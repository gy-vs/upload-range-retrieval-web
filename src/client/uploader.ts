/**
 * Client-side resumable uploader.
 *
 * The server protocol is a strictly sequential append (offset CAS), so the
 * uploader is a pipelined sender with at most one chunk in flight per session.
 * The "same offset submitted twice" scenario (e.g. a user double-click or a
 * proxy retry) is handled by `duplicateDispatch`: two identical PATCHes for
 * the SAME bytes/offset race against each other; exactly one wins, the loser
 * gets 409 carrying the new offset and is reconciled — bytes are never
 * appended twice.
 *
 * Guarantees:
 *  - Every block keeps a STABLE request id for its whole life; the same id is
 *    reused on every retry, so a lost response is answered from the server's
 *    idempotency ledger instead of being written twice.
 *  - After a 409 the client adopts the server's current offset/revision and
 *    retries ONLY the still-unacknowledged suffix of its data (often empty:
 *    the racing duplicate already persisted it).
 *  - A network/507 failure retries the same bytes at the same offset — a
 *    failed write never advanced the server's metadata.
 *  - 410 (expired/cancelled/completed) is terminal.
 */

export type BlockStatus =
  | 'queued'
  | 'sending'
  | 'acked'
  | 'covered'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type UploadBlock = {
  index: number;
  /** Stable per-block request id, retained across every retry. */
  requestId: string;
  baseStart: number;
  /** Full block bytes as planned (never mutated; retries slice from these). */
  fullBytes: Uint8Array;
  /** Current send window; moves forward only via acknowledged prefixes. */
  start: number;
  end: number;
  status: BlockStatus;
  attempts: number;
  replayed: boolean;
  note: string;
  /** When true, this block is fired twice concurrently (same offset/bytes). */
  duplicate?: boolean;
};

export type RunnerOptions = {
  sessionId: string;
  blocks: UploadBlock[];
  /** Called after every state change, for UI rendering/logging. */
  onEvent: (event: UploadEvent) => void;
  /** Fetch injected for tests; defaults to window.fetch. */
  doFetch?: typeof fetch;
  /** Origin prefix (tests use an ephemeral server; the browser uses ''). */
  baseUrl?: string;
  signal?: AbortSignal;
};

export type UploadEvent =
  | {type: 'send'; block: UploadBlock; requestId: string; offset: number; length: number}
  | {type: 'ack'; block: UploadBlock; offset: number; revision: number; replayed: boolean; requestId: string}
  | {type: 'conflict'; block: UploadBlock; requestId: string; serverOffset: number; serverRevision: number}
  | {type: 'retry'; block: UploadBlock; reason: string; delayMs: number}
  | {type: 'storage-failure'; block: UploadBlock}
  | {type: 'covered'; block: UploadBlock; serverOffset: number}
  | {type: 'fatal'; block: UploadBlock; reason: string}
  | {type: 'done'; offset: number; revision: number; sha256: string}
  | {type: 'log'; message: string};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Split payload into blocks of `chunkSize`. Indexes in `zeroIndexes` are
 * inserted as zero-length blocks at their boundary position (they still bump
 * the session revision but add no bytes). Overlapping blocks for the conflict
 * demo are built separately via `planOverlappingBlocks`.
 */
export function planBlocks(payload: Uint8Array, chunkSize: number, zeroIndexes: number[] = []): UploadBlock[] {
  const blocks: UploadBlock[] = [];
  const zero = new Set(zeroIndexes);
  let start = 0;
  let index = 0;
  if (payload.length === 0) zero.add(0);
  while (start < payload.length || zero.has(index)) {
    if (zero.has(index)) {
      blocks.push(makeBlock(index, start, payload.subarray(start, start)));
    } else {
      const end = Math.min(start + chunkSize, payload.length);
      blocks.push(makeBlock(index, start, payload.subarray(start, end)));
      start = end;
    }
    index += 1;
  }
  return blocks;
}

/**
 * Overlapping plan: each entry is [start, end) into `payload`. Adjacent or
 * overlapping windows both work — the offset CAS serialises them and the
 * client trims already-covered prefixes.
 */
export function planOverlappingBlocks(payload: Uint8Array, windows: Array<[number, number]>): UploadBlock[] {
  return windows.map(([start, end], i) => {
    const block = makeBlock(i, start, payload.subarray(start, Math.max(start, end)));
    return block;
  });
}

function makeBlock(index: number, start: number, bytes: Uint8Array): UploadBlock {
  return {
    index,
    requestId: newRequestId(index),
    baseStart: start,
    fullBytes: bytes,
    start,
    end: start + bytes.length,
    status: 'queued',
    attempts: 0,
    replayed: false,
    note: bytes.length === 0 ? 'zero-length' : '',
  };
}

export function newRequestId(index: number): string {
  return `req_${index}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

type ServerState = {offset: number; revision: number};
type Termination = 'done' | 'expired' | 'fatal' | 'cancelled';

export async function runUpload(options: RunnerOptions): Promise<{
  offset: number;
  revision: number;
  sha256: string;
}> {
  const doFetch = options.doFetch ?? fetch;
  const url = (path: string) => `${options.baseUrl ?? ''}${path}`;
  const committed: ServerState = await fetchSession(doFetch, url(`/api/uploads/${options.sessionId}`))
    .then((s) => s ?? {offset: 0, revision: 0})
    .catch(() => ({offset: 0, revision: 0}));

  const emit = options.onEvent;
  const isAborted = () => Boolean(options.signal?.aborted);

  function sync(offset: number, revision: number) {
    committed.offset = Math.max(committed.offset, offset);
    committed.revision = Math.max(committed.revision, revision);
  }

  // One PATCH attempt. Returns the server outcome; never throws for normal
  // transport errors (those become 'network' and get retried).
  async function attempt(
    block: UploadBlock,
    requestId: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<
    | {kind: '200'; offset: number; revision: number; replayed: boolean}
    | {kind: '409'; offset: number; revision: number}
    | {kind: '410'; error: string}
    | {kind: '422'; error: string}
    | {kind: '507'; error: string}
    | {kind: 'network'; error: string}
    | {kind: 'other'; status: number}
  > {
    const checksum = await sha256Hex(bytes);
    emit({type: 'send', block, requestId, offset, length: bytes.length});
    let response: Response;
    try {
      response = await doFetch(url(`/api/uploads/${options.sessionId}/`), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/offset-bytes',
          'Upload-Offset': String(offset),
          'If-Match': `"${committed.revision}"`,
          'Upload-Request-Id': requestId,
          'Upload-Checksum': checksum,
        },
        body: bytes as unknown as BodyInit,
        signal: options.signal,
      });
    } catch (error) {
      if (isAborted()) return {kind: '410', error: 'aborted'};
      return {kind: 'network', error: (error as Error).message};
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 200) {
      return {kind: '200', offset: body.offset, revision: body.revision, replayed: Boolean(body.replayed)};
    }
    if (response.status === 409) return {kind: '409', offset: body.offset, revision: body.revision};
    if (response.status === 410) return {kind: '410', error: body.error ?? 'gone'};
    if (response.status === 422) return {kind: '422', error: body.error ?? 'checksum'};
    if (response.status === 507) return {kind: '507', error: body.error ?? 'storage'};
    return {kind: 'other', status: response.status};
  }

  // Send one block to completion. Retry loop owns:
  //  - trimming the unacknowledged prefix after 409
  //  - reusing the same request id after network loss / 507
  async function sendBlock(block: UploadBlock): Promise<Termination> {
    block.status = 'sending';
    let backoff = 50;

    while (!isAborted()) {
      // 1. Trim everything already covered by the durable prefix. A
      //    zero-length block carries no bytes and simply PATCHes at the
      //    current committed offset (it bumps revision but not offset).
      let offset: number;
      let bytes: Uint8Array;
      if (block.fullBytes.length === 0) {
        offset = committed.offset;
        bytes = block.fullBytes;
      } else if (committed.offset >= block.end) {
        block.status = 'covered';
        emit({type: 'covered', block, serverOffset: committed.offset});
        return 'done';
      } else {
        offset = Math.max(block.start, committed.offset);
        const skip = offset - block.baseStart;
        bytes = block.fullBytes.subarray(Math.max(0, skip));
      }

      // 2. Fire. Duplicate blocks launch two identical requests at once with
      //    DIFFERENT request ids (they are genuinely two submissions); the
      //    server CAS picks one winner.
      block.attempts += 1;
      const primaryId = block.requestId;
      const results = block.duplicate && block.attempts === 1
        ? await Promise.all([
            attempt(block, primaryId, offset, bytes),
            attempt({...block, note: block.note}, `${primaryId}d2`, offset, bytes),
          ])
        : [await attempt(block, primaryId, offset, bytes)];

      // Process the most authoritative result: any 200 first, then 409.
      const ok = results.find((r) => r.kind === '200') as
        | Extract<(typeof results)[number], {kind: '200'}>
        | undefined;
      const conflict = results.find((r) => r.kind === '409') as
        | Extract<(typeof results)[number], {kind: '409'}>
        | undefined;
      const gone = results.find((r) => r.kind === '410');
      const unprocessable = results.find((r) => r.kind === '422');
      const storage = results.find((r) => r.kind === '507');
      const network = results.find((r) => r.kind === 'network');

      if (gone) {
        block.status = 'expired';
        block.note = (gone as {error: string}).error;
        emit({type: 'fatal', block, reason: block.note});
        return 'expired';
      }
      if (unprocessable) {
        block.status = 'failed';
        block.note = 'checksum_mismatch';
        emit({type: 'fatal', block, reason: 'checksum_mismatch'});
        return 'fatal';
      }

      if (ok) {
        sync(ok.offset, ok.revision);
        block.replayed = ok.replayed;
        block.status = 'acked';
        block.note = ok.replayed ? 'replayed from ledger (response was lost)' : block.duplicate && conflict ? 'won the same-offset race' : block.note;
        emit({
          type: 'ack',
          block,
          offset: ok.offset,
          revision: ok.revision,
          replayed: ok.replayed,
          requestId: primaryId,
        });
        if (conflict) emit({type: 'conflict', block, requestId: `${primaryId}d2`, serverOffset: conflict.offset, serverRevision: conflict.revision});
        return 'done';
      }

      if (conflict) {
        sync(conflict.offset, conflict.revision);
        emit({type: 'conflict', block, requestId: primaryId, serverOffset: conflict.offset, serverRevision: conflict.revision});
        // Loop: trim to the unacknowledged suffix and resend (or discover the
        // whole block was covered by the winning duplicate).
        continue;
      }

      if (storage) {
        // Metadata did not move. Same bytes, same request id, same offset.
        block.note = 'storage write failed; metadata unchanged';
        emit({type: 'storage-failure', block});
        emit({type: 'retry', block, reason: '507 storage_write_failed', delayMs: backoff});
        await wait(backoff);
        backoff = Math.min(backoff * 2, 800);
        continue;
      }

      if (network) {
        // The server may have committed just before losing the response.
        // Retry with the SAME request id WITHOUT refreshing first: the
        // server checks its ledger ahead of the offset compare, so it either
        // replays the original 200 (no second write) or, if nothing landed,
        // appends the bytes exactly once.
        block.note = `network: ${(network as {error: string}).error}; same request id retried`;
        emit({type: 'retry', block, reason: 'network/response-lost', delayMs: backoff});
        await wait(backoff);
        backoff = Math.min(backoff * 2, 800);
        continue;
      }

      const other = results.find((r) => r.kind === 'other') as Extract<(typeof results)[number], {kind: 'other'}> | undefined;
      emit({type: 'retry', block, reason: `http ${other?.status ?? '?'}`, delayMs: backoff});
      await wait(backoff);
      backoff = Math.min(backoff * 2, 800);
    }

    block.status = 'cancelled';
    return 'cancelled';
  }

  // Sequential pipeline: each block starts only after the previous one is
  // durably acknowledged, which is exactly what an append CAS requires.
  for (const block of options.blocks) {
    if (isAborted()) break;
    const outcome = await sendBlock(block);
    if (outcome !== 'done') {
      for (const queued of options.blocks.slice(block.index + 1)) queued.status = 'cancelled';
      if (outcome === 'cancelled') throw new Error('upload_cancelled');
      throw new Error(`upload_failed: ${block.note}`);
    }
  }

  const session = await fetchSession(doFetch, url(`/api/uploads/${options.sessionId}`));
  if (!session) throw new Error('session_gone');
  emit({type: 'done', offset: session.offset, revision: session.revision, sha256: session.sha256});
  return {offset: session.offset, revision: session.revision, sha256: session.sha256};
}

async function fetchSession(
  doFetch: typeof fetch,
  href: string,
): Promise<{offset: number; revision: number; sha256: string; state: string} | null> {
  const response = await doFetch(href);
  if (response.status === 410 || response.status === 404) return null;
  if (!response.ok) throw new Error(`session fetch ${response.status}`);
  const body = await response.json();
  return {offset: body.offset, revision: body.revision, sha256: body.sha256, state: body.state};
}
