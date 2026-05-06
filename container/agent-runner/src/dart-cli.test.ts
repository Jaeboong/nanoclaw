import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('dart-tool CLI', () => {
  it('exits without exposing secrets when DART_API_KEY is missing', async () => {
    vi.stubEnv('DART_API_KEY', '');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((code: string | number | null | undefined) => {
      throw new Error(`exit ${code}`);
    });

    await expect(import('./dart-cli.js')).rejects.toThrow('exit 2');
    expect(errorSpy).toHaveBeenCalledWith('DART_API_KEY is not set');
  });
});
