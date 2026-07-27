/**
 * Tests for the core MCP tools' in_reply_to resolution. send_message and
 * send_file run in the MCP tools subprocess, which shares no memory with
 * the poll loop — so in_reply_to must be resolved by reading inbound.db
 * directly (mirroring the final <message> block's dispatch), not from an
 * in-process value set by the poll loop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendMessage } from './core.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps in_reply_to from the most recent matching inbound row', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, channel_type, platform_id, content)
         VALUES ('inbound-msg-1', 1, 'chat', '2026-01-01T00:00:00Z', 'agent', 'ag-peer', '{}')`,
      )
      .run();

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no inbound row matches the destination', async () => {
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});
