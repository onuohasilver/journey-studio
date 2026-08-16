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
| **HAR** (browser recording) | one step per API call, assets and analytics filtered out, **and the chain inferred from the traffic itself** |
| **curl** | a pasted command, or a file of them — the format every API's docs and every browser's "Copy as cURL" already speak |

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

### Recording a flow you have no spec for

Plenty of the APIs worth testing have no document — the internal one nobody wrote down, the flow that
only exists as four calls the front end happens to make in order. For those, the recording *is* the
specification. Click the flow in your app, export a HAR from the network panel, and drop it in.

A flat list of requests is not a journey, though; it is a recording that breaks the moment an id
changes. So the importer looks for **values one response produced and a later request used**, and
wires those as `gives` and `{{vars.x}}`:

```
POST /oauth/token   gives accesstoken
POST /pet           Authorization: Bearer {{vars.accesstoken}}   gives id
GET  /pet/{{vars.id}}
```

Matching is on the literal text, so no convention about naming is needed. Two rules keep it honest:
a value must look like an identifier — a digit, a separator, or real length — because `"Bearer"` is
six characters and chaining it produces a journey that reads like nonsense; and nothing links
backwards, because a value cannot come from a response that had not arrived yet.

A recorded credential is **replaced by a reference to the step that produced it** rather than
imported. `Bearer {{vars.accesstoken}}` stores no secret and makes the journey self-contained: it
logs in and uses what it got. A credential that came from your session rather than from a step here
is dropped, with a note saying so.

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
npx journey run --tag smoke           # only journeys carrying that tag
npx journey run --var country=NG      # seed a value into every run
npx journey run --junit junit.xml     # results every CI renders natively
npx journey init --ci                 # write a working GitHub Action
npx journey sweep --env staging       # delete what earlier failed runs left behind
npx journey run --parallel 4          # run four journeys at once
npx journey run --otlp                # export metrics to your collector
npx journey run --file-issues         # open/update/close tracker issues
npx journey run --no-history          # do not append this run to history/
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

Snapshots live in `snapshots/`, **one file per journey per environment**, meant to be committed. A
shape change arriving as a diff in a pull request is the point: it turns "the API changed under us"
from something found in production into a line somebody approved.

Per environment because staging and production legitimately differ — a feature flag, a field one
build has and the other does not — and a single shared baseline makes one of them report drift for
ever, which is how the check stops being read. A baseline recorded before this existed still applies
as a fallback, so nothing is thrown away.

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

### Waiting for a condition, instead of sleeping

A step can declare what it is waiting for, and be re-sent until that holds:

```
keep trying until   body.status equals settled
every               1000ms
give up after       30000ms
```

This exists to kill the fixed sleep, which is the single largest source of flaky
API tests — and slower than it needs to be on a good day while still being wrong on a bad one. Hard
failures are retried too, because "not ready yet" usually arrives as a 404. A step with no condition
still fails fast: retrying everything would turn one broken endpoint into a suite that takes an hour
to say so.

### Firing several requests at once

Set **fire at once** to 5 and the step sends five identical requests simultaneously. The whole class
of race conditions — double spend, idempotency-key reuse, two transfers against one balance — is
invisible to a runner that only ever sends one request at a time.

What came back is available to assertions with no new machinery:

```
concurrent.succeeded  equals 1     # a double-spend guard should let exactly one through
concurrent.distinct   equals 1     # an idempotent endpoint returns one body, repeated
```

```
✗ Charge the card · 201 — 5 at once → 5 ok, 5 distinct    # five charges, five ledger rows
✓ Charge the card · 201 — 5 at once → 1 ok, 2 distinct    # the guard held
```

The first success is what flows downstream, so `gives`, contract checking and snapshots carry on
working exactly as they do for a single request.

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

### When did this start failing?

Every run appends a small row to `history/`, and the report shows a tick per run per step:

```
Read the order  ▮▮▯▮▮▯     failing since 2026-08-16 00:31
```

Deliberately small — a full report per run would be megabytes a week and nobody would commit it. What
is kept is the shape of the answer: per step, did it pass, how long, did it drift.

The failing-since line reports the *current* run of failures, not the first one that ever happened. A
step that broke in January, was fixed, and broke again yesterday is failing since yesterday — saying
"since January" would send someone to the wrong commit. History is keyed on step id, so renaming a
step does not silently start its history over.

### Fitting into CI

`--junit` writes the one format every CI already understands, so failures show up as rows with
messages inline, and GitHub, GitLab and CircleCI apply their own history and flake tracking for free.
A journey becomes a suite; a step becomes a test.

Three things have no JUnit equivalent and would otherwise be lost, so they go in `system-out` where
every renderer shows them: **drift**, **a step that polled**, and — most importantly — **a webhook
delivered from a mock**. A mocked run must never read as proof the integration works.

`journey init --ci` writes a workflow that runs on push and nightly, and uploads the report with
`if: always()` — because the run worth having the report from is the one that failed, which is the
line everyone forgets writing it by hand.

### Setup a suite shares

Twenty journeys that each log in spend most of their time logging in, hammer the auth endpoint twenty
times, and leave twenty sessions for somebody to clean up. Name the setup once instead:

```json
{"uses": ["Login"], "tags": ["needs-login"]}
```

`Login` runs first, once, and whatever it produced is seeded into every journey that declares it —
under a case's own values and under `--var`, since it is a default rather than an instruction. Setups
are pulled in even when a filter did not name them: `--tag smoke` means "run the smoke tests", not
"run them without logging in first".

When the setup itself fails, its dependents are reported as **not run**, not failed:

```
✗ Login
  ✗ Get a token · 404
Not run:
  · Alpha — needs Login (its own steps failed)
  · Beta — needs Login (its own steps failed)
```

Twenty red rows for one broken login buries the news, and those journeys never touched the API under
test. Calling them failures would be a lie about it.

### Sweeping up

A run that failed halfway is the one that leaves records behind, and if its clean-up step also failed
— a 503 from the delete endpoint, say — they stay there forever. History remembers what each run
created, so:

```bash
npx journey sweep --env staging
```

runs each journey's clean-up steps against the values that run produced:

```
✓ Leaky · 2026-08-16 10:01 — removed petId=775511
Swept 1 run on local.
```

No new mechanism: a journey already knows how to remove what it makes. Swept entries are marked, so
this is safe to run on a schedule, and only the current environment's leftovers are touched — an id
created on staging means nothing in production, and deleting by it there would be a very bad
surprise.

### Running a suite in parallel

```bash
npx journey run --parallel 4
```

Opt-in, and it has to be: journeys that share data collide, and the tool cannot know which do. Two
kinds stay on their own — a journey another one **uses** as a setup, and any journey marked
`"serial": true`, the escape hatch for one that owns a balance, a singleton record, or a queue it
drains.

```
✓ Slow 2      (serial — alone)
✓ Slow 3      (a setup — alone)
running 2 journeys 4 at a time
  Slow 1, Slow 4 overlap
```

Four two-second journeys take **8.9s sequentially and 3.3s at `--parallel 4`**.

Each journey's output is buffered and flushed in one piece. Interleaved progress from eight journeys
is unreadable, and an unattended run is read afterwards anyway. Results keep their input order
whatever order they finish in, so the report still diffs cleanly between runs.

### Choosing what to run

Tag a journey and run subsets:

```bash
npx journey run --tag smoke                # on every pull request
npx journey run --tag nightly --strict     # once a day, drift is a failure
```

Names and tags both narrow: `--tag smoke checkout` means "the checkout journey, if it is a smoke
test". The union reading is what somebody eventually wants and is not what anyone expects from the
same command. When nothing matches, the error names the tags that *are* in use, because the mistake
is nearly always a typo.

`--var key=value` seeds a value into every run. A data-driven row that names the same variable wins —
otherwise the flag would silently flatten a twelve-case run into twelve copies of one.

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

## Where the results go

### Metrics

```bash
npx journey run --otlp
```

Exports over **OTLP**, which Datadog, Grafana, Honeycomb and the OpenTelemetry Collector all accept —
one integration rather than one per vendor, and no SDK dependency in a tool whose pitch is that it
lives in your repo. Step durations, pass/fail per step and per journey, drift, and budget breaches,
tagged with environment, journey, case and step.

Two deliberate choices. Durations are gauges, not histograms: a histogram of one observation is a lie
dressed as statistics, and the percentile that matters is already computed across runs and cases.
Mocked steps carry a `mocked` attribute, so a dashboard can exclude them from an integration SLO —
counting a mocked run towards "the payment webhook works" is worse than no dashboard. A collector
being down is reported and never fails the build.

### Issues

```bash
npx journey run --file-issues
```

Opens one issue per failing step, comments on it while it stays broken, and closes it when it passes.
**Deduplication is the entire feature** — without it this is a bot that files thirty issues a night
and gets muted in a week, which is worse than nothing because it also trains people to ignore the
tracker.

The dedup key is a hidden marker in the issue body rather than something encoded in the title,
because titles get edited by people and a key a human can break by tidying the wording is not a key.
History supplies the memory: a step failing for the fifth night running is the same problem, so it
gets a comment, not a fifth issue. A data-driven journey failing twelve rows of one step files once.

## Credentials

The engine hands a resolved request to a transport; in the app that transport is a local proxy that
holds the secrets and substitutes them on the way out. The canvas only ever sees `{{secrets.apiKey}}`.
This also sidesteps CORS, since the APIs worth testing rarely allow a browser origin.

`journey.config.json` holds environments and named auth schemes. Secrets belong in
`journey.config.local.json` (gitignored), in `JOURNEY_SECRET_*` environment variables, or — better —
nowhere near the repo at all:

```
${env:API_TOKEN}                an environment variable
${file:./secrets/token}         the contents of a file
${op://Vault/Item/credential}   1Password, through its CLI
```

A reference that cannot be resolved is **left in place**, not blanked. A request that fails carrying
a literal `${env:API_TOKEN}` says exactly what is wrong; one that fails carrying an empty header looks
like the API rejecting you, and that is an afternoon gone.

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
npm test        # 396 tests, no network
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
- [x] OAuth2, with tokens fetched, cached and refreshed server-side
- [x] Poll until a condition holds, instead of sleeping
- [x] Assertion editor, with paths from the response and AI suggestions
- [x] Run history, so drift has a timeline
- [x] Concurrent bursts, to catch races a one-at-a-time runner cannot see
- [x] HAR and curl import, so a flow with no spec still becomes a journey
- [x] JUnit output and `journey init --ci`
- [x] Tags and `--var`, for choosing what runs
- [x] Shared setup journeys, so a suite logs in once rather than twenty times
- [x] Sweep, to clean up records earlier failed runs left behind
- [x] OpenTelemetry metrics, so budgets sit beside production latency
- [x] Issue-tracker filing, deduplicated against `failing since`
- [x] Parallel journeys within a suite, for the runs that do not share data
- [x] Response snapshots per environment, so staging and prod keep separate baselines

## License

MIT
