// Mirrors the user's Claude Code PreToolUse guards into a Codex worker's hooks
// (AEON-1705), so a codex agent gets the same "blocked on purpose" guards a
// claude agent gets from the same machine.
//
// Only groups whose matcher covers `Bash` are mirrored. Codex reports its shell
// tool to PreToolUse as tool_name "Bash" with tool_input {command: string}, also
// for each nested exec_command inside a code-mode `exec` script, and honours the
// same {hookSpecificOutput:{permissionDecision:"deny"}} reply, so a Claude guard
// runs unmodified (verified live against codex-cli 0.153.4). Codex has no
// Write/Edit tool; its file edits go through apply_patch, whose hook shape was not
// observable, so Write|Edit-only groups are deliberately not mirrored.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface MirroredHook {
  command: string;
  timeout: number;
}

/** Codex parses `timeout` as seconds and floors 0 to 1s, so Claude's 0/absent
 *  sentinel must not be copied through. */
const DEFAULT_TIMEOUT_SEC = 30;

function matcherCoversBash(matcher: unknown): boolean {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  if (typeof matcher !== 'string') return false;
  try {
    return new RegExp(`^(?:${matcher})$`).test('Bash');
  } catch {
    return matcher === 'Bash';
  }
}

export function claudeBashGuards(settings: unknown): MirroredHook[] {
  const groups = (settings as { hooks?: { PreToolUse?: unknown } } | null)?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return [];
  const out: MirroredHook[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    if (!g || typeof g !== 'object' || !matcherCoversBash((g as { matcher?: unknown }).matcher)) continue;
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

/** The settings file a Claude Code session on this machine reads. */
export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
}

export function readClaudeBashGuards(path = claudeSettingsPath()): MirroredHook[] {
  if (!existsSync(path)) return [];
  try {
    return claudeBashGuards(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    console.warn('[hive] could not read Claude PreToolUse guards for codex parity:', e);
    return [];
  }
}

/** One `matcher = "Bash"` PreToolUse group for a Codex config.toml. JSON string
 *  escaping is a valid TOML basic string, same as the hive shim entry. */
export function codexGuardHooksToml(hooks: MirroredHook[]): string {
  if (!hooks.length) return '';
  let toml = '\n# --- Claude Code PreToolUse guards mirrored for codex (AEON-1705; auto-generated) ---\n';
  toml += '\n[[hooks.PreToolUse]]\nmatcher = "Bash"\n';
  for (const h of hooks) {
    toml += `[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(h.command)}\ntimeout = ${h.timeout}\n`;
  }
  return toml;
}
