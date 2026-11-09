import { describe, expect, it } from 'vitest';
import { normalizeWorkflow } from '../src/normalize/normalize.js';
import {
  findSecretsInString,
  isSensitiveName,
  looksLikeLiteralSecret,
  redactString,
  redactWorkflow,
  scanWorkflowSecrets,
} from '../src/secrets/index.js';
import { formatPath } from '../src/diff/path.js';
import { chars, FAKE } from './fake-secrets.js';
import { loadFixture, nodeNamed } from './helpers.js';

describe('findSecretsInString', () => {
  it.each([
    ['AWS access key', FAKE.aws],
    ['GitHub token', FAKE.github],
    ['Slack token', FAKE.slack],
    ['Stripe key', FAKE.stripe],
    ['Anthropic key', FAKE.anthropic],
    ['OpenAI key', FAKE.openai],
    ['Google API key', FAKE.google],
    ['SendGrid key', FAKE.sendgrid],
    ['JWT', FAKE.jwt],
    ['private key', FAKE.privateKey],
  ])('detects a %s', (label, secret) => {
    expect(findSecretsInString(`value: ${secret} end`)).toMatchObject([{ label }]);
  });

  it('finds only the token part of a bearer header', () => {
    const text = `Bearer ${FAKE.bearer}`;
    const [match] = findSecretsInString(text);
    expect(match?.label).toBe('bearer token');
    expect(text.slice(match?.start, match?.end)).toBe(FAKE.bearer);
  });

  it('finds the password in a URL', () => {
    const text = `https://user:${chars(12)}@db.example.com/x`;
    const [match] = findSecretsInString(text);
    expect(match?.label).toBe('credentials in URL');
    expect(text.slice(match?.start, match?.end)).toBe(chars(12));
  });

  it('finds a hard-coded secret assigned in code', () => {
    const code = `const apiKey = "${chars(20)}";\nreturn items;`;
    expect(findSecretsInString(code)).toMatchObject([{ label: 'hard-coded secret in code' }]);
  });

  it.each([
    ['an expression', '=Bearer {{ $env.API_TOKEN }}'],
    ['a template literal', 'const token = `${process.env.X}`;'],
    ['a placeholder', 'Bearer <your-token-goes-here-123456>'],
    ['plain text', 'Send the weekly report to the team'],
    ['a URL without credentials', 'https://api.example.com/items?limit=10'],
  ])('ignores %s', (_kind, text) => {
    expect(findSecretsInString(text)).toEqual([]);
  });
});

describe('sensitive names and literal values', () => {
  it.each([
    'apiKey',
    'api_key',
    'X-API-Key',
    'Authorization',
    'clientSecret',
    'refreshToken',
    'password',
  ])('%s is sensitive', (name) => {
    expect(isSensitiveName(name)).toBe(true);
  });

  it.each(['url', 'maxTokens', 'authentication', 'tokenUrl', 'name'])(
    '%s is not sensitive',
    (name) => {
      expect(isSensitiveName(name)).toBe(false);
    },
  );

  it('accepts long mixed literals and rejects expressions, short values and placeholders', () => {
    expect(looksLikeLiteralSecret(chars(16))).toBe(true);
    expect(looksLikeLiteralSecret('={{ $env.KEY }}')).toBe(false);
    expect(looksLikeLiteralSecret('={{ $vars.apiKey }}')).toBe(false);
    expect(looksLikeLiteralSecret('abc123')).toBe(false);
    expect(looksLikeLiteralSecret('onlyletterswithoutdigits')).toBe(false);
    expect(looksLikeLiteralSecret('your-api-key-1234567')).toBe(false);
  });
});

describe('scanWorkflowSecrets', () => {
  function withFetchParameters(parameters: Record<string, unknown>) {
    const workflow = normalizeWorkflow(loadFixture('linear.json'));
    nodeNamed(workflow, 'Fetch Items').parameters = parameters;
    return workflow;
  }

  it('finds a literal Authorization header in an n8n name/value list', () => {
    const workflow = withFetchParameters({
      headerParameters: { parameters: [{ name: 'Authorization', value: `Bearer ${FAKE.bearer}` }] },
    });
    const [finding] = scanWorkflowSecrets(workflow);
    expect(finding).toMatchObject({ node: { name: 'Fetch Items' }, label: 'bearer token' });
    expect(finding && formatPath(finding.path)).toBe('headerParameters.parameters[0].value');
  });

  it('finds a literal value under a sensitive header name without a known format', () => {
    const workflow = withFetchParameters({
      headerParameters: { parameters: [{ name: 'X-API-Key', value: chars(24) }] },
    });
    expect(scanWorkflowSecrets(workflow)).toMatchObject([
      { label: 'literal value in value of "X-API-Key"' },
    ]);
  });

  it('finds a sensitive parameter key and secrets in notes', () => {
    const workflow = withFetchParameters({ apiKey: chars(20) });
    Object.assign(nodeNamed(workflow, 'Fetch Items'), { notes: `temp key ${FAKE.github}` });
    expect(scanWorkflowSecrets(workflow).map((f) => formatPath(f.path))).toEqual([
      'apiKey',
      'notes',
    ]);
  });

  it('finds nothing in the clean fixtures', () => {
    for (const name of [
      'linear.json',
      'if-branch.json',
      'credential-ref.json',
      'code-node.json',
      'node-groups.json',
    ]) {
      expect(scanWorkflowSecrets(normalizeWorkflow(loadFixture(name)))).toEqual([]);
    }
  });
});

describe('redaction', () => {
  it('replaces only the secret part of a string, with a fingerprint', () => {
    const redacted = redactString(`Bearer ${FAKE.bearer}`);
    expect(redacted).toMatch(/^Bearer ‹redacted bearer token #[0-9a-f]{4}›$/);
    expect(redacted).not.toContain(FAKE.bearer);
  });

  it('gives different secrets different markers and the same secret the same marker', () => {
    expect(redactString(FAKE.github)).toBe(redactString(FAKE.github));
    expect(redactString(FAKE.github)).not.toBe(redactString('gh' + 'p_' + chars(36, 'zYxW9')));
  });

  it('redacts a whole workflow copy without modifying the original', () => {
    const workflow = normalizeWorkflow(loadFixture('linear.json'));
    nodeNamed(workflow, 'Fetch Items').parameters = {
      apiKey: chars(20),
      url: 'https://api.example.com/items',
    };
    const redacted = redactWorkflow(workflow);
    expect(nodeNamed(redacted, 'Fetch Items').parameters).toEqual({
      apiKey: expect.stringMatching(/^‹redacted secret #[0-9a-f]{4}›$/) as unknown,
      url: 'https://api.example.com/items',
    });
    expect(nodeNamed(workflow, 'Fetch Items').parameters.apiKey).toBe(chars(20));
  });

  it('redacts a private key block as one marker', () => {
    expect(redactString(`key:\n${FAKE.privateKey}\nend`)).toMatch(
      /^key:\n‹redacted private key #[0-9a-f]{4}›\nend$/,
    );
  });
});
