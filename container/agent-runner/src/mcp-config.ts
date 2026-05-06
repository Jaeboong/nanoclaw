interface McpContainerInput {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

interface BuildMcpServersInput {
  containerInput: McpContainerInput;
  nanoclawMcpServerPath: string;
  dartMcpServerPath: string;
  env: Record<string, string | undefined>;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const BASE_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
];

export function buildAllowedTools(
  env: Record<string, string | undefined>,
): string[] {
  return env.DART_API_KEY
    ? [...BASE_ALLOWED_TOOLS, 'mcp__dart__*']
    : [...BASE_ALLOWED_TOOLS];
}

export function buildMcpServers({
  containerInput,
  nanoclawMcpServerPath,
  dartMcpServerPath,
  env,
}: BuildMcpServersInput): Record<string, McpServerConfig> {
  return {
    nanoclaw: {
      command: 'node',
      args: [nanoclawMcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      },
    },
    ...(env.DART_API_KEY
      ? {
          dart: {
            command: 'node',
            args: [dartMcpServerPath],
            env: { DART_API_KEY: env.DART_API_KEY },
          },
        }
      : {}),
  };
}
