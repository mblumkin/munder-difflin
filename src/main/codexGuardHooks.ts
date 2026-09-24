// Mirrors the user's Claude Code PreToolUse guards into a Codex worker's hooks
// (AEON-1705, AEON-1706), so a codex agent gets the same "blocked on purpose" guards
// a claude agent gets from the same machine.
//
// Verified live against codex-cli 0.153.4, including inside code-mode `exec` scripts:
// - a shell call reaches PreToolUse as tool_name "Bash", tool_input {command: string};
// - a file edit reaches it as tool_name "apply_patch", tool_input {command: <patch>},
//   with every target on an "*** Add File: / Update File: / Delete File: / Move to:" line;
// - the {hookSpecificOutput:{permissionDecision:"deny"}} reply blocks the call.
// So Bash-covering groups mirror under matcher "Bash", and Write/Edit-covering groups
// mirror under matcher "apply_patch". A guard that does not understand apply_patch
// input simply sees a tool it ignores; the ~/git/claude-setup file guards parse it.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface MirroredHook {
  command: string;
  timeout: number;
}

export interface MirroredGuards {
  bash: MirroredHook[];
  applyPatch: MirroredHook[];
}

/** Codex parses `timeout` as seconds and floors 0 to 1s, so Claude's 0/absent
 *  sentinel must not be copied through. */
const DEFAULT_TIMEOUT_SEC = 30;
const CLAUDE_FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

function matcherCovers(matcher: unknown, tools: string[]): boolean {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  if (typeof matcher !== 'string') return false;
  try {
    const re = new RegExp(`^(?:${matcher})$`);
    return tools.some((t) => re.test(t));
  } catch {
    return tools.includes(matcher);
  }
}

function collect(groups: unknown[], tools: string[]): MirroredHook[] {
  const out: MirroredHook[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    if (!g || typeof g !== 'object' || !matcherCovers((g as { matcher?: unknown }).matcher, tools)) continue;
    const hooks = (g as { hooks?: unknown }).hooks;
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) {
      const command = (h as { type?: unknown; command?: unknown })?.command;
      if ((h as { type?: unknown })?.type !== 'command' || typeof command !== 'string' || !command.trim()) continue;
      if (seen.has(command)) continue;
      seen.add(command);
      const t = (h as { timeout?: unknown }).timeout;
      out.push({ command, timeout: typeof t === 'number' && t > 0 ? t : DEFAULT_TIMEOUT_SEC });
    }
  }
  return out;
}

export function claudeGuards(settings: unknown): MirroredGuards {
  const groups = (settings as { hooks?: { PreToolUse?: unknown } } | null)?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return { bash: [], applyPatch: [] };
  return { bash: collect(groups, ['Bash']), applyPatch: collect(groups, CLAUDE_FILE_TOOLS) };
}

/** The settings file a Claude Code session on this machine reads. */
export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
}

export function readClaudeGuards(path = claudeSettingsPath()): MirroredGuards {
  if (!existsSync(path)) return { bash: [], applyPatch: [] };
  try {
    return claudeGuards(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    console.warn('[hive] could not read Claude PreToolUse guards for codex parity:', e);
    return { bash: [], applyPatch: [] };
  }
}

function group(matcher: string, hooks: MirroredHook[]): string {
  if (!hooks.length) return '';
  let toml = `\n[[hooks.PreToolUse]]\nmatcher = ${JSON.stringify(matcher)}\n`;
  for (const h of hooks) {
    toml += `[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(h.command)}\ntimeout = ${h.timeout}\n`;
  }
  return toml;
}

/** PreToolUse groups for a Codex config.toml. JSON string escaping is a valid TOML
 *  basic string, same as the hive shim entry. */
export function codexGuardHooksToml(guards: MirroredGuards): string {
  const body = group('Bash', guards.bash) + group('apply_patch', guards.applyPatch);
  return body ? '\n# --- Claude Code PreToolUse guards mirrored for codex (AEON-1705; auto-generated) ---\n' + body : '';
}
