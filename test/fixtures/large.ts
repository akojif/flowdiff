/**
 * A generated set of 50 made-up workflows for testing large diffs. Deterministic:
 * the same seed always gives the same workflows, so snapshots stay stable.
 * All values are fake (example.com URLs, invented names).
 *
 * Each workflow is assigned a scenario by index, so the mix is fixed:
 *   0–11  unchanged                       12–21 cosmetic only
 *   22–36 behavior changes (1 to ~12)     37–38 only local (new)
 *   39    deleted on instance             40–42 untracked (instance only)
 *   43–44 rename without updating refs    45    rename with refs updated
 *   46–49 behavior + cosmetic mixed
 */
import type { NormalizedWorkflow } from '../../src/normalize/normalize.js';

export interface LargeFixture {
  /** Before side (the instance). */
  instance: Map<string, NormalizedWorkflow>;
  /** After side (local files). */
  local: Map<string, NormalizedWorkflow>;
  /** Workflow ids with a pull record. */
  pulledIds: Set<string>;
}

const SUBJECTS = ['Invoice', 'Order', 'Lead', 'Ticket', 'Report', 'Refund', 'Signup', 'Shipment'];
const ACTIONS = ['Sync', 'Router', 'Digest', 'Cleanup', 'Alert', 'Import'];

type Node = NormalizedWorkflow['nodes'][number];

/** Small seeded PRNG (mulberry32), so the fixture does not depend on Math.random. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function baseWorkflow(index: number, random: () => number): NormalizedWorkflow {
  const id = `largeFixture${pad(index)}`;
  const subject = SUBJECTS[index % SUBJECTS.length] ?? 'Item';
  const action = ACTIONS[Math.floor(index / SUBJECTS.length) % ACTIONS.length] ?? 'Sync';
  const nodeId = (n: number) => `${id}-node-${String(n)}`;
  const nodes: Node[] = [
    {
      id: nodeId(1),
      name: 'Schedule',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
      parameters: { rule: { interval: [{ field: 'hours' }] } },
    },
    {
      id: nodeId(2),
      name: 'Fetch Records',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [220, 0],
      parameters: { url: `https://api.example.com/${subject.toLowerCase()}s`, options: {} },
    },
    {
      id: nodeId(3),
      name: 'Has Records?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [440, 0],
      parameters: { conditions: { combinator: 'and', conditions: [] }, options: {} },
    },
    {
      id: nodeId(4),
      name: 'Transform',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [660, -100],
      parameters: {
        jsCode: `const limit = ${String(10 + Math.floor(random() * 90))};\nconst rows = $('Fetch Records').all();\nreturn rows.slice(0, limit);\n`,
      },
    },
    {
      id: nodeId(5),
      name: 'Nothing To Do',
      type: 'n8n-nodes-base.noOp',
      typeVersion: 1,
      position: [660, 100],
      parameters: {},
    },
  ];
  return {
    id,
    name: `${subject} ${action} ${pad(index)}`,
    active: random() < 0.3,
    tags: ['flowdiff-test'],
    nodes,
    connections: {
      Schedule: { main: [[{ node: 'Fetch Records', type: 'main', index: 0 }]] },
      'Fetch Records': { main: [[{ node: 'Has Records?', type: 'main', index: 0 }]] },
      'Has Records?': {
        main: [
          [{ node: 'Transform', type: 'main', index: 0 }],
          [{ node: 'Nothing To Do', type: 'main', index: 0 }],
        ],
      },
    },
    settings: { executionOrder: 'v1' },
  };
}

function node(workflow: NormalizedWorkflow, name: string): Node {
  const found = workflow.nodes.find((n) => n.name === name);
  if (found === undefined) throw new Error(`fixture has no node ${name}`);
  return found;
}

/** Renames a node and rewrites connections; optionally rewrites `$('Old')` references too. */
function renameNode(
  workflow: NormalizedWorkflow,
  from: string,
  to: string,
  updateReferences: boolean,
): void {
  node(workflow, from).name = to;
  const renamed = JSON.stringify(workflow.connections).replaceAll(`"${from}"`, `"${to}"`);
  workflow.connections = JSON.parse(renamed) as NormalizedWorkflow['connections'];
  if (updateReferences) {
    for (const n of workflow.nodes) {
      n.parameters = JSON.parse(
        JSON.stringify(n.parameters).replaceAll(`$('${from}')`, `$('${to}')`),
      ) as Node['parameters'];
    }
  }
}

function applyCosmetic(workflow: NormalizedWorkflow, variant: number): void {
  switch (variant % 5) {
    case 0:
      node(workflow, 'Nothing To Do').name = 'Skip';
      workflow.connections['Has Records?'] = {
        main: [
          [{ node: 'Transform', type: 'main', index: 0 }],
          [{ node: 'Skip', type: 'main', index: 0 }],
        ],
      };
      break;
    case 1:
      Object.assign(node(workflow, 'Transform'), { notes: 'Keeps the first rows only' });
      break;
    case 2:
      // Layout alone is ignored by default, so pair it with a visible cosmetic change.
      node(workflow, 'Transform').position = [700, -120];
      workflow.name = `${workflow.name} (old)`;
      break;
    case 3:
      // Local still has an explicit default that the editor stripped on the instance.
      node(workflow, 'Fetch Records').parameters.method = 'GET';
      break;
    default:
      workflow.tags = [...workflow.tags, 'reviewed'];
  }
}

/** Applies `count` behavior changes, cycling through change types. */
function applyBehavior(workflow: NormalizedWorkflow, count: number): void {
  for (let i = 0; i < count; i++) {
    switch (i % 6) {
      case 0:
        node(workflow, 'Fetch Records').parameters.url =
          `https://api.example.com/v2/items-${String(i)}`;
        break;
      case 1:
        node(workflow, 'Transform').parameters.jsCode = String(
          node(workflow, 'Transform').parameters.jsCode,
        ).replace('return rows', `const extra = ${String(i)};\nreturn rows`);
        break;
      case 2:
        workflow.nodes.push({
          id: `${workflow.id}-added-${String(i)}`,
          name: `Log ${String(i)}`,
          type: 'n8n-nodes-base.noOp',
          typeVersion: 1,
          position: [880, i * 40],
          parameters: {},
        });
        break;
      case 3:
        workflow.settings = { ...workflow.settings, timezone: `Etc/GMT+${String(i)}` };
        break;
      case 4:
        Object.assign(node(workflow, 'Fetch Records'), { retryOnFail: true, maxTries: i });
        break;
      default:
        node(workflow, 'Fetch Records').credentials = {
          httpHeaderAuth: { id: `fakeCred${String(i)}`, name: `Example Key ${String(i)}` },
        };
    }
  }
}

export function generateLargeFixture(seed = 7): LargeFixture {
  const random = rng(seed);
  const instance = new Map<string, NormalizedWorkflow>();
  const local = new Map<string, NormalizedWorkflow>();
  const pulledIds = new Set<string>();

  for (let index = 0; index < 50; index++) {
    const before = baseWorkflow(index, random);
    const after = structuredClone(before);

    if (index >= 12 && index <= 21) applyCosmetic(after, index - 12);
    if (index >= 22 && index <= 36) applyBehavior(after, 1 + Math.floor(random() * 12));
    if (index === 43 || index === 44) renameNode(after, 'Fetch Records', 'Load Records', false);
    if (index === 45) renameNode(after, 'Fetch Records', 'Load Records', true);
    if (index >= 46) {
      applyBehavior(after, 2);
      applyCosmetic(after, index);
    }

    const onInstance = !(index === 37 || index === 38 || index === 39);
    const isLocal = !(index >= 40 && index <= 42);
    if (onInstance) instance.set(before.id, before);
    if (isLocal) local.set(after.id, after);
    if (onInstance || index === 39) pulledIds.add(before.id);
  }
  return { instance, local, pulledIds };
}
