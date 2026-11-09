# Command reference

All commands read `flowdiff.config.json` from the current directory and the API key from `FLOWDIFF_API_KEY` (see [configuration](configuration.md)). Only `diff <a>..<b>` works without an n8n instance.

## `flowdiff init`

Interactive. Asks for the instance URL, the folder for workflow files (default `workflows`) and an optional tag, writes `flowdiff.config.json`, and offers to add `.env` and `.flowdiff/` to `.gitignore`. It never asks for the API key.

## `flowdiff pull`

Downloads workflows as normalized JSON, one file per workflow: `workflows/<slug>.<id>.json`. Pulling twice in a row produces no git changes.

| Flag           |                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `--tag <name>` | Only pull workflows with this tag (overrides the saved tag). In an interactive terminal, offers to save it. |
| `--no-tag`     | Ignore the saved tag for this run.                                                                          |
| `--force`      | Overwrite local edits even if the workflow also changed on the instance.                                    |

Pull protects local work: a file you edited since the last pull is only overwritten with `--force`. Renamed workflows are moved to their new file name; workflows deleted on the instance are reported, never deleted locally. Pull warns when a pulled file contains a possible hard-coded secret, and when a workflow has a top-level field flowdiff doesn't know yet.

## `flowdiff status`

Shows each workflow's sync state, comparing content hashes with the last pull (`.flowdiff/state.json`).

| State                | Meaning                                                  |
| -------------------- | -------------------------------------------------------- |
| unchanged            | in sync                                                  |
| modified locally     | edited locally since the last pull (`flowdiff push`)     |
| modified on instance | changed in n8n since the last pull (`flowdiff pull`)     |
| conflict             | changed on both sides                                    |
| deleted on instance  | pulled before, gone from the instance                    |
| new locally          | a local file that was never on the instance              |
| no pull record       | on both sides but never pulled here (e.g. a fresh clone) |
| untracked            | on the instance only; shown as one summary line          |

Flags: `--tag <name>`, `--no-tag`, `--all` (list untracked workflows), `--json`.

## `flowdiff diff`

```sh
flowdiff diff                      # all workflows: what push would change (instance → local)
flowdiff diff "Order Sync"         # one workflow, by name, id, file name or slug
flowdiff diff main..feature        # workflow files between two git refs (no instance needed)
```

| Flag                              |                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `--format <text\|json\|markdown>` | Output format (default `text`). `--json` is shorthand for `--format json`.                     |
| `--stat` / `--no-stat`            | Force the one-line-per-workflow summary on or off. It's the default above 5 changed workflows. |
| `--full`                          | Show long values in full instead of truncating them (JSON is never truncated).                 |
| `--include-layout`                | Also show node position changes.                                                               |
| `--show-secrets`                  | Show values that look like secrets instead of redacting them.                                  |
| `--exit-code [mode]`              | Exit with 1 on any change (`changes`, the default) or only on behavior changes (`behavior`).   |
| `--all`                           | List untracked instance workflows individually.                                                |
| `--tag <name>`, `--no-tag`        | Tag scope (local vs instance only; git ranges ignore it).                                      |

Changes are split into **behavior** changes (nodes, parameters, connections, credentials, settings, activation) and **cosmetic** ones (renames, notes, layout, tags, node groups), with **possible defaults** listed separately. See [how it works](how-it-works.md).

## `flowdiff push`

Uploads local changes. Always shows the diff and asks for confirmation.

| Flag                       |                                                                             |
| -------------------------- | --------------------------------------------------------------------------- |
| `--dry-run`                | Show what would be pushed and change nothing.                               |
| `--force`                  | Overwrite even if the workflow changed on the instance since the last pull. |
| `--apply-active`           | Also activate/deactivate workflows to match the local files.                |
| `--show-secrets`           | Show secret values in the diff (what is sent never changes).                |
| `--tag <name>`, `--no-tag` | Tag scope; see the push guard in [configuration](configuration.md).         |

Push asks separately, defaulting to No, before sending a workflow that has broken references or that adds or changes a possible secret. It refuses to run without an interactive terminal. See the [safety design](../README.md#safety-design).

## Exit codes

| Code | Meaning                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------- |
| 0    | Success, or no changes                                                                                        |
| 1    | `diff --exit-code` found changes; `pull` hit a conflict; `push` refused or skipped something, or you declined |
| 2    | An error (including invalid flags), or a `push` update failed                                                 |

## JSON output

`flowdiff diff --json` prints:

```json
{
  "before": "main",
  "after": "feature",
  "workflows": [
    {
      "id": "fixtureLinear001",
      "name": "Fixture: Linear",
      "status": "changed",
      "active": false,
      "counts": { "behavior": 1, "cosmetic": 1, "possibleDefaults": 0 },
      "changes": [{ "kind": "node-renamed", "impact": "cosmetic", "...": "..." }],
      "warnings": [],
      "secrets": []
    }
  ]
}
```

`status` is one of `changed`, `unchanged`, `only-before`, `only-after`, `untracked`, `deleted-on-instance`. Every change has a `kind` and an `impact` (`behavior` or `cosmetic`); the change types are defined in [`src/diff/types.ts`](../src/diff/types.ts). Secret values are redacted unless `--show-secrets` is passed. Workflows are sorted by name, then id.
