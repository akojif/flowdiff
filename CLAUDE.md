# flowdiff

Version control and human-readable diffs for n8n workflows, via the n8n public API.
Works with any n8n instance (community edition, self-hosted, n8n Cloud). No server shell access needed.

This is a public, open-source portfolio project. Code quality, tests, and the README matter as much as features.

## Commands (v1)

- `flowdiff init` – create `flowdiff.config.json` (instance URL, workflows folder). Never store the API key in config. `FLOWDIFF_URL` overrides the config's instance URL when set.
- `flowdiff pull` – download workflows as normalized JSON, one file per workflow: `workflows/<slug>.<id>.json`
- `flowdiff status` – per workflow: unchanged / modified locally / modified on instance / conflict / deleted on instance / new locally / no pull record (content hashes vs `.flowdiff/state.json`, tag scope); `--json`, `--all`
- `flowdiff diff [workflow]` – readable diff: local vs instance (before = instance, after = local, i.e. what push would change), or between git refs (`main..feature`, no network needed); `--json` (never truncated), `--full`, `--include-layout`, `--exit-code`
  - Local vs instance: instance-only workflows are "untracked" (one dim summary line; listed with `--all`; always in JSON; ignored by `--exit-code`). A local workflow with a pull record in `.flowdiff/state.json` that is gone from the instance is "deleted on instance", distinct from a new local-only workflow.
- Tag scope: optional `tag` in `flowdiff.config.json` applies to pull, diff, status and push. Precedence: `--tag <name>` > `--no-tag` > config. Scope = instance workflows with the tag plus every workflow already tracked locally. Git-ref diffs ignore the tag.
- Exit codes: 0 = success / no changes, 1 = changes found (`--exit-code`) or pull conflicts, 2 = any error
- `flowdiff push [workflow]` – upload local changes; always shows diff + asks for confirmation; supports `--dry-run`, `--force`, `--apply-active`
  - Pure planner (`src/push/plan.ts`) + executor (`src/push/execute.ts`). Skips new-locally and deleted-on-instance workflows (never creates or recreates), doesn't push tag changes, changes active only with `--apply-active`, asks separately for workflows with broken references, refuses without an interactive terminal (no `--yes`).
  - Per workflow: re-fetch, re-check dev guard + pull record, backup to `.flowdiff/backups/<id>/<timestamp>.json`, PUT with `publishIfActive=false`, optional activate/deactivate, then refresh the local file and pull record.
  - Exit codes: 0 = pushed (or nothing to do), 1 = something refused/declined, 2 = an update failed.

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
- `src/secrets/` – heuristic secret scanner (known token formats, private keys, bearer/basic auth, URL credentials, secrets assigned in code, literal values at sensitive names incl. n8n name/value header lists). `compareWorkflowSets` redacts BOTH workflows before diffing (fingerprinted markers like `‹redacted bearer token #3f9a›`), so every renderer gets redacted data; `--show-secrets` (diff, push) turns it off. The push request body is always built from the real local file, never the redacted copy. Warnings in diff, status, pull ("check before committing") and push; push asks (default No) only when it adds or changes a secret. Test tokens are assembled at run time.
- `src/render/` – turn `Change[]` into readable terminal text, JSON or Markdown (`renderMarkdown`, shared by `diff --format markdown` and the Action; escapes HTML/table syntax/@mentions and uses fences longer than any backtick run).
  - Text: behavior changes first, then `cosmetic:` and `possible defaults:` groups. Display order: deleted, then workflows with broken-reference warnings, then changed (active, most behavior, most cosmetic first), then new. Summary view (one line per workflow) above 5 changed workflows; `--stat` / `--no-stat` force it on/off.
  - JSON: name/id order, never truncated, each change has `impact`, each workflow has `counts` and `warnings`.
- `src/config/` – load `.env`, read/validate `flowdiff.config.json`, resolve the instance URL (env over config) and API key (env only).
- `src/workspace/` – workflow file naming (`<slug>.<id>.json`) and `.flowdiff/state.json` (content hash + instance `versionId` at last pull).
- `src/commands/` – thin command handlers wiring the above together.
- `src/action/` – GitHub Action logic, run via the hidden `flowdiff github-action` command (inputs from env). `pull_request` only (refuses `pull_request_target`), diffs merge-base..head with `compareGitRefs` (always redacted; no show-secrets path), one sticky comment (`<!-- flowdiff-report -->`, posted by a Bot) within `COMMENT_MAX_LENGTH`, full report in the job summary and `report-path`, falls back to the job summary on 403/404 (fork PRs), `fail-on: none|changes|behavior` via `shouldFail`. No @actions/* dependencies: small helpers with delimiter-safe GITHUB_OUTPUT writing. `action.yml` (composite) passes inputs as `INPUT_FAIL_ON`-style env names: `npx` starts flowdiff through `/bin/sh`, which is dash on Ubuntu runners, and dash drops hyphenated names like `INPUT_FAIL-ON` (verified with a probe on a runner; macOS's `/bin/sh` keeps them, so it doesn't reproduce locally). A test enforces valid shell identifiers.

## n8n API gotchas

- Workflow update (PUT) rejects read-only fields (`id`, `active`, `createdAt`, `updatedAt`, `tags`, ...). Send only `name`, `nodes`, `connections`, `settings`.
- Activate/deactivate are separate endpoints, not part of the update.
- Credential IDs differ between instances; the API never returns credential secrets. Reference credentials by name and warn if missing.

Verified against n8n 2.46 source and live (2026-11-09):

- `PUT /workflows/{id}` body is STRICT at every level (unknown top-level fields, node fields or settings keys → 400). Writable: `name`, `nodes`, `connections`, `settings` (required), optional `nodeGroups` (`nodeIds` is an array), `description`, `staticData`, `pinData`. Read-only: `id`, `active`, `tags`, `meta`, `versionId`, timestamps, `shared`. push builds the body field by field from allow-lists in `src/push/request-body.ts` and drops anything else with a warning.
- Omitted `pinData` / `staticData` are NOT touched (only sent fields are written). Verified live: markers in both survived an update without them, and `versionId` only changes when nodes/connections/nodeGroups change. push never sends them. Content-hash change detection relies on this.
- Updating an active (published) workflow re-publishes it automatically unless `?publishIfActive=false`. push always sends `publishIfActive=false`; publishing/activation only happens via `--apply-active` (separate activate/deactivate endpoints).
- Settings are merged with the stored settings, then n8n strips values equal to its defaults. `binaryMode` is accepted but dropped.
- On update n8n resolves credentials whose id doesn't exist by name + type within the project (if exactly one matches). Listing credentials (`GET /credentials`) needs the `credential:list` API key scope; without it push skips the missing-credential check and says so.
- Tags are set via a separate endpoint (`PUT /workflows/{id}/tags`, tag ids); push does not push tag changes.
- The list endpoint and the single GET return different fields: `GET /workflows/{id}` adds `description`, `sourceWorkflowId`, `versionCounter` (and pin data on request). Every hash flowdiff compares (pull, status, push's pre-write check and post-push refresh) must come from the list endpoint; push uses the list filtered by the dev-guard tag (`listedVersion`). The single GET is only for backups. The test fake client mimics this difference.

## Safety rules (important)

- Development runs against the author's LIVE n8n instance.
- Push guard (`src/config/push-guard.ts`): push only touches workflows carrying the guard tag, locally AND on the instance. Guard = `requireTag` (string) if set, else the tag scope's tag (`tag` / `--tag`); nothing set → push refuses everything and tells the user what to add; `requireTag: false` is the only way to allow untagged workflows. `--force`, `--tag` and `--no-tag` never loosen a `requireTag`. Do not weaken these defaults.
- During development, the author's config sets `"requireTag": "flowdiff-test"`.
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
3. `status` + `push` with all safety rules above (built; first live push still needs the author's approval)
   - push must not wipe pinData or staticData on the instance; verify how the update endpoint treats missing fields before shipping push.
   - push must not recreate workflows that are "deleted on instance" (pulled before, now gone) without explicit confirmation.
   - status and push use the same tag scope as diff (`resolveTagScope`).
   - push must refuse, or ask for explicit confirmation, when the workflows being pushed have broken-reference warnings.
4. Polish: GitHub Action posting diffs as PR comments, hard-coded-secret scanner, README with `vhs` demo, npm publish
   - Order: Markdown renderer + Action logic (done) → README + docs/ (done; `docs/demo.gif` from `vhs docs/demo.tape`, built on `scripts/demo-repo.mjs`) → npm release 0.1.0 (prepared; see Releasing) → composite `action.yml` running `npx @akojif/flowdiff@<exact version> github-action`, with `actions/setup-node` pinning Node → demo repo `akojif/flowdiff-demo` (ask first). README example workflow uses minimal permissions and a `concurrency` group.
   - `--exit-code [changes|behavior]` is done (`shouldFail`): behavior = behavior changes, broken references, or added/removed workflows.
   - The GitHub Action must redact values the secret scanner flags before posting diffs as PR comments. It must NEVER allow `--show-secrets` (no input, no passthrough).

## Releasing

- Versions are managed with changesets: each behaviour change adds one (`npx changeset`). To release: `npx changeset version`, commit, `git tag -a vX.Y.Z`, push the commit and the tag.
- `.github/workflows/release.yml` publishes on `v*` tags via npm trusted publishing (OIDC, no token; provenance is automatic). It runs in the `npm` GitHub environment (required reviewer, `v*` tags only), checks the tag matches `package.json`, skips versions already on npm, and `prepublishOnly` runs lint, typecheck, tests and build.
- The npm trusted publisher must name owner `akojif`, repository `flowdiff`, workflow `release.yml`, environment `npm`; `repository.url` in package.json must match the repo exactly. A new trusted publisher configuration expires if it isn't used for a successful publish within 2 days. Trusted publishing needs npm >= 11.5.1 in CI (the workflow installs npm@11).
- The npm package is `@akojif/flowdiff` (npm rejected the unscoped name as too similar to `flow-diff`); the command is still `flowdiff`. `publishConfig.access` is `public`, because scoped packages are private by default.
- The package ships only `dist/cli.js`, README, LICENSE and (later) `action.yml`; no source map. Check with `npm pack --dry-run`.
- The author does the publishing; never push release tags or publish without being asked.

## Backlog

- npm audit (2026-11-09): 9 moderate findings, all dev-only (`npm audit --omit=dev` is clean), from one minimatch advisory (GHSA-g3hv-75wg-m249) via eslint and typescript-eslint. Fixed only in minimatch 11.0.1+, which even the latest eslint/typescript-eslint don't accept (`^10`); `npm audit fix --force` would downgrade eslint. Revisit when they move to minimatch 11.
- Description syncing: the list endpoint doesn't return `description`, so it is never pulled or pushed (n8n keeps it untouched). Syncing it would mean fetching each workflow with the single GET (one request per workflow) and hashing that shape everywhere.
- Future CI push mode: needs a non-interactive path (no `--yes` today) with extra safeguards, e.g. an explicit allow-list of workflow ids, `--exit-code` on refusals, and a separate write key.
- Action `fail-on: secrets` (secrets currently only warn and suggest key rotation).
- Comments on fork PRs via the safe two-workflow `workflow_run` pattern (never `pull_request_target`).
- Opt-in node defaults cache: `flowdiff defaults fetch --n8n-version <v>` downloads `n8n-nodes-base@<v>`'s `dist/types/nodes.json` from npm into `.flowdiff/cache/` (gitignored, never bundled: that data is under n8n's Sustainable Use License, and flowdiff stays MIT). A parameter missing on one side and equal to its declared default for that node type/version on the other would then not count as a change. Unknown type/version: show the change. Note: npm's `latest` tag for n8n-nodes-base is stale; use the version matching the instance (e.g. the `stable` tag).
