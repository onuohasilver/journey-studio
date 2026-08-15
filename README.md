# Journey Studio

A visual canvas for building, running and replaying **API journeys** — chains of HTTP calls where the
ids and tokens each step produces flow into the next.

Import an OpenAPI document or a Postman collection, wire the steps together, and run them against a
real environment. Or describe what you want in plain English and let it assemble the journey — then
keep editing it in place.

Save a journey and it becomes a regression test: `journey run` executes it in CI, checks every
response against the spec the API published, and posts the report to Slack.

```bash
npm install
npm run dev     # http://localhost:5180
```

## Why

Most API clients treat requests as independent things you fire one at a time. Real journeys aren't:
step three needs the token step one minted and the id step two created. That chaining is usually left
to the person at the keyboard — copy the id out of one response, paste it into the next — or buried
in a test script nobody reads.

Journey Studio makes chaining the primitive. Every node declares two things:

```ts
needs: ['userId']                          // must exist before this can run
gives: [{key: 'orderId', from: 'body.id'}] // what it hands to the steps after it
```

Everything else follows: the run order, whether a journey can work at all, what breaks when you
delete a step. The pre-run check names the exact step whose `needs` nothing upstream provides —
finding that on the canvas costs nothing; finding it against a shared environment costs real data.

## Where nodes come from

A hand-authored catalog is weeks of work per API and stale the day the backend ships. So you import
a document instead, and the format is detected from its contents:

| Format | What comes across |
|---|---|
| **OpenAPI 3.x** (JSON or YAML) | paths, methods, path/query/header params, JSON bodies seeded from the spec's own examples, local `$ref`, enums as selects, the documented 2xx as the status assertion |
| **Postman Collection v2.x** | folders as groups, `:pathVariables`, headers, query, raw/urlencoded/formdata bodies — **and `pm.*.set()` calls transcribed into `gives`** |

Two details that matter:

- **Postman collections already express chaining.** `pm.environment.set("userId", jsonData.id)` in a
  test script *is* a `gives`, so it carries over rather than being redeclared. Scripts are
  pattern-matched, never executed: a collection is untrusted input, and evaluating its JavaScript to
  learn what it sets would be a plain remote-code-execution hole.
- **Credentials in a collection are not imported.** Collections routinely have a live token pasted
  in. The auth *scheme* is referenced by name and configured on your side; the value is left behind.

Path parameters default to `{{vars.<name>}}`, which is the single choice that makes an imported
document chain: if an earlier step produced `petId`, a later `/pets/{petId}` picks it up with no
wiring at all.

## Build with AI

Set `ANTHROPIC_API_KEY` in `.env.local` (see `.env.example`) and the AI rail turns on. The key stays
in the node process — the browser never sees it.

- **Describe a journey** and it assembles one from the nodes you actually have loaded. The grounding
  index is built from the live registry, so it works against whatever document you imported.
- **Then keep talking.** The first message builds; every message after it *edits*. "Use the other
  endpoint instead" swaps one step and leaves the rest — their ids, their positions, and the
  responses they already fetched. A planner that can only replace the canvas is one you stop using
  after the second prompt.
- **Explain** turns the canvas into plain English: what it does, what it creates, what to watch for.

The model is grounded, not trusted. Every node type, setting and step reference that comes back is
re-checked against the live registry before it reaches the canvas — anything that fails is reported,
not silently applied.

## Using it for QA

A journey you can save is a test. A journey you can run on a schedule is a suite.

```bash
npx journey run                       # every saved journey, default environment
npx journey run signup --env staging  # one journey, somewhere specific
npx journey run --repeat 5            # run five times and name the flaky steps
npx journey run --report qa.json      # write the evidence
npx journey run --slack               # post the result
npx journey run --strict-contract     # fail when a response stops matching the spec
```

Exit code is 1 on any failure, so CI stops without anyone wiring up a parser.

### Contract checking — the assertions nobody has to write

Because the document was imported, every node knows the response schema its API published. So each
run compares what came back against what was promised, and reports the failures no hand-written
assertion would have anticipated: a required field that quietly disappeared, a string that became a
number, an enum that grew a value the client will not understand.

Assertions test what you thought to check. This tests what the API said.

Findings are reported but do not fail the run unless you pass `--strict-contract` — drift is often
something you are shipping deliberately, and the point is that you find out either way. Only success
responses are checked: an error body was never meant to match the 2xx schema, and one false finding
is all it takes for people to stop reading the report.

### What a report carries

Per step: status, HTTP code, timing, the failing assertion, and — for failures — the exact request
that was sent, so it reproduces. Per journey: the values the run captured, which is to say **the
records it created on a shared environment**. Plus anywhere the API stopped matching its spec.

Response bodies are left out by default (`--include-bodies` opts in): they routinely hold tokens and
personal data, and reports get pasted into channels.

### Saved journeys are self-contained

A saved journey embeds the definitions of the node types it uses. Two consequences, both wanted: it
runs in CI with no document to import and no setup step, and it pins the contract as it was the day
you saved it — so if the spec later changes, that difference is the news rather than something
papered over.

### Slack

Set `SLACK_WEBHOOK_URL` in `.env.local`, or `slack.webhookUrl` in your config. The webhook URL *is*
the credential, so it stays on the server: the browser posts the report, never the secret.

The message leads with the verdict, then the failing steps and how to reproduce them, then what the
run created. It never contains a response body.

## Credentials

The engine hands a resolved request to a transport; in the app that transport is a local proxy that
holds the secrets and substitutes them on the way out. The canvas only ever sees `{{secrets.apiKey}}`.
This also sidesteps CORS, since the APIs worth testing rarely allow a browser origin.

`journey.config.json` holds environments and named auth schemes. Secrets belong in
`journey.config.local.json` (gitignored) or in `JOURNEY_SECRET_*` environment variables, and
`${env:NAME}` is expanded anywhere in the config.

```json
{
  "environments": [{"name": "demo", "baseUrl": "https://petstore3.swagger.io/api/v3"}],
  "auth": {"bearer": {"type": "bearer", "token": "${env:API_TOKEN}"}}
}
```

## Templating

Any string in a request may reference the run context:

```
{{vars.userId}}             a value an earlier step produced
{{nodes.n1.body.data.id}}   straight into an earlier step's response
{{secrets.apiKey}}          substituted by the proxy, never in the browser
{{$uuid}} {{$now}}          generated per request
```

A string that is *only* a reference keeps its type, so `{{vars.count}}` stays a number in a JSON
body. An unknown reference is left in place rather than blanked — a request that fails with
`/users/{{vars.userId}}` in the URL tells you what went wrong; one that fails with `/users/undefined`
does not.

## Development

```bash
npm test        # 146 tests, no network
npm run typecheck
npm run build
```

In dev, `window.studio` exposes the store for poking at from the console.

`Cmd/Ctrl+Z` undoes, `Cmd/Ctrl+Shift+Z` redoes. Inside a text field the browser's own undo is left
alone, so a half-typed URL is never traded for a canvas edit.

## Roadmap

- [x] Engine — topological run, context threading, templating, assertions, run-from-here
- [x] Pre-run check — names the step whose `needs` nothing upstream provides
- [x] OpenAPI 3 and Postman v2 import
- [x] Credential proxy — server-side secrets, per-environment base URLs, named auth schemes
- [x] Canvas, palette, inspector, logs
- [x] AI — build a journey, edit it in place, explain it
- [x] Undo/redo — coalesced per field, one step per AI edit
- [x] Save and load journeys, self-contained so they run in CI
- [x] Contract checking against the imported spec
- [x] QA report — evidence, created data, contract drift
- [x] CLI runner with exit codes, `--repeat` flake detection, and Slack delivery
- [ ] Data-driven runs — one journey over a table of inputs
- [ ] Response snapshots, to catch drift in APIs with no spec
- [ ] Teardown tracking, so a suite can clean up what it created
- [ ] Webhook inbox for async steps
- [ ] Assertion editor in the inspector

## License

MIT
