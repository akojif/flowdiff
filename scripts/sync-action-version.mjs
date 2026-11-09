#!/usr/bin/env node
// Pins action.yml to the package version: `npx --yes @akojif/flowdiff@X.Y.Z`.
// Run by `npm run version-packages` after `changeset version`.
//   node scripts/sync-action-version.mjs           update action.yml
//   node scripts/sync-action-version.mjs --check   exit 1 if it is out of sync
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const { name, version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const actionUrl = new URL('action.yml', root);
const action = readFileSync(actionUrl, 'utf8');

const pin = new RegExp(`${name.replace('/', '\\/')}@\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?`, 'g');
const pins = action.match(pin) ?? [];
if (pins.length !== 1) {
  console.error(
    `action.yml should contain exactly one ${name}@<version> pin, found ${String(pins.length)}.`,
  );
  process.exit(1);
}

const expected = `${name}@${version}`;
if (pins[0] === expected) {
  console.log(`action.yml already pins ${expected}`);
} else if (process.argv.includes('--check')) {
  console.error(
    `action.yml pins ${pins[0]}, but package.json is ${version}. Run: node scripts/sync-action-version.mjs`,
  );
  process.exit(1);
} else {
  writeFileSync(actionUrl, action.replace(pin, expected));
  console.log(`action.yml now pins ${expected}`);
}
