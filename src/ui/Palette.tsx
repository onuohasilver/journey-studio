import {useMemo, useState, useSyncExternalStore} from 'react';
import {allDefs, subscribe} from '../core/registry';
import {useStudio} from '../state/store';
import type {NodeDef} from '../core/types';

/** Re-render whenever a document is imported or removed. */
function useRegistry(): NodeDef[] {
  return useSyncExternalStore(subscribe, allDefs, allDefs);
}

export function Palette({onImport}: {onImport: () => void}) {
  const defs = useRegistry();
  const addNode = useStudio((s) => s.addNode);
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? defs.filter((d) =>
          [d.label, d.type, d.summary ?? '', d.request?.path ?? ''].join(' ').toLowerCase().includes(needle),
        )
      : defs;

    const map = new Map<string, NodeDef[]>();
    for (const def of matched) {
      const group = def.group ?? 'Other';
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(def);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [defs, query]);

  return (
    <aside className="palette">
      <header>
        <div className="palette-label">
          <span>Nodes</span>
          <span>{defs.length}</span>
        </div>
        <input
          className="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search nodes or paths…"
          aria-label="Search nodes"
        />
      </header>

      <div className="palette-scroll">
        {groups.length === 0 && (
          <p className="empty-note">
            {defs.length === 0 ? (
              <>
                No nodes loaded yet.{' '}
                <button className="btn" style={{marginTop: 8}} onClick={onImport}>
                  Import a document
                </button>
              </>
            ) : (
              'Nothing matches that search.'
            )}
          </p>
        )}

        {groups.map(([group, list]) => (
          <section key={group}>
            <div className="group-head">
              <span>{group}</span>
              <span>{list.length}</span>
            </div>
            {list.map((def) => (
              <button
                key={def.type}
                className="node-row"
                onClick={() => addNode(def.type)}
                title={def.summary ?? def.type}
              >
                <span className="nm">{def.label}</span>
                <span className="sub">
                  {def.request ? `${def.request.method} ${def.request.path}` : `control · ${def.control}`}
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}
