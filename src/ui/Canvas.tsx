import {useCallback, useMemo} from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {lookup} from '../core/registry';
import {useStudio} from '../state/store';
import type {NodeState} from '../core/types';

interface CardData extends Record<string, unknown> {
  label: string;
  call: string;
  status: NodeState['status'];
  method?: string;
  control?: boolean;
  teardown?: boolean;
  budgetMs?: number;
}

/** The method tile is the fastest read on a canvas: colour tells you the verb. */
function tileClass(method?: string, control?: boolean): string {
  if (control) return 'tile ctl';
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') return 'tile post';
  if (method === 'DELETE') return 'tile del';
  return 'tile get';
}

function JourneyCard({data, selected}: NodeProps) {
  const d = data as CardData;
  const status = d.status ?? 'idle';
  return (
    <div className={`jnode ${status} ${selected ? 'selected' : ''} ${d.teardown ? 'teardown' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <span className={tileClass(d.method, d.control)}>{d.control ? '◆' : (d.method ?? 'GET').slice(0, 3)}</span>
      <span className="body">
        <span className="nm">{d.label}</span>
        <span className="sub">
          {d.teardown ? 'clean-up · ' : ''}
          {d.call}
          {d.budgetMs ? ` · ≤${d.budgetMs}ms` : ''}
        </span>
      </span>
      <span className="dot" />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function Flow() {
  const journey = useStudio((s) => s.journey);
  const states = useStudio((s) => s.states);
  const selectedId = useStudio((s) => s.selectedId);
  const select = useStudio((s) => s.select);
  const connect = useStudio((s) => s.connect);
  const moveNode = useStudio((s) => s.moveNode);
  const deleteNode = useStudio((s) => s.deleteNode);

  const nodeTypes = useMemo(() => ({journey: JourneyCard}), []);

  const nodes: Node[] = useMemo(
    () =>
      journey.nodes.map((n) => {
        const def = lookup(n.type);
        return {
          id: n.id,
          type: 'journey',
          position: n.position,
          selected: n.id === selectedId,
          data: {
            label: n.label ?? def?.label ?? n.type,
            call: def?.request ? `${def.request.method} ${def.request.path}` : `control · ${def?.control ?? '?'}`,
            method: def?.request?.method,
            control: Boolean(def?.control),
            status: states[n.id]?.status ?? 'idle',
            teardown: n.teardown,
            budgetMs: n.budgetMs,
          } satisfies CardData,
        };
      }),
    [journey.nodes, states, selectedId],
  );

  const edges: Edge[] = useMemo(
    () =>
      journey.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        className: states[e.source]?.status === 'passed' ? 'passed' : undefined,
      })),
    [journey.edges, states],
  );

  const onConnect = useCallback((c: Connection) => {
    if (c.source && c.target) connect(c.source, c.target);
  }, [connect]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onConnect={onConnect}
      onNodeClick={(_, node) => select(node.id)}
      onNodeDragStop={(_, node) => moveNode(node.id, node.position)}
      onNodesDelete={(deleted) => deleted.forEach((n) => deleteNode(n.id))}
      onPaneClick={() => select(null)}
      panOnScroll
      zoomOnScroll={false}
      zoomOnPinch
      deleteKeyCode={['Backspace', 'Delete']}
      fitView
      minZoom={0.25}
      maxZoom={1.6}
      proOptions={{hideAttribution: true}}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="var(--canvas-dot)" />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}

export function Canvas() {
  const empty = useStudio((s) => s.journey.nodes.length === 0);
  return (
    <div className="canvas-wrap">
      <ReactFlowProvider>
        <Flow />
      </ReactFlowProvider>
      {empty && (
        <div className="canvas-empty">
          <div>
            <b>Nothing on the canvas yet</b>
            Import an OpenAPI document or a Postman collection to get nodes, then drag them in from the
            left — or describe what you want in <strong>Build with AI</strong> and let it assemble the journey.
          </div>
        </div>
      )}
    </div>
  );
}
