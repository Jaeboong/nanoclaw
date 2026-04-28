import path from 'path';

import { DATA_DIR } from './config.js';
import { assertValidGroupFolder, resolveGroupIpcPath } from './group-folder.js';

/**
 * An IPC namespace identifies a writable directory on the host that a single
 * container's IPC layer maps to `/workspace/ipc`. Splitting this into an
 * explicit value type lets callers depend on a resolver rather than hard-coded
 * path logic, which keeps the host and container wiring decoupled.
 *
 * Two namespace flavors exist:
 *   - group: the long-lived directory shared by a registered group. Polled by
 *     the IPC watcher by virtue of living directly under DATA_DIR/ipc.
 *   - bg: a per-task directory used by fire-and-forget parallel subagents so
 *     their input/_close sentinels and drainIpcInput() scans don't collide
 *     with the group's primary container.
 */
export interface IpcNamespace {
  /** Stable identifier, used as a Map key and in logs. */
  readonly key: string;
  /** Writable host path. Gets mounted at `containerPath` inside the container. */
  readonly hostPath: string;
  /** In-container mount point. Always `/workspace/ipc` today. */
  readonly containerPath: string;
  /** The owning group folder — bg namespaces inherit this from their parent. */
  readonly groupFolder: string;
  /** Non-null for bg namespaces; null for the group namespace itself. */
  readonly taskId: string | null;
}

const CONTAINER_IPC_PATH = '/workspace/ipc';
const BG_DIR_PREFIX = 'bg-';
const BG_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertValidBgTaskId(taskId: string): void {
  if (!BG_TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`Invalid bg task id "${taskId}"`);
  }
}

export function isValidBgTaskId(taskId: string): boolean {
  return BG_TASK_ID_PATTERN.test(taskId);
}

export function groupNamespace(folder: string): IpcNamespace {
  assertValidGroupFolder(folder);
  return {
    key: `group:${folder}`,
    hostPath: resolveGroupIpcPath(folder),
    containerPath: CONTAINER_IPC_PATH,
    groupFolder: folder,
    taskId: null,
  };
}

export function bgNamespace(folder: string, taskId: string): IpcNamespace {
  assertValidGroupFolder(folder);
  assertValidBgTaskId(taskId);
  const groupIpc = resolveGroupIpcPath(folder);
  const bgDir = path.join(groupIpc, `${BG_DIR_PREFIX}${taskId}`);
  return {
    key: `bg:${folder}:${taskId}`,
    hostPath: bgDir,
    containerPath: CONTAINER_IPC_PATH,
    groupFolder: folder,
    taskId,
  };
}

/**
 * True when the given sub-directory name under a group's IPC dir is a bg
 * namespace slot (rather than the group's own `messages/`, `tasks/`, `input/`).
 */
export function isBgSubdir(name: string): boolean {
  if (!name.startsWith(BG_DIR_PREFIX)) return false;
  const taskId = name.slice(BG_DIR_PREFIX.length);
  return isValidBgTaskId(taskId);
}

/**
 * Absolute host path to the shared IPC base directory. Exposed here so
 * callers that enumerate namespaces don't reach into config internals.
 */
export function ipcBaseDir(): string {
  return path.join(DATA_DIR, 'ipc');
}
