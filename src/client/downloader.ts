/**
 * Client-side resumable downloader for COMPLETED upload sessions.
 *
 * The server turns a completed session into an immutable object whose ETag is
 * the full-content SHA-256. This module downloads that object in a way that
 * survives connection drops and pauses WITHOUT ever splicing two different
 * contents into one "successful" file:
 *
 *  - The object identity (ETag/sha256/size) is pinned via HEAD before any
 *    byte is accepted, and every later response is checked against it.
 *  - A retry after a connection failure always resumes at the number of
 *    bytes already confirmed locally (`Range` + `If-Range`) — it never
 *    silently restarts from zero and overwrites confirmed data.
 *  - If the server answers a resume with full content (200 instead of 206)
 *    or a different ETag, the identity changed underneath us: the run fails
 *    loudly and the confirmed prefix is kept untouched.
 *  - "done" is only reached after the assembled bytes hash to the pinned
 *    SHA-256. Local progress is what the CLIENT has verified receiving —
 *    never a number inferred from server-side metadata.
 */

import {sha256Hex} from './uploader';

export type DownloadInfo =
  | {kind: 'ready'; size: number; sha256: string; etag: string}
  | {kind: 'active'; offset: number; sha256: string}
  | {kind: 'cancelled'; offset: number; sha256: string}
  | {kind: 'gone'; error: string};

export type FetchLike = typeof fetch;

/**
 * Read the identity/length/digest of a completed session without its body.
 * Non-downloadable states are explained via response headers (X-Session-Error,
 * Upload-Offset, X-Prefix-Sha256) precisely because a HEAD response has no
 * body to read them from.
 */
export async function fetchDownloadInfo(options: {
  sessionId: string;
  doFetch?: FetchLike;
  baseUrl?: string;
}): Promise<DownloadInfo> {
  const doFetch = options.doFetch ?? fetch;
  const response = await doFetch(
    `${options.baseUrl ?? ''}/api/uploads/${options.sessionId}/download`,
    {method: 'HEAD'},
  );
  if (response.status === 200) {
    const etag = (response.headers.get('etag') ?? '').trim();
    const size = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    const sha256 = etag.replace(/^"|"$/g, '');
    if (!Number.isInteger(size) || size < 0 || sha256.length === 0) {
      throw new Error('download info incomplete');
    }
    return {kind: 'ready', size, sha256, etag};
  }
  const error = response.headers.get('x-session-error') ?? '';
  const offsetRaw = Number.parseInt(response.headers.get('upload-offset') ?? '', 10);
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const prefixSha = response.headers.get('x-prefix-sha256') ?? '';
  if (response.status === 409 || error === 'session_active') {
    return {kind: 'active', offset, sha256: prefixSha};
  }
  if (error === 'session_cancelled') {
    return {kind: 'cancelled', offset, sha256: prefixSha};
  }
  return {kind: 'gone', error: error || `http_${response.status}`};
}

/**
 * Locally confirmed download state. `confirmed` counts only bytes actually
 * received and kept by this client; it never decreases within a run and is
 * the sole source of "how much do we have".
 */
export type DownloadProgress = {
  /** Pinned object identity every resume is validated against. */
  etag: string;
  sha256: string;
  size: number;
  /** Length of the contiguous confirmed prefix [0, confirmed). */
  confirmed: number;
  chunks: Uint8Array[];
};

export type DownloadResult =
  | {status: 'done'; bytes: Uint8Array; sha256: string; progress: DownloadProgress}
  | {status: 'paused'; progress: DownloadProgress}
  | {status: 'failed'; reason: string; progress: DownloadProgress | null};

export type DownloadEvent =
  | {type: 'info'; size: number; sha256: string; etag: string}
  | {type: 'request'; offset: number; attempt: number}
  | {type: 'progress'; confirmed: number; total: number}
  | {type: 'retry'; reason: string; delayMs: number}
  | {type: 'paused'; confirmed: number; total: number}
  | {type: 'verify'; sha256: string; expected: string}
  | {type: 'done'; size: number; sha256: string}
  | {type: 'fatal'; reason: string}
  | {type: 'log'; message: string};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runDownload(options: {
  sessionId: string;
  onEvent: (event: DownloadEvent) => void;
  doFetch?: FetchLike;
  baseUrl?: string;
  /** Abort = pause: the run settles as 'paused' with resumable progress. */
  signal?: AbortSignal;
  /** Previously confirmed partial state; adopted only if identity matches. */
  resumeFrom?: DownloadProgress;
}): Promise<DownloadResult> {
  const doFetch = options.doFetch ?? fetch;
  const url = `${options.baseUrl ?? ''}/api/uploads/${options.sessionId}/download`;
  const emit = options.onEvent;
  const isAborted = () => Boolean(options.signal?.aborted);
  const paused = (progress: DownloadProgress): DownloadResult => {
    emit({type: 'paused', confirmed: progress.confirmed, total: progress.size});
    return {status: 'paused', progress};
  };

  // 1. Pin the object identity for this run.
  let info: DownloadInfo;
  try {
    info = await fetchDownloadInfo({
      sessionId: options.sessionId,
      doFetch,
      baseUrl: options.baseUrl,
    });
  } catch (error) {
    const reason = `info: ${(error as Error).message}`;
    emit({type: 'fatal', reason});
    return {status: 'failed', reason, progress: options.resumeFrom ?? null};
  }
  if (info.kind !== 'ready') {
    const reason =
      info.kind === 'active'
        ? `session_active: prefix at offset ${info.offset} is still changing, not the final file`
        : info.kind === 'cancelled'
          ? `session_cancelled: confirmed prefix ${info.offset}B is not downloadable`
          : info.error;
    emit({type: 'fatal', reason});
    return {status: 'failed', reason, progress: options.resumeFrom ?? null};
  }
  emit({type: 'info', size: info.size, sha256: info.sha256, etag: info.etag});

  // 2. Adopt or validate saved progress. A saved prefix is only continued
  //    when it provably belongs to THIS object identity.
  let progress: DownloadProgress;
  if (options.resumeFrom) {
    if (options.resumeFrom.etag !== info.etag) {
      const reason = 'identity_changed: saved bytes belong to a different object';
      emit({type: 'fatal', reason});
      return {status: 'failed', reason, progress: options.resumeFrom};
    }
    progress = options.resumeFrom;
  } else {
    progress = {etag: info.etag, sha256: info.sha256, size: info.size, confirmed: 0, chunks: []};
  }

  // 3. Fetch the missing suffix. Every request — including the first — is a
  //    conditional Range request, so a retry after a connection failure
  //    continues at `confirmed` instead of restarting from zero.
  let backoff = 50;
  let attempt = 0;
  while (progress.confirmed < progress.size) {
    if (isAborted()) return paused(progress);
    attempt += 1;
    emit({type: 'request', offset: progress.confirmed, attempt});

    let response: Response;
    try {
      response = await doFetch(url, {
        headers: {Range: `bytes=${progress.confirmed}-`, 'If-Range': progress.etag},
        signal: options.signal,
      });
    } catch (error) {
      if (isAborted()) return paused(progress);
      emit({type: 'retry', reason: `network: ${(error as Error).message}`, delayMs: backoff});
      await wait(backoff);
      backoff = Math.min(backoff * 2, 800);
      continue;
    }

    if (response.status === 410 || response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as {error?: string};
      const reason =
        response.headers.get('x-session-error') ?? body.error ?? `http_${response.status}`;
      emit({type: 'fatal', reason});
      return {status: 'failed', reason, progress};
    }
    if (response.status === 200 && progress.confirmed > 0) {
      // The server ignored/overrode our Range: answering a resume with full
      // content means the identity no longer matches. Appending it to the
      // saved prefix would splice two versions into one file — refuse.
      const reason = 'identity_changed: resume answered with full content';
      emit({type: 'fatal', reason});
      return {status: 'failed', reason, progress};
    }
    if (response.status !== 200 && response.status !== 206) {
      emit({type: 'retry', reason: `http ${response.status}`, delayMs: backoff});
      await wait(backoff);
      backoff = Math.min(backoff * 2, 800);
      continue;
    }
    if (response.status === 206) {
      const range = parseContentRange(response.headers.get('content-range'));
      if (!range || range.start !== progress.confirmed || range.total !== progress.size) {
        const reason = 'range_mismatch: response does not continue the confirmed prefix';
        emit({type: 'fatal', reason});
        return {status: 'failed', reason, progress};
      }
    }
    const responseEtag = response.headers.get('etag');
    if (responseEtag && responseEtag.trim() !== progress.etag) {
      const reason = 'identity_changed: etag mismatch';
      emit({type: 'fatal', reason});
      return {status: 'failed', reason, progress};
    }

    // Stream the body into the confirmed prefix.
    const reader = response.body?.getReader();
    if (!reader) {
      const buf = new Uint8Array(await response.arrayBuffer());
      progress.chunks.push(buf);
      progress.confirmed += buf.length;
      emit({type: 'progress', confirmed: progress.confirmed, total: progress.size});
      continue;
    }
    let dropped: string | null = null;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        progress.chunks.push(value);
        progress.confirmed += value.length;
        emit({type: 'progress', confirmed: progress.confirmed, total: progress.size});
      }
    } catch (error) {
      if (isAborted()) return paused(progress);
      dropped = (error as Error).message;
    }
    if (dropped) {
      // Connection failed mid-body: keep every confirmed byte and resume at
      // exactly `confirmed` — never restart from zero.
      emit({
        type: 'retry',
        reason: `connection dropped at ${progress.confirmed}B: ${dropped}`,
        delayMs: backoff,
      });
      await wait(backoff);
      backoff = Math.min(backoff * 2, 800);
      continue;
    }
    backoff = 50; // a cleanly completed response resets the backoff
  }

  // 4. Final verification: the assembled prefix must hash to the pinned
  //    identity — this is what makes "done" mean THIS object, complete.
  const bytes = concatChunks(progress.chunks, progress.confirmed);
  const actual = await sha256Hex(bytes);
  emit({type: 'verify', sha256: actual, expected: progress.sha256});
  if (actual !== progress.sha256) {
    const reason = 'digest_mismatch: assembled bytes do not match the pinned identity';
    emit({type: 'fatal', reason});
    return {status: 'failed', reason, progress};
  }
  emit({type: 'done', size: progress.size, sha256: actual});
  return {status: 'done', bytes, sha256: actual, progress};
}

function parseContentRange(value: string | null): {start: number; end: number; total: number} | null {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match || match[3] === '*') return null;
  return {
    start: Number.parseInt(match[1], 10),
    end: Number.parseInt(match[2], 10),
    total: Number.parseInt(match[3], 10),
  };
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}
