import { describe, expect, it } from 'vitest';
import { findBrokenReferences, formatPath, referencedNodeNames } from '../src/diff/index.js';
import { nodeNamed, normalizedFixture } from './helpers.js';

describe('referencedNodeNames', () => {
  it.each([
    ["={{ $('Set Defaults').item.json.limit }}", ['Set Defaults']],
    ['={{ $("Set Defaults").first().json }}', ['Set Defaults']],
    ['={{ $(`Set Defaults`).all() }}', ['Set Defaults']],
    ['={{ $node["Set Defaults"].json.limit }}', ['Set Defaults']],
    ["={{ $node['Set Defaults'].json.limit }}", ['Set Defaults']],
    ['={{ $node.SetDefaults.json.limit }}', ['SetDefaults']],
    ["const rows = $items('Fetch Items');", ['Fetch Items']],
    ["={{ $('It\\'s here').item }}", ["It's here"]],
    ["={{ $('A').item.json.x + $('B').item.json.y }}", ['A', 'B']],
  ])('%s', (text, expected) => {
    expect(referencedNodeNames(text)).toEqual(expected);
  });

  it('skips dynamic template literals and plain text', () => {
    expect(referencedNodeNames('={{ $(`Node ${n}`).item }}')).toEqual([]);
    expect(referencedNodeNames('price is $5 (approx)')).toEqual([]);
  });
});

describe('findBrokenReferences', () => {
  /** Linear fixture where Fetch Items references Set Defaults in its URL and a Code-style string. */
  function withReferences() {
    const workflow = normalizedFixture('linear.json');
    const fetch = nodeNamed(workflow, 'Fetch Items');
    fetch.parameters = {
      ...fetch.parameters,
      url: "={{ 'https://api.example.com/items?limit=' + $('Set Defaults').item.json.limit }}",
    };
    return workflow;
  }

  it('finds nothing when every referenced node exists', () => {
    expect(findBrokenReferences(withReferences())).toEqual([]);
  });

  it('reports a reference to a missing node with the node and parameter path', () => {
    const workflow = withReferences();
    nodeNamed(workflow, 'Set Defaults').name = 'Prepare';

    const [broken, ...rest] = findBrokenReferences(workflow);

    expect(rest).toEqual([]);
    expect(broken).toMatchObject({ node: { name: 'Fetch Items' }, reference: 'Set Defaults' });
    expect(broken && formatPath(broken.path)).toBe('url');
  });

  it('finds references inside Code node source', () => {
    const workflow = normalizedFixture('code-node.json');
    nodeNamed(workflow, 'Transform Items').parameters = {
      jsCode:
        "const trigger = $('Manual Trigger').first();\nconst gone = $('Old Node').all();\nreturn gone;\n",
    };
    expect(findBrokenReferences(workflow).map((b) => b.reference)).toEqual(['Old Node']);
  });

  it('ignores sticky notes', () => {
    const workflow = normalizedFixture('linear.json');
    workflow.nodes.push({
      id: 'sticky',
      name: 'Note',
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [0, 300],
      parameters: { content: "Remember: $('Old Name') was removed" },
    });
    expect(findBrokenReferences(workflow)).toEqual([]);
  });

  it('reports each missing name once per parameter', () => {
    const workflow = normalizedFixture('linear.json');
    nodeNamed(workflow, 'Fetch Items').parameters = {
      url: "={{ $('Gone').item.json.a + $('Gone').item.json.b }}",
    };
    expect(findBrokenReferences(workflow)).toHaveLength(1);
  });
});
