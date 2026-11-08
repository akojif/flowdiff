# flowdiff

Version control and human-readable diffs for n8n workflows, via the n8n public API.
Works with any n8n instance (community edition, self-hosted, n8n Cloud). No server shell access needed.

This is a public, open-source portfolio project. Code quality, tests, and the README matter as much as features.

## Commands (v1)

- `flowdiff init` – create `flowdiff.config.json` (instance URL, workflows folder). Never store the API key in config.
- `flowdiff pull` – download workflows as normalized JSON, one file per workflow: `workflows/<slug>.<id>.json`
- `flowdiff status` – per workflow: unchanged / modified locally / modified on instance / conflict
- `flowdiff diff [workflow]` – readable diff: local vs instance, or between git refs (`main..feature`); `--json` for machine output
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
- `src/render/` – turn `Change[]` into readable terminal text or JSON.
- `src/commands/` – thin command handlers wiring the above together.

## n8n API gotchas

- Workflow update (PUT) rejects read-only fields (`id`, `active`, `createdAt`, `updatedAt`, `tags`, ...). Send only `name`, `nodes`, `connections`, `settings`.
- Activate/deactivate are separate endpoints, not part of the update.
- Credential IDs differ between instances; the API never returns credential secrets. Reference credentials by name and warn if missing.

## Safety rules (important)

- Development runs against the author's LIVE n8n instance.
- During development, `push` MUST refuse any workflow that does not have the tag `flowdiff-test`. Do not remove or bypass this guard.
- Never log, print, or write the API key. Read it only from env: `FLOWDIFF_API_KEY` and `FLOWDIFF_URL` (loaded from `.env`, which is gitignored).
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
4. Polish: GitHub Action posting diffs as PR comments, hard-coded-secret scanner, README with `vhs` demo, npm publish
