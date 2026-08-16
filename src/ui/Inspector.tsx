import {useEffect, useState} from 'react';
import {lookup} from '../core/registry';
import {checkJourney} from '../core/graph';
import {useStudio} from '../state/store';
import {shapeOf} from '../core/snapshot';
import type {AssertionSuggestions} from '../core/ai/client';
import type {Assertion, AssertOp, Field} from '../core/types';

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

const OPS: {value: AssertOp; label: string; needsValue: boolean; needsPath: boolean}[] = [
  {value: 'status', label: 'status is', needsValue: true, needsPath: false},
  {value: 'eq', label: 'equals', needsValue: true, needsPath: true},
  {value: 'neq', label: 'does not equal', needsValue: true, needsPath: true},
  {value: 'exists', label: 'is present', needsValue: false, needsPath: true},
  {value: 'absent', label: 'is absent', needsValue: false, needsPath: true},
  {value: 'contains', label: 'contains', needsValue: true, needsPath: true},
  {value: 'matches', label: 'matches regex', needsValue: true, needsPath: true},
  {value: 'gt', label: 'is greater than', needsValue: true, needsPath: true},
  {value: 'lt', label: 'is less than', needsValue: true, needsPath: true},
];

/**
 * Assertions as rows rather than raw JSON.
 *
 * The paths offered come from the response this step actually returned, which is
 * the difference between writing a check and guessing at one — nobody remembers
 * whether it is `data.id` or `data.attributes.id` without looking.
 */
function AssertionRows({
  value,
  onChange,
  paths,
  addLabel,
}: {
  value: Assertion[] | undefined;
  onChange: (next: Assertion[] | undefined) => void;
  paths: string[];
  addLabel: string;
}) {
  const rows = value ?? [];
  const listId = `paths-${addLabel.replace(/\W+/g, '')}`;

  const update = (i: number, patch: Partial<Assertion>) => {
    const next = rows.map((row, at) => (at === i ? {...row, ...patch} : row));
    onChange(next);
  };

  return (
    <>
      <datalist id={listId}>
        {paths.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>

      {rows.map((row, i) => {
        const op = OPS.find((o) => o.value === row.op) ?? OPS[1];
        return (
          <div className="assert-row" key={i}>
            {op.needsPath ? (
              <input
                aria-label="Path"
                list={listId}
                placeholder="body.status"
                value={row.path ?? ''}
                onChange={(e) => update(i, {path: e.target.value})}
              />
            ) : (
              <span className="assert-fixed">response</span>
            )}
            <select aria-label="Check" value={row.op} onChange={(e) => update(i, {op: e.target.value as AssertOp})}>
              {OPS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {op.needsValue && (
              <input
                aria-label="Expected"
                placeholder={row.op === 'status' ? '200' : 'settled'}
                value={row.expected === undefined ? '' : String(row.expected)}
                onChange={(e) => {
                  // Numbers stay numbers, so `status is 200` and `gt 100` compare
                  // the way anybody typing them expects.
                  const raw = e.target.value;
                  const asNumber = Number(raw);
                  update(i, {
                    expected: raw !== '' && String(asNumber) === raw.trim() ? asNumber : raw,
                  });
                }}
              />
            )}
            <button
              className="btn danger"
              aria-label="Remove check"
              onClick={() => onChange(rows.filter((_, at) => at !== i).length ? rows.filter((_, at) => at !== i) : undefined)}
            >
              ×
            </button>
          </div>
        );
      })}

      <button
        className="btn"
        onClick={() => onChange([...rows, rows.length ? {path: '', op: 'eq', expected: ''} : {op: 'status', expected: 200}])}
      >
        {addLabel}
      </button>
    </>
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
  const setAssertions = useStudio((s) => s.setAssertions);
  const setUntil = useStudio((s) => s.setUntil);
  const setPoll = useStudio((s) => s.setPoll);
  const suggestAssertions = useStudio((s) => s.suggestAssertions);
  const [suggesting, setSuggesting] = useState(false);
  const [suggested, setSuggested] = useState<(AssertionSuggestions & {error?: string}) | null>(null);

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

  // Offered as path suggestions. Reusing the snapshot shape means the list is
  // every path the response actually had, arrays collapsed, already flattened.
  const paths = state?.response
    ? ['status', ...Object.keys(shapeOf(state.response.body)).map((p) => `body.${p}`)]
    : ['status', 'body.id', 'body.status'];

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

      {def && Boolean(def.needs.length || def.gives.length) && (
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

      {def?.request && (
        <>
          <span className="caps">Checks</span>
          {def.assertions?.length ? (
            <div className="note info">
              From the spec: {def.assertions.map((a) => `${a.path ?? 'status'} ${a.op}`).join(', ')}
            </div>
          ) : null}
          <AssertionRows
            value={node.assertions}
            onChange={(next) => setAssertions(node.id, next)}
            paths={paths}
            addLabel="Add a check"
          />

          {state?.response && (
            <>
              <button
                className="btn"
                disabled={suggesting}
                title="Propose checks from the response this step returned"
                onClick={async () => {
                  setSuggesting(true);
                  setSuggested(await suggestAssertions(node.id));
                  setSuggesting(false);
                }}
              >
                {suggesting ? 'Reading the response…' : '✳ Suggest checks from the response'}
              </button>
              <span className="help">
                Sends this step's response body to the model. Bodies routinely hold tokens and personal
                data, so this only happens when you ask.
              </span>
            </>
          )}

          {suggested?.error && <div className="note bad">{suggested.error}</div>}
          {suggested?.assertions.map((s, i) => (
            <button
              key={i}
              className="step"
              title="Add this check"
              onClick={() =>
                setAssertions(node.id, [
                  ...(node.assertions ?? []),
                  {path: s.path, op: s.op as AssertOp, ...(s.expected === undefined ? {} : {expected: s.expected})},
                ])
              }
            >
              <span className="ic" />
              <span className="tx">
                {s.path} {OPS.find((o) => o.value === s.op)?.label ?? s.op}
                {s.expected === undefined ? '' : ` ${JSON.stringify(s.expected)}`}
                <span className="ty">{s.why}</span>
              </span>
            </button>
          ))}
          {suggested?.skipped?.length ? (
            <div className="note info">
              <strong>Left alone</strong> {suggested.skipped.join('; ')}
            </div>
          ) : null}

          <span className="caps">Keep trying until</span>
          <AssertionRows
            value={node.until}
            onChange={(next) => setUntil(node.id, next)}
            paths={paths}
            addLabel="Wait for a condition"
          />
          <span className="help">
            Re-sends until these hold, instead of sleeping and hoping. A fixed wait is the single
            largest source of flaky API tests — and slower than it needs to be on a good day.
          </span>
          {node.until?.length ? (
            <div className="assert-row">
              <input
                aria-label="Every ms"
                type="number"
                placeholder="every 1000ms"
                value={node.pollEveryMs ?? ''}
                onChange={(e) => setPoll(node.id, {pollEveryMs: e.target.value === '' ? undefined : Number(e.target.value)})}
              />
              <input
                aria-label="Give up after ms"
                type="number"
                placeholder="give up 30000ms"
                value={node.pollTimeoutMs ?? ''}
                onChange={(e) => setPoll(node.id, {pollTimeoutMs: e.target.value === '' ? undefined : Number(e.target.value)})}
              />
            </div>
          ) : null}
        </>
      )}

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
