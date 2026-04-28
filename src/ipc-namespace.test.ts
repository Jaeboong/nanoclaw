import path from 'path';

import { describe, expect, it } from 'vitest';

import { DATA_DIR } from './config.js';
import {
  assertValidBgTaskId,
  bgNamespace,
  groupNamespace,
  ipcBaseDir,
  isBgSubdir,
  isValidBgTaskId,
} from './ipc-namespace.js';

describe('groupNamespace', () => {
  it('resolves to data/ipc/<folder>', () => {
    const ns = groupNamespace('main');
    expect(ns.hostPath).toBe(path.join(DATA_DIR, 'ipc', 'main'));
    expect(ns.containerPath).toBe('/workspace/ipc');
    expect(ns.key).toBe('group:main');
    expect(ns.groupFolder).toBe('main');
    expect(ns.taskId).toBeNull();
  });

  it('rejects invalid folder names', () => {
    expect(() => groupNamespace('../escape')).toThrow();
    expect(() => groupNamespace('global')).toThrow();
    expect(() => groupNamespace('')).toThrow();
  });
});

describe('bgNamespace', () => {
  it('nests under the group ipc dir with bg- prefix', () => {
    const ns = bgNamespace('discord_main', 'task-123-abc');
    expect(ns.hostPath).toBe(
      path.join(DATA_DIR, 'ipc', 'discord_main', 'bg-task-123-abc'),
    );
    expect(ns.key).toBe('bg:discord_main:task-123-abc');
    expect(ns.groupFolder).toBe('discord_main');
    expect(ns.taskId).toBe('task-123-abc');
  });

  it('rejects invalid task ids', () => {
    expect(() => bgNamespace('main', '')).toThrow();
    expect(() => bgNamespace('main', '../escape')).toThrow();
    expect(() => bgNamespace('main', 'has spaces')).toThrow();
  });

  it('rejects invalid folders', () => {
    expect(() => bgNamespace('global', 'task-1')).toThrow();
  });
});

describe('isValidBgTaskId', () => {
  it('accepts typical generated ids', () => {
    expect(isValidBgTaskId('task-1700000000000-abc123')).toBe(true);
    expect(isValidBgTaskId('bg_job_42')).toBe(true);
  });

  it('rejects traversal, spaces, dots', () => {
    expect(isValidBgTaskId('../escape')).toBe(false);
    expect(isValidBgTaskId('a b')).toBe(false);
    expect(isValidBgTaskId('a.b')).toBe(false);
    expect(isValidBgTaskId('')).toBe(false);
    expect(isValidBgTaskId('-leading-dash')).toBe(false);
  });
});

describe('assertValidBgTaskId', () => {
  it('throws on invalid', () => {
    expect(() => assertValidBgTaskId('')).toThrow();
    expect(() => assertValidBgTaskId('..')).toThrow();
  });

  it('passes on valid', () => {
    expect(() => assertValidBgTaskId('task-1')).not.toThrow();
  });
});

describe('isBgSubdir', () => {
  it('matches bg- prefixed valid task ids', () => {
    expect(isBgSubdir('bg-task-1')).toBe(true);
    expect(isBgSubdir('bg-abc_def')).toBe(true);
  });

  it('rejects group sibling dirs', () => {
    expect(isBgSubdir('messages')).toBe(false);
    expect(isBgSubdir('tasks')).toBe(false);
    expect(isBgSubdir('input')).toBe(false);
    expect(isBgSubdir('errors')).toBe(false);
  });

  it('rejects malformed bg names', () => {
    expect(isBgSubdir('bg-')).toBe(false);
    expect(isBgSubdir('bg-../escape')).toBe(false);
    expect(isBgSubdir('bg- space')).toBe(false);
  });
});

describe('ipcBaseDir', () => {
  it('returns data/ipc', () => {
    expect(ipcBaseDir()).toBe(path.join(DATA_DIR, 'ipc'));
  });
});
