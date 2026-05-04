import { describe, expect, it, vi } from 'vitest';

import { findChannel, routeOutbound } from './router.js';
import type { Channel } from './types.js';

function createStubChannel(
  name: string,
  matcher: (jid: string) => number,
  connected = true,
): {
  channel: Channel;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn(async () => undefined);
  const channel = {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => connected,
    matchJid: matcher,
    name,
    ownsJid: (jid: string) => matcher(jid) > 0,
    sendMessage,
  } as Channel;
  return { channel, sendMessage };
}

describe('channel routing', () => {
  it('prefers the most specific channel match for a jid', () => {
    const genericDiscord = createStubChannel('discord', (jid) =>
      jid.startsWith('dc:') ? 1 : 0,
    );
    const monitoringDiscord = createStubChannel('discord-monitoring', (jid) =>
      jid === 'dc:1500673538129002606' ? 2 : 0,
    );

    const channel = findChannel(
      [genericDiscord.channel, monitoringDiscord.channel],
      'dc:1500673538129002606',
    );

    expect(channel).toBe(monitoringDiscord.channel);
  });

  it('routes outbound messages through the most specific connected channel', async () => {
    const genericDiscord = createStubChannel('discord', (jid) =>
      jid.startsWith('dc:') ? 1 : 0,
    );
    const monitoringDiscord = createStubChannel('discord-monitoring', (jid) =>
      jid === 'dc:1500673538129002606' ? 2 : 0,
    );

    await routeOutbound(
      [genericDiscord.channel, monitoringDiscord.channel],
      'dc:1500673538129002606',
      'hello',
    );

    expect(monitoringDiscord.sendMessage).toHaveBeenCalledWith(
      'dc:1500673538129002606',
      'hello',
      undefined,
    );
    expect(genericDiscord.sendMessage).not.toHaveBeenCalled();
  });
});
