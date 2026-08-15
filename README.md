# Journey Studio

A visual canvas for building, running and replaying **API journeys** — chains of HTTP calls where the
ids and tokens each step produces flow into the next.

Import an OpenAPI document or a Postman collection, wire the steps together, and run them against a
real environment. Or describe what you want in plain English and let it assemble the journey — then
keep editing it in place.

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
npm test        # 108 tests, no network
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
- [ ] Save and load journeys to disk
- [ ] Webhook inbox for async steps
- [ ] Assertion editor in the inspector
- [ ] CLI runner, so a saved journey becomes a CI check

## License

MIT
