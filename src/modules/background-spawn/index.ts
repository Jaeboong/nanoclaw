/**
 * Background-spawn module — `spawn_subagent`.
 *
 * Additive module (see docs/UPSTREAM-MERGE.md). Registers a delivery-action
 * handler for the container's `spawn_subagent` system message via the existing
 * `registerDeliveryAction` seam — no core change. The matching container MCP
 * tool lives at container/agent-runner/src/mcp-tools/background-spawn.ts.
 */
import { registerDeliveryAction } from '../../delivery.js';

import { handleSpawnSubagent } from './handler.js';

registerDeliveryAction('spawn_subagent', handleSpawnSubagent);

export { handleSpawnSubagent };
