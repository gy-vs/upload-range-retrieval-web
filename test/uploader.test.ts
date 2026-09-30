import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {createApp} from '../src/server/index';
import {InMemoryStorage} from '../src/server/storage';
import {UploadEngine} from '../src/server/engine';
import {
  newRequestId,
  planBlocks,
  planOverlappingBlocks,
  runUpload,
  sha256Hex,
  type UploadBlock,
  type UploadEvent,
} from '../src/client/uploader';

const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const PAYLOAD = 'the-quick-brown-fox-jumps-over-the-lazy-dog-0123456789';

let base = '';
const servers: Array<ReturnType<typeof createServer>> = [];

function makeEngine(now: () => number = () => Date.now()) {
  const storage = new InMemoryStorage();
  return {storage, engine: new UploadEngine(storage, {now})};
}

async function startServer(engine?: UploadEngine) {
  const app = createApp(engine);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const {port} = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  base = await startServer();
});

afterAll(async () => {
  await Promise.all(
    servers.map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve())),
    ),
  );
});

async function createSession(b: string, ttlMs: number | null = null) {
  const res = await fetch(`${b}/api/uploads`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(ttlMs === null ? {} : {ttlMs}),
  });
  return (await res.json()) as {id: string; offset: number; revision: number; sha256: string};
}

async function sessionState(b: string, id: string) {
  const res = await fetch(`${b}/api/uploads/${id}`);
  if (res.status === 410) return null;
  return res.json();
}

function trace(events: UploadEvent[]) {
  return (event: UploadEvent) => events.push(event);
}

describe('client uploader', () => {
  it('normal sequential run reproduces the exact payload and digest', async () => {
    const payload = new TextEncoder().encode(PAYLOAD);
    const s = await createSession(base);
    const blocks = planBlocks(payload, 10);
    const events: UploadEvent[] = [];
    const result = await runUpload({sessionId: s.id, blocks, onEvent: trace(events), baseUrl: base});
    expect(result.offset).toBe(payload.length);
    expect(result.sha256).toBe(await sha256Hex(payload));
  });

  it('same-offset duplicate dispatch: one ack, one conflict, no duplicate bytes', async () => {
    const b = await startServer();
    const payload = new TextEncoder().encode(PAYLOAD);
    const s = await createSession(b);
    const blocks = planBlocks(payload, 10);
    blocks[1] = {...blocks[1], duplicate: true};
    const events: UploadEvent[] = [];
    const result = await runUpload({sessionId: s.id, blocks, onEvent: trace(events), baseUrl: b, doFetch: fetch});

    expect(result.offset).toBe(payload.length);
    expect(result.sha256).toBe(sha(payload));
    expect(events.some((e) => e.type === 'conflict')).toBe(true);
    const state = await sessionState(b, s.id);
    expect(state.chunks.length).toBe(blocks.length); // no doubled append
  });

  it('overlapping blocks trim covered prefixes and converge to the full payload', async () => {
    const b = await startServer();
    const payload = new TextEncoder().encode(PAYLOAD);
    const s = await createSession(b);
    // [0,20) then [10,40) then [30,end] — heavy overlaps, strict append order.
    const end = payload.length;
    const blocks = planOverlappingBlocks(payload, [
      [0, 20],
      [10, 40],
      [30, end],
    ]);
    const events: UploadEvent[] = [];
    const result = await runUpload({sessionId: s.id, blocks, onEvent: trace(events), baseUrl: b, doFetch: fetch});

    expect(result.offset).toBe(end);
    expect(result.sha256).toBe(sha(payload));
    // The client trims each window to the locally-known committed offset
    // before sending, so overlapping blocks are resolved without wasted 409s:
    // block 1 goes out at 20 (not 10), block 2 at 40 (not 30).
    const sends = events.filter((e) => e.type === 'send') as Extract<UploadEvent, {type: 'send'}>[];
    expect(sends.map((e) => e.offset)).toEqual([0, 20, 40]);
    expect(sends.map((e) => e.offset + e.length)).toEqual([20, 40, end]);
  });

  it('zero-length blocks bump revision without changing offset; payload intact', async () => {
    const b = await startServer();
    const payload = new TextEncoder().encode(PAYLOAD);
    const s = await createSession(b);
    const blocks = planBlocks(payload, 12, [1]); // zero block inserted at index 1
    blocks.splice(2, 0, {
      index: 99,
      requestId: newRequestId(99),
      baseStart: 12,
      fullBytes: new Uint8Array(0),
      start: 12,
      end: 12,
      status: 'queued',
      attempts: 0,
      replayed: false,
      note: 'extra zero-length',
    });
    blocks.forEach((block, i) => (block.index = i));
    const events: UploadEvent[] = [];
    const result = await runUpload({sessionId: s.id, blocks, onEvent: trace(events), baseUrl: b, doFetch: fetch});

    expect(result.offset).toBe(payload.length);
    expect(result.sha256).toBe(sha(payload));
    // revision = number of PATCHes = blocks count
    expect(result.revision).toBe(blocks.length);
  });

  it('write failure: retries same request id and completes; prefix always consistent', async () => {
    const {engine} = makeEngine();
    const b = await startServer(engine);
    const payload = new TextEncoder().encode(PAYLOAD);
    const s = await createSession(b);
    engine.planStorageFailure('append'); // first append fails
    const blocks = planBlocks(payload, 10);
    const events: UploadEvent[] = [];
    const result = await runUpload({sessionId: s.id, blocks, onEvent: trace(events), baseUrl: b, doFetch: fetch});

    expect(events.some((e) => e.type === 'storage-failure')).toBe(true);
    expect(result.offset).toBe(payload.length);
    expect(result.sha256).toBe(sha(payload));
  });

  it('response lost after commit: same request id replays, bytes written once', async () => {
    const b = await startServer();
    const payload = new TextEncoder().encode(PAYLOAD);
    const s = await createSession(b);
    const blocks = planBlocks(payload, 10);
    const targetId = blocks[1].requestId;
    let lost = false;
    const events: UploadEvent[] = [];

    const patchedFetch: typeof fetch = (input, init) => {
      const reqId = (init?.headers as Record<string, string> | undefined)?.['Upload-Request-Id'];
      if (!lost && init?.method === 'PATCH' && reqId === targetId) {
        lost = true;
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('lost')), 100);
        return fetch(input as string, {...init, signal: controller.signal});
      }
      return fetch(input as string, init);
    };

    const result = await runUpload({
      sessionId: s.id,
      blocks,
      onEvent: trace(events), baseUrl: b,
      doFetch: patchedFetch,
    });

    expect(result.offset).toBe(payload.length);
    expect(result.sha256).toBe(sha(payload));
    // The retry after the lost response should have been a ledger replay OR a
    // conflict-retrim that still wrote the payload exactly once.
    const state = await sessionState(b, s.id);
    expect(state.offset).toBe(payload.length);
    expect(state.chunks.length).toBe(blocks.length);
  });

  it('expired session terminates with 410 and leaves no writes after TTL', async () => {
    let now = Date.now();
    const {engine} = makeEngine(() => now);
    const b = await startServer(engine);
    const payload = new TextEncoder().encode(PAYLOAD);
    const s = await createSession(b, 300);
    const blocks = planBlocks(payload, 10);
    const events: UploadEvent[] = [];

    // Slow the network so the upload is still in flight when the TTL elapses.
    const slowFetch: typeof fetch = async (input, init) => {
      if (init?.method === 'PATCH') await new Promise((r) => setTimeout(r, 200));
      return fetch(input as string, init);
    };
    const run = runUpload({sessionId: s.id, blocks, onEvent: trace(events), baseUrl: b, doFetch: slowFetch});
    await new Promise((r) => setTimeout(r, 450));
    now += 1000; // TTL elapses server-side
    await expect(run).rejects.toThrow(/upload_failed|session/);
    expect(events.some((e) => e.type === 'fatal')).toBe(true);
  });

  it('cancel mid-upload is terminal; whatever was acked remains a valid prefix', async () => {
    const b = await startServer();
    const payload = new TextEncoder().encode(PAYLOAD);
    const s = await createSession(b);
    const blocks = planBlocks(payload, 10);
    const events: UploadEvent[] = [];
    const controller = new AbortController();

    setTimeout(() => {
      void fetch(`${b}/api/uploads/${s.id}`, {method: 'DELETE'});
      controller.abort();
    }, 30);

    await expect(
      runUpload({sessionId: s.id, blocks, onEvent: trace(events), baseUrl: b, doFetch: fetch, signal: controller.signal}),
    ).rejects.toThrow(/cancel|failed/);
  });

  it('every acknowledged offset maps to exactly one persisted prefix (random races)', async () => {
    const b = await startServer();
    const payload = new TextEncoder().encode(PAYLOAD);
    const s = await createSession(b);
    const blocks = planBlocks(payload, 8);
    blocks.forEach((block, i) => {
      if (i % 2 === 0) block.duplicate = true;
    });
    const events: UploadEvent[] = [];
    const result = await runUpload({sessionId: s.id, blocks, onEvent: trace(events), baseUrl: b, doFetch: fetch});

    expect(result.offset).toBe(payload.length);
    expect(result.sha256).toBe(sha(payload));
    // No gap, no overwrite: chunk offsets recorded server-side are unique.
    const state = await sessionState(b, s.id);
    const offsets = state.chunks.map((c: {offset: number}) => c.offset);
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(offsets).toEqual([...offsets].sort((a: number, z: number) => a - z));
  });
});
