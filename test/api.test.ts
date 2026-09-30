import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createHash} from 'node:crypto';
import {createApp} from '../src/server/index';
import {InMemoryStorage} from '../src/server/storage';
import {UploadEngine} from '../src/server/engine';

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const buf = (text: string) => Buffer.from(text, 'utf8');

type App = ReturnType<typeof createApp>;

async function createSession(app: App, ttlMs?: number | null) {
  const res = await request(app)
    .post('/api/uploads')
    .send(ttlMs === undefined ? {} : {ttlMs})
    .expect(201);
  return res.body as {id: string; offset: number; revision: number; sha256: string; state: string};
}

function patch(
  app: App,
  id: string,
  chunk: Buffer,
  options: {offset: number; revision?: number; requestId?: string; checksum?: boolean} = {
    offset: 0,
  },
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/offset-bytes',
    'Upload-Offset': String(options.offset),
  };
  if (options.revision !== undefined) headers['If-Match'] = `"${options.revision}"`;
  if (options.requestId) headers['Upload-Request-Id'] = options.requestId;
  if (options.checksum) headers['Upload-Checksum'] = sha(chunk);
  return request(app)
    .patch(`/api/uploads/${id}`)
    .set(headers)
    .send(chunk);
}

describe('offset-CAS upload protocol', () => {
  it('appends chunks strictly in order and tracks offset/revision/digest', async () => {
    const app = createApp();
    const s = await createSession(app);

    const r1 = await patch(app, s.id, buf('hello '), {offset: 0, revision: 0, requestId: 'r1'}).expect(200);
    expect(r1.body.offset).toBe(6);
    expect(r1.body.revision).toBe(1);
    expect(r1.body.sha256).toBe(sha('hello '));
    expect(r1.headers['upload-offset']).toBe('6');

    const r2 = await patch(app, s.id, buf('world'), {offset: 6, revision: 1, requestId: 'r2'}).expect(200);
    expect(r2.body.offset).toBe(11);
    expect(r2.body.revision).toBe(2);
    expect(r2.body.sha256).toBe(sha('hello world'));

    const got = await request(app).get(`/api/uploads/${s.id}`).expect(200);
    expect(got.body.offset).toBe(11);
    expect(got.body.chunks.map((c: {offset: number}) => c.offset)).toEqual([0, 6]);
  });

  it('concurrent same-offset PATCHes: one wins, the loser gets 409 + current offset and writes nothing', async () => {
    const app = createApp();
    const s = await createSession(app);

    const [a, b] = await Promise.all([
      patch(app, s.id, buf('AAAA'), {offset: 0, revision: 0, requestId: 'dup-a'}),
      patch(app, s.id, buf('AAAA'), {offset: 0, revision: 0, requestId: 'dup-b'}),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const ok = a.status === 200 ? a : b;
    const conflict = a.status === 409 ? a : b;

    expect(ok.body.offset).toBe(4);
    expect(ok.body.revision).toBe(1);

    // Conflict reports the CURRENT committed offset/revision — no overwrite.
    expect(conflict.body.error).toBe('offset_conflict');
    expect(conflict.body.offset).toBe(4);
    expect(conflict.body.revision).toBe(1);
    expect(conflict.headers['upload-offset']).toBe('4');

    // The blob is exactly one copy: later write never overwrote earlier one.
    const state = await request(app).get(`/api/uploads/${s.id}`).expect(200);
    expect(state.body.offset).toBe(4);
    expect(state.body.revision).toBe(1);
    expect(state.body.sha256).toBe(sha('AAAA'));
  });

  it('handles many concurrent same-offset submissions (only the first appends)', async () => {
    const app = createApp();
    const s = await createSession(app);
    const results = await Promise.all(
      Array.from({length: 8}, (_, i) =>
        patch(app, s.id, buf('X'.repeat(4)), {offset: 0, revision: 0, requestId: `x${i}`}),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    const state = await request(app).get(`/api/uploads/${s.id}`).expect(200);
    expect(state.body.offset).toBe(4);
    expect(state.body.revision).toBe(1);
  });

  it('overlapping blocks: stale offset conflicts, then trimmed suffix appends', async () => {
    const app = createApp();
    const s = await createSession(app);

    // Block A: [0, 8)
    await patch(app, s.id, buf('01234567'), {offset: 0, revision: 0, requestId: 'a'}).expect(200);
    // Block B was planned at [4, 12) and arrives unchanged — conflict.
    const clash = await patch(app, s.id, buf('456789AB'), {offset: 4, revision: 1, requestId: 'b'}).expect(409);
    expect(clash.body.offset).toBe(8);
    expect(clash.body.revision).toBe(1);

    // Client trims the already-covered prefix ("4567") and resends only it.
    const suffix = await patch(app, s.id, buf('89AB'), {offset: 8, revision: 1, requestId: 'b-tail'}).expect(200);
    expect(suffix.body.offset).toBe(12);
    expect(suffix.body.sha256).toBe(sha('0123456789AB'));
  });

  it('advanced offset (gap) is also rejected without writing', async () => {
    const app = createApp();
    const s = await createSession(app);
    const r = await patch(app, s.id, buf('abc'), {offset: 5, revision: 0, requestId: 'gap'}).expect(409);
    expect(r.body.offset).toBe(0);
    const state = await request(app).get(`/api/uploads/${s.id}`).expect(200);
    expect(state.body.offset).toBe(0);
    expect(state.body.revision).toBe(0);
  });

  it('zero-length chunks bump revision but never the offset, and remain consistent', async () => {
    const app = createApp();
    const s = await createSession(app);

    const empty1 = await patch(app, s.id, Buffer.alloc(0), {offset: 0, revision: 0, requestId: 'z0'}).expect(200);
    expect(empty1.body.offset).toBe(0);
    expect(empty1.body.revision).toBe(1);
    expect(empty1.body.sha256).toBe(sha(Buffer.alloc(0)));

    const data = await patch(app, s.id, buf('data'), {offset: 0, revision: 1, requestId: 'd'}).expect(200);
    expect(data.body.offset).toBe(4);
    expect(data.body.revision).toBe(2);

    const empty2 = await patch(app, s.id, Buffer.alloc(0), {offset: 4, revision: 2, requestId: 'z1'}).expect(200);
    expect(empty2.body.offset).toBe(4);
    expect(empty2.body.revision).toBe(3);

    // Only the non-empty chunk is recorded; digest matches the bytes.
    const state = await request(app).get(`/api/uploads/${s.id}`).expect(200);
    expect(state.body.chunks).toHaveLength(1);
    expect(state.body.sha256).toBe(sha('data'));
  });

  it('storage write failure does NOT advance offset, revision or digest', async () => {
    const storage = new InMemoryStorage();
    const engine = new UploadEngine(storage);
    const app = createApp(engine);
    const s = await createSession(app);
    await patch(app, s.id, buf('safe-'), {offset: 0, revision: 0, requestId: 'ok'}).expect(200);

    storage.planFailure('append');
    const failed = await patch(app, s.id, buf('LOST'), {offset: 5, revision: 1, requestId: 'failing'}).expect(507);
    expect(failed.body.error).toBe('storage_write_failed');

    const state = await request(app).get(`/api/uploads/${s.id}`).expect(200);
    expect(state.body.offset).toBe(5);
    expect(state.body.revision).toBe(1);
    expect(state.body.sha256).toBe(sha('safe-'));

    // Same request id / bytes retry after storage recovers commits normally.
    const retry = await patch(app, s.id, buf('LOST'), {offset: 5, revision: 1, requestId: 'failing'}).expect(200);
    expect(retry.body.offset).toBe(9);
    expect(retry.body.revision).toBe(2);
    expect(retry.body.sha256).toBe(sha('safe-LOST'));
  });

  it('response lost: retry with the same request id replays 200 without a second write', async () => {
    const app = createApp();
    const s = await createSession(app);
    await patch(app, s.id, buf('once-'), {offset: 0, revision: 0, requestId: 'lost-req'}).expect(200);

    // Client retries the exact same request (response was lost). Offset is
    // now 5, so without the ledger this would be an offset conflict; the
    // ledger replays the ORIGINAL committed response instead.
    const replay = await patch(app, s.id, buf('once-'), {offset: 0, revision: 0, requestId: 'lost-req'}).expect(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.offset).toBe(5);
    expect(replay.body.revision).toBe(1);

    const state = await request(app).get(`/api/uploads/${s.id}`).expect(200);
    expect(state.body.offset).toBe(5);
    expect(state.body.chunks).toHaveLength(1);
    expect(state.body.sha256).toBe(sha('once-'));
  });

  it('two in-flight requests sharing one request id resolve to a single write', async () => {
    const app = createApp();
    const s = await createSession(app);
    const [a, b] = await Promise.all([
      patch(app, s.id, buf('TWIN'), {offset: 0, revision: 0, requestId: 'shared'}),
      patch(app, s.id, buf('TWIN'), {offset: 0, revision: 0, requestId: 'shared'}),
    ]);
    for (const r of [a, b]) {
      expect(r.status).toBe(200);
      expect(r.body.offset).toBe(4);
      expect(r.body.revision).toBe(1);
    }
    const state = await request(app).get(`/api/uploads/${s.id}`).expect(200);
    expect(state.body.offset).toBe(4);
    expect(state.body.revision).toBe(1);
  });

  it('stale session revision (If-Match) conflicts and reports the current revision', async () => {
    const app = createApp();
    const s = await createSession(app);
    await patch(app, s.id, buf('aa'), {offset: 0, revision: 0, requestId: 'one'}).expect(200);
    const stale = await patch(app, s.id, buf('bb'), {offset: 2, revision: 0, requestId: 'two'}).expect(409);
    expect(stale.body.error).toBe('revision_conflict');
    expect(stale.body.revision).toBe(1);
    expect(stale.body.offset).toBe(2);
  });

  it('rejects a bad chunk checksum before writing', async () => {
    const app = createApp();
    const s = await createSession(app);
    const r = await request(app)
      .patch(`/api/uploads/${s.id}`)
      .set('Content-Type', 'application/offset-bytes')
      .set('Upload-Offset', '0')
      .set('Upload-Checksum', sha('something-else'))
      .send(buf('payload'))
      .expect(422);
    expect(r.body.error).toBe('checksum_mismatch');
    const state = await request(app).get(`/api/uploads/${s.id}`).expect(200);
    expect(state.body.offset).toBe(0);
    expect(state.body.revision).toBe(0);
  });

  it('expired session: PATCH and GET return 410 and nothing can be written', async () => {
    let now = 1_000_000;
    const engine = new UploadEngine(new InMemoryStorage(), {now: () => now});
    const app = createApp(engine);
    const s = await createSession(app, 2500);
    await patch(app, s.id, buf('early'), {offset: 0, revision: 0, requestId: 'e1'}).expect(200);

    now += 3000; // past TTL
    await request(app).get(`/api/uploads/${s.id}`).expect(410);
    const late = await patch(app, s.id, buf('late'), {offset: 5, revision: 1, requestId: 'e2'}).expect(410);
    expect(['session_expired']).toContain(late.body.error);
  });

  it('cancelled session: further appends are 410, but the committed prefix stays intact', async () => {
    const app = createApp();
    const s = await createSession(app);
    await patch(app, s.id, buf('kept'), {offset: 0, revision: 0, requestId: 'k'}).expect(200);
    await request(app).delete(`/api/uploads/${s.id}`).expect(200);

    const r = await patch(app, s.id, buf('nope'), {offset: 4, revision: 1, requestId: 'n'}).expect(410);
    expect(r.body.error).toBe('session_cancelled');
    const state = await request(app).get(`/api/uploads/${s.id}`);
    expect([200, 410]).toContain(state.status);
    if (state.status === 200) {
      expect(state.body.state).toBe('cancelled');
      expect(state.body.offset).toBe(4);
      expect(state.body.sha256).toBe(sha('kept'));
    }
  });

  it('completed session rejects further appends', async () => {
    const app = createApp();
    const s = await createSession(app);
    await patch(app, s.id, buf('done'), {offset: 0, revision: 0, requestId: 'd'}).expect(200);
    await request(app).post(`/api/uploads/${s.id}/complete`).expect(200);
    const r = await patch(app, s.id, buf('more'), {offset: 4, revision: 1, requestId: 'm'}).expect(410);
    expect(r.body.error).toBe('session_completed');
  });

  it('invariant: every acknowledged offset identifies the unique persisted prefix', async () => {
    const app = createApp();
    const s = await createSession(app);
    const chunks = [buf('aaaa'), buf('bbbb'), buf('cccc')];
    let assembled = Buffer.alloc(0);
    for (let i = 0; i < chunks.length; i++) {
      assembled = Buffer.concat([assembled, chunks[i]]);
      const r = await patch(app, s.id, chunks[i], {
        offset: assembled.length - chunks[i].length,
        revision: i,
        requestId: `p${i}`,
      }).expect(200);
      expect(r.body.offset).toBe(assembled.length);
      expect(r.body.sha256).toBe(sha(assembled));
    }
    // Concurrent late duplicates never disturb the final unique prefix.
    await Promise.all(
      [0, 1, 2].map((i) =>
        patch(app, s.id, chunks[i], {
          offset: chunks.slice(0, i).reduce((n, c) => n + c.length, 0),
          revision: i,
          requestId: `late-${i}`,
        }),
      ),
    ).then((rs) => rs.forEach((r) => expect(r.status).toBe(409)));

    const final = await request(app).get(`/api/uploads/${s.id}`).expect(200);
    expect(final.body.offset).toBe(12);
    expect(final.body.revision).toBe(3);
    expect(final.body.sha256).toBe(sha('aaaabbbbcccc'));
  });
});
