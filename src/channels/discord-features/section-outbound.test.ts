import { describe, expect, it, vi } from 'vitest';

import { deliverSectionEmbeds, discordChannelId } from './section-outbound.js';
import type { RichPayload } from './section-rest.js';

type PostFn = (channelId: string, payload: RichPayload) => Promise<string | null>;
const postMock = (impl: PostFn) => vi.fn(impl);

describe('discordChannelId', () => {
  it('extracts the channel snowflake from an encoded thread id', () => {
    expect(discordChannelId('discord:123:456')).toBe('456');
    expect(discordChannelId('discord:@me:789')).toBe('789');
  });

  it('returns null for non-Discord or malformed ids', () => {
    expect(discordChannelId('telegram:456')).toBeNull();
    expect(discordChannelId('discord:123:notnumeric')).toBeNull();
  });
});

describe('deliverSectionEmbeds', () => {
  const okPost: PostFn = async () => 'msg-1';

  it('renders colored embeds and posts them, reporting handled', async () => {
    const post = postMock(async () => 'msg-1');
    const result = await deliverSectionEmbeds(
      { threadId: 'discord:1:200', text: '## 🔍 분석\nA\n\n## 📌 결론\nB', files: [] },
      { post },
    );
    expect(result).toEqual({ handled: true, messageId: 'msg-1' });
    expect(post).toHaveBeenCalledTimes(1);
    const [channelId, payload] = post.mock.calls[0];
    expect(channelId).toBe('200');
    expect(payload.embeds).toHaveLength(2);
    expect(payload.embeds[0].color).toBe(0x57f287);
    expect(payload.embeds[1].color).toBe(0x3498db);
  });

  it('falls back (handled:false) for a non-Discord thread without posting', async () => {
    const post = postMock(okPost);
    const result = await deliverSectionEmbeds({ threadId: 'slack:1', text: 'hi', files: [] }, { post });
    expect(result).toEqual({ handled: false });
    expect(post).not.toHaveBeenCalled();
  });

  it('falls back when the body is blank and there are no files', async () => {
    const post = postMock(okPost);
    const result = await deliverSectionEmbeds({ threadId: 'discord:1:2', text: '   ', files: [] }, { post });
    expect(result).toEqual({ handled: false });
    expect(post).not.toHaveBeenCalled();
  });

  it('falls back when the REST post fails (null)', async () => {
    const post = postMock(async () => null);
    const result = await deliverSectionEmbeds({ threadId: 'discord:1:2', text: 'plain reply', files: [] }, { post });
    expect(result).toEqual({ handled: false });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('passes agent-sent files through as extraFiles', async () => {
    const post = postMock(async () => 'msg-9');
    await deliverSectionEmbeds(
      { threadId: 'discord:1:2', text: 'see attached', files: [{ data: Buffer.from([1]), filename: 'a.png' }] },
      { post },
    );
    const [, payload] = post.mock.calls[0];
    expect(payload.extraFiles).toEqual([{ name: 'a.png', data: Buffer.from([1]) }]);
  });

  it('splits embeds across messages when the 6000-char aggregate cap is exceeded', async () => {
    // Three sections, ~2500 chars each → 7500 total > 6000, so the real poster
    // must split into >1 Discord message instead of one rejected request.
    const big = (label: string) => `## ${label}\n${'가'.repeat(2500)}`;
    const text = [big('🔍 분석'), big('📌 결론'), big('⚠️ 주의')].join('\n\n');
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ id: 'm' }), { status: 200 }));
    // Use the real REST poster (only fetch + token injected) to exercise chunking.
    const result = await deliverSectionEmbeds(
      { threadId: 'discord:1:2', text, files: [] },
      { fetchFn: fetchFn as unknown as typeof fetch, token: 'x' },
    );
    expect(result.handled).toBe(true);
    expect(fetchFn.mock.calls.length).toBeGreaterThan(1);
  });

  it('falls back when rendering throws', async () => {
    const post = postMock(okPost);
    const build = vi.fn(async () => {
      throw new Error('boom');
    });
    const result = await deliverSectionEmbeds(
      { threadId: 'discord:1:2', text: 'x', files: [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { post, build: build as any },
    );
    expect(result).toEqual({ handled: false });
    expect(post).not.toHaveBeenCalled();
  });
});
