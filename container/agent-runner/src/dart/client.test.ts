import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenDartClient } from './client.js';

afterEach(() => vi.restoreAllMocks());

describe('OpenDartClient', () => {
  it('adds crtfc_key and returns JSON payloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ status: '000', list: [] }),
      text: async () => '',
    });
    const client = new OpenDartClient({ apiKey: 'key', fetchImpl: fetchMock });
    await client.listFilings({ corpCode: '00149293', bgnDe: '20260101' });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('crtfc_key')).toBe('key');
    expect(url.pathname).toBe('/api/list.json');
  });

  it('throws on OpenDART non-success status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ status: '013', message: 'no data' }),
      text: async () => '',
    });
    const client = new OpenDartClient({ apiKey: 'key', fetchImpl: fetchMock });
    await expect(client.companyInfo('00149293')).rejects.toThrow('013');
  });
});
