import { describe, expect, it } from 'vitest';

import {
  buildEmbedsForMessage,
  EMBED_DESC_LIMIT,
  extractFrontmatter,
  parseSections,
  sanitizeDiscordMarkdown,
} from './discord-sections.js';

describe('parseSections', () => {
  it('returns a single default section when no headers', () => {
    const result = parseSections('간단한 답변이야.');
    expect(result).toHaveLength(1);
    expect(result[0].label).toBeNull();
    expect(result[0].body).toBe('간단한 답변이야.');
  });

  it('returns empty array for blank input', () => {
    expect(parseSections('')).toEqual([]);
    expect(parseSections('   \n\n  ')).toEqual([]);
  });

  it('splits on ## headers with emoji prefix', () => {
    const input = [
      '파일 확인했어.',
      '',
      '## 🔍 분석',
      '문제는 여기.',
      '',
      '## 📌 결론',
      '이렇게 고치자.',
    ].join('\n');

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
    const warn = parseSections('## ⚠️ 주의\nA');
    const err = parseSections('## ⚠️ 에러\nB');
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
    const input = [
      '예시 코드:',
      '```',
      '## 이건 헤더 아님',
      'const x = 1;',
      '```',
    ].join('\n');

    const result = parseSections(input);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBeNull();
    expect(result[0].body).toContain('## 이건 헤더 아님');
  });

  it('preserves ### subheaders as body content', () => {
    const result = parseSections('## 🔍 분석\n### 세부\n본문');
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('분석');
    expect(result[0].body).toContain('### 세부');
  });

  it('skips empty sections (header with no body before next header)', () => {
    const input = ['## 🔍 분석', '', '## 📌 결론', '실질 내용'].join('\n');
    const result = parseSections(input);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('결론');
  });
});

describe('buildEmbedsForMessage', () => {
  it('produces zero embeds for blank input', async () => {
    const { embeds, overflowText, attachments } =
      await buildEmbedsForMessage('');
    expect(embeds).toHaveLength(0);
    expect(overflowText).toBe('');
    expect(attachments).toHaveLength(0);
  });

  it('produces one white embed for plain text', async () => {
    const { embeds } = await buildEmbedsForMessage('응, 완료했어.');
    expect(embeds).toHaveLength(1);
    expect(embeds[0].data.color).toBe(0xffffff);
    expect(embeds[0].data.description).toBe('응, 완료했어.');
  });

  it('produces colored embeds matching section order', async () => {
    const input = '## 🔍 분석\nA\n\n## 📌 결론\nB';
    const { embeds } = await buildEmbedsForMessage(input);
    expect(embeds).toHaveLength(2);
    expect(embeds[0].data.color).toBe(0x57f287); // green
    expect(embeds[1].data.color).toBe(0x3498db); // blue
  });

  it('overflows into plain text when body exceeds embed description limit', async () => {
    const longBody = 'x'.repeat(EMBED_DESC_LIMIT + 200);
    const { embeds, overflowText } = await buildEmbedsForMessage(longBody);
    expect(embeds).toHaveLength(1);
    expect(embeds[0].data.description).toHaveLength(EMBED_DESC_LIMIT);
    expect(overflowText).toHaveLength(200);
  });

  it('attaches footer to last embed only when metadata present', async () => {
    const input = '## 🔍 분석\nA\n\n## 📌 결론\nB';
    const { embeds } = await buildEmbedsForMessage(input, {
      toolCounts: { read: 3, bash: 2 },
      elapsedMs: 14000,
      model: 'claude-opus-4-7',
    });
    expect(embeds[0].data.footer).toBeUndefined();
    expect(embeds[1].data.footer?.text).toContain('📖 3');
    expect(embeds[1].data.footer?.text).toContain('⚡ 2');
    expect(embeds[1].data.footer?.text).toContain('14s');
    expect(embeds[1].data.footer?.text).toContain('claude-opus-4-7');
  });

  it('omits footer when metadata has no usable fields', async () => {
    const { embeds } = await buildEmbedsForMessage('plain', {});
    expect(embeds[0].data.footer).toBeUndefined();
  });

  it('combines write and edit counts under single pencil emoji', async () => {
    const { embeds } = await buildEmbedsForMessage('plain', {
      toolCounts: { write: 2, edit: 3 },
    });
    const footer = embeds[0].data.footer?.text ?? '';
    expect(footer).toContain('✏️ 5');
  });

  it('emits an image embed for pipe tables when renderer is available', async () => {
    const input = [
      'before',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'after',
    ].join('\n');
    const { embeds, attachments } = await buildEmbedsForMessage(input);
    // text-before embed, image embed, text-after embed
    expect(embeds.length).toBeGreaterThanOrEqual(2);
    const hasImage = embeds.some((e) =>
      e.data.image?.url?.startsWith('attachment://table_'),
    );
    expect(hasImage).toBe(true);
    expect(attachments.length).toBeGreaterThanOrEqual(1);
    expect(attachments[0].name).toMatch(/^table_\d+\.png$/);
  });
});

describe('extractFrontmatter', () => {
  it('returns null frontmatter and whole text when no block', () => {
    const { frontmatter, body } = extractFrontmatter('plain body');
    expect(frontmatter).toBeNull();
    expect(body).toBe('plain body');
  });

  it('extracts string scalars', () => {
    const input = [
      '---',
      'author: Andy (Opus 4.7)',
      'title: Result',
      '---',
      'body text',
    ].join('\n');
    const { frontmatter, body } = extractFrontmatter(input);
    expect(frontmatter?.author).toBe('Andy (Opus 4.7)');
    expect(frontmatter?.title).toBe('Result');
    expect(body).toBe('body text');
  });

  it('strips surrounding quotes from values', () => {
    const input = ['---', 'author: "Andy"', '---', 'x'].join('\n');
    const { frontmatter } = extractFrontmatter(input);
    expect(frontmatter?.author).toBe('Andy');
  });

  it('parses boolean timestamp', () => {
    const input = ['---', 'timestamp: true', '---', 'x'].join('\n');
    const { frontmatter } = extractFrontmatter(input);
    expect(frontmatter?.timestamp).toBe(true);
  });

  it('parses JSON fields array', () => {
    const input = [
      '---',
      'fields: [{"name":"Risk","value":"Low","inline":true}]',
      '---',
      'x',
    ].join('\n');
    const { frontmatter } = extractFrontmatter(input);
    expect(frontmatter?.fields).toEqual([
      { name: 'Risk', value: 'Low', inline: true },
    ]);
  });

  it('ignores malformed JSON values', () => {
    const input = ['---', 'fields: [broken', '---', 'x'].join('\n');
    const { frontmatter } = extractFrontmatter(input);
    expect(frontmatter?.fields).toBeUndefined();
  });

  it('skips comment lines starting with #', () => {
    const input = [
      '---',
      '# this is a comment',
      'author: Andy',
      '---',
      'x',
    ].join('\n');
    const { frontmatter } = extractFrontmatter(input);
    expect(frontmatter?.author).toBe('Andy');
  });
});

describe('sanitizeDiscordMarkdown', () => {
  it('converts H4+ headers to bold', () => {
    const out = sanitizeDiscordMarkdown('#### deep\n##### deeper');
    expect(out).toBe('**deep**\n**deeper**');
  });

  it('leaves H1-H3 untouched', () => {
    const out = sanitizeDiscordMarkdown('# one\n## two\n### three');
    expect(out).toBe('# one\n## two\n### three');
  });

  it('wraps table rows in a code block', () => {
    const input = ['| A | B |', '|---|---|', '| 1 | 2 |'].join('\n');
    const out = sanitizeDiscordMarkdown(input);
    expect(out.startsWith('```')).toBe(true);
    expect(out.endsWith('```')).toBe(true);
    expect(out).toContain('| A | B |');
  });

  it('converts unchecked task to bullet with ☐', () => {
    const out = sanitizeDiscordMarkdown('- [ ] do the thing');
    expect(out).toBe('• ☐ do the thing');
  });

  it('converts checked task to bullet with ☑', () => {
    const out = sanitizeDiscordMarkdown('- [x] done');
    expect(out).toBe('• ☑ done');
  });

  it('replaces --- horizontal rule with blank line', () => {
    const out = sanitizeDiscordMarkdown('above\n---\nbelow');
    expect(out).toBe('above\n\nbelow');
  });

  it('preserves content inside fenced code blocks', () => {
    const input = ['```', '#### not a header', '| not | table |', '```'].join(
      '\n',
    );
    const out = sanitizeDiscordMarkdown(input);
    expect(out).toContain('#### not a header');
    expect(out).toContain('| not | table |');
  });
});

describe('buildEmbedsForMessage with frontmatter', () => {
  it('applies author to first embed', async () => {
    const input = [
      '---',
      'author: Andy',
      '---',
      '## 🔍 분석',
      'A',
      '',
      '## 📌 결론',
      'B',
    ].join('\n');
    const { embeds } = await buildEmbedsForMessage(input);
    expect(embeds).toHaveLength(2);
    expect(embeds[0].data.author).toEqual({ name: 'Andy' });
    expect(embeds[1].data.author).toBeUndefined();
  });

  it('applies fields to first embed', async () => {
    const input = [
      '---',
      'fields: [{"name":"Risk","value":"Low","inline":true}]',
      '---',
      'body',
    ].join('\n');
    const { embeds } = await buildEmbedsForMessage(input);
    expect(embeds[0].data.fields).toEqual([
      { name: 'Risk', value: 'Low', inline: true },
    ]);
  });

  it('caps fields at 25 items', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `n${i}`,
      value: `v${i}`,
    }));
    const input = [
      '---',
      `fields: ${JSON.stringify(many)}`,
      '---',
      'body',
    ].join('\n');
    const { embeds } = await buildEmbedsForMessage(input);
    expect(embeds[0].data.fields).toHaveLength(25);
  });

  it('applies sanitize before sectioning', async () => {
    const input = '#### small header\n\nbody';
    const { embeds } = await buildEmbedsForMessage(input);
    expect(embeds[0].data.description).toContain('**small header**');
  });
});
