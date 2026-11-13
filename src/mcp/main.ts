// `roundtable mcp`: stdio MCP server for agents. Launch from the agent's harness config (see docs in 2.6):
//   claude mcp add roundtable -s local -- node <repo>/dist/cli/main.js mcp
//   codex mcp add roundtable -- node <repo>/dist/cli/main.js mcp
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultRegistryDeps, resolveClaudeConfigDir } from '../adapters/claude/registry.js';
import { loadConfig } from '../core/config.js';
import { resolveRoomRoot } from '../core/registry/root.js';
import { RoomClient } from '../ipc/client.js';
import { resolveCaller, windowsProcessInfo } from './identity.js';
import { createRoomMcpServer } from './server.js';

export async function runMcpServer(): Promise<void> {
  const config = loadConfig();
  const root = await resolveRoomRoot(process.cwd(), config.roomRoot ?? undefined);
  const registry = defaultRegistryDeps(resolveClaudeConfigDir(config.claudeConfigDir), config.claudeProcStartTimeoutMs);
  const processInfo = windowsProcessInfo();
  const server = createRoomMcpServer({
    connect: () => RoomClient.connect(root, { client: 'mcp', autoStart: true }),
    identify: (meta) => resolveCaller(meta, { claudeRegistry: registry, processInfo, ownParentPid: process.ppid, env: process.env }),
  });
  await server.connect(new StdioServerTransport());
  // Exit when the host goes away: the room connection would otherwise keep this process alive as an orphan.
  const shutdown = () => {
    (server as typeof server & { closeRoom?: () => void }).closeRoom?.();
    void server.close().finally(() => process.exit(0));
  };
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
}
