# flowdiff

[![npm](https://img.shields.io/npm/v/@akojif/flowdiff)](https://www.npmjs.com/package/@akojif/flowdiff)
[![CI](https://github.com/akojif/flowdiff/actions/workflows/ci.yml/badge.svg)](https://github.com/akojif/flowdiff/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Version control and readable diffs for n8n workflows.**

flowdiff pulls your n8n workflows into git as clean JSON files, shows what changed in terms of nodes, parameters and connections instead of raw JSON, and pushes your changes back to n8n with safety checks. It uses the n8n public API, so it works with any n8n instance (Community, self-hosted or Cloud) without server access.

![flowdiff diff in a terminal](docs/demo.gif)

<details>
<summary>The same output as text</summary>

```text
$ flowdiff diff main..feature
Changes from main to feature

~ Fixture: Credential Reference (fixtureCredRef01)
    ⚠ "Forward to API" › headerParameters.parameters[0].value looks like a hard-coded secret (bearer token)
    ~ param   "Forward to API" › headerParameters.parameters[0].value: "=Bearer {{ $env.API_TOKEN }}" → "Bearer ‹redacted bearer token #4d1e›"

~ Fixture: Linear (fixtureLinear001)
    ⚠ "Fetch Items" › url references "Set Defaults", which is not a node in this workflow
    cosmetic:
      ~ node    "Set Defaults" renamed to "Prepare Request"
    possible defaults:
      + param   "Fetch Items" › sendBody: false

~ Fixture: IF Branch (fixtureIfBranch1)  active
    ~ param   "Is Active?" › conditions.conditions[#bbbbbbbb-0000-4000-8000-000000000001].rightValue: "active" → "enabled"
    + node    "Notify Team" (n8n-nodes-base.noOp)
    - link    "Is Active?" (false) → "Mark Inactive"
    + link    "Is Active?" (false) → "Notify Team"

~ Fixture: Code and AI (fixtureCodeNode1)
    ~ param   "Transform Items" › jsCode
              @@ -4,4 +4,4 @@
                 item.json.total = item.json.price * item.json.quantity;
               }

              -return items;
              +return items.filter((item) => item.json.total > 0);

4 changed (3 with behavior changes), 1 unchanged, 1 possible default, 1 broken reference, 1 possible secret.
Possible defaults: likely removed by the n8n editor on save; flowdiff pull refreshes your baseline.
Broken references: these expressions name nodes that don't exist, so those nodes will fail.
Possible secrets are redacted (--show-secrets shows them); use n8n credentials and rotate any real key.
```

</details>

The demo uses made-up workflows (`node scripts/demo-repo.mjs <dir>` recreates it), so no n8n instance is needed.

## Why

Diff two versions of an n8n workflow with git and you mostly see noise: timestamps, version ids, reordered keys and moved nodes. flowdiff normalizes the files so pulling twice never creates a change, then shows what actually changed: renames as renames, IF branches as `true`/`false`, line-by-line Code and prompt diffs, each change marked **behavior** or **cosmetic**, plus warnings for broken node references and pasted tokens.

On n8n Enterprise, the built-in Git source control may already cover your needs; flowdiff works with any edition via the public API and focuses on readable review and CI checks.

## Quick start

Requires Node.js 22 or later.

```sh
npm install -g @akojif/flowdiff   # installs the `flowdiff` command
```

Or run it without installing: `npx @akojif/flowdiff --help`.

```sh
mkdir n8n-workflows && cd n8n-workflows && git init
flowdiff init                       # instance URL, folder, optional tag
echo 'FLOWDIFF_API_KEY=…' >> .env   # n8n: Settings → n8n API (a read-only key is enough)
flowdiff pull && git add . && git commit -m "Baseline"

# …edit workflows in n8n or locally…
flowdiff status                     # what changed where
flowdiff diff                       # what push would change on the instance
flowdiff push --dry-run             # preview, then `flowdiff push`
```

## Commands

| Command           | What it does                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `flowdiff init`   | Create `flowdiff.config.json` and offer to gitignore `.env` and `.flowdiff/`                                                              |
| `flowdiff pull`   | Download workflows as normalized JSON, one file per workflow; never overwrites local edits without `--force`                              |
| `flowdiff status` | Per workflow: unchanged, modified locally, modified on instance, conflict, deleted on instance…                                           |
| `flowdiff diff`   | What push would change; or `diff main..feature` between git refs, no instance needed. `--format markdown\|json`, `--exit-code [behavior]` |
| `flowdiff push`   | Upload local changes after showing the diff and asking. `--dry-run`, `--force`, `--apply-active`                                          |

Full flags, exit codes and JSON output: [docs/commands.md](docs/commands.md).

### Configuration

| Setting            | Where                  |                                                 |
| ------------------ | ---------------------- | ----------------------------------------------- |
| `instanceUrl`      | `flowdiff.config.json` | Your n8n URL. `FLOWDIFF_URL` overrides it.      |
| `workflowsDir`     | `flowdiff.config.json` | Folder for workflow files (default `workflows`) |
| `tag`              | `flowdiff.config.json` | Only track workflows with this tag              |
| `requireTag`       | `flowdiff.config.json` | Tag push requires on every workflow it touches  |
| `FLOWDIFF_API_KEY` | environment or `.env`  | n8n API key; never stored in the config file    |

**Use two API keys.** Keep a read-only key (`workflow:list`) in `.env` for `pull`, `status` and `diff`, and a separate key with only `workflow:list`, `workflow:read` and `workflow:update` for pushing. Shell variables win over `.env`, so you can pass the push key for one command: `FLOWDIFF_API_KEY="$FLOWDIFF_PUSH_KEY" flowdiff push`.

More, including the tag scope and push guard rules: [docs/configuration.md](docs/configuration.md).

## Safety design

Pushing to a live automation platform should be boring. Push:

- **shows the diff and asks first**, with `--dry-run` to preview; it refuses to run without an interactive terminal
- **backs up** the instance version to `.flowdiff/backups/` before every write
- **refuses conflicts**: if a workflow changed in n8n since your last pull, it stops unless you pass `--force`, and it re-checks right before writing
- **has a push guard**: it only touches workflows carrying the guard tag (`requireTag`), locally and in n8n, and pushes nothing until you configure one
- **never puts anything live by itself**: updates are sent with `publishIfActive=false`, and activation only changes with `--apply-active`
- **never sends `pinData` or `staticData`**, so pinned test data and trigger state stay as they are (verified against the live API)
- **never creates or recreates workflows**, and never deletes anything
- **asks again** before sending a workflow with broken references or a newly added secret
- **redacts secrets** in all output, unless you pass `--show-secrets`

Why each of these exists, and the n8n API behaviour behind them: [docs/how-it-works.md](docs/how-it-works.md).

## GitHub Action

**Coming soon:** a GitHub Action that comments on pull requests with this diff (from git alone, no n8n instance or API key) and can fail the check on behavior changes. Planned design and example workflow: [docs/github-action.md](docs/github-action.md).

## Limitations

- **The secret scanner is heuristic**: a clean result means "no known pattern found", not "no secrets".
- **Push only updates** existing workflows: no creating, recreating or deleting.
- **Tags aren't pushed**, and activation only changes with `--apply-active`.
- **Possible defaults** can appear after the n8n editor's first save of an API-created workflow; pull again to refresh.
- **Workflow descriptions aren't synced** (the API's workflow list doesn't include them).
- **The missing-credential warning** needs the `credential:list` scope on the push key.
- **Tested against n8n 2.46.x**; push reports any field a newer n8n version adds that it had to drop.

## How I built this

_Coming soon._

## Development

```sh
npm ci
npm test          # Vitest; no network, n8n is faked
npm run lint && npm run typecheck && npm run build
```

The diff engine (`src/diff/`) and normalization (`src/normalize/`) are pure and tested on made-up fixtures in `test/fixtures/`.

## Disclaimer and license

flowdiff is an independent project. It is not affiliated with, endorsed by or sponsored by n8n GmbH. "n8n" is a trademark of n8n GmbH.

[MIT](LICENSE) © 2026 Francis Akoji
