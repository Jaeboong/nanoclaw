import { describe, expect, it } from 'vitest';

import {
  buildSectionEmbeds,
  EMBED_DESC_LIMIT,
  extractFrontmatter,
  parseSections,
  sanitizeWithTables,
  type ParsedTable,
} from './section-embeds.js';

// A fake renderer so table tests don't depend on the native canvas being
// present in CI. Returns a deterministic 1-byte PNG buffer.
const fakeRender = async (_t: ParsedTable): Promise<Buffer> => Buffer.from([0x89]);

describe('parseSections', () => {
  it('returns a single default section when no headers', () => {
    const result = parseSections('간단한 답변이야.');
    expect(result).toHaveLength(1);
    expect(result[0].label).toBeNull();
    expect(result[0].color).toBe(0xffffff);
    expect(result[0].body).toBe('간단한 답변이야.');
  });

  it('returns empty array for blank input', () => {
    expect(parseSections('')).toEqual([]);
    expect(parseSections('   \n\n  ')).toEqual([]);
  });

  it('splits on ## headers with emoji prefix', () => {
    const input = ['파일 확인했어.', '', '## 🔍 분석', '문제는 여기.', '', '## 📌 결론', '이렇게 고치자.'].join('\n');
    const result = parseSections(input);
    expect(result).toHaveLength(3);
    expect(result[0].label).toBeNull();
    expect(result[0].body).toBe('파일 확인했어.');
    expect(result[1].label).toBe('분석');
    expect(result[1].body).toBe('문제는 여기.');
    expect(result[2].label).toBe('결론');
    expect(result[2].body).toBe('이렇게 고치자.');
  });

  it('matches label without leading emoji', () => {
    const result = parseSections('## 분석\n본문');
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('분석');
    expect(result[0].body).toBe('본문');
  });

  it('maps 에러 to same color as 주의', () => {
    const warn = parseSections('## 주의\nx');
    const err = parseSections('## 에러\ny');
    expect(warn[0].color).toBe(err[0].color);
  });

  it('treats unknown ## headers as body content', () => {
    const result = parseSections('## 기타 사항\n내용');
    expect(result).toHaveLength(1);
    expect(result[0].label).toBeNull();
    expect(result[0].body).toContain('## 기타 사항');
    expect(result[0].body).toContain('내용');
  });

  it('ignores ## headers inside fenced code blocks', () => {
    const input = ['```md', '## 이건 헤더 아님', '```'].join('\n');
    const result = parseSections(input);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBeNull();
    expect(result[0].body).toContain('## 이건 헤더 아님');
  });

  it('preserves ### subheaders as body content', () => {
    const result = parseSections('## 분석\n### 세부\n내용');
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('분석');
    expect(result[0].body).toContain('### 세부');
  });

  it('skips empty sections (header with no body before next header)', () => {
    const result = parseSections('## 분석\n## 결론\n실제 내용');
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('결론');
  });
});

describe('buildSectionEmbeds', () => {
  it('produces zero embeds for blank input', async () => {
    const { embeds, overflowText, attachments } = await buildSectionEmbeds('');
    expect(embeds).toHaveLength(0);
    expect(overflowText).toBe('');
    expect(attachments).toHaveLength(0);
  });

  it('produces one white embed for plain text', async () => {
    const { embeds } = await buildSectionEmbeds('응, 완료했어.');
    expect(embeds).toHaveLength(1);
    expect(embeds[0].color).toBe(0xffffff);
    expect(embeds[0].description).toBe('응, 완료했어.');
  });

  it('produces colored embeds matching section order', async () => {
    const { embeds } = await buildSectionEmbeds('## 🔍 분석\nA\n\n## 📌 결론\nB');
    expect(embeds).toHaveLength(2);
    expect(embeds[0].color).toBe(0x57f287); // green
    expect(embeds[1].color).toBe(0x3498db); // blue
  });

  it('overflows into plain text when body exceeds embed description limit', async () => {
    const longBody = 'x'.repeat(EMBED_DESC_LIMIT + 200);
    const { embeds, overflowText } = await buildSectionEmbeds(longBody);
    expect(embeds).toHaveLength(1);
    expect(embeds[0].description).toHaveLength(EMBED_DESC_LIMIT);
    expect(overflowText).toHaveLength(200);
  });

  it('attaches footer to last embed only when metadata present', async () => {
    const { embeds } = await buildSectionEmbeds('## 🔍 분석\nA\n\n## 📌 결론\nB', {
      toolCounts: { read: 3, bash: 2 },
      elapsedMs: 14000,
      model: 'claude-opus-4-8',
    });
    expect(embeds[0].footer).toBeUndefined();
    expect(embeds[1].footer?.text).toContain('📖 3');
    expect(embeds[1].footer?.text).toContain('⚡ 2');
    expect(embeds[1].footer?.text).toContain('14s');
    expect(embeds[1].footer?.text).toContain('claude-opus-4-8');
  });

  it('omits footer when metadata has no usable fields', async () => {
    const { embeds } = await buildSectionEmbeds('plain', {});
    expect(embeds[0].footer).toBeUndefined();
  });

  it('combines write and edit counts under single pencil emoji', async () => {
    const { embeds } = await buildSectionEmbeds('plain', { toolCounts: { write: 2, edit: 3 } });
    expect(embeds[0].footer?.text ?? '').toContain('✏️ 5');
  });

  it('emits an image embed for pipe tables when renderer is available', async () => {
    const input = ['before', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', 'after'].join('\n');
    const { embeds, attachments } = await buildSectionEmbeds(input, undefined, {
      render: fakeRender,
      available: true,
    });
    expect(embeds.length).toBeGreaterThanOrEqual(2);
    const hasImage = embeds.some((e) => e.image?.url?.startsWith('attachment://table_'));
    expect(hasImage).toBe(true);
    expect(attachments.length).toBeGreaterThanOrEqual(1);
    expect(attachments[0].name).toMatch(/^table_\d+\.png$/);
  });

  it('falls back to a code block when the table renderer fails', async () => {
    const input = ['| A | B |', '|---|---|', '| 1 | 2 |'].join('\n');
    const { embeds, attachments } = await buildSectionEmbeds(input, undefined, {
      render: async () => null,
      available: true,
    });
    expect(attachments).toHaveLength(0);
    expect(embeds[0].description).toContain('| A | B |');
  });

  it('carries the section color onto the table image embed', async () => {
    const input = ['## ⚠️ 주의', '| A | B |', '|---|---|', '| 1 | 2 |'].join('\n');
    const { embeds } = await buildSectionEmbeds(input, undefined, { render: fakeRender, available: true });
    const imageEmbed = embeds.find((e) => e.image);
    expect(imageEmbed?.color).toBe(0xed4245); // red — inherited from 주의 section
  });
});

describe('extractFrontmatter', () => {
  it('returns null frontmatter and whole text when no block', () => {
    const { frontmatter, body } = extractFrontmatter('plain body');
    expect(frontmatter).toBeNull();
    expect(body).toBe('plain body');
  });

  it('extracts string scalars and strips quotes', () => {
    const input = ['---', 'author: "Andy"', 'title: Result', '---', 'body text'].join('\n');
    const { frontmatter, body } = extractFrontmatter(input);
    expect(frontmatter?.author).toBe('Andy');
    expect(frontmatter?.title).toBe('Result');
    expect(body).toBe('body text');
  });

  it('parses JSON fields array and ignores malformed JSON', () => {
    const ok = extractFrontmatter(['---', 'fields: [{"name":"Risk","value":"Low","inline":true}]', '---', 'x'].join('\n'));
    expect(ok.frontmatter?.fields).toEqual([{ name: 'Risk', value: 'Low', inline: true }]);
    const bad = extractFrontmatter(['---', 'fields: [broken', '---', 'x'].join('\n'));
    expect(bad.frontmatter?.fields).toBeUndefined();
  });

  it('lifts frontmatter onto the first embed', async () => {
    const input = ['---', 'author: Andy', 'title: 결과', '---', '본문이야.'].join('\n');
    const { embeds } = await buildSectionEmbeds(input);
    expect(embeds[0].author?.name).toBe('Andy');
    expect(embeds[0].title).toBe('결과');
  });
});

describe('sanitizeWithTables', () => {
  it('converts H4+ headers to bold and leaves H1-H3', () => {
    const { text } = sanitizeWithTables('#### deep\n## keep');
    expect(text).toContain('**deep**');
    expect(text).toContain('## keep');
  });

  it('extracts a pipe table into the tables array', () => {
    const { text, tables } = sanitizeWithTables(['| A | B |', '|---|---|', '| 1 | 2 |'].join('\n'));
    expect(tables).toHaveLength(1);
    expect(tables[0].headers).toEqual(['A', 'B']);
    expect(text).toContain('TABLE_0');
  });
});
