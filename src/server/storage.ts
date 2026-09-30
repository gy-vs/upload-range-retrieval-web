import {createHash} from 'node:crypto';
import {mkdir,open,rename,rm,readFile} from 'node:fs/promises';
import path from 'node:path';

/**
 * A blob store that supports exactly one mutating operation per session:
 * appending a chunk at a given offset. The contract every backend MUST keep:
 *
 *   If appendChunk throws, the stored length MUST be unchanged — a failed
 *   write must never leave a partial prefix behind, because the session
 *   metadata (offset/revision) is only advanced after this call succeeds.
 *
 * Metadata (offset, revision, checksum, TTL state) is owned by the engine and
 * snapshotted via `saveMeta`; a metadata snapshot failure also must not lose
 * the just-appended bytes (the next session load reconciles the file length).
 */
export interface UploadStorage {
  appendChunk(sessionId: string, offset: number, chunk: Buffer): Promise<void>;
  readChunk(sessionId: string, offset: number, length: number): Promise<Buffer>;
  length(sessionId: string): Promise<number>;
  digest(sessionId: string): Promise<string>;
  remove(sessionId: string): Promise<void>;
  saveMeta?(sessionId: string, meta: SessionMetaSnapshot): Promise<void>;
  /** Optional demo/test fault injection: next durable op of this kind fails. */
  planFailure?(kind: 'append' | 'meta'): void;
}

export type SessionMetaSnapshot = {
  id: string;
  offset: number;
  revision: number;
  sha256: string;
  state: 'active' | 'completed' | 'cancelled';
  expiresAt: number | null;
};

export class InMemoryStorage implements UploadStorage {
  blobs = new Map<string, Buffer>();
  snapshots = new Map<string, SessionMetaSnapshot>();
  /** When set, the next N appendChunk calls reject instead of writing. */
  failNextAppends = 0;
  /** When set, the next N saveMeta calls reject. */
  failNextMetaSaves = 0;

  async appendChunk(sessionId: string, offset: number, chunk: Buffer): Promise<void> {
    if (this.failNextAppends > 0) {
      this.failNextAppends -= 1;
      throw new Error('simulated storage write failure');
    }
    const current = this.blobs.get(sessionId) ?? Buffer.alloc(0);
    if (current.length !== offset) {
      // Defensive: the engine already compares offset under the session lock.
      throw Object.assign(new Error('offset_mismatch'), {code: 'offset_mismatch'});
    }
    // Atomic in-process replacement: either the new buffer is visible whole
    // or the old one stays. No torn writes, no length change on the error path.
    this.blobs.set(sessionId, Buffer.concat([current, chunk]));
  }

  async readChunk(sessionId: string, offset: number, length: number): Promise<Buffer> {
    const current = this.blobs.get(sessionId) ?? Buffer.alloc(0);
    return current.subarray(offset, offset + length);
  }

  async length(sessionId: string): Promise<number> {
    return (this.blobs.get(sessionId) ?? Buffer.alloc(0)).length;
  }

  async digest(sessionId: string): Promise<string> {
    return createHash('sha256').update(this.blobs.get(sessionId) ?? Buffer.alloc(0)).digest('hex');
  }

  async remove(sessionId: string): Promise<void> {
    this.blobs.delete(sessionId);
    this.snapshots.delete(sessionId);
  }

  async saveMeta(sessionId: string, meta: SessionMetaSnapshot): Promise<void> {
    if (this.failNextMetaSaves > 0) {
      this.failNextMetaSaves -= 1;
      throw new Error('simulated metadata write failure');
    }
    this.snapshots.set(sessionId, {...meta});
  }

  planFailure(kind: 'append' | 'meta'): void {
    if (kind === 'append') this.failNextAppends += 1;
    else this.failNextMetaSaves += 1;
  }
}

/**
 * Filesystem backend. Each session is one file; appends go through a single
 * `write` at the expected position followed by `sync`. fsync failure surfaces
 * as a rejected promise and leaves metadata untouched; an unexpected partial
 * write is truncated back to the expected length so the blob invariant holds.
 */
export class DiskStorage implements UploadStorage {
  private failNextAppends = 0;
  private failNextMetaSaves = 0;

  constructor(private readonly dir: string) {}

  private fileFor(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw Object.assign(new Error('invalid session id'), {code: 'invalid_id'});
    }
    return path.join(this.dir, sessionId + '.part');
  }

  private metaFor(sessionId: string): string {
    return path.join(this.dir, sessionId + '.meta.json');
  }

  async ensure(): Promise<void> {
    await mkdir(this.dir, {recursive: true});
  }

  async appendChunk(sessionId: string, offset: number, chunk: Buffer): Promise<void> {
    if (this.failNextAppends > 0) {
      this.failNextAppends -= 1;
      throw new Error('simulated storage write failure');
    }
    await this.ensure();
    const file = await open(this.fileFor(sessionId), 'a');
    try {
      // With 'a' the position argument is ignored on POSIX; instead verify
      // against the current size so the write cannot land anywhere else.
      const stat = await file.stat();
      if (stat.size !== offset) {
        throw Object.assign(new Error('offset_mismatch'), {code: 'offset_mismatch'});
      }
      if (chunk.length === 0) {
        await file.sync();
        return;
      }
      const {bytesWritten} = await file.write(chunk, 0, chunk.length);
      if (bytesWritten !== chunk.length) {
        // Roll the file back to the pre-write length; metadata never moved.
        await file.truncate(offset);
        await file.sync();
        throw new Error(`short write (${bytesWritten}/${chunk.length})`);
      }
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async readChunk(sessionId: string, offset: number, length: number): Promise<Buffer> {
    const file = await open(this.fileFor(sessionId), 'r');
    try {
      const buffer = Buffer.alloc(length);
      const {bytesRead} = await file.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }

  async length(sessionId: string): Promise<number> {
    try {
      await this.ensure();
      const file = await open(this.fileFor(sessionId), 'r');
      try {
        return (await file.stat()).size;
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  async digest(sessionId: string): Promise<string> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.fileFor(sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') bytes = Buffer.alloc(0);
      else throw error;
    }
    return createHash('sha256').update(bytes).digest('hex');
  }

  async remove(sessionId: string): Promise<void> {
    await rm(this.fileFor(sessionId), {force: true});
    await rm(this.metaFor(sessionId), {force: true});
  }

  /**
   * Metadata snapshots are written to a temp file, fsynced and atomically
   * renamed — callers either see the previous snapshot or the new one.
   */
  async saveMeta(sessionId: string, meta: SessionMetaSnapshot): Promise<void> {
    if (this.failNextMetaSaves > 0) {
      this.failNextMetaSaves -= 1;
      throw new Error('simulated metadata write failure');
    }
    await this.ensure();
    const target = this.metaFor(sessionId);
    const tmp = target + '.tmp';
    const file = await open(tmp, 'w');
    try {
      await file.writeFile(JSON.stringify(meta));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, target);
  }

  planFailure(kind: 'append' | 'meta'): void {
    if (kind === 'append') this.failNextAppends += 1;
    else this.failNextMetaSaves += 1;
  }
}
