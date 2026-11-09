---
'@akojif/flowdiff': patch
---

GitHub Action: `uses: akojif/flowdiff@v0` comments on pull requests with a readable diff of the n8n workflow files they change (git only, no n8n instance or API key), keeps one comment up to date, writes the full report to the job summary, always redacts secrets, and can fail the check with `fail-on: changes` or `fail-on: behavior`.
