/**
 * How text is typed into an agent's TUI so the Enter that follows submits it.
 *
 * Text and Enter are always two writes, Enter PTY_SUBMIT_ENTER_DELAY_MS later: one chunk makes the TUI read the
 * "\r" as part of a paste. Multi-line text is wrapped in bracketed-paste markers so its newlines stay newlines.
 *
 * PITFALL (AEON-2468): Codex reads a raw burst of characters as a paste and turns any Enter it processes within
 * 120 ms of the burst's LAST processed character into a newline (codex-rs tui paste_burst.rs,
 * PASTE_ENTER_SUPPRESS_WINDOW). The window runs from when Codex reads the text, not from when it was written, so a
 * busy TUI that reads 20 ms late eats a 140 ms Enter and the nudge sits typed but unsent. An explicit bracketed
 * paste clears that window, so a provider with `bracketedSubmit` gets the markers even on one line.
 */
import { providerPreset, type AgentProvider } from './agentProvider';

export const PTY_SUBMIT_ENTER_DELAY_MS = 140;

export function ptySubmitPayload(text: string, provider: AgentProvider | undefined): string {
  const bracketed = text.includes('\n') || (provider !== undefined && providerPreset(provider).bracketedSubmit === true);
  return bracketed ? `\x1b[200~${text}\x1b[201~` : text;
}
