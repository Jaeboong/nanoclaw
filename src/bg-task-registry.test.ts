import { describe, expect, it } from 'vitest';

import { BgTaskRegistry } from './bg-task-registry.js';
import { bgNamespace } from './ipc-namespace.js';

function entry(taskId: string, folder = 'discord_main', jid = 'dc:123') {
  return {
    taskId,
    chatJid: jid,
    groupFolder: folder,
    isMain: folder === 'main',
    namespace: bgNamespace(folder, taskId),
  };
}

describe('BgTaskRegistry', () => {
  it('starts empty', () => {
    const r = new BgTaskRegistry();
    expect(r.size()).toBe(0);
    expect(r.list()).toEqual([]);
  });

  it('registers and retrieves by taskId', () => {
    const r = new BgTaskRegistry();
    r.register(entry('task-a'));
    const got = r.get('task-a');
    expect(got).toBeDefined();
    expect(got?.taskId).toBe('task-a');
    expect(got?.registeredAt).toBeGreaterThan(0);
  });

  it('is idempotent: second register with same taskId is a no-op', () => {
    const r = new BgTaskRegistry();
    r.register(entry('task-a'));
    const firstTs = r.get('task-a')!.registeredAt;
    r.register(entry('task-a'));
    expect(r.size()).toBe(1);
    expect(r.get('task-a')!.registeredAt).toBe(firstTs);
  });

  it('unregister removes the entry', () => {
    const r = new BgTaskRegistry();
    r.register(entry('task-a'));
    r.unregister('task-a');
    expect(r.size()).toBe(0);
    expect(r.get('task-a')).toBeUndefined();
  });

  it('unregister on missing id is a no-op', () => {
    const r = new BgTaskRegistry();
    expect(() => r.unregister('nope')).not.toThrow();
  });

  it('listByGroupFolder filters correctly', () => {
    const r = new BgTaskRegistry();
    r.register(entry('task-a', 'discord_main'));
    r.register(entry('task-b', 'discord_main'));
    r.register(entry('task-c', 'slack_ops'));

    const discord = r.listByGroupFolder('discord_main').map((e) => e.taskId);
    expect(discord.sort()).toEqual(['task-a', 'task-b']);

    const slack = r.listByGroupFolder('slack_ops').map((e) => e.taskId);
    expect(slack).toEqual(['task-c']);

    expect(r.listByGroupFolder('nonexistent')).toEqual([]);
  });

  it('list returns a snapshot (mutation-safe)', () => {
    const r = new BgTaskRegistry();
    r.register(entry('task-a'));
    const snap = r.list();
    r.register(entry('task-b'));
    expect(snap).toHaveLength(1);
    expect(r.list()).toHaveLength(2);
  });
});
