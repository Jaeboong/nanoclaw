import { describe, expect, it } from 'vitest';

import { parsePipeTable } from './table-render.js';

describe('parsePipeTable', () => {
  it('parses headers + rows and drops the alignment row', () => {
    const t = parsePipeTable(['| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |']);
    expect(t).not.toBeNull();
    expect(t!.headers).toEqual(['A', 'B']);
    expect(t!.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('handles CJK cells and trailing-pipe-only rows (leading pipe optional)', () => {
    const t = parsePipeTable(['이름 | 점수 |', '---|---|', '가나다 | 100 |']);
    expect(t!.headers).toEqual(['이름', '점수']);
    expect(t!.rows).toEqual([['가나다', '100']]);
  });

  it('rejects rows with neither a leading nor trailing pipe', () => {
    // 이름 | 점수 has only an internal pipe → not a table row (matches v1).
    expect(parsePipeTable(['이름 | 점수', '가나다 | 100'])).toBeNull();
  });

  it('returns null for fewer than two non-alignment rows', () => {
    expect(parsePipeTable(['| only |'])).toBeNull();
    expect(parsePipeTable(['| H |', '|---|'])).toBeNull();
  });

  it('pads short rows and truncates long rows to the header column count', () => {
    const t = parsePipeTable(['| A | B | C |', '|---|---|---|', '| 1 |', '| x | y | z | extra |']);
    expect(t!.rows).toEqual([
      ['1', '', ''],
      ['x', 'y', 'z'],
    ]);
  });

  it('ignores non-pipe lines when building the table', () => {
    expect(parsePipeTable(['plain text', 'no pipes here'])).toBeNull();
  });
});
