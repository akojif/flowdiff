# flowdiff

Version control and human-readable diffs for n8n workflows, via the n8n public API.
Works with any n8n instance (community edition, self-hosted, n8n Cloud). No server shell access needed.

This is a public, open-source portfolio project. Code quality, tests, and the README matter as much as features.

## Commands (v1)

- `flowdiff init` – create `flowdiff.config.json` (instance URL, workflows folder). Never store the API key in config. `FLOWDIFF_URL` overrides the config's instance URL when set.
- `flowdiff pull` – download workflows as normalized JSON, one file per workflow: `workflows/<slug>.<id>.json`
- `flowdiff status` – per workflow: unchanged / modified locally / modified on instance / conflict
- `flowdiff diff [workflow]` – readable diff: local vs instance (before = instance, after = local, i.e. what push would change), or between git refs (`main..feature`, no network needed); `--json` (never truncated), `--full`, `--include-layout`, `--exit-code`
  - Local vs instance: instance-only workflows are "untracked" (one dim summary line; listed with `--all`; always in JSON; ignored by `--exit-code`). A local workflow with a pull record in `.flowdiff/state.json` that is gone from the instance is "deleted on instance", distinct from a new local-only workflow.
- Tag scope: optional `tag` in `flowdiff.config.json` applies to pull, diff, status and push. Precedence: `--tag <name>` > `--no-tag` > config. Scope = instance workflows with the tag plus every workflow already tracked locally. Git-ref diffs ignore the tag.
- Exit codes: 0 = success / no changes, 1 = changes found (`--exit-code`) or pull conflicts, 2 = any error
- `flowdiff push [workflow]` – upload local changes; always shows diff + asks for confirmation; supports `--dry-run`

## Stack

- TypeScript, Node 22+ (developed on Node 24), ESM
- `commander` (CLI), `@clack/prompts` (interactive prompts), `zod` (config + API response validation), `picocolors`
- Vitest for tests, `tsup` for bundling, `changesets` for releases
- ESLint + Prettier (`eslint-config-prettier` turns off ESLint formatting rules)
- GitHub Actions CI: lint, typecheck, test on every push (Node 22 and 24)

## Architecture

- `src/api/` – typed n8n API client. Base path `/api/v1`, auth header `X-N8N-API-KEY`. Handle cursor pagination.
- `src/normalize/` – strip volatile fields (`updatedAt`, `versionId`, etc.), sort keys, stable formatting. Pulling twice must produce zero git changes.
- `src/diff/` – PURE function `diffWorkflows(before, after): Change[]`. No I/O. Heavily tested.
  - Match nodes by `id`, not name, so renames are detected as renames.
  - Deep-compare node `parameters`; report the exact changed field.
  - Connections are keyed by node NAME in n8n – translate through the id mapping.
  - Ignore canvas `position` changes by default (`--include-layout` to show them).
  - Arrays of objects with unique string `id`s are matched by id (path label = name, or `#id` if names repeat); otherwise by position.
  - Multi-line strings get a line-level diff. Credentials compare by name; id-only changes are ignored.
  - `nodeGroups` are diffed in their own section (added/removed/renamed/description/membership).
  - Settings equivalent when missing (`src/diff/settings.ts`, currently only `binaryMode` = "separate") compare as equal. Add entries only after confirming n8n's runtime behaviour.
  - A parameter key present on one side only, with a scalar or empty value, is labelled `possibleDefault` (the n8n editor strips defaults on save). Never hidden: shown after real changes and counted separately.
  - `classifyChange`: renames, notes, layout, tags, groups and possible defaults are cosmetic; everything else (including anything new) is behavior.
  - `findBrokenReferences`: expressions/Code nodes referencing a node name that doesn't exist (`$('Name')`, `$node["Name"]`, `$node.Name`, `$items('Name')`; sticky notes ignored). Reported as warnings on the after side of changed or new workflows.
- `src/render/` – turn `Change[]` into readable terminal text or JSON.
  - Text: behavior changes first, then `cosmetic:` and `possible defaults:` groups. Display order: deleted, then workflows with broken-reference warnings, then changed (active, most behavior, most cosmetic first), then new. Summary view (one line per workflow) above 5 changed workflows; `--stat` / `--no-stat` force it on/off.
  - JSON: name/id order, never truncated, each change has `impact`, each workflow has `counts` and `warnings`.
- `src/config/` – load `.env`, read/validate `flowdiff.config.json`, resolve the instance URL (env over config) and API key (env only).
- `src/workspace/` – workflow file naming (`<slug>.<id>.json`) and `.flowdiff/state.json` (content hash + instance `versionId` at last pull).
- `src/commands/` – thin command handlers wiring the above together.

## n8n API gotchas

- Workflow update (PUT) rejects read-only fields (`id`, `active`, `createdAt`, `updatedAt`, `tags`, ...). Send only `name`, `nodes`, `connections`, `settings`.
- Activate/deactivate are separate endpoints, not part of the update.
- Credential IDs differ between instances; the API never returns credential secrets. Reference credentials by name and warn if missing.

## Safety rules (important)

- Development runs against the author's LIVE n8n instance.
- During development, `push` MUST refuse any workflow that does not have the tag `flowdiff-test`. Do not remove or bypass this guard.
- Never log, print, or write the API key. Read it only from env: `FLOWDIFF_API_KEY` (loaded from `.env`, which is gitignored). The instance URL comes from `FLOWDIFF_URL` if set, otherwise from `flowdiff.config.json`.
- Before overwriting a workflow on push, save a backup of the instance version to `.flowdiff/backups/`.
- Refuse to push if the instance version changed since the last pull, unless `--force`.
- Never commit real workflows. `workflows/`, `.flowdiff/`, and `.env` are in `.gitignore`.
- Test fixtures in `test/fixtures/` must be made-up workflows with fake values only (no real URLs, tokens, emails, or names).

## Conventions

- Small, focused commits with clear messages.
- Every module in `src/diff/` and `src/normalize/` gets unit tests before it's considered done.
- Prefer clear code over clever code; this repo will be read by recruiters.
- Ask before adding new dependencies.

## Build phases

0. Setup: repo, TypeScript, ESLint, Vitest, CI, folder structure, `.gitignore`, made-up fixtures
1. `init` + `pull` + normalization (done when two pulls in a row produce no git changes)
2. Diff engine + `diff` command (done when added/removed/renamed/modified nodes and connections are tested)
3. `status` + `push` with all safety rules above
   - push must not wipe pinData or staticData on the instance; verify how the update endpoint treats missing fields before shipping push.
   - push must not recreate workflows that are "deleted on instance" (pulled before, now gone) without explicit confirmation.
   - status and push use the same tag scope as diff (`resolveTagScope`).
   - push must refuse, or ask for explicit confirmation, when the workflows being pushed have broken-reference warnings.
4. Polish: GitHub Action posting diffs as PR comments, hard-coded-secret scanner, README with `vhs` demo, npm publish
   - The GitHub Action must redact values the secret scanner flags before posting diffs as PR comments.

## Backlog

- Phase 4: `--exit-code=behavior`, so CI only fails on behavior changes (not cosmetic-only diffs). Workflows with broken-reference warnings count as behavior even when the rename itself is cosmetic; use `hasBehaviorImpact` from `src/diff/classify.ts`.
- Clearer diff header than "instance → local", e.g. "Changes push would make to the instance" (and a matching phrasing for git ranges).
- Opt-in node defaults cache: `flowdiff defaults fetch --n8n-version <v>` downloads `n8n-nodes-base@<v>`'s `dist/types/nodes.json` from npm into `.flowdiff/cache/` (gitignored, never bundled: that data is under n8n's Sustainable Use License, and flowdiff stays MIT). A parameter missing on one side and equal to its declared default for that node type/version on the other would then not count as a change. Unknown type/version: show the change. Note: npm's `latest` tag for n8n-nodes-base is stale; use the version matching the instance (e.g. the `stable` tag).
