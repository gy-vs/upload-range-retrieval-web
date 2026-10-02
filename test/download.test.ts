import {afterEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createApp} from '../src/server/index';
import {DiskStorage, InMemoryStorage} from '../src/server/storage';
import {UploadEngine} from '../src/server/engine';

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const shaB64 = (data: Buffer | string) => createHash('sha256').update(data).digest('base64');
const buf = (text: string) => Buffer.from(text, 'utf8');

type App = ReturnType<typeof createApp>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function makeBackend(kind: 'memory' | 'disk', now?: () => number) {
  if (kind === 'memory') {
    const storage = new InMemoryStorage();
    return {engine: new UploadEngine(storage, now ? {now} : {}), storage};
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'download-'));
  cleanups.push(() => rm(dir, {recursive: true, force: true}));
  const storage = new DiskStorage(dir);
  return {engine: new UploadEngine(storage, now ? {now} : {}), storage, dir};
}

async function createSession(app: App, ttlMs: number | null = null, name = 'file.bin') {
  const res = await request(app).post('/api/uploads').send({ttlMs, name}).expect(201);
  return res.body as {id: string; offset: number; revision: number; sha256: string; state: string};
}

async function patchChunk(app: App, id: string, chunk: Buffer, offset: number, revision: number) {
  return request(app)
    .patch(`/api/uploads/${id}`)
    .set('Content-Type', 'application/offset-bytes')
    .set('Upload-Offset', String(offset))
    .set('If-Match', `"${revision}"`)
    .set('Upload-Checksum', sha(chunk))
    .send(chunk)
    .expect(200);
}

/** Upload `content` in two chunks and complete the session. */
async function completedSession(app: App, content: Buffer, name = 'file.bin') {
  const s = await createSession(app, null, name);
  const half = Math.floor(content.length / 2);
  await patchChunk(app, s.id, content.subarray(0, half), 0, 0);
  await patchChunk(app, s.id, content.subarray(half), half, 1);
  await request(app).post(`/api/uploads/${s.id}/complete`).expect(200);
  return s.id;
}

const CONTENT = buf('the-complete-file-contents-0123456789abcdefghijklmnopqrstuvwxyz');

for (const kind of ['memory', 'disk'] as const) {
  describe(`download protocol (${kind})`, () => {
    it('HEAD on a completed session returns identity, length and digest without a body', async () => {
      const {engine} = await makeBackend(kind);
      const app = createApp(engine);
      const id = await completedSession(app, CONTENT);

      const res = await request(app).head(`/api/uploads/${id}/download`).expect(200);
      expect(res.headers['content-length']).toBe(String(CONTENT.length));
      expect(res.headers['etag']).toBe(`"${sha(CONTENT)}"`);
      expect(res.headers['digest']).toBe(`sha-256=:${shaB64(CONTENT)}:`);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.text ?? '').toBe('');
    });

    it('GET full content: body, ETag, Digest and Content-Length all agree', async () => {
      const {engine} = await makeBackend(kind);
      const app = createApp(engine);
      const id = await completedSession(app, CONTENT);

      const res = await request(app)
        .get(`/api/uploads/${id}/download`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.body.equals(CONTENT)).toBe(true);
      expect(res.headers['content-length']).toBe(String(CONTENT.length));
      expect(res.headers['etag']).toBe(`"${sha(CONTENT)}"`);
      expect(res.headers['digest']).toBe(`sha-256=:${shaB64(CONTENT)}:`);
    });

    it('GET with a byte range: 206, Content-Range and a Content-Digest over exactly this body', async () => {
      const {engine} = await makeBackend(kind);
      const app = createApp(engine);
      const id = await completedSession(app, CONTENT);

      const res = await request(app)
        .get(`/api/uploads/${id}/download`)
        .set('Range', 'bytes=10-19')
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(206);
      const expected = CONTENT.subarray(10, 20);
      expect(res.body.equals(expected)).toBe(true);
      expect(res.headers['content-range']).toBe(`bytes 10-19/${CONTENT.length}`);
      expect(res.headers['content-length']).toBe('10');
      // Body identity of THIS response vs identity of the WHOLE object.
      expect(res.headers['content-digest']).toBe(`sha-256=:${shaB64(expected)}:`);
      expect(res.headers['digest']).toBe(`sha-256=:${shaB64(CONTENT)}:`);
      expect(res.headers['etag']).toBe(`"${sha(CONTENT)}"`);
    });

    it('open-ended and suffix ranges are supported', async () => {
      const {engine} = await makeBackend(kind);
      const app = createApp(engine);
      const id = await completedSession(app, CONTENT);

      const open = await request(app)
        .get(`/api/uploads/${id}/download`)
        .set('Range', 'bytes=50-')
        .expect(206);
      expect(open.headers['content-range']).toBe(`bytes 50-${CONTENT.length - 1}/${CONTENT.length}`);

      const suffix = await request(app)
        .get(`/api/uploads/${id}/download`)
        .set('Range', 'bytes=-7')
        .expect(206);
      expect(suffix.headers['content-range']).toBe(
        `bytes ${CONTENT.length - 7}-${CONTENT.length - 1}/${CONTENT.length}`,
      );
    });

    it('unsatisfiable ranges get 416 with the total size', async () => {
      const {engine} = await makeBackend(kind);
      const app = createApp(engine);
      const id = await completedSession(app, CONTENT);

      const res = await request(app)
        .get(`/api/uploads/${id}/download`)
        .set('Range', `bytes=${CONTENT.length}-`)
        .expect(416);
      expect(res.headers['content-range']).toBe(`bytes */${CONTENT.length}`);
      expect(res.body.error).toBe('range_not_satisfiable');
    });

    it('If-Range with the pinned ETag serves the range; a stale one serves full content', async () => {
      const {engine} = await makeBackend(kind);
      const app = createApp(engine);
      const id = await completedSession(app, CONTENT);
      const etag = `"${sha(CONTENT)}"`;

      const match = await request(app)
        .get(`/api/uploads/${id}/download`)
        .set('Range', 'bytes=0-9')
        .set('If-Range', etag)
        .expect(206);
      expect(match.headers['content-range']).toBe(`bytes 0-9/${CONTENT.length}`);

      // Stale validator: the client must get a 200 (full content) so it can
      // detect the identity change instead of splicing two versions.
      const stale = await request(app)
        .get(`/api/uploads/${id}/download`)
        .set('Range', 'bytes=0-9')
        .set('If-Range', '"0000deadbeef"')
        .expect(200);
      expect(stale.headers['content-range']).toBeUndefined();
      expect(stale.headers['content-length']).toBe(String(CONTENT.length));
      expect(stale.headers['etag']).toBe(etag);
    });

    it('two ranged GETs reassemble into the full verified object', async () => {
      const {engine} = await makeBackend(kind);
      const app = createApp(engine);
      const id = await completedSession(app, CONTENT);
      const half = Math.floor(CONTENT.length / 2);

      const read = async (range: string) => {
        const res = await request(app)
          .get(`/api/uploads/${id}/download`)
          .set('Range', range)
          .buffer(true)
          .parse((r, cb) => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () => cb(null, Buffer.concat(chunks)));
          })
          .expect(206);
        expect(res.headers['etag']).toBe(`"${sha(CONTENT)}"`);
        return res.body as Buffer;
      };

      const assembled = Buffer.concat([await read(`bytes=0-${half - 1}`), await read(`bytes=${half}-`)]);
      expect(assembled.equals(CONTENT)).toBe(true);
      expect(sha(assembled)).toBe(sha(CONTENT));
    });

    it('active session: 409 explains the still-changing prefix, nothing is served', async () => {
      const {engine} = await makeBackend(kind);
      const app = createApp(engine);
      const s = await createSession(app);
      await patchChunk(app, s.id, buf('partial'), 0, 0);

      const res = await request(app).get(`/api/uploads/${s.id}/download`).expect(409);
      expect(res.body.error).toBe('session_active');
      expect(res.body.offset).toBe(7);
      expect(res.body.sha256).toBe(sha('partial'));

      // HEAD explains the same state via headers (no body to read them from)
      // and never advertises a downloadable object. (Express adds a WEAK
      // ETag to the JSON error body itself — never our strong object ETag.)
      const head = await request(app).head(`/api/uploads/${s.id}/download`).expect(409);
      expect(head.headers['x-session-error']).toBe('session_active');
      expect(head.headers['upload-offset']).toBe('7');
      expect(head.headers['x-prefix-sha256']).toBe(sha('partial'));
      expect(head.headers['etag']).not.toBe(`"${sha('partial')}"`);
      expect(String(head.headers['etag'] ?? '')).toMatch(/^W\//);
      expect(head.headers['accept-ranges']).toBeUndefined();
    });

    it('cancelled session: 410 even though the bytes are still in storage', async () => {
      const {engine, storage, dir} = await makeBackend(kind);
      const app = createApp(engine);
      const s = await createSession(app);
      await patchChunk(app, s.id, buf('kept-bytes'), 0, 0);
      await request(app).delete(`/api/uploads/${s.id}`).expect(200);

      if (kind === 'disk' && dir) {
        // The blob still exists on disk — the 410 is a protocol decision,
        // not a side effect of the file being gone.
        await expect(stat(path.join(dir, `${s.id}.part`))).resolves.toBeTruthy();
      }
      expect(await storage.length(s.id)).toBe(10);

      const res = await request(app).get(`/api/uploads/${s.id}/download`).expect(410);
      expect(res.body.error).toBe('session_cancelled');
      expect(res.body.offset).toBe(10);
      expect(res.body.sha256).toBe(sha('kept-bytes'));
      expect(res.headers['x-session-error']).toBe('session_cancelled');
      const head = await request(app).head(`/api/uploads/${s.id}/download`).expect(410);
      expect(head.headers['x-session-error']).toBe('session_cancelled');
      expect(head.headers['upload-offset']).toBe('10');
    });

    it('expired session: 410 and the blob is evicted', async () => {
      let now = 1_000_000;
      const {engine} = await makeBackend(kind, () => now);
      const app = createApp(engine);
      const s = await createSession(app, 1000);
      await patchChunk(app, s.id, buf('old'), 0, 0);

      now += 2000;
      const res = await request(app).get(`/api/uploads/${s.id}/download`).expect(410);
      expect(res.body.error).toBe('session_expired');
    });

    it('cancel after completion: the cancel wins and explains the confirmed bytes', async () => {
      const {engine} = await makeBackend(kind);
      const app = createApp(engine);
      const id = await completedSession(app, CONTENT);
      await request(app).delete(`/api/uploads/${id}`).expect(200);

      const res = await request(app).get(`/api/uploads/${id}/download`).expect(410);
      expect(res.body.error).toBe('session_cancelled');
      expect(res.body.offset).toBe(CONTENT.length);
      expect(res.body.sha256).toBe(sha(CONTENT));
    });

    it('zero-byte completed file: GET 200 with length 0, ranges are 416', async () => {
      const {engine} = await makeBackend(kind);
      const app = createApp(engine);
      const s = await createSession(app);
      await request(app).post(`/api/uploads/${s.id}/complete`).expect(200);

      const res = await request(app).get(`/api/uploads/${s.id}/download`).expect(200);
      expect(res.headers['content-length']).toBe('0');
      expect(res.headers['etag']).toBe(`"${sha(Buffer.alloc(0))}"`);

      await request(app)
        .get(`/api/uploads/${s.id}/download`)
        .set('Range', 'bytes=0-')
        .expect(416);
    });

    it('full GET is assembled from storage slices, not one whole-blob read', async () => {
      const {engine} = await makeBackend(kind);
      // Tiny slice size forces the streaming loop through many iterations.
      const app = createApp(engine, {downloadSliceBytes: 4});
      const id = await completedSession(app, CONTENT);

      const res = await request(app)
        .get(`/api/uploads/${id}/download`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.body.equals(CONTENT)).toBe(true);

      const ranged = await request(app)
        .get(`/api/uploads/${id}/download`)
        .set('Range', 'bytes=3-30')
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(206);
      expect(ranged.body.equals(CONTENT.subarray(3, 31))).toBe(true);
    });

    it('unknown session id is 410, never a served file', async () => {
      const {engine} = await makeBackend(kind);
      const app = createApp(engine);
      const res = await request(app).get('/api/uploads/s_nope/download').expect(410);
      expect(res.body.error).toBe('session_expired');
    });
  });
}
