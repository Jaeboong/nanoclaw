import { describe, it, expect } from 'vitest';
import {
  createRtsAggregator,
  formatRtsResult,
  RTS_GROUP_FOLDER,
  RTS_MCP_SERVER_NAME,
  RTS_TOOL_MODE_SYSTEM_APPEND,
  type AICommand,
} from './rts-tools.js';

describe('rts-tools constants', () => {
  it('exports the rts-ai group folder name and MCP server name', () => {
    expect(RTS_GROUP_FOLDER).toBe('rts-ai');
    expect(RTS_MCP_SERVER_NAME).toBe('rts');
  });

  it('system-prompt append mentions tool-call mode and the tool family', () => {
    expect(RTS_TOOL_MODE_SYSTEM_APPEND).toMatch(/tool-call mode/i);
    expect(RTS_TOOL_MODE_SYSTEM_APPEND).toMatch(/move|attack|gather|build/);
  });
});

describe('createRtsAggregator surface', () => {
  it('starts with an empty buffer and a configured MCP server', () => {
    const agg = createRtsAggregator();
    expect(agg.snapshot()).toEqual([]);
    expect(agg.mcpServer.type).toBe('sdk');
    expect(agg.mcpServer.name).toBe('rts');
    expect(agg.mcpServer.instance).toBeDefined();
  });

  it('exposes one allowed-tool name per AICommand variant, prefixed', () => {
    const agg = createRtsAggregator();
    expect(agg.allowedToolNames).toEqual([
      'mcp__rts__move',
      'mcp__rts__attack',
      'mcp__rts__attackMove',
      'mcp__rts__gather',
      'mcp__rts__build',
      'mcp__rts__produce',
      'mcp__rts__setRally',
      'mcp__rts__cancel',
    ]);
  });
});

describe('aggregator handlers record AICommands', () => {
  it('records a move command with the exact field shape', async () => {
    const agg = createRtsAggregator();
    const result = await agg.invokeForTest('move', {
      unitIds: [10, 11],
      target: { x: 320, y: 480 },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('ok');
    expect(agg.snapshot()).toEqual<AICommand[]>([
      { type: 'move', unitIds: [10, 11], target: { x: 320, y: 480 } },
    ]);
  });

  it('records an attack command (singular targetId)', async () => {
    const agg = createRtsAggregator();
    await agg.invokeForTest('attack', { unitIds: [5], targetId: 99 });
    expect(agg.snapshot()).toEqual<AICommand[]>([
      { type: 'attack', unitIds: [5], targetId: 99 },
    ]);
  });

  it('records an attackMove command with target coords', async () => {
    const agg = createRtsAggregator();
    await agg.invokeForTest('attackMove', {
      unitIds: [50, 51, 52],
      target: { x: 100, y: 200 },
    });
    expect(agg.snapshot()).toEqual<AICommand[]>([
      {
        type: 'attackMove',
        unitIds: [50, 51, 52],
        target: { x: 100, y: 200 },
      },
    ]);
  });

  it('records a gather command for one or more workers', async () => {
    const agg = createRtsAggregator();
    await agg.invokeForTest('gather', { unitIds: [38, 39], nodeId: 15 });
    expect(agg.snapshot()).toEqual<AICommand[]>([
      { type: 'gather', unitIds: [38, 39], nodeId: 15 },
    ]);
  });

  it('records a build command with cellX/cellY in 0..127', async () => {
    const agg = createRtsAggregator();
    await agg.invokeForTest('build', {
      workerId: 37,
      building: 'supplyDepot',
      cellX: 93,
      cellY: 22,
    });
    expect(agg.snapshot()).toEqual<AICommand[]>([
      {
        type: 'build',
        workerId: 37,
        building: 'supplyDepot',
        cellX: 93,
        cellY: 22,
      },
    ]);
  });

  it('records a produce command (buildingId + unit kind)', async () => {
    const agg = createRtsAggregator();
    await agg.invokeForTest('produce', { buildingId: 11, unit: 'marine' });
    expect(agg.snapshot()).toEqual<AICommand[]>([
      { type: 'produce', buildingId: 11, unit: 'marine' },
    ]);
  });

  it('records a setRally command with pos coords', async () => {
    const agg = createRtsAggregator();
    await agg.invokeForTest('setRally', {
      buildingId: 11,
      pos: { x: 600, y: 700 },
    });
    expect(agg.snapshot()).toEqual<AICommand[]>([
      { type: 'setRally', buildingId: 11, pos: { x: 600, y: 700 } },
    ]);
  });

  it('records a cancel command (entityId, NOT unitIds — schema fix)', async () => {
    const agg = createRtsAggregator();
    await agg.invokeForTest('cancel', { entityId: 42 });
    expect(agg.snapshot()).toEqual<AICommand[]>([
      { type: 'cancel', entityId: 42 },
    ]);
  });

  it('rejects an unknown tool name with isError=true', async () => {
    const agg = createRtsAggregator();
    const result = await agg.invokeForTest('teleport', {});
    expect(result.isError).toBe(true);
    expect(agg.snapshot()).toEqual([]);
  });
});

describe('aggregator buffering and drain', () => {
  it('accumulates multiple tool calls in order', async () => {
    const agg = createRtsAggregator();
    await agg.invokeForTest('build', {
      workerId: 37,
      building: 'supplyDepot',
      cellX: 93,
      cellY: 22,
    });
    await agg.invokeForTest('gather', { unitIds: [38, 39], nodeId: 15 });
    await agg.invokeForTest('produce', { buildingId: 11, unit: 'worker' });
    await agg.invokeForTest('attackMove', {
      unitIds: [50, 51, 52, 53],
      target: { x: 400, y: 1500 },
    });

    expect(agg.snapshot()).toEqual<AICommand[]>([
      {
        type: 'build',
        workerId: 37,
        building: 'supplyDepot',
        cellX: 93,
        cellY: 22,
      },
      { type: 'gather', unitIds: [38, 39], nodeId: 15 },
      { type: 'produce', buildingId: 11, unit: 'worker' },
      {
        type: 'attackMove',
        unitIds: [50, 51, 52, 53],
        target: { x: 400, y: 1500 },
      },
    ]);
  });

  it('drain returns the buffer and clears it; snapshot then sees empty', async () => {
    const agg = createRtsAggregator();
    await agg.invokeForTest('cancel', { entityId: 1 });
    await agg.invokeForTest('cancel', { entityId: 2 });

    const drained = agg.drain();
    expect(drained).toHaveLength(2);
    expect(agg.snapshot()).toEqual([]);

    // A second drain on an empty buffer returns []
    expect(agg.drain()).toEqual([]);
  });

  it('multiple aggregators are independent (no module-level shared state)', async () => {
    const a = createRtsAggregator();
    const b = createRtsAggregator();
    await a.invokeForTest('cancel', { entityId: 1 });
    expect(a.snapshot()).toHaveLength(1);
    expect(b.snapshot()).toEqual([]);
  });
});

describe('formatRtsResult', () => {
  it('serialises an empty list as "[]"', () => {
    expect(formatRtsResult([])).toBe('[]');
  });

  it('serialises commands as a JSON array round-trippable through JSON.parse', () => {
    const commands: AICommand[] = [
      {
        type: 'build',
        workerId: 37,
        building: 'supplyDepot',
        cellX: 93,
        cellY: 22,
      },
      { type: 'gather', unitIds: [38, 39], nodeId: 15 },
      { type: 'cancel', entityId: 5 },
    ];
    const out = formatRtsResult(commands);
    expect(JSON.parse(out)).toEqual(commands);
  });
});
