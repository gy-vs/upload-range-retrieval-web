/**
 * Client-side resumable downloader for a FINALIZED upload object.
 *
 * Completion froze the object server-side: its length and SHA-256 can never
 * change. The downloader therefore pins the object identity it first observed
 * and builds the file strictly append-only:
 *
 *  - Before (re)starting it reads the object metadata (HEAD) and adopts only
 *    the identity whose ETag + length + digest it is about to verify.
 *  - Every byte request is `Range: bytes=saved-` with `If-Match: "<etag>"`.
 *    If the object behind the URL ever names different bytes, the server
 *    answers 412 and the run stops FATALLY — a new version is never spliced
 *    onto a prefix of the old one.
 *  - A 206 response is accepted only when its Content-Range starts exactly at
 *    `saved` and its ETag still matches; received bytes extend the buffer.
 *  - A network failure leaves every confirmed byte in place; the next attempt
 *    re-requests from `saved` (which is the server's request start, so a
 *    dropped response cannot duplicate or shift bytes). It never silently
 *    restarts from zero and overwrites confirmed data.
 *  - A 200 (whole object) is accepted ONLY when nothing has been confirmed
 *    yet; receiving one mid-file is treated as an identity/protocol failure,
 *    not a cue to truncate and restart.
 *  - When the last byte is in, the assembled file is itself hashed and must
 *    equal the object digest; only then is the run declared verified.
 */

export type ObjectInfo = {
  id: string;
  name: string;
  /** Strong validator: SHA-256 of the complete object, hex (no quotes). */
  etag: string;
  /** Total object length in bytes. */
  size: number;
  sha256: string;
};

export type DownloadEvent =
  | {type: 'metadata'; info: ObjectInfo}
  | {type: 'request'; start: number; end: number; attempt: number}
  | {type: 'chunk'; received: number; saved: number; total: number}
  | {type: 'retry'; reason: string; delayMs: number; from: number}
  | {type: 'paused'; saved: number}
  | {type: 'done'; bytes: Uint8Array; sha256: string; total: number}
  | {type: 'fatal'; reason: string; code?: string};

export type DownloadOptions = {
  sessionId: string;
  /**
   * Prefix already confirmed in THIS browser session (survives pause/resume in
   * memory). A page reload starts from zero even if the server already holds
   * the whole object — server offset alone never proves local possession.
   */
  prefix?: Uint8Array;
  /** Identity pinned by a previous run; resumed runs must stay on this object. */
  etag?: string;
  onEvent: (event: DownloadEvent) => void;
  doFetch?: typeof fetch;
  baseUrl?: string;
  signal?: AbortSignal;
  /** Pause/resume: abort the in-flight request but keep the confirmed prefix. */
  pauseSignal?: AbortSignal;
  /** Bytes requested per round trip. */
  chunkSize?: number;
};

export const DEFAULT_DOWNLOAD_CHUNK = 64;

const MAX_RETRIES = 8;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Read the object metadata. Only a completed session yields info; every other
 * state rejects so the UI can explain why no final object exists.
 */
export async function fetchObjectInfo(
  doFetch: typeof fetch,
  baseUrl: string,
  sessionId: string,
): Promise<
  | {kind: 'object'; info: ObjectInfo}
  | {kind: 'active'; offset: number; sha256: string}
  | {kind: 'gone'; code: string}
> {
  const response = await doFetch(`${baseUrl}/api/uploads/${sessionId}/content`, {method: 'HEAD'});
  if (response.status === 200) {
    const etag = (response.headers.get('ETag') ?? '').replace(/^"|"$/g, '');
    const size = Number.parseInt(response.headers.get('Content-Length') ?? '-1', 10);
    const sha = response.headers.get('X-Content-SHA256') ?? etag;
    let name = sessionId;
    const encodedName = response.headers.get('X-Object-Name');
    if (encodedName) {
      try {
        name = decodeURIComponent(encodedName);
      } catch {
        name = sessionId;
      }
    }
    if (!etag || !Number.isInteger(size)) {
      return {kind: 'gone', code: 'bad_metadata'};
    }
    return {kind: 'object', info: {id: sessionId, name, etag, size, sha256: sha}};
  }
  if (response.status === 409) {
    return {
      kind: 'active',
      offset: Number.parseInt(response.headers.get('Upload-Offset') ?? '0', 10),
      sha256: response.headers.get('X-Content-SHA256') ?? '',
    };
  }
  return {kind: 'gone', code: response.headers.get('X-Session-State') ?? `http_${response.status}`};
}

function quotedHeader(response: Response, name: string): string {
  return (response.headers.get(name) ?? '').replace(/^"|"$/g, '');
}

function parseContentRange(value: string | null): {start: number; end: number; total: number} | null {
  if (!value) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) return null;
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  const total = Number.parseInt(match[3], 10);
  if (![start, end, total].every(Number.isInteger) || end < start) return null;
  return {start, end, total};
}

/**
 * Run a download to completion. Resolves with the verified bytes on success;
 * a pause resolves with `{paused: true, saved}` and an identity/protocol
 * failure rejects. Confirmed bytes are passed back on pause for resume.
 */
export async function runDownload(options: DownloadOptions): Promise<
  | {paused: true; saved: Uint8Array; info: ObjectInfo}
  | {bytes: Uint8Array; info: ObjectInfo}
> {
  const doFetch = options.doFetch ?? fetch;
  const baseUrl = options.baseUrl ?? '';
  const emit = options.onEvent;
  const chunkSize = options.chunkSize ?? DEFAULT_DOWNLOAD_CHUNK;

  // 1. Resolve the immutable object identity.
  const meta = await fetchObjectInfo(doFetch, baseUrl, options.sessionId);
  if (meta.kind !== 'object') {
    throw Object.assign(new Error(meta.kind === 'active' ? 'session_not_completed' : `unavailable: ${meta.code}`), {
      code: meta.kind === 'active' ? 'not_completed' : meta.code,
    });
  }
  const info = meta.info;

  // 2. Validate the local prefix against the pinned identity. The prefix is
  //    only ever one WE built for this exact etag (checked by the caller);
  //    here we pin the resume etag when present.
  if (options.etag !== undefined && options.etag !== info.etag) {
    emit({type: 'fatal', reason: 'object identity changed since the prefix was saved', code: 'identity_changed'});
    throw Object.assign(new Error('identity_changed'), {code: 'identity_changed'});
  }
  const prefix = options.prefix ?? new Uint8Array(0);
  if (prefix.length > info.size) {
    emit({type: 'fatal', reason: 'local prefix is longer than the object', code: 'prefix_too_long'});
    throw Object.assign(new Error('prefix_too_long'), {code: 'prefix_too_long'});
  }

  emit({type: 'metadata', info});

  // Prefix already equal to the object (e.g. resumed after the last chunk):
  // verify the saved bytes before declaring done.
  if (prefix.length === info.size) {
    const localDigest = await sha256Hex(prefix);
    if (localDigest !== info.sha256) {
      emit({type: 'fatal', reason: 'saved bytes digest disagrees with object identity', code: 'digest_mismatch'});
      throw Object.assign(new Error('digest_mismatch'), {code: 'digest_mismatch'});
    }
    emit({type: 'chunk', received: 0, saved: info.size, total: info.size});
    emit({type: 'done', bytes: prefix, sha256: localDigest, total: info.size});
    return {bytes: prefix, info};
  }

  // Append-only assembly buffer. Nothing confirmed is ever shifted/truncated.
  let parts: Uint8Array[] = prefix.length > 0 ? [prefix] : [];
  let saved = prefix.length;
  let attempt = 0;

  const abortedByUser = () => Boolean(options.signal?.aborted);
  const paused = () => Boolean(options.pauseSignal?.aborted);

  while (saved < info.size && !abortedByUser()) {
    if (paused()) {
      emit({type: 'paused', saved});
      return {paused: true, saved: concat(parts), info};
    }

    attempt += 1;
    if (attempt > MAX_RETRIES) {
      emit({type: 'fatal', reason: `giving up after ${MAX_RETRIES} failed attempts`, code: 'retries_exhausted'});
      throw Object.assign(new Error('retries_exhausted'), {code: 'retries_exhausted'});
    }

    const start = saved;
    const end = Math.min(start + chunkSize - 1, info.size - 1);
    emit({type: 'request', start, end, attempt});

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/api/uploads/${options.sessionId}/content`, {
        method: 'GET',
        headers: {
          Range: `bytes=${start}-${end}`,
          'If-Match': `"${info.etag}"`,
        },
        signal: options.pauseSignal ?? options.signal,
      });
    } catch (error) {
      if (abortedByUser()) throw new Error('download_cancelled');
      if (paused()) {
        emit({type: 'paused', saved});
        return {paused: true, saved: concat(parts), info};
      }
      // Connection lost: the prefix is intact. Retry the SAME window.
      const delay = backoff(attempt);
      emit({type: 'retry', reason: `network: ${(error as Error).message}`, delayMs: delay, from: start});
      await interruptibleWait(delay, options.pauseSignal, options.signal);
      continue;
    }

    if (response.status === 412) {
      // The object behind the URL is not the one our prefix belongs to.
      emit({type: 'fatal', reason: 'server refused the splice: object identity changed', code: 'identity_changed'});
      throw Object.assign(new Error('identity_changed'), {code: 'identity_changed'});
    }

    if (response.status === 410) {
      emit({type: 'fatal', reason: 'object is no longer available (cancelled/expired)', code: 'gone'});
      throw Object.assign(new Error('object_gone'), {code: 'gone'});
    }

    if (response.status === 200) {
      // Whole object returned for a ranged resume request. Accepting it would
      // mean restarting from zero and overwriting confirmed bytes — refuse.
      emit({
        type: 'fatal',
        reason: start === 0
          ? 'server ignored the range on a fresh start'
          : 'server sent the whole object mid-download; refusing to overwrite confirmed prefix',
        code: 'unexpected_full_body',
      });
      throw Object.assign(new Error('unexpected_full_body'), {code: 'unexpected_full_body'});
    }

    if (response.status !== 206) {
      const delay = backoff(attempt);
      emit({type: 'retry', reason: `http ${response.status}`, delayMs: delay, from: start});
      await response.body?.cancel().catch(() => undefined);
      await interruptibleWait(delay, options.pauseSignal, options.signal);
      continue;
    }

    // 206: range, body and identity must describe the same object/window.
    const cr = parseContentRange(response.headers.get('Content-Range'));
    const responseEtag = quotedHeader(response, 'ETag');
    if (
      !cr ||
      cr.start !== start ||
      cr.total !== info.size ||
      responseEtag !== info.etag ||
      cr.end - cr.start + 1 > end - start + 1
    ) {
      emit({
        type: 'fatal',
        reason: 'response window/identity is inconsistent with the pinned object',
        code: 'bad_content_range',
      });
      throw Object.assign(new Error('bad_content_range'), {code: 'bad_content_range'});
    }

    let chunk: Uint8Array;
    try {
      chunk = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (abortedByUser()) throw new Error('download_cancelled');
      if (paused()) {
        emit({type: 'paused', saved});
        return {paused: true, saved: concat(parts), info};
      }
      const delay = backoff(attempt);
      emit({type: 'retry', reason: `read body: ${(error as Error).message}`, delayMs: delay, from: start});
      await interruptibleWait(delay, options.pauseSignal, options.signal);
      continue;
    }

    if (chunk.length === 0 || chunk.length > end - start + 1 || start + chunk.length > info.size) {
      emit({type: 'fatal', reason: 'response body length disagrees with Content-Range', code: 'bad_body_length'});
      throw Object.assign(new Error('bad_body_length'), {code: 'bad_body_length'});
    }

    // Commit only bytes that extend the confirmed prefix contiguously.
    parts.push(chunk);
    saved = start + chunk.length;
    attempt = 0;
    emit({type: 'chunk', received: chunk.length, saved, total: info.size});
  }

  if (abortedByUser()) throw new Error('download_cancelled');

  // 3. Final cross-check: hash the assembled file.
  const bytes = concat(parts);
  if (bytes.length !== info.size) {
    emit({type: 'fatal', reason: `assembled ${bytes.length} bytes, object is ${info.size}`, code: 'short_file'});
    throw Object.assign(new Error('short_file'), {code: 'short_file'});
  }
  const finalDigest = await sha256Hex(bytes);
  if (finalDigest !== info.sha256) {
    emit({type: 'fatal', reason: 'final digest does not match the object', code: 'digest_mismatch'});
    throw Object.assign(new Error('digest_mismatch'), {code: 'digest_mismatch'});
  }
  emit({type: 'done', bytes, sha256: finalDigest, total: info.size});
  return {bytes, info};
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function backoff(attempt: number): number {
  return Math.min(50 * 2 ** Math.max(0, attempt - 1), 800);
}

/**
 * Monotonic guard against a late response of a previous session being applied
 * after the user switched sessions. `next()` is called when a new download
 * starts for the currently selected object; an event carrying an older run id
 * is stale and must not touch the panel state.
 */
export class RunGuard {
  private current = 0;

  next(): number {
    this.current += 1;
    return this.current;
  }

  invalidate(): void {
    this.current += 1;
  }

  isCurrent(run: number): boolean {
    return run === this.current;
  }
}

async function interruptibleWait(ms: number, ...signals: Array<AbortSignal | undefined>): Promise<void> {
  if (signals.some((s) => s?.aborted)) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    for (const signal of signals) signal?.addEventListener('abort', onAbort, {once: true});
  });
}
