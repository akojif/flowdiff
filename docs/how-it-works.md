# How it works

flowdiff talks to n8n only through the [public API](https://docs.n8n.io/api/) (`/api/v1`, `X-N8N-API-KEY`), so it needs no shell access to the server and works with any edition.

## Normalization

n8n returns workflows with fields that change without anyone editing them. Before writing a file, flowdiff:

- removes volatile and runtime fields: `createdAt`, `updatedAt`, `versionId`, `activeVersionId`, `activeVersion`, `versionCounter`, `triggerCount`, `shared`, `meta`, `isArchived`, `staticData` (runtime state) and `pinData` (can contain real execution data)
- reduces tags to a sorted list of names
- sorts object keys at every depth, keeping array order
- keeps fields it doesn't recognize, and says so on pull

The result: pulling twice in a row produces no git changes.

## The diff engine

`diffWorkflows(before, after)` is a pure function (no I/O) in [`src/diff/`](../src/diff/).

- **Nodes are matched by id**, not name, so a renamed node is reported as a rename.
- **Connections** are keyed by node _name_ in n8n. flowdiff rewrites them in terms of node ids first, so renaming a node doesn't show its connections as removed and re-added. IF and Filter outputs are labelled (`true`/`false`, `kept`/`discarded`).
- **Parameters** are compared recursively and every change reports its exact path, e.g. `assignments.assignments[limit].value`. Lists whose items all have a unique `id` (Set assignments, IF conditions) are matched by id, so removing the first item doesn't make every later item look changed.
- **Multi-line strings** (Code nodes, AI prompts, SQL) get a line-level diff.
- **Credentials** are compared by name; credential ids differ between instances.
- **Node positions** are ignored unless you pass `--include-layout`.
- **Settings** that behave the same when missing (`binaryMode` = `separate`) compare as equal.

### Behavior vs cosmetic

Every change is classified. Renames, notes, layout, tags and node groups are **cosmetic**; everything else (nodes, parameters, connections, credentials, settings, activation, unknown fields) is **behavior**. New kinds of change default to behavior, so nothing gets played down by accident. `diff --exit-code behavior` and the Action's `fail-on: behavior` use this.

### Possible defaults

When you save a workflow in the n8n editor, it removes parameters that equal their default value. A workflow created through the API or imported may still contain them, so its first editor save looks like several changed parameters. flowdiff labels "present on one side, missing on the other" as a **possible default**, lists it separately and never hides it. Pulling again refreshes your baseline.

### Broken references

Expressions and Code nodes refer to other nodes by name: `$('Name')`, `$node["Name"]`, `$items('Name')`. If a referenced name doesn't exist in the workflow (typically after a rename where the expression wasn't updated), flowdiff warns. Such workflows sort to the top and count as behavior changes, even though the rename itself is cosmetic.

## Secret scanner

flowdiff looks for likely hard-coded secrets in node parameters and notes:

- common token formats (AWS, GitHub, Slack, Stripe, OpenAI, Anthropic, Google, SendGrid, JWTs), private keys, bearer and basic auth, passwords in URLs, secrets assigned in Code nodes
- literal values under sensitive names (`apiKey`, `password`, `Authorization`, ...), including n8n's header lists (`{ name: "Authorization", value: "..." }`)

Values that read from n8n's own stores (`{{ $env.X }}`, `$vars`, `$secrets`) are skipped.

Both versions of a workflow are redacted **before** diffing, so no output format can print a secret by accident. Each value becomes a marker like `‹redacted bearer token #3f9a›`; the short fingerprint lets a changed secret still show up as a change. `--show-secrets` turns redaction off for `diff` and `push`. What push sends is always built from your real file, never from the redacted copy.

The scanner is heuristic. A clean result means "no known pattern found", not "no secrets". Prefer n8n credentials over pasted tokens, and rotate any real secret that was committed: redacting output doesn't remove it from git history.

## n8n API behaviour flowdiff relies on

Verified against n8n 2.46 (source and a live instance):

- `PUT /workflows/{id}` validates the body strictly at every level: unknown top-level fields, node fields or settings make n8n reject the request. flowdiff builds the body field by field from allow-lists and reports anything it drops.
- Fields left out of an update are not touched. A live test confirmed `pinData` and `staticData` survive an update that doesn't include them, which is why push never sends them.
- Updating an active (published) workflow re-publishes it unless `?publishIfActive=false` is passed. push always passes it.
- n8n merges settings with the stored ones and removes values equal to its defaults.
- On update, n8n resolves a credential id it doesn't know by name and type.
- `GET /workflows` (the list) and `GET /workflows/{id}` return different fields; the single GET adds `description` and `sourceWorkflowId`. Every hash flowdiff compares comes from the list, so pull, status and push always compare like with like. The single GET is used only for backups.
