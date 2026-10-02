import {useEffect, useRef, useState} from 'react';
import {
  Ban,
  CheckCircle2,
  Clock3,
  FileLock2,
  FlaskConical,
  HardDriveDownload,
  Layers,
  OctagonX,
  Pause,
  Play,
  Download as DownloadIcon,
  RadioTower,
  RefreshCw,
  Save,
  ShieldAlert,
  WifiOff,
  Zap,
} from 'lucide-react';
import {
  newRequestId,
  planBlocks,
  planOverlappingBlocks,
  runUpload,
  sha256Hex,
  type UploadBlock,
  type UploadEvent,
} from './uploader';
import {
  fetchObjectInfo,
  runDownload,
  RunGuard,
  type ObjectInfo,
} from './downloader';

type Scenario =
  | 'normal'
  | 'duplicate'
  | 'overlap'
  | 'zero'
  | 'write-fail'
  | 'response-lost'
  | 'expire'
  | 'cancel';

const SCENARIOS: Array<{id: Scenario; label: string; hint: string; Icon: typeof Zap}> = [
  {id: 'normal', label: 'Sequential upload', hint: 'Three blocks, strict offset CAS', Icon: Play},
  {id: 'duplicate', label: 'Same-offset race', hint: 'Two identical PATCHes for one block', Icon: Zap},
  {id: 'overlap', label: 'Overlapping blocks', hint: 'Trim & retry only the uncovered suffix', Icon: Layers},
  {id: 'zero', label: 'Zero-length blocks', hint: 'Empty PATCH bumps revision only', Icon: RadioTower},
  {id: 'write-fail', label: 'Storage failure', hint: '507: metadata must not advance', Icon: HardDriveDownload},
  {id: 'response-lost', label: 'Response lost', hint: 'Same request id replay from ledger', Icon: RefreshCw},
  {id: 'expire', label: 'Session expiry', hint: 'TTL 2.5s, upload pauses past it', Icon: Clock3},
  {id: 'cancel', label: 'Cancel', hint: 'DELETE mid-upload -> terminal 410', Icon: OctagonX},
];

const DEFAULT_PAYLOAD =
  'alpha-block-0001\nbeta-block-0002\ngamma-block-0003\ndelta-block-0004\nepsilon-0005\n';

const OBJECTS_KEY = 'upload-studio:objects';

type LogLine = {id: number; text: string; tone: 'info' | 'ok' | 'warn' | 'bad'};

type DownloadState =
  | 'ready'
  | 'downloading'
  | 'paused'
  | 'verified'
  | 'error'
  | 'not-completed';

type DownloadPanel = {
  sessionId: string;
  name: string;
  size: number;
  sha256: string;
  state: DownloadState;
  /** Bytes durably received and confirmed IN THIS BROWSER SESSION. */
  saved: number;
  note?: string;
};

type StoredObjectMeta = {id: string; name: string; size: number; sha256: string; savedAt: string};

function loadStoredObjects(): StoredObjectMeta[] {
  try {
    const raw = localStorage.getItem(OBJECTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredObjectMeta[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [scenario, setScenario] = useState<Scenario>('normal');
  const [payloadText, setPayloadText] = useState(DEFAULT_PAYLOAD);
  const [chunkSize, setChunkSize] = useState(16);
  const [dlChunkSize, setDlChunkSize] = useState(64);
  const [running, setRunning] = useState(false);
  const [blocks, setBlocks] = useState<UploadBlock[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [result, setResult] = useState<null | {
    offset: number;
    revision: number;
    sha256: string;
    expectedSha: string;
    consistent: boolean;
    sessionId: string;
    state: string;
  }>(null);
  const [dl, setDl] = useState<DownloadPanel | null>(null);
  const [objectOptions, setObjectOptions] = useState<StoredObjectMeta[]>([]);
  const [selectedObjectId, setSelectedObjectId] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const logId = useRef(0);

  // Download run bookkeeping. runGuard prevents a response of a previous
  // session being written into the panel after the user switches sessions.
  const runGuardRef = useRef(new RunGuard());
  const currentSessionIdRef = useRef<string | null>(null);
  const dlAbortRef = useRef<AbortController | null>(null);
  const dlPauseRef = useRef<AbortController | null>(null);
  /** Confirmed download bytes (memory only; lost on page reload by design). */
  const dlPrefixRef = useRef<Uint8Array>(new Uint8Array(0));
  const dlBytesRef = useRef<Uint8Array | null>(null);
  const dlInfoRef = useRef<ObjectInfo | null>(null);
  const dropNextRef = useRef(false);
  /** Note the paused/stopped run should surface once it settles. */
  const pauseNoteRef = useRef<string | null>(null);

  function log(text: string, tone: LogLine['tone'] = 'info') {
    logId.current += 1;
    setLogs((prev) => [...prev.slice(-160), {id: logId.current, text, tone}]);
  }

  function invalidateDownloadRuns() {
    // Bump the run generation and stop any in-flight download. Events from the
    // old run (responses still arriving) are dropped by the RunGuard check.
    runGuardRef.current.invalidate();
    dlAbortRef.current?.abort();
    dlPauseRef.current?.abort();
    dlAbortRef.current = null;
    dlPauseRef.current = null;
  }

  // Refresh the list of downloadable objects (completed sessions on the
  // server, merged with metadata kept from earlier browser sessions).
  async function refreshObjectList() {
    const stored = loadStoredObjects();
    let serverCompleted: StoredObjectMeta[] = [];
    try {
      const res = await fetch('/api/uploads');
      if (res.ok) {
        const rows = (await res.json()) as Array<{
          id: string;
          name: string;
          size?: number;
          offset: number;
          sha256: string;
          state: string;
        }>;
        serverCompleted = rows
          .filter((r) => r.state === 'completed')
          .map((r) => ({id: r.id, name: r.name, size: r.offset, sha256: r.sha256, savedAt: ''}));
      }
    } catch {
      /* offline: fall back to stored metadata only */
    }
    const merged = new Map<string, StoredObjectMeta>();
    for (const meta of [...stored, ...serverCompleted]) merged.set(meta.id, meta);
    setObjectOptions([...merged.values()]);
  }

  useEffect(() => {
    void refreshObjectList();
  }, []);

  function persistObjectMeta(info: ObjectInfo) {
    const stored = loadStoredObjects().filter((o) => o.id !== info.id);
    stored.push({id: info.id, name: info.name, size: info.size, sha256: info.sha256, savedAt: new Date().toISOString()});
    localStorage.setItem(OBJECTS_KEY, JSON.stringify(stored));
    void refreshObjectList();
  }

  function renderEvent(event: UploadEvent) {
    if ('block' in event) {
      setBlocks((prev) => prev.map((b) => (b.index === event.block.index ? {...event.block} : b)));
    }
    switch (event.type) {
      case 'send':
        log(`→ PATCH block#${event.block.index} req=${event.requestId} offset=${event.offset} len=${event.length}`, 'info');
        break;
      case 'ack':
        log(
          `← 200 block#${event.block.index} committed offset=${event.offset} rev=${event.revision}${
            event.replayed ? ' [LEDGER REPLAY, no duplicate write]' : event.block.note ? ` (${event.block.note})` : ''
          }`,
          'ok',
        );
        break;
      case 'conflict':
        log(`← 409 block#${event.block.index} req=${event.requestId} -> current offset=${event.serverOffset} rev=${event.serverRevision}; trimming`, 'warn');
        break;
      case 'retry':
        log(`↻ retry block#${event.block.index} (${event.reason}) in ${event.delayMs}ms — same request id`, 'warn');
        break;
      case 'storage-failure':
        log(`← 507 block#${event.block.index} storage failed; offset/revision unchanged`, 'bad');
        break;
      case 'covered':
        log(`✓ block#${event.block.index} already covered by committed prefix ${event.serverOffset}`, 'ok');
        break;
      case 'fatal':
        log(`✗ block#${event.block.index} terminal: ${event.reason}`, 'bad');
        break;
      case 'done':
        log(`■ upload done offset=${event.offset} rev=${event.revision} sha=${event.sha256.slice(0, 12)}…`, 'ok');
        break;
      case 'log':
        log(event.message, 'info');
        break;
    }
  }

  async function start() {
    setRunning(true);
    setLogs([]);
    setResult(null);
    invalidateDownloadRuns();
    setDl(null);
    dlBytesRef.current = null;
    dlPrefixRef.current = new Uint8Array(0);
    const payload = new TextEncoder().encode(payloadText);

    // 1. create session (short TTL for the expiry demo)
    const createRes = await fetch('/api/uploads', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        name: SCENARIOS.find((s) => s.id === scenario)?.label,
        ttlMs: scenario === 'expire' ? 2500 : null,
      }),
    });
    const session = await createRes.json();
    currentSessionIdRef.current = session.id;
    setSelectedObjectId('');
    log(`session ${session.id} created rev=0 offset=0${scenario === 'expire' ? ' ttl=2500ms' : ''}`, 'info');

    // 2. plan blocks for the scenario
    let planned: UploadBlock[];
    switch (scenario) {
      case 'zero':
        planned = planBlocks(payload, chunkSize, [1]);
        // inject an extra zero block at the tail too
        planned.push({
          index: planned.length,
          requestId: newRequestId(planned.length),
          baseStart: payload.length,
          fullBytes: new Uint8Array(0),
          start: payload.length,
          end: payload.length,
          status: 'queued',
          attempts: 0,
          replayed: false,
          note: 'trailing zero-length',
        });
        break;
      case 'overlap': {
        const half = Math.max(1, Math.floor(payload.length / 2));
        planned = planOverlappingBlocks(payload, [
          [0, chunkSize * 2],
          [chunkSize, chunkSize * 3], // overlaps block 0 by chunkSize bytes
          [chunkSize * 2, payload.length || 1],
        ]).filter((b) => b.end > b.start || half >= 0);
        break;
      }
      case 'duplicate':
        planned = planBlocks(payload, chunkSize);
        planned[1] = {...planned[1], duplicate: true, note: 'fired twice at once'};
        break;
      default:
        planned = planBlocks(payload, chunkSize);
    }
    planned = planned.filter((b) => b.fullBytes.length > 0 || b.note.includes('zero') || scenario === 'zero');
    setBlocks(planned);

    const abort = new AbortController();
    abortRef.current = abort;

    // Scenario side effects
    let doFetch: typeof fetch | undefined;
    if (scenario === 'write-fail') {
      await fetch(`/api/uploads/${session.id}/fault`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({kind: 'append'}),
      });
      log('fault injected: next durable append will fail', 'warn');
    }
    if (scenario === 'response-lost') {
      // Lose the response of block 1's first attempt client-side: abort the
      // fetch while the server still processes and commits it. The retry uses
      // the same request id and must be answered from the ledger.
      const targetIndex = 1;
      const targetId = planned[targetIndex]?.requestId;
      const realFetch = fetch;
      let lost = false;
      doFetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const urlText = String(input);
        const reqId = (init?.headers as Record<string, string> | undefined)?.['Upload-Request-Id'];
        if (!lost && urlText.includes('/api/uploads/') && init?.method === 'PATCH' && reqId === targetId) {
          lost = true;
          // Abort the RESPONSE after the server has had time to commit the
          // append. The retry uses the same request id; the server ledger
          // must answer replayed=true instead of writing twice.
          const oneShot = new AbortController();
          setTimeout(() => {
            oneShot.abort(new Error('simulated packet loss'));
            log('🌩 response for block#1 lost after the server committed it', 'warn');
          }, 120);
          return realFetch(input as RequestInfo, {...init, signal: oneShot.signal});
        }
        return realFetch(input as RequestInfo, init);
      };
    }
    if (scenario === 'expire') {
      log('sleeping 3000ms so the session expires before any chunk lands…', 'warn');
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (scenario === 'cancel') {
      setTimeout(() => {
        log('user pressed cancel: DELETE session', 'warn');
        void fetch(`/api/uploads/${session.id}`, {method: 'DELETE'});
        abort.abort();
      }, 220);
    }

    try {
      const finalState = await runUpload({
        sessionId: session.id,
        blocks: planned,
        onEvent: renderEvent,
        doFetch,
        signal: abort.signal,
      });
      const expected = await sha256Hex(payload);
      // Only full-payload scenarios can be compared to the plain payload hash.
      const full = ['normal', 'duplicate', 'overlap', 'response-lost', 'write-fail'].includes(scenario);
      setResult({
        offset: finalState.offset,
        revision: finalState.revision,
        sha256: finalState.sha256,
        expectedSha: expected,
        consistent: !full || (finalState.offset === payload.length && finalState.sha256 === expected),
        sessionId: session.id,
        state: 'active',
      });
    } catch (error) {
      log(`■ stopped: ${(error as Error).message}`, 'bad');
      const probe = await fetch(`/api/uploads/${session.id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (probe) {
        const expected = await sha256Hex(payload);
        // Partial prefixes are still internally consistent: digest over the
        // first `offset` bytes of payload must equal the server digest.
        const prefixSha = await sha256Hex(payload.subarray(0, probe.offset));
        setResult({
          offset: probe.offset,
          revision: probe.revision,
          sha256: probe.sha256,
          expectedSha: prefixSha,
          consistent: probe.sha256 === prefixSha && probe.offset <= payload.length,
          sessionId: session.id,
          state: probe.state,
        });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  /** Freeze the active session: the server re-verifies length+digest then seals. */
  async function completeCurrent() {
    const sessionId = result?.sessionId ?? currentSessionIdRef.current;
    if (!sessionId) return;
    const res = await fetch(`/api/uploads/${sessionId}/complete`, {method: 'POST'});
    const body = await res.json().catch(() => ({}));
    if (res.status === 200) {
      log(`◆ session ${sessionId} sealed as an immutable object (${body.offset} bytes, ${body.state})`, 'ok');
      const meta = await fetchObjectInfo(fetch, '', sessionId);
      if (meta.kind === 'object') {
        persistObjectMeta(meta.info);
        showReady(meta.info);
      }
      setResult((r) => (r ? {...r, state: 'completed'} : r));
    } else if (res.status === 409) {
      log(`◆ complete refused: ${body.error} (state=${body.state}) — only an active session freezes`, 'warn');
    } else if (res.status === 410) {
      log(`◆ complete refused: ${body.error ?? 'session gone'}`, 'bad');
    } else {
      log(`◆ seal failed: ${body.error} ${body.detail ?? ''}`, 'bad');
      setDl({
        sessionId,
        name: '',
        size: result?.offset ?? 0,
        sha256: result?.sha256 ?? '',
        state: 'error',
        saved: 0,
        note: `server refused to seal: ${body.detail ?? body.error}`,
      });
    }
  }

  function showReady(info: ObjectInfo) {
    dlPrefixRef.current = new Uint8Array(0);
    dlBytesRef.current = null;
    dlInfoRef.current = info;
    setSelectedObjectId(info.id);
    // After a page reload the local bytes are GONE even though the server list
    // still reports the full offset: start the panel at zero confirmed bytes.
    setDl({sessionId: info.id, name: info.name, size: info.size, sha256: info.sha256, state: 'ready', saved: 0});
  }

  /**
   * Drive one run of the downloader. A new runId invalidates any previous
   * run: its late events/results cannot touch the current session's panel.
   */
  function launchDownload(info: ObjectInfo, prefix: Uint8Array, resume: boolean) {
    const myRun = runGuardRef.current.next();
    const cancel = new AbortController();
    const pause = new AbortController();
    dlAbortRef.current = cancel;
    dlPauseRef.current = pause;
    dlPrefixRef.current = prefix;
    dlInfoRef.current = info;

    setDl({
      sessionId: info.id,
      name: info.name,
      size: info.size,
      sha256: info.sha256,
      state: 'downloading',
      saved: prefix.length,
      note: resume ? `resuming at byte ${prefix.length} with If-Match pinned` : undefined,
    });
    if (resume) log(`DL ▶ resume ${info.id} from byte ${prefix.length}/${info.size}, etag pinned`, 'info');
    else log(`DL ▶ download ${info.id} (${info.size} bytes, chunk ${dlChunkSize}B)`, 'info');

    const realFetch = fetch;
    const doFetch: typeof fetch = (input, init) => {
      // Demo fault: kill the NEXT content GET mid-flight. The confirmed prefix
      // survives; the downloader retries exactly the missing window.
      if (dropNextRef.current && init?.method === 'GET' && String(input).includes('/content')) {
        dropNextRef.current = false;
        const oneShot = new AbortController();
        setTimeout(() => {
          oneShot.abort(new Error('simulated connection drop'));
          log('DL ⚡ connection dropped mid-chunk — confirmed bytes kept, will resume', 'warn');
        }, 25);
        return realFetch(input as RequestInfo, {...init, signal: oneShot.signal});
      }
      return realFetch(input as RequestInfo, init);
    };

    void runDownload({
      sessionId: info.id,
      prefix,
      etag: resume ? info.etag : undefined,
      baseUrl: '',
      doFetch,
      signal: cancel.signal,
      pauseSignal: pause.signal,
      chunkSize: dlChunkSize,
      onEvent: (event) => {
        if (!runGuardRef.current.isCurrent(myRun)) return; // stale run: ignore
        switch (event.type) {
          case 'metadata':
            log(`DL · object ${event.info.name}: ${event.info.size}B sha=${event.info.sha256.slice(0, 12)}…`, 'info');
            break;
          case 'request':
            log(`DL → GET Range bytes=${event.start}-${event.end}${event.attempt > 1 ? ` (attempt ${event.attempt})` : ''}`, 'info');
            break;
          case 'chunk':
            setDl((d) => (d && d.sessionId === info.id ? {...d, saved: event.saved} : d));
            break;
          case 'retry':
            log(`DL ↻ ${event.reason}; retry from byte ${event.from} in ${event.delayMs}ms — no overwrite`, 'warn');
            break;
          case 'paused':
            log(`DL ⏸ paused with ${event.saved} confirmed bytes`, 'warn');
            break;
          case 'fatal':
            log(`DL ✗ ${event.reason}`, 'bad');
            break;
          case 'done':
            log(`DL ■ complete: ${event.total} bytes, sha256 ${event.sha256.slice(0, 16)}… VERIFIED`, 'ok');
            break;
        }
      },
    })
      .then((outcome) => {
        if (!runGuardRef.current.isCurrent(myRun)) return; // user switched sessions: discard
        if ('paused' in outcome) {
          dlPrefixRef.current = outcome.saved;
          dlInfoRef.current = outcome.info;
          const note = pauseNoteRef.current ?? 'paused — Resume continues from the saved byte';
          pauseNoteRef.current = null;
          setDl((d) =>
            d && d.sessionId === info.id
              ? {...d, state: 'paused', saved: outcome.saved.length, note}
              : d,
          );
        } else {
          dlPrefixRef.current = outcome.bytes;
          dlBytesRef.current = outcome.bytes;
          dlInfoRef.current = outcome.info;
          persistObjectMeta(outcome.info);
          setDl((d) =>
            d && d.sessionId === info.id
              ? {
                  ...d,
                  state: 'verified',
                  saved: outcome.bytes.length,
                  note: 'SHA-256 verified over the complete downloaded file',
                }
              : d,
          );
        }
      })
      .catch((error: Error) => {
        if (!runGuardRef.current.isCurrent(myRun)) return;
        const code = (error as {code?: string}).code;
        setDl((d) =>
          d && d.sessionId === info.id
            ? {
                ...d,
                state: 'error',
                note: `${error.message}${code ? ` (${code})` : ''}`,
              }
            : d,
        );
      });
  }

  /** Resolve metadata for a session and present its object (no auto-start). */
  async function inspectObject(sessionId: string) {
    invalidateDownloadRuns();
    const meta = await fetchObjectInfo(fetch, '', sessionId);
    if (meta.kind === 'object') {
      showReady(meta.info);
    } else if (meta.kind === 'active') {
      dlInfoRef.current = null;
      dlBytesRef.current = null;
      setDl({
        sessionId,
        name: '',
        size: meta.offset,
        sha256: meta.sha256,
        state: 'not-completed',
        saved: 0,
        note: `session still active: prefix of ${meta.offset} bytes is changing, not a final object`,
      });
    } else {
      dlInfoRef.current = null;
      dlBytesRef.current = null;
      setDl({
        sessionId,
        name: '',
        size: 0,
        sha256: '',
        state: 'error',
        saved: 0,
        note: `no downloadable object: ${meta.code}`,
      });
    }
  }

  function beginDownload() {
    const info = dlInfoRef.current;
    if (!info || !dl || dl.state === 'downloading') return;
    launchDownload(info, new Uint8Array(0), false);
  }

  function pauseDownload() {
    pauseNoteRef.current = null;
    dlPauseRef.current?.abort();
  }

  function resumeDownload() {
    const info = dlInfoRef.current;
    if (!info || !dl || dl.state !== 'paused') return;
    launchDownload(info, dlPrefixRef.current, true);
  }

  // Stop uses the SAME cooperative-pause path: abort only the in-flight range
  // request and let the run settle with its confirmed prefix intact. It must
  // NOT invalidate the run generation, otherwise the settling `.then` would be
  // dropped and Resume could re-fetch already-confirmed bytes (a wasted, and
  // for Range clients potentially identity-breaking, re-download).
  function stopDownload() {
    pauseNoteRef.current = 'stopped — confirmed bytes kept, Resume to continue';
    dlPauseRef.current?.abort();
  }

  function discardLocalCopy() {
    invalidateDownloadRuns();
    dlPrefixRef.current = new Uint8Array(0);
    dlBytesRef.current = null;
    setDl((d) => (d ? {...d, state: 'ready', saved: 0, note: 'local copy discarded; server object untouched'} : d));
  }

  function saveVerifiedFile() {
    const bytes = dlBytesRef.current;
    if (!bytes || !dl) return;
    const blob = new Blob([new Uint8Array(bytes)], {type: 'application/octet-stream'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${dl.name || dl.sessionId}.bin`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Resumable Upload Workbench</strong>
        <small>offset CAS · session revision · per-block request ids · immutable object download</small>
      </header>

      <section className="workbench">
        <aside className="pane scenarios">
          <h2>Scenarios</h2>
          {SCENARIOS.map(({id, label, hint, Icon}) => (
            <button
              key={id}
              className={scenario === id ? 'active' : ''}
              disabled={running}
              onClick={() => setScenario(id)}
            >
              <Icon size={15} />
              <span>
                {label}
                <small>{hint}</small>
              </span>
            </button>
          ))}
          <div className="tuning">
            <label>
              Upload chunk
              <input
                type="number"
                min={1}
                value={chunkSize}
                onChange={(e) => setChunkSize(Math.max(1, Number(e.target.value) || 1))}
                disabled={running}
              />
            </label>
          </div>
        </aside>

        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={start} disabled={running}>
              <Play size={15} /> Run scenario
            </button>
            <button onClick={cancel} disabled={!running}>
              <Ban size={15} /> Abort client
            </button>
            <button
              onClick={completeCurrent}
              disabled={running || !result || result.state === 'completed'}
              title="Verify length + digest server-side and freeze the object"
            >
              <FileLock2 size={15} /> Complete &amp; freeze
            </button>
            <span className={`state ${running ? 'live' : ''}`}>{running ? 'running…' : 'idle'}</span>
          </div>

          <label className="field-label">Payload</label>
          <textarea
            aria-label="Payload"
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            readOnly={running}
            spellCheck={false}
          />

          <div className="blocks">
            <h3>Blocks (request id is stable across retries)</h3>
            {blocks.length === 0 && <p className="muted">Run a scenario to plan blocks.</p>}
            {blocks.map((block) => (
              <div key={block.index} className={`block ${block.status}`}>
                <span className="block-index">#{block.index}</span>
                <code className="block-req">{block.requestId}</code>
                <span className="block-range">
                  [{block.start}…{block.end}] {block.fullBytes.length}B
                  {block.duplicate ? ' ×2 concurrent' : ''}
                </span>
                <span className={`badge ${block.status}`}>{statusLabel(block.status)}</span>
                <span className="block-attempts">attempts {block.attempts}</span>
                {block.note && <small className="block-note">{block.note}</small>}
              </div>
            ))}
          </div>
        </section>

        <aside className="pane inspect">
          <h2>Protocol trace</h2>
          <div className="log">
            {logs.map((line) => (
              <div key={line.id} className={`log-line ${line.tone}`}>
                {line.text}
              </div>
            ))}
          </div>

          {result && (
            <div className={`verdict ${result.consistent ? 'good' : 'bad'}`}>
              {result.consistent ? <CheckCircle2 size={18} /> : <ShieldAlert size={18} />}
              <div>
                <strong>{result.consistent ? 'Unique durable prefix verified' : 'Inconsistent prefix!'}</strong>
                <small>
                  session {result.sessionId.slice(0, 10)}… · state {result.state}
                  <br />
                  offset {result.offset} · revision {result.revision}
                  <br />
                  server sha {result.sha256.slice(0, 20)}…
                  <br />
                  prefix sha {result.expectedSha.slice(0, 20)}…
                </small>
              </div>
            </div>
          )}

          <div className="download-card">
            <h3>Final object &amp; download</h3>

            <div className="dl-row">
              <select
                aria-label="Completed object"
                value={selectedObjectId}
                onChange={(e) => {
                  setSelectedObjectId(e.target.value);
                  if (e.target.value) void inspectObject(e.target.value);
                }}
              >
                <option value="">— pick a completed object —</option>
                {objectOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name || o.id} ({o.size}B)
                  </option>
                ))}
              </select>
              <button className="mini" onClick={refreshObjectList} title="Reload object list">
                <RefreshCw size={13} />
              </button>
            </div>

            {!dl && <p className="muted">Complete an upload, then freeze it — or pick a completed object. A page reload lists server objects but starts local bytes at 0.</p>}

            {dl && (
              <>
                <div className="dl-meta">
                  <div><strong>{dl.name || dl.sessionId}</strong></div>
                  <div className="muted">session {dl.sessionId}</div>
                  <div className="muted">size {dl.size} bytes</div>
                  <div className="muted hash">sha256 {dl.sha256}</div>
                </div>

                <div className="dl-progress" aria-label="download progress">
                  <div
                    className={`dl-progress-fill ${dl.state}`}
                    style={{width: `${dl.size ? Math.min(100, (dl.saved / dl.size) * 100) : 0}%`}}
                  />
                  <span className="dl-progress-label">
                    {dl.saved}/{dl.size} confirmed bytes
                  </span>
                </div>

                <div className="dl-controls">
                  <button className="mini" onClick={beginDownload} disabled={dl.state === 'downloading'}>
                    <DownloadIcon size={13} /> Download
                  </button>
                  <button className="mini" onClick={pauseDownload} disabled={dl.state !== 'downloading'}>
                    <Pause size={13} /> Pause
                  </button>
                  <button className="mini" onClick={resumeDownload} disabled={dl.state !== 'paused'}>
                    <Play size={13} /> Resume
                  </button>
                  <button className="mini" onClick={stopDownload} disabled={dl.state !== 'downloading'}>
                    <Ban size={13} /> Stop
                  </button>
                  <button className="mini" onClick={discardLocalCopy} disabled={dl.state === 'downloading'}>
                    <OctagonX size={13} /> Discard
                  </button>
                  <button
                    className="mini"
                    onClick={() => {
                      dropNextRef.current = true;
                    }}
                    disabled={dl.state !== 'downloading'}
                    title="Abort the next content request to simulate a connection drop"
                  >
                    <WifiOff size={13} /> Drop connection
                  </button>
                  <button className="mini primary" onClick={saveVerifiedFile} disabled={dl.state !== 'verified'}>
                    <Save size={13} /> Save .bin
                  </button>
                </div>

                <label className="dl-chunk">
                  Download chunk
                  <input
                    type="number"
                    min={1}
                    value={dlChunkSize}
                    onChange={(e) => setDlChunkSize(Math.max(1, Number(e.target.value) || 1))}
                    disabled={dl.state === 'downloading'}
                  />
                </label>

                <div className={`dl-verdict ${dl.state}`}>
                  {dl.state === 'verified' && <CheckCircle2 size={15} />}
                  {dl.state === 'error' && <ShieldAlert size={15} />}
                  {dl.state === 'downloading' && <RefreshCw size={13} className="spin" />}
                  {dl.state === 'paused' && <Pause size={15} />}
                  {dl.state === 'not-completed' && <Clock3 size={15} />}
                  {dl.state === 'ready' && <DownloadIcon size={15} />}
                  <span>{verdictText(dl.state, dl.note)}</span>
                </div>
              </>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}

function verdictText(state: DownloadState, note?: string): string {
  if (note) return note;
  switch (state) {
    case 'ready':
      return 'object resolved: identity, length and digest known locally saved bytes: 0';
    case 'downloading':
      return 'downloading with Range + If-Match…';
    case 'paused':
      return 'paused; confirmed bytes kept';
    case 'verified':
      return 'downloaded file digest matches the object';
    case 'error':
      return 'download stopped';
    case 'not-completed':
      return 'session is still active — not a final object';
  }
}

function statusLabel(status: UploadBlock['status']): string {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'sending':
      return 'sending';
    case 'acked':
      return 'acknowledged';
    case 'covered':
      return 'already covered';
    case 'failed':
      return 'failed';
    case 'expired':
      return 'session gone (410)';
    case 'cancelled':
      return 'cancelled';
  }
}
