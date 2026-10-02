import {useRef, useState} from 'react';
import {
  Ban,
  CheckCircle2,
  Clock3,
  Download,
  FlaskConical,
  HardDriveDownload,
  Layers,
  OctagonX,
  Pause,
  Play,
  RadioTower,
  RefreshCw,
  Save,
  SearchCheck,
  ShieldAlert,
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
  fetchDownloadInfo,
  runDownload,
  type DownloadEvent,
  type DownloadProgress,
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

type LogLine = {id: number; text: string; tone: 'info' | 'ok' | 'warn' | 'bad'};

type InspectState = {
  id: string;
  name: string;
  state: string;
  offset: number;
  revision: number;
  sha256: string;
};

/**
 * Download panel state. `confirmed` counts ONLY bytes this browser has
 * actually received and kept — it is never derived from server-side offsets,
 * so a page refresh (which drops this in-memory state) cannot leave the UI
 * claiming a finished download it no longer has.
 */
type DownloadUi = {
  sessionId: string;
  phase: 'idle' | 'info' | 'downloading' | 'paused' | 'done' | 'failed';
  size: number;
  sha256: string;
  etag: string;
  confirmed: number;
  saved: DownloadProgress | null;
  reason?: string;
  finalSha?: string;
};

const emptyDownload = (sessionId: string): DownloadUi => ({
  sessionId,
  phase: 'idle',
  size: 0,
  sha256: '',
  etag: '',
  confirmed: 0,
  saved: null,
});

export default function App() {
  const [scenario, setScenario] = useState<Scenario>('normal');
  const [payloadText, setPayloadText] = useState(DEFAULT_PAYLOAD);
  const [chunkSize, setChunkSize] = useState(16);
  const [running, setRunning] = useState(false);
  const [blocks, setBlocks] = useState<UploadBlock[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [result, setResult] = useState<null | {
    offset: number;
    revision: number;
    sha256: string;
    expectedSha: string;
    consistent: boolean;
  }>(null);
  const [sessionInput, setSessionInput] = useState('');
  const [inspect, setInspect] = useState<InspectState | null>(null);
  const [dl, setDl] = useState<DownloadUi>(emptyDownload(''));
  const abortRef = useRef<AbortController | null>(null);
  /** Token of the download run that currently owns the panel. */
  const dlTokenRef = useRef(0);
  const dlAbortRef = useRef<AbortController | null>(null);
  const dlBytesRef = useRef<Uint8Array | null>(null);
  const logId = useRef(0);

  function log(text: string, tone: LogLine['tone'] = 'info') {
    logId.current += 1;
    setLogs((prev) => [...prev.slice(-120), {id: logId.current, text, tone}]);
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

  function renderDownloadEvent(event: DownloadEvent) {
    switch (event.type) {
      case 'info':
        setDl((prev) => ({...prev, size: event.size, sha256: event.sha256, etag: event.etag}));
        log(`⇓ HEAD 200 size=${event.size} etag=${event.etag.slice(1, 13)}… — object identity pinned`, 'info');
        break;
      case 'request':
        log(`→ GET download Range bytes=${event.offset}- + If-Range (attempt ${event.attempt})`, 'info');
        break;
      case 'progress':
        setDl((prev) => ({...prev, confirmed: event.confirmed, size: event.total}));
        break;
      case 'retry':
        log(`↻ ${event.reason} — resuming at confirmed bytes in ${event.delayMs}ms`, 'warn');
        break;
      case 'paused':
        log(`⏸ paused at ${event.confirmed}/${event.total}B — confirmed bytes kept locally`, 'warn');
        break;
      case 'verify':
        log(`⇓ assembled sha=${event.sha256.slice(0, 12)}… vs pinned ${event.expected.slice(0, 12)}…`, 'info');
        break;
      case 'done':
        log(`■ download complete & verified: ${event.size}B sha=${event.sha256.slice(0, 12)}…`, 'ok');
        break;
      case 'fatal':
        log(`✗ download stopped: ${event.reason}`, 'bad');
        break;
      case 'log':
        log(event.message, 'info');
        break;
    }
  }

  /** Invalidate any in-flight download run and drop its panel state. */
  function resetDownload() {
    dlTokenRef.current += 1;
    dlAbortRef.current?.abort();
    dlAbortRef.current = null;
    dlBytesRef.current = null;
  }

  async function inspectSession(id: string) {
    const trimmed = id.trim();
    if (!trimmed) return;
    resetDownload();
    setInspect(null);
    const res = await fetch(`/api/uploads/${trimmed}`).catch(() => null);
    if (!res || res.status === 410) {
      setDl({...emptyDownload(trimmed), phase: 'failed', reason: 'session_expired: unknown or aged out'});
      log(`⇓ ${trimmed}: 410 session_expired — nothing downloadable`, 'bad');
      return;
    }
    const body = (await res.json()) as InspectState;
    setInspect(body);
    if (body.state === 'completed') {
      const info = await fetchDownloadInfo({sessionId: trimmed}).catch(() => null);
      if (!info) {
        setDl({...emptyDownload(trimmed), phase: 'failed', reason: 'download info unavailable'});
        return;
      }
      if (info.kind === 'ready') {
        setDl({
          ...emptyDownload(trimmed),
          phase: 'info',
          size: info.size,
          sha256: info.sha256,
          etag: info.etag,
        });
        log(`⇓ ${trimmed} completed: size=${info.size}B sha=${info.sha256.slice(0, 12)}… — immutable, ready to download`, 'ok');
      } else if (info.kind === 'cancelled') {
        setDl({...emptyDownload(trimmed), phase: 'failed', reason: `session_cancelled: confirmed prefix ${info.offset}B is not downloadable`});
      } else if (info.kind === 'active') {
        setDl(emptyDownload(trimmed));
      } else {
        setDl({...emptyDownload(trimmed), phase: 'failed', reason: info.error});
      }
      return;
    }
    if (body.state === 'cancelled') {
      setDl({
        ...emptyDownload(trimmed),
        phase: 'failed',
        reason: `session_cancelled: confirmed prefix ${body.offset}B (sha ${body.sha256.slice(0, 12)}…) is not downloadable`,
      });
      log(`⇓ ${trimmed} cancelled — prefix ${body.offset}B was confirmed but is not downloadable`, 'bad');
      return;
    }
    // active: bytes still changing — not a final file yet.
    setDl(emptyDownload(trimmed));
    log(`⇓ ${trimmed} active at offset=${body.offset} rev=${body.revision} — complete it to publish the final file`, 'info');
  }

  async function completeSession() {
    if (!inspect) return;
    const res = await fetch(`/api/uploads/${inspect.id}/complete`, {method: 'POST'}).catch(() => null);
    if (!res || !res.ok) {
      log(`⇓ complete failed for ${inspect.id}`, 'bad');
      return;
    }
    log(`⇓ session ${inspect.id} completed — content is now immutable`, 'ok');
    await inspectSession(inspect.id);
  }

  async function startDownload(id: string, resumeFrom?: DownloadProgress) {
    // A new run takes over the panel: any stale run's late events/resolution
    // are dropped via the token check, so a previous session's response can
    // never be written into this session's result.
    const token = ++dlTokenRef.current;
    const abort = new AbortController();
    dlAbortRef.current = abort;
    setDl((prev) => ({...prev, phase: 'downloading', reason: undefined}));
    const result = await runDownload({
      sessionId: id,
      resumeFrom,
      signal: abort.signal,
      onEvent: (event) => {
        if (token !== dlTokenRef.current) return; // stale run (session switched)
        renderDownloadEvent(event);
      },
    });
    if (token !== dlTokenRef.current) return; // a newer run owns the panel now
    dlAbortRef.current = null;
    if (result.status === 'done') {
      dlBytesRef.current = result.bytes;
      setDl((prev) => ({
        ...prev,
        phase: 'done',
        confirmed: result.progress.confirmed,
        finalSha: result.sha256,
        saved: null,
      }));
    } else if (result.status === 'paused') {
      setDl((prev) => ({...prev, phase: 'paused', saved: result.progress, confirmed: result.progress.confirmed}));
    } else {
      setDl((prev) => ({
        ...prev,
        phase: 'failed',
        reason: result.reason,
        saved: result.progress,
        confirmed: result.progress?.confirmed ?? prev.confirmed,
      }));
    }
  }

  function pauseDownload() {
    // Aborting the in-flight request makes runDownload settle as 'paused'
    // with every confirmed byte retained for a later resume.
    dlAbortRef.current?.abort();
  }

  function saveFile() {
    const bytes = dlBytesRef.current;
    if (!bytes) return;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${inspect?.name ?? 'download'}.bin`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function start() {
    setRunning(true);
    setLogs([]);
    setResult(null);
    resetDownload();
    setInspect(null);
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
    setSessionInput(session.id);
    setDl(emptyDownload(session.id));
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
        });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      // Reflect the session's post-run state in the download panel (active ->
      // offer Complete; cancelled/expired -> show the terminal explanation).
      void inspectSession(session.id);
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  const dlPercent =
    dl.size > 0 ? Math.min(100, Math.round((dl.confirmed / dl.size) * 100)) : dl.phase === 'done' ? 100 : 0;

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Resumable Upload Workbench</strong>
        <small>offset CAS · session revision · per-block request ids · verified download</small>
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
              Chunk size
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
                  offset {result.offset} · revision {result.revision}
                  <br />
                  server sha {result.sha256.slice(0, 20)}…
                  <br />
                  prefix sha {result.expectedSha.slice(0, 20)}…
                </small>
              </div>
            </div>
          )}

          <div className="download">
            <h3>Completed file download</h3>
            <div className="download-load">
              <input
                aria-label="Session id"
                value={sessionInput}
                onChange={(e) => setSessionInput(e.target.value)}
                placeholder="session id"
                spellCheck={false}
              />
              <button onClick={() => void inspectSession(sessionInput)}>
                <SearchCheck size={14} /> Inspect
              </button>
            </div>

            {inspect && (
              <div className="download-meta">
                <span>
                  <code>{inspect.id}</code> · {inspect.name}
                </span>
                <span>
                  state <strong>{inspect.state}</strong> · offset {inspect.offset} · rev {inspect.revision}
                </span>
              </div>
            )}

            {inspect?.state === 'active' && (
              <div className="download-actions">
                <button className="primary" onClick={() => void completeSession()}>
                  <CheckCircle2 size={14} /> Complete session
                </button>
                <small className="muted">Prefix is still mutable — complete it to publish the final file.</small>
              </div>
            )}

            {dl.phase !== 'idle' && (
              <div className={`download-body ${dl.phase}`}>
                {dl.etag !== '' && (
                  <div className="download-meta">
                    <span>size {dl.size}B</span>
                    <span>
                      sha256 <code>{dl.sha256.slice(0, 20)}…</code>
                    </span>
                    <span>
                      etag <code>{dl.etag.slice(0, 22)}…</code>
                    </span>
                  </div>
                )}

                <div className="progress" aria-label="Download progress">
                  <div className="progress-fill" style={{width: `${dlPercent}%`}} />
                </div>
                <div className="download-status">
                  confirmed {dl.confirmed} / {dl.etag === '' ? '?' : dl.size} B locally
                  {dl.phase === 'done' ? ' · verified ✓' : dl.phase === 'downloading' ? ` · ${dlPercent}%` : ''}
                </div>

                <div className="download-actions">
                  {dl.phase === 'info' && (
                    <button className="primary" onClick={() => void startDownload(dl.sessionId)}>
                      <Download size={14} /> Download
                    </button>
                  )}
                  {dl.phase === 'downloading' && (
                    <button onClick={pauseDownload}>
                      <Pause size={14} /> Pause
                    </button>
                  )}
                  {(dl.phase === 'paused' || (dl.phase === 'failed' && dl.saved)) && (
                    <button className="primary" onClick={() => void startDownload(dl.sessionId, dl.saved ?? undefined)}>
                      <Play size={14} /> Resume at {dl.saved?.confirmed ?? 0}B
                    </button>
                  )}
                  {dl.phase === 'failed' && !dl.saved && dl.etag !== '' && (
                    <button onClick={() => void startDownload(dl.sessionId)}>
                      <RefreshCw size={14} /> Retry from 0B
                    </button>
                  )}
                  {dl.phase === 'done' && (
                    <button onClick={saveFile}>
                      <Save size={14} /> Save file
                    </button>
                  )}
                </div>

                {dl.reason && <p className="download-reason">{dl.reason}</p>}

                {dl.phase === 'done' && dl.finalSha && (
                  <div className="verdict good">
                    <CheckCircle2 size={18} />
                    <div>
                      <strong>Download verified against pinned identity</strong>
                      <small>
                        sha256 {dl.finalSha.slice(0, 24)}…
                        <br />
                        {dl.confirmed}B confirmed & hashed locally
                      </small>
                    </div>
                  </div>
                )}
              </div>
            )}
            <p className="muted download-note">
              Progress lives in browser memory only: a page refresh restarts from 0 bytes — the server
              offset is never treated as local download progress.
            </p>
          </div>
        </aside>
      </section>
    </main>
  );
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
