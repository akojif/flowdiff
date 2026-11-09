# GitHub Action

> **Coming in a later release.** The Action isn't part of flowdiff 0.1.0 yet. This page describes how it will work.

The Action comments on pull requests with a readable diff of the n8n workflow files they change. It uses git only: no n8n instance and no API key.

## Example workflow

```yaml
# .github/workflows/flowdiff.yml
name: flowdiff

on:
  pull_request:
    paths:
      - 'workflows/**'

permissions:
  contents: read
  pull-requests: write # to post the comment

concurrency:
  group: flowdiff-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0 # flowdiff needs the merge base
      - uses: akojif/flowdiff@v0
        with:
          fail-on: behavior
```

## Inputs

| Input               | Default               |                                                                                                                                                 |
| ------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `fail-on`           | `none`                | `none`, `changes` (any difference), or `behavior` (behavior changes, broken references, or added/removed workflows; cosmetic-only changes pass) |
| `comment`           | `true`                | Post or update the pull request comment                                                                                                         |
| `working-directory` | `.`                   | Folder containing `flowdiff.config.json`                                                                                                        |
| `token`             | `${{ github.token }}` | Used only to comment                                                                                                                            |

There is no input to show secrets: the Action always redacts them.

## Outputs

| Output        |                                                                      |
| ------------- | -------------------------------------------------------------------- |
| `changed`     | Number of workflows that changed, were added or were removed         |
| `behavior`    | `true` if any change would fail `fail-on: behavior`                  |
| `report-path` | Path to the full Markdown report, e.g. for `actions/upload-artifact` |

## What it does

1. Diffs the pull request from its **merge base** to its head, the same range GitHub's "Files changed" tab shows, so changes that landed on the base branch later don't appear reversed.
2. Writes the full report to the **job summary** (the workflow run page) and to `report-path`.
3. Keeps **one comment** on the pull request up to date: created on the first run, edited on later pushes. If a later push removes all workflow changes, the comment says so.
4. Applies `fail-on`.

## Size limits

GitHub comments are limited to 65,536 characters. The comment always contains the summary table for every workflow; per-workflow details are added in order of importance (broken references and secrets first, then active workflows with the most behavior changes) until the limit, followed by a notice linking to the full report in the job summary.

## Pull requests from forks

For pull requests from forks, GitHub gives workflows a read-only token, so the Action can't comment. It then writes the report to the job summary, prints a notice, and doesn't fail because of it.

The Action refuses to run on `pull_request_target`, which runs with a write token and secrets and is unsafe for code from forks. If you need comments on fork pull requests, the safe pattern is a second workflow triggered by `workflow_run`. That isn't built in yet.

## Security notes

- Secrets are always redacted, in the comment, the job summary and the report file.
- Workflow names, values and refs come from the pull request, so all of it is escaped: HTML, table syntax and code fences, and `@mentions` are neutralized so a workflow name can't ping anyone.
- The token is only used to list, create and update comments on the pull request.
