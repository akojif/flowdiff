import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiBaseUrl, createClient } from '../src/api/client.js';
import type { Connection } from '../src/config/connection.js';

const API_KEY = 'fake-api-key-do-not-print';

const connection: Connection = {
  instanceUrl: 'https://n8n.example.com',
  urlSource: 'flowdiff.config.json',
  apiKey: API_KEY,
};

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** A fake fetch that records requests and answers with `respond`. */
function fakeFetch(respond: (url: URL) => Response | Promise<Response>) {
  const requests: { url: URL; headers: Headers }[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push({ url, headers: new Headers(init?.headers) });
    return respond(url);
  };
  return { fetch: fetchFn, requests };
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the promise to reject');
}

describe('apiBaseUrl', () => {
  it.each([
    ['https://n8n.example.com', 'https://n8n.example.com/api/v1'],
    ['https://n8n.example.com/', 'https://n8n.example.com/api/v1'],
    ['https://n8n.example.com/api/v1', 'https://n8n.example.com/api/v1'],
    ['https://n8n.example.com/api/v1/', 'https://n8n.example.com/api/v1'],
    ['https://example.com/n8n/', 'https://example.com/n8n/api/v1'],
  ])('%s -> %s', (input, expected) => {
    expect(apiBaseUrl(input)).toBe(expected);
  });
});

describe('listWorkflows', () => {
  it('follows nextCursor across pages', async () => {
    const pages: Record<string, unknown> = {
      '': { data: [fixture('linear.json')], nextCursor: 'page2' },
      page2: { data: [fixture('if-branch.json')], nextCursor: 'page3' },
      page3: { data: [fixture('credential-ref.json')], nextCursor: null },
    };
    const { fetch, requests } = fakeFetch((url) =>
      json(pages[url.searchParams.get('cursor') ?? '']),
    );

    const workflows = await createClient({ connection, fetch }).listWorkflows();

    expect(workflows.map((w) => w.id)).toEqual([
      'fixtureLinear001',
      'fixtureIfBranch1',
      'fixtureCredRef01',
    ]);
    expect(requests).toHaveLength(3);
    expect(requests[0]?.url.pathname).toBe('/api/v1/workflows');
    expect(requests[0]?.url.searchParams.get('limit')).toBe('100');
  });

  it('sends the API key header and the tag filter', async () => {
    const { fetch, requests } = fakeFetch(() => json({ data: [], nextCursor: null }));

    await createClient({ connection, fetch }).listWorkflows({ tag: 'flowdiff-test' });

    expect(requests[0]?.headers.get('X-N8N-API-KEY')).toBe(API_KEY);
    expect(requests[0]?.url.searchParams.get('tags')).toBe('flowdiff-test');
  });

  it('keeps fields that the schema does not know about', async () => {
    const workflow = { ...(fixture('linear.json') as object), description: 'kept' };
    const { fetch } = fakeFetch(() => json({ data: [workflow] }));

    const [result] = await createClient({ connection, fetch }).listWorkflows();

    expect(result).toHaveProperty('description', 'kept');
  });
});

describe('error messages', () => {
  const cases: [string, () => Response | Promise<Response>, RegExp][] = [
    ['401', () => json({ message: 'unauthorized' }, 401), /rejected the API key \(401\)/],
    [
      '403',
      () => json({ message: 'forbidden' }, 403),
      /does not have permission to list workflows \(403\)/,
    ],
    ['404', () => json({ message: 'not found' }, 404), /no n8n API was found at \/api\/v1/],
    [
      'HTML instead of JSON',
      () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      /no n8n API was found/,
    ],
    [
      '500',
      () => new Response('oops', { status: 500 }),
      /returned 500 when trying to list workflows/,
    ],
    [
      'schema mismatch',
      () => json({ data: [{ id: 1 }] }),
      /Unexpected response .* at "data\.0\.id"/,
    ],
    [
      'DNS failure',
      () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })),
      /Could not reach n8n at https:\/\/n8n\.example\.com \(from flowdiff\.config\.json\): the host name could not be resolved/,
    ],
    [
      'connection refused',
      () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })),
      /the connection was refused/,
    ],
    [
      'timeout',
      () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
      /the request timed out/,
    ],
  ];

  it.each(cases)('%s', async (_name, respond, expected) => {
    const { fetch } = fakeFetch(respond);
    const error = await captureError(createClient({ connection, fetch }).listWorkflows());
    expect(error.message).toMatch(expected);
  });

  it.each(cases)('never includes the API key (%s)', async (_name, respond) => {
    const { fetch } = fakeFetch(respond);
    const error = await captureError(createClient({ connection, fetch }).listWorkflows());
    expect(`${error.message}\n${error.stack ?? ''}`).not.toContain(API_KEY);
  });

  it('names FLOWDIFF_URL when it was the URL source', async () => {
    const { fetch } = fakeFetch(() => json({}, 401));
    const client = createClient({
      connection: { ...connection, urlSource: 'FLOWDIFF_URL' },
      fetch,
    });
    const error = await captureError(client.listWorkflows());
    expect(error.message).toContain('(from FLOWDIFF_URL)');
  });
});
