import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerState } from '../../db/session-db.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { __testHooks, formatStatus, startStatusLine, stopStatusLine } from './index.js';
// Side effect: registers setStatusLineAdapter via onDeliveryAdapterReady, so
// the setDeliveryAdapter() call below binds the adapter through the real path.
import './register.js';

interface DeliverCall {
  channelType: string;
  platformId: string;
  threadId: string | null;
  kind: string;
  content: Record<string, unknown>;
}

function makeAdapter(): { adapter: ChannelDeliveryAdapter; calls: DeliverCall[] } {
  const calls: DeliverCall[] = [];
  let nextId = 1;
  const adapter: ChannelDeliveryAdapter = {
    async deliver(channelType, platformId, threadId, kind, content) {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      calls.push({ channelType, platformId, threadId, kind, content: parsed });
      // A fresh post (no operation) returns the new message id; edit/delete
      // return nothing — mirrors the chat-SDK bridge.
      return parsed.operation ? undefined : `msg-${nextId++}`;
    },
  };
  return { adapter, calls };
}

function tool(name: string | null, startedAt: string | null = '2026-06-01T00:00:00.000Z'): ContainerState {
  return { current_tool: name, tool_declared_timeout_ms: null, tool_started_at: startedAt };
}

const SID = 's1';

/** Bind the fake adapter through the real onDeliveryAdapterReady path. */
async function bindAdapter(adapter: ChannelDeliveryAdapter): Promise<void> {
  setDeliveryAdapter(adapter);
  // onDeliveryAdapterReady callbacks fire on a microtask — flush it.
  await Promise.resolve();
  await Promise.resolve();
}

describe('formatStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:12.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('shows the tool name and elapsed seconds', () => {
    expect(formatStatus(tool('Bash'))).toBe('🔧 Bash · 12초');
  });

  it('shows a neutral working line when no tool is in flight', () => {
    expect(formatStatus(tool(null))).toBe('💭 작업 중…');
    expect(formatStatus(null)).toBe('💭 작업 중…');
  });

  it('treats a missing tool_started_at as 0 seconds', () => {
    expect(formatStatus(tool('Read', null))).toBe('🔧 Read · 0초');
  });
});

describe('status-line lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:12.000Z'));
  });
  afterEach(() => {
    stopStatusLine(SID);
    __testHooks.resetStateReader();
    vi.useRealTimers();
  });

  it('does not post anything until the agent runs its first tool', async () => {
    const { adapter, calls } = makeAdapter();
    await bindAdapter(adapter);
    __testHooks.setStateReader(() => tool(null)); // working, but no tool yet
    startStatusLine(SID, 'g1', 'discord', 'plat', null);

    await __testHooks.tick(SID);

    expect(calls).toHaveLength(0);
    expect(__testHooks.isTracked(SID)).toBe(true);
  });

  it('posts once when a tool appears, then edits in place on change', async () => {
    const { adapter, calls } = makeAdapter();
    await bindAdapter(adapter);
    startStatusLine(SID, 'g1', 'discord', 'plat', null);

    // First tool → a fresh post.
    __testHooks.setStateReader(() => tool('Bash'));
    await __testHooks.tick(SID);
    expect(calls).toHaveLength(1);
    expect(calls[0].content.operation).toBeUndefined();
    expect(calls[0].content.text).toBe('🔧 Bash · 12초');
    expect(calls[0].kind).toBe('chat-sdk');

    // Same text → no redundant post/edit.
    await __testHooks.tick(SID);
    expect(calls).toHaveLength(1);

    // Different tool → an in-place edit targeting the posted message id.
    __testHooks.setStateReader(() => tool('Read'));
    await __testHooks.tick(SID);
    expect(calls).toHaveLength(2);
    expect(calls[1].content.operation).toBe('edit');
    expect(calls[1].content.messageId).toBe('msg-1');
    expect(calls[1].content.text).toBe('🔧 Read · 12초');
  });

  it('edits to the neutral line when the tool clears, then deletes on stop', async () => {
    const { adapter, calls } = makeAdapter();
    await bindAdapter(adapter);
    startStatusLine(SID, 'g1', 'discord', 'plat', null);

    __testHooks.setStateReader(() => tool('Bash'));
    await __testHooks.tick(SID); // post
    __testHooks.setStateReader(() => tool(null));
    await __testHooks.tick(SID); // edit → 작업 중
    expect(calls[1].content.operation).toBe('edit');
    expect(calls[1].content.text).toBe('💭 작업 중…');

    stopStatusLine(SID);
    expect(calls).toHaveLength(3);
    expect(calls[2].content.operation).toBe('delete');
    expect(calls[2].content.messageId).toBe('msg-1');
    expect(__testHooks.isTracked(SID)).toBe(false);
  });

  it('stop is a no-op (no delete) when nothing was ever posted', async () => {
    const { adapter, calls } = makeAdapter();
    await bindAdapter(adapter);
    __testHooks.setStateReader(() => tool(null));
    startStatusLine(SID, 'g1', 'discord', 'plat', null);
    await __testHooks.tick(SID);

    stopStatusLine(SID);
    expect(calls).toHaveLength(0);
  });

  it('deletes the message even when the turn ends while the first post is in flight', async () => {
    // Adapter whose initial post hangs until we release it, so we can stop
    // the session mid-post (the leak the race guard prevents).
    const calls: DeliverCall[] = [];
    let releasePost: (id: string) => void = () => {};
    const adapter: ChannelDeliveryAdapter = {
      async deliver(channelType, platformId, threadId, kind, content) {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        calls.push({ channelType, platformId, threadId, kind, content: parsed });
        if (parsed.operation) return undefined; // edit/delete resolve at once
        return new Promise<string>((resolve) => {
          releasePost = resolve;
        });
      },
    };
    await bindAdapter(adapter);
    __testHooks.setStateReader(() => tool('Bash'));
    startStatusLine(SID, 'g1', 'discord', 'plat', null);

    const tickPromise = __testHooks.tick(SID); // blocks awaiting the post
    stopStatusLine(SID); // turn ends mid-post — no messageId to delete yet
    releasePost('msg-1'); // post finally resolves
    await tickPromise;

    // The in-flight tick must clean up the message it just created.
    const deletes = calls.filter((c) => c.content.operation === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].content.messageId).toBe('msg-1');
    expect(__testHooks.isTracked(SID)).toBe(false);
  });

  it('start is idempotent for an already-tracked session', async () => {
    const { adapter } = makeAdapter();
    await bindAdapter(adapter);
    startStatusLine(SID, 'g1', 'discord', 'plat', null);
    startStatusLine(SID, 'g1', 'discord', 'plat', null);
    expect(__testHooks.isTracked(SID)).toBe(true);
  });
});
