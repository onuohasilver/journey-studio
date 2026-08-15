import {useRef, useState} from 'react';
import {detectFormat} from '../core/import';
import {useStudio} from '../state/store';
import type {ImportResult} from '../core/types';

const FORMAT_LABEL: Record<string, string> = {
  openapi: 'OpenAPI document',
  postman: 'Postman collection',
  unknown: 'unrecognised',
};

export function ImportDialog({onClose}: {onClose: () => void}) {
  const importText = useStudio((s) => s.importText);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [over, setOver] = useState(false);
  const [pasted, setPasted] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const ingest = (text: string, filename?: string) => {
    const outcome = importText(text, filename);
    setResult(outcome);
  };

  const readFile = async (file: File) => ingest(await file.text(), file.name);

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Import a document" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Import nodes</h2>
          <p>
            Drop an OpenAPI 3 document (JSON or YAML) or a Postman v2 collection. The format is detected
            from the file, so you don't have to say which it is.
          </p>
        </header>

        <div className="content">
          <div
            className={`drop ${over ? 'over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const file = e.dataTransfer.files[0];
              if (file) void readFile(file);
            }}
          >
            Drop a file here, or{' '}
            <button className="btn" style={{fontSize: 12}} onClick={() => fileInput.current?.click()}>
              choose one
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,.yaml,.yml,application/json,text/yaml"
              style={{display: 'none'}}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void readFile(file);
              }}
            />
          </div>

          <div className="field">
            <label htmlFor="paste">…or paste it</label>
            <textarea
              id="paste"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="openapi: 3.0.0 …"
            />
            {pasted.trim() && (
              <span className="help">Looks like a {FORMAT_LABEL[detectFormat(pasted)]}.</span>
            )}
            <button className="btn" disabled={!pasted.trim()} onClick={() => ingest(pasted)}>
              Import pasted text
            </button>
          </div>

          {result && !result.ok && <div className="note bad">{result.error}</div>}

          {result?.ok && (
            <>
              <div className="note info">
                Imported <strong>{result.title}</strong> — {result.nodes.length} nodes from a{' '}
                {FORMAT_LABEL[result.format ?? 'unknown']}.
                {result.servers[0] ? ` Server: ${result.servers[0]}` : ''}
              </div>
              {result.servers.length > 0 && (
                <p className="help">
                  Point an environment at that base URL in <code>journey.config.json</code> so requests
                  go somewhere real.
                </p>
              )}
              {result.warnings.map((w, i) => (
                <div key={i} className="note warn">{w}</div>
              ))}
            </>
          )}
        </div>

        <footer>
          <button className="btn" onClick={onClose}>{result?.ok ? 'Done' : 'Cancel'}</button>
        </footer>
      </div>
    </div>
  );
}
