// ---- AI: plan a journey, edit one, explain one ----
//
// The model call lives on this side for the same reason every credential does:
// the browser is never handed an API key.
//
// The model is grounded, not trusted. It is given a line-per-node index of the
// registry — built in the browser, because that is where imported documents are
// registered — and constrained by a JSON schema. Whatever comes back is then
// re-checked against the live registry on the client before anything reaches the
// canvas, so a hallucinated node type is reported rather than rendered.

import type {Request, Response, Router} from 'express';
import express from 'express';

const MODEL = 'claude-opus-5';

export interface Grounding {
  /** Line-per-node index of everything registered. */
  nodeIndex: string;
  /** Environment names the journey can run against. */
  environments: string;
}

interface Failure {
  error: string;
}

// Structured outputs cannot express a free-form object, so per-node settings
// come back as key/value string pairs and the client coerces them using each
// field's declared kind.
const CONFIG_PAIRS = {
  type: 'array',
  description: 'Only settings the request actually pins down. Omit to use the defaults.',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['key', 'value'],
    properties: {
      key: {type: 'string'},
      value: {type: 'string', description: 'JSON-encoded for a json field; plain text otherwise.'},
    },
  },
} as const;

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'steps'],
  properties: {
    summary: {type: 'string', description: 'One or two plain sentences telling the reader what this journey does.'},
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'why'],
        properties: {
          type: {type: 'string', description: 'A node type copied exactly from the NODES list.'},
          label: {type: 'string', description: 'Optional rename when the default is ambiguous here.'},
          why: {
            type: 'string',
            description:
              'One sentence, plain English, for someone who has not read the API docs. What this step does and why the journey needs it.',
          },
          config: CONFIG_PAIRS,
        },
      },
    },
    caveats: {
      type: 'array',
      description: 'Things to know before running it — data created, money moved, manual steps.',
      items: {type: 'string'},
    },
    unsupported: {
      type: 'array',
      description: 'Parts of the request no loaded node covers. Say so here rather than inventing a node.',
      items: {type: 'string'},
    },
  },
} as const;

const EDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'ops'],
  properties: {
    summary: {type: 'string', description: 'One or two plain sentences saying what you changed and why.'},
    ops: {
      type: 'array',
      description: 'The changes to make, in order. Empty if nothing needs to change.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'why'],
        properties: {
          op: {
            type: 'string',
            enum: ['insert', 'remove', 'replace', 'configure'],
            description:
              "insert = add a step; remove = delete one; replace = swap a step's node type keeping its place in the chain; configure = change a step's settings.",
          },
          ref: {type: 'string', description: 'The step being changed, copied exactly from the CANVAS ref. Required for remove, replace and configure.'},
          after: {type: 'string', description: 'insert only: the ref this goes after, or "start" / "end".'},
          handle: {type: 'string', description: 'insert only: a name for the new step so a later op in this list can target it.'},
          type: {type: 'string', description: 'insert and replace only: a node type copied exactly from NODES.'},
          label: {type: 'string'},
          config: CONFIG_PAIRS,
          why: {
            type: 'string',
            description:
              "One sentence, plain English. For a new or swapped step, what it does and why — this becomes the step's description. For a removal or settings change, why you made it.",
          },
        },
      },
    },
    caveats: {type: 'array', items: {type: 'string'}},
    unsupported: {type: 'array', items: {type: 'string'}},
  },
} as const;

const EXPLAIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'summary', 'steps'],
  properties: {
    headline: {type: 'string', description: 'One sentence: what this journey does, for someone who has never seen it.'},
    summary: {type: 'string', description: 'Two or three sentences. What it creates, how long it takes, what it depends on.'},
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'what'],
        properties: {
          ref: {type: 'string', description: 'The step ref, copied from the journey given to you.'},
          what: {type: 'string', description: 'One sentence, no endpoint paths or field names.'},
        },
      },
    },
    watchOuts: {type: 'array', description: 'Anything with real consequences, or a step that can fail confusingly.', items: {type: 'string'}},
  },
} as const;

// The shared half of the prompt. Kept byte-identical between the three tasks so
// they sit behind one cache breakpoint — the node index is the expensive part
// and re-sending it uncached for every call would be the costliest thing here.
const BASE = `You work with API journeys in Journey Studio — a canvas where each node is one HTTP call, and the ids and tokens a node produces flow to the nodes after it.

The person asking usually knows the product but not the API. They describe an outcome; you work in the nodes that reproduce it.

Rules that always hold:
- Use only node types listed in NODES, copied exactly. If nothing fits part of the request, put that part in "unsupported" rather than inventing a node.
- Order steps so that each node's needs= are produced by an earlier node's gives=.
- Set config only where the request pins a value down. Defaults are already right for a normal run, and a wrong value is worse than no value.
- Keep it to what was asked. Do not add checks, cleanup or verification nobody requested.
- Note anything with real-world consequences — data created, money moved, a destructive call — in "caveats".

Writing the "why" lines: they are what the person reads while the journey runs. One sentence, no endpoint paths, no field names, no jargon.`;

const PLAN_TASK = 'Your task now: turn the goal below into a new journey — a list of steps in the order they run.';

const REVISE_TASK = `Your task now: the person already has a journey on the canvas and wants it CHANGED. Return the smallest set of changes that does what they asked.

This is an edit, not a rebuild. Every step you do not mention keeps its place, its settings and anything it already fetched — so touching a step you did not need to touch throws away real work.

- Name steps by the ref shown in CANVAS. A ref you invent is dropped.
- Prefer the narrowest change: configure to change a setting, replace to swap one call for another in the same position, insert or remove only when the shape of the journey really changes.
- "Use X instead of Y" is a replace, not a remove plus an insert — replacing keeps the step wired to its neighbours.
- On configure, send only the settings you are actually changing.
- To add several steps in a row, give the first a handle and use it as the next one's after.
- When a step failed on the last run, its error is on its CANVAS line. Fix the cause.
- If what they asked for is already true, return no ops and say so in the summary.`;

const ASSERT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['assertions'],
  properties: {
    assertions: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'op', 'why'],
        properties: {
          path: {type: 'string', description: 'e.g. status, body.data.id'},
          op: {enum: ['status', 'eq', 'neq', 'exists', 'absent', 'contains', 'matches', 'gt', 'lt']},
          expected: {description: 'omit for exists/absent'},
          why: {type: 'string', description: 'one short line: what regression this catches'},
        },
      },
    },
    skipped: {
      type: 'array',
      items: {type: 'string'},
      description: 'fields deliberately not asserted on, and why',
    },
  },
} as const;

const ASSERT_TASK = `Your task now: propose assertions for one step, from the response it actually returned.

What makes a good assertion here:
- It catches a regression. "id is present" is worth having; "id equals 8fd2c1" is not — it will fail on the next run and teach the team to ignore red.
- Prefer structure and invariants over values that change per run: ids, timestamps, tokens, balances, and anything generated. Assert those with exists, not eq.
- Assert a value only when it is genuinely fixed for this call: a status, an enum, a currency, an echoed input, a computed total you can derive from the request.
- If the spec declares a schema, do not restate it — contract checking already covers required fields and types. Add what the spec cannot know.
- Fewer, sharper checks beat a wall of them. Six is plenty.

List anything you deliberately left alone in "skipped", with the reason.`;

const COVERAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    headline: {type: 'string', description: 'one line on the shape of the gap'},
    suggestions: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['journey', 'why', 'types'],
        properties: {
          journey: {type: 'string', description: 'what to call it, e.g. "Refund a settled order"'},
          why: {type: 'string', description: 'the risk it covers, in one line'},
          types: {type: 'array', items: {type: 'string'}, description: 'node types it would use, in order'},
          risk: {enum: ['high', 'medium', 'low']},
        },
      },
    },
  },
} as const;

const COVERAGE_TASK = `Your task now: given the operations no journey touches, say which gaps matter and what to write next.

What makes this useful rather than a restatement of the list:
- Rank by consequence, not by count. An untested endpoint that moves money, deletes records or changes permissions outranks twenty untested reads.
- Group into journeys, not endpoints. "Refund a settled order" is a thing somebody can go and write; "POST /refunds is untested" is the list they already have.
- Every type you name must appear in the gaps given to you. Do not invent operations, and do not propose a journey whose steps are not all available.
- Say what the risk actually is in one line — "a refund that succeeds twice would double-pay" beats "important endpoint".
- Prefer chains that reuse what the covered journeys already produce; a journey that needs no new setup is one somebody will actually write.

Five suggestions at most. If the gaps are all low-risk reads, say so plainly rather than manufacturing urgency.`;

const REPRODUCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'steps', 'assumptions'],
  properties: {
    summary: {type: 'string', description: 'what the report says is broken, in one line'},
    steps: PLAN_SCHEMA.properties.steps,
    assumptions: {
      type: 'array',
      items: {type: 'string'},
      description: 'what you had to decide because the report did not say',
    },
    missing: {
      type: 'array',
      items: {type: 'string'},
      description: 'what you would need from the reporter to make this exact',
    },
    expected: {type: 'string', description: 'what should happen if the bug is fixed'},
  },
} as const;

const REPRODUCE_TASK = `Your task now: turn a bug report into a journey that reproduces it.

A bug report is mostly not reproduction steps. It is a narrative with a severity, someone's
frustration, a stack trace, a customer id, and three sentences of context. Pull out the sequence of
API calls implied by it and leave the rest.

Rules:
- Build only from the node types listed above. If the report needs a call the loaded documents do not
  have, say so in "missing" rather than inventing a step.
- Separate what the report *stated* from what you *decided*. Anything you chose — an amount, a
  currency, which account, the order of two steps — goes in "assumptions". A reproduction that
  quietly invents the input is one that reproduces something else.
- Put the failing call last, so the journey reads as "set this up, then do the thing that breaks".
- Add the assertion that would fail *now* and pass once it is fixed, and describe that in "expected".
- If the report is too vague to reproduce at all, return no steps and put the questions in "missing".`;

const EXPLAIN_TASK =
  'Your task now: explain the journey below in plain English, for someone who has never seen this API. Use the refs given.';

async function callModel(opts: {
  grounding: string;
  task: string;
  user: string;
  schema: object;
  cutoff: string;
}): Promise<unknown | Failure> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {error: 'No ANTHROPIC_API_KEY. Export one in the shell that runs the dev server, then reload.'};
  }

  let Anthropic: typeof import('@anthropic-ai/sdk').default;
  try {
    ({default: Anthropic} = await import('@anthropic-ai/sdk'));
  } catch {
    return {error: 'The @anthropic-ai/sdk package is not installed.'};
  }

  const client = new Anthropic({apiKey});

  try {
    // Streaming: the node index can run to tens of thousands of tokens and
    // thinking is on, so a non-streaming call risks the SDK's HTTP timeout.
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      thinking: {type: 'adaptive'},
      output_config: {effort: 'high', format: {type: 'json_schema', schema: opts.schema as Record<string, unknown>}},
      system: [
        {type: 'text', text: opts.grounding, cache_control: {type: 'ephemeral'}},
        {type: 'text', text: opts.task},
      ],
      messages: [{role: 'user', content: opts.user}],
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      return {error: `The model declined this request (${message.stop_details?.category ?? 'no category'}).`};
    }
    if (message.stop_reason === 'max_tokens') return {error: opts.cutoff};

    const text = message.content
      .filter((b): b is {type: 'text'; text: string} & typeof b => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (!text.trim()) return {error: 'The model returned an empty response.'};

    return JSON.parse(text) as unknown;
  } catch (err) {
    return {error: err instanceof Error ? err.message : 'the model call failed'};
  }
}

function grounding(g: Grounding): string {
  return [
    BASE,
    `\nNODES (type | label | method path | needs | gives | fields | summary | note)\n${g.nodeIndex}`,
    `\nENVIRONMENTS\n${g.environments}`,
  ].join('\n');
}

export function createAiRouter(): Router {
  const router = express.Router();
  router.use(express.json({limit: '12mb'}));

  router.get('/status', (_req: Request, res: Response) => {
    const configured = Boolean(process.env.ANTHROPIC_API_KEY);
    res.json({
      configured,
      model: MODEL,
      ...(configured ? {} : {hint: 'Set ANTHROPIC_API_KEY in the shell that runs the dev server, then reload.'}),
    });
  });

  router.post('/plan', async (req: Request, res: Response) => {
    const {goal, env, nodeIndex, environments} = req.body ?? {};
    if (!goal?.trim()) {
      res.status(400).json({error: 'No goal given.'});
      return;
    }
    res.json(
      await callModel({
        grounding: grounding({nodeIndex: nodeIndex ?? '', environments: environments ?? ''}),
        task: PLAN_TASK,
        user: `Goal: ${goal}\n\nThis will run against the "${env ?? 'default'}" environment.`,
        schema: PLAN_SCHEMA,
        cutoff: 'The plan was cut off before it finished. Try a narrower goal.',
      }),
    );
  });

  router.post('/revise', async (req: Request, res: Response) => {
    const {instruction, env, nodeIndex, environments, canvas, history} = req.body ?? {};
    if (!instruction?.trim()) {
      res.status(400).json({error: 'No change given.'});
      return;
    }
    if (!canvas?.trim()) {
      res.status(400).json({error: 'There is nothing on the canvas to change yet.'});
      return;
    }
    res.json(
      await callModel({
        grounding: grounding({nodeIndex: nodeIndex ?? '', environments: environments ?? ''}),
        task: REVISE_TASK,
        user: [
          `CANVAS (the journey as it stands, in run order)\n${canvas}`,
          history?.trim() ? `\nEARLIER IN THIS BUILD\n${history}` : '',
          `\nChange requested: ${instruction}`,
          `\nThis runs against the "${env ?? 'default'}" environment.`,
        ]
          .filter(Boolean)
          .join('\n'),
        schema: EDIT_SCHEMA,
        cutoff: 'The edit was cut off. Try asking for one change at a time.',
      }),
    );
  });

  router.post('/explain', async (req: Request, res: Response) => {
    const {canvas, nodeIndex, environments} = req.body ?? {};
    if (!canvas?.trim()) {
      res.status(400).json({error: 'There is nothing on the canvas to explain.'});
      return;
    }
    res.json(
      await callModel({
        grounding: grounding({nodeIndex: nodeIndex ?? '', environments: environments ?? ''}),
        task: EXPLAIN_TASK,
        user: `JOURNEY\n${canvas}`,
        schema: EXPLAIN_SCHEMA,
        cutoff: 'The explanation was cut off. Try a shorter journey.',
      }),
    );
  });

  router.post('/assert', async (req: Request, res: Response) => {
    const {step, response, schema, nodeIndex, environments} = req.body ?? {};
    if (!response) {
      res.status(400).json({error: 'Run the step first — there is no response to suggest checks from.'});
      return;
    }
    res.json(
      await callModel({
        grounding: grounding({nodeIndex: nodeIndex ?? '', environments: environments ?? ''}),
        task: ASSERT_TASK,
        user: [
          `STEP\n${step ?? '(unnamed)'}`,
          schema ? `\nWHAT THE SPEC PROMISES\n${JSON.stringify(schema).slice(0, 4000)}` : '',
          `\nWHAT IT ACTUALLY RETURNED\n${JSON.stringify(response).slice(0, 8000)}`,
        ].join('\n'),
        schema: ASSERT_SCHEMA,
        cutoff: 'The suggestions were cut off. Try a step with a smaller response.',
      }),
    );
  });

  router.post('/coverage', async (req: Request, res: Response) => {
    const {gaps, covered, nodeIndex, environments} = req.body ?? {};
    if (!gaps?.trim()) {
      res.status(400).json({error: 'Nothing uncovered — import a document, or the suite already touches everything.'});
      return;
    }
    res.json(
      await callModel({
        grounding: grounding({nodeIndex: nodeIndex ?? '', environments: environments ?? ''}),
        task: COVERAGE_TASK,
        user: [`ALREADY COVERED\n${covered || '(nothing yet)'}`, `\nNOT COVERED\n${gaps}`].join('\n'),
        schema: COVERAGE_SCHEMA,
        cutoff: 'The suggestions were cut off. Import a smaller document, or cover some of it first.',
      }),
    );
  });

  router.post('/reproduce', async (req: Request, res: Response) => {
    const {report, nodeIndex, environments} = req.body ?? {};
    if (!report?.trim()) {
      res.status(400).json({error: 'Paste the bug report first.'});
      return;
    }
    res.json(
      await callModel({
        grounding: grounding({nodeIndex: nodeIndex ?? '', environments: environments ?? ''}),
        task: REPRODUCE_TASK,
        user: `BUG REPORT\n${String(report).slice(0, 12000)}`,
        schema: REPRODUCE_SCHEMA,
        cutoff: 'The reproduction was cut off. Try a shorter report.',
      }),
    );
  });

  return router;
}
