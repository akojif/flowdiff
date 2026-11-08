import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface FixtureNode {
  id: string;
  name: string;
}

interface FixtureWorkflow {
  id: string;
  name: string;
  nodes: FixtureNode[];
  connections: Record<string, Record<string, { node: string }[][]>>;
}

const fixturesDir = join(import.meta.dirname, 'fixtures');
const fixtureFiles = readdirSync(fixturesDir).filter((file) => file.endsWith('.json'));

function loadFixture(file: string): FixtureWorkflow {
  return JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as FixtureWorkflow;
}

describe('test fixtures', () => {
  it('includes the expected fixtures', () => {
    expect(fixtureFiles.sort()).toEqual([
      'code-node.json',
      'credential-ref.json',
      'if-branch.json',
      'linear.json',
      'node-groups.json',
    ]);
  });

  describe.each(fixtureFiles)('%s', (file) => {
    const workflow = loadFixture(file);

    it('has a workflow id, name and nodes', () => {
      expect(workflow.id).toBeTypeOf('string');
      expect(workflow.name).toBeTypeOf('string');
      expect(workflow.nodes.length).toBeGreaterThan(0);
    });

    it('has unique node ids and names', () => {
      const ids = workflow.nodes.map((node) => node.id);
      const names = workflow.nodes.map((node) => node.name);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(names).size).toBe(names.length);
    });

    it('only connects nodes that exist (connections are keyed by node name)', () => {
      const names = new Set(workflow.nodes.map((node) => node.name));
      for (const [source, outputs] of Object.entries(workflow.connections)) {
        expect(names).toContain(source);
        for (const target of Object.values(outputs).flat(2)) {
          expect(names).toContain(target.node);
        }
      }
    });

    it('uses only reserved example domains for URLs', () => {
      const urls = readFileSync(join(fixturesDir, file), 'utf8').match(/https?:\/\/[^"\s]+/g) ?? [];
      for (const url of urls) {
        expect(new URL(url).hostname).toMatch(/(^|\.)example\.(com|org|net)$/);
      }
    });
  });
});
