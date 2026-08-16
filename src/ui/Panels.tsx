import {useState} from 'react';
import {topoOrder} from '../core/graph';
import {summariseContract} from '../core/contract';
import {summariseShape} from '../core/snapshot';
import {summariseDrift} from '../core/report';
import {describeTrend} from '../core/history';
import {casesFromCsv, casesToCsv} from '../core/csv';
import {useStudio} from '../state/store';

/** Plain-English account of what the journey on the canvas actually does. */
export function ExplainPanel() {
  const explanation = useStudio((s) => s.explanation);
  const explaining = useStudio((s) => s.explaining);
  const journey = useStudio((s) => s.journey);
  const explain = useStudio((s) => s.explain);
  const select = useStudio((s) => s.select);

  if (explaining) return <div className="rail-body"><p className="help">Reading the journey…</p></div>;

  if (!explanation) {
    return (
      <div className="rail-body">
        <p className="help">
          Get a plain-English account of what this journey does, what it creates, and what to watch out
          for — useful before running something against a shared environment.
        </p>
        <button className="btn go" disabled={!journey.nodes.length} onClick={() => void explain()}>
          Explain this journey
        </button>
      </div>
    );
  }

  const ordered = topoOrder(journey.nodes, journey.edges);
  const labelFor = (ref: string) => ordered.find((n) => n.id === ref)?.label ?? ref;

  return (
    <div className="rail-body">
      <p style={{margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.35}}>{explanation.headline}</p>
      <p style={{margin: 0, fontSize: 12.5, lineHeight: 1.6, color: 'var(--muted)'}}>{explanation.summary}</p>

      <span className="caps">Step by step</span>
      {explanation.steps.map((step) => (
        <button key={step.ref} className="step" onClick={() => select(step.ref)}>
          <span className="ic" />
          <span className="tx">
            {step.what}
            <span className="ty">{labelFor(step.ref)}</span>
          </span>
        </button>
      ))}

      {explanation.watchOuts?.length ? (
        <>
          <span className="caps">Watch out for</span>
          {explanation.watchOuts.map((w, i) => (
            <div key={i} className="note warn">{w}</div>
          ))}
        </>
      ) : null}

      <button className="btn" onClick={() => void explain()}>Explain again</button>
    </div>
  );
}

/** Loaded documents, and the nodes each one contributed. */
export function PacksPanel({onImport}: {onImport: () => void}) {
  const packs = useStudio((s) => s.packs);
  const removeImported = useStudio((s) => s.removeImported);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="rail-body">
      <button className="btn go" onClick={onImport}>Import a document</button>

      {packs.length === 0 && (
        <p className="help">
          Nothing imported yet. Drop in an OpenAPI document or a Postman collection and every operation
          becomes a node you can drag onto the canvas.
        </p>
      )}

      {packs.map((pack) => (
        <div className="pack" key={pack.slug}>
          <div className="nm">{pack.title}</div>
          <div className="sub">
            {pack.format} · {pack.types.length} nodes
            {pack.servers[0] ? ` · ${pack.servers[0]}` : ''}
          </div>
          {pack.warnings.length > 0 && (
            <button
              className="btn"
              style={{marginTop: 8, fontSize: 11}}
              onClick={() => setOpen(open === pack.slug ? null : pack.slug)}
            >
              {pack.warnings.length} warning{pack.warnings.length === 1 ? '' : 's'}
            </button>
          )}
          {open === pack.slug &&
            pack.warnings.map((w, i) => (
              <div key={i} className="note warn" style={{marginTop: 6}}>{w}</div>
            ))}
          <button className="btn danger" style={{marginTop: 8, fontSize: 11}} onClick={() => removeImported(pack.slug)}>
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Deliveries the inbox has seen, and the saved payloads that stand in for them.
 *
 * The panel exists mostly to answer one question fast — "did it actually call
 * us?" — because the alternative is reading someone else's delivery logs.
 */
export function InboxPanel() {
  const hooks = useStudio((s) => s.hooks);
  const inboxUrl = useStudio((s) => s.inboxUrl);
  const mocks = useStudio((s) => s.mocks);
  const useMocks = useStudio((s) => s.useMocks);
  const setUseMocks = useStudio((s) => s.setUseMocks);
  const refreshInbox = useStudio((s) => s.refreshInbox);
  const clearInbox = useStudio((s) => s.clearInbox);
  const saveMockFrom = useStudio((s) => s.saveMockFrom);
  const fireMock = useStudio((s) => s.fireMock);
  const deleteMock = useStudio((s) => s.deleteMock);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="rail-body">
      <div className="field">
        <label>Point the provider here</label>
        <input readOnly value={`${inboxUrl}<path>`} onFocus={(e) => e.currentTarget.select()} />
        <span className="help">
          Anything sent here is recorded and answered 200. It has to be reachable from wherever the
          provider runs, so locally that means a tunnel.
        </span>
      </div>

      <label className="check">
        <input type="checkbox" checked={useMocks} onChange={(e) => setUseMocks(e.target.checked)} />
        <span>
          Deliver from mocks instead of waiting
          <span className="help">
            Off, a waiting step blocks until the real callback arrives and fails honestly if it does not.
            Mocks are never a fallback — a run that quietly accepts a canned payload passes while the
            integration is broken. Mocked steps are marked as such in the report.
          </span>
        </span>
      </label>

      <span className="caps">Received {hooks.length ? `· ${hooks.length}` : ''}</span>
      {hooks.length === 0 && <p className="help">Nothing yet.</p>}
      {hooks.map((hook) => (
        <div className="pack" key={hook.id}>
          <div className="nm">
            {hook.method} /{hook.path || '(root)'}
            {hook.claimedBy ? <span className="ty"> · claimed by {hook.claimedBy}</span> : null}
          </div>
          <div className="sub">{hook.at.slice(11, 19)}</div>
          <div className="btn-row" style={{marginTop: 8}}>
            <button
              className="btn"
              style={{fontSize: 11}}
              onClick={() => setOpen(open === hook.id ? null : hook.id)}
            >
              {open === hook.id ? 'Hide' : 'Payload'}
            </button>
            <button
              className="btn"
              style={{fontSize: 11}}
              onClick={() => {
                const name = window.prompt('Save this delivery as a mock called…', hook.path || 'webhook');
                if (name) void saveMockFrom(hook, name);
              }}
            >
              Save as mock
            </button>
          </div>
          {open === hook.id && (
            <pre
              style={{
                margin: '8px 0 0', background: 'var(--surface-0)', border: '1px solid var(--line)',
                borderRadius: 8, padding: 10, fontSize: 11, overflowX: 'auto', maxHeight: 220,
                fontFamily: 'var(--mono)',
              }}
            >
              {JSON.stringify(hook.body, null, 2)}
            </pre>
          )}
        </div>
      ))}

      <span className="caps">Mocks</span>
      {mocks.length === 0 && (
        <p className="help">
          Save a delivery you received and it becomes replayable — which is the only way a journey that
          waits for a webhook can run in CI, where no provider is going to call a build agent.
        </p>
      )}
      {mocks.map((mock) => (
        <div className="pack" key={mock.name}>
          <div className="nm">{mock.name}</div>
          <div className="sub">{mock.method ?? 'POST'} /{mock.path || '(root)'}</div>
          <div className="btn-row" style={{marginTop: 8}}>
            <button className="btn go" style={{fontSize: 11}} onClick={() => void fireMock(mock.name)}>
              Fire now
            </button>
            <button className="btn danger" style={{fontSize: 11}} onClick={() => void deleteMock(mock.name)}>
              Delete
            </button>
          </div>
        </div>
      ))}

      <div className="btn-row">
        <button className="btn" onClick={() => void refreshInbox()}>Refresh</button>
        <button className="btn danger" disabled={!hooks.length} onClick={() => void clearInbox()}>
          Clear inbox
        </button>
      </div>
    </div>
  );
}

/** The QA report for the last run — the thing you take away, export, or post. */
export function ReportPanel() {
  const report = useStudio((s) => s.report);
  const slackConfigured = useStudio((s) => s.slackConfigured);
  const sendReportToSlack = useStudio((s) => s.sendReportToSlack);
  const select = useStudio((s) => s.select);
  const recordSnapshot = useStudio((s) => s.recordSnapshot);
  const recordedAt = useStudio((s) => s.recordedAt);
  const trends = useStudio((s) => s.trends);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ok: boolean; error?: string} | null>(null);
  const [recorded, setRecorded] = useState<{ok: boolean; error?: string; nodes?: number} | null>(null);
  const [shown, setShown] = useState<number | null>(null);

  if (!report) {
    return (
      <div className="rail-body">
        <p className="help">Run the journey and the report lands here — per-step timings, the request
        behind any failure, what the run created, and anywhere the API stopped matching its own spec.</p>
      </div>
    );
  }

  const download = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qa-report-${report.startedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // With cases the panel opens on the row somebody needs to look at.
  const cased = report.journeys.length > 1 || Boolean(report.journeys[0]?.case);
  const failedFirst = report.journeys.findIndex((j) => j.status === 'failed');
  // A later run with fewer cases must not leave the panel pointing past the end.
  const picked = shown !== null && shown < report.journeys.length ? shown : Math.max(failedFirst, 0);
  const journey = report.journeys[picked];
  const drift = summariseDrift(report.totals);

  return (
    <div className="rail-body">
      <div className={`note ${report.status === 'passed' ? 'info' : 'bad'}`}>
        <strong>{report.status === 'passed' ? 'Passed' : 'Failed'}</strong> ·{' '}
        {cased ? `${report.totals.passed}/${report.totals.journeys} cases · ` : ''}
        {report.totals.steps} steps · {(report.durationMs / 1000).toFixed(1)}s · {report.env}
      </div>

      {drift && (
        <div className="note warn">
          {drift}. Assertions still pass, so nothing failed — but a consumer may already be broken.
        </div>
      )}

      {cased && (
        <>
          <span className="caps">Cases</span>
          {report.journeys.map((j, i) => (
            <button
              key={`${j.name}-${j.case ?? i}`}
              className={`step ${j.status}`}
              aria-pressed={j === journey}
              onClick={() => setShown(i)}
            >
              <span className="ic" />
              <span className="tx">
                {j.case ?? j.name}
                <span className="ty">
                  {j.steps.filter((s) => s.status === 'passed').length}/{j.steps.length} steps ·{' '}
                  {(j.durationMs / 1000).toFixed(1)}s
                </span>
              </span>
            </button>
          ))}
        </>
      )}

      {trends.length > 0 && (
        <>
          <span className="caps">Over the last {trends[0].results.length} runs</span>
          {trends.map((trend) => (
            <div className="trend" key={trend.id}>
              <span className="nm">{trend.label}</span>
              <span className="ticks" aria-label={describeTrend(trend)}>
                {trend.results.map((r, i) => (
                  <i key={i} className={r ?? 'none'} title={r ?? 'did not run'} />
                ))}
              </span>
              {trend.failingSince && (
                <span className="since">failing since {trend.failingSince.slice(0, 16).replace('T', ' ')}</span>
              )}
            </div>
          ))}
        </>
      )}

      <span className="caps">{journey?.case ? `Steps · ${journey.case}` : 'Steps'}</span>
      {journey?.steps.map((step) => (
        <button key={step.id} className={`step ${step.status}`} onClick={() => select(step.id)}>
          <span className="ic" />
          <span className="tx">
            {step.label}
            <span className="ty">
              {step.httpStatus ? `${step.httpStatus} · ` : ''}
              {step.durationMs ?? 0}ms
              {step.contract.length ? ` · ${summariseContract(step.contract)}` : ''}
              {step.shapeChanges.length ? ` · ${summariseShape(step.shapeChanges)}` : ''}
            </span>
            {step.error && <span className="ty" style={{color: 'var(--danger)'}}>{step.error}</span>}
          </span>
        </button>
      ))}

      {journey?.contractBreaks ? (
        <>
          <span className="caps">Against the spec</span>
          {journey.steps.flatMap((s) => s.contract).map((finding, i) => (
            <div key={i} className={`note ${finding.severity === 'error' ? 'warn' : 'info'}`}>
              {finding.message}
            </div>
          ))}
        </>
      ) : null}

      {journey?.steps.some((s) => s.shapeChanges.length) ? (
        <>
          <span className="caps">Since it was recorded</span>
          {journey.steps.flatMap((s) => s.shapeChanges).map((change, i) => (
            <div key={i} className={`note ${change.severity === 'error' ? 'warn' : 'info'}`}>
              {change.message}
            </div>
          ))}
        </>
      ) : null}

      {journey?.created.length ? (
        <>
          <span className="caps">Created on {report.env}</span>
          <div className="note info">
            {journey.created.map((c) => `${c.key}=${c.value}`).join(', ')}
          </div>
        </>
      ) : null}

      <div className="btn-row">
        <button
          className="btn"
          title={
            recordedAt
              ? `Replace the shapes recorded ${recordedAt.slice(0, 10)}`
              : 'Record what these responses look like, and compare every later run against it'
          }
          onClick={async () => setRecorded(await recordSnapshot())}
        >
          {recordedAt ? 'Re-record shapes' : 'Record shapes'}
        </button>
        <button className="btn" onClick={download}>Download JSON</button>
        <button
          className="btn go"
          disabled={!slackConfigured || sending}
          title={slackConfigured ? 'Post this report to Slack' : 'No Slack webhook configured'}
          onClick={async () => {
            setSending(true);
            setSent(await sendReportToSlack());
            setSending(false);
          }}
        >
          {sending ? 'Posting…' : 'Send to Slack'}
        </button>
      </div>
      {!slackConfigured && (
        <p className="help">
          Set <code>SLACK_WEBHOOK_URL</code> in <code>.env.local</code>, or <code>slack.webhookUrl</code> in
          your config, to enable posting.
        </p>
      )}
      {sent && <div className={`note ${sent.ok ? 'info' : 'bad'}`}>{sent.ok ? 'Posted to Slack.' : sent.error}</div>}
      {recorded && (
        <div className={`note ${recorded.ok ? 'info' : 'bad'}`}>
          {recorded.ok
            ? `Recorded ${recorded.nodes} response shapes. Later runs are compared against them.`
            : recorded.error}
        </div>
      )}
    </div>
  );
}

/**
 * The table of inputs the journey runs against — the difference between one test
 * and twenty. Editing is a CSV textarea on purpose: the rows almost always exist
 * in a spreadsheet already, and a bespoke grid you have to retype into is how a
 * data-driven suite ends up with three cases in it.
 */
export function CasesPanel() {
  const journey = useStudio((s) => s.journey);
  const setCases = useStudio((s) => s.setCases);
  const cases = journey.cases ?? [];

  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? (cases.length ? casesToCsv(cases) : '');
  const parsed = casesFromCsv(text);

  return (
    <div className="rail-body">
      {cases.length === 0 && (
        <p className="help">
          Run this journey once per row. The first row names the variables, and each row after it seeds a
          run — so <code>{'{{vars.country}}'}</code> in a step picks up that row's value.
        </p>
      )}

      <div className="field">
        <label htmlFor="cases-csv">Cases</label>
        <textarea
          id="cases-csv"
          rows={10}
          spellCheck={false}
          value={text}
          placeholder={'name,country,amount\nnigeria,NG,1000\nghana,GH,250'}
          onChange={(e) => setDraft(e.target.value)}
          style={{fontFamily: 'var(--mono)', fontSize: 11.5}}
        />
        <span className="help">Paste straight from a spreadsheet. A <code>name</code> column names the row.</span>
      </div>

      {parsed.warnings.map((w, i) => (
        <div key={i} className="note warn">{w}</div>
      ))}

      {parsed.cases.length > 0 && (
        <div className="note info">
          {parsed.cases.length} case{parsed.cases.length === 1 ? '' : 's'} ·{' '}
          {parsed.columns.join(', ') || 'no variables'}
        </div>
      )}

      <div className="btn-row">
        <button
          className="btn go"
          disabled={draft === null}
          onClick={() => {
            setCases(parsed.cases);
            setDraft(null);
          }}
        >
          Use these cases
        </button>
        {cases.length > 0 && (
          <button
            className="btn danger"
            onClick={() => {
              setCases(undefined);
              setDraft('');
            }}
          >
            Clear
          </button>
        )}
      </div>

      {cases.length > 0 && (
        <p className="help">
          A failing case does not stop the others — every row runs, and the report lists them all. The canvas
          shows the first row that failed.
        </p>
      )}
    </div>
  );
}

/** Journeys saved to disk — the suite the CLI runs in CI. */
export function SavedPanel() {
  const saved = useStudio((s) => s.saved);
  const journey = useStudio((s) => s.journey);
  const saveJourney = useStudio((s) => s.saveJourney);
  const openJourney = useStudio((s) => s.openJourney);
  const deleteSaved = useStudio((s) => s.deleteSaved);
  const setTags = useStudio((s) => s.setTags);
  const [name, setName] = useState(journey.name);
  const [note, setNote] = useState<string | null>(null);

  return (
    <div className="rail-body">
      <div className="field">
        <label htmlFor="journey-name">Save this journey as</label>
        <input id="journey-name" value={name} onChange={(e) => setName(e.target.value)} />
        <span className="help">
          Written to <code>journeys/</code> with the definitions it uses embedded, so it runs in CI with
          no document to import.
        </span>
      </div>
      <div className="field">
        <label htmlFor="journey-tags">Tags</label>
        <input
          id="journey-tags"
          value={(journey.tags ?? []).join(', ')}
          placeholder="smoke, payments"
          onChange={(e) => setTags(e.target.value.split(',').map((t) => t.trim()).filter(Boolean))}
        />
        <span className="help">
          Run a subset with <code>--tag smoke</code>. Needed the moment a suite passes ten journeys —
          running everything on every pull request is how a suite becomes something people skip.
        </span>
      </div>

      <button
        className="btn go"
        disabled={!name.trim() || !journey.nodes.length}
        onClick={async () => {
          try {
            await saveJourney(name.trim());
            setNote(`Saved "${name.trim()}".`);
          } catch (err) {
            setNote(err instanceof Error ? err.message : 'could not save');
          }
        }}
      >
        Save
      </button>
      {note && <div className="note info">{note}</div>}

      <span className="caps">On disk</span>
      {saved.length === 0 && <p className="help">Nothing saved yet.</p>}
      {saved.map((item) => (
        <div className="pack" key={item.file}>
          <div className="nm">{item.name}</div>
          <div className="sub">
            {item.steps} steps
            {item.tags?.length ? ` · ${item.tags.join(', ')}` : ''}
            {item.cases ? ` · ${item.cases} cases` : ''}
            {item.snapshot ? ' · shapes recorded' : ''}
            {item.savedAt ? ` · ${item.savedAt.slice(0, 10)}` : ''}
          </div>
          <div className="btn-row" style={{marginTop: 8}}>
            <button
              className="btn"
              style={{fontSize: 11}}
              onClick={async () => {
                const missing = await openJourney(item.file);
                setNote(missing.length ? `Opened, but ${missing.length} step type(s) are unknown.` : `Opened "${item.name}".`);
                setName(item.name);
              }}
            >
              Open
            </button>
            <button className="btn danger" style={{fontSize: 11}} onClick={() => void deleteSaved(item.file)}>
              Delete
            </button>
          </div>
        </div>
      ))}

      <span className="caps">In CI</span>
      <pre style={{margin: 0, background: 'var(--surface-0)', border: '1px solid var(--line)', borderRadius: 8, padding: 10, fontSize: 11, fontFamily: 'var(--mono)', overflowX: 'auto'}}>
{`npx journey run --env ${useStudio.getState().env || 'staging'} \\
  --report qa.json --slack`}
      </pre>
    </div>
  );
}
