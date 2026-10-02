import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {createApp} from '../src/server/index';
import {InMemoryStorage} from '../src/server/storage';
import {UploadEngine} from '../src/server/engine';
import {
  fetchDownloadInfo,
  runDownload,
  type DownloadEvent,
  type DownloadProgress,
} from '../src/client/downloader';
import {sha256Hex} from '../src/client/uploader';

const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const PAYLOAD = Array.from({length: 40}, (_, i) => `line-${String(i).padStart(3, '0')}-of-the-file`).join('\n');

let base = '';
const servers: Array<ReturnType<typeof createServer>> = [];

async function startServer(engine = new UploadEngine(new InMemoryStorage())) {
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
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function completedSession(b: string, content: Uint8Array, name = 'file.bin') {
  const create = await fetch(`${b}/api/uploads`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({name, ttlMs: null}),
  });
  const {id} = (await create.json()) as {id: string};
  const half = Math.floor(content.length / 2);
  for (const [offset, chunk, rev] of [
    [0, content.subarray(0, half), 0],
    [half, content.subarray(half), 1],
  ] as const) {
    const res = await fetch(`${b}/api/uploads/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/offset-bytes',
        'Upload-Offset': String(offset),
        'If-Match': `"${rev}"`,
        'Upload-Checksum': await sha256Hex(chunk),
      },
      body: chunk as unknown as BodyInit,
    });
    expect(res.status).toBe(200);
  }
  await fetch(`${b}/api/uploads/${id}/complete`, {method: 'POST'});
  return id;
}

function trace(events: DownloadEvent[]) {
  return (event: DownloadEvent) => events.push(event);
}

type RecordedRequest = {range: string | null; ifRange: string | null};

/**
 * Wrap fetch so the first content GET delivers only `cut` bytes and then
 * resets the connection. Every content request's Range/If-Range is recorded.
 * The stream is pull-driven: enqueueing and erroring synchronously would
 * discard the queued bytes (ResetQueue) before the reader sees them.
 */
function dropFirstBodyAfter(cut: number) {
  const requests: RecordedRequest[] = [];
  let dropped = false;
  const doFetch: typeof fetch = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const isContentGet = init?.method !== 'HEAD' && String(input).includes('/download');
    if (isContentGet) {
      requests.push({range: headers['Range'] ?? null, ifRange: headers['If-Range'] ?? null});
    }
    const res = await fetch(input as string, init);
    if (!dropped && isContentGet && res.status === 206 && res.body) {
      dropped = true;
      const body = new Uint8Array(await res.arrayBuffer());
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(body.subarray(0, cut));
          } else {
            controller.error(new Error('connection reset'));
          }
        },
      });
      return new Response(stream, {status: res.status, headers: res.headers});
    }
    return res;
  };
  return {doFetch, requests};
}

/** Wrap fetch so the first content GET pauses (aborts) after `cut` bytes. */
function pauseFirstBodyAfter(cut: number, controller: AbortController) {
  let truncated = false;
  const doFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input as string, init);
    if (!truncated && init?.method !== 'HEAD' && res.status === 206 && res.body) {
      truncated = true;
      const body = new Uint8Array(await res.arrayBuffer());
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (!sent) {
            sent = true;
            c.enqueue(body.subarray(0, cut));
          } else {
            controller.abort(); // user pressed pause mid-stream
            c.error(new DOMException('The operation was aborted', 'AbortError'));
          }
        },
      });
      return new Response(stream, {status: res.status, headers: res.headers});
    }
    return res;
  };
  return doFetch;
}

describe('client downloader', () => {
  it('downloads a completed session and verifies the assembled bytes', async () => {
    const payload = new TextEncoder().encode(PAYLOAD);
    const id = await completedSession(base, payload);
    const events: DownloadEvent[] = [];

    const result = await runDownload({sessionId: id, onEvent: trace(events), baseUrl: base});

    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.bytes.length).toBe(payload.length);
    expect(Buffer.from(result.bytes).equals(Buffer.from(payload))).toBe(true);
    expect(result.sha256).toBe(sha(payload));
    expect(result.progress.confirmed).toBe(payload.length);
    expect(events.some((e) => e.type === 'info')).toBe(true);
    expect(events.some((e) => e.type === 'verify')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('connection drop mid-stream: resumes at confirmed bytes, never restarts from zero', async () => {
    const payload = new TextEncoder().encode(PAYLOAD);
    const id = await completedSession(base, payload);
    const cut = 100;
    const {doFetch, requests} = dropFirstBodyAfter(cut);
    const events: DownloadEvent[] = [];

    const result = await runDownload({sessionId: id, onEvent: trace(events), baseUrl: base, doFetch});

    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(Buffer.from(result.bytes).equals(Buffer.from(payload))).toBe(true);

    // Two content requests: the dropped one at 0, the resume at exactly the
    // confirmed prefix — both conditional on the pinned identity.
    expect(requests).toHaveLength(2);
    expect(requests[0].range).toBe('bytes=0-');
    expect(requests[1].range).toBe(`bytes=${cut}-`);
    expect(requests[0].ifRange).toBe(`"${sha(payload)}"`);
    expect(requests[1].ifRange).toBe(`"${sha(payload)}"`);
    // No silent from-zero retry after the drop.
    expect(requests.slice(1).every((r) => r.range !== 'bytes=0-')).toBe(true);
    expect(events.some((e) => e.type === 'retry')).toBe(true);
  });

  it('pause keeps confirmed bytes; resume finishes the same object', async () => {
    const payload = new TextEncoder().encode(PAYLOAD);
    const id = await completedSession(base, payload);
    const controller = new AbortController();
    const cut = 120;

    const first = await runDownload({
      sessionId: id,
      onEvent: () => undefined,
      baseUrl: base,
      doFetch: pauseFirstBodyAfter(cut, controller),
      signal: controller.signal,
    });
    expect(first.status).toBe('paused');
    if (first.status !== 'paused') return;
    expect(first.progress.confirmed).toBe(cut);

    const events: DownloadEvent[] = [];
    const second = await runDownload({
      sessionId: id,
      onEvent: trace(events),
      baseUrl: base,
      resumeFrom: first.progress,
    });
    expect(second.status).toBe('done');
    if (second.status !== 'done') return;
    expect(Buffer.from(second.bytes).equals(Buffer.from(payload))).toBe(true);
    expect(second.progress.confirmed).toBe(payload.length);
  });

  it('refuses to resume a different object: saved bytes are not spliced or discarded', async () => {
    const payloadA = new TextEncoder().encode(PAYLOAD);
    const payloadB = new TextEncoder().encode(`completely different file ${PAYLOAD}`);
    const idA = await completedSession(base, payloadA, 'a.bin');
    const idB = await completedSession(base, payloadB, 'b.bin');

    const first = await runDownload({sessionId: idA, onEvent: () => undefined, baseUrl: base});
    expect(first.status).toBe('done');
    if (first.status !== 'done') return;
    const savedA: DownloadProgress = first.progress;

    // Point a resume at session B while carrying session A's saved bytes.
    const events: DownloadEvent[] = [];
    const mixed = await runDownload({
      sessionId: idB,
      onEvent: trace(events),
      baseUrl: base,
      resumeFrom: savedA,
    });
    expect(mixed.status).toBe('failed');
    if (mixed.status !== 'failed') return;
    expect(mixed.reason).toContain('identity_changed');
    // The confirmed prefix of A is returned untouched — nothing overwritten.
    expect(mixed.progress?.confirmed).toBe(savedA.confirmed);
    expect(mixed.progress?.etag).toBe(savedA.etag);
  });

  it('cancel after a partial download: resume fails with session_cancelled, progress kept', async () => {
    const payload = new TextEncoder().encode(PAYLOAD);
    const id = await completedSession(base, payload);
    const controller = new AbortController();
    // Pause right after 64 confirmed bytes by aborting mid-stream.
    const first = await runDownload({
      sessionId: id,
      onEvent: () => undefined,
      baseUrl: base,
      doFetch: pauseFirstBodyAfter(64, controller),
      signal: controller.signal,
    });
    expect(first.status).toBe('paused');
    if (first.status !== 'paused') return;
    expect(first.progress.confirmed).toBe(64);

    await fetch(`${base}/api/uploads/${id}`, {method: 'DELETE'});

    const events: DownloadEvent[] = [];
    const resumed = await runDownload({
      sessionId: id,
      onEvent: trace(events),
      baseUrl: base,
      resumeFrom: first.progress,
    });
    expect(resumed.status).toBe('failed');
    if (resumed.status !== 'failed') return;
    expect(resumed.reason).toContain('session_cancelled');
    expect(resumed.progress?.confirmed).toBe(64);
  });

  it('active session is not downloadable: explains the still-changing prefix', async () => {
    const create = await fetch(`${base}/api/uploads`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ttlMs: null}),
    });
    const {id} = (await create.json()) as {id: string};
    const chunk = new TextEncoder().encode('partial-prefix');
    await fetch(`${base}/api/uploads/${id}`, {
      method: 'PATCH',
      headers: {'Content-Type': 'application/offset-bytes', 'Upload-Offset': '0'},
      body: chunk as unknown as BodyInit,
    });

    const info = await fetchDownloadInfo({sessionId: id, baseUrl: base});
    expect(info.kind).toBe('active');
    if (info.kind === 'active') expect(info.offset).toBe(chunk.length);

    const result = await runDownload({sessionId: id, onEvent: () => undefined, baseUrl: base});
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toContain('session_active');
  });

  it('zero-byte completed file downloads as an empty verified object', async () => {
    const create = await fetch(`${base}/api/uploads`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ttlMs: null}),
    });
    const {id} = (await create.json()) as {id: string};
    await fetch(`${base}/api/uploads/${id}/complete`, {method: 'POST'});

    const result = await runDownload({sessionId: id, onEvent: () => undefined, baseUrl: base});
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.bytes.length).toBe(0);
    expect(result.sha256).toBe(sha(Buffer.alloc(0)));
  });

  it('fetchDownloadInfo maps every session state', async () => {
    const payload = new TextEncoder().encode(PAYLOAD);
    const done = await completedSession(base, payload);
    const ready = await fetchDownloadInfo({sessionId: done, baseUrl: base});
    expect(ready).toEqual({
      kind: 'ready',
      size: payload.length,
      sha256: sha(payload),
      etag: `"${sha(payload)}"`,
    });

    const cancelled = await completedSession(base, payload);
    await fetch(`${base}/api/uploads/${cancelled}`, {method: 'DELETE'});
    const cancelledInfo = await fetchDownloadInfo({sessionId: cancelled, baseUrl: base});
    expect(cancelledInfo.kind).toBe('cancelled');

    const gone = await fetchDownloadInfo({sessionId: 's_missing', baseUrl: base});
    expect(gone.kind).toBe('gone');
  });
});
