import { describe, expect, it } from 'vitest';
import { buildAllowedTools, buildMcpServers } from './mcp-config.js';

const containerInput = {
  chatJid: 'dc:test',
  groupFolder: 'job',
  isMain: false,
};

describe('MCP config', () => {
  it('omits DART tools and server when DART_API_KEY is unavailable', () => {
    expect(buildAllowedTools({})).not.toContain('mcp__dart__*');
    expect(
      buildMcpServers({
        containerInput,
        nanoclawMcpServerPath: '/app/dist/ipc-mcp-stdio.js',
        dartMcpServerPath: '/app/dist/dart-mcp-stdio.js',
        env: {},
      }),
    ).toEqual({
      nanoclaw: {
        command: 'node',
        args: ['/app/dist/ipc-mcp-stdio.js'],
        env: {
          NANOCLAW_CHAT_JID: 'dc:test',
          NANOCLAW_GROUP_FOLDER: 'job',
          NANOCLAW_IS_MAIN: '0',
        },
      },
    });
  });

  it('adds DART tools and server when DART_API_KEY is available', () => {
    expect(buildAllowedTools({ DART_API_KEY: 'secret' })).toContain(
      'mcp__dart__*',
    );
    expect(
      buildMcpServers({
        containerInput,
        nanoclawMcpServerPath: '/app/dist/ipc-mcp-stdio.js',
        dartMcpServerPath: '/app/dist/dart-mcp-stdio.js',
        env: { DART_API_KEY: 'secret' },
      }).dart,
    ).toEqual({
      command: 'node',
      args: ['/app/dist/dart-mcp-stdio.js'],
      env: { DART_API_KEY: 'secret' },
    });
  });
});
