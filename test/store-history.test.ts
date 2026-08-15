import {beforeEach, describe, expect, it} from 'vitest';
import {resetStudio, useStudio} from '../src/state/store';
import {lookup, register, resetRegistry} from '../src/core/registry';
import {applyOps} from '../src/core/ai/apply';
import type {NodeDef} from '../src/core/types';

const DEFS: NodeDef[] = [
  {
    type: 'demo.create',
    label: 'Create thing',
    fields: [{key: 'name', label: 'Name', kind: 'text'}],
    defaults: {name: ''},
    request: {method: 'POST', path: '/things'},
    needs: [],
    gives: [{key: 'thingId', from: 'body.id'}],
  },
  {
    type: 'demo.read',
    label: 'Read thing',
    fields: [],
    request: {method: 'GET', path: '/things/{{vars.thingId}}'},
    needs: ['thingId'],
    gives: [],
  },
];

const s = () => useStudio.getState();

beforeEach(() => {
  resetRegistry();
  register(DEFS);
  resetStudio();
});

describe('undo and redo through the store', () => {
  it('takes back an added step and puts it back', () => {
    s().addNode('demo.create');
    expect(s().journey.nodes).toHaveLength(1);
    expect(s().undoLabel).toBe('add Create thing');

    s().undo();
    expect(s().journey.nodes).toHaveLength(0);
    expect(s().redoLabel).toBe('add Create thing');

    s().redo();
    expect(s().journey.nodes).toHaveLength(1);
  });

  it('restores a deleted step with its wiring intact', () => {
    s().addNode('demo.create');
    s().addNode('demo.read');
    const [a, b] = s().journey.nodes.map((n) => n.id);
    s().connect(a, b);

    s().deleteNode(b);
    expect(s().journey.nodes).toHaveLength(1);
    expect(s().journey.edges).toHaveLength(0);

    s().undo();
    expect(s().journey.nodes.map((n) => n.id)).toEqual([a, b]);
    expect(s().journey.edges).toHaveLength(1);
  });

  it('treats a burst of typing as one step', () => {
    // Otherwise undo walks back one character at a time.
    s().addNode('demo.create');
    const id = s().journey.nodes[0].id;

    for (const name of ['w', 'wi', 'wid', 'widg', 'widge', 'widget']) {
      s().updateConfig(id, {name});
    }
    expect(s().journey.nodes[0].config.name).toBe('widget');

    s().undo();
    expect(s().journey.nodes[0].config.name).toBe('');
  });

  it('keeps edits to different fields separate', () => {
    s().addNode('demo.create');
    const id = s().journey.nodes[0].id;
    s().updateConfig(id, {name: 'widget'});
    s().renameNode(id, 'Make a widget');

    s().undo();
    expect(s().journey.nodes[0].label).toBe('Create thing');
    expect(s().journey.nodes[0].config.name).toBe('widget');   // the earlier edit survives
  });

  it('does not throw away run results', () => {
    // Undo puts the canvas back; it must not discard responses you already paid
    // for. Results are keyed by node id, so a restored step brings its own back.
    s().addNode('demo.create');
    const id = s().journey.nodes[0].id;
    const response = {status: 201, headers: {}, body: {id: 't_1'}, durationMs: 5};
    useStudio.setState({states: {[id]: {status: 'passed', response}}});

    s().deleteNode(id);
    s().undo();

    expect(s().journey.nodes[0].id).toBe(id);
    expect(s().states[id].response).toEqual(response);
  });

  it('drops the redo branch once you change something else', () => {
    s().addNode('demo.create');
    s().undo();
    expect(s().redoLabel).toBe('add Create thing');

    s().addNode('demo.read');
    expect(s().redoLabel).toBeUndefined();
  });

  it('clears a selection pointing at a step that no longer exists', () => {
    s().addNode('demo.create');
    const id = s().journey.nodes[0].id;
    expect(s().selectedId).toBe(id);

    s().undo();   // the selected node is gone
    expect(s().selectedId).toBeNull();
  });

  it('does nothing at either end instead of throwing', () => {
    expect(() => s().undo()).not.toThrow();
    expect(() => s().redo()).not.toThrow();
    expect(s().journey.nodes).toHaveLength(0);
  });

  it('undoes a whole AI edit as one step', () => {
    // The case undo exists for: one message can rewrite several steps at once.
    s().addNode('demo.create');
    const before = s().journey;

    // Same code path revise() uses to apply a validated edit.
    const edited = applyOps(
      before,
      [
        {op: 'insert', after: 'end', type: 'demo.read', config: {}, why: 'read it back'},
        {op: 'configure', ref: before.nodes[0].id, config: {name: 'changed'}, why: 'rename'},
      ],
      lookup,
    );
    s().setJourney(edited.journey);

    expect(s().journey.nodes).toHaveLength(2);
    s().undo();
    expect(s().journey.nodes).toHaveLength(1);
    expect(s().journey.nodes[0].config.name).toBe('');
  });
});
