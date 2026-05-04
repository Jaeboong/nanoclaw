import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

function matchScore(channel: Channel, jid: string): number {
  if (channel.matchJid) {
    return channel.matchJid(jid);
  }
  return channel.ownsJid(jid) ? 1 : 0;
}

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    const senderIdAttr = m.sender ? ` sender_id="${escapeXml(m.sender)}"` : '';
    return `<message sender="${escapeXml(m.sender_name)}"${senderIdAttr} time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
  files?: string[],
): Promise<void> {
  const channel = channels
    .filter((c) => c.isConnected())
    .reduce<{ channel: Channel | undefined; score: number }>(
      (best, candidate) => {
        const score = matchScore(candidate, jid);
        if (score > best.score) {
          return { channel: candidate, score };
        }
        return best;
      },
      { channel: undefined, score: 0 },
    ).channel;
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text, files);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.reduce<{ channel: Channel | undefined; score: number }>(
    (best, candidate) => {
      const score = matchScore(candidate, jid);
      if (score > best.score) {
        return { channel: candidate, score };
      }
      return best;
    },
    { channel: undefined, score: 0 },
  ).channel;
}
