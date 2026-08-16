import {useEffect, useState} from 'react';
import {register} from '../core/registry';
import {BUILTINS} from '../core/builtins';
import {useStudio, type Rail} from '../state/store';
import {Canvas} from './Canvas';
import {Palette} from './Palette';
import {Inspector} from './Inspector';
import {AiPanel} from './AiPanel';
import {CasesPanel, ExplainPanel, InboxPanel, PacksPanel, ReportPanel, SavedPanel} from './Panels';
import {ImportDialog} from './ImportDialog';
import {RailTabs} from './RailTabs';
import {GalleryPanel} from './GalleryPanel';

register(BUILTINS);

const RAIL_TITLE: Record<Rail, string> = {
  inspector: 'Step',
  ai: 'Build with AI',
  explain: 'Explain this journey',
  packs: 'Imported documents',
  report: 'QA report',
  saved: 'Saved journeys',
  data: 'Cases',
  inbox: 'Webhook inbox',
  gallery: 'Files',
};

function Logs() {
  const logs = useStudio((s) => s.logs);
  if (!logs.length) return null;
  return (
    <div className="logs">
      <h3>Logs</h3>
      <div className="lines">
        {logs.map((line, i) => (
          <div key={i} className={line.startsWith('✓') ? 'ok' : line.startsWith('✗') || line.startsWith('!') ? 'bad' : line.startsWith('⚠') ? 'warn' : undefined}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function Topbar({onImport}: {onImport: () => void}) {
  const config = useStudio((s) => s.config);
  const env = useStudio((s) => s.env);
  const setEnv = useStudio((s) => s.setEnv);
  const run = useStudio((s) => s.run);
  const stop = useStudio((s) => s.stop);
  const running = useStudio((s) => s.running);
  const hasNodes = useStudio((s) => s.journey.nodes.length > 0);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const undoLabel = useStudio((s) => s.undoLabel);
  const redoLabel = useStudio((s) => s.redoLabel);

  return (
    <header className="topbar">
      <span className="brand"><i />Journey Studio</span>

      <div className="envs" role="group" aria-label="Environment">
        {config.environments.map((e) => (
          <button
            key={e.name}
            className="env"
            aria-pressed={env === e.name}
            aria-label={`${e.name} — ${e.baseUrl}`}
            onClick={() => setEnv(e.name)}
            title={e.baseUrl}
          >
            {e.name}
          </button>
        ))}
        {config.environments.length === 0 && <span className="env">no environments</span>}
      </div>

      <div className="tools">
        <div className="undo">
          <button
            className="tool icon"
            onClick={undo}
            disabled={!undoLabel}
            title={undoLabel ? `Undo ${undoLabel}` : 'Nothing to undo'}
            aria-label={undoLabel ? `Undo ${undoLabel}` : 'Nothing to undo'}
          >
            ↶
          </button>
          <button
            className="tool icon"
            onClick={redo}
            disabled={!redoLabel}
            title={redoLabel ? `Redo ${redoLabel}` : 'Nothing to redo'}
            aria-label={redoLabel ? `Redo ${redoLabel}` : 'Nothing to redo'}
          >
            ↷
          </button>
        </div>
        <button className="tool" onClick={onImport}>Import</button>
        {running ? (
          <button className="tool stop" onClick={stop}>■ Stop</button>
        ) : (
          <button className="tool primary" disabled={!hasNodes} onClick={() => void run()}>▷ Run</button>
        )}
      </div>
    </header>
  );
}

export default function App() {
  const init = useStudio((s) => s.init);
  const rail = useStudio((s) => s.rail);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;

      // Inside a text field the browser's own undo is the right one — stealing
      // Cmd+Z there would wipe a half-typed URL instead of undoing a canvas edit.
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }

      e.preventDefault();
      const {undo, redo} = useStudio.getState();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <Topbar onImport={() => setImporting(true)} />
      <div className="workspace">
        <Palette onImport={() => setImporting(true)} />
        <div style={{position: 'relative', flex: 1, minWidth: 0, display: 'flex'}}>
          <Canvas />
          <Logs />
        </div>
        <aside className="rail">
          <div className="rail-main">
            <div className="rail-head"><b>{RAIL_TITLE[rail]}</b></div>
            {rail === 'inspector' && <Inspector />}
            {rail === 'ai' && <AiPanel />}
            {rail === 'explain' && <ExplainPanel />}
            {rail === 'packs' && <PacksPanel onImport={() => setImporting(true)} />}
            {rail === 'report' && <ReportPanel />}
            {rail === 'saved' && <SavedPanel />}
            {rail === 'data' && <CasesPanel />}
            {rail === 'inbox' && <InboxPanel />}
            {rail === 'gallery' && <GalleryPanel />}
          </div>
          <RailTabs />
        </aside>
      </div>
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}
