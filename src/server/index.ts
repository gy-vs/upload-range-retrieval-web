import express from 'express';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {DiskStorage} from './storage';
import {UploadEngine, type ContentDescriptor, type UploadSession} from './engine';

export function createApp(engine?: UploadEngine) {
  const uploadEngine =
    engine ??
    new UploadEngine(new DiskStorage(path.join(process.cwd(), '.uploads-data')));

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

  app.post('/api/uploads/:id/complete', async (req, res) => {
    const outcome = await uploadEngine.completeSession(req.params.id);
    res.status(outcome.status).json(outcome.body);
  });

  app.delete('/api/uploads/:id', async (req, res) => {
    const outcome = await uploadEngine.cancelSession(req.params.id);
    res.status(outcome.status).json(outcome.body);
  });

  /**
   * Shared gate for the object HEAD: only a completed session advertises an
   * object; active prefixes answer 409 and cancelled/expired ones 410.
   * On success the full-object identity headers are already set.
   */
  const contentHeadGate = async (
    req: express.Request,
    res: express.Response,
  ): Promise<ContentDescriptor | null> => {
    const opened = await uploadEngine.openContent(String(req.params.id));
    if (opened.status !== 200) {
      if (opened.status === 409) {
        const body = opened.body;
        res.status(409);
        res.set('X-Session-State', body.state);
        res.set('Upload-Offset', String(body.offset));
        res.set('X-Content-SHA256', body.sha256);
      } else {
        const body = opened.body;
        res.status(opened.status);
        res.set(
          'X-Session-State',
          body.error === 'session_cancelled'
            ? 'cancelled'
            : body.error === 'session_expired'
              ? 'expired'
              : 'completed',
        );
      }
      res.end();
      return null;
    }
    setObjectHeaders(res, opened.descriptor);
    const ifMatch = header(req, 'if-match');
    if (ifMatch !== undefined && !etagMatches(ifMatch, opened.descriptor.etag)) {
      res.status(412).end();
      return null;
    }
    return opened.descriptor;
  };

  app.head('/api/uploads/:id/content', async (req, res) => {
    const descriptor = await contentHeadGate(req, res);
    if (!descriptor) return;
    // Full-object length; a HEAD never opens a byte stream.
    res.set('Content-Length', String(descriptor.size));
    res.set('Accept-Ranges', 'bytes');
    res.end();
  });

  app.get('/api/uploads/:id/content', async (req, res) => {
    const opened = await uploadEngine.openContent(String(req.params.id));
    if (opened.status !== 200) {
      if (opened.status === 409) {
        const body = opened.body;
        res.status(409);
        res.set('X-Session-State', body.state);
        res.set('Upload-Offset', String(body.offset));
        res.set('X-Content-SHA256', body.sha256);
      } else {
        const body = opened.body;
        res.status(opened.status);
        res.set(
          'X-Session-State',
          body.error === 'session_cancelled' ? 'cancelled' : body.error === 'session_expired' ? 'expired' : 'completed',
        );
      }
      res.json(opened.body);
      return;
    }
    const descriptor = opened.descriptor;
    setObjectHeaders(res, descriptor);

    // Identity precondition (resume safety): mismatched identity -> 412.
    const ifMatch = header(req, 'if-match');
    if (ifMatch !== undefined && !etagMatches(ifMatch, descriptor.etag)) {
      res.status(412).json({error: 'precondition_failed', expected: ifMatch, etag: `"${descriptor.etag}"`});
      return;
    }

    // A zero-byte object has no rangeable content: send an empty whole body.
    if (descriptor.size === 0) {
      res.set('Content-Length', '0');
      return res.end();
    }

    const rangeHeader = header(req, 'range');
    if (rangeHeader !== undefined) {
      // If-Range: serve the range only if the entity is still the expected
      // one; otherwise fall back to the complete entity (RFC 9110). A
      // completed object is immutable, so a date form always refers to an
      // unchanged entity; an entity-tag form must match exactly.
      const ifRange = header(req, 'if-range')?.trim();
      const rangeFresh =
        ifRange === undefined ||
        (ifRange.startsWith('"') ? ifRange === `"${descriptor.etag}"` : parseHttpDate(ifRange) >= 0);
      const range = parseRange(rangeHeader, descriptor.size);
      if (!range || !rangeFresh) {
        if (range) {
          // Stale If-Range: ignore the Range and send the whole object below.
        } else {
          res.status(416);
          res.set('Content-Range', `bytes */${descriptor.size}`);
          return res.json({error: 'range_not_satisfiable'});
        }
      } else {
        const {start, end} = range;
        const length = end - start + 1;
        res.status(206);
        res.set('Content-Length', String(length));
        res.set('Content-Range', `bytes ${start}-${end}/${descriptor.size}`);
        res.set('Accept-Ranges', 'bytes');
        const stream = uploadEngine.openContentStream(descriptor.id, start, end + 1);
        stream.on('error', (error: Error) => {
          if (!res.headersSent) {
            res.status(500).json({error: 'stream_failed', detail: error.message});
          } else {
            res.destroy(error);
          }
        });
        return stream.pipe(res);
      }
    }

    // Whole object (no Range, or stale If-Range fallback).
    res.status(200);
    res.set('Content-Length', String(descriptor.size));
    res.set('Accept-Ranges', 'bytes');
    const stream = uploadEngine.openContentStream(descriptor.id, 0, descriptor.size);
    stream.on('error', (error: Error) => {
      if (!res.headersSent) {
        res.status(500).json({error: 'stream_failed', detail: error.message});
      } else {
        res.destroy(error);
      }
    });
    stream.pipe(res);
  });

  return app;
}

/** Headers identifying the FULL object, set identically on HEAD and range GET. */
function setObjectHeaders(res: express.Response, descriptor: ContentDescriptor): void {
  res.set('ETag', `"${descriptor.etag}"`);
  res.set('Content-Type', 'application/octet-stream');
  // RFC 9530 plus an unencoded mirror that workbenches/tests can read directly.
  res.set('Digest', `sha-256=${base64FromHex(descriptor.sha256)}`);
  res.set('X-Content-SHA256', descriptor.sha256);
  res.set('X-Object-Name', encodeURIComponent(descriptor.name));
  res.set('Content-Disposition', contentDisposition(descriptor.name, descriptor.id));
}

function contentDisposition(name: string, id: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[^A-Za-z0-9._-]/g, '_') || id;
  // RFC 6266: ASCII fallback plus the RFC 5987 extended (UTF-8) name.
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(name)}`;
}

function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function base64FromHex(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

/**
 * Parse an RFC 9110 byte range against the object size. Only the first range
 * is honoured (single-window streaming); returns null on a malformed or
 * unsatisfiable range. Open suffix ranges (`bytes=start-`) are clamped to the
 * end; suffix ranges (`bytes=-n`) mean the last n bytes.
 */
export function parseRange(headerValue: string, size: number): {start: number; end: number} | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(headerValue.trim());
  if (!match) return null;
  const [, first, last] = match;
  if (first === '' && last === '') return null;
  let start: number;
  let end: number;
  if (first === '') {
    // Suffix range: the final N bytes.
    const n = Number.parseInt(last, 10);
    if (!Number.isInteger(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number.parseInt(first, 10);
    if (!Number.isInteger(start) || start < 0) return null;
    if (start >= size) return null;
    end = last === '' ? size - 1 : Number.parseInt(last, 10);
    if (!Number.isInteger(end) || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return {start, end};
}

function etagMatches(ifMatchHeader: string, etag: string): boolean {
  // Supports a single strong validator or `*`; multiple tags are AND/OR-less
  // here because this endpoint only ever has one entity.
  const tokens = ifMatchHeader
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return tokens.some((token) => token === '*' || token === `"${etag}"`);
}

function parseHttpDate(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? -1 : time;
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
