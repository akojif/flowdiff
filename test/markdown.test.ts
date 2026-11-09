import { describe, expect, it } from 'vitest';
import { exitCodeMode } from '../src/commands/diff.js';
import { compareWorkflowSets, shouldFail, type WorkflowComparison } from '../src/diff/index.js';
import type { NormalizedWorkflow } from '../src/normalize/normalize.js';
import {
  codeBlock,
  escapeHtml,
  escapeInline,
  neutralizeMentions,
  renderMarkdown,
  type MarkdownRenderOptions,
} from '../src/render/index.js';
import { FAKE } from './fake-secrets.js';
import { generateLargeFixture } from './fixtures/large.js';
import { nodeNamed, normalizedFixture } from './helpers.js';

/** Zero-width joiner, inserted after @ so mentions don't notify anyone. */
const ZWJ = '\u200D';

const options: MarkdownRenderOptions = {
  beforeLabel: 'main',
  afterLabel: 'feature',
  title: 'Changes from main to feature',
};

function compareOne(before: NormalizedWorkflow, after: NormalizedWorkflow): WorkflowComparison[] {
  return compareWorkflowSets(new Map([[before.id, before]]), new Map([[after.id, after]]));
}

describe('renderMarkdown', () => {
  it('renders a summary table and collapsible details with diff blocks', () => {
    const before = normalizedFixture('code-node.json');
    const after = structuredClone(before);
    const code = nodeNamed(after, 'Transform Items');
    code.parameters = {
      jsCode: String(code.parameters.jsCode).replace(
        'return items;',
        'return items.filter(Boolean);',
      ),
    };
    nodeNamed(after, 'Summarize').name = 'Summarise';
    after.connections = JSON.parse(
      JSON.stringify(after.connections).replaceAll('"Summarize"', '"Summarise"'),
    ) as typeof after.connections;

    expect(renderMarkdown(compareOne(before, after), options).markdown).toMatchInlineSnapshot(`
      "## flowdiff: Changes from main to feature

      **1 changed \\(1 with behavior changes\\), 0 unchanged.**

      | | Workflow | Behavior | Cosmetic | What changed |
      |---|---|---|---|---|
      | ~ | Fixture: Code and AI (\`fixtureCodeNode1\`) | 1 | 1 | 1 param · 1 rename |

      <details>
      <summary>Fixture: Code and AI (fixtureCodeNode1): 1 behavior change, 1 cosmetic</summary>

      **Behavior**

      \`\`\`diff
      ~ param   "Transform Items" › jsCode
      @@ -4,4 +4,4 @@
         item.json.total = item.json.price * item.json.quantity;
       }
       
      -return items;
      +return items.filter(Boolean);
      \`\`\`

      **Cosmetic**

      \`\`\`diff
      ~ node    "Summarize" renamed to "Summarise"
      \`\`\`

      </details>
      "
    `);
  });

  it('says when there are no changes', () => {
    const linear = normalizedFixture('linear.json');
    expect(renderMarkdown(compareOne(linear, linear), options).markdown).toBe(
      '## flowdiff: Changes from main to feature\n\n**No changes \\(1 unchanged\\).**\n',
    );
  });

  it('escapes HTML, table syntax and mentions in workflow names', () => {
    const before = normalizedFixture('linear.json');
    const after = { ...before, name: '<img src=x onerror=alert(1)> | ping @octocat', active: true };
    const { markdown } = renderMarkdown(compareOne(before, after), options);

    // Inside code blocks GitHub shows HTML as literal text; everywhere else it must be escaped.
    const outsideCode = markdown.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1$/gm, '');
    expect(outsideCode).not.toContain('<img');
    expect(outsideCode).not.toMatch(/@octocat/);
    // In the table, `<` becomes an entity so no tag can form; `>` and `|` are backslash-escaped.
    expect(markdown).toContain(`&lt;img src=x onerror=alert\\(1\\)\\> \\| ping @${ZWJ}octocat`);
    expect(markdown).toContain(`<summary>&lt;img src=x onerror=alert(1)&gt; | ping @${ZWJ}octocat`);
  });

  it('uses a longer fence when the content contains backticks', () => {
    const before = normalizedFixture('code-node.json');
    const after = structuredClone(before);
    nodeNamed(after, 'Transform Items').parameters = { jsCode: 'const s = ```;\nreturn [];\n' };
    const { markdown } = renderMarkdown(compareOne(before, after), options);
    expect(markdown).toContain('````diff\n');
  });

  it('never contains secret values and never suggests --show-secrets when it is unavailable', () => {
    const before = normalizedFixture('linear.json');
    const after = structuredClone(before);
    const fetch = nodeNamed(after, 'Fetch Items');
    fetch.parameters = {
      ...fetch.parameters,
      headerParameters: { parameters: [{ name: 'Authorization', value: `Bearer ${FAKE.bearer}` }] },
    };

    const { markdown } = renderMarkdown(compareOne(before, after), { ...options, full: true });

    expect(markdown).not.toContain(FAKE.bearer);
    expect(markdown).toContain('‹redacted bearer token #');
    expect(markdown).toContain('looks like a hard-coded secret');
    expect(markdown).toContain('rotate it');
    expect(markdown).not.toContain('--show-secrets');
  });

  it('stays within the size budget and says how many workflows were omitted', () => {
    const fixture = generateLargeFixture();
    const comparisons = compareWorkflowSets(fixture.instance, fixture.local);
    const full = renderMarkdown(comparisons, options);
    const limited = renderMarkdown(comparisons, {
      ...options,
      maxLength: 8_000,
      fullReportUrl: 'https://github.example.com/run/1',
    });

    expect(full.omitted).toBe(0);
    expect(limited.omitted).toBeGreaterThan(0);
    expect(limited.markdown.length).toBeLessThanOrEqual(8_000);
    expect(limited.markdown).toContain(`details for ${String(limited.omitted)} more workflow`);
    expect(limited.markdown).toContain(
      '[Full report](https://github.example.com/run/1) in the job summary.',
    );
    // The table always lists every workflow, even when details are omitted.
    expect(limited.markdown.match(/^\| (?:~|\+|−|!|⚠️) \|/gm)?.length).toBe(
      full.markdown.match(/^\| (?:~|\+|−|!|⚠️) \|/gm)?.length,
    );
  });
});

describe('escaping helpers', () => {
  it('neutralizes mentions', () => {
    expect(neutralizeMentions('hi @team and @a-b, not me@')).toBe(
      `hi @${ZWJ}team and @${ZWJ}a-b, not me@`,
    );
  });

  it('escapes HTML and Markdown', () => {
    expect(escapeHtml('<b>"x" & \'y\'</b>')).toBe(
      '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;',
    );
    expect(escapeInline('*bold* [link](x) | `code`')).toBe(
      '\\*bold\\* \\[link\\]\\(x\\) \\| \\`code\\`',
    );
  });

  it('picks a fence longer than any backtick run', () => {
    expect(codeBlock(['a ``` b', 'c ````` d'])).toBe('``````\na ``` b\nc ````` d\n``````');
    expect(codeBlock(['plain'], 'diff')).toBe('```diff\nplain\n```');
  });
});

describe('shouldFail', () => {
  const fixture = generateLargeFixture();
  const all = compareWorkflowSets(fixture.instance, fixture.local);
  const byIndex = (index: number) =>
    all.filter((c) => c.id === `largeFixture${String(index).padStart(2, '0')}`);

  it('never fails with none', () => {
    expect(shouldFail(all, 'none')).toBe(false);
  });

  it('fails on any difference with changes, but not on unchanged workflows', () => {
    expect(shouldFail(byIndex(14), 'changes')).toBe(true);
    expect(shouldFail(byIndex(0), 'changes')).toBe(false);
  });

  it('passes cosmetic-only differences with behavior', () => {
    expect(shouldFail(byIndex(14), 'behavior')).toBe(false);
  });

  it('fails on behavior changes, broken references and added workflows with behavior', () => {
    expect(shouldFail(byIndex(22), 'behavior')).toBe(true);
    expect(shouldFail(byIndex(43), 'behavior')).toBe(true);
    expect(shouldFail(byIndex(37), 'behavior')).toBe(true);
  });
});

describe('exitCodeMode', () => {
  it('maps the flag to a mode', () => {
    expect(exitCodeMode(undefined)).toBe('none');
    expect(exitCodeMode(true)).toBe('changes');
    expect(exitCodeMode('changes')).toBe('changes');
    expect(exitCodeMode('behavior')).toBe('behavior');
    expect(() => exitCodeMode('sometimes')).toThrow(/Unknown --exit-code mode "sometimes"/);
  });
});
