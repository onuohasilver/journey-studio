# Journey Studio

A visual canvas for building, running and replaying **API journeys** — chains of HTTP calls where the
ids and tokens each step produces flow into the next.

> **Status: early.** The engine and both importers are complete and tested (66 tests). The canvas UI
> and the credential proxy are in progress. See [Roadmap](#roadmap).

## Why

Most API clients treat requests as independent things you fire one at a time. Real journeys aren't:
step three needs the token step one minted and the id step two created. That chaining is usually left
to the person at the keyboard — copy the id out of one response, paste it into the next request — or
buried in a test script nobody reads.

Journey Studio makes chaining the primitive. Every node declares two things:

```ts
needs: ['userId']                          // must exist before this can run
gives: [{key: 'orderId', from: 'body.id'}] // what it hands to the steps after it
```

Everything else follows from those two lists: the run order, whether a journey can work at all, and
what breaks when you delete a step.

## Two ideas worth stealing

**Nodes come from documents, not from hand-authoring.** A catalog you write by hand is weeks of work
per API and stale the day the backend ships. Drop in an OpenAPI document or a Postman collection and
you get nodes.

**Credentials never reach the browser.** The engine hands a resolved request to a transport; in the
app that transport is a local proxy that holds the secrets and substitutes them on the way out. The
canvas only ever sees `{{secrets.apiKey}}`.

## Importing

| Format | Support |
|---|---|
| OpenAPI 3.x (JSON or YAML) | paths, methods, path/query/header params, JSON request bodies, local `$ref`, enums as selects, documented 2xx as the status assertion |
| Postman Collection v2.x | folders as groups, path variables, headers, query, raw/urlencoded/formdata bodies, **and `pm.*.set()` calls transcribed into `gives`** |

Format is detected from the document's contents, so you just drop the file.

Two details that matter:

- **Postman collections already express chaining.** `pm.environment.set("userId", jsonData.id)` in a
  test script *is* a `gives` — it carries over rather than being redeclared. The script is
  pattern-matched, never executed: a collection is untrusted input and evaluating its JavaScript to
  learn what it sets would be a plain remote-code-execution hole.
- **Credentials in a collection are not imported.** Collections routinely have a live token pasted
  into them. The auth *scheme* is referenced by name and configured on your side; the value is left
  behind and you get a warning.

Path parameters default to `{{vars.<name>}}`, which is the single choice that makes an imported
document chain: if an earlier step produced `petId`, a later `/pets/{petId}` picks it up with no
wiring at all.

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
npm install
npm test          # 66 tests, no network
npm run typecheck
```

## Roadmap

- [x] Engine — topological run, context threading, templating, assertions, run-from-here
- [x] Pre-run check — names the step whose `needs` nothing upstream provides
- [x] OpenAPI 3 import
- [x] Postman v2 import, including chaining from test scripts
- [ ] Credential proxy — server-side secret store, per-environment base URLs
- [ ] Canvas — palette, inspector, logs, run controls
- [ ] Save and load journeys
- [ ] Webhook inbox for async steps
- [ ] Assertion editor
- [ ] CLI runner, so a saved journey is a CI check

## License

MIT
