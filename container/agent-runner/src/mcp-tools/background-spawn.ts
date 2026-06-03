/**
 * Background spawn MCP tool: spawn_subagent.
 *
 * For long, slow work (deploys, big research, migrations) that should NOT block
 * the current turn and should survive it ending. Fire-and-forget: the host runs
 * the task in a SEPARATE container (its own isolated session) and posts the
 * result back to this channel when done — unlike the built-in Agent/Task tool,
 * whose sub-agents are in-process and die when this container idles out.
 *
 * The container can't write to inbound.db; it emits a `kind='system'` outbound
 * message with `action: 'spawn_subagent'`, which the host's delivery-action
 * registry routes to the background-spawn module (src/modules/background-spawn).
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const spawnSubagent: McpToolDefinition = {
  tool: {
    name: 'spawn_subagent',
    description:
      'Run a long/slow task (deploy, large research, migration) in a separate background sub-agent that survives your turn ending. ' +
      'Fire-and-forget: it works in its own isolated container and posts its result back to this channel when done. ' +
      'Use it for anything you should not block on; for a quick in-turn delegation use the built-in Agent tool instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description:
            'Self-contained task for the background sub-agent. It starts with a FRESH context, so include all the context it needs.',
        },
        description: { type: 'string', description: 'Short label for the task (optional).' },
      },
      required: ['prompt'],
    },
  },
  async handler(args) {
    const prompt = args.prompt as string;
    if (!prompt) return err('prompt is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'spawn_subagent',
        requestId,
        prompt,
        description: (args.description as string) || null,
      }),
    });

    const label = (args.description as string) || null;
    log(`spawn_subagent: ${requestId}${label ? ` (${label})` : ''}`);
    return ok(
      `Background sub-agent ${requestId} started${label ? ` (${label})` : ''}. ` +
        'It will post its result back to this channel when done.',
    );
  },
};

registerTools([spawnSubagent]);
