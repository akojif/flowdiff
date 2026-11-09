#!/usr/bin/env node
// Builds a throwaway git repo from the fake test fixtures, for the README demo:
//   node scripts/demo-repo.mjs <empty-dir>
// `main` holds the fixtures; `feature` changes them (a rename that breaks an
// expression, an IF condition and a new branch, a Code node edit, a possible
// default, and a token pasted over an environment variable). Then `flowdiff diff main..feature` shows
// everything without an n8n instance.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const target = process.argv[2];
if (target === undefined) {
  console.error('usage: node scripts/demo-repo.mjs <empty-dir>');
  process.exit(2);
}
const fixtures = new URL('../test/fixtures/', import.meta.url);
const VOLATILE = [
  'createdAt',
  'updatedAt',
  'versionId',
  'isArchived',
  'staticData',
  'pinData',
  'activeVersion',
  'meta',
];

/** A minimal stand-in for flowdiff's normalization: enough for valid workflow files. */
function load(file) {
  const raw = JSON.parse(readFileSync(new URL(file, fixtures), 'utf8'));
  const workflow = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !VOLATILE.includes(key)),
  );
  workflow.tags = (raw.tags ?? []).map((tag) => tag.name);
  return workflow;
}

const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const git = (...args) => execFileSync('git', args, { cwd: target, stdio: 'pipe' });
const node = (workflow, name) => workflow.nodes.find((n) => n.name === name);

function write(workflows) {
  rmSync(join(target, 'workflows'), { recursive: true, force: true });
  mkdirSync(join(target, 'workflows'), { recursive: true });
  for (const w of workflows) {
    writeFileSync(
      join(target, 'workflows', `${slugify(w.name)}.${w.id}.json`),
      `${JSON.stringify(w, null, 2)}\n`,
    );
  }
}

function base() {
  const workflows = readdirSync(fixtures)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map(load);
  const linear = workflows.find((w) => w.id === 'fixtureLinear001');
  // An expression that uses another node by name, so a rename can break it.
  node(linear, 'Fetch Items').parameters.url =
    "={{ 'https://api.example.com/items?limit=' + $('Set Defaults').item.json.limit }}";
  // A header that reads its token from the environment, as it should.
  const forward = node(
    workflows.find((w) => w.id === 'fixtureCredRef01'),
    'Forward to API',
  );
  forward.parameters.sendHeaders = true;
  forward.parameters.headerParameters = {
    parameters: [{ name: 'Authorization', value: '=Bearer {{ $env.API_TOKEN }}' }],
  };
  return workflows;
}

mkdirSync(target, { recursive: true });
git('init', '--quiet', '--initial-branch=main');
git('config', 'user.email', 'demo@example.com');
git('config', 'user.name', 'flowdiff demo');
writeFileSync(
  join(target, 'flowdiff.config.json'),
  `${JSON.stringify({ instanceUrl: 'https://n8n.example.com', workflowsDir: 'workflows' }, null, 2)}\n`,
);
write(base());
git('add', '--all');
git('commit', '--quiet', '-m', 'Workflows on main');

git('switch', '--quiet', '-c', 'feature');
const changed = base();
const byId = (id) => changed.find((w) => w.id === id);

// 1. Rename a node but forget the expression that refers to it; add an explicit
//    default value (as API-created workflows often have).
const linear = byId('fixtureLinear001');
node(linear, 'Set Defaults').name = 'Prepare Request';
linear.connections = JSON.parse(
  JSON.stringify(linear.connections).replaceAll('"Set Defaults"', '"Prepare Request"'),
);
node(linear, 'Fetch Items').parameters.sendBody = false;

// 2. Change the IF condition and send the false branch to a new node.
const ifBranch = byId('fixtureIfBranch1');
node(ifBranch, 'Is Active?').parameters.conditions.conditions[0].rightValue = 'enabled';
ifBranch.nodes.push({
  id: '22222222-2222-4222-8222-000000000005',
  name: 'Notify Team',
  type: 'n8n-nodes-base.noOp',
  typeVersion: 1,
  position: [660, 200],
  parameters: {},
});
ifBranch.connections['Is Active?'].main[1] = [{ node: 'Notify Team', type: 'main', index: 0 }];

// 3. Edit the Code node.
const code = node(byId('fixtureCodeNode1'), 'Transform Items');
code.parameters.jsCode = code.parameters.jsCode.replace(
  'return items;',
  'return items.filter((item) => item.json.total > 0);',
);

// 4. Replace the environment variable with a pasted token (fake value).
node(byId('fixtureCredRef01'), 'Forward to API').parameters.headerParameters.parameters[0].value =
  'Bearer demo_7f3k9q2x8m4p6r1t5v0w3y8z2b6n4j1h';

write(changed);
git('add', '--all');
git('commit', '--quiet', '-m', 'Feature changes');
console.log(`Demo repo ready in ${target} (branches: main, feature)`);
