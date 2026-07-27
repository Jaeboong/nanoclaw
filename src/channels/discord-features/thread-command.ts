/**
 * `/thread [name]` slash command — open a new Discord thread on demand.
 *
 * Additive module (see docs/UPSTREAM-MERGE.md): self-registers into the
 * interaction framework on import; touches no upstream-core logic. Replaces the
 * removed auto-thread-on-mention (see suppress-mention-thread.ts) with an
 * explicit, opt-in command — mentions now stay in the root channel and a thread
 * is created only when the user asks. Messages sent inside the new thread route
 * to a per-thread session automatically (the adapter encodes the threadId into
 * the platform id).
 *
 * Open to anyone (no `requireAdmin`): opening a thread is benign and the old
 * mention behavior it replaces was open to everyone too.
 */
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import {
  OPTION_STRING,
  registerSlashCommand,
  type SlashInvocation,
  type SlashResult,
} from '../discord-interactions.js';

const DISCORD_API = 'https://discord.com/api/v10';
const PUBLIC_THREAD = 11; // ChannelType.GuildPublicThread
const AUTO_ARCHIVE_MINUTES = 1440; // 24h — matches the old auto-thread default.
const DEFAULT_NAME = '새 대화';

async function handleThread(inv: SlashInvocation): Promise<SlashResult> {
  const token = readEnvFile(['DISCORD_BOT_TOKEN']).DISCORD_BOT_TOKEN ?? process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    log.warn('thread-command: no DISCORD_BOT_TOKEN — cannot create thread');
    return { text: '스레드를 만들 수 없습니다 — 봇 토큰이 설정되지 않았습니다.' };
  }

  const name = (inv.options.name ?? '').trim() || DEFAULT_NAME;

  try {
    // Thread-without-message: POST /channels/{id}/threads with an explicit
    // `type`. Requires the bot's CREATE_PUBLIC_THREADS permission (same perm the
    // old auto-thread relied on).
    const res = await fetch(`${DISCORD_API}/channels/${inv.channelId}/threads`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: PUBLIC_THREAD, auto_archive_duration: AUTO_ARCHIVE_MINUTES }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      log.warn('thread-command: Discord rejected thread create', {
        status: res.status,
        detail,
        channelId: inv.channelId,
      });
      return { text: `스레드 생성 실패 (HTTP ${res.status}).` };
    }
    const thread = (await res.json()) as { id?: string };
    if (!thread.id) {
      log.warn('thread-command: thread create returned no id', { channelId: inv.channelId });
      return { text: '스레드 생성 실패 — 응답에 스레드 id가 없습니다.' };
    }
    log.info('thread-command: thread created', { channelId: inv.channelId, threadId: thread.id, name });
    return { text: `스레드 열었어 → <#${thread.id}> · 거기서 이어가자.`, ephemeral: false };
  } catch (err) {
    log.error('thread-command: thread create threw', { err: String(err), channelId: inv.channelId });
    return { text: '스레드 생성 중 오류가 발생했습니다.' };
  }
}

registerSlashCommand(
  {
    name: 'thread',
    description: '이 채널에 새 대화 스레드 열기 (멘션과 무관하게 필요할 때만)',
    options: [
      {
        type: OPTION_STRING,
        name: 'name',
        description: '스레드 제목 (생략 시 "새 대화")',
        required: false,
      },
    ],
  },
  handleThread,
);

export { handleThread };
