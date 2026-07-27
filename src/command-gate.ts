/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Normal messages: pass through unchanged
 */
import { getDb, hasTable } from './db/connection.js';

export type GateResult = { action: 'pass' } | { action: 'filter' } | { action: 'deny'; command: string };

const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files', '/upload-trace']);

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages and authorized admin commands,
 * 'filter' for silently-dropped commands, 'deny' for unauthorized
 * admin commands.
 */
export function gateCommand(content: string, userId: string | null, agentGroupId: string): GateResult {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  if (!text.startsWith('/')) return { action: 'pass' };

  const command = text.split(/\s/)[0].toLowerCase();

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (ADMIN_COMMANDS.has(command)) {
    if (isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}

/**
 * Whether `userId` holds owner/admin over `agentGroupId`. Exported so the
 * Discord slash/interaction framework gates admin commands with the exact
 * same semantics as the typed-command gate (owner/global-admin match
 * regardless of group via the `agent_group_id IS NULL` row; scoped admin
 * matches the specific group). `agentGroupId` may be null for commands not
 * bound to a channel — only owner/global-admin then authorize. When the
 * permissions module isn't installed (`user_roles` absent), allow all.
 */
export function isAdmin(userId: string | null, agentGroupId: string | null): boolean {
  if (!userId) return false;
  if (!hasTable(getDb(), 'user_roles')) return true; // no permissions module = allow all
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (role = 'owner' OR role = 'admin')
         AND (agent_group_id IS NULL OR agent_group_id = ?)
       LIMIT 1`,
    )
    .get(userId, agentGroupId);
  return row != null;
}
