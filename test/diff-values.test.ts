import { describe, expect, it } from 'vitest';
import { formatPath } from '../src/diff/path.js';
import { diffText } from '../src/diff/text.js';
import { diffValues } from '../src/diff/values.js';

/** Changed paths, formatted, for compact assertions. */
function paths(before: unknown, after: unknown): string[] {
  return diffValues(before, after).map((d) => formatPath(d.path));
}

describe('diffValues', () => {
  it('returns nothing for equal values', () => {
    expect(diffValues({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual([]);
  });

  it('reports added, removed and modified keys with their exact path', () => {
    expect(diffValues({ a: { b: 1, c: 2 } }, { a: { b: 9, d: 3 } })).toEqual([
      { path: [{ key: 'a' }, { key: 'b' }], change: { type: 'modified', from: 1, to: 9 } },
      { path: [{ key: 'a' }, { key: 'c' }], change: { type: 'removed', value: 2 } },
      { path: [{ key: 'a' }, { key: 'd' }], change: { type: 'added', value: 3 } },
    ]);
  });

  it('reports a type change as modified', () => {
    expect(diffValues({ a: '1' }, { a: 1 })[0]?.change).toEqual({
      type: 'modified',
      from: '1',
      to: 1,
    });
  });

  it('compares plain arrays by position', () => {
    expect(paths({ list: ['a', 'b', 'c'] }, { list: ['a', 'x', 'c', 'd'] })).toEqual([
      'list[1]',
      'list[3]',
    ]);
  });

  it('uses a line-level diff for multi-line strings', () => {
    const [diff] = diffValues({ code: 'a\nb\nc\n' }, { code: 'a\nB\nc\n' });
    expect(diff?.change.type).toBe('text');
  });

  it('keeps single-line string changes as modified', () => {
    expect(diffValues('a', 'b')[0]?.change).toEqual({ type: 'modified', from: 'a', to: 'b' });
  });
});

describe('id-matched arrays', () => {
  const field = (id: string, name: string, value: unknown) => ({ id, name, value });

  it('matches elements by id, so removing the first one does not shift the rest', () => {
    const before = [field('1', 'a', 1), field('2', 'b', 2), field('3', 'c', 3)];
    const after = [field('2', 'b', 2), field('3', 'c', 30)];
    expect(paths(before, after)).toEqual(['[c].value', '[a]']);
    expect(diffValues(before, after)[1]?.change.type).toBe('removed');
  });

  it('labels elements by name and reports additions', () => {
    const before = [field('1', 'limit', 10)];
    const after = [field('1', 'limit', 20), field('2', 'offset', 0)];
    expect(paths(before, after)).toEqual(['[limit].value', '[offset]']);
  });

  it('falls back to #id when names repeat', () => {
    const before = [field('1', 'dup', 1), field('2', 'dup', 2)];
    const after = [field('1', 'dup', 1), field('2', 'dup', 3)];
    expect(paths(before, after)).toEqual(['[#2].value']);
  });

  it('falls back to #id when an element has no name', () => {
    expect(paths([{ id: 'x', value: 1 }], [{ id: 'x', value: 2 }])).toEqual(['[#x].value']);
  });

  it('reports a reorder of the same elements', () => {
    const before = [field('1', 'a', 1), field('2', 'b', 2)];
    const after = [field('2', 'b', 2), field('1', 'a', 1)];
    expect(diffValues(before, after)).toEqual([
      { path: [], change: { type: 'reordered', from: ['a', 'b'], to: ['b', 'a'] } },
    ]);
  });

  it('falls back to position matching when an id is missing', () => {
    const before = [field('1', 'a', 1), { name: 'b', value: 2 }];
    const after = [field('1', 'a', 1), { name: 'b', value: 3 }];
    expect(paths(before, after)).toEqual(['[1].value']);
  });

  it('falls back to position matching when ids are not unique', () => {
    const before = [field('1', 'a', 1), field('1', 'b', 2)];
    const after = [field('1', 'a', 1), field('1', 'b', 3)];
    expect(paths(before, after)).toEqual(['[1].value']);
  });
});

describe('diffText', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${String(i + 1)}`);

  it('produces hunks with three lines of context', () => {
    const before = lines(10).join('\n');
    const after = lines(10)
      .map((l) => (l === 'line 5' ? 'line five' : l))
      .join('\n');
    const change = diffText(before, after);
    expect(change.hunks).toHaveLength(1);
    expect(change.hunks[0]?.lines).toEqual([
      ' line 2',
      ' line 3',
      ' line 4',
      '-line 5',
      '+line five',
      ' line 6',
      ' line 7',
      ' line 8',
    ]);
    expect(change.lineEndingsChanged).toBe(false);
  });

  it('handles added and removed lines', () => {
    const change = diffText('a\nb\n', 'a\nb\nc\n');
    expect(change.hunks[0]?.lines).toEqual([' a', ' b', '+c']);
    expect(diffText('a\nb\nc\n', 'a\nc\n').hunks[0]?.lines).toEqual([' a', '-b', ' c']);
  });

  it('flags a CRLF to LF switch without marking every line as changed', () => {
    const change = diffText('a\r\nb\r\n', 'a\nb\n');
    expect(change.hunks).toEqual([]);
    expect(change.lineEndingsChanged).toBe(true);
  });

  it('drops "no newline at end of file" markers', () => {
    const change = diffText('a\nb', 'a\nc');
    expect(change.hunks.flatMap((h) => h.lines).some((l) => l.startsWith('\\'))).toBe(false);
  });
});

describe('formatPath', () => {
  it('formats keys, indexes, id labels and odd keys', () => {
    expect(
      formatPath([
        { key: 'options' },
        { key: 'list' },
        { index: 0 },
        { id: 'x', label: 'limit' },
        { key: 'with space' },
      ]),
    ).toBe('options.list[0][limit]["with space"]');
  });
});
