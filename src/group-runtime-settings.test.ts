import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP_BASE = path.join(os.tmpdir(), 'nanoclaw-runtime-settings-test');

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => path.join(TMP_BASE, folder),
}));

import {
  DEFAULT_SENTINEL,
  loadRuntimeSettings,
  saveRuntimeSettings,
  updateRuntimeSettings,
  effortLabel,
  modelLabel,
} from './group-runtime-settings.js';

const FOLDER = 'g1';

beforeEach(() => {
  fs.mkdirSync(path.join(TMP_BASE, FOLDER), { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP_BASE, { recursive: true, force: true });
});

describe('loadRuntimeSettings', () => {
  it('returns empty object when file missing', () => {
    expect(loadRuntimeSettings(FOLDER)).toEqual({});
  });

  it('returns valid model and effort', () => {
    saveRuntimeSettings(FOLDER, { model: 'claude-opus-4-7', effort: 'high' });
    expect(loadRuntimeSettings(FOLDER)).toEqual({
      model: 'claude-opus-4-7',
      effort: 'high',
    });
  });

  it('strips unknown model values', () => {
    fs.writeFileSync(
      path.join(TMP_BASE, FOLDER, 'runtime-settings.json'),
      JSON.stringify({ model: 'claude-gpt-5', effort: 'low' }),
    );
    expect(loadRuntimeSettings(FOLDER)).toEqual({ effort: 'low' });
  });

  it('strips invalid effort values', () => {
    fs.writeFileSync(
      path.join(TMP_BASE, FOLDER, 'runtime-settings.json'),
      JSON.stringify({ effort: 'ultra' }),
    );
    expect(loadRuntimeSettings(FOLDER)).toEqual({});
  });

  it('handles corrupt JSON gracefully', () => {
    fs.writeFileSync(
      path.join(TMP_BASE, FOLDER, 'runtime-settings.json'),
      'not valid json',
    );
    expect(loadRuntimeSettings(FOLDER)).toEqual({});
  });
});

describe('updateRuntimeSettings', () => {
  it('merges new model over existing', () => {
    saveRuntimeSettings(FOLDER, { model: 'claude-sonnet-4-6', effort: 'low' });
    const out = updateRuntimeSettings(FOLDER, { model: 'claude-opus-4-7' });
    expect(out).toEqual({ model: 'claude-opus-4-7', effort: 'low' });
  });

  it('clears model when set to default sentinel', () => {
    saveRuntimeSettings(FOLDER, { model: 'claude-opus-4-7', effort: 'low' });
    const out = updateRuntimeSettings(FOLDER, { model: DEFAULT_SENTINEL });
    expect(out).toEqual({ effort: 'low' });
  });

  it('clears effort when set to "off"', () => {
    saveRuntimeSettings(FOLDER, { model: 'claude-opus-4-7', effort: 'high' });
    const out = updateRuntimeSettings(FOLDER, { effort: 'off' });
    expect(out).toEqual({ model: 'claude-opus-4-7' });
  });

  it('ignores bogus model patches', () => {
    saveRuntimeSettings(FOLDER, { model: 'claude-sonnet-4-6' });
    const out = updateRuntimeSettings(FOLDER, { model: 'bogus-model' });
    expect(out).toEqual({ model: 'claude-sonnet-4-6' });
  });

  it('ignores bogus effort patches', () => {
    saveRuntimeSettings(FOLDER, { effort: 'medium' });
    const out = updateRuntimeSettings(FOLDER, { effort: 'ultra' });
    expect(out).toEqual({ effort: 'medium' });
  });
});

describe('labels', () => {
  it('modelLabel maps known IDs', () => {
    expect(modelLabel('claude-opus-4-7')).toMatch(/Opus/);
    expect(modelLabel(undefined)).toMatch(/기본값/);
    expect(modelLabel('unknown')).toBe('unknown');
  });

  it('effortLabel returns "off" for undefined', () => {
    expect(effortLabel(undefined)).toBe('off');
    expect(effortLabel('high')).toBe('high');
  });
});
