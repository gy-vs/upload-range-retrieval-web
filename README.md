# Resumable Upload Studio

Run `npm install`, `npm test`, `npm run build`, or `npm run dev`.
The development UI listens on port 4173 and the API on port 4174.

## What this is

A workbench for a strictly-sequential resumable **upload** protocol
(`offset-cas/1`) and, once an upload is finalized, a resumable, verifiable
**download** of the frozen object.

### Upload (unchanged)

- `POST /api/uploads` create a session
- `PATCH /api/uploads/:id` append raw bytes with `Upload-Offset`,
  `If-Match: "<revision>"`, `Upload-Request-Id` (idempotency) and
  `Upload-Checksum`
- 409 conflicts carry the current committed offset; 507 leaves metadata
  untouched; a lost response is replayed from the request-id ledger

### Finalize

`POST /api/uploads/:id/complete` **seals** the session. Before the state flips
to `completed`, the server re-reads the durable blob and proves its length and
SHA-256 equal the committed prefix. A completed object is immutable: further
appends are 410 and a late `DELETE` is 409 (the object stays downloadable).
`DELETE` on an active session cancels it (serialized against in-flight
appends); cancelling a completed session is refused.

### Download the finalized object

`HEAD|GET /api/uploads/:id/content`

- only a `completed` session is served: active → **409** (a moving prefix is
  never a file), cancelled/expired → **410** even if the `.part` file remains
- `ETag` is the SHA-256 of the full bytes; `Digest: sha-256=…`,
  `X-Content-SHA256`, total `Content-Length` and `Content-Disposition` are
  always present
- `Range: bytes=a-b` → 206 with a `Content-Range` whose window, body and ETag
  all describe the same object; bad/unsatisfiable ranges → 416
- `If-Match: "<sha256>"` pins object identity for resume: if the object behind
  the URL changed, the server answers **412** instead of letting the client
  splice two versions together
- `If-Range` serves the range only while the entity matches, else the whole
  object
- reads are bounded and streamed from both storage backends — a small range
  never hashes or buffers the entire file

The browser panel lets you freeze an upload, inspect object identity/length/
digest, download, pause/resume (or simulate a dropped connection), watch the
confirmed byte count, and finish with a full-file SHA-256 verification. Local
bytes live only in memory: after a page reload the UI starts at 0 confirmed
bytes even though the server already holds the object.
