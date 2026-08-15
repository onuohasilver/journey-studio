import {useState} from 'react';
import {topoOrder} from '../core/graph';
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

/** The QA report for the last run — the thing you take away, export, or post. */
export function ReportPanel() {
  const report = useStudio((s) => s.report);
  const slackConfigured = useStudio((s) => s.slackConfigured);
  const sendReportToSlack = useStudio((s) => s.sendReportToSlack);
  const select = useStudio((s) => s.select);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ok: boolean; error?: string} | null>(null);

  if (!report) {
    return (
      <div className="rail-body">
        <p className="help">Run the journey and the report lands here — per-step timings, the request
        behind any failure, what the run created, and anywhere the API stopped matching its own spec.</p>
      </div>
    );
  }

  const journey = report.journeys[0];
  const download = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qa-report-${report.startedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rail-body">
      <div className={`note ${report.status === 'passed' ? 'info' : 'bad'}`}>
        <strong>{report.status === 'passed' ? 'Passed' : 'Failed'}</strong> · {report.totals.steps} steps ·{' '}
        {(report.durationMs / 1000).toFixed(1)}s · {report.env}
      </div>

      {report.totals.contractBreaks > 0 && (
        <div className="note warn">
          {report.totals.contractBreaks} response{report.totals.contractBreaks === 1 ? '' : 's'} no longer
          match the spec. Assertions still pass, so nothing failed — but a consumer may already be broken.
        </div>
      )}

      <span className="caps">Steps</span>
      {journey?.steps.map((step) => (
        <button key={step.id} className={`step ${step.status}`} onClick={() => select(step.id)}>
          <span className="ic" />
          <span className="tx">
            {step.label}
            <span className="ty">
              {step.httpStatus ? `${step.httpStatus} · ` : ''}
              {step.durationMs ?? 0}ms
              {step.contract.length ? ` · ${step.contract.length} contract finding(s)` : ''}
            </span>
            {step.error && <span className="ty" style={{color: 'var(--danger)'}}>{step.error}</span>}
          </span>
        </button>
      ))}

      {journey?.contractBreaks ? (
        <>
          <span className="caps">Contract</span>
          {journey.steps.flatMap((s) => s.contract).map((finding, i) => (
            <div key={i} className={`note ${finding.severity === 'error' ? 'warn' : 'info'}`}>
              {finding.message}
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
            {item.steps} steps{item.savedAt ? ` · ${item.savedAt.slice(0, 10)}` : ''}
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
