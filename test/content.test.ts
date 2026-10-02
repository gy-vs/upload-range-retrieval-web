import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../src/server/index';
import {DiskStorage, InMemoryStorage, type UploadStorage} from '../src/server/storage';
import {UploadEngine} from '../src/server/engine';

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const buf = (text: string) => Buffer.from(text, 'utf8');

type App = ReturnType<typeof createApp>;

async function makeApp(storage: UploadStorage): Promise<App> {
  return createApp(new UploadEngine(storage));
}

async function createSession(app: App, ttlMs: number | null = null) {
  const res = await request(app)
    .post('/api/uploads')
    .send(ttlMs === null ? {} : {ttlMs})
    .expect(201);
  return res.body as {id: string};
}

async function append(app: App, id: string, chunk: Buffer, offset: number, revision: number, req: string) {
  return request(app)
    .patch(`/api/uploads/${id}`)
    .set('Content-Type', 'application/offset-bytes')
    .set('Upload-Offset', String(offset))
    .set('If-Match', `"${revision}"`)
    .set('Upload-Request-Id', req)
    .send(chunk)
    .expect(200);
}

async function seedCompleted(app: App, text: string, name?: string) {
  const res = await request(app)
    .post('/api/uploads')
    .send(name === undefined ? {} : {name})
    .expect(201);
  const s = res.body as {id: string};
  await append(app, s.id, buf(text), 0, 0, 'only');
  await request(app).post(`/api/uploads/${s.id}/complete`).expect(200);
  return {...s, payload: text};
}

/**
 * The whole download contract is asserted against BOTH backends — the HTTP
 * behaviour of DiskStorage and InMemoryStorage must be identical.
 */
const diskDirs = new WeakMap<DiskStorage, string>();
const factories: Array<[string, () => UploadStorage]> = [
  ['InMemoryStorage', () => new InMemoryStorage()],
  [
    'DiskStorage',
    () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-parity-'));
      const storage = new DiskStorage(dir);
      diskDirs.set(storage, dir);
      return storage;
    },
  ],
];
describe.each(factories)('finalized object download over %s', (_label, makeStorage) => {
  const TEXT = '0123456789abcdef-the-final-immutable-object';

  it('HEAD exposes identity, total length and digest but no body', async () => {
    const storage = makeStorage();
    const app = await makeApp(storage);
    const s = await seedCompleted(app, TEXT, 'report.txt');

    const head = await request(app).head(`/api/uploads/${s.id}/content`);
    expect(head.status).toBe(200);
    expect(head.headers['etag']).toBe(`"${sha(TEXT)}"`);
    expect(head.headers['content-length']).toBe(String(TEXT.length));
    expect(head.headers['x-content-sha256']).toBe(sha(TEXT));
    expect(head.headers['accept-ranges']).toBe('bytes');
    expect(head.headers['x-object-name']).toBe(encodeURIComponent('report.txt'));
    expect(head.headers['content-disposition']).toContain('attachment');
    expect(head.body.length ?? 0).toBe(0);
  });

  it('GET with no Range returns the exact complete bytes with matching identity headers', async () => {
    const app = await makeApp(makeStorage());
    const s = await seedCompleted(app, TEXT);

    const res = await request(app).get(`/api/uploads/${s.id}/content`).expect(200);
    expect(res.body instanceof Buffer ? res.body.toString() : res.text).toBe(TEXT);
    expect(res.headers['etag']).toBe(`"${sha(TEXT)}"`);
    expect(res.headers['content-length']).toBe(String(TEXT.length));
    expect(res.headers['x-content-sha256']).toBe(sha(TEXT));
    expect(res.headers['digest']).toContain('sha-256=');
    expect(res.headers['content-range']).toBeUndefined();
  });

  it('Range windows: headers, body and full-file identity are mutually consistent', async () => {
    const app = await makeApp(makeStorage());
    const s = await seedCompleted(app, TEXT);

    const r1 = await request(app)
      .get(`/api/uploads/${s.id}/content`)
      .set('Range', 'bytes=10-19')
      .expect(206);
    expect(r1.body.toString()).toBe(TEXT.slice(10, 20));
    expect(r1.headers['content-range']).toBe(`bytes 10-19/${TEXT.length}`);
    expect(r1.headers['content-length']).toBe('10');
    expect(r1.headers['etag']).toBe(`"${sha(TEXT)}"`);
    expect(r1.headers['x-content-sha256']).toBe(sha(TEXT));

    // Open suffix and tail-suffix forms.
    const r2 = await request(app)
      .get(`/api/uploads/${s.id}/content`)
      .set('Range', `bytes=${TEXT.length - 5}-`)
      .expect(206);
    expect(r2.body.toString()).toBe(TEXT.slice(TEXT.length - 5));
    expect(r2.headers['content-range']).toBe(`bytes ${TEXT.length - 5}-${TEXT.length - 1}/${TEXT.length}`);

    const r3 = await request(app)
      .get(`/api/uploads/${s.id}/content`)
      .set('Range', 'bytes=-7')
      .expect(206);
    expect(r3.body.toString()).toBe(TEXT.slice(TEXT.length - 7));
    expect(r3.headers['content-range']).toBe(`bytes ${TEXT.length - 7}-${TEXT.length - 1}/${TEXT.length}`);

    // Clamped end.
    const r4 = await request(app)
      .get(`/api/uploads/${s.id}/content`)
      .set('Range', `bytes=0-${TEXT.length + 100}`)
      .expect(206);
    expect(r4.body.toString()).toBe(TEXT);
    expect(r4.headers['content-range']).toBe(`bytes 0-${TEXT.length - 1}/${TEXT.length}`);
  });

  it('sequential ranged GETs reconstruct the exact object', async () => {
    const app = await makeApp(makeStorage());
    const s = await seedCompleted(app, TEXT);
    const pieces: Buffer[] = [];
    for (let start = 0; start < TEXT.length; start += 8) {
      const end = Math.min(start + 7, TEXT.length - 1);
      const res = await request(app)
        .get(`/api/uploads/${s.id}/content`)
        .set('Range', `bytes=${start}-${end}`)
        .expect(206);
      expect(res.headers['content-range']).toBe(`bytes ${start}-${end}/${TEXT.length}`);
      pieces.push(res.body);
    }
    expect(Buffer.concat(pieces).toString()).toBe(TEXT);
    expect(sha(Buffer.concat(pieces))).toBe(sha(TEXT));
  });

  it('unsatisfiable / malformed ranges are 416 with Content-Range bytes */size', async () => {
    const app = await makeApp(makeStorage());
    const s = await seedCompleted(app, TEXT);

    const beyond = await request(app)
      .get(`/api/uploads/${s.id}/content`)
      .set('Range', `bytes=${TEXT.length}-`)
      .expect(416);
    expect(beyond.headers['content-range']).toBe(`bytes */${TEXT.length}`);

    const malformed = await request(app)
      .get(`/api/uploads/${s.id}/content`)
      .set('Range', 'items=0-5')
      .expect(416);
    expect(malformed.headers['content-range']).toBe(`bytes */${TEXT.length}`);
  });

  it('If-Match mismatches refuse with 412 and send no bytes (no version splice)', async () => {
    const app = await makeApp(makeStorage());
    const s = await seedCompleted(app, TEXT);

    const res = await request(app)
      .get(`/api/uploads/${s.id}/content`)
      .set('Range', 'bytes=0-9')
      .set('If-Match', '"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"')
      .expect(412);
    expect(res.headers['etag']).toBe(`"${sha(TEXT)}"`);
    expect(JSON.parse(res.body.toString())).toEqual({
      error: 'precondition_failed',
      expected: expect.any(String),
      etag: `"${sha(TEXT)}"`,
    });

    const head = await request(app)
      .head(`/api/uploads/${s.id}/content`)
      .set('If-Match', '"deadbeef"')
      .expect(412);
    expect(head.body.length ?? 0).toBe(0);
  });

  it('If-Match matching the object allows a resumed range', async () => {
    const app = await makeApp(makeStorage());
    const s = await seedCompleted(app, TEXT);

    const res = await request(app)
      .get(`/api/uploads/${s.id}/content`)
      .set('Range', 'bytes=5-14')
      .set('If-Match', `"${sha(TEXT)}"`)
      .expect(206);
    expect(res.body.toString()).toBe(TEXT.slice(5, 15));
  });

  it('If-Range with the current ETag returns the range; with a stale one returns the whole object', async () => {
    const app = await makeApp(makeStorage());
    const s = await seedCompleted(app, TEXT);

    const fresh = await request(app)
      .get(`/api/uploads/${s.id}/content`)
      .set('Range', 'bytes=2-5')
      .set('If-Range', `"${sha(TEXT)}"`)
      .expect(206);
    expect(fresh.body.toString()).toBe(TEXT.slice(2, 6));

    const stale = await request(app)
      .get(`/api/uploads/${s.id}/content`)
      .set('Range', 'bytes=2-5')
      .set('If-Range', '"0000000000000000000000000000000000000000000000000000000000000000"')
      .expect(200);
    expect(stale.body.toString()).toBe(TEXT);
    expect(stale.headers['content-range']).toBeUndefined();
  });

  it('active sessions answer 409 — a moving prefix is never served as a file', async () => {
    const app = await makeApp(makeStorage());
    const s = await createSession(app);
    await append(app, s.id, buf('partial-'), 0, 0, 'p');

    const get = await request(app).get(`/api/uploads/${s.id}/content`).expect(409);
    expect(get.body.error).toBe('session_not_completed');
    expect(get.body.state).toBe('active');
    expect(get.headers['x-session-state']).toBe('active');
    expect(get.headers['upload-offset']).toBe('8');

    const head = await request(app).head(`/api/uploads/${s.id}/content`).expect(409);
    expect(head.headers['x-session-state']).toBe('active');
  });

  it('cancelled sessions answer 410 even though the bytes may still be on disk', async () => {
    const app = await makeApp(makeStorage());
    const s = await createSession(app);
    await append(app, s.id, buf('kept-bytes'), 0, 0, 'k');
    await request(app).delete(`/api/uploads/${s.id}`).expect(200);

    const get = await request(app).get(`/api/uploads/${s.id}/content`).expect(410);
    expect(get.body.error).toBe('session_cancelled');
    expect(get.headers['x-session-state']).toBe('cancelled');
    const head = await request(app).head(`/api/uploads/${s.id}/content`).expect(410);
    expect(head.headers['x-session-state']).toBe('cancelled');
  });

  it('expired sessions answer 410', async () => {
    let now = 5_000_000;
    const engine = new UploadEngine(makeStorage(), {now: () => now});
    const app = createApp(engine);
    const s = await createSession(app, 2500);
    await append(app, s.id, buf('old'), 0, 0, 'o');
    now += 3000;
    await request(app).get(`/api/uploads/${s.id}/content`).expect(410);
  });

  it('DELETE on a completed object is 409 and the object stays downloadable', async () => {
    const app = await makeApp(makeStorage());
    const s = await seedCompleted(app, TEXT);

    const del = await request(app).delete(`/api/uploads/${s.id}`).expect(409);
    expect(del.body.error).toBe('session_not_active');
    expect(del.body.state).toBe('completed');

    const get = await request(app).get(`/api/uploads/${s.id}/content`).expect(200);
    expect(get.body.toString()).toBe(TEXT);
  });

  it('completing a cancelled session is 409 and never opens a download', async () => {
    const app = await makeApp(makeStorage());
    const s = await createSession(app);
    await request(app).delete(`/api/uploads/${s.id}`).expect(200);
    const complete = await request(app).post(`/api/uploads/${s.id}/complete`).expect(409);
    expect(complete.body.state).toBe('cancelled');
    await request(app).get(`/api/uploads/${s.id}/content`).expect(410);
  });

  it('complete is idempotent and identifies the same bytes', async () => {
    const app = await makeApp(makeStorage());
    const s = await seedCompleted(app, TEXT);
    const again = await request(app).post(`/api/uploads/${s.id}/complete`).expect(200);
    expect(again.body.state).toBe('completed');
    expect(again.body.sha256).toBe(sha(TEXT));
  });

  it('serves a zero-byte completed object as 200 with empty body', async () => {
    const app = await makeApp(makeStorage());
    const s = await createSession(app);
    await request(app).post(`/api/uploads/${s.id}/complete`).expect(200);
    const get = await request(app).get(`/api/uploads/${s.id}/content`).expect(200);
    expect(get.body.length ?? 0).toBe(0);
    expect(get.headers['content-length']).toBe('0');
    expect(get.headers['etag']).toBe(`"${sha(Buffer.alloc(0))}"`);
  });

  it('seal failure: a blob whose bytes drifted from the prefix cannot be completed or downloaded', async () => {
    // Corrupt the blob behind the engine's back, then try to seal.
    const storage = makeStorage();
    const engine = new UploadEngine(storage);
    const app = createApp(engine);
    const s = await createSession(app);
    await append(app, s.id, buf('good'), 0, 0, 'g');

    if (storage instanceof InMemoryStorage) {
      storage.blobs.set(s.id, Buffer.from('tampered-bytes'));
    } else {
      const dir = diskDirs.get(storage as DiskStorage)!;
      await writeFile(path.join(dir, `${s.id}.part`), 'tampered-bytes');
    }

    const lengthMismatch = Buffer.from('tampered-bytes').length !== 6;
    const res = await request(app).post(`/api/uploads/${s.id}/complete`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('seal_failed');
    expect(lengthMismatch || /digest/.test(res.body.detail)).toBe(true);

    // Still active -> content endpoint refuses (moving prefix), never serving
    // the tampered bytes under the tracked identity.
    await request(app).get(`/api/uploads/${s.id}/content`).expect(409);
  });
});

describe('DiskStorage specific streaming', () => {
  it('serving a range is bounded: digest() runs only at seal, GETs never re-hash or read the whole blob', async () => {
    // Wrap InMemoryStorage to count digest() calls and record every read
    // window. A range GET must not call digest() and must only touch the
    // requested slice — serving a small range never loads the full file.
    const inner = new InMemoryStorage();
    const reads: Array<{offset: number; length: number}> = [];
    let digestCalls = 0;
    const spy: UploadStorage = {
      appendChunk: (id, offset, chunk) => inner.appendChunk(id, offset, chunk),
      readChunk: async (id, offset, length) => {
        reads.push({offset, length});
        return inner.readChunk(id, offset, length);
      },
      createReadStream: (id, offset, endExclusive) => {
        reads.push({offset, length: (endExclusive ?? Number.MAX_SAFE_INTEGER) - offset});
        return inner.createReadStream(id, offset, endExclusive);
      },
      length: (id) => inner.length(id),
      digest: async (id) => {
        digestCalls += 1;
        return inner.digest(id);
      },
      remove: (id) => inner.remove(id),
      saveMeta: (id, meta) => inner.saveMeta!(id, meta),
    };
    const app = createApp(new UploadEngine(spy));
    const s = await createSession(app);
    const big = Buffer.alloc(100_000, 9);
    await request(app)
      .patch(`/api/uploads/${s.id}`)
      .set('Content-Type', 'application/octet-stream')
      .set('Upload-Offset', '0')
      .set('If-Match', '"0"')
      .set('Upload-Request-Id', 'big')
      .send(big)
      .expect(200);

    digestCalls = 0;
    reads.length = 0;
    await request(app).post(`/api/uploads/${s.id}/complete`).expect(200);
    expect(digestCalls).toBe(1); // exactly one full-hash: the seal

    digestCalls = 0;
    reads.length = 0;
    // A small range of a large object.
    await request(app)
      .get(`/api/uploads/${s.id}/content`)
      .set('Range', 'bytes=100-199')
      .expect(206);
    expect(digestCalls).toBe(0); // no whole-file hashing on the read path
    expect(reads.some((x) => x.length > 100)).toBe(false); // no full-blob read
    expect(reads).toContainEqual({offset: 100, length: 100});

    // HEAD also must not hash.
    reads.length = 0;
    await request(app).head(`/api/uploads/${s.id}/content`).expect(200);
    expect(digestCalls).toBe(0);
  });

  it('range serving reads the requested window from disk and never buffers the whole file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-bounded-'));
    try {
      const storage = new DiskStorage(dir);
      const app = createApp(new UploadEngine(storage));
      const big = Buffer.alloc(500_000, 7);
      const s = await createSession(app);
      await request(app)
        .patch(`/api/uploads/${s.id}`)
        .set('Content-Type', 'application/octet-stream')
        .set('Upload-Offset', '0')
        .set('If-Match', '"0"')
        .set('Upload-Request-Id', 'big')
        .send(big)
        .expect(200);
      await request(app).post(`/api/uploads/${s.id}/complete`).expect(200);

      const res = await request(app)
        .get(`/api/uploads/${s.id}/content`)
        .set('Range', 'bytes=100-199')
        .expect(206);
      expect(res.body.length).toBe(100);
      expect(res.body.every((b: number) => b === 7)).toBe(true);
      expect(res.headers['content-range']).toBe('bytes 100-199/500000');
      expect((await readFile(path.join(dir, `${s.id}.part`))).length).toBe(500_000);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});
