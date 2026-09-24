// Stand-in for a Claude Code PreToolUse guard (AEON-1705 test): reads the hook
// payload on stdin and denies a force-push or an unlocked tasks.json write with the
// same reply shape the real ~/git/claude-setup guards emit.
let data = '';
process.stdin.on('data', (d) => (data += d));
process.stdin.on('end', () => {
  let cmd = '';
  try { cmd = JSON.parse(data).tool_input.command || ''; } catch { /* allow */ }
  const reason = /git push\b.*--force/.test(cmd) ? 'FIXTURE: force-push is blocked'
    : /json\.dump\(.*tasks\.json|>\s*\S*tasks\.json/.test(cmd) ? 'FIXTURE: unlocked tasks.json write is blocked'
    : null;
  if (reason) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  }
});
