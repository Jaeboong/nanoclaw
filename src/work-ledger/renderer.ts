import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import { JiraIssueCache, NonJiraTodo, JiraSuggestion } from './state.js';

const STATUS_ORDER = ['To Do', 'In Progress', 'Code Review'];

function statusEmoji(s: string): string {
  const lower = s.toLowerCase();
  if (lower.includes('progress') || lower.includes('진행')) return '🟡';
  if (lower.includes('review') || lower.includes('리뷰')) return '🔵';
  if (
    lower.includes('to do') ||
    lower.includes('todo') ||
    lower.includes('open') ||
    lower.includes('할 일') ||
    lower.includes('할일')
  )
    return '⚪';
  return '🔘';
}

/** SSAFY 컨벤션: 제목이 `[BE]`, `[FE]`, `[AI]`, `[DOCS]` 로 시작.
 *  prefix 와 본문을 분리해서 시각적 배지로 보여주기 위해 파싱. */
function splitPart(summary: string): { part: string | null; rest: string } {
  const m = summary.match(/^\s*\[([A-Za-z]+)\]\s*(.*)$/);
  if (!m) return { part: null, rest: summary.trim() };
  return { part: m[1].toUpperCase(), rest: m[2].trim() };
}

function partBadge(part: string | null): string {
  switch (part) {
    case 'BE':
      return '⚙️ `BE` ';
    case 'FE':
      return '🖼️ `FE` ';
    case 'AI':
      return '🤖 `AI` ';
    case 'DOCS':
      return '📄 `DOC`';
    default:
      return part ? `\`${part}\` ` : '';
  }
}

/** SSAFY assignee display name 종종 `[구미_1반_이새롬]` 같이 들어옴 → 마지막 segment만. */
function cleanAssignee(name: string | null): string {
  if (!name) return '';
  const m = name.match(/^\[([^\]]+)\]$/);
  if (m) {
    const parts = m[1].split('_');
    return parts[parts.length - 1] || name;
  }
  return name;
}

function renderIssueLine(i: JiraIssueCache): string {
  const { part, rest } = splitPart(i.summary);
  const badge = partBadge(part);
  const who = i.assignee ? ` · *${cleanAssignee(i.assignee)}*` : '';
  return `${badge}[\`${i.key}\`](${i.url}) ${rest}${who}`;
}

function isSubtask(i: JiraIssueCache): boolean {
  const t = (i.type || '').toLowerCase();
  return (
    t.includes('subtask') || t.includes('sub-task') || t.includes('하위') // "하위 작업"
  );
}

function isEpic(i: JiraIssueCache): boolean {
  const t = (i.type || '').toLowerCase();
  return t.includes('epic') || t.includes('에픽');
}

function jiraSection(issues: JiraIssueCache[]): string {
  if (issues.length === 0) return '_열린 이슈 없음_';
  const buckets = new Map<string, JiraIssueCache[]>();
  for (const i of issues) {
    const list = buckets.get(i.status) ?? [];
    list.push(i);
    buckets.set(i.status, list);
  }
  const sortedStatuses = Array.from(buckets.keys()).sort((a, b) => {
    const ai = STATUS_ORDER.indexOf(a);
    const bi = STATUS_ORDER.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  const lines: string[] = [];
  for (const status of sortedStatuses) {
    const items = buckets.get(status) ?? [];
    lines.push(`**${statusEmoji(status)} ${status}** (${items.length})`);
    // BE / FE / AI / DOCS / (없음) 순으로 묶어서 보여주면 한 파트가 죽 이어져서 더 가독성 ↑
    const partOrder = ['BE', 'FE', 'AI', 'DOCS'];
    items.sort((a, b) => {
      const ap = splitPart(a.summary).part ?? 'ZZ';
      const bp = splitPart(b.summary).part ?? 'ZZ';
      const ai = partOrder.indexOf(ap);
      const bi = partOrder.indexOf(bp);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    for (const i of items) {
      lines.push(renderIssueLine(i));
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

/** Embed field value cap is 1024 chars; description cap is 4096. We use
 * description for body to fit more issues. Hard truncate with ellipsis. */
function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 20) + '\n…(이하 생략)';
}

export function buildJiraPanel(opts: {
  jiraIssues: JiraIssueCache[];
  lastJiraFetch: string | null;
  jiraError?: string;
}): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const parents = opts.jiraIssues.filter((i) => !isSubtask(i) && !isEpic(i));
  const subtasks = opts.jiraIssues.filter((i) => isSubtask(i));
  const epicCount = opts.jiraIssues.filter((i) => isEpic(i)).length;

  const body = opts.jiraError
    ? `⚠️ Jira 가져오기 실패: \`${opts.jiraError.slice(0, 200)}\``
    : jiraSection(parents);

  const subtaskHint =
    subtasks.length > 0
      ? `\n\n_+ ${subtasks.length}건 서브태스크 숨김 — 아래 \`서브태스크 펼치기\` 버튼_`
      : '';

  const embed = new EmbedBuilder()
    .setColor(0x0052cc)
    .setTitle('🎯 Jira')
    .setDescription(clamp(body + subtaskHint, 4000))
    .setFooter({
      text: `Story/Task/Bug ${parents.length}건 · 서브태스크 ${subtasks.length}건 · 에픽 ${epicCount}건 (숨김) · ${
        opts.lastJiraFetch
          ? new Date(opts.lastJiraFetch).toLocaleString('ko-KR', {
              timeZone: 'Asia/Seoul',
            })
          : '미동기화'
      }`,
    });

  const buttons: ButtonBuilder[] = [
    new ButtonBuilder()
      .setCustomId('work:sync')
      .setLabel('동기화')
      .setStyle(ButtonStyle.Secondary),
  ];
  if (subtasks.length > 0) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('work:expand-subtasks')
        .setLabel(`🔍 서브태스크 ${subtasks.length} 펼치기`)
        .setStyle(ButtonStyle.Primary),
    );
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

  return { embeds: [embed], components: [row] };
}

/** Build paginated ephemeral subtask drilldown — grouped by parent issue.
 *  Each page is one Discord message (kept under 5500 chars to stay safely
 *  below the 6000 per-message cap). Caller sends first page via editReply
 *  and the rest via followUp ephemeral. */
export function buildSubtasksEphemeral(jiraIssues: JiraIssueCache[]): {
  pages: { embeds: EmbedBuilder[] }[];
} {
  const subtasks = jiraIssues.filter((i) => isSubtask(i));
  if (subtasks.length === 0) {
    return {
      pages: [
        {
          embeds: [
            new EmbedBuilder()
              .setColor(0x0052cc)
              .setTitle('서브태스크 없음')
              .setDescription('현재 열린 서브태스크가 없다냥.'),
          ],
        },
      ],
    };
  }

  // Group by parent key (preserve insertion order via Map)
  const groups = new Map<string, JiraIssueCache[]>();
  for (const s of subtasks) {
    const k = s.parentKey ?? '_orphan';
    const list = groups.get(k) ?? [];
    list.push(s);
    groups.set(k, list);
  }

  const FIELD_NAME_MAX = 256;
  const FIELD_VALUE_MAX = 1024;
  const PAGE_TOTAL_MAX = 5500; // safe under 6000 message-total cap

  type Field = { name: string; value: string };
  type ChunkedField = Field[]; // a parent group, possibly split into multiple fields if value too long

  // Pre-build all (name, value) field chunks, splitting long parents across multiple fields
  const allChunks: ChunkedField[] = [];
  for (const [parentKey, kids] of groups) {
    const parentSummary = kids[0]?.parentSummary ?? '(unknown)';
    const headerBase =
      parentKey === '_orphan'
        ? '_(부모 없음)_'
        : `[\`${parentKey}\`] ${parentSummary}`;
    const header = headerBase.slice(0, FIELD_NAME_MAX);

    const lines = kids.map(renderIssueLine);
    // Pack lines into <=1024 char buckets; each bucket = one field.
    const buckets: string[] = [];
    let cur = '';
    for (const line of lines) {
      const candidate = cur ? cur + '\n' + line : line;
      if (candidate.length > FIELD_VALUE_MAX) {
        if (cur) buckets.push(cur);
        cur =
          line.length > FIELD_VALUE_MAX ? line.slice(0, FIELD_VALUE_MAX) : line;
      } else {
        cur = candidate;
      }
    }
    if (cur) buckets.push(cur);
    if (buckets.length === 0) buckets.push('_없음_');

    const fields: Field[] = buckets.map((value, idx) => ({
      name: idx === 0 ? header : `${header} (계속)`,
      value,
    }));
    allChunks.push(fields);
  }

  // Pack chunks into pages under PAGE_TOTAL_MAX. A "chunk" is a parent group;
  // we keep a parent group together when possible (within page char budget).
  // If a single chunk is larger than budget, split it across pages — fields
  // go in order anyway.
  const pages: { embeds: EmbedBuilder[] }[] = [];
  const totalParents = groups.size;
  let pageNum = 1;
  let curPageFields: Field[] = [];
  let curPageChars = 0;

  function flushPage(isLast = false): void {
    if (curPageFields.length === 0 && pages.length > 0) return;
    const e = new EmbedBuilder()
      .setColor(0x0052cc)
      .setTitle(`🔍 서브태스크 — page ${pageNum}`)
      .setDescription(
        pageNum === 1
          ? `총 **${subtasks.length}건** / 부모 이슈 ${totalParents}개. 부모별로 묶음 — 진행 중 / 시작 전만 표시.`
          : '_(이전 페이지에서 이어짐)_',
      );
    if (curPageFields.length > 0) e.addFields(...curPageFields);
    pages.push({ embeds: [e] });
    pageNum++;
    curPageFields = [];
    curPageChars = 0;
  }

  for (const chunk of allChunks) {
    for (const field of chunk) {
      const cost = field.name.length + field.value.length;
      const wouldExceedSize = curPageChars + cost > PAGE_TOTAL_MAX - 200; // leave headroom for title/desc
      const wouldExceedFields = curPageFields.length >= 25;
      if (wouldExceedSize || wouldExceedFields) {
        flushPage();
      }
      curPageFields.push(field);
      curPageChars += cost;
    }
  }
  flushPage(true);

  return { pages };
}

function nonJiraList(items: NonJiraTodo[]): string {
  if (items.length === 0) return '_없음_';
  return items.map((t) => `• \`${t.id.slice(-5)}\` ${t.text}`).join('\n');
}

export function buildNonJiraPanel(opts: { todos: NonJiraTodo[] }): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const fe = opts.todos.filter((t) => t.side === 'fe');
  const be = opts.todos.filter((t) => t.side === 'be');

  const embed = new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle('🗒️ 추후 할 일')
    .setDescription(
      'Jira에 등재 전 / 추후 정리 대상. FE/BE 분류는 자동 추정 + 수정 가능.',
    )
    .addFields(
      {
        name: `🖼️ FE (${fe.length})`,
        value: clamp(nonJiraList(fe), 1024),
        inline: true,
      },
      {
        name: `⚙️ BE (${be.length})`,
        value: clamp(nonJiraList(be), 1024),
        inline: true,
      },
    )
    .setFooter({ text: `총 ${opts.todos.length}건` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('work:add')
      .setLabel('추가')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('work:edit')
      .setLabel('수정')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('work:delete')
      .setLabel('삭제')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('work:promote')
      .setLabel('Jira에 넣기')
      .setStyle(ButtonStyle.Success),
  );

  return { embeds: [embed], components: [row] };
}

function suggestionLine(s: JiraSuggestion, index: number): string {
  const conf = `(${Math.round(s.confidence * 100)}%)`;
  const num = `**[${index + 1}]**`;
  if (s.action.kind === 'transition') {
    return `${num} **${s.candidateIssueKey ?? '?'}** → \`${s.action.status}\` ${conf}\n  ${s.reasoning}`;
  }
  return `${num} 새 이슈 [${s.action.type}] ${s.action.summary} ${conf}\n  ${s.reasoning}`;
}

export function buildSuggestionsPanel(suggestions: JiraSuggestion[]): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🔔 Jira 변경 권장')
    .setDescription(
      suggestions.length === 0
        ? '_대기 중인 권장 사항 없음_'
        : clamp(
            suggestions.map((s, idx) => suggestionLine(s, idx)).join('\n\n'),
            4000,
          ),
    )
    .setFooter({
      text:
        suggestions.length === 0
          ? '0건 대기'
          : `${suggestions.length}건 대기 · 버튼 행은 위 [N] 순서대로`,
    });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < Math.min(suggestions.length, 5); i++) {
    const s = suggestions[i];
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`work:sugg-apply:${s.id}`)
        .setLabel(`[${i + 1}] 적용`)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`work:sugg-edit:${s.id}`)
        .setLabel(`[${i + 1}] 수정`)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`work:sugg-delete:${s.id}`)
        .setLabel(`[${i + 1}] 삭제`)
        .setStyle(ButtonStyle.Danger),
    );
    components.push(row);
  }

  return { embeds: [embed], components };
}
