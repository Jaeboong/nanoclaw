import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _resetRegistry,
  handleInteraction,
  listSlashCommandDefs,
  OPTION_STRING,
  registerComponentHandler,
  registerSlashCommand,
  registerSlashCommandsWithDiscord,
  type ComponentInvocation,
  type RawDiscordInteraction,
  type SlashInvocation,
} from './discord-interactions.js';

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function recordingFetch(): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
    });
    return {
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function slashInteraction(over: Partial<RawDiscordInteraction> = {}): RawDiscordInteraction {
  return {
    id: 'int-1',
    application_id: 'app-1',
    token: 'tok-1',
    type: 2,
    channel_id: 'chan-1',
    guild_id: 'guild-1',
    member: { user: { id: '99887766' } },
    data: { name: 'demo', options: [] },
    ...over,
  };
}

function componentInteraction(over: Partial<RawDiscordInteraction> = {}): RawDiscordInteraction {
  return {
    id: 'int-2',
    application_id: 'app-1',
    token: 'tok-2',
    type: 3,
    channel_id: 'chan-1',
    guild_id: 'guild-1',
    member: { user: { id: '99887766' } },
    message: { id: 'msg-1' },
    data: { custom_id: 'work:refresh', values: [] },
    ...over,
  };
}

afterEach(() => {
  _resetRegistry();
  vi.restoreAllMocks();
});

describe('slash registry', () => {
  it('lists registered command definitions', () => {
    registerSlashCommand({ name: 'demo', description: 'd' }, async () => ({ text: 'ok' }));
    expect(listSlashCommandDefs().map((d) => d.name)).toEqual(['demo']);
  });
});

describe('handleInteraction — slash (type 2)', () => {
  it('routes to the handler and replies ephemerally via type-4 callback', async () => {
    let received: SlashInvocation | undefined;
    registerSlashCommand({ name: 'demo', description: 'd' }, async (inv) => {
      received = inv;
      return { text: 'done' };
    });
    const { fetchImpl, calls } = recordingFetch();

    await handleInteraction(slashInteraction(), { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/interactions/int-1/tok-1/callback');
    expect(calls[0].body).toMatchObject({
      type: 4,
      data: { content: 'done', flags: 64 },
    });
    // Canonical user id form must match user_roles / extractAndUpsertUser.
    expect(received?.userId).toBe('discord:99887766');
    expect(received?.platformId).toBe('discord:guild-1:chan-1');
  });

  it('passes option values through to the handler', async () => {
    let received: SlashInvocation | undefined;
    registerSlashCommand(
      { name: 'model', description: 'm', options: [{ type: OPTION_STRING, name: 'choice', description: 'c' }] },
      async (inv) => {
        received = inv;
        return { text: 'ok' };
      },
    );
    const { fetchImpl } = recordingFetch();

    await handleInteraction(
      slashInteraction({ data: { name: 'model', options: [{ name: 'choice', value: 'opus' }] } }),
      { fetchImpl },
    );

    expect(received?.options).toEqual({ choice: 'opus' });
  });

  it('derives discord:<snowflake> from interaction.user in a DM (no member/guild)', async () => {
    let received: SlashInvocation | undefined;
    registerSlashCommand({ name: 'demo', description: 'd' }, async (inv) => {
      received = inv;
      return { text: 'ok' };
    });
    const { fetchImpl } = recordingFetch();

    await handleInteraction(
      slashInteraction({ member: undefined, guild_id: undefined, user: { id: '123' } }),
      { fetchImpl },
    );

    expect(received?.userId).toBe('discord:123');
    expect(received?.guildId).toBeNull();
    expect(received?.platformId).toBe('discord:@me:chan-1');
  });

  it('replies with an ephemeral error for an unknown command', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await handleInteraction(slashInteraction({ data: { name: 'nope' } }), { fetchImpl });
    expect(calls[0].body).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(String((calls[0].body?.data as Record<string, unknown>).content)).toContain('/nope');
  });

  it('denies a requireAdmin command for a non-admin without running the handler', async () => {
    const handler = vi.fn(async () => ({ text: 'secret' }));
    registerSlashCommand({ name: 'compact', description: 'c', requireAdmin: true }, handler);
    const { fetchImpl, calls } = recordingFetch();

    await handleInteraction(slashInteraction({ data: { name: 'compact' } }), {
      fetchImpl,
      isAdminImpl: () => false,
      resolveAgentGroupId: () => 'ag-1',
    });

    expect(handler).not.toHaveBeenCalled();
    expect(String((calls[0].body?.data as Record<string, unknown>).content)).toContain('권한 거부');
  });

  it('allows a requireAdmin command for an admin', async () => {
    const handler = vi.fn(async () => ({ text: 'ran' }));
    registerSlashCommand({ name: 'compact', description: 'c', requireAdmin: true }, handler);
    const { fetchImpl, calls } = recordingFetch();

    await handleInteraction(slashInteraction({ data: { name: 'compact' } }), {
      fetchImpl,
      isAdminImpl: () => true,
      resolveAgentGroupId: () => 'ag-1',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect((calls[0].body?.data as Record<string, unknown>).content).toBe('ran');
  });

  it('acks with type-5 then PATCHes @original for a deferred command', async () => {
    registerSlashCommand({ name: 'slow', description: 's', deferred: true }, async () => ({ text: 'eventual' }));
    const { fetchImpl, calls } = recordingFetch();

    await handleInteraction(slashInteraction({ data: { name: 'slow' } }), { fetchImpl });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/interactions/int-1/tok-1/callback');
    expect(calls[0].body).toMatchObject({ type: 5, data: { flags: 64 } });
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].url).toContain('/webhooks/app-1/tok-1/messages/@original');
    expect(calls[1].body).toMatchObject({ content: 'eventual' });
  });

  it('turns a handler throw into an ephemeral error (still acks)', async () => {
    registerSlashCommand({ name: 'boom', description: 'b' }, async () => {
      throw new Error('kaboom');
    });
    const { fetchImpl, calls } = recordingFetch();

    await handleInteraction(slashInteraction({ data: { name: 'boom' } }), { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(String((calls[0].body?.data as Record<string, unknown>).content)).toContain('실패');
  });
});

describe('handleInteraction — component (type 3)', () => {
  it('acks with type-6 then PATCHes the message and posts a followup', async () => {
    let received: ComponentInvocation | undefined;
    registerComponentHandler('work:', async (inv) => {
      received = inv;
      return { update: { text: 'refreshed', clearComponents: true }, message: { text: 'done' } };
    });
    const { fetchImpl, calls } = recordingFetch();

    await handleInteraction(componentInteraction(), { fetchImpl });

    expect(received?.customId).toBe('work:refresh');
    expect(received?.messageId).toBe('msg-1');
    expect(calls[0].body).toMatchObject({ type: 6 });
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].body).toMatchObject({ content: 'refreshed', components: [] });
    expect(calls[2].method).toBe('POST');
    expect(calls[2].url).toContain('/webhooks/app-1/tok-2');
    expect(calls[2].body).toMatchObject({ content: 'done', flags: 64 });
  });

  it('acks with a no-op type-6 when no handler matches', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await handleInteraction(componentInteraction({ data: { custom_id: 'unknown:x' } }), { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ type: 6 });
  });

  it('matches the longest custom_id prefix', async () => {
    const generic = vi.fn(async () => ({}));
    const specific = vi.fn(async () => ({}));
    registerComponentHandler('work:', generic);
    registerComponentHandler('work:ledger:', specific);
    const { fetchImpl } = recordingFetch();

    await handleInteraction(componentInteraction({ data: { custom_id: 'work:ledger:close' } }), { fetchImpl });

    expect(specific).toHaveBeenCalledTimes(1);
    expect(generic).not.toHaveBeenCalled();
  });
});

describe('registerSlashCommandsWithDiscord', () => {
  it('enumerates guilds then PUTs commands per guild', async () => {
    registerSlashCommand(
      {
        name: 'model',
        description: 'm',
        options: [
          {
            type: OPTION_STRING,
            name: 'choice',
            description: 'c',
            choices: [{ name: 'Opus', value: 'opus' }],
          },
        ],
      },
      async () => ({ text: 'ok' }),
    );

    const calls: RecordedCall[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({
        url: u,
        method: init?.method ?? 'GET',
        body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
      });
      if (u.includes('/users/@me/guilds')) {
        return { ok: true, status: 200, json: async () => [{ id: 'g1' }, { id: 'g2' }] } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;

    await registerSlashCommandsWithDiscord('app-1', 'bot-token', fetchImpl);

    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((p) => p.url)).toEqual([
      'https://discord.com/api/v10/applications/app-1/guilds/g1/commands',
      'https://discord.com/api/v10/applications/app-1/guilds/g2/commands',
    ]);
    const body = puts[0].body as unknown as Array<Record<string, unknown>>;
    expect(body[0]).toMatchObject({ type: 1, name: 'model' });
    const opt = (body[0].options as Array<Record<string, unknown>>)[0];
    expect(opt).toMatchObject({ type: 3, name: 'choice', choices: [{ name: 'Opus', value: 'opus' }] });
  });
});
