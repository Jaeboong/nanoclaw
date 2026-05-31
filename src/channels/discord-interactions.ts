/**
 * Discord slash-command + message-component (button/select) framework.
 *
 * v1 used a discord.js `Client` and a `DiscordFeature` plugin interface to
 * register slash commands and dispatch interactions. v2 has no discord.js on
 * the host — `@chat-adapter/discord` owns the gateway — so this module
 * reimplements the framework against the raw interaction JSON the bridge
 * receives over the gateway-forward path (`GATEWAY_INTERACTION_CREATE`).
 *
 * Why not the adapter's own slash path: in gateway-forward mode the adapter's
 * `handleForwardedGatewayEvent` switch only covers MESSAGE_CREATE / REACTION,
 * not INTERACTION_CREATE. So application-command (type 2) and non-`ncq:`
 * component (type 3) interactions are unhandled by both the adapter and the
 * bridge's `ncq:` special case — this module fills that gap. The bridge calls
 * `handleInteraction` via the optional `onDiscordInteraction` config hook.
 *
 * Ack invariant: Discord fails any interaction without a response within ~3s
 * ("interaction failed"). Fast handlers respond directly (type 4 / type 7);
 * commands declared `deferred` ack immediately (type 5) and PATCH the
 * follow-up; every component path acks at least with a deferred update (type
 * 6). See `handleInteraction`.
 *
 * Auth: a command marked `requireAdmin` is gated by `isAdmin` (command-gate)
 * using the canonical `discord:<snowflake>` user id — the SAME form
 * `extractAndUpsertUser` produces for typed commands — so slash-auth and
 * typed-command-auth agree by construction.
 */
import { isAdmin } from '../command-gate.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { log } from '../log.js';

const DISCORD_API = 'https://discord.com/api/v10';

// Discord interaction types (request).
export const INTERACTION_APPLICATION_COMMAND = 2;
export const INTERACTION_MESSAGE_COMPONENT = 3;

// Discord interaction callback types (response).
const RT_CHANNEL_MESSAGE = 4; // CHANNEL_MESSAGE_WITH_SOURCE
const RT_DEFERRED_CHANNEL_MESSAGE = 5; // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
const RT_DEFERRED_UPDATE = 6; // DEFERRED_UPDATE_MESSAGE (component ack, no visible change)
const RT_UPDATE_MESSAGE = 7; // UPDATE_MESSAGE
const EPHEMERAL_FLAG = 64; // MessageFlags.Ephemeral

// Discord application-command option types we use (STRING only for now).
export const OPTION_STRING = 3;

export interface SlashOptionChoice {
  readonly name: string;
  readonly value: string;
}

export interface SlashOption {
  readonly type: number; // OPTION_STRING etc.
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  /**
   * Static choices. The adapter drops Autocomplete (type 4) interactions in
   * gateway mode, so dynamic autocomplete is not available — commands that
   * need a fixed menu (e.g. /model, /effort) ship static choices instead.
   */
  readonly choices?: readonly SlashOptionChoice[];
}

export interface SlashCommandDef {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly SlashOption[];
  /** Gate with owner/admin (user_roles) before running the handler. */
  readonly requireAdmin?: boolean;
  /**
   * Ack with a deferred response (type 5) before running the handler, then
   * PATCH the follow-up. Use for handlers that may exceed ~2s; instant
   * handlers (a DB write) leave this false and reply directly.
   */
  readonly deferred?: boolean;
}

export interface SlashInvocation {
  readonly commandName: string;
  readonly options: Readonly<Record<string, string>>;
  /** Canonical `discord:<snowflake>` — matches user_roles / extractAndUpsertUser. */
  readonly userId: string;
  readonly channelId: string;
  readonly guildId: string | null;
  /** `discord:<guild>:<channel>` (guild) or `discord:@me:<channel>` (DM). */
  readonly platformId: string;
}

export interface SlashResult {
  readonly text: string;
  /** Default true — slash replies are ephemeral unless explicitly public. */
  readonly ephemeral?: boolean;
}

export type SlashHandler = (inv: SlashInvocation) => Promise<SlashResult>;

export interface ComponentInvocation {
  readonly customId: string;
  readonly values: readonly string[];
  readonly userId: string;
  readonly channelId: string;
  readonly guildId: string | null;
  readonly platformId: string;
  readonly messageId: string;
}

export interface ComponentResult {
  /** Edit the message the component lives on (e.g. refresh a panel). */
  readonly update?: { readonly text?: string; readonly clearComponents?: boolean };
  /** Post an ephemeral follow-up message visible only to the clicker. */
  readonly message?: { readonly text: string };
}

export type ComponentHandler = (inv: ComponentInvocation) => Promise<ComponentResult>;

// ── Registry ────────────────────────────────────────────────────────────

interface RegisteredSlash {
  readonly def: SlashCommandDef;
  readonly handler: SlashHandler;
}

const slashCommands = new Map<string, RegisteredSlash>();
const componentHandlers: Array<{ readonly prefix: string; readonly handler: ComponentHandler }> = [];

/** Register a slash command + handler. Feature modules call this at import. */
export function registerSlashCommand(def: SlashCommandDef, handler: SlashHandler): void {
  slashCommands.set(def.name, { def, handler });
}

/** Register a component handler matched by `custom_id` prefix (longest first). */
export function registerComponentHandler(prefix: string, handler: ComponentHandler): void {
  componentHandlers.push({ prefix, handler });
}

/** Definitions for REST registration with Discord. */
export function listSlashCommandDefs(): readonly SlashCommandDef[] {
  return [...slashCommands.values()].map((c) => c.def);
}

function findComponentHandler(customId: string): ComponentHandler | undefined {
  // Longest matching prefix wins so a generic prefix can't shadow a specific one.
  let best: { prefix: string; handler: ComponentHandler } | undefined;
  for (const entry of componentHandlers) {
    if (customId.startsWith(entry.prefix) && (!best || entry.prefix.length > best.prefix.length)) {
      best = entry;
    }
  }
  return best?.handler;
}

/** Test-only: clear the registry between cases. */
export function _resetRegistry(): void {
  slashCommands.clear();
  componentHandlers.length = 0;
}

// ── Raw interaction shape ───────────────────────────────────────────────

export interface RawDiscordInteraction {
  readonly id: string;
  readonly application_id: string;
  readonly token: string;
  readonly type: number;
  readonly channel_id?: string;
  readonly guild_id?: string;
  readonly member?: { readonly user?: { readonly id: string } };
  readonly user?: { readonly id: string };
  readonly message?: { readonly id: string };
  readonly data?: {
    readonly name?: string;
    readonly options?: ReadonlyArray<{ readonly name: string; readonly value: unknown }>;
    readonly custom_id?: string;
    readonly values?: readonly string[];
  };
}

/**
 * Router registered into the bridge via `setForwardedInteractionRouter`.
 * Returns true when it handled the interaction; false to let the bridge fall
 * through (the built-in `ncq:` ask_question card flow stays in the bridge).
 */
export async function routeForwardedInteraction(interaction: Record<string, unknown>): Promise<boolean> {
  const type = interaction.type;
  if (type !== INTERACTION_APPLICATION_COMMAND && type !== INTERACTION_MESSAGE_COMPONENT) return false;
  if (type === INTERACTION_MESSAGE_COMPONENT) {
    const customId = (interaction.data as Record<string, unknown> | undefined)?.custom_id;
    if (typeof customId === 'string' && customId.startsWith('ncq:')) return false;
  }
  await handleInteraction(interaction as unknown as RawDiscordInteraction);
  return true;
}

/** Injectable seams for testing. */
export interface InteractionDeps {
  readonly fetchImpl?: typeof fetch;
  readonly isAdminImpl?: (userId: string, agentGroupId: string | null) => boolean;
  readonly resolveAgentGroupId?: (platformId: string) => string | null;
}

function defaultResolveAgentGroupId(platformId: string): string | null {
  const mg = getMessagingGroupByPlatform('discord', platformId);
  if (!mg) return null;
  return getMessagingGroupAgents(mg.id)[0]?.agent_group_id ?? null;
}

function platformIdFor(guildId: string | null, channelId: string): string {
  return guildId ? `discord:${guildId}:${channelId}` : `discord:@me:${channelId}`;
}

// ── Discord REST callback helpers ─────────────────────────────────────────

async function postCallback(
  interaction: RawDiscordInteraction,
  fetchImpl: typeof fetch,
  payload: Record<string, unknown>,
): Promise<void> {
  await fetchImpl(`${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function patchOriginal(
  interaction: RawDiscordInteraction,
  fetchImpl: typeof fetch,
  data: Record<string, unknown>,
): Promise<void> {
  await fetchImpl(`${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

async function postFollowup(
  interaction: RawDiscordInteraction,
  fetchImpl: typeof fetch,
  data: Record<string, unknown>,
): Promise<void> {
  await fetchImpl(`${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// ── Dispatch ──────────────────────────────────────────────────────────────

/**
 * Handle one forwarded Discord interaction (type 2 application command or
 * type 3 message component). Always sends exactly one ack and, for deferred
 * paths, one follow-up. Never throws to the caller — a handler error becomes
 * an ephemeral error message so the interaction never shows "failed".
 */
export async function handleInteraction(interaction: RawDiscordInteraction, deps: InteractionDeps = {}): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const isAdminImpl = deps.isAdminImpl ?? isAdmin;
  const resolveAgentGroupId = deps.resolveAgentGroupId ?? defaultResolveAgentGroupId;

  const snowflake = interaction.member?.user?.id ?? interaction.user?.id ?? '';
  const userId = `discord:${snowflake}`;
  const channelId = interaction.channel_id ?? '';
  const guildId = interaction.guild_id ?? null;
  const platformId = platformIdFor(guildId, channelId);

  try {
    if (interaction.type === INTERACTION_APPLICATION_COMMAND) {
      await handleSlash(interaction, { userId, channelId, guildId, platformId }, { fetchImpl, isAdminImpl, resolveAgentGroupId });
      return;
    }
    if (interaction.type === INTERACTION_MESSAGE_COMPONENT) {
      await handleComponent(interaction, { userId, channelId, guildId, platformId }, { fetchImpl });
      return;
    }
  } catch (err) {
    log.error('discord-interactions: handler failed', { err, type: interaction.type });
  }
}

interface ResolvedContext {
  userId: string;
  channelId: string;
  guildId: string | null;
  platformId: string;
}

async function handleSlash(
  interaction: RawDiscordInteraction,
  ctx: ResolvedContext,
  deps: { fetchImpl: typeof fetch; isAdminImpl: NonNullable<InteractionDeps['isAdminImpl']>; resolveAgentGroupId: NonNullable<InteractionDeps['resolveAgentGroupId']> },
): Promise<void> {
  const name = interaction.data?.name ?? '';
  const cmd = slashCommands.get(name);
  if (!cmd) {
    await postCallback(interaction, deps.fetchImpl, {
      type: RT_CHANNEL_MESSAGE,
      data: { content: `알 수 없는 명령: /${name}`, flags: EPHEMERAL_FLAG },
    });
    return;
  }

  if (cmd.def.requireAdmin) {
    const agentGroupId = deps.resolveAgentGroupId(ctx.platformId);
    if (!deps.isAdminImpl(ctx.userId, agentGroupId)) {
      await postCallback(interaction, deps.fetchImpl, {
        type: RT_CHANNEL_MESSAGE,
        data: { content: `권한 거부: /${name} 은(는) 관리자 전용입니다.`, flags: EPHEMERAL_FLAG },
      });
      return;
    }
  }

  const options: Record<string, string> = {};
  for (const opt of interaction.data?.options ?? []) {
    options[opt.name] = String(opt.value);
  }
  const inv: SlashInvocation = {
    commandName: name,
    options,
    userId: ctx.userId,
    channelId: ctx.channelId,
    guildId: ctx.guildId,
    platformId: ctx.platformId,
  };

  if (cmd.def.deferred) {
    // Ack within 3s, then run the (possibly slow) handler and PATCH the result.
    await postCallback(interaction, deps.fetchImpl, {
      type: RT_DEFERRED_CHANNEL_MESSAGE,
      data: { flags: EPHEMERAL_FLAG },
    });
    let text: string;
    try {
      text = (await cmd.handler(inv)).text;
    } catch (err) {
      log.error('discord-interactions: deferred slash handler error', { err, name });
      text = '명령 실행 실패. 서버 로그를 확인해주세요.';
    }
    await patchOriginal(interaction, deps.fetchImpl, { content: text });
    return;
  }

  let result: SlashResult;
  try {
    result = await cmd.handler(inv);
  } catch (err) {
    log.error('discord-interactions: slash handler error', { err, name });
    result = { text: '명령 실행 실패. 서버 로그를 확인해주세요.', ephemeral: true };
  }
  await postCallback(interaction, deps.fetchImpl, {
    type: RT_CHANNEL_MESSAGE,
    data: { content: result.text, flags: result.ephemeral === false ? 0 : EPHEMERAL_FLAG },
  });
}

async function handleComponent(
  interaction: RawDiscordInteraction,
  ctx: ResolvedContext,
  deps: { fetchImpl: typeof fetch },
): Promise<void> {
  const customId = interaction.data?.custom_id ?? '';
  const handler = findComponentHandler(customId);
  if (!handler) {
    // No handler — ack with a no-op deferred update so Discord doesn't show
    // "interaction failed". (Unknown / stale buttons land here.)
    await postCallback(interaction, deps.fetchImpl, { type: RT_DEFERRED_UPDATE });
    return;
  }

  const inv: ComponentInvocation = {
    customId,
    values: interaction.data?.values ?? [],
    userId: ctx.userId,
    channelId: ctx.channelId,
    guildId: ctx.guildId,
    platformId: ctx.platformId,
    messageId: interaction.message?.id ?? '',
  };

  // Ack immediately (deferred update — the panel may take a moment to rebuild),
  // then apply the result via PATCH (message edit) and/or an ephemeral followup.
  await postCallback(interaction, deps.fetchImpl, { type: RT_DEFERRED_UPDATE });
  let result: ComponentResult;
  try {
    result = await handler(inv);
  } catch (err) {
    log.error('discord-interactions: component handler error', { err, customId });
    await postFollowup(interaction, deps.fetchImpl, {
      content: '작업 실패. 서버 로그를 확인해주세요.',
      flags: EPHEMERAL_FLAG,
    });
    return;
  }

  if (result.update) {
    const data: Record<string, unknown> = {};
    if (result.update.text !== undefined) data.content = result.update.text;
    if (result.update.clearComponents) data.components = [];
    await patchOriginal(interaction, deps.fetchImpl, data);
  }
  if (result.message) {
    await postFollowup(interaction, deps.fetchImpl, {
      content: result.message.text,
      flags: EPHEMERAL_FLAG,
    });
  }
}

// ── REST registration ─────────────────────────────────────────────────────

function toDiscordCommandJson(def: SlashCommandDef): Record<string, unknown> {
  return {
    type: 1, // CHAT_INPUT
    name: def.name,
    description: def.description,
    options: (def.options ?? []).map((o) => ({
      type: o.type,
      name: o.name,
      description: o.description,
      required: o.required ?? false,
      ...(o.choices ? { choices: o.choices.map((c) => ({ name: c.name, value: c.value })) } : {}),
    })),
  };
}

async function getBotGuildIds(botToken: string, fetchImpl: typeof fetch): Promise<string[]> {
  const res = await fetchImpl(`${DISCORD_API}/users/@me/guilds?limit=200`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!res.ok) {
    log.warn('discord-interactions: failed to list guilds for command registration', { status: res.status });
    return [];
  }
  const guilds = (await res.json()) as Array<{ id: string }>;
  return guilds.map((g) => g.id);
}

/**
 * Register all known slash commands with Discord, per-guild for instant
 * availability (global registration propagates up to ~1h). Best-effort: a
 * failure for one guild logs and continues. Safe to call with an empty
 * registry — it PUTs `[]`, clearing stale commands.
 *
 * Requires NO public ingress: this is plain REST with the bot token. The
 * interaction *delivery* relies on no Interactions Endpoint URL being set in
 * the Discord Developer Portal (else interactions route to HTTP, not the
 * gateway) — see the cutover checklist.
 */
export async function registerSlashCommandsWithDiscord(
  applicationId: string,
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!applicationId || !botToken) {
    log.warn('discord-interactions: missing applicationId/botToken — skipping command registration');
    return;
  }
  const body = JSON.stringify(listSlashCommandDefs().map(toDiscordCommandJson));
  const guildIds = await getBotGuildIds(botToken, fetchImpl);
  for (const guildId of guildIds) {
    try {
      const res = await fetchImpl(`${DISCORD_API}/applications/${applicationId}/guilds/${guildId}/commands`, {
        method: 'PUT',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        log.warn('discord-interactions: guild command registration failed', { guildId, status: res.status });
      }
    } catch (err) {
      log.warn('discord-interactions: guild command registration threw', { guildId, err });
    }
  }
  log.info('discord-interactions: slash commands registered', {
    commands: slashCommands.size,
    guilds: guildIds.length,
  });
}
