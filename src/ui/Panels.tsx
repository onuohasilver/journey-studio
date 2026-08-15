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
