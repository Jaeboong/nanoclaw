import fs from 'fs';
import path from 'path';
import {
  ActionRowBuilder,
  ButtonInteraction,
  Client,
  Interaction,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { classifySide, parseSide } from '../work-ledger/classify.js';
import {
  createJiraIssue,
  fetchOpenJiraIssues,
  transitionIssue,
} from '../work-ledger/jira-fetcher.js';
import { nextId, NonJiraTodo, Side } from '../work-ledger/state.js';
import {
  buildJiraPanel,
  buildNonJiraPanel,
  buildSubtasksEphemeral,
  buildSuggestionsPanel,
} from '../work-ledger/renderer.js';
import { loadState, saveState } from '../work-ledger/state.js';

// Work ledger lives in #추후-수정 (folder discord_notes), not #메인.
const TARGET_CHANNEL_ID = '1498600648982265906';

// Module-level Discord client reference, set after the bot is ready.
// Used by the webhook server (which lives outside the channel module) to
// trigger pin refreshes without coupling the two modules tightly.
let _client: Client | null = null;
export function setDiscordClient(c: Client): void {
  _client = c;
}
export function getDiscordClient(): Client | null {
  return _client;
}

export interface InteractionResult {
  handled: boolean;
  ack?: string;
}

async function getTargetChannel(client: Client): Promise<TextChannel | null> {
  try {
    const ch = await client.channels.fetch(TARGET_CHANNEL_ID);
    if (ch && ch.isTextBased() && 'send' in ch) return ch as TextChannel;
  } catch (err) {
    logger.warn({ err }, 'failed to fetch #추후-수정 channel');
  }
  return null;
}

async function deletePrevious(
  channel: TextChannel,
  messageId: string | null,
): Promise<void> {
  if (!messageId) return;
  try {
    const old = await channel.messages.fetch(messageId);
    await old.delete();
  } catch {
    // already gone — fine
  }
}

/**
 * Best-effort: clean up the legacy notes-ui pinned message on first sync,
 * since we're taking over the channel.  Deletes the message and removes the
 * stale state file so it doesn't get re-created.
 */
async function cleanupLegacyNotesPanel(channel: TextChannel): Promise<void> {
  const statePath = path.join(GROUPS_DIR, 'discord_notes', '.notes-panel.json');
  if (!fs.existsSync(statePath)) return;
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as { lastPanelMessageId?: string };
    if (parsed.lastPanelMessageId) {
      await deletePrevious(channel, parsed.lastPanelMessageId);
    }
    fs.unlinkSync(statePath);
    logger.info(
      'Legacy notes panel removed; work-ledger now owns this channel',
    );
  } catch (err) {
    logger.warn({ err }, 'Legacy notes panel cleanup failed (non-fatal)');
  }
}

/**
 * Edit-in-place when possible — keep the message ID stable, just update embeds
 * and components. Only send+pin on first creation or if the previous message
 * was deleted by someone. This eliminates the "X pinned a message" spam in the
 * channel after the very first sync.
 */
async function upsertPanel(
  channel: TextChannel,
  embeds: ReturnType<typeof buildJiraPanel>['embeds'],
  components: ReturnType<typeof buildJiraPanel>['components'],
  prevId: string | null,
): Promise<string> {
  if (prevId) {
    try {
      const existing = await channel.messages.fetch(prevId);
      await existing.edit({ embeds, components });
      // If somehow it got unpinned (user action), re-pin silently.
      if (!existing.pinned) {
        try {
          await existing.pin();
        } catch {
          /* swallow */
        }
      }
      return prevId;
    } catch (err) {
      logger.warn(
        { err, prevId },
        'panel edit-in-place failed; falling back to send+pin',
      );
      // fall through to send-new path
    }
  }
  const sent = await channel.send({ embeds, components });
  try {
    await sent.pin();
  } catch (err) {
    logger.warn({ err, msgId: sent.id }, 'pin failed');
  }
  return sent.id;
}

/** Refresh all three pinned panels in #추후-수정 (Jira / Non-Jira / Suggestions). */
export async function refreshAllPanels(client: Client): Promise<boolean> {
  const channel = await getTargetChannel(client);
  if (!channel) return false;
  await cleanupLegacyNotesPanel(channel);
  const state = loadState();
  if (state.legacyCombinedPanelMessageId) {
    await deletePrevious(channel, state.legacyCombinedPanelMessageId);
    state.legacyCombinedPanelMessageId = null;
  }

  const fetchResult = await fetchOpenJiraIssues();
  if (fetchResult.ok) {
    state.jiraIssues = fetchResult.issues;
    state.lastJiraFetch = new Date().toISOString();
  }

  // 1. Jira ledger
  const jira = buildJiraPanel({
    jiraIssues: state.jiraIssues,
    lastJiraFetch: state.lastJiraFetch,
    jiraError: fetchResult.ok ? undefined : fetchResult.error,
  });
  state.jiraPanelMessageId = await upsertPanel(
    channel,
    jira.embeds,
    jira.components,
    state.jiraPanelMessageId,
  );

  // 2. Non-Jira ledger
  const nonJira = buildNonJiraPanel({ todos: state.nonJiraTodos });
  state.nonJiraPanelMessageId = await upsertPanel(
    channel,
    nonJira.embeds,
    nonJira.components,
    state.nonJiraPanelMessageId,
  );

  // 3. Suggestions
  const sugg = buildSuggestionsPanel(state.suggestions);
  state.suggestionsPanelMessageId = await upsertPanel(
    channel,
    sugg.embeds,
    sugg.components,
    state.suggestionsPanelMessageId,
  );

  saveState(state);
  return true;
}

/** Re-render only the suggestions pin (used after webhook adds new suggestions). */
export async function refreshSuggestionsPanel(
  client: Client,
): Promise<boolean> {
  const channel = await getTargetChannel(client);
  if (!channel) return false;
  const state = loadState();
  const { embeds, components } = buildSuggestionsPanel(state.suggestions);
  state.suggestionsPanelMessageId = await upsertPanel(
    channel,
    embeds,
    components,
    state.suggestionsPanelMessageId,
  );
  saveState(state);
  return true;
}

/** Re-render only the Non-Jira pin (used after CRUD ops on todos). */
export async function refreshNonJiraPanel(client: Client): Promise<boolean> {
  const channel = await getTargetChannel(client);
  if (!channel) return false;
  const state = loadState();
  const { embeds, components } = buildNonJiraPanel({
    todos: state.nonJiraTodos,
  });
  state.nonJiraPanelMessageId = await upsertPanel(
    channel,
    embeds,
    components,
    state.nonJiraPanelMessageId,
  );
  saveState(state);
  return true;
}

/**
 * Handle button clicks on the work panel.  All work:* customIds route here.
 * Phase 1 = stubs only.  Real CRUD + Jira promotion come in next phase.
 */
export async function handleWorkInteraction(
  i: Interaction,
): Promise<InteractionResult> {
  if (!i.isButton()) return { handled: false };
  const b = i as ButtonInteraction;
  if (!b.customId.startsWith('work:')) return { handled: false };

  const action = b.customId.slice('work:'.length).split(':')[0];

  switch (action) {
    case 'sync': {
      await b.deferReply({ flags: MessageFlags.Ephemeral });
      const ok = await refreshAllPanels(b.client);
      await b.editReply(
        ok ? '동기화 완료다냥' : '동기화 실패다냥 — 로그 좀 봐줘',
      );
      return { handled: true };
    }
    case 'expand-subtasks': {
      try {
        await b.deferReply({ flags: MessageFlags.Ephemeral });
        const state = loadState();
        const { pages } = buildSubtasksEphemeral(state.jiraIssues);
        await b.editReply({ embeds: pages[0].embeds });
        for (let p = 1; p < pages.length; p++) {
          await b.followUp({
            embeds: pages[p].embeds,
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (err) {
        logger.error({ err }, 'expand-subtasks failed');
        try {
          if (b.deferred) {
            await b.editReply('서브태스크 띄우다 막혔다냥 — 로그 봐줘');
          } else {
            await b.reply({
              content: '서브태스크 띄우다 막혔다냥 — 로그 봐줘',
              flags: MessageFlags.Ephemeral,
            });
          }
        } catch {
          /* already responded — give up */
        }
      }
      return { handled: true };
    }
    case 'add': {
      // Empty modal — auto-classify on submit.
      const modal = new ModalBuilder()
        .setCustomId('work:modal:add')
        .setTitle('Non-Jira 할 일 추가')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('text')
              .setLabel('할 일 내용')
              .setStyle(TextInputStyle.Paragraph)
              .setMaxLength(500)
              .setRequired(true),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('side')
              .setLabel('분류 (FE / BE) — 비우면 자동 추정')
              .setStyle(TextInputStyle.Short)
              .setMaxLength(8)
              .setRequired(false),
          ),
        );
      await b.showModal(modal);
      return { handled: true };
    }
    case 'edit': {
      const state = loadState();
      if (state.nonJiraTodos.length === 0) {
        await b.reply({
          content: '수정할 항목이 없다냥.',
          flags: MessageFlags.Ephemeral,
        });
        return { handled: true };
      }
      const select = new StringSelectMenuBuilder()
        .setCustomId('work:select:edit')
        .setPlaceholder('수정할 항목 골라줘')
        .addOptions(
          state.nonJiraTodos.slice(0, 25).map((t) => ({
            label: t.text.slice(0, 100),
            value: t.id,
            description: `${t.side.toUpperCase()} · ${t.id.slice(-5)}`,
          })),
        );
      await b.reply({
        content: '수정할 항목 하나 골라줘냥.',
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return { handled: true };
    }
    case 'delete': {
      const state = loadState();
      const total = state.nonJiraTodos.length;
      if (total === 0) {
        await b.reply({
          content: '삭제할 항목이 없다냥.',
          flags: MessageFlags.Ephemeral,
        });
        return { handled: true };
      }
      const select = new StringSelectMenuBuilder()
        .setCustomId('work:select:delete')
        .setPlaceholder('삭제할 항목 골라줘 (여러 개 가능)')
        .setMinValues(1)
        .setMaxValues(Math.min(total, 25))
        .addOptions(
          state.nonJiraTodos.slice(0, 25).map((t) => ({
            label: t.text.slice(0, 100),
            value: t.id,
            description: `${t.side.toUpperCase()} · ${t.id.slice(-5)}`,
          })),
        );
      await b.reply({
        content: `삭제할 항목 골라줘냥 — 여러 개 선택 가능, 전체 다 지우려면 ${total}개 다 체크하면 된다냥. (선택 즉시 삭제)`,
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return { handled: true };
    }
    case 'promote': {
      const state = loadState();
      const total = state.nonJiraTodos.length;
      if (total === 0) {
        await b.reply({
          content: 'Jira 로 옮길 항목이 없다냥.',
          flags: MessageFlags.Ephemeral,
        });
        return { handled: true };
      }
      const select = new StringSelectMenuBuilder()
        .setCustomId('work:select:promote')
        .setPlaceholder('Jira 로 옮길 항목 골라줘 (여러 개 가능)')
        .setMinValues(1)
        .setMaxValues(Math.min(total, 25))
        .addOptions(
          state.nonJiraTodos.slice(0, 25).map((t) => ({
            label: t.text.slice(0, 100),
            value: t.id,
            description: `${t.side.toUpperCase()} · Task 로 등록`,
          })),
        );
      await b.reply({
        content: `Jira 에 등재할 항목 골라줘냥 — 여러 개 선택 가능, 전부 옮기려면 ${total}개 다 체크. \`[FE]/[BE] 내용\` Task 로 생성되고 Non-Jira 에서 빠진다냥.`,
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return { handled: true };
    }
    case 'sugg-apply': {
      const suggId = b.customId.split(':')[2];
      await b.deferReply({ flags: MessageFlags.Ephemeral });
      const state = loadState();
      const sugg = state.suggestions.find((s) => s.id === suggId);
      if (!sugg) {
        await b.editReply('추천이 사라졌다냥 (이미 처리됐거나 삭제됨).');
        return { handled: true };
      }
      if (sugg.action.kind !== 'transition') {
        await b.editReply(
          '이 추천은 transition 타입이 아니다냥. 수정으로 풀어라.',
        );
        return { handled: true };
      }
      if (!sugg.candidateIssueKey) {
        await b.editReply(
          '매칭된 Jira 키가 없다냥. 수정 버튼으로 키 박은 다음 적용해줘.',
        );
        return { handled: true };
      }
      const result = await transitionIssue(
        sugg.candidateIssueKey,
        sugg.action.status,
      );
      if (!result.ok) {
        await b.editReply(`적용 실패다냥 — \`${result.error}\``);
        return { handled: true };
      }
      // Remove suggestion + refresh both pins
      const fresh = loadState();
      fresh.suggestions = fresh.suggestions.filter((s) => s.id !== suggId);
      saveState(fresh);
      await refreshSuggestionsPanel(b.client);
      refreshAllPanels(b.client).catch((err) =>
        logger.warn({ err }, 'post-apply Jira refresh failed'),
      );
      await b.editReply(
        `적용 완료다냥 — \`${sugg.candidateIssueKey}\` → **${result.appliedStatus ?? sugg.action.status}**`,
      );
      return { handled: true };
    }
    case 'sugg-edit': {
      const suggId = b.customId.split(':')[2];
      const state = loadState();
      const sugg = state.suggestions.find((s) => s.id === suggId);
      if (!sugg) {
        await b.reply({
          content: '추천이 사라졌다냥.',
          flags: MessageFlags.Ephemeral,
        });
        return { handled: true };
      }
      const targetStatus =
        sugg.action.kind === 'transition' ? sugg.action.status : 'In Progress';
      const modal = new ModalBuilder()
        .setCustomId(`work:modal:sugg-edit:${suggId}`)
        .setTitle('추천 수정')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('issueKey')
              .setLabel('Jira 이슈 키 (예: S14P31D107-431)')
              .setStyle(TextInputStyle.Short)
              .setMaxLength(40)
              .setValue(sugg.candidateIssueKey ?? '')
              .setRequired(true),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('targetStatus')
              .setLabel('이동할 상태 (예: Done, In Progress)')
              .setStyle(TextInputStyle.Short)
              .setMaxLength(40)
              .setValue(targetStatus)
              .setRequired(true),
          ),
        );
      await b.showModal(modal);
      return { handled: true };
    }
    case 'sugg-delete': {
      const suggId = b.customId.split(':')[2];
      const state = loadState();
      const before = state.suggestions.length;
      state.suggestions = state.suggestions.filter((s) => s.id !== suggId);
      saveState(state);
      await refreshSuggestionsPanel(b.client);
      await b.reply({
        content:
          before === state.suggestions.length
            ? '이미 사라진 추천이다냥.'
            : '추천 삭제했다냥.',
        flags: MessageFlags.Ephemeral,
      });
      return { handled: true };
    }
    default:
      return { handled: false };
  }
}

export async function handleWorkSelect(
  i: Interaction,
): Promise<InteractionResult> {
  if (!i.isStringSelectMenu()) return { handled: false };
  const s = i as StringSelectMenuInteraction;
  if (!s.customId.startsWith('work:select:')) return { handled: false };

  const sub = s.customId.slice('work:select:'.length);
  const ids = s.values;
  const state = loadState();

  // Edit is single-select only (modal needs one item context)
  if (sub === 'edit') {
    const todo = state.nonJiraTodos.find((t) => t.id === ids[0]);
    if (!todo) {
      await s.update({
        content: '항목이 사라졌다냥 (이미 삭제된 듯).',
        components: [],
      });
      return { handled: true };
    }
    const modal = new ModalBuilder()
      .setCustomId(`work:modal:edit:${todo.id}`)
      .setTitle('Non-Jira 할 일 수정')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('text')
            .setLabel('할 일 내용')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(500)
            .setValue(todo.text)
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('side')
            .setLabel('분류 (FE / BE)')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(8)
            .setValue(todo.side.toUpperCase())
            .setRequired(true),
        ),
      );
    await s.showModal(modal);
    return { handled: true };
  }

  if (sub === 'delete') {
    const targets = state.nonJiraTodos.filter((t) => ids.includes(t.id));
    if (targets.length === 0) {
      await s.update({
        content: '항목이 사라졌다냥 (이미 삭제된 듯).',
        components: [],
      });
      return { handled: true };
    }
    state.nonJiraTodos = state.nonJiraTodos.filter((t) => !ids.includes(t.id));
    saveState(state);
    await refreshNonJiraPanel(s.client);
    const summary =
      targets.length === 1
        ? `\`${targets[0].text.slice(0, 60)}\``
        : `${targets.length}건 (` +
          targets
            .slice(0, 3)
            .map((t) => `\`${t.text.slice(0, 30)}\``)
            .join(', ') +
          (targets.length > 3 ? ', …' : '') +
          ')';
    await s.update({
      content: `삭제 완료다냥 — ${summary}`,
      components: [],
    });
    return { handled: true };
  }

  if (sub === 'promote') {
    await s.deferUpdate();
    const targets = state.nonJiraTodos.filter((t) => ids.includes(t.id));
    if (targets.length === 0) {
      await s.editReply({
        content: '항목이 사라졌다냥 (이미 처리된 듯).',
        components: [],
      });
      return { handled: true };
    }
    const created: Array<{ key: string; url: string; summary: string }> = [];
    const failed: Array<{ summary: string; error: string }> = [];
    const okIds: string[] = [];
    for (const todo of targets) {
      const summary = `[${todo.side.toUpperCase()}] ${todo.text}`;
      const result = await createJiraIssue(summary, 'Task');
      if (result.ok) {
        created.push({
          key: result.key ?? '?',
          url: result.url ?? '',
          summary,
        });
        okIds.push(todo.id);
      } else {
        failed.push({ summary, error: result.error ?? 'unknown' });
      }
    }
    state.nonJiraTodos = state.nonJiraTodos.filter(
      (t) => !okIds.includes(t.id),
    );
    saveState(state);
    await refreshNonJiraPanel(s.client);
    refreshAllPanels(s.client).catch((err) =>
      logger.warn({ err }, 'post-promote refresh failed'),
    );

    const lines: string[] = [];
    if (created.length > 0) {
      lines.push(`Jira 생성 ${created.length}건 완료다냥:`);
      for (const c of created) {
        lines.push(`• [${c.key}](${c.url}) "${c.summary.slice(0, 80)}"`);
      }
    }
    if (failed.length > 0) {
      lines.push('');
      lines.push(`실패 ${failed.length}건:`);
      for (const f of failed) {
        lines.push(
          `• "${f.summary.slice(0, 60)}" — \`${f.error.slice(0, 100)}\``,
        );
      }
    }
    await s.editReply({
      content: lines.join('\n').slice(0, 1900) || 'Jira 호출 결과 비어있다냥.',
      components: [],
    });
    return { handled: true };
  }

  return { handled: false };
}

export async function handleWorkModal(
  i: Interaction,
): Promise<InteractionResult> {
  if (!i.isModalSubmit()) return { handled: false };
  const m = i as ModalSubmitInteraction;
  if (!m.customId.startsWith('work:modal:')) return { handled: false };

  const sub = m.customId.slice('work:modal:'.length);
  const state = loadState();

  if (sub === 'add') {
    const text = m.fields.getTextInputValue('text').trim();
    const sideRaw = m.fields.getTextInputValue('side').trim();
    const inferred: Side = classifySide(text);
    const side = sideRaw ? parseSide(sideRaw, inferred) : inferred;
    const todo: NonJiraTodo = {
      id: nextId('todo'),
      text,
      side,
      createdAt: new Date().toISOString(),
    };
    state.nonJiraTodos.push(todo);
    saveState(state);
    await refreshNonJiraPanel(m.client);
    await m.reply({
      content: `추가했다냥 — \`${side.toUpperCase()}\` "${text.slice(0, 80)}"${
        sideRaw ? '' : ' (분류는 내가 추정함)'
      }`,
      flags: MessageFlags.Ephemeral,
    });
    return { handled: true };
  }

  if (sub.startsWith('edit:')) {
    const todoId = sub.slice('edit:'.length);
    const todo = state.nonJiraTodos.find((t) => t.id === todoId);
    if (!todo) {
      await m.reply({
        content: '항목이 사라졌다냥.',
        flags: MessageFlags.Ephemeral,
      });
      return { handled: true };
    }
    const text = m.fields.getTextInputValue('text').trim();
    const sideRaw = m.fields.getTextInputValue('side').trim();
    todo.text = text;
    todo.side = parseSide(sideRaw, todo.side);
    saveState(state);
    await refreshNonJiraPanel(m.client);
    await m.reply({
      content: `수정 완료다냥 — \`${todo.side.toUpperCase()}\` "${text.slice(0, 80)}"`,
      flags: MessageFlags.Ephemeral,
    });
    return { handled: true };
  }

  if (sub.startsWith('sugg-edit:')) {
    const suggId = sub.slice('sugg-edit:'.length);
    const sugg = state.suggestions.find((s) => s.id === suggId);
    if (!sugg) {
      await m.reply({
        content: '추천이 사라졌다냥.',
        flags: MessageFlags.Ephemeral,
      });
      return { handled: true };
    }
    const issueKey = m.fields.getTextInputValue('issueKey').trim();
    const targetStatus = m.fields.getTextInputValue('targetStatus').trim();
    sugg.candidateIssueKey = issueKey || undefined;
    sugg.action = { kind: 'transition', status: targetStatus || 'In Progress' };
    sugg.confidence = 1; // user confirmed
    sugg.reasoning = `${sugg.reasoning}\n  _(사용자 수정: ${issueKey} → ${targetStatus})_`;
    saveState(state);
    await refreshSuggestionsPanel(m.client);
    await m.reply({
      content: `추천 수정 완료다냥 — \`${issueKey}\` → **${targetStatus}**. 적용 버튼 누르면 반영된다냥.`,
      flags: MessageFlags.Ephemeral,
    });
    return { handled: true };
  }

  return { handled: false };
}
