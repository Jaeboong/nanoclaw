import { afterEach, describe, expect, it, mock } from 'bun:test';

import { OpenDartClient } from './client.js';

// bun:test has no vi.stubEnv/unstubAllEnvs — save/restore NO_PROXY manually.
const ORIG_NO_PROXY = process.env.NO_PROXY;
afterEach(() => {
  if (ORIG_NO_PROXY === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = ORIG_NO_PROXY;
});

describe('OpenDartClient', () => {
  it('adds crtfc_key and returns JSON payloads', async () => {
    const fetchMock = mock(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ status: '000', list: [] }),
      text: async () => '',
    }));
    const client = new OpenDartClient({
      apiKey: 'key',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await client.listFilings({ corpCode: '00149293', bgnDe: '20260101' });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('crtfc_key')).toBe('key');
    expect(url.pathname).toBe('/api/list.json');
  });

  it('throws on OpenDART non-success status', async () => {
    const fetchMock = mock(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ status: '013', message: 'no data' }),
      text: async () => '',
    }));
    const client = new OpenDartClient({
      apiKey: 'key',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(client.companyInfo('00149293')).rejects.toThrow('013');
  });

  it('bypasses proxies for the OpenDART host', () => {
    process.env.NO_PROXY = 'localhost,127.0.0.1';
    new OpenDartClient({
      apiKey: 'key',
      fetchImpl: mock(async () => ({})) as unknown as typeof fetch,
    });
    expect(process.env.NO_PROXY?.split(',')).toContain('opendart.fss.or.kr');
    expect(process.env.NO_PROXY?.split(',')).toContain('localhost');
  });
});
