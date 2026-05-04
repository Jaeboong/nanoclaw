import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelOpts } from './registry.js';

type FactoryState = {
  env: Record<string, string>;
  registrations: Map<string, (opts: ChannelOpts) => unknown>;
};

const state = vi.hoisted<FactoryState>(() => ({
  env: {},
  registrations: new Map(),
}));

const runtimeControlFeature = {
  name: 'runtime-control',
  slashCommands: () => [],
};

const jiraFeature = {
  name: 'jira',
  slashCommands: () => [],
};

const grafanaFeature = {
  name: 'grafana-summary',
  slashCommands: () => [],
};

vi.mock('./registry.js', () => ({
  registerChannel: (name: string, factory: (opts: ChannelOpts) => unknown) => {
    state.registrations.set(name, factory);
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => state.env),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('./discord-features/runtime-control.js', () => ({
  runtimeControlFeature,
}));

vi.mock('./discord-features/jira.js', () => ({
  createJiraFeature: vi.fn(() => jiraFeature),
}));

vi.mock('./discord-features/grafana-summary.js', () => ({
  createGrafanaSummaryFeature: vi.fn(() => grafanaFeature),
}));

function createOpts(): ChannelOpts {
  return {
    onChatMetadata: vi.fn(),
    onMessage: vi.fn(),
    registeredGroups: () => ({}),
  };
}

describe('discord channel factories', () => {
  beforeEach(() => {
    state.env = {};
    state.registrations.clear();
    vi.resetModules();
  });

  it('builds the main discord channel without grafana feature', async () => {
    state.env = {
      DISCORD_BOT_TOKEN: 'main-token',
      DISCORD_JIRA_PANEL_CHANNEL_ID: '1495328144578707506',
      WEBHOOK_GRAFANA_JID: 'dc:1500673538129002606',
    };

    const discordModule = await import('./discord.js');
    const factory = state.registrations.get('discord');

    expect(factory).toBeTypeOf('function');

    const channel = factory?.(createOpts());

    expect(channel).toBeInstanceOf(discordModule.DiscordChannel);

    const discordChannel = channel as InstanceType<
      typeof discordModule.DiscordChannel
    >;
    expect(discordChannel.getFeature('runtime-control')).toBe(
      runtimeControlFeature,
    );
    expect(discordChannel.getFeature('jira')).toBe(jiraFeature);
    expect(discordChannel.getFeature('grafana-summary')).toBeUndefined();
  });

  it('builds the monitoring discord channel only when token and grafana JID exist', async () => {
    state.env = {
      DISCORD_BOT_TOKEN_MONITORING: 'monitoring-token',
      WEBHOOK_GRAFANA_JID: 'dc:1500673538129002606',
    };

    const discordModule = await import('./discord.js');
    await import('./discord-monitoring.js');
    const factory = state.registrations.get('discord-monitoring');

    expect(factory).toBeTypeOf('function');

    const channel = factory?.(createOpts());

    expect(channel).toBeInstanceOf(discordModule.DiscordChannel);

    const discordChannel = channel as InstanceType<
      typeof discordModule.DiscordChannel
    >;
    expect(discordChannel.getFeature('runtime-control')).toBe(
      runtimeControlFeature,
    );
    expect(discordChannel.getFeature('grafana-summary')).toBe(grafanaFeature);
    expect(discordChannel.getFeature('jira')).toBeUndefined();
    expect(discordChannel.ownsJid('dc:1500673538129002606')).toBe(true);
    expect(discordChannel.ownsJid('dc:1495097903985725672')).toBe(false);
  });

  it('skips the monitoring channel when monitoring env is incomplete', async () => {
    state.env = {
      DISCORD_BOT_TOKEN_MONITORING: 'monitoring-token',
    };

    await import('./discord-monitoring.js');
    const factory = state.registrations.get('discord-monitoring');

    expect(factory).toBeTypeOf('function');
    expect(factory?.(createOpts())).toBeNull();
  });
});
