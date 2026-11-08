import { describe, expect, it } from 'vitest';
import { parseRange } from '../src/workspace/git.js';

describe('parseRange', () => {
  it.each([
    ['main..feature', { from: 'main', to: 'feature' }],
    ['v1.2..v1.3', { from: 'v1.2', to: 'v1.3' }],
    ['HEAD~1..HEAD', { from: 'HEAD~1', to: 'HEAD' }],
  ])('parses %s', (value, expected) => {
    expect(parseRange(value)).toEqual(expected);
  });

  it.each(['main', 'main..', '..feature', 'a...b', 'Order Sync', 'a..b..c'])(
    'rejects %j',
    (value) => {
      expect(parseRange(value)).toBeUndefined();
    },
  );
});
