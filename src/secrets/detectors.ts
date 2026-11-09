/**
 * Heuristic detection of hard-coded secrets in strings. It catches common token
 * formats and obvious patterns, not every secret; treat a clean result as "no
 * known pattern found", not as "no secrets".
 */

export interface SecretMatch {
  /** Range of the secret itself within the string (not the surrounding "Bearer ", etc.). */
  start: number;
  end: number;
  label: string;
}

interface Pattern {
  label: string;
  regex: RegExp;
  /** Capture group holding the secret; 0 means the whole match. */
  group: number;
}

// Order matters only for overlapping matches: the earliest, then longest, wins.
const PATTERNS: Pattern[] = [
  {
    label: 'private key',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/dg,
    group: 0,
  },
  { label: 'AWS access key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/dg, group: 0 },
  {
    label: 'GitHub token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/dg,
    group: 0,
  },
  { label: 'Slack token', regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/dg, group: 0 },
  { label: 'Stripe key', regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/dg, group: 0 },
  { label: 'Anthropic key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/dg, group: 0 },
  { label: 'OpenAI key', regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/dg, group: 0 },
  { label: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}/dg, group: 0 },
  { label: 'SendGrid key', regex: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/dg, group: 0 },
  {
    label: 'JWT',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/dg,
    group: 0,
  },
  { label: 'bearer token', regex: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/dg, group: 1 },
  { label: 'basic auth', regex: /\bBasic\s+([A-Za-z0-9+/]{16,}={0,2})/dg, group: 1 },
  {
    label: 'credentials in URL',
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/{}]{3,})@/dgi,
    group: 1,
  },
  {
    label: 'hard-coded secret in code',
    regex:
      /\b(?:api[_-]?key|apikey|secret|token|password|passwd|client[_-]?secret|access[_-]?key)\w*\s*[:=]\s*(['"`])((?![^'"`]*\$\{)[^'"`\s]{8,})\1/dgi,
    group: 2,
  },
];

/** Finds secrets in a string, non-overlapping, in order. Pure. */
export function findSecretsInString(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { label, regex, group } of PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const range = match.indices?.[group];
      if (range === undefined) continue;
      const value = text.slice(range[0], range[1]);
      if (isPlaceholder(value)) continue;
      matches.push({ start: range[0], end: range[1], label });
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: SecretMatch[] = [];
  for (const match of matches) {
    const last = kept.at(-1);
    if (last === undefined || match.start >= last.end) kept.push(match);
  }
  return kept;
}

/** Parameter or header names whose literal value is likely a secret. */
const SENSITIVE_NAME_ENDINGS = [
  'apikey',
  'apisecret',
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'privatekey',
  'accesskey',
];

export function isSensitiveName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[-_ ]/g, '');
  return SENSITIVE_NAME_ENDINGS.some((ending) => normalized.endsWith(ending));
}

/**
 * Whether a value at a sensitive name looks like a literal secret rather than an
 * expression, placeholder or short setting. Expressions that read n8n's own
 * stores (`{{ $env.X }}`, `$vars`, `$secrets`) are never secrets.
 */
export function looksLikeLiteralSecret(value: string): boolean {
  const literal = value.startsWith('=') ? value.slice(1) : value;
  if (literal.includes('{{') || /\$(?:env|vars|secrets)\b/.test(literal)) return false;
  const trimmed = literal.trim();
  return (
    trimmed.length >= 12 &&
    !/\s/.test(trimmed) &&
    /[A-Za-z]/.test(trimmed) &&
    /[0-9]/.test(trimmed) &&
    !isPlaceholder(trimmed)
  );
}

function isPlaceholder(value: string): boolean {
  return /^(?:x+|\*+|<[^>]*>|\{[^}]*\}|\[[^\]]*\])$|your|changeme|example|placeholder|dummy|redacted/i.test(
    value,
  );
}
