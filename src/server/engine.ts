import {createHash, type Hash, timingSafeEqual} from 'node:crypto';
import type {Readable} from 'node:stream';
import type {UploadStorage} from './storage';

export type SessionState = 'active' | 'completed' | 'cancelled';

export type ChunkRecord = {requestId: string; offset: number; length: number; sha256: string};

export type UploadSession = {
  id: string;
  name: string;
  /** Number of bytes durably persisted and acknowledged. */
  offset: number;
  /**
   * Monotonic session revision. It only advances together with a durable
   * append (zero-length appends also bump it), and never advances on any
   * error path. A client PATCH must carry the revision it last observed.
   */
  revision: number;
  /** SHA-256 of the whole persisted prefix [0, offset). */
  sha256: string;
  /** Live hash over [0, offset); read via `.copy().digest()`. */
  hasher: Hash;
  /** Per-chunk ledger of acknowledged non-empty appends. */
  chunks: ChunkRecord[];
  /**
   * Idempotency ledger: requestId -> first settled response for that id.
   * Only 200 responses are recorded (they're the only ones that mutate),
   * so a retried PATCH after a lost response is answered identically
   * without a second write.
   */
  ledger: Map<string, {status: 200; body: PatchResultBody}>;
  /** Same request id arriving again while the first call is still in flight. */
  inflight: Map<string, Promise<AppendOutcome>>;
  state: SessionState;
  createdAt: number;
  expiresAt: number | null;
  /** Serialises compare-offset -> append -> commit for one session. */
  lock: Promise<unknown>;
};

export type PatchResultBody = {
  id: string;
  offset: number;
  revision: number;
  sha256: string;
  state: SessionState;
  /** True when produced from the idempotency ledger (response lost retry). */
  replayed?: boolean;
};

export type ConflictBody = {
  error: 'offset_conflict' | 'revision_conflict';
  offset: number;
  revision: number;
  sha256: string;
};

export type ErrorBody = {error: string; detail?: string};
export type AppendOutcome = {status: number; body: PatchResultBody | ConflictBody | ErrorBody};

export type FinalizeOutcome =
  | {status: 200; body: PatchResultBody}
  | {status: 409; body: {error: 'session_not_active'; state: SessionState}}
  | {status: 410; body: {error: 'session_expired'}}
  | {status: 500; body: {error: 'seal_failed'; detail: string}};

/**
 * A handle on an immutable, downloadable object. `etag`/`sha256` identify the
 * full byte sequence [0, size); they never change afterwards, so a downloader
 * can pin them and refuse to splice a different version onto a saved prefix.
 */
export type ContentDescriptor = {
  id: string;
  name: string;
  etag: string;
  size: number;
  sha256: string;
};

export type OpenContentOutcome =
  | {status: 200; descriptor: ContentDescriptor}
  | {
      status: 409;
      body: {error: 'session_not_completed'; state: SessionState; offset: number; sha256: string};
    }
  | {status: 410; body: {error: 'session_expired' | 'session_cancelled'}}
  | {status: 500; body: {error: 'blob_drift'; detail: string}};

export type CreateSessionOptions = {
  id?: string;
  name?: string;
  ttlMs?: number | null;
};

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class UploadEngine {
  readonly sessions = new Map<string, UploadSession>();
  private now: () => number;

  constructor(
    readonly storage: UploadStorage,
    options: {now?: () => number} = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Demo/test hook: make the next durable append or metadata snapshot fail. */
  planStorageFailure(kind: 'append' | 'meta'): void {
    this.storage.planFailure?.(kind);
  }

  createSession(options: CreateSessionOptions = {}): UploadSession {
    const id = options.id ?? randomId();
    const ttl = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
    const session: UploadSession = {
      id,
      name: options.name ?? id,
      offset: 0,
      revision: 0,
      sha256: emptySha256(),
      hasher: createHash('sha256'),
      chunks: [],
      ledger: new Map(),
      inflight: new Map(),
      state: 'active',
      createdAt: this.now(),
      expiresAt: ttl == null ? null : this.now() + ttl,
      lock: Promise.resolve(),
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): UploadSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (this.isExpired(session)) {
      this.evict(session);
      return undefined;
    }
    return session;
  }

  listSessions(): UploadSession[] {
    for (const session of [...this.sessions.values()]) {
      if (this.isExpired(session)) this.evict(session);
    }
    return [...this.sessions.values()];
  }

  isExpired(session: UploadSession): boolean {
    // Only active sessions age out; completed/cancelled ones stay inspectable.
    return session.state === 'active' && session.expiresAt != null && this.now() >= session.expiresAt;
  }

  private evict(session: UploadSession): void {
    this.sessions.delete(session.id);
    void this.storage.remove(session.id).catch(() => undefined);
  }

  /**
   * Cancel is a state-machine transition, so it runs under the same per-session
   * lock as appends: it cannot interleave with an in-flight PATCH, and a
   * completed (frozen) session is never retroactively cancelled — the final
   * object must remain downloadable even if a late DELETE arrives.
   */
  cancelSession(id: string): Promise<FinalizeOutcome> {
    const session = this.sessions.get(id);
    if (!session || this.isExpired(session)) {
      if (session) this.evict(session);
      return Promise.resolve({status: 410, body: {error: 'session_expired'}});
    }
    return this.underLock(session, async () => {
      if (session.state === 'completed') {
        return {status: 409, body: {error: 'session_not_active', state: 'completed'}};
      }
      if (session.state === 'cancelled') {
        return {status: 409, body: {error: 'session_not_active', state: 'cancelled'}};
      }
      session.state = 'cancelled';
      session.expiresAt = null;
      try {
        await this.storage.saveMeta?.(session.id, this.snapshot(session));
      } catch {
        /* in-memory state stands; next snapshot reconciles */
      }
      return {status: 200, body: this.resultBody(session)};
    });
  }

  /**
   * Completion FREEZES the session into an immutable object. Before flipping
   * the state, the durable blob is re-read in full: its length must equal the
   * committed offset and its SHA-256 must equal the tracked prefix digest.
   * Only after that seal does the state become 'completed' and reads open.
   * Serialised by the session lock so it can never race the last append.
   */
  completeSession(id: string): Promise<FinalizeOutcome> {
    const session = this.sessions.get(id);
    if (!session || this.isExpired(session)) {
      if (session) this.evict(session);
      return Promise.resolve({status: 410, body: {error: 'session_expired'}});
    }
    return this.underLock(session, async () => {
      if (this.isExpired(session)) {
        this.evict(session);
        return {status: 410, body: {error: 'session_expired'}};
      }
      if (session.state === 'completed') {
        // Idempotent: re-completing confirms the SAME frozen bytes.
        return {status: 200, body: this.resultBody(session)};
      }
      if (session.state === 'cancelled') {
        return {status: 409, body: {error: 'session_not_active', state: 'cancelled'}};
      }

      // Seal: prove the durable bytes are exactly the committed prefix.
      let onDiskLength: number;
      let onDiskDigest: string;
      try {
        onDiskLength = await this.storage.length(session.id);
        onDiskDigest = await this.storage.digest(session.id);
      } catch (error) {
        return {status: 500, body: {error: 'seal_failed', detail: (error as Error).message}};
      }
      if (onDiskLength !== session.offset) {
        return {
          status: 500,
          body: {
            error: 'seal_failed',
            detail: `blob length ${onDiskLength} != committed offset ${session.offset}`,
          },
        };
      }
      if (onDiskDigest !== session.sha256) {
        return {
          status: 500,
          body: {error: 'seal_failed', detail: 'blob digest != committed prefix digest'},
        };
      }

      session.state = 'completed';
      session.expiresAt = null;
      try {
        await this.storage.saveMeta?.(session.id, this.snapshot(session));
      } catch {
        /* bytes are sealed; metadata snapshot is best-effort */
      }
      return {status: 200, body: this.resultBody(session)};
    });
  }

  /** Run `task` after every prior per-session op, chaining it onto the lock. */
  private underLock<T>(session: UploadSession, task: () => Promise<T>): Promise<T> {
    const run = session.lock.then(task);
    session.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Resolve a session to a downloadable object descriptor. ONLY a completed
   * session qualifies: an active prefix is still moving, and a cancelled/
   * expired session must not leak its leftover bytes from disk.
   *
   * The stat check here is deliberately O(1): opening (and serving) a tiny
   * range never hashes or reads the whole blob. The full-file digest was
   * pinned at completion; the downloader verifies the assembled bytes against
   * `descriptor.sha256` at the end.
   */
  async openContent(id: string): Promise<OpenContentOutcome> {
    const session = this.sessions.get(id);
    if (!session || this.isExpired(session)) {
      if (session) this.evict(session);
      return {status: 410, body: {error: 'session_expired'}};
    }
    if (session.state === 'cancelled') {
      return {status: 410, body: {error: 'session_cancelled'}};
    }
    if (session.state === 'active') {
      return {
        status: 409,
        body: {error: 'session_not_completed', state: 'active', offset: session.offset, sha256: session.sha256},
      };
    }

    let onDiskLength: number;
    try {
      onDiskLength = await this.storage.length(session.id);
    } catch (error) {
      return {status: 500, body: {error: 'blob_drift', detail: (error as Error).message}};
    }
    if (onDiskLength !== session.offset) {
      // The bytes behind the frozen identity changed (e.g. file tampered):
      // refuse rather than serve a body that disagrees with the ETag.
      return {
        status: 500,
        body: {error: 'blob_drift', detail: `blob length ${onDiskLength} != object size ${session.offset}`},
      };
    }

    return {
      status: 200,
      descriptor: {
        id: session.id,
        name: session.name,
        etag: session.sha256,
        size: session.offset,
        sha256: session.sha256,
      },
    };
  }

  /** Open the bounded byte stream backing an already-resolved descriptor. */
  openContentStream(id: string, offset: number, endExclusive?: number): Readable {
    return this.storage.createReadStream(id, offset, endExclusive);
  }

  private resultBody(session: UploadSession): PatchResultBody {
    return {
      id: session.id,
      offset: session.offset,
      revision: session.revision,
      sha256: session.sha256,
      state: session.state,
    };
  }

  private snapshot(session: UploadSession) {
    return {
      id: session.id,
      offset: session.offset,
      revision: session.revision,
      sha256: session.sha256,
      state: session.state,
      expiresAt: session.expiresAt,
    };
  }

  /**
   * The heart of the protocol. Runs entirely under the per-session lock:
   *
   *   1. validate session state
   *   2. replay an acknowledged request id, or join an in-flight one
   *   3. compare session revision (If-Match) and Upload-Offset
   *   4. verify the chunk checksum (before touching storage)
   *   5. durably append bytes at exactly the committed offset
   *   6. ONLY THEN advance offset/revision/checksum and snapshot metadata
   *
   * Any failure before step 6 leaves blob and metadata exactly where they
   * were. A conflicting revision/offset returns 409 carrying the CURRENT
   * committed offset and writes nothing.
   */
  appendChunk(
    id: string,
    params: {
      requestId: string | undefined;
      expectedRevision: number | undefined;
      expectedOffset: number;
      chunk: Buffer;
      checksum: string | undefined;
    },
  ): Promise<AppendOutcome> {
    const session = this.sessions.get(id);
    if (!session || this.isExpired(session)) {
      if (session) this.evict(session);
      return Promise.resolve({status: 410, body: {error: 'session_expired'}});
    }

    if (params.requestId) {
      const settled = session.ledger.get(params.requestId);
      if (settled) {
        return Promise.resolve({
          status: 200,
          body: {...settled.body, replayed: true},
        });
      }
      const pending = session.inflight.get(params.requestId);
      if (pending) return pending;
    }

    // Chain onto the session lock: concurrent PATCHes on one session are
    // serialised; different sessions stay fully concurrent.
    const run = this.underLock(session, () => this.appendChunkLocked(session, params));

    if (params.requestId) {
      session.inflight.set(params.requestId, run);
      run.finally(() => session.inflight.delete(params.requestId!)).catch(() => undefined);
    }
    return run;
  }

  private async appendChunkLocked(
    session: UploadSession,
    params: {
      requestId: string | undefined;
      expectedRevision: number | undefined;
      expectedOffset: number;
      chunk: Buffer;
      checksum: string | undefined;
    },
  ): Promise<AppendOutcome> {
    // Re-check under the lock: a racing request may have settled this id.
    if (params.requestId) {
      const settled = session.ledger.get(params.requestId);
      if (settled) {
        return {status: 200, body: {...settled.body, replayed: true}};
      }
    }

    if (session.state === 'cancelled') return {status: 410, body: {error: 'session_cancelled'}};
    if (session.state === 'completed') return {status: 410, body: {error: 'session_completed'}};
    if (this.isExpired(session)) {
      this.evict(session);
      return {status: 410, body: {error: 'session_expired'}};
    }

    // THE atomic offset compare first — this is the race the protocol exists
    // to settle. A stale/overlapping/advanced client learns where the durable
    // prefix ends. No bytes are written on this path. The body carries the
    // current offset and revision either way.
    if (params.expectedOffset !== session.offset) {
      return this.conflict(session, 'offset_conflict');
    }

    // Revision (If-Match) is a secondary guard for clients whose offset
    // happens to coincide (e.g. zero-length bump races).
    if (params.expectedRevision !== undefined && params.expectedRevision !== session.revision) {
      return this.conflict(session, 'revision_conflict');
    }

    // Validate the chunk's own checksum BEFORE touching storage.
    if (params.checksum && !checksumMatches(params.chunk, params.checksum)) {
      return {status: 422, body: {error: 'checksum_mismatch'}};
    }

    // Durable append (zero-length chunks still sync). The storage contract
    // guarantees the blob length is unchanged if this rejects.
    try {
      await this.storage.appendChunk(session.id, session.offset, params.chunk);
    } catch (error) {
      // Disk/storage failure: metadata MUST NOT move. Same request id may be
      // retried; it is deliberately NOT recorded in the ledger.
      return {
        status: 507,
        body: {error: 'storage_write_failed', detail: (error as Error).message},
      };
    }

    // Commit in-memory metadata only after bytes are durable.
    const chunkSha = createHash('sha256').update(params.chunk).digest('hex');
    session.hasher.update(params.chunk);
    const start = session.offset;
    session.offset += params.chunk.length;
    session.revision += 1;
    session.sha256 = session.hasher.copy().digest('hex');
    if (params.chunk.length > 0) {
      session.chunks.push({
        requestId: params.requestId ?? `anon-${session.revision}`,
        offset: start,
        length: params.chunk.length,
        sha256: chunkSha,
      });
    }

    // Durable metadata snapshot. Bytes are already on disk; a snapshot
    // failure cannot un-write them, so the in-memory commit stands (the blob
    // is the source of truth for length) and the prefix stays consistent.
    if (this.storage.saveMeta) {
      try {
        await this.storage.saveMeta(session.id, this.snapshot(session));
      } catch {
        /* best-effort; next snapshot reconciles */
      }
    }

    const body: PatchResultBody = {
      id: session.id,
      offset: session.offset,
      revision: session.revision,
      sha256: session.sha256,
      state: session.state,
    };
    if (params.requestId) session.ledger.set(params.requestId, {status: 200, body});
    return {status: 200, body};
  }

  private conflict(session: UploadSession, error: ConflictBody['error']): AppendOutcome {
    return {
      status: 409,
      body: {error, offset: session.offset, revision: session.revision, sha256: session.sha256},
    };
  }

  /** Verify the blob digest agrees with the tracked digest of [0, offset). */
  async verifyDigest(id: string): Promise<{offset: number; sha256: string} | undefined> {
    const session = this.getSession(id);
    if (!session) return undefined;
    const onDisk = await this.storage.digest(session.id);
    if (onDisk !== session.sha256) {
      throw new Error('digest drift: blob and metadata disagree');
    }
    return {offset: session.offset, sha256: session.sha256};
  }
}

function checksumMatches(chunk: Buffer, providedHex: string): boolean {
  const provided = Buffer.from(providedHex, 'hex');
  const actual = createHash('sha256').update(chunk).digest();
  return provided.length === actual.length && timingSafeEqual(provided, actual);
}

function emptySha256(): string {
  return createHash('sha256').digest('hex');
}

function randomId(): string {
  return `s_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
