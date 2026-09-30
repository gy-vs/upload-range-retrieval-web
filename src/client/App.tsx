import {useRef, useState} from 'react';
import {
  Ban,
  CheckCircle2,
  Clock3,
  FlaskConical,
  HardDriveDownload,
  Layers,
  OctagonX,
  Play,
  RadioTower,
  RefreshCw,
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
  const abortRef = useRef<AbortController | null>(null);
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

  async function start() {
    setRunning(true);
    setLogs([]);
    setResult(null);
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
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Resumable Upload Workbench</strong>
        <small>offset CAS · session revision · per-block request ids</small>
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
