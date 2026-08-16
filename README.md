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
npx journey run --data users.csv      # once per row of a spreadsheet
npx journey run --repeat 5            # run five times and name the flaky steps
npx journey run --report qa.json      # write the evidence
npx journey run --slack               # post the result
npx journey run -u                    # record what the responses look like now
npx journey run --strict              # fail on drift, not just on assertions
npx journey run --mock-webhooks       # replay saved callbacks instead of waiting
npx journey compare --env a --with b  # the same journey against two environments
```

Exit code is 1 on any failure, so CI stops without anyone wiring up a parser.

### Data-driven runs — one journey, twenty tests

A journey with cases runs once per row, and each row seeds the context before the first step — so
`{{vars.country}}` in a step picks up that row's value with no other wiring.

```
name,country,amount
domestic,US,100
nigeria,NG,50000
sanctioned,KP,100
```

Paste that into the Cases rail, or point the CLI at the file with `--data`. The rows almost always
already exist in a spreadsheet, which is why the editor takes CSV rather than making you retype into
a grid.

**A failing case does not stop the others.** Inside a journey, stopping at the first failure is right
— step four cannot work without the id step three never created. Across cases it is exactly wrong:
they are independent, and a suite that reports "row 3 failed" and goes home makes you re-run it once
per broken row to learn there were four.

One check exists because the failure is otherwise silent: if a step **sets** a variable the cases
also supply, every row runs against that step's value and all of them go green having tested one
case. The studio names the step before you run, and the CLI prints it even under `--quiet`.

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

### Response snapshots — drift detection for APIs with no spec

Contract checking needs a schema. Most APIs do not have one: every Postman collection arrives without
any, and plenty of OpenAPI documents describe a response as a bare `object`. For those, the best
description of the contract is what the API returned last time it was known good.

So each run records the **shape** of every success — each path and its type — and compares later runs
against it:

```bash
npx journey run -u        # record the shapes as they are now
npx journey run           # compare, and report what moved
npx journey run --strict  # …and fail the build on it
```

Not the values: ids, timestamps and balances change every run, and a check that fires on those gets
turned off in a week. Shapes hold still.

The severities encode who breaks. A field that disappeared or changed type breaks every consumer
reading it today — error. A field that stopped always being present breaks the ones that assumed it —
warning. A new field breaks nobody — information. Reporting additions as failures is how a snapshot
suite becomes something people delete.

Snapshots live in `snapshots/`, one file per journey, meant to be committed. A shape change arriving
as a diff in a pull request is the point: it turns "the API changed under us" from something found in
production into a line somebody approved.

### Waiting for a webhook

Plenty of the flows worth testing do not finish when the response does. You POST a payment, get a
202, and the thing you care about turns up later as a callback. A tool that can only make outbound
requests cannot test that — it can only sleep and poll and hope.

So the studio runs an inbox. Anything sent to `/api/hooks/<path>` is recorded and answered 200, and a
**Wait for webhook** step blocks until one arrives that belongs to it:

```
path          payments
correlate on  body.reference
must equal    {{vars.paymentRef}}
capture       {"settlementStatus": "body.status"}
```

Correlation is what makes this usable for more than a demo. With a dozen cases in flight, "the next
delivery on /payments" is the wrong one most of the time; matching on a value the run itself produced
is the only way each row claims its own callback. A delivery is handed to one claimant only.

The whole thing rests on one decision: **a received webhook is just an `HttpResponse`.** Stored that
way, everything already in the tool works on it unchanged — `{{nodes.n5.body.status}}`, `gives`,
assertions, contract checking, snapshots. None of them needed a line of webhook-specific code.

Two details that took a bug to find. Deliveries that arrived *before* the step started waiting still
count, because the race goes the unhelpful way in practice — a fast provider calls back before the
journey reaches the step — and watching only for new arrivals fails on exactly the integrations that
work best. And anything older than the run is ignored, so a run cannot go green by claiming last
night's callback.

When nothing arrives, the message tells you which problem you have:

```
Waited 5s for a webhook on "payments" where body.reference = "pay_demo" and none arrived.
1 other delivery did: POST /payments {"reference":"pay_SOMEONE_ELSE","status":"settled"}
```

"It called with a reference you are not matching on" and "it never called" need different fixes.

### Mocking the callback

Save a delivery you received and it becomes replayable. Two jobs: while building a journey it saves
you triggering a real payment to see what the callback looks like, and in CI it is the only way the
journey can run at all — no provider is going to call a build agent.

```bash
npx journey run --mock-webhooks     # deliver saved payloads instead of waiting
```

A mock body may use `{{templates}}`, so it echoes back the reference *this* run generated rather than
a hard-coded one. Firing one from the studio resolves it against the run that is currently waiting.

**A mock is never a fallback.** A journey that quietly satisfies its webhook from a canned payload
whenever the real one fails to arrive is a test that passes while the integration is broken, which is
worse than no test. So mock delivery is asked for explicitly, and every step it fulfils is marked:

```
✓ Wait for settlement (mocked) · 200 (1ms)
1 webhook delivered from mocks, not the real integration
```

That line is in the terminal, the report, and the Slack message. It also fires for a mock you fired
by hand mid-run — the step really did wait, but the payload was still canned, and a green run must
never read as proof the integration works.

Locally the inbox has to be reachable from wherever the provider runs, which means a tunnel; the
panel shows the URL it believes it is on, taking the forwarded host over anything configured.

### Cleaning up after yourself

Mark a step as a **clean-up step** and it runs after the journey, *whether the journey passed or
failed*. That condition is the whole feature: the failed run is precisely the one that created an
account and then fell over before the step that deletes it, so cleanup that only happens on success
cleans up exactly when there was nothing to clean.

Clean-up is best effort. One failing cleanup step does not stop the others — if deleting the order
fails, the account it belongs to should still be attempted — and a failed cleanup does **not** turn
the journey red. The API under test may have behaved perfectly; what broke is test hygiene. It gets
its own line instead:

```
✓ Pet with cleanup
  ✓ Create a pet · 200 (22ms)
  ✓ Read it back · 200 (2ms)
  ✓ ⌫ Delete the pet · 200 (2ms)
  created: petId=987654321
```

Clean-up steps are skipped when a run is stopped: firing deletes at an environment after somebody hit
stop is the opposite of what they asked for.

### Timing budgets

A step can declare how long it is allowed to take. The verdict is taken at **p95 across every run and
every case**, not on a single sample — one cold start is not an SLO breach, and failing on it
produces exactly the flakiness this tool exists to name.

```
Over budget:
  ⏱ Pet with cleanup · Read it back — p95 456ms against 300ms (p50 455ms, max 456ms, 3 runs)
```

Reported by default; `--strict-budget` (or `--strict`) makes it fail the build.

### Comparing two environments

"It works on staging" is the oldest bug report there is, and it is hard to act on because nobody has
the two runs side by side.

```bash
npx journey compare signup --env staging --with prod
```

It runs the journey in both and prints only where they disagree:

```
✗ Pet with cleanup · local vs local-next — 7 differences
  Read it back
    ✗ id is number on local and string on local-next.
    ~ region comes back on local-next but not on local.
    ~ local-next is 604.0× slower here (1ms vs 604ms).
```

Values are ignored — ids and balances differ between environments by definition, and that is what
makes them different environments. What should not differ is the contract. A field only one side
returns is a finding here even though it is noise against a recorded baseline: it usually means the
two are running different builds. Timing is only mentioned when one side is both relatively *and*
absolutely worse, so a 3ms/8ms endpoint stays quiet.

### What a report carries

Per step: status, HTTP code, timing, the failing assertion, and — for failures — the exact request
that was sent, so it reproduces. Per journey (or per case): the values the run captured, which is to
say **the records it created on a shared environment**. Plus anywhere the API stopped matching its
spec, or changed shape since it was recorded.

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
  "auth": {
    "bearer": {"type": "bearer", "token": "${env:API_TOKEN}"},
    "api": {
      "type": "oauth2",
      "tokenUrl": "https://issuer.example.com/oauth/token",
      "grant": "client_credentials",
      "clientId": "${env:CLIENT_ID}",
      "clientSecret": "${env:CLIENT_SECRET}",
      "scope": "payments:write"
    }
  }
}
```

### Tokens that expire

Static credentials are the easy half. Every API worth testing hands you a token that dies in an hour,
and a tool that makes you paste a fresh one before each session is one nobody uses twice. An `oauth2`
scheme is fetched and refreshed by the proxy, so an unattended nightly run works.

Three details that only show up in practice:

- **Expiry is treated as earlier than it says.** A token that expires *during* a request looks exactly
  like a broken integration, and this machine's clock is not the issuer's.
- **Concurrent runs share one fetch.** Twelve cases starting at once must not send twelve requests to
  the token endpoint; plenty of providers rate-limit that hard, and a suite that fails on its own auth
  is worse than no suite.
- **A 401 refreshes and retries exactly once.** Credentials get revoked early — one retry recovers,
  and a loop would turn a bad credential into a denial-of-service against your own auth server. The
  second 401 is returned to the journey to assert on rather than swallowed.

Tokens are held in the node process and never sent to the browser, like every other secret here.

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
npm test        # 226 tests, no network
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
- [x] Data-driven runs — one journey over a table of inputs, from CSV
- [x] Response snapshots, to catch drift in APIs with no spec
- [x] Clean-up steps that run whether the journey passed or failed
- [x] Timing budgets, judged at p95 across runs and cases
- [x] Environment comparison — the same journey against two, diffed
- [x] Webhook inbox for async steps, with correlation and replayable mocks
- [ ] Scheduled runs with a history, so drift has a timeline
- [ ] Assertion editor in the inspector

## License

MIT
