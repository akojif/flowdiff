# @akojif/flowdiff

## 0.1.1

### Patch Changes

- 38daf56: `diff --stat` no longer shortens workflow names when output is piped to a file or another program; names are only fitted to the width in an interactive terminal.

## 0.1.0

### Minor Changes

- First release. `init`, `pull`, `status`, `diff` and `push` for n8n workflows via the public API: normalized workflow files that pull cleanly into git, readable diffs (nodes matched by id, connections, IF branches, line-level Code diffs, behavior vs cosmetic, possible defaults, broken references), git-ref diffs without an instance, Markdown and JSON output, and a guarded push with confirmations, backups, conflict checks and secret redaction.
