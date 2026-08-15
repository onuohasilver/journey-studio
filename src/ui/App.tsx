import {useEffect, useState} from 'react';
import {register} from '../core/registry';
import {BUILTINS} from '../core/builtins';
import {useStudio, type Rail} from '../state/store';
import {Canvas} from './Canvas';
import {Palette} from './Palette';
import {Inspector} from './Inspector';
import {AiPanel} from './AiPanel';
import {ExplainPanel, PacksPanel} from './Panels';
import {ImportDialog} from './ImportDialog';

register(BUILTINS);

const RAIL_TITLE: Record<Rail, string> = {
  inspector: 'Step',
  ai: '✳ Build with AI',
  explain: '▤ Explain',
  packs: 'Imported documents',
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
  const rail = useStudio((s) => s.rail);
  const setRail = useStudio((s) => s.setRail);
  const run = useStudio((s) => s.run);
  const stop = useStudio((s) => s.stop);
  const running = useStudio((s) => s.running);
  const hasNodes = useStudio((s) => s.journey.nodes.length > 0);

  const toggle = (target: Rail) => setRail(rail === target ? 'inspector' : target);

  return (
    <header className="topbar">
      <span className="brand"><i />Journey Studio</span>

      <div className="envs" role="group" aria-label="Environment">
        {config.environments.map((e) => (
          <button key={e.name} className="env" aria-pressed={env === e.name} onClick={() => setEnv(e.name)} title={e.baseUrl}>
            {e.name}
          </button>
        ))}
        {config.environments.length === 0 && <span className="env">no environments</span>}
      </div>

      <div className="tools">
        <button className="tool" onClick={onImport}>Import</button>
        <button className="tool" aria-pressed={rail === 'packs'} onClick={() => toggle('packs')}>Documents</button>
        <button className="tool" aria-pressed={rail === 'ai'} onClick={() => toggle('ai')}>Build with AI</button>
        <button className="tool" aria-pressed={rail === 'explain'} onClick={() => toggle('explain')}>Explain</button>
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
          <div className="rail-head"><b>{RAIL_TITLE[rail]}</b></div>
          {rail === 'inspector' && <Inspector />}
          {rail === 'ai' && <AiPanel />}
          {rail === 'explain' && <ExplainPanel />}
          {rail === 'packs' && <PacksPanel onImport={() => setImporting(true)} />}
        </aside>
      </div>
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}
