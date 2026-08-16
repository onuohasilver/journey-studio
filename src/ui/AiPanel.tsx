// ---- Build with AI ----
//
// The first message builds; every message after it *edits*. That distinction is
// the whole point: "use the other endpoint instead" should change one step and
// leave the rest — their positions, their settings, and the responses they
// already fetched — exactly where they were.

import {useEffect, useState} from 'react';
import {aiStatus, type AiStatus, type Reproduction} from '../core/ai/client';
import {useStudio} from '../state/store';
import type {AiTurn} from '../state/store';

const BUILD_EXAMPLES = [
  'Create a user, read it back, then delete it',
  'Sign in and list the first page of orders',
  'Create a pet, upload its photo, then check it appears in the list',
];

const EDIT_EXAMPLES = [
  'Add a check after the last step',
  'Use the other endpoint instead',
  'Drop the delete at the end',
  'Fix the step that failed',
];

function Turn({turn, onSelect}: {turn: AiTurn; onSelect: (id: string) => void}) {
  return (
    <div className="turn">
      <p className="said">{turn.instruction}</p>
      <p className="summary">{turn.summary}</p>

      {turn.kind === 'revise' &&
        (turn.changes.length ? (
          turn.changes.map((change, i) => (
            <button
              key={i}
              className={`change ${change.kind}`}
              title={change.why}
              disabled={!change.nodeId}
              onClick={() => change.nodeId && onSelect(change.nodeId)}
            >
              <b>{change.kind === 'insert' ? '+' : change.kind === 'remove' ? '−' : change.kind === 'replace' ? '⇄' : '✎'}</b>
              <span>{change.text}</span>
            </button>
          ))
        ) : (
          <p className="help">Nothing on the canvas needed changing.</p>
        ))}

      {turn.caveats.map((c, i) => (
        <div key={i} className="note warn">{c}</div>
      ))}
      {turn.unsupported.length > 0 && (
        <>
          <span className="caps">Not covered by any node</span>
          {turn.unsupported.map((u, i) => (
            <p key={i} className="help">{u}</p>
          ))}
        </>
      )}
      {turn.problems.length > 0 && (
        <>
          <span className="caps">Adjusted against the loaded nodes</span>
          {turn.problems.map((p, i) => (
            <p key={i} className="help">{p}</p>
          ))}
        </>
      )}
    </div>
  );
}

export function AiPanel() {
  const env = useStudio((s) => s.env);
  const journey = useStudio((s) => s.journey);
  const turns = useStudio((s) => s.aiTurns);
  const running = useStudio((s) => s.running);
  const plan = useStudio((s) => s.plan);
  const revise = useStudio((s) => s.revise);
  const select = useStudio((s) => s.select);
  const stop = useStudio((s) => s.stop);
  const resetConversation = useStudio((s) => s.resetConversation);

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [startingOver, setStartingOver] = useState(false);
  const [bugReport, setBugReport] = useState('');
  const [reproducing, setReproducing] = useState(false);
  const [reproduction, setReproduction] = useState<(Reproduction & {error?: string}) | undefined>();
  const reproduce = useStudio((s) => s.reproduce);

  useEffect(() => {
    void aiStatus().then(setStatus);
  }, []);

  const hasCanvas = journey.nodes.length > 0;
  const editing = hasCanvas && !startingOver;

  const submit = async (thenRun: boolean) => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) await revise(text, thenRun);
      else {
        resetConversation();
        await plan(text, thenRun);
        setStartingOver(false);
      }
      setInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'that failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rail-body">
      <div className="field">
        <textarea
          value={input}
          rows={3}
          onChange={(e) => setInput(e.target.value)}
          placeholder={editing ? 'What should change?' : 'Describe the journey in plain English…'}
          aria-label={editing ? 'Describe the change' : 'Describe the journey'}
        />
      </div>

      {!input && (
        <div className="btn-row">
          {(editing ? EDIT_EXAMPLES : BUILD_EXAMPLES).map((e) => (
            <button key={e} className="btn" style={{fontWeight: 400, fontSize: 11}} onClick={() => setInput(e)}>
              {e}
            </button>
          ))}
        </div>
      )}

      <div className="btn-row">
        {running ? (
          <button className="btn danger" onClick={stop}>Stop</button>
        ) : (
          <>
            <button className="btn go" disabled={!input.trim() || busy || !status?.configured} onClick={() => void submit(true)}>
              {busy ? 'Working…' : `${editing ? 'Update' : 'Build'} & run on ${env || 'default'}`}
            </button>
            <button className="btn" disabled={!input.trim() || busy || !status?.configured} onClick={() => void submit(false)}>
              {editing ? 'Update' : 'Build'} only
            </button>
          </>
        )}
      </div>

      <span className="caps">From a bug report</span>
      <div className="field">
        <textarea
          value={bugReport}
          rows={4}
          onChange={(e) => setBugReport(e.target.value)}
          placeholder={'Paste a ticket or a Slack message…\n\n"Refunds over £500 return 200 but the balance never moves. Seen on staging by two customers this morning."'}
          aria-label="Paste a bug report"
        />
        <span className="help">
          A report is mostly not reproduction steps. This pulls out the calls it implies, and lists
          separately what it had to assume — a reproduction that quietly invents the input reproduces
          something else.
        </span>
      </div>
      <button
        className="btn"
        disabled={!bugReport.trim() || reproducing || !status?.configured}
        onClick={async () => {
          setReproducing(true);
          setReproduction(await reproduce(bugReport));
          setReproducing(false);
        }}
      >
        {reproducing ? 'Reading the report…' : '✳ Build a reproduction'}
      </button>

      {reproduction?.error && <div className="note bad">{reproduction.error}</div>}
      {reproduction && !reproduction.error && (
        <>
          <div className="note info">{reproduction.summary}</div>
          {reproduction.expected && (
            <p className="help">
              <strong>Should happen once fixed:</strong> {reproduction.expected}
            </p>
          )}
          {reproduction.assumptions.length > 0 && (
            <>
              <span className="caps">Assumed, because the report did not say</span>
              {reproduction.assumptions.map((a, i) => (
                <div key={i} className="note warn">{a}</div>
              ))}
            </>
          )}
          {reproduction.missing?.length ? (
            <>
              <span className="caps">Ask the reporter</span>
              {reproduction.missing.map((m, i) => (
                <div key={i} className="note">{m}</div>
              ))}
            </>
          ) : null}
        </>
      )}

      {/* Editing is the default once anything is on the canvas; a rebuild has to
          be asked for, because it discards every id, position and result. */}
      {hasCanvas &&
        (editing ? (
          <p className="help">
            Editing the {journey.nodes.length} step{journey.nodes.length === 1 ? '' : 's'} on the canvas — untouched
            steps keep their results.{' '}
            <button className="change" style={{display: 'inline', width: 'auto', padding: 0, textDecoration: 'underline'}} onClick={() => setStartingOver(true)}>
              Start a new journey
            </button>
          </p>
        ) : (
          <div className="note warn">
            This replaces everything on the canvas.{' '}
            <button className="change" style={{display: 'inline', width: 'auto', padding: 0, textDecoration: 'underline'}} onClick={() => setStartingOver(false)}>
              Edit it instead
            </button>
          </div>
        ))}

      {status && !status.configured && <div className="note warn">{status.hint}</div>}
      {error && <div className="note bad">{error}</div>}

      {turns.map((turn) => (
        <Turn key={turn.id} turn={turn} onSelect={select} />
      ))}
    </div>
  );
}
