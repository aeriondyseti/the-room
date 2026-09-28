// `room mcp`: stdio MCP server for agents. Launch from the agent's harness config (see docs in 2.6):
//   claude mcp add room -s local -- node <repo>/dist/cli/main.js mcp
//   codex mcp add room -- node <repo>/dist/cli/main.js mcp
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultRegistryDeps, resolveClaudeConfigDir } from '../adapters/claude/registry.js';
import { loadConfig } from '../core/config.js';
import { resolveRoomRoot } from '../core/registry/root.js';
import { RoomClient } from '../ipc/client.js';
import { resolveCaller, windowsParentOf } from './identity.js';
import { createRoomMcpServer } from './server.js';

export async function runMcpServer(): Promise<void> {
  const config = loadConfig();
  const root = await resolveRoomRoot(process.cwd(), config.roomRoot ?? undefined);
  const registry = defaultRegistryDeps(resolveClaudeConfigDir(config.claudeConfigDir), config.claudeProcStartTimeoutMs);
  const parentOf = windowsParentOf();
  const server = createRoomMcpServer({
    connect: () => RoomClient.connect(root, { client: 'mcp', autoStart: true }),
    identify: (meta) => resolveCaller(meta, { claudeRegistry: registry, parentOf, ownParentPid: process.ppid, env: process.env }),
  });
  await server.connect(new StdioServerTransport());
}
