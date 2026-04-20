/**
 * Download and persist Discord message attachments to the group's inbox so
 * the agent container can read them via its /workspace/group/inbox/ mount.
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';

export const MAX_INBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const INBOX_SUBDIR = 'inbox';

export interface InboundAttachment {
  url: string;
  name: string | null;
  size: number;
  contentType: string | null;
}

export interface SavedAttachment {
  /** Host filesystem path (for logging). */
  hostPath: string;
  /** Path the agent sees inside its container (/workspace/group/inbox/...). */
  containerPath: string;
  /** Original filename as sent by Discord (unsanitized). */
  originalName: string;
  /** Size in bytes. */
  size: number;
  /** MIME type from Discord, if provided. */
  contentType: string | null;
}

/**
 * Sanitize a filename so it's safe to write to disk: no path separators,
 * no leading dots, no control chars, length-capped. Preserves Hangul and
 * most Unicode letters/digits.
 */
export function sanitizeFilename(raw: string | null): string {
  const fallback = 'file';
  if (!raw) return fallback;
  let s = raw.normalize('NFC');
  s = s.replace(/[\x00-\x1f\x7f/\\]/g, '_');
  s = s.replace(/^\.+/, '');
  s = s.trim();
  if (!s) return fallback;
  if (s.length > 200) {
    const ext = path.extname(s).slice(0, 20);
    const base = path.basename(s, ext);
    s = base.slice(0, 200 - ext.length) + ext;
  }
  return s;
}

/**
 * Download a single attachment. Returns null on failure (logged) so the
 * caller can continue processing other attachments.
 */
export async function saveAttachment(
  attachment: InboundAttachment,
  groupFolder: string,
): Promise<SavedAttachment | null> {
  if (attachment.size > MAX_INBOUND_ATTACHMENT_BYTES) {
    logger.warn(
      {
        name: attachment.name,
        size: attachment.size,
        limit: MAX_INBOUND_ATTACHMENT_BYTES,
      },
      'Inbound attachment rejected — exceeds size limit',
    );
    return null;
  }

  const inboxDir = path.join(resolveGroupFolderPath(groupFolder), INBOX_SUBDIR);
  fs.mkdirSync(inboxDir, { recursive: true });

  const safeName = sanitizeFilename(attachment.name);
  const stamped = `${Date.now()}-${safeName}`;
  const hostPath = path.join(inboxDir, stamped);

  try {
    const response = await fetch(attachment.url);
    if (!response.ok) {
      logger.warn(
        { status: response.status, url: attachment.url },
        'Attachment download failed',
      );
      return null;
    }
    const buf = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(hostPath, buf);
  } catch (err) {
    logger.error({ err, name: attachment.name }, 'Attachment download error');
    return null;
  }

  return {
    hostPath,
    containerPath: `/workspace/group/${INBOX_SUBDIR}/${stamped}`,
    originalName: attachment.name ?? stamped,
    size: attachment.size,
    contentType: attachment.contentType,
  };
}

/**
 * Produce a human-readable reference line for an attachment that gets
 * appended to the message content. The agent reads this in the XML
 * message context and knows the container path to open.
 */
export function formatAttachmentReference(saved: SavedAttachment): string {
  const ct = saved.contentType ?? '';
  let kind = 'File';
  if (ct.startsWith('image/')) kind = 'Image';
  else if (ct.startsWith('video/')) kind = 'Video';
  else if (ct.startsWith('audio/')) kind = 'Audio';
  const kb = Math.round(saved.size / 1024);
  return `[${kind}: ${saved.originalName} (${kb}KB) saved at ${saved.containerPath}]`;
}
