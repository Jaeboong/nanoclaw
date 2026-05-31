import { afterEach, describe, expect, it, spyOn } from 'bun:test';

// bun:test has no vi.stubEnv/unstubAllEnvs — save/restore DART_API_KEY manually.
const ORIG_KEY = process.env.DART_API_KEY;
afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.DART_API_KEY;
  else process.env.DART_API_KEY = ORIG_KEY;
});

describe('dart-tool CLI', () => {
  it('exits without exposing secrets when DART_API_KEY is missing', async () => {
    process.env.DART_API_KEY = '';
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    try {
      await expect(import('./dart-cli.js')).rejects.toThrow('exit 2');
      expect(errorSpy).toHaveBeenCalledWith('DART_API_KEY is not set');
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
