/**
 * UI builders + interaction handlers for the discord_notes (#추후-수정) channel.
 *
 * - buildPanel(): the always-on-bottom embed + buttons + select menu
 * - handleInteraction(): routes button/modal/select events to the notes store
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  type Interaction,
  type MessageActionRowComponentBuilder,
  type ModalActionRowComponentBuilder,
} from 'discord.js';

import { logger } from '../logger.js';
import * as notes from '../notes-store.js';
import * as opinions from '../opinions-store.js';

const DDONYANG_EMOJI = '<:ddonyang1:1498556584257917024>';

export interface NotesPanel {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

export function buildPanel(): NotesPanel {
  const filter = notes.getFilterCategory();
  const items = notes.list({ category: filter });
  const allItems = notes.list();

  const filterLabel = filter === 'all' ? '전체' : filter;
  const title = `📋 추후-수정 리스트 (${items.length}건${filter !== 'all' ? ` / ${filterLabel}` : ''})`;

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(title)
    .setTimestamp(new Date());

  if (items.length === 0) {
    embed.setDescription(
      filter === 'all'
        ? `아직 등록된 항목이 없다냥 ${DDONYANG_EMOJI}\n아래 **➕ 추가** 버튼으로 등록해라냥.`
        : `\`${filterLabel}\` 카테고리에 항목이 없다냥. 다른 카테고리를 골라봐라냥.`,
    );
  } else {
    embed.setDescription(
      `현재 필터: \`${filterLabel}\` · 총 **${items.length}건**`,
    );
    embed.addFields(buildPriorityFields(items));
  }

  const stats = notes.stats();
  const opinionCount = opinions.count();
  embed.setFooter({
    text: `전체 ${allItems.length}건 / 보관함 ${stats.archived}건 · 상 ${stats.byPriority.high} 중 ${stats.byPriority.mid} 낮 ${stats.byPriority.low} · 의견 ${opinionCount}건`,
  });

  const row1 =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('notes:add')
        .setLabel('추가')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('notes:complete')
        .setLabel('완료')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('notes:edit')
        .setLabel('수정')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('notes:delete')
        .setLabel('삭제')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger),
    );

  const row2 =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('notes:archive')
        .setLabel('보관함')
        .setEmoji('📦')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('notes:search')
        .setLabel('검색')
        .setEmoji('🔍')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('notes:stats')
        .setLabel('통계')
        .setEmoji('📊')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('notes:refresh')
        .setLabel('새로고침')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary),
    );

  const row3 =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('notes:opinion-add')
        .setLabel('의견 추가')
        .setEmoji('💬')
        .setStyle(ButtonStyle.Primary),
    );

  const select = new StringSelectMenuBuilder()
    .setCustomId('notes:filter')
    .setPlaceholder(`카테고리 필터 — 현재: ${filterLabel}`)
    .addOptions(
      { label: '전체', value: 'all', default: filter === 'all' },
      { label: '🚨 우선 (상)', value: 'urgent', default: filter === 'urgent' },
      ...notes
        .categories()
        .map((c) => ({ label: c, value: c, default: filter === c })),
    );
  const row4 =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      select,
    );

  return { embeds: [embed], components: [row1, row2, row3, row4] };
}

function buildPriorityFields(
  items: notes.FollowupItem[],
): Array<{ name: string; value: string; inline: boolean }> {
  const sections = [
    { key: 'high' as notes.Priority, emoji: '🔥', label: '상' },
    { key: 'mid' as notes.Priority, emoji: '⚡', label: '중' },
    { key: 'low' as notes.Priority, emoji: '💧', label: '낮' },
  ];

  const allOpinions = opinions.list();
  const opsByFid = new Map<number, opinions.OpinionItem[]>();
  for (const op of allOpinions) {
    if (op.linkedFollowupId !== undefined) {
      const arr = opsByFid.get(op.linkedFollowupId) ?? [];
      arr.push(op);
      opsByFid.set(op.linkedFollowupId, arr);
    }
  }

  const fields: Array<{ name: string; value: string; inline: boolean }> = [];

  for (const sec of sections) {
    const list = items.filter((it) => it.priority === sec.key);
    if (list.length === 0) continue;

    const lines: string[] = [];
    for (let idx = 0; idx < list.length; idx++) {
      if (idx > 0) lines.push('​');
      const it = list[idx];
      const id = `**#${String(it.id).padStart(3, '0')}**`;
      const cat = `\`${it.category}\``;
      const titleLines = it.title.split('\n');
      lines.push(`${id} ${cat} ${titleLines[0]}`);
      for (const extra of titleLines.slice(1)) {
        lines.push(`　　${extra}`);
      }
      const opsHere = opsByFid.get(it.id) ?? [];
      for (const op of opsHere) {
        const content =
          op.content.length > 140 ? op.content.slice(0, 137) + '…' : op.content;
        lines.push(`　　↳ 💬 **${op.authorName}**: ${content}`);
      }
    }

    const chunks = chunkLines(lines, 1000);
    chunks.forEach((chunk, idx) => {
      const suffix = chunks.length > 1 ? ` (${idx + 1}/${chunks.length})` : '';
      fields.push({
        name:
          chunks.length === 1
            ? `${sec.emoji} 우선순위 ${sec.label} · ${list.length}건`
            : `${sec.emoji} 우선순위 ${sec.label}${suffix}`,
        value: chunk,
        inline: false,
      });
    });
  }

  const freeOps = allOpinions.filter((op) => op.linkedFollowupId === undefined);
  if (freeOps.length > 0) {
    const lines: string[] = [];
    for (let idx = 0; idx < freeOps.length; idx++) {
      if (idx > 0) lines.push('​');
      const op = freeOps[idx];
      const content =
        op.content.length > 200 ? op.content.slice(0, 197) + '…' : op.content;
      lines.push(`💬 **${op.authorName}**: ${content}`);
    }
    const chunks = chunkLines(lines, 1000);
    chunks.forEach((chunk, idx) => {
      fields.push({
        name:
          chunks.length === 1
            ? `💭 자유 의견 · ${freeOps.length}건`
            : `💭 자유 의견 (${idx + 1}/${chunks.length})`,
        value: chunk,
        inline: false,
      });
    });
  }

  return fields;
}

const PRIORITY_OPTIONS: Array<{
  label: string;
  value: notes.Priority;
}> = [
  { label: '상', value: 'high' },
  { label: '중', value: 'mid' },
  { label: '하', value: 'low' },
];

function buildAddPickRows(
  cat: string,
  pri: notes.Priority,
): Array<ActionRowBuilder<MessageActionRowComponentBuilder>> {
  const cats = notes.categories();
  const catSelect = new StringSelectMenuBuilder()
    .setCustomId(`notes:add-cat:${pri}`)
    .setPlaceholder(`카테고리 — 현재: ${cat}`)
    .addOptions(
      cats.slice(0, 25).map((c) => ({
        label: c,
        value: c,
        default: c === cat,
      })),
    );
  const priSelect = new StringSelectMenuBuilder()
    .setCustomId(`notes:add-pri:${cat}`)
    .setPlaceholder(`우선순위 — 현재: ${notes.priorityLabel(pri)}`)
    .addOptions(
      PRIORITY_OPTIONS.map((p) => ({
        label: p.label,
        value: p.value,
        default: p.value === pri,
      })),
    );
  const confirm = new ButtonBuilder()
    .setCustomId(`notes:add-go:${cat}:${pri}`)
    .setLabel('내용 입력')
    .setEmoji('📝')
    .setStyle(ButtonStyle.Primary);

  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      catSelect,
    ),
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      priSelect,
    ),
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      confirm,
    ),
  ];
}

function buildEditPickRows(
  id: number,
  cat: string,
  pri: notes.Priority,
): Array<ActionRowBuilder<MessageActionRowComponentBuilder>> {
  const cats = notes.categories();
  const catSelect = new StringSelectMenuBuilder()
    .setCustomId(`notes:edit-cat:${id}:${pri}`)
    .setPlaceholder(`카테고리 — 현재: ${cat}`)
    .addOptions(
      cats.slice(0, 25).map((c) => ({
        label: c,
        value: c,
        default: c === cat,
      })),
    );
  const priSelect = new StringSelectMenuBuilder()
    .setCustomId(`notes:edit-pri:${id}:${cat}`)
    .setPlaceholder(`우선순위 — 현재: ${notes.priorityLabel(pri)}`)
    .addOptions(
      PRIORITY_OPTIONS.map((p) => ({
        label: p.label,
        value: p.value,
        default: p.value === pri,
      })),
    );
  const confirm = new ButtonBuilder()
    .setCustomId(`notes:edit-go:${id}:${cat}:${pri}`)
    .setLabel('내용 입력')
    .setEmoji('📝')
    .setStyle(ButtonStyle.Primary);

  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      catSelect,
    ),
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      priSelect,
    ),
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      confirm,
    ),
  ];
}

async function sendAddPickMenu(i: ButtonInteraction): Promise<void> {
  const cats = notes.categories();
  const defaultCat = cats.includes('etc') ? 'etc' : (cats[0] ?? 'etc');
  await i.reply({
    content: '카테고리·우선순위 고르고 다음 누르라냥',
    components: buildAddPickRows(defaultCat, 'low'),
    flags: 64,
  });
}

async function sendOpinionAddPickMenu(i: ButtonInteraction): Promise<void> {
  const followups = notes.list();
  const options: Array<{ label: string; value: string; description?: string }> =
    [];
  options.push({
    label: '💭 자유 의견 (특정 항목과 무관)',
    value: 'free',
  });
  for (const f of followups.slice(0, 24)) {
    const id = `#${String(f.id).padStart(3, '0')}`;
    const titleFirstLine = f.title.split('\n')[0];
    options.push({
      label: `${id} ${titleFirstLine}`.slice(0, 100),
      value: `f:${f.id}`,
      description:
        `[${f.category}] 우선순위: ${notes.priorityLabel(f.priority)}`.slice(
          0,
          100,
        ),
    });
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId('notes:opinion-pick')
    .setPlaceholder('어느 항목에 의견 달래냥?')
    .addOptions(options.slice(0, 25));
  const row =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      select,
    );
  const note =
    followups.length > 24
      ? `(${followups.length}건 중 상위 24건만 보인다냥)`
      : '';
  await i.reply({
    content: `의견 달 항목 골라라냥 ${note}`.trim(),
    components: [row],
    flags: 64,
  });
}

async function handleOpinionAddPick(
  i: StringSelectMenuInteraction,
): Promise<void> {
  const value = i.values[0];
  if (value === 'free') {
    await i.showModal(buildOpinionAddModal(undefined, '자유 의견'));
    return;
  }
  if (value.startsWith('f:')) {
    const fid = parseInt(value.slice(2), 10);
    const fol = notes.list().find((f) => f.id === fid);
    if (!fol) {
      await i.update({ content: '항목 못 찾았다냥', components: [] });
      return;
    }
    const idStr = `#${String(fid).padStart(3, '0')}`;
    const label = `${idStr} ${fol.title.split('\n')[0]}`.slice(0, 30);
    await i.showModal(buildOpinionAddModal(fid, label));
    return;
  }
  await i.update({ content: '알 수 없는 선택이다냥', components: [] });
}

function chunkLines(lines: string[], maxLen: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ln of lines) {
    const candidate = cur ? cur + '\n' + ln : ln;
    if (candidate.length > maxLen) {
      if (cur) out.push(cur);
      cur = ln;
    } else {
      cur = candidate;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Returns true if the interaction was a notes interaction (handled here).
 * Caller is responsible for refreshing the channel panel after this returns
 * (only for interactions that mutate state).
 */
export async function handleInteraction(
  interaction: Interaction,
): Promise<{ handled: boolean; mutated: boolean; ack?: string }> {
  if (interaction.isButton())
    return handleButton(interaction as ButtonInteraction);
  if (interaction.isStringSelectMenu())
    return handleSelect(interaction as StringSelectMenuInteraction);
  if (interaction.isModalSubmit())
    return handleModal(interaction as ModalSubmitInteraction);
  return { handled: false, mutated: false };
}

async function handleButton(
  i: ButtonInteraction,
): Promise<{ handled: boolean; mutated: boolean; ack?: string }> {
  if (!i.customId.startsWith('notes:'))
    return { handled: false, mutated: false };
  const action = i.customId.slice('notes:'.length);

  if (action.startsWith('add-go:')) {
    const [, cat, pri] = action.split(':');
    await i.showModal(buildAddModal(cat, pri as notes.Priority));
    return { handled: true, mutated: false };
  }
  if (action.startsWith('edit-go:')) {
    const [, idRaw, cat, pri] = action.split(':');
    const id = parseInt(idRaw, 10);
    const item = notes.list().find((it) => it.id === id);
    if (!item) {
      await i.reply({ content: `#${id} 못 찾았다냥`, flags: 64 });
      return { handled: true, mutated: false };
    }
    await i.showModal(buildEditModal(item, cat, pri as notes.Priority));
    return { handled: true, mutated: false };
  }

  switch (action) {
    case 'add':
      await sendAddPickMenu(i);
      return { handled: true, mutated: false };
    case 'complete':
    case 'edit':
    case 'delete':
      await sendPickMenu(i, action);
      return { handled: true, mutated: false };
    case 'archive': {
      const archive = notes.getArchive();
      const lines =
        archive.length === 0
          ? ['_보관함이 비어있다냥._']
          : archive
              .slice(0, 25)
              .map(
                (a) =>
                  `**#${String(a.id).padStart(3, '0')}** [\`${a.category}\`] ${a.title} — ${notes.statusLabel(a.status)} (${a.updatedAt.slice(0, 10)})`,
              );
      const e = new EmbedBuilder()
        .setColor(0x99aab5)
        .setTitle(`📦 보관함 (${archive.length}건)`)
        .setDescription(lines.join('\n').slice(0, 4000));
      await i.reply({ embeds: [e], flags: 64 }); // ephemeral
      return { handled: true, mutated: false };
    }
    case 'search':
      await i.showModal(buildSearchModal());
      return { handled: true, mutated: false };
    case 'stats': {
      const s = notes.stats();
      const catLines =
        Object.entries(s.byCategory)
          .map(([k, v]) => `\`${k}\`: ${v}`)
          .join(', ') || '_없음_';
      const e = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📊 통계')
        .addFields(
          { name: '총 항목', value: String(s.total), inline: true },
          { name: '보관함', value: String(s.archived), inline: true },
          {
            name: '우선순위',
            value: `상 ${s.byPriority.high} / 중 ${s.byPriority.mid} / 낮 ${s.byPriority.low}`,
            inline: false,
          },
          { name: '카테고리', value: catLines, inline: false },
        );
      await i.reply({ embeds: [e], flags: 64 });
      return { handled: true, mutated: false };
    }
    case 'refresh':
      await i.deferUpdate();
      return { handled: true, mutated: true, ack: 'refresh' };
    case 'opinion-add':
      await sendOpinionAddPickMenu(i);
      return { handled: true, mutated: false };
    default:
      logger.warn({ action }, 'Unknown notes button action');
      await i.reply({ content: '알 수 없는 버튼이다냥', flags: 64 });
      return { handled: true, mutated: false };
  }
}

async function handleSelect(
  i: StringSelectMenuInteraction,
): Promise<{ handled: boolean; mutated: boolean; ack?: string }> {
  if (i.customId === 'notes:filter') {
    notes.setFilterCategory(i.values[0]);
    await i.deferUpdate();
    return { handled: true, mutated: true, ack: 'filter' };
  }
  if (i.customId === 'notes:opinion-pick') {
    await handleOpinionAddPick(i);
    return { handled: true, mutated: false };
  }
  if (i.customId.startsWith('notes:add-cat:')) {
    const pri = i.customId.split(':')[2] as notes.Priority;
    const cat = i.values[0];
    await i.update({
      content: '카테고리·우선순위 고르고 다음 누르라냥',
      components: buildAddPickRows(cat, pri),
    });
    return { handled: true, mutated: false };
  }
  if (i.customId.startsWith('notes:add-pri:')) {
    const cat = i.customId.split(':')[2];
    const pri = i.values[0] as notes.Priority;
    await i.update({
      content: '카테고리·우선순위 고르고 다음 누르라냥',
      components: buildAddPickRows(cat, pri),
    });
    return { handled: true, mutated: false };
  }
  if (i.customId.startsWith('notes:edit-cat:')) {
    const parts = i.customId.split(':');
    const id = parseInt(parts[2], 10);
    const pri = parts[3] as notes.Priority;
    const cat = i.values[0];
    await i.update({
      content: `**#${String(id).padStart(3, '0')}** 카테고리·우선순위 고르고 다음 누르라냥`,
      components: buildEditPickRows(id, cat, pri),
    });
    return { handled: true, mutated: false };
  }
  if (i.customId.startsWith('notes:edit-pri:')) {
    const parts = i.customId.split(':');
    const id = parseInt(parts[2], 10);
    const cat = parts[3];
    const pri = i.values[0] as notes.Priority;
    await i.update({
      content: `**#${String(id).padStart(3, '0')}** 카테고리·우선순위 고르고 다음 누르라냥`,
      components: buildEditPickRows(id, cat, pri),
    });
    return { handled: true, mutated: false };
  }
  if (i.customId.startsWith('notes:pick:')) {
    const action = i.customId.slice('notes:pick:'.length) as
      | 'edit'
      | 'complete'
      | 'delete';
    const id = parseInt(i.values[0], 10);
    if (!Number.isFinite(id)) {
      await i.update({ content: 'ID 파싱 실패다냥', components: [] });
      return { handled: true, mutated: false };
    }
    if (action === 'edit') {
      const item = notes.list().find((it) => it.id === id);
      if (!item) {
        await i.update({ content: `#${id} 못 찾았다냥`, components: [] });
        return { handled: true, mutated: false };
      }
      await i.update({
        content: `**#${String(id).padStart(3, '0')}** 카테고리·우선순위 고르고 다음 누르라냥`,
        components: buildEditPickRows(item.id, item.category, item.priority),
      });
      return { handled: true, mutated: false };
    }
    if (action === 'complete') {
      const item = notes.complete(id);
      if (!item) {
        await i.update({ content: `#${id} 못 찾았다냥`, components: [] });
        return { handled: true, mutated: false };
      }
      await i.update({
        content: `${DDONYANG_EMOJI} **#${String(item.id).padStart(3, '0')}** 완료 처리, 보관함으로 옮겼다냥`,
        components: [],
      });
      return { handled: true, mutated: true, ack: 'complete' };
    }
    if (action === 'delete') {
      const item = notes.remove(id);
      if (!item) {
        await i.update({ content: `#${id} 못 찾았다냥`, components: [] });
        return { handled: true, mutated: false };
      }
      await i.update({
        content: `${DDONYANG_EMOJI} **#${String(item.id).padStart(3, '0')}** 삭제했다냥`,
        components: [],
      });
      return { handled: true, mutated: true, ack: 'delete' };
    }
  }
  return { handled: false, mutated: false };
}

async function sendPickMenu(
  i: ButtonInteraction,
  action: 'edit' | 'complete' | 'delete',
): Promise<void> {
  const items = notes.list();
  if (items.length === 0) {
    await i.reply({ content: '등록된 항목이 없다냥', flags: 64 });
    return;
  }
  const verb =
    action === 'edit'
      ? '수정할'
      : action === 'complete'
        ? '완료 처리할'
        : '삭제할';
  const shown = items.slice(0, 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`notes:pick:${action}`)
    .setPlaceholder(`${verb} 항목 골라라냥`)
    .addOptions(
      shown.map((it) => {
        const idStr = `#${String(it.id).padStart(3, '0')}`;
        const pri = notes.priorityLabel(it.priority);
        const desc = `[${it.category}] 우선순위: ${pri}`;
        return {
          label: `${idStr} ${it.title}`.slice(0, 100),
          description: desc.slice(0, 100),
          value: String(it.id),
        };
      }),
    );
  const row =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      select,
    );
  const note =
    items.length > 25 ? `(총 ${items.length}건 중 상위 25건만 보인다냥)` : '';
  await i.reply({
    content: `${verb} 항목을 골라라냥 ${note}`.trim(),
    components: [row],
    flags: 64,
  });
}

async function handleModal(
  i: ModalSubmitInteraction,
): Promise<{ handled: boolean; mutated: boolean; ack?: string }> {
  if (!i.customId.startsWith('notes:modal:'))
    return { handled: false, mutated: false };
  const fullAction = i.customId.slice('notes:modal:'.length);
  const [action, ...rest] = fullAction.split(':');
  const param = rest.join(':');
  const senderName =
    (i.member as { displayName?: string } | null)?.displayName ||
    i.user.username;

  try {
    switch (action) {
      case 'add': {
        const [cat, pri] = param.split(':');
        const title = i.fields.getTextInputValue('title');
        if (!title.trim()) {
          await i.reply({ content: '내용은 필수다냥', flags: 64 });
          return { handled: true, mutated: false };
        }
        const item = notes.add({
          title,
          category: cat || 'etc',
          priority: (pri as notes.Priority) || 'low',
          registeredBy: senderName,
        });
        await i.reply({
          content: `${DDONYANG_EMOJI} **#${String(item.id).padStart(3, '0')}** 추가했다냥`,
          flags: 64,
        });
        return { handled: true, mutated: true, ack: 'add' };
      }
      case 'edit': {
        const [idRaw, cat, pri] = param.split(':');
        const id = parseInt(idRaw, 10);
        if (!Number.isFinite(id)) {
          await i.reply({ content: 'ID 파싱 실패다냥', flags: 64 });
          return { handled: true, mutated: false };
        }
        const titleVal = i.fields.getTextInputValue('title').trim();
        const updated = notes.update({
          id,
          title: titleVal || undefined,
          category: cat || undefined,
          priority: (pri as notes.Priority) || undefined,
        });
        if (!updated) {
          await i.reply({ content: `#${id} 못 찾았다냥`, flags: 64 });
          return { handled: true, mutated: false };
        }
        await i.reply({
          content: `${DDONYANG_EMOJI} **#${String(updated.id).padStart(3, '0')}** 수정했다냥`,
          flags: 64,
        });
        return { handled: true, mutated: true, ack: 'edit' };
      }
      case 'opinion-add': {
        const content = i.fields.getTextInputValue('content').trim();
        if (!content) {
          await i.reply({ content: '의견 내용은 필수다냥', flags: 64 });
          return { handled: true, mutated: false };
        }
        let linkedFollowupId: number | undefined;
        if (param && param !== 'free') {
          const fid = parseInt(param, 10);
          if (!Number.isFinite(fid)) {
            await i.reply({ content: '연결 ID 파싱 실패다냥', flags: 64 });
            return { handled: true, mutated: false };
          }
          if (!notes.list().some((it) => it.id === fid)) {
            await i.reply({
              content: `#${String(fid).padStart(3, '0')} 항목 못 찾았다냥`,
              flags: 64,
            });
            return { handled: true, mutated: false };
          }
          linkedFollowupId = fid;
        }
        const item = opinions.add({
          content,
          authorName: senderName,
          authorId: i.user.id,
          linkedFollowupId,
        });
        const linkedSuffix =
          linkedFollowupId !== undefined
            ? ` (#${String(linkedFollowupId).padStart(3, '0')} 연결)`
            : ' (자유 의견)';
        await i.reply({
          content: `${DDONYANG_EMOJI} **${senderName}**의 의견 #${String(item.id).padStart(3, '0')}${linkedSuffix} 기억했다냥`,
          flags: 64,
        });
        return { handled: true, mutated: true, ack: 'opinion-add' };
      }
      case 'search': {
        const keyword = i.fields.getTextInputValue('keyword').trim();
        if (!keyword) {
          await i.reply({ content: '검색어를 입력해라냥', flags: 64 });
          return { handled: true, mutated: false };
        }
        const found = notes.search(keyword);
        const lines =
          found.length === 0
            ? [`\`${keyword}\` 매칭 항목 없다냥.`]
            : found
                .slice(0, 25)
                .map(
                  (f) =>
                    `**#${String(f.id).padStart(3, '0')}** [\`${f.category}\`] ${f.title}`,
                );
        const e = new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle(`🔍 "${keyword}" 검색 결과 (${found.length}건)`)
          .setDescription(lines.join('\n').slice(0, 4000));
        await i.reply({ embeds: [e], flags: 64 });
        return { handled: true, mutated: false };
      }
      default:
        await i.reply({ content: '알 수 없는 모달이다냥', flags: 64 });
        return { handled: true, mutated: false };
    }
  } catch (err) {
    logger.error({ err, action }, 'Notes modal handling failed');
    if (!i.replied) {
      await i.reply({ content: '처리 중 에러 났다냥', flags: 64 });
    }
    return { handled: true, mutated: false };
  }
}

function buildAddModal(cat: string, pri: notes.Priority): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`notes:modal:add:${cat}:${pri}`)
    .setTitle(`새 항목 추가 (${cat}·${notes.priorityLabel(pri)})`.slice(0, 45))
    .addComponents(
      row(
        new TextInputBuilder()
          .setCustomId('title')
          .setLabel('내용')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
    );
}

function buildEditModal(
  item: notes.FollowupItem,
  cat: string,
  pri: notes.Priority,
): ModalBuilder {
  const idStr = `#${String(item.id).padStart(3, '0')}`;
  return new ModalBuilder()
    .setCustomId(`notes:modal:edit:${item.id}:${cat}:${pri}`)
    .setTitle(`${idStr} 수정 (${cat}·${notes.priorityLabel(pri)})`.slice(0, 45))
    .addComponents(
      row(
        new TextInputBuilder()
          .setCustomId('title')
          .setLabel('내용')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000)
          .setValue(item.title),
      ),
    );
}

function buildOpinionAddModal(
  linkedFollowupId: number | undefined,
  label: string,
): ModalBuilder {
  const suffix =
    linkedFollowupId !== undefined ? `:${linkedFollowupId}` : ':free';
  return new ModalBuilder()
    .setCustomId(`notes:modal:opinion-add${suffix}`)
    .setTitle(`의견 — ${label}`.slice(0, 45))
    .addComponents(
      row(
        new TextInputBuilder()
          .setCustomId('content')
          .setLabel('의견 내용')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(2000)
          .setPlaceholder('자유롭게 적어라냥'),
      ),
    );
}

function buildSearchModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('notes:modal:search')
    .setTitle('검색')
    .addComponents(
      row(
        new TextInputBuilder()
          .setCustomId('keyword')
          .setLabel('검색어 (제목/메모/카테고리에서 매칭)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
}

function row(
  input: TextInputBuilder,
): ActionRowBuilder<ModalActionRowComponentBuilder> {
  return new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
    input,
  );
}
