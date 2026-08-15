import {describe, expect, it, vi} from 'vitest';
import {runJourney, type Transport} from '../src/core/engine';
import {checkJourney, downstreamOf, findCycles, topoOrder} from '../src/core/graph';
import type {HttpResponse, Journey, NodeDef, ResolvedRequest} from '../src/core/types';

// ---- a tiny two-node API, defined the way a real pack would define it -------

const DEFS: Record<string, NodeDef> = {
  'demo.createUser': {
    type: 'demo.createUser',
    label: 'Create user',
    fields: [{key: 'email', label: 'Email', kind: 'text'}],
    defaults: {email: 'a@example.com'},
    request: {method: 'POST', path: '/users', body: {email: '{{fields.email}}'}},
    needs: [],
    gives: [{key: 'userId', from: 'body.id'}],
    assertions: [{op: 'status', expected: 201}],
  },
  'demo.getUser': {
    type: 'demo.getUser',
    label: 'Get user',
    fields: [],
    request: {method: 'GET', path: '/users/{{vars.userId}}'},
    needs: ['userId'],
    gives: [{key: 'userEmail', from: 'body.email'}],
    assertions: [{op: 'status', expected: 200}],
  },
  'control.set': {
    type: 'control.set',
    label: 'Set values',
    fields: [],
    control: 'set',
    needs: [],
    gives: [],
  },
};

const lookup = (type: string) => DEFS[type];

function journey(): Journey {
  return {
    name: 'demo',
    nodes: [
      {id: 'n1', type: 'demo.createUser', config: {}, position: {x: 0, y: 0}},
      {id: 'n2', type: 'demo.getUser', config: {}, position: {x: 250, y: 0}},
    ],
    edges: [{id: 'e1', source: 'n1', target: 'n2'}],
  };
}

/** Records what was sent and answers from a script. */
function stubTransport(script: Record<string, Partial<HttpResponse>>) {
  const sent: ResolvedRequest[] = [];
  const transport: Transport = {
    async send(request) {
      sent.push(request);
      const key = `${request.method} ${request.url.split('?')[0]}`;
      const canned = script[key];
      if (!canned) throw new Error(`no stub for ${key}`);
      return {status: 200, headers: {}, body: {}, durationMs: 1, ...canned};
    },
  };
  return {transport, sent};
}

const OK = {
  'POST /users': {status: 201, body: {id: 'u_1'}},
  'GET /users/u_1': {status: 200, body: {id: 'u_1', email: 'a@example.com'}},
};

describe('running a journey', () => {
  it('threads a value from one step into the next', async () => {
    // The whole premise: step 2's URL is built from what step 1 returned.
    const {transport, sent} = stubTransport(OK);
    const result = await runJourney(journey(), {env: 'test', lookup, transport});

    expect(result.passed).toBe(true);
    expect(sent.map((r) => r.url)).toEqual(['/users', '/users/u_1']);
    expect(result.context.vars).toEqual({userId: 'u_1', userEmail: 'a@example.com'});
  });

  it('folds node config into the request before templating', async () => {
    const {transport, sent} = stubTransport(OK);
    const j = journey();
    j.nodes[0].config = {email: 'typed@example.com'};
    await runJourney(j, {env: 'test', lookup, transport});

    expect(sent[0].body).toEqual({email: 'typed@example.com'});
  });

  it('resolves a config value that is itself a template', async () => {
    // This is how every imported document chains: a path parameter defaults to
    // `{{vars.petId}}`, so resolving only the request would send the literal
    // placeholder in the URL.
    const defs: Record<string, NodeDef> = {
      'demo.byId': {
        type: 'demo.byId',
        label: 'By id',
        fields: [{key: 'petId', label: 'petId', kind: 'text'}],
        defaults: {petId: '{{vars.petId}}'},
        request: {method: 'GET', path: '/pets/{{fields.petId}}'},
        needs: ['petId'],
        gives: [],
      },
      'control.set': {type: 'control.set', label: 'Set', fields: [], control: 'set', needs: [], gives: []},
    };
    const {transport, sent} = stubTransport({'GET /pets/7': {status: 200, body: {id: 7}}});
    const j: Journey = {
      name: 'chain',
      nodes: [
        {id: 's1', type: 'control.set', config: {values: {petId: 7}}, position: {x: 0, y: 0}},
        {id: 's2', type: 'demo.byId', config: {}, position: {x: 250, y: 0}},
      ],
      edges: [{id: 'e1', source: 's1', target: 's2'}],
    };
    const result = await runJourney(j, {env: 'test', lookup: (t) => defs[t], transport});

    expect(sent[0].url).toBe('/pets/7');
    expect(result.passed).toBe(true);
  });

  it('stops at the first failed assertion instead of running on', async () => {
    // Continuing past a failure produces a cascade of errors that all look real.
    const {transport, sent} = stubTransport({...OK, 'POST /users': {status: 500, body: {}}});
    const result = await runJourney(journey(), {env: 'test', lookup, transport});

    expect(result.passed).toBe(false);
    expect(sent).toHaveLength(1);
    expect(result.states.n1.status).toBe('failed');
    expect(result.states.n1.error).toContain('status');
    expect(result.states.n2).toBeUndefined();
  });

  it('keeps the request that failed, exactly as it was sent', async () => {
    const {transport} = stubTransport({...OK, 'POST /users': {status: 500, body: {}}});
    const result = await runJourney(journey(), {env: 'test', lookup, transport});

    expect(result.states.n1.sent).toMatchObject({method: 'POST', url: '/users'});
  });

  it('warns when a declared output is not in the response', async () => {
    const lines: string[] = [];
    const {transport} = stubTransport({...OK, 'POST /users': {status: 201, body: {}}});
    await runJourney(journey(), {
      env: 'test',
      lookup,
      transport,
      hooks: {onLog: (l) => lines.push(l)},
    });

    expect(lines.join('\n')).toContain('userId not found');
  });

  it('reuses prior responses when running from a node', async () => {
    // "Run from here" only makes sense if upstream steps are not re-executed —
    // step 1 created a real account.
    const {transport, sent} = stubTransport(OK);
    const result = await runJourney(journey(), {
      env: 'test',
      lookup,
      transport,
      startAt: 'n2',
      priorResponses: {n1: {status: 201, headers: {}, body: {id: 'u_1'}, durationMs: 1}},
    });

    expect(sent.map((r) => r.url)).toEqual(['/users/u_1']);   // step 1 not re-sent
    expect(result.passed).toBe(true);
    expect(result.states.n1.status).toBe('skipped');
  });

  it('runs control nodes without touching the network', async () => {
    const {transport, sent} = stubTransport({});
    const j: Journey = {
      name: 'set',
      nodes: [{id: 's1', type: 'control.set', config: {values: {tenant: 'acme'}}, position: {x: 0, y: 0}}],
      edges: [],
    };
    const result = await runJourney(j, {env: 'test', lookup, transport});

    expect(sent).toHaveLength(0);
    expect(result.context.vars.tenant).toBe('acme');
  });

  it('can be stopped between steps', async () => {
    const controller = new AbortController();
    const {transport, sent} = stubTransport(OK);
    controller.abort();
    const result = await runJourney(journey(), {
      env: 'test',
      lookup,
      transport,
      signal: controller.signal,
    });

    expect(sent).toHaveLength(0);
    expect(result.passed).toBe(true);   // nothing ran, so nothing failed
  });

  it('lets a hook hold a step back', async () => {
    const {transport, sent} = stubTransport(OK);
    const beforeNode = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const result = await runJourney(journey(), {env: 'test', lookup, transport, hooks: {beforeNode}});

    expect(sent).toHaveLength(1);
    expect(result.states.n1.status).toBe('skipped');
  });
});

describe('graph', () => {
  it('orders by dependency, not by canvas position', () => {
    const j = journey();
    j.nodes.reverse();
    expect(topoOrder(j.nodes, j.edges).map((n) => n.id)).toEqual(['n1', 'n2']);
  });

  it('reports a cycle rather than looping forever', () => {
    const j = journey();
    j.edges.push({id: 'e2', source: 'n2', target: 'n1'});
    expect(findCycles(j.nodes, j.edges).sort()).toEqual(['n1', 'n2']);
  });

  it('collects everything downstream of a node', () => {
    const j = journey();
    expect([...downstreamOf('n1', j.edges)].sort()).toEqual(['n1', 'n2']);
    expect([...downstreamOf('n2', j.edges)]).toEqual(['n2']);
  });
});

describe('checking a journey before it runs', () => {
  it('passes a well-formed journey', () => {
    expect(checkJourney(journey(), lookup)).toEqual([]);
  });

  it('names the step whose needs nothing upstream provides', () => {
    // Finding this here costs nothing; finding it on staging costs an account.
    const j = journey();
    j.nodes = [j.nodes[1]];
    j.edges = [];
    const problems = checkJourney(j, lookup);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({nodeId: 'n2', kind: 'missing-context'});
    expect(problems[0].message).toContain('userId');
  });

  it('flags a node type that is not loaded', () => {
    const j = journey();
    j.nodes.push({id: 'n3', type: 'gone.node', config: {}, position: {x: 0, y: 0}});
    expect(checkJourney(j, lookup).some((p) => p.kind === 'unknown-type')).toBe(true);
  });
});

describe('nodes that only know their outputs once configured', () => {
  it('counts what a Set values step gives, so a good journey is not flagged', () => {
    // Without this the pre-run check warns on a perfectly correct journey,
    // which is worse than not checking at all.
    const defs: Record<string, NodeDef> = {
      'control.set': {
        type: 'control.set', label: 'Set', fields: [], control: 'set',
        givesFrom: 'values', needs: [], gives: [],
      },
      'demo.needsIt': {
        type: 'demo.needsIt', label: 'Needs it', fields: [],
        request: {method: 'GET', path: '/x/{{vars.petId}}'},
        needs: ['petId'], gives: [],
      },
    };
    const j: Journey = {
      name: 'set-then-use',
      nodes: [
        {id: 's1', type: 'control.set', config: {values: {petId: 1}}, position: {x: 0, y: 0}},
        {id: 's2', type: 'demo.needsIt', config: {}, position: {x: 250, y: 0}},
      ],
      edges: [{id: 'e1', source: 's1', target: 's2'}],
    };

    expect(checkJourney(j, (t) => defs[t])).toEqual([]);

    // …and it still catches the case where nothing sets it.
    j.nodes[0].config = {values: {}};
    expect(checkJourney(j, (t) => defs[t])[0]).toMatchObject({nodeId: 's2', kind: 'missing-context'});
  });
});
