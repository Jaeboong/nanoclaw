import { IpcNamespace } from './ipc-namespace.js';

/**
 * A bg task entry tracks one active parallel subagent. The IPC watcher
 * consults the registry to discover which bg namespaces need scanning, and
 * the scheduler uses it for lifecycle cleanup (unregister on container exit,
 * list for shutdown).
 */
export interface BgTaskEntry {
  taskId: string;
  /** The chat JID that receives the subagent's outbound messages. */
  chatJid: string;
  /** The owning group — authorization and routing use this. */
  groupFolder: string;
  /** Whether the owning group is the trusted main group. */
  isMain: boolean;
  /** IPC namespace assigned to this subagent. */
  namespace: IpcNamespace;
  registeredAt: number;
}

/**
 * In-memory registry of active bg (parallel) subagent tasks. Intentionally
 * process-local: bg tasks are fire-and-forget and should not survive a
 * NanoClaw restart. The DB row (execution_mode=parallel) is the durable
 * record for audit; this registry is only the "currently spawning" view.
 */
export class BgTaskRegistry {
  private byTaskId = new Map<string, BgTaskEntry>();

  register(entry: Omit<BgTaskEntry, 'registeredAt'>): void {
    if (this.byTaskId.has(entry.taskId)) {
      // Idempotent — second register for the same task id is a no-op.
      return;
    }
    this.byTaskId.set(entry.taskId, { ...entry, registeredAt: Date.now() });
  }

  unregister(taskId: string): void {
    this.byTaskId.delete(taskId);
  }

  get(taskId: string): BgTaskEntry | undefined {
    return this.byTaskId.get(taskId);
  }

  /** Snapshot of currently-registered entries. Safe to iterate. */
  list(): BgTaskEntry[] {
    return [...this.byTaskId.values()];
  }

  /** Entries owned by a given group folder. Used by the IPC watcher. */
  listByGroupFolder(groupFolder: string): BgTaskEntry[] {
    const out: BgTaskEntry[] = [];
    for (const entry of this.byTaskId.values()) {
      if (entry.groupFolder === groupFolder) out.push(entry);
    }
    return out;
  }

  size(): number {
    return this.byTaskId.size;
  }
}
