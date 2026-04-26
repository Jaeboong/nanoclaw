/**
 * RTS AI tool aggregator.
 *
 * The rts-ai group exposes the RTS game's AICommand schema as Claude Agent SDK
 * tools (one tool per command type). The handlers do NOT execute the command —
 * they record it into a per-query buffer. The host extracts the buffer at
 * end-of-turn and serialises it as a JSON array, which is what the RTS client
 * (`NanoclawPlayer`) parses.
 *
 * This replaces the previous "LLM emits a JSON array as plaintext" contract,
 * which suffered from schema drift (e.g. cancel.unitIds vs entityId), reasoning
 * compression (single forced emission), and silent skipped commands.
 */
import { z } from 'zod';
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';

export const RTS_GROUP_FOLDER = 'rts-ai';
export const RTS_MCP_SERVER_NAME = 'rts';

/**
 * AICommand mirrors `src/game/players/types.ts` in the rts2 repo. Keep these
 * in sync — the consumer (`parseCommands`) deserialises the JSON array into
 * the same union.
 */
export type AICommand =
  | { type: 'move'; unitIds: number[]; target: { x: number; y: number } }
  | { type: 'attack'; unitIds: number[]; targetId: number }
  | { type: 'attackMove'; unitIds: number[]; target: { x: number; y: number } }
  | { type: 'gather'; unitIds: number[]; nodeId: number }
  | {
      type: 'build';
      workerId: number;
      building: string;
      cellX: number;
      cellY: number;
    }
  | { type: 'produce'; buildingId: number; unit: string }
  | { type: 'setRally'; buildingId: number; pos: { x: number; y: number } }
  | { type: 'cancel'; entityId: number };

const Vec2 = { x: z.number(), y: z.number() };
const idArray = z
  .array(z.number().int())
  .min(1)
  .describe('One or more entity ids belonging to your team');
const id = z.number().int().describe('Entity id from the prompt');

function ok(message = 'ok') {
  return {
    content: [{ type: 'text' as const, text: message }],
  };
}

/** Direct invocation result mirroring MCP CallToolResult, kept narrow. */
export interface ToolInvokeResult {
  content: ReadonlyArray<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface RtsAggregator {
  /** MCP server config for `query({ options: { mcpServers } })`. */
  readonly mcpServer: McpSdkServerConfigWithInstance;
  /** Tool names to add to `allowedTools` (with `mcp__<server>__` prefix). */
  readonly allowedToolNames: readonly string[];
  /** Snapshot of accumulated commands (does not clear). */
  snapshot(): readonly AICommand[];
  /** Return all accumulated commands and clear the buffer. */
  drain(): AICommand[];
  /**
   * Invoke a registered tool by short name (without the `mcp__rts__` prefix)
   * and return the SDK-shaped result. Exposed for unit tests; the production
   * call path goes through the SDK's MCP transport, not this method.
   */
  invokeForTest(
    name: string,
    input: Record<string, unknown>,
  ): Promise<ToolInvokeResult>;
}

/**
 * Create a new aggregator. One per `runQuery` invocation — closure over
 * `commands` keeps state local so concurrent groups can't bleed into each
 * other (relevant if the agent-runner ever runs multiple sessions in one
 * process).
 */
export function createRtsAggregator(): RtsAggregator {
  const commands: AICommand[] = [];

  const tools = [
    tool(
      'move',
      'Order units to walk to a world-pixel coordinate without engaging enemies. ' +
        'Use for repositioning. For combat advances, use attackMove instead.',
      { unitIds: idArray, target: z.object(Vec2) },
      async ({ unitIds, target }) => {
        commands.push({
          type: 'move',
          unitIds: unitIds.map((n) => Math.trunc(n)),
          target: { x: target.x, y: target.y },
        });
        return ok();
      },
    ),
    tool(
      'attack',
      'Order units to attack a specific enemy entity (chases until in range). ' +
        'targetId must be a hostile entity id from the prompt.',
      { unitIds: idArray, targetId: id },
      async ({ unitIds, targetId }) => {
        commands.push({
          type: 'attack',
          unitIds: unitIds.map((n) => Math.trunc(n)),
          targetId: Math.trunc(targetId),
        });
        return ok();
      },
    ),
    tool(
      'attackMove',
      'Order units to advance toward a world-pixel coordinate, engaging any ' +
        'enemies that come into range along the way.',
      { unitIds: idArray, target: z.object(Vec2) },
      async ({ unitIds, target }) => {
        commands.push({
          type: 'attackMove',
          unitIds: unitIds.map((n) => Math.trunc(n)),
          target: { x: target.x, y: target.y },
        });
        return ok();
      },
    ),
    tool(
      'gather',
      'Order one or more workers to gather minerals from a depot-claimed ' +
        'mineralNode. The node must already have a completed supplyDepot built ' +
        'on top of it (build supplyDepot first if not). nodeId may be either ' +
        'the mineralNode id or its claimed supplyDepot id.',
      { unitIds: idArray, nodeId: id },
      async ({ unitIds, nodeId }) => {
        commands.push({
          type: 'gather',
          unitIds: unitIds.map((n) => Math.trunc(n)),
          nodeId: Math.trunc(nodeId),
        });
        return ok();
      },
    ),
    tool(
      'build',
      'Order one worker to construct a building at the given grid cell ' +
        '(0..127). For supplyDepot/refinery, cellX/cellY must equal the host ' +
        "mineralNode/gasGeyser's cellX/cellY exactly.",
      {
        workerId: id,
        building: z
          .string()
          .describe(
            'Building kind: commandCenter, supplyDepot, barracks, refinery, factory, turret',
          ),
        cellX: z.number().int().min(0).max(127),
        cellY: z.number().int().min(0).max(127),
      },
      async ({ workerId, building, cellX, cellY }) => {
        commands.push({
          type: 'build',
          workerId: Math.trunc(workerId),
          building,
          cellX: Math.trunc(cellX),
          cellY: Math.trunc(cellY),
        });
        return ok();
      },
    ),
    tool(
      'produce',
      'Add a unit to a production building queue. CC produces worker; ' +
        'barracks produces marine/medic; factory produces tank/tank-light.',
      {
        buildingId: id,
        unit: z
          .string()
          .describe('Unit kind: worker, marine, medic, tank, tank-light'),
      },
      async ({ buildingId, unit }) => {
        commands.push({
          type: 'produce',
          buildingId: Math.trunc(buildingId),
          unit,
        });
        return ok();
      },
    ),
    tool(
      'setRally',
      'Set the rally point for a production building. Newly produced units ' +
        'walk to this world-pixel coordinate after spawning.',
      { buildingId: id, pos: z.object(Vec2) },
      async ({ buildingId, pos }) => {
        commands.push({
          type: 'setRally',
          buildingId: Math.trunc(buildingId),
          pos: { x: pos.x, y: pos.y },
        });
        return ok();
      },
    ),
    tool(
      'cancel',
      'Cancel the current order or production for a single entity (worker ' +
        'task, building production queue head, or in-progress construction).',
      { entityId: id },
      async ({ entityId }) => {
        commands.push({ type: 'cancel', entityId: Math.trunc(entityId) });
        return ok();
      },
    ),
  ];

  const mcpServer = createSdkMcpServer({
    name: RTS_MCP_SERVER_NAME,
    version: '1.0.0',
    tools,
  });

  const allowedToolNames = tools.map(
    (t) => `mcp__${RTS_MCP_SERVER_NAME}__${t.name}`,
  );

  // Build a name -> handler map for direct test invocation. We use the same
  // tool definitions that were registered with the SDK, so a contract change
  // in production code is automatically reflected here.
  const handlerByName = new Map(
    tools.map((t) => [t.name, t.handler] as const),
  );

  return {
    mcpServer,
    allowedToolNames,
    snapshot() {
      return commands.slice();
    },
    drain() {
      const out = commands.slice();
      commands.length = 0;
      return out;
    },
    async invokeForTest(name, input) {
      const handler = handlerByName.get(name);
      if (!handler) {
        return {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        };
      }
      // Cast to match the heterogenous-shape handler signature; production
      // path validates via Zod inside the SDK transport.
      const result = (await handler(
        input as never,
        undefined,
      )) as ToolInvokeResult;
      return result;
    },
  };
}

/**
 * Single-line system-prompt append injected for the rts-ai group. Tells the
 * model to use the rts tools (instead of the legacy plaintext-JSON contract).
 * The bulk of the game manual stays in groups/rts-ai/CLAUDE.md.
 */
export const RTS_TOOL_MODE_SYSTEM_APPEND = [
  '',
  '## RTS tool-call mode (active)',
  '',
  'You issue commands by calling the rts__* tools (move, attack, attackMove, ' +
    'gather, build, produce, setRally, cancel). Each tool call records one ' +
    'AICommand. Make all the calls you want for this tick, then end your turn.',
  '',
  'Do NOT emit a JSON array in your prose — the host now harvests the tool ' +
    'calls directly. Prose is ignored for the response payload but is fine ' +
    'for brief reasoning. To pass on this tick, simply make zero tool calls ' +
    'and end the turn.',
].join('\n');

/**
 * Final response payload format. Always a stringified JSON array — never null
 * or an empty string — so the host parser has a stable contract.
 */
export function formatRtsResult(commands: readonly AICommand[]): string {
  return JSON.stringify(commands);
}
