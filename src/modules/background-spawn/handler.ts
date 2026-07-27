/**
 * `spawn_subagent` delivery-action handler.
 *
 * Runs a long task in a SEPARATE, isolated, ephemeral worker session — its own
 * container, fresh context, surviving the parent's turn — and lets it post the
 * result back to the parent's origin channel.
 *
 * Design (see docs/UPSTREAM-MERGE.md and the gating test spawn-pattern.test.ts):
 *   - The worker session shares the parent's `agent_group_id` (so it sees the
 *     same group filesystem/memory and is authorized to reply to the origin
 *     channel via the same `agent_destinations` wiring row).
 *   - Its `messaging_group_id` is NULL, so `findSessionForAgent` for the channel
 *     never matches it — the parent keeps owning the channel's inbound.
 *   - The task is injected as an inbound stamped with the ORIGIN channel routing
 *     and the parent's thread, so the worker's reply lands where the request
 *     came from (resolveDestinationThread reads it from the inbound).
 *
 * Lifecycle: the worker session stays `active` (the 60s sweep is its reliable
 * delivery safety net; re-drains are idempotent). Finished workers — whose
 * container has exited — are reaped to `closed` on the next spawn so they stop
 * being swept and don't accumulate. No core change: cleanup is module-owned.
 */
import { wakeContainer } from '../../container-runner.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getSessionsByAgentGroup, updateSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { initSessionFolder, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

const WORKER_ID_PREFIX = 'bg-';

/**
 * Don't reap a worker younger than this: a just-spawned worker sits at
 * `container_status='stopped'` until `wakeContainer` → `markContainerRunning`
 * runs (several awaits later). Without this age guard, a concurrent spawn (the
 * active and sweep poll chains can interleave at await points) could reap a
 * sibling that is still booting. Boot is seconds; this is comfortably longer.
 */
const REAP_MIN_AGE_MS = 60_000;

function generateId(suffix: string): string {
  return `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Mark prior background workers whose container has already exited as closed, so
 * the sweep stops re-visiting them and they don't pile up as active sessions.
 * Skips workers younger than REAP_MIN_AGE_MS (they may still be booting).
 */
function reapFinishedWorkers(agentGroupId: string): void {
  const cutoff = Date.now() - REAP_MIN_AGE_MS;
  for (const s of getSessionsByAgentGroup(agentGroupId)) {
    if (
      s.id.startsWith(WORKER_ID_PREFIX) &&
      s.status === 'active' &&
      s.container_status === 'stopped' &&
      new Date(s.created_at).getTime() < cutoff
    ) {
      updateSession(s.id, { status: 'closed' });
      log.debug('Reaped finished background worker', { sessionId: s.id });
    }
  }
}

export async function handleSpawnSubagent(content: Record<string, unknown>, session: Session): Promise<void> {
  const prompt = typeof content.prompt === 'string' ? content.prompt.trim() : '';
  if (!prompt) {
    log.warn('spawn_subagent: empty prompt — ignoring', { parentSessionId: session.id });
    return;
  }

  // Origin = the parent session's channel. The worker posts its result there;
  // without an origin channel there is nowhere to deliver, so skip.
  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  if (!mg) {
    log.warn('spawn_subagent: parent session has no origin channel — ignoring', {
      parentSessionId: session.id,
    });
    return;
  }

  reapFinishedWorkers(session.agent_group_id);

  const worker: Session = {
    id: generateId(WORKER_ID_PREFIX),
    agent_group_id: session.agent_group_id,
    messaging_group_id: null, // never matched by findSessionForAgent on a channel
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
  createSession(worker);
  initSessionFolder(worker.agent_group_id, worker.id); // creates inbound.db + outbound.db

  // Inject the task as inbound, stamped with the ORIGIN routing + the parent's
  // thread so the worker's reply lands where the request came from.
  writeSessionMessage(worker.agent_group_id, worker.id, {
    id: generateId('bg-task'),
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: mg.platform_id,
    channelType: mg.channel_type,
    threadId: session.thread_id,
    content: JSON.stringify({ text: prompt, sender: 'system', senderId: 'system' }),
  });

  log.info('Background sub-agent spawned', {
    workerSessionId: worker.id,
    parentSessionId: session.id,
    agentGroupId: worker.agent_group_id,
  });

  await wakeContainer(worker);
}
