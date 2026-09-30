import express from 'express';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {DiskStorage} from './storage';
import {UploadEngine, type UploadSession} from './engine';

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

  app.post('/api/uploads/:id/complete', (req, res) => {    const session = uploadEngine.completeSession(req.params.id);
    if (!session) return res.status(410).json({error: 'session_expired'});
    res.json(serialize(session));
  });

  app.delete('/api/uploads/:id', (req, res) => {
    const session = uploadEngine.cancelSession(req.params.id);
    if (!session) return res.status(410).json({error: 'session_expired'});
    res.json(serialize(session));
  });

  return app;
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
