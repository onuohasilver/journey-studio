import {useEffect, useState} from 'react';
import {lookup} from '../core/registry';
import {checkJourney} from '../core/graph';
import {useStudio} from '../state/store';
import type {Field} from '../core/types';

/** A json field edits as text so a half-typed object doesn't throw on each key. */
function JsonField({value, onChange}: {value: unknown; onChange: (v: unknown) => void}) {
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(value === undefined ? '' : JSON.stringify(value, null, 2));
  }, [value]);

  return (
    <>
      <textarea
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) {
            setError(null);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value));
            setError(null);
          } catch {
            // Keep the text; only commit when it parses. Templates like
            // {{vars.x}} are legitimately unparseable until they resolve.
            setError('Not valid JSON yet');
          }
        }}
      />
      {error && <span className="help" style={{color: 'var(--warn)'}}>{error}</span>}
    </>
  );
}

function FieldInput({field, value, onChange}: {field: Field; value: unknown; onChange: (v: unknown) => void}) {
  if (field.kind === 'json') return <JsonField value={value} onChange={onChange} />;
  if (field.kind === 'boolean') {
    return (
      <select value={String(Boolean(value))} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (field.kind === 'select') {
    return (
      <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {field.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type={field.kind === 'number' ? 'number' : 'text'}
      value={value === undefined || value === null ? '' : String(value)}
      placeholder={field.placeholder}
      onChange={(e) => onChange(field.kind === 'number' ? Number(e.target.value) : e.target.value)}
    />
  );
}

export function Inspector() {
  const journey = useStudio((s) => s.journey);
  const selectedId = useStudio((s) => s.selectedId);
  const states = useStudio((s) => s.states);
  const updateConfig = useStudio((s) => s.updateConfig);
  const renameNode = useStudio((s) => s.renameNode);
  const deleteNode = useStudio((s) => s.deleteNode);
  const run = useStudio((s) => s.run);
  const running = useStudio((s) => s.running);
  const setTeardown = useStudio((s) => s.setTeardown);
  const setBudget = useStudio((s) => s.setBudget);

  const node = journey.nodes.find((n) => n.id === selectedId);
  const problems = checkJourney(journey, lookup);

  if (!node) {
    return (
      <div className="rail-body">
        <p className="help">Select a step to edit it.</p>
        {problems.length > 0 && (
          <>
            <span className="caps">Before you run</span>
            {problems.map((p, i) => (
              <div key={i} className="note warn">
                {journey.nodes.find((n) => n.id === p.nodeId)?.label ?? p.nodeId}: {p.message}
              </div>
            ))}
          </>
        )}
      </div>
    );
  }

  const def = lookup(node.type);
  const state = states[node.id];
  const nodeProblems = problems.filter((p) => p.nodeId === node.id);

  return (
    <div className="rail-body">
      <div className="field">
        <label htmlFor="node-label">Name</label>
        <input id="node-label" value={node.label ?? ''} onChange={(e) => renameNode(node.id, e.target.value)} />
        <span className="help">
          {def?.request ? `${def.request.method} ${def.request.path}` : `control · ${def?.control}`}
        </span>
      </div>

      {def?.notes && <div className="note warn">{def.notes}</div>}
      {nodeProblems.map((p, i) => (
        <div key={i} className="note warn">{p.message}</div>
      ))}

      {(def?.needs.length || def?.gives.length) && (
        <div className="note info">
          {def.needs.length > 0 && (
            <div>
              <strong>Needs</strong> {def.needs.join(', ')}
            </div>
          )}
          {def.gives.length > 0 && (
            <div style={{marginTop: def.needs.length ? 6 : 0}}>
              <strong>Gives</strong> {def.gives.map((g) => `${g.key} ← ${g.from}`).join(', ')}
            </div>
          )}
        </div>
      )}

      {def?.fields.map((field) => (
        <div className="field" key={field.key}>
          <label>{field.label}{field.required ? ' *' : ''}</label>
          <FieldInput
            field={field}
            value={node.config[field.key]}
            onChange={(v) => updateConfig(node.id, {[field.key]: v})}
          />
          {field.help && <span className="help">{field.help}</span>}
        </div>
      ))}

      <span className="caps">When it runs, and how fast</span>

      <label className="check">
        <input
          type="checkbox"
          checked={Boolean(node.teardown)}
          onChange={(e) => setTeardown(node.id, e.target.checked)}
        />
        <span>
          Clean-up step
          <span className="help">
            Runs after the journey, whether it passed or failed — the failed run is the one that left
            records behind. A clean-up that fails is reported, not counted against the journey.
          </span>
        </span>
      </label>

      <div className="field">
        <label htmlFor="node-budget">Time budget (ms)</label>
        <input
          id="node-budget"
          type="number"
          min={0}
          placeholder="no budget"
          value={node.budgetMs ?? ''}
          onChange={(e) => setBudget(node.id, e.target.value === '' ? undefined : Number(e.target.value))}
        />
        <span className="help">
          Judged at p95 across every run and case, so one cold start does not turn the suite red. Reported
          unless the run is strict.
        </span>
      </div>

      <div className="btn-row">
        <button className="btn go" disabled={running} onClick={() => run(node.id)}>
          Run from here
        </button>
        <button className="btn danger" onClick={() => deleteNode(node.id)}>
          Delete
        </button>
      </div>

      {state?.error && <div className="note bad">{state.error}</div>}

      {state?.response && (
        <>
          <span className="caps">Response · {state.response.status} · {state.response.durationMs}ms</span>
          <pre
            style={{
              margin: 0, background: 'var(--surface-0)', border: '1px solid var(--line)',
              borderRadius: 8, padding: 10, fontSize: 11, lineHeight: 1.5, overflowX: 'auto',
              maxHeight: 260, fontFamily: 'var(--mono)',
            }}
          >
            {JSON.stringify(state.response.body, null, 2)}
          </pre>
        </>
      )}
    </div>
  );
}
