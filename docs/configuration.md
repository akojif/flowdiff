# Configuration

## `flowdiff.config.json`

Created by `flowdiff init`. Safe to commit: it never contains the API key.

```json
{
  "instanceUrl": "https://n8n.example.com",
  "workflowsDir": "workflows",
  "tag": "flowdiff",
  "requireTag": "flowdiff"
}
```

| Field          | Required |                                                                                          |
| -------------- | -------- | ---------------------------------------------------------------------------------------- |
| `instanceUrl`  | yes      | Your n8n URL, with or without a trailing `/api/v1`. `FLOWDIFF_URL` overrides it.         |
| `workflowsDir` | no       | Folder for workflow files. Default `workflows`.                                          |
| `tag`          | no       | Only track workflows with this tag. Applies to pull, diff, status and push.              |
| `requireTag`   | no       | Tag push requires on every workflow it touches (see below). `false` allows any workflow. |

## Environment variables

flowdiff loads `.env` from the current directory. Variables already set in your shell win over `.env`.

| Variable           |                                                                        |
| ------------------ | ---------------------------------------------------------------------- |
| `FLOWDIFF_API_KEY` | n8n API key (Settings → n8n API). Only ever read from the environment. |
| `FLOWDIFF_URL`     | Overrides `instanceUrl` from the config file.                          |

Keep `.env` out of git (`flowdiff init` offers to add it to `.gitignore`).

## API keys: use two

Use a read-only key day to day and a separate key for pushing, so a write key is never active by accident.

| Key                         | Scopes                                              | Used by                  |
| --------------------------- | --------------------------------------------------- | ------------------------ |
| Read key, in `.env`         | `workflow:list`                                     | `pull`, `status`, `diff` |
| Push key, only when pushing | `workflow:list`, `workflow:read`, `workflow:update` | `push`                   |

Optional scopes on the push key: `credential:list` (lets push warn about credential names missing on the instance; without it the check is skipped), and `workflow:activate` / `workflow:deactivate` (only for `--apply-active`).

Because shell variables win over `.env`, you can keep the push key elsewhere (a password manager, a separate file) and pass it for a single command:

```sh
FLOWDIFF_API_KEY="$FLOWDIFF_PUSH_KEY" flowdiff push
```

## Tag scope

With `tag` set, flowdiff works on workflows that have the tag **plus any workflow already tracked locally**. So removing the tag in n8n doesn't make a tracked workflow vanish: it shows up as a tag change instead. Override per run with `--tag <name>` or `--no-tag`. Diffs between git refs ignore the tag.

## Push guard

Push only touches workflows that carry the guard tag, both in the local file and on the instance. It's strict by default:

| Config                        | Push requires                                     |
| ----------------------------- | ------------------------------------------------- |
| `"requireTag": "x"`           | tag `x`. CLI flags never loosen this.             |
| no `requireTag`, `"tag": "y"` | tag `y`                                           |
| neither                       | nothing can be pushed; push tells you what to add |
| `"requireTag": false`         | no tag (not recommended)                          |

`--force` never bypasses the guard. A workflow you track locally whose tag was removed in n8n is refused.

## Files flowdiff writes

| Path                   | Commit it? |                                                                                  |
| ---------------------- | ---------- | -------------------------------------------------------------------------------- |
| `workflows/*.json`     | yes        | Normalized workflows                                                             |
| `flowdiff.config.json` | yes        | Instance URL, folder, tags                                                       |
| `.flowdiff/state.json` | no         | Hashes and versions from the last pull                                           |
| `.flowdiff/backups/`   | no         | Instance versions saved before each push (full API response, including pin data) |
| `.env`                 | **never**  | API key                                                                          |
