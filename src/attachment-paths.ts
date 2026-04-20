/**
 * Translate container-visible attachment paths to host paths for outbound
 * delivery, and enforce that the resolved host path lies under one of the
 * group's mounted directories (not an arbitrary host file).
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { validateMount } from './mount-security.js';
import { RegisteredGroup } from './types.js';

/**
 * Short human-readable reason suitable for appending to an outbound chat
 * message. We avoid leaking host paths — only the filename (basename) and
 * category are shown.
 */
export function rejectionSummary(item: {
  containerPath: string;
  reason: string;
}): string {
  const name = item.containerPath.split('/').pop() || item.containerPath;
  const r = item.reason;
  if (/exceeds /i.test(r) || /Per-message limit/i.test(r))
    return `${name} — ${r}`;
  if (/not a regular file/i.test(r)) return `${name} — 정규 파일이 아님`;
  if (/not under any allowed mount/i.test(r))
    return `${name} — 허용된 마운트 경로 밖`;
  if (/Cannot stat/i.test(r)) return `${name} — 파일을 찾을 수 없음`;
  if (/must be absolute/i.test(r) || /must not contain/i.test(r)) {
    return `${name} — 잘못된 경로 형식`;
  }
  return `${name} — ${r}`;
}

export interface AttachmentMount {
  containerPath: string;
  hostPath: string;
}

/**
 * Per-file cap. Discord's free tier rejects uploads above 10 MiB;
 * Nitro Basic allows 50 MiB and Nitro 500 MiB. We pick the free-tier value
 * so agents tell the user upfront rather than failing silently at Discord's API.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * Build the list of mounts a group's attachments may reference.
 * Only directories that the agent can legitimately produce or read files
 * from are included — the group folder (for screenshots/generated output)
 * and any validated additionalMounts.
 */
export function getAttachmentMounts(group: RegisteredGroup): AttachmentMount[] {
  const mounts: AttachmentMount[] = [
    {
      containerPath: '/workspace/group',
      hostPath: resolveGroupFolderPath(group.folder),
    },
  ];

  if (group.containerConfig?.additionalMounts) {
    for (const am of group.containerConfig.additionalMounts) {
      const result = validateMount(am, Boolean(group.isMain));
      if (
        result.allowed &&
        result.realHostPath &&
        result.resolvedContainerPath
      ) {
        mounts.push({
          containerPath: `/workspace/extra/${result.resolvedContainerPath}`,
          hostPath: result.realHostPath,
        });
      }
    }
  }

  return mounts;
}

export type ResolveResult =
  | { ok: true; hostPath: string }
  | { ok: false; reason: string };

/**
 * Resolve a single container path to a host path, rejecting anything
 * outside the provided mounts, traversal attempts, and non-regular files.
 */
export function resolveAttachmentPath(
  containerPath: string,
  mounts: readonly AttachmentMount[],
): ResolveResult {
  if (!path.isAbsolute(containerPath)) {
    return {
      ok: false,
      reason: `Attachment path must be absolute: ${containerPath}`,
    };
  }
  if (containerPath.split(path.sep).includes('..')) {
    return {
      ok: false,
      reason: `Attachment path must not contain "..": ${containerPath}`,
    };
  }

  for (const mount of mounts) {
    const prefix = mount.containerPath.endsWith('/')
      ? mount.containerPath
      : mount.containerPath + '/';
    const matches =
      containerPath === mount.containerPath || containerPath.startsWith(prefix);
    if (!matches) continue;

    const rel =
      containerPath === mount.containerPath
        ? ''
        : containerPath.slice(prefix.length);
    const hostPath = rel ? path.join(mount.hostPath, rel) : mount.hostPath;

    const escaped = path.relative(mount.hostPath, hostPath);
    if (escaped.startsWith('..') || path.isAbsolute(escaped)) {
      return { ok: false, reason: `Resolved path escapes mount root` };
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(hostPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `Cannot stat ${hostPath}: ${msg}` };
    }

    if (!stat.isFile()) {
      return { ok: false, reason: `Not a regular file: ${hostPath}` };
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        reason: `File ${hostPath} is ${stat.size} bytes, exceeds ${MAX_ATTACHMENT_BYTES}`,
      };
    }

    return { ok: true, hostPath };
  }

  return {
    ok: false,
    reason: `Path ${containerPath} is not under any allowed mount`,
  };
}

export interface AttachmentBatchResult {
  /** Host paths that passed validation and can be handed to the channel. */
  resolved: string[];
  /** Rejected entries so callers can surface feedback to the user. */
  rejections: Array<{ containerPath: string; reason: string }>;
}

/**
 * Resolve a batch of container paths. Always returns both what passed and
 * what was rejected, so the caller can tell the user why an attachment
 * didn't make it (silent drops are a bad UX).
 */
export function resolveAttachmentPaths(
  containerPaths: readonly string[],
  group: RegisteredGroup,
): AttachmentBatchResult {
  if (containerPaths.length === 0) return { resolved: [], rejections: [] };

  const mounts = getAttachmentMounts(group);
  const resolved: string[] = [];
  const rejections: AttachmentBatchResult['rejections'] = [];

  for (const cp of containerPaths) {
    if (resolved.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      rejections.push({
        containerPath: cp,
        reason: `Per-message limit (${MAX_ATTACHMENTS_PER_MESSAGE}) reached`,
      });
      continue;
    }
    const result = resolveAttachmentPath(cp, mounts);
    if (result.ok) {
      resolved.push(result.hostPath);
    } else {
      rejections.push({ containerPath: cp, reason: result.reason });
      logger.warn(
        { group: group.name, containerPath: cp, reason: result.reason },
        'Attachment rejected',
      );
    }
  }

  return { resolved, rejections };
}
