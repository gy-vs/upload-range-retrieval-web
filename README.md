# Resumable Upload Studio

Run `npm install`, `npm test`, `npm run build`, or `npm run dev`.
The development UI listens on port 4173 and the API on port 4174.

## Upload protocol (offset CAS)

`PATCH /api/uploads/:id` with a raw chunk body and tus-style headers
(`Upload-Offset`, `If-Match: "<revision>"`, `Upload-Request-Id`,
`Upload-Checksum`). One durable append advances offset+revision exactly once;
conflicts return 409 with the current committed offset, lost responses are
replayed from the request-id ledger, and storage failures (507) never move
the metadata.

## Download protocol (completed sessions)

A session becomes a downloadable object exactly when it is completed
(`POST /api/uploads/:id/complete`); from then on its bytes never change and
its identity is the full-content SHA-256.

- `HEAD /api/uploads/:id/download` → 200 with `Content-Length`,
  `ETag: "<sha256>"`, `Digest: sha-256=:…:`, `Accept-Ranges: bytes` — the
  identity, total length and digest a client pins before fetching bytes.
- `GET /api/uploads/:id/download` → 200 full content (streamed in slices), or
  206 for `Range: bytes=a-b` with `Content-Range` and a `Content-Digest` over
  exactly that response body. Only the requested range is read from storage.
- `If-Range: "<etag>"` with a stale validator → full 200, so a resuming
  client detects the identity change instead of splicing two versions.
- Unsatisfiable range → 416 with `Content-Range: bytes */<size>`.
- Non-final states explain themselves (body + `X-Session-Error`,
  `Upload-Offset`, `X-Prefix-Sha256` headers, since HEAD has no body):
  409 `session_active` (prefix still changing), 410 `session_cancelled`
  (confirmed prefix is not downloadable), 410 `session_expired`.

The workbench UI drives the whole flow: run an upload scenario, complete the
session, inspect the downloadable object, then download / pause / resume with
a live confirmed-bytes counter and a final SHA-256 verification. Download
progress lives in browser memory only — a page refresh restarts from 0 bytes.
