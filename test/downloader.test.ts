import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {createApp} from '../src/server/index';
import {InMemoryStorage} from '../src/server/storage';
import {UploadEngine} from '../src/server/engine';
import {runDownload, sha256Hex, RunGuard, type DownloadEvent} from '../src/client/downloader';

const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const PAYLOAD = 'the-quick-brown-fox-jumps-over-the-lazy-dog-0123456789';

let base = '';
const servers: Array<ReturnType<typeof createServer>> = [];

async function startServer(engine?: UploadEngine) {
  const app = createApp(engine ?? new UploadEngine(new InMemoryStorage()));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const {port} = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function seedCompleted(b: string, text: string) {
  const created = await fetch(`${b}/api/uploads`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({ttlMs: null}),
  }).then((r) => r.json());
  await fetch(`${b}/api/uploads/${created.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/offset-bytes',
      'Upload-Offset': '0',
      'If-Match': '"0"',
      'Upload-Request-Id': 'all',
      'Upload-Checksum': await sha256Hex(new TextEncoder().encode(text)),
    },
    body: new TextEncoder().encode(text),
  });
  await fetch(`${b}/api/uploads/${created.id}/complete`, {method: 'POST'});
  return created.id as string;
}

function eventsOf(events: DownloadEvent[]) {
  return (event: DownloadEvent) => events.push(event);
}

beforeAll(async () => {
  base = await startServer();
});

afterAll(() => {
  for (const s of servers) s.close();
});

describe('client downloader', () => {
  it('RunGuard drops responses of a previous session after switching', () => {
    const guard = new RunGuard();
    const runA = guard.next();
    expect(guard.isCurrent(runA)).toBe(true);
    // A response for A is still in flight when the user switches sessions.
    guard.invalidate();
    expect(guard.isCurrent(runA)).toBe(false);
    const runB = guard.next();
    expect(guard.isCurrent(runB)).toBe(true);
    expect(guard.isCurrent(runA)).toBe(false);
    // A stale response arriving for B's slot cannot overwrite B either.
    guard.invalidate();
    const runC = guard.next();
    expect(guard.isCurrent(runB)).toBe(false);
    expect(guard.isCurrent(runC)).toBe(true);
  });
  it('downloads the complete object in ranges and verifies the final digest', async () => {
    const id = await seedCompleted(base, PAYLOAD);
    const events: DownloadEvent[] = [];
    const outcome = await runDownload({
      sessionId: id,
      baseUrl: base,
      chunkSize: 10,
      onEvent: eventsOf(events),
    });
    expect('bytes' in outcome).toBe(true);
    if (!('bytes' in outcome)) return;
    expect(new TextDecoder().decode(outcome.bytes)).toBe(PAYLOAD);
    expect(outcome.info.size).toBe(PAYLOAD.length);
    expect(outcome.info.sha256).toBe(sha(PAYLOAD));

    const requests = events.filter((e) => e.type === 'request') as Extract<DownloadEvent, {type: 'request'}>[];
    expect(requests[0].start).toBe(0);
    // The windows are contiguous, non-overlapping and cover the object.
    expect(requests.map((r) => r.start)).toEqual(
      Array.from({length: Math.ceil(PAYLOAD.length / 10)}, (_, i) => i * 10),
    );
    const done = events.find((e) => e.type === 'done') as Extract<DownloadEvent, {type: 'done'}>;
    expect(done.total).toBe(PAYLOAD.length);
    expect(done.sha256).toBe(sha(PAYLOAD));
  });

  it('pauses mid-file and resumes from the saved byte with the pinned etag', async () => {
    const id = await seedCompleted(base, PAYLOAD);
    const events: DownloadEvent[] = [];
    const pause = new AbortController();
    // Pause as soon as the first chunk is confirmed, while bytes remain.
    const unsubscribe = eventsOf(events);
    const wrappedEvents = (event: DownloadEvent) => {
      unsubscribe(event);
      if (event.type === 'chunk' && pause.signal.aborted === false) pause.abort();
    };

    const first = await runDownload({
      sessionId: id,
      baseUrl: base,
      chunkSize: 7,
      pauseSignal: pause.signal,
      onEvent: wrappedEvents,
    });
    expect('paused' in first).toBe(true);
    if (!('paused' in first)) return;
    expect(first.saved.length).toBe(7);
    expect(first.saved.length).toBeLessThan(PAYLOAD.length);
    expect(first.info.etag).toBe(sha(PAYLOAD));

    // Resume: every range must start AT the saved boundary — never zero.
    const resumedEvents: DownloadEvent[] = [];
    const second = await runDownload({
      sessionId: id,
      baseUrl: base,
      chunkSize: 7,
      prefix: first.saved,
      etag: first.info.etag,
      onEvent: eventsOf(resumedEvents),
    });
    expect('bytes' in second).toBe(true);
    if (!('bytes' in second)) return;
    expect(new TextDecoder().decode(second.bytes)).toBe(PAYLOAD);

    const requests = resumedEvents.filter((e) => e.type === 'request') as Extract<DownloadEvent, {type: 'request'}>[];
    expect(requests[0].start).toBe(first.saved.length);
    expect(requests.every((r) => r.start >= first.saved.length)).toBe(true);
  });

  it('a dropped connection retries the same window and never restarts from zero', async () => {
    const id = await seedCompleted(base, PAYLOAD);
    const events: DownloadEvent[] = [];
    let drops = 0;
    const flakyFetch: typeof fetch = async (input, init) => {
      const range = (init?.headers as Record<string, string> | undefined)?.['Range'] ?? '';
      // Fail the first request at byte 20 (an earlier chunk was already
      // confirmed), then let everything through.
      if (drops < 1 && /^bytes=20-/.test(range)) {
        drops += 1;
        throw Object.assign(new Error('socket hang up'), {name: 'AbortError'});
      }
      return fetch(input as string, init);
    };

    const outcome = await runDownload({
      sessionId: id,
      baseUrl: base,
      chunkSize: 10,
      doFetch: flakyFetch,
      onEvent: eventsOf(events),
    });
    expect('bytes' in outcome).toBe(true);
    if (!('bytes' in outcome)) return;
    expect(new TextDecoder().decode(outcome.bytes)).toBe(PAYLOAD);

    const retries = events.filter((e) => e.type === 'retry') as Extract<DownloadEvent, {type: 'retry'}>[];
    expect(retries.length).toBe(1);
    expect(retries[0].from).toBe(20);
    // Retries continue at the exact unconfirmed byte; no request after progress
    // ever goes back to zero.
    const requests = events.filter((e) => e.type === 'request') as Extract<DownloadEvent, {type: 'request'}>[];
    const sawZero = requests.filter((r) => r.start === 0);
    expect(sawZero).toHaveLength(1);
    const retried = requests.filter((r) => r.start === 20);
    expect(retried.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses to splice when the server object identity changes (412 mid-download)', async () => {
    const b = await startServer();
    const id = await seedCompleted(b, PAYLOAD);
    const prefix = new TextEncoder().encode(PAYLOAD.slice(0, 21));

    // The resumed GETs will be answered 412 as if the URL now pointed at a
    // different frozen object.
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/content') && init?.method === 'HEAD') {
        // Report a DIFFERENT identity than the prefix was built from.
        const other = await sha256Hex('a-totally-different-object');
        return new Response(null, {
          status: 200,
          headers: {
            ETag: `"${other}"`,
            'Content-Length': String(PAYLOAD.length),
            'X-Content-SHA256': other,
          },
        });
      }
      return new Response(JSON.stringify({error: 'precondition_failed'}), {
        status: 412,
        headers: {'content-type': 'application/json'},
      });
    };

    const events: DownloadEvent[] = [];
    await expect(
      runDownload({
        sessionId: id,
        baseUrl: b,
        prefix,
        etag: await sha256Hex(PAYLOAD),
        chunkSize: 10,
        doFetch: fakeFetch,
        onEvent: eventsOf(events),
      }),
    ).rejects.toMatchObject({code: 'identity_changed'});
    const fatal = events.find((e) => e.type === 'fatal') as Extract<DownloadEvent, {type: 'fatal'}>;
    expect(fatal.code).toBe('identity_changed');
  });

  it('rejects a whole-object 200 during a ranged resume instead of overwriting the prefix', async () => {
    const b = await startServer();
    const id = await seedCompleted(b, PAYLOAD);
    const prefix = new TextEncoder().encode(PAYLOAD.slice(0, 21));
    const wrongFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/content') && init?.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            ETag: `"${sha(PAYLOAD)}"`,
            'Content-Length': String(PAYLOAD.length),
            'X-Content-SHA256': sha(PAYLOAD),
          },
        });
      }
      // A misbehaving proxy returns 200 (whole body) despite Range.
      return new Response(new TextEncoder().encode(PAYLOAD), {status: 200, headers: {'content-length': String(PAYLOAD.length)}});
    };

    await expect(
      runDownload({
        sessionId: id,
        baseUrl: b,
        prefix,
        etag: sha(PAYLOAD),
        chunkSize: 10,
        doFetch: wrongFetch,
        onEvent: () => undefined,
      }),
    ).rejects.toMatchObject({code: 'unexpected_full_body'});
  });

  it('fails on a Content-Range window inconsistent with the pinned position', async () => {
    const b = await startServer();
    const id = await seedCompleted(b, PAYLOAD);
    const prefix = new TextEncoder().encode(PAYLOAD.slice(0, 21));
    const lyingFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/content') && init?.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            ETag: `"${sha(PAYLOAD)}"`,
            'Content-Length': String(PAYLOAD.length),
            'X-Content-SHA256': sha(PAYLOAD),
          },
        });
      }
      // Claims to start at byte 0 though the client requested 21.
      return new Response(new TextEncoder().encode(PAYLOAD.slice(0, 10)), {
        status: 206,
        headers: {
          ETag: `"${sha(PAYLOAD)}"`,
          'Content-Range': `bytes 0-9/${PAYLOAD.length}`,
          'content-length': '10',
        },
      });
    };

    await expect(
      runDownload({
        sessionId: id,
        baseUrl: b,
        prefix,
        etag: sha(PAYLOAD),
        chunkSize: 10,
        doFetch: lyingFetch,
        onEvent: () => undefined,
      }),
    ).rejects.toMatchObject({code: 'bad_content_range'});
  });

  it('a prefix equal to the object length is accepted only when its digest matches', async () => {
    const id = await seedCompleted(base, PAYLOAD);
    const full = new TextEncoder().encode(PAYLOAD);

    const good = await runDownload({sessionId: id, baseUrl: base, prefix: full, etag: sha(PAYLOAD), chunkSize: 10, onEvent: () => undefined});
    expect('bytes' in good).toBe(true);

    const corrupted = new Uint8Array(full);
    corrupted[0] = corrupted[0] === 97 ? 98 : 97;
    await expect(
      runDownload({sessionId: id, baseUrl: base, prefix: corrupted, etag: sha(PAYLOAD), chunkSize: 10, onEvent: () => undefined}),
    ).rejects.toMatchObject({code: 'digest_mismatch'});
  });

  it('does not open bytes for an active or cancelled session', async () => {
    const b = await startServer();
    // Active.
    const created = await fetch(`${b}/api/uploads`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}).then((r) => r.json());
    await expect(
      runDownload({sessionId: created.id, baseUrl: b, chunkSize: 10, onEvent: () => undefined}),
    ).rejects.toMatchObject({code: 'not_completed'});

    // Completed then cancelled is impossible via API; cancel a fresh session.
    await fetch(`${b}/api/uploads/${created.id}`, {method: 'DELETE'});
    await expect(
      runDownload({sessionId: created.id, baseUrl: b, chunkSize: 10, onEvent: () => undefined}),
    ).rejects.toMatchObject({code: /cancelled|expired/});
  });
});
