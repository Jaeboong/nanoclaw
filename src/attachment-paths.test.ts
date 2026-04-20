import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  MAX_ATTACHMENT_BYTES,
  rejectionSummary,
  resolveAttachmentPath,
  resolveAttachmentPaths,
  type AttachmentMount,
} from './attachment-paths.js';
import { RegisteredGroup } from './types.js';

vi.mock('./mount-security.js', () => ({
  validateMount: (mount: { hostPath: string }, _isMain: boolean) => ({
    allowed: true,
    reason: 'test',
    realHostPath: mount.hostPath,
    resolvedContainerPath: path.basename(mount.hostPath),
    effectiveReadonly: false,
  }),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    path.join(os.tmpdir(), 'nanoclaw-attach-test-groups', folder),
}));

const TMP = path.join(os.tmpdir(), 'nanoclaw-attach-test');
const GROUP_DIR = path.join(os.tmpdir(), 'nanoclaw-attach-test-groups', 'g1');
const PROJECT_DIR = path.join(TMP, 'project');

beforeAll(() => {
  fs.mkdirSync(GROUP_DIR, { recursive: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  fs.writeFileSync(path.join(GROUP_DIR, 'shot.png'), 'img');
  fs.writeFileSync(path.join(PROJECT_DIR, 'a.txt'), 'hello');
  fs.mkdirSync(path.join(PROJECT_DIR, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'sub', 'b.txt'), 'nested');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), 'nanoclaw-attach-test-groups'), {
    recursive: true,
    force: true,
  });
});

function mounts(): AttachmentMount[] {
  return [
    { containerPath: '/workspace/group', hostPath: GROUP_DIR },
    { containerPath: '/workspace/extra/project', hostPath: PROJECT_DIR },
  ];
}

describe('resolveAttachmentPath', () => {
  it('resolves file at mount root', () => {
    const r = resolveAttachmentPath('/workspace/group/shot.png', mounts());
    expect(r).toEqual({ ok: true, hostPath: path.join(GROUP_DIR, 'shot.png') });
  });

  it('resolves nested file', () => {
    const r = resolveAttachmentPath(
      '/workspace/extra/project/sub/b.txt',
      mounts(),
    );
    expect(r).toEqual({
      ok: true,
      hostPath: path.join(PROJECT_DIR, 'sub', 'b.txt'),
    });
  });

  it('rejects non-absolute paths', () => {
    const r = resolveAttachmentPath('workspace/group/shot.png', mounts());
    expect(r.ok).toBe(false);
  });

  it('rejects paths containing ..', () => {
    const r = resolveAttachmentPath('/workspace/group/../etc/passwd', mounts());
    expect(r.ok).toBe(false);
  });

  it('rejects paths outside any mount', () => {
    const r = resolveAttachmentPath('/etc/passwd', mounts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not under any allowed mount/);
  });

  it('rejects non-existent files', () => {
    const r = resolveAttachmentPath('/workspace/group/missing.png', mounts());
    expect(r.ok).toBe(false);
  });

  it('rejects directories', () => {
    const r = resolveAttachmentPath('/workspace/extra/project/sub', mounts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/regular file/);
  });

  it('rejects files over size limit', () => {
    const big = path.join(PROJECT_DIR, 'big.bin');
    const fd = fs.openSync(big, 'w');
    fs.ftruncateSync(fd, MAX_ATTACHMENT_BYTES + 1);
    fs.closeSync(fd);
    try {
      const r = resolveAttachmentPath(
        '/workspace/extra/project/big.bin',
        mounts(),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/exceeds/);
    } finally {
      fs.rmSync(big, { force: true });
    }
  });
});

describe('resolveAttachmentPaths batch', () => {
  const group: RegisteredGroup = {
    name: 'g1',
    folder: 'g1',
    trigger: '@Andy',
    added_at: '2026-01-01T00:00:00Z',
    isMain: true,
    containerConfig: {
      additionalMounts: [{ hostPath: PROJECT_DIR, readonly: false }],
    },
  };

  it('splits valid and invalid into resolved + rejections', () => {
    const out = resolveAttachmentPaths(
      [
        '/workspace/group/shot.png',
        '/etc/passwd',
        '/workspace/extra/project/a.txt',
      ],
      group,
    );
    expect(out.resolved).toEqual([
      path.join(GROUP_DIR, 'shot.png'),
      path.join(PROJECT_DIR, 'a.txt'),
    ]);
    expect(out.rejections).toHaveLength(1);
    expect(out.rejections[0].containerPath).toBe('/etc/passwd');
    expect(out.rejections[0].reason).toMatch(/not under any allowed mount/);
  });

  it('returns empty batch when input is empty', () => {
    expect(resolveAttachmentPaths([], group)).toEqual({
      resolved: [],
      rejections: [],
    });
  });
});

describe('rejectionSummary', () => {
  it('formats common rejection reasons in Korean', () => {
    expect(
      rejectionSummary({
        containerPath: '/x/big.pdf',
        reason: 'File /x/big.pdf is 12000000 bytes, exceeds 10485760',
      }),
    ).toMatch(/big\.pdf.*exceeds/);
    expect(
      rejectionSummary({
        containerPath: '/x/dir',
        reason: 'Not a regular file: /x/dir',
      }),
    ).toMatch(/정규 파일이 아님/);
    expect(
      rejectionSummary({
        containerPath: '/etc/passwd',
        reason: 'Path /etc/passwd is not under any allowed mount',
      }),
    ).toMatch(/허용된 마운트 경로 밖/);
    expect(
      rejectionSummary({
        containerPath: 'rel.txt',
        reason: 'Attachment path must be absolute: rel.txt',
      }),
    ).toMatch(/잘못된 경로 형식/);
  });
});
