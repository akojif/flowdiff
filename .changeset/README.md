# Changesets

Each pull request that changes behaviour adds a changeset: `npx changeset` asks for the bump type (patch, minor, major) and a one-line summary for the changelog.

To release (see "Releasing" in CLAUDE.md):

```sh
npx changeset version   # bumps package.json, writes CHANGELOG.md, deletes used changesets
git commit -am "chore: release vX.Y.Z"
git tag -a vX.Y.Z -m "flowdiff X.Y.Z" && git push origin main vX.Y.Z
```

Pushing the tag starts `.github/workflows/release.yml`, which publishes to npm after approval.
