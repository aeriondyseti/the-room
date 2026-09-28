// `room statusline-tap [-- <your statusline command>]` (6.6). Opt-in bridge for Claude plan usage: Claude Code passes
// its statusline command a JSON object on stdin that includes `rate_limits`. Wrap your statusline with this and it
// saves ONLY the per-window used-percentage and reset time (nothing else from the input) for `room tui` to show,
// then runs your original statusline command with the same input and prints its output. It never breaks the status
// line: any tap error is swallowed; the wrapped command's output and exit code pass through.
import { spawn } from 'node:child_process';
import { claudeTapPath, tapRecordFrom, writeTapRecord } from '../adapters/claude/rate-limits.js';
import { resolveClaudeConfigDir } from '../adapters/claude/registry.js';
import { loadConfig } from '../core/config.js';

export const STATUSLINE_TAP_USAGE = `room statusline-tap [-- <your statusline command>]

Opt-in: lets \`room tui\` show Claude plan usage (5h / weekly limits). Claude Code only passes these to your
statusline command, so point your Claude Code statusLine setting at:

  node <vibe-pairing>/dist/cli/main.js statusline-tap -- <your existing statusline command>

It stores only each limit's used percentage and reset time (nothing else from the statusline input), then runs
your command with the same input so your status line is unchanged. Without a command it prints nothing.`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

export async function runStatuslineTap(argv: string[]): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(STATUSLINE_TAP_USAGE);
    return 0;
  }
  const input = await readStdin().catch(() => '');
  try {
    const record = tapRecordFrom(JSON.parse(input), new Date());
    if (record) {
      const config = loadConfig();
      await writeTapRecord(claudeTapPath(resolveClaudeConfigDir(config.claudeConfigDir)), record);
    }
  } catch {
    // Never break the status line over a tap problem.
  }
  const sep = argv.indexOf('--');
  // The calling shell already unquoted these; re-quote any argument with spaces/quotes so paths survive.
  const quote = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const command = (sep >= 0 ? argv.slice(sep + 1) : argv).map(quote).join(' ').trim();
  if (!command) return 0;
  return await new Promise<number>((resolve) => {
    // The statusline setting is a shell command string (the user's own), so run it through the shell as Claude does.
    const child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
    child.stdin.on('error', () => {}); // the wrapped command may exit before reading all input
    child.stdin.end(input);
  });
}
