import { describe, expect, it } from 'vitest';
import { resolveContainerEnv } from './env-passthrough.js';

describe('resolveContainerEnv', () => {
  it('passes only valid requested names with available values', () => {
    expect(
      resolveContainerEnv(['DART_API_KEY', 'missing', 'bad-name'], {
        DART_API_KEY: 'secret',
      }),
    ).toEqual([{ name: 'DART_API_KEY', value: 'secret' }]);
  });

  it('deduplicates names and preserves first valid order', () => {
    expect(
      resolveContainerEnv(['DART_API_KEY', 'DART_API_KEY', 'OPENAI_API_KEY'], {
        DART_API_KEY: 'a',
        OPENAI_API_KEY: 'b',
      }),
    ).toEqual([
      { name: 'DART_API_KEY', value: 'a' },
      { name: 'OPENAI_API_KEY', value: 'b' },
    ]);
  });
});
