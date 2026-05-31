import { describe, expect, it } from 'vitest';

import type { OutboundFileUpload, OutboundMessageTransform } from '../chat-sdk-bridge.js';
import { renderOutboundTables, type TableRenderDeps } from './table-outbound.js';
import { TABLE_RENDER_AVAILABLE } from './table-render.js';

// Deterministic, env-independent fake renderer: a 1-byte buffer per table so we
// can assert extraction/replacement/budget without the native canvas binary.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const fakeDeps: TableRenderDeps = { available: true, render: async () => PNG };

function msg(text: string, files: OutboundFileUpload[] = []): OutboundMessageTransform {
  return { text, files };
}

const TABLE = ['| 이름 | 점수 |', '|---|---|', '| 가나다 | 100 |', '| 라마바 | 95 |'].join('\n');

describe('renderOutboundTables', () => {
  it('extracts a pipe table into a PNG attachment and removes it from the body', async () => {
    const out = await renderOutboundTables(msg(`결과:\n\n${TABLE}\n\n끝.`), fakeDeps);
    expect(out.files).toHaveLength(1);
    expect(out.files[0].filename).toBe('table_1.png');
    expect(out.files[0].data).toEqual(PNG);
    expect(out.text).toContain('결과:');
    expect(out.text).toContain('끝.');
    expect(out.text).not.toContain('|'); // table lines gone
  });

  it('returns the message unchanged when there is no pipe table', async () => {
    const input = msg('그냥 평범한 텍스트입니다.');
    const out = await renderOutboundTables(input, fakeDeps);
    expect(out).toBe(input); // fast-path identity (no pipe char)
  });

  it('does not touch tables inside a fenced code block', async () => {
    const input = msg(['```', '| a | b |', '|---|---|', '| 1 | 2 |', '```'].join('\n'));
    const out = await renderOutboundTables(input, fakeDeps);
    expect(out).toBe(input);
  });

  it('keeps a malformed single-row table verbatim (no render)', async () => {
    const input = msg('| only one row |');
    const out = await renderOutboundTables(input, fakeDeps);
    expect(out).toBe(input);
  });

  it('renders multiple tables to sequentially-named attachments', async () => {
    const out = await renderOutboundTables(msg(`${TABLE}\n\n사이 텍스트\n\n${TABLE}`), fakeDeps);
    expect(out.files.map((f) => f.filename)).toEqual(['table_1.png', 'table_2.png']);
    expect(out.text).toContain('사이 텍스트');
  });

  it('preserves any pre-existing attachments and appends table PNGs after them', async () => {
    const existing: OutboundFileUpload = { data: Buffer.from('x'), filename: 'report.pdf' };
    const out = await renderOutboundTables(msg(TABLE, [existing]), fakeDeps);
    expect(out.files[0]).toBe(existing);
    expect(out.files[1].filename).toBe('table_1.png');
  });

  it('respects the 10-attachment budget: leaves overflow tables as markdown', async () => {
    const full: OutboundFileUpload[] = Array.from({ length: 10 }, (_, i) => ({
      data: Buffer.from('x'),
      filename: `f${i}.png`,
    }));
    const input = msg(TABLE, full);
    const out = await renderOutboundTables(input, fakeDeps);
    // No room for new attachments → nothing rendered → input returned as-is.
    expect(out).toBe(input);
    expect(out.files).toHaveLength(10);
    expect(out.text).toContain('|');
  });

  it('falls back to markdown when the renderer is unavailable', async () => {
    const input = msg(TABLE);
    const out = await renderOutboundTables(input, { available: false });
    expect(out).toBe(input);
  });

  it('falls back to markdown when a render returns null', async () => {
    const input = msg(TABLE);
    const out = await renderOutboundTables(input, { available: true, render: async () => null });
    expect(out).toBe(input);
    expect(out.text).toContain('| 이름 | 점수 |');
  });

  it('real canvas renderer (smoke): produces a valid PNG when available', async () => {
    if (!TABLE_RENDER_AVAILABLE) return; // skip where the native binary is absent
    const out = await renderOutboundTables(msg(TABLE));
    expect(out.files).toHaveLength(1);
    const png = out.files[0].data;
    // PNG magic number
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.length).toBeGreaterThan(100);
  });
});
