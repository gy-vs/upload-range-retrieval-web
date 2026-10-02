import express from 'express';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DiskStorage} from './storage';
import {UploadEngine, type DownloadState, type UploadSession} from './engine';

export type AppOptions = {
  /**
   * Slice size used when streaming full-file downloads and when assembling
   * ranged responses. Tests shrink it to prove multi-slice assembly; the
   * default keeps big files out of memory.
   */
  downloadSliceBytes?: number;
};

const DEFAULT_DOWNLOAD_SLICE_BYTES = 256 * 1024;

export function createApp(engine?: UploadEngine, options: AppOptions = {}) {
  const uploadEngine =
    engine ??
    new UploadEngine(new DiskStorage(path.join(process.cwd(), '.uploads-data')));
  const downloadSliceBytes = options.downloadSliceBytes ?? DEFAULT_DOWNLOAD_SLICE_BYTES;

  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) =>
    res.json({family: 'upload-resume', protocol: 'offset-cas/1'}),
  );

  app.post('/api/uploads', (req, res) => {
    const ttlMs =
      typeof req.body?.ttlMs === 'number'
        ? req.body.ttlMs
        : req.body?.ttlMs === null
          ? null
          : undefined;
    const session = uploadEngine.createSession({
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      ttlMs,
    });
    res.status(201).json(serialize(session));
  });

  app.get('/api/uploads', (_req, res) => {
    res.json(
      uploadEngine.listSessions().map((session) => ({
        ...serialize(session),
        chunks: session.chunks.length,
      })),
    );
  });

  app.get('/api/uploads/:id', (req, res) => {
    const session = uploadEngine.getSession(req.params.id);
    if (!session) return res.status(410).json({error: 'session_expired'});
    res.set('ETag', `"${session.revision}"`).json({
      ...serialize(session),
      chunks: session.chunks,
    });
  });

  // Raw chunk body. tus-style headers carry offset/revision/request id/checksum.
  app.patch(
    '/api/uploads/:id',
    express.raw({type: ['application/offset-bytes', 'application/octet-stream'], limit: '5mb'}),
    async (req, res) => {
      const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const offsetHeader = header(req, 'upload-offset');
      const expectedOffset = Number.parseInt(offsetHeader ?? '', 10);
      if (offsetHeader === undefined || !Number.isInteger(expectedOffset) || expectedOffset < 0) {
        return res.status(400).json({error: 'missing_or_invalid_upload_offset'});
      }
      const revisionHeader = header(req, 'if-match');
      const expectedRevision =
        revisionHeader === undefined
          ? undefined
          : Number.parseInt(revisionHeader.replace(/^"|"$/g, ''), 10);

      const outcome = await uploadEngine.appendChunk(req.params.id, {
        requestId: header(req, 'upload-request-id'),
        expectedRevision: Number.isInteger(expectedRevision) ? expectedRevision : undefined,
        expectedOffset,
        chunk,
        checksum: header(req, 'upload-checksum'),
      });

      res.status(outcome.status);
      if (outcome.status === 200) {
        const body = outcome.body as Extract<typeof outcome.body, {offset: number; revision: number}>;
        res.set('Upload-Offset', String(body.offset));
        res.set('ETag', `"${body.revision}"`);
        res.set('Upload-Request-Id', header(req, 'upload-request-id') ?? '');
      } else if (outcome.status === 409) {
        // Conflict carries the CURRENT committed offset so the client can
        // trim everything below it and retry only unacknowledged bytes.
        const body = outcome.body as Extract<typeof outcome.body, {offset: number; revision: number}>;
        res.set('Upload-Offset', String(body.offset));
        res.set('ETag', `"${body.revision}"`);
      }
      res.json(outcome.body);
    },
  );

  // Demo/test fault injection: the next durable append (or metadata snapshot)
  // for this session rejects, simulating a disk failure.
  app.post('/api/uploads/:id/fault', (req, res) => {
    if (!uploadEngine.getSession(req.params.id)) {
      return res.status(410).json({error: 'session_expired'});
    }
    const kind = req.body?.kind === 'meta' ? 'meta' : 'append';
    uploadEngine.planStorageFailure(kind);
    res.json({planned: kind});
  });

  app.post('/api/uploads/:id/complete', (req, res) => {    const session = uploadEngine.completeSession(req.params.id);
    if (!session) return res.status(410).json({error: 'session_expired'});
    res.json(serialize(session));
  });

  app.delete('/api/uploads/:id', (req, res) => {
    const session = uploadEngine.cancelSession(req.params.id);
    if (!session) return res.status(410).json({error: 'session_expired'});
    res.json(serialize(session));
  });

  /**
   * Download protocol. A session becomes a downloadable object exactly when
   * it is completed; from then on its bytes — and therefore its ETag (the
   * full-content SHA-256) — never change.
   *
   *   HEAD /api/uploads/:id/download
   *     200 + Content-Length / ETag / Digest / Accept-Ranges: the identity,
   *     total length and digest a client pins BEFORE fetching any bytes.
   *     409 session_active   — prefix still changing, not the final file
   *     410 session_cancelled — confirmed prefix is not downloadable
   *     410 session_expired  — unknown or aged-out session
   *
   *   GET /api/uploads/:id/download
   *     No Range        -> 200 full content, streamed in slices.
   *     Range: bytes=a-b -> 206 with Content-Range and a Content-Digest over
   *                         exactly this response's body. Only the requested
   *                         range is read (positioned storage reads) — a small
   *                         range never pulls the whole blob into memory.
   *     If-Range: <etag> -> stale validator means the client's saved prefix
   *                         belongs to a different object: the Range is
   *                         ignored and a full 200 is sent, so the client can
   *                         detect the mismatch instead of splicing two
   *                         versions into one "successful" file.
   *     Unsatisfiable   -> 416; Content-Range reports "bytes *" plus the size.
   */
  const downloadHandler = async (
    req: express.Request<{id: string}>,
    res: express.Response,
    head: boolean,
  ) => {
    try {
      let info: DownloadState;
      try {
        info = await uploadEngine.describeDownload(req.params.id);
      } catch (error) {
        return res.status(500).json({error: 'blob_inconsistent', detail: (error as Error).message});
      }
      if (info.kind !== 'ready') return explainDownloadState(res, info);

      const etag = `"${info.sha256}"`;
      res.set('ETag', etag);
      res.set('Digest', `sha-256=:${Buffer.from(info.sha256, 'hex').toString('base64')}:`);
      res.set('Accept-Ranges', 'bytes');
      res.set('Cache-Control', 'no-store');
      res.set('Content-Disposition', `attachment; filename="${sanitizeFilename(info.name)}"`);

      // A stale If-Range validator downgrades this to a full-content 200.
      let parsed = parseRangeHeader(header(req, 'range'), info.size);
      const ifRange = header(req, 'if-range');
      if (parsed.kind !== 'none' && ifRange !== undefined && ifRange.trim() !== etag) {
        parsed = {kind: 'none'};
      }

      if (parsed.kind === 'unsatisfiable') {
        res.set('Content-Range', `bytes */${info.size}`);
        return res.status(416).json({error: 'range_not_satisfiable', size: info.size});
      }

      if (parsed.kind === 'range') {
        const {start, end} = parsed.range;
        const length = end - start + 1;
        res.status(206);
        res.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
        res.set('Content-Length', String(length));
        if (head) return res.end();

        // Read exactly the requested range in positioned slices — never the
        // whole blob — and hash it so this response's body is self-verifiable.
        // Everything happens BEFORE the first header byte goes out, so an
        // identity change mid-read still yields a clean terminal status.
        const parts: Buffer[] = [];
        const bodyHasher = createHash('sha256');
        let pos = start;
        while (pos <= end) {
          const slice = await uploadEngine.readCompletedRange(
            info.id,
            pos,
            Math.min(downloadSliceBytes, end + 1 - pos),
            info.sha256,
          );
          if (!slice) {
            const now = await uploadEngine.describeDownload(info.id).catch(() => ({kind: 'gone'}) as DownloadState);
            return explainDownloadState(res, now);
          }
          if (slice.length === 0) break;
          parts.push(slice);
          bodyHasher.update(slice);
          pos += slice.length;
        }
        const body = Buffer.concat(parts);
        if (body.length !== length) {
          return res.status(500).json({error: 'blob_inconsistent', detail: 'short read'});
        }
        res.set('Content-Digest', `sha-256=:${bodyHasher.digest('base64')}:`);
        return res.end(body);
      }

      // Full content.
      res.status(200);
      res.set('Content-Length', String(info.size));
      if (head) return res.end();

      // Stream in slices; the identity is re-validated per slice so a cancel
      // or expiry mid-stream destroys the response instead of letting bytes
      // of a different object complete this one.
      res.on('error', () => undefined);
      let pos = 0;
      while (pos < info.size) {
        const slice = await uploadEngine.readCompletedRange(
          info.id,
          pos,
          Math.min(downloadSliceBytes, info.size - pos),
          info.sha256,
        );
        if (!slice || slice.length === 0) {
          res.destroy(new Error('session changed mid-download'));
          return;
        }
        pos += slice.length;
        if (res.destroyed || res.writableEnded) return;
        if (!res.write(slice)) await once(res, 'drain');
      }
      res.end();
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error as Error);
      } else {
        res.status(500).json({error: 'download_failed', detail: (error as Error).message});
      }
    }
  };

  app.head('/api/uploads/:id/download', (req, res) => void downloadHandler(req, res, true));
  app.get('/api/uploads/:id/download', (req, res) => void downloadHandler(req, res, false));

  return app;
}

/**
 * Terminal non-downloadable states, each explaining its confirmed bytes.
 * The explanation travels BOTH in the JSON body and in headers, because HEAD
 * responses carry no body — a client must be able to learn from a HEAD why
 * the object is not downloadable and which prefix had been confirmed.
 */
function explainDownloadState(res: express.Response, info: DownloadState) {
  if (info.kind === 'cancelled') {
    res.set('X-Session-Error', 'session_cancelled');
    res.set('Upload-Offset', String(info.offset));
    res.set('X-Prefix-Sha256', info.sha256);
    return res.status(410).json({
      error: 'session_cancelled',
      offset: info.offset,
      revision: info.revision,
      sha256: info.sha256,
    });
  }
  if (info.kind === 'active') {
    res.set('X-Session-Error', 'session_active');
    res.set('Upload-Offset', String(info.offset));
    res.set('X-Prefix-Sha256', info.sha256);
    return res.status(409).json({
      error: 'session_active',
      offset: info.offset,
      revision: info.revision,
      sha256: info.sha256,
    });
  }
  res.set('X-Session-Error', 'session_expired');
  return res.status(410).json({error: 'session_expired'});
}

type ByteRange = {start: number; end: number}; // inclusive

type RangeParse =
  | {kind: 'none'} // header absent/invalid/ignored -> full content
  | {kind: 'unsatisfiable'} // no overlap with the representation -> 416
  | {kind: 'range'; range: ByteRange};

/**
 * Single-range parser (RFC 9110 §14.1.2). Unknown units, malformed specs and
 * multi-range sets are ignored (full content); ranges with no overlap are
 * unsatisfiable. `end` is clamped to the representation.
 */
export function parseRangeHeader(value: string | undefined, size: number): RangeParse {
  if (!value) return {kind: 'none'};
  const unit = /^bytes\s*=\s*(.+)$/i.exec(value.trim());
  if (!unit) return {kind: 'none'};
  const specs = unit[1].split(',');
  if (specs.length !== 1) return {kind: 'none'};
  const match = /^(\d*)-(\d*)$/.exec(specs[0].trim());
  if (!match || (match[1] === '' && match[2] === '')) return {kind: 'none'};

  if (match[1] === '') {
    // Suffix: the last N bytes.
    const suffix = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) {
      return {kind: 'unsatisfiable'};
    }
    return {kind: 'range', range: {start: Math.max(0, size - suffix), end: size - 1}};
  }

  const start = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(start)) return {kind: 'none'};
  if (start >= size) return {kind: 'unsatisfiable'};
  if (match[2] === '') return {kind: 'range', range: {start, end: size - 1}};
  const end = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(end) || end < start) return {kind: 'none'};
  return {kind: 'range', range: {start, end: Math.min(end, size - 1)}};
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'download.bin';
}

function header(req: express.Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function serialize(session: UploadSession) {
  return {
    id: session.id,
    name: session.name,
    offset: session.offset,
    revision: session.revision,
    sha256: session.sha256,
    state: session.state,
    createdAt: new Date(session.createdAt).toISOString(),
    expiresAt: session.expiresAt == null ? null : new Date(session.expiresAt).toISOString(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () =>
    console.log('server http://127.0.0.1:4174'),
  );
}
