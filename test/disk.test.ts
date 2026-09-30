import {describe, expect, it} from 'vitest';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DiskStorage} from '../src/server/storage';
import {UploadEngine} from '../src/server/engine';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe('DiskStorage durability contract', () => {
  it('appends sync to disk and metadata snapshots atomically', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'uploads-'));
    try {
      const storage = new DiskStorage(dir);
      const engine = new UploadEngine(storage);
      const session = engine.createSession({id: 'demo', ttlMs: null});

      await engine.appendChunk('demo', {
        requestId: 'c1',
        expectedRevision: 0,
        expectedOffset: 0,
        chunk: Buffer.from('abc'),
        checksum: undefined,
      });

      const fileBytes = await readFile(path.join(dir, 'demo.part'));
      expect(fileBytes.toString()).toBe('abc');
      const meta = JSON.parse((await readFile(path.join(dir, 'demo.meta.json'))).toString());
      expect(meta).toMatchObject({id: 'demo', offset: 3, revision: 1});
      expect(meta.sha256).toBe(sha(Buffer.from('abc')));
      expect(await stat(path.join(dir, 'demo.meta.json.tmp')).catch(() => null)).toBeNull();

      expect(session.offset).toBe(3);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  it('a failed append leaves file length and metadata untouched', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'uploads-'));
    try {
      const storage = new DiskStorage(dir);
      const engine = new UploadEngine(storage);
      engine.createSession({id: 'f', ttlMs: null});
      const first = await engine.appendChunk('f', {
        requestId: 'c0',
        expectedRevision: 0,
        expectedOffset: 0,
        chunk: Buffer.from('xy'),
        checksum: undefined,
      });
      expect(first.status).toBe(200);

      storage.planFailure('append');
      const outcome = await engine.appendChunk('f', {
        requestId: 'c-fail',
        expectedRevision: 1,
        expectedOffset: 2,
        chunk: Buffer.from('NO'),
        checksum: undefined,
      });
      expect(outcome.status).toBe(507);

      const session = engine.getSession('f')!;
      expect(session.offset).toBe(2);
      expect(session.revision).toBe(1);
      expect(await storage.length('f')).toBe(2);
      expect((await readFile(path.join(dir, 'f.part'))).toString()).toBe('xy');

      // After recovery the same logical chunk lands correctly.
      const retry = await engine.appendChunk('f', {
        requestId: 'c-fail',
        expectedRevision: 1,
        expectedOffset: 2,
        chunk: Buffer.from('NO'),
        checksum: undefined,
      });
      expect(retry.status).toBe(200);
      expect((retry.body as {offset: number; sha256: string}).sha256).toBe(
        sha(Buffer.from('xyNO')),
      );
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});
