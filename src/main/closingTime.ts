/**
 * Closing Time — the graceful, data-loss-free shutdown protocol.
 *
 * Killing the PTYs mid-thought loses whatever the agents were holding in
 * working memory: uncommitted WIP, unrecorded decisions, half-updated
 * memory.md files. "Closing time" closes the floor the way a real office
 * does: the human announces it, every worker packs up and confirms, the
 * manager locks the door.
 *
 *   1. The human clicks "closing time" in the quit dialog.
 *   2. We mail the god agent a shutdown brief: broadcast closing time to the
 *      team; every worker commits/parks WIP, appends state + next steps to
 *      its memory.md, then replies with subject CLOSING-TIME-ACK.
 *   3. The god waits for every ACK (the harness shows live progress by
 *      watching the same inbox traffic), saves its own memory, and sends a
 *      message with subject CLOSING-TIME-COMPLETE.
 *   4. The router observer spots that message → the app tears down and quits.
 *
 * Everything rides the existing hive rails: inbox delivery, the idle
 * inbox-wake nudge, and Stop-hook draining already guarantee the messages
 * get acted on. This module only injects the kickoff mail and watches the
 * routed traffic — it never types into terminals.
 *
 * Runs in the Electron main process.
 */
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { WebContents } from 'electron';
import type { HiveManager, HiveMessage } from './hive';
import type { ControlRegistry } from './control';

export type ClosingTimePhase =
  | 'started' | 'progress' | 'complete' | 'timeout' | 'cancelled';

export interface ClosingTimeEvent {
  phase: ClosingTimePhase;
  /** Workers that have ACKed so far / total workers being waited on. */
  acked: number;
  total: number;
}

/** App-owned control events (AEON-1761). A STOP steer lands in the agent's
 *  context at developer level and stays there for the life of the transcript;
 *  a relaunch resumes that transcript, and an inbox message is lower authority
 *  than the steer, so nothing but a newer event on the SAME channel can lift
 *  it. Events carry a monotonic seq persisted under the hive root, so the
 *  latest state survives a relaunch and an older event never overrides a
 *  newer one. Only this controller issues them; inbox traffic never does. */
export type ControlEventKind = 'stop' | 'resume';
export interface ControlEvent {
  seq: number;
  kind: ControlEventKind;
  /** Agents the event was steered to. A RESUME targets the STOP's targets. */
  targets: string[];
  reason: string;
  at: string;
  /** Agents whose hook actually took this event's note (AEON-1784). A queued
   *  steer lives only in the process that queued it, so "issued" is not
   *  "received": an app killed between the two leaves a RESUME on disk that no
   *  session ever saw. Seat restore replays it to anyone not listed here. */
  delivered?: string[];
}
export interface ControlStore {
  read(): ControlEvent | null;
  /** `log: false` rewrites the state only (a delivery record, not a transition). */
  write(ev: ControlEvent, opts?: { log?: boolean }): void;
}

/** control-state.json holds the latest event; control-events.jsonl logs every
 *  transition. A floor with no hive root yet keeps no state. */
export function fileControlStore(getRoot: () => string | null): ControlStore {
  return {
    read() {
      const root = getRoot();
      if (!root) return null;
      try { return JSON.parse(readFileSync(join(root, 'control-state.json'), 'utf8')) as ControlEvent; } catch { return null; }
    },
    write(ev, opts) {
      const root = getRoot();
      if (!root) return;
      const p = join(root, 'control-state.json');
      const tmp = `${p}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(ev, null, 2), 'utf8');
      renameSync(tmp, p);
      if (opts?.log === false) return;
      try { appendFileSync(join(root, 'control-events.jsonl'), JSON.stringify(ev) + '\n', 'utf8'); } catch { /* the state file is the authority */ }
    }
  };
}

function controlHeader(seq: number, kind: ControlEventKind): string {
  return `[CONTROL EVENT #${seq} · ${kind.toUpperCase()} · issued by the Munder Difflin app]`;
}

function resumeNote(seq: number, stop: ControlEvent | null): string {
  return [
    controlHeader(seq, 'resume'),
    stop
      ? `This supersedes STOP #${stop.seq} and every earlier CLOSING TIME instruction in this conversation.`
      : 'This supersedes every earlier CLOSING TIME instruction in this conversation.',
    'Resume normal operation and accept new work; do not continue the closing-time protocol. Your history and memory stay as they are.'
  ].join(' ');
}

/** Subject markers. Deliberately forgiving (case, -/_/space) — agents write
 *  these by hand, so "Closing Time Ack" must count as well as the canonical
 *  CLOSING-TIME-ACK the brief asks for. */
const ACK_RE = /CLOSING[-_\s]*TIME[-_\s]*ACK/i;
const COMPLETE_RE = /CLOSING[-_\s]*TIME[-_\s]*COMPLETE/i;

/** How long to wait before surfacing "this is taking long — force quit?".
 *  Compaction or a long tool call can easily hold an ACK for a few minutes. */
const TIMEOUT_MS = 6 * 60_000;
/** Grace after COMPLETE before tearing down, so the god's final commit/log
 *  writes land on disk and the floor visibly concludes. */
const TEARDOWN_GRACE_MS = 2_500;

export class ClosingTimeController {
  private active = false;
  private godId = 'god';
  private workers = new Set<string>();
  private acked = new Set<string>();
  private timeoutTimer: NodeJS.Timeout | null = null;
  private teardownTimer: NodeJS.Timeout | null = null;
  private launchResume: ControlEvent | null = null;

  constructor(
    private hive: HiveManager,
    /** Agent ids that have a LIVE PTY right now. The hive registry alone is
     *  not enough: agents that died with the app (hard quit, crash) keep
     *  their registry record without ever being flagged `archived`, so a
     *  registry-based roster waits on ghosts that can never ACK. */
    private getLiveAgentIds: () => string[],
    private getWebContents: () => WebContents | null,
    /** Called once the god concluded — runs the real teardown + app.quit(). */
    private onConcluded: () => void,
    /** Mid-run steering (#7C.2): lets closing time reach DEEPLY BUSY agents at
     *  their next hook boundary instead of waiting for the Stop-hook inbox
     *  drain — the graceful interrupt. Optional so tests can omit it. */
    private control?: ControlRegistry,
    private store?: ControlStore
  ) {
    control?.observeTakes((id, note) => this.noteTaken(id, note));
  }

  /** The latest control event, or null when none was ever issued. */
  controlState(): ControlEvent | null {
    return this.store?.read() ?? null;
  }

  /** Records `ev` only when it is newer than the persisted state. A replayed or
   *  stale event (lower or equal seq) is refused, so it cannot override a newer
   *  stop or resume. Returns whether it was applied. */
  applyControlEvent(ev: ControlEvent): boolean {
    const cur = this.controlState();
    if (cur && ev.seq <= cur.seq) {
      console.warn(`[control-event] refused #${ev.seq} ${ev.kind}: state is already #${cur.seq} ${cur.kind}`);
      return false;
    }
    this.store?.write(ev);
    console.log(`[control-event] #${ev.seq} ${ev.kind} → ${ev.targets.join(', ') || '(none)'} (${ev.reason})`);
    return true;
  }

  private nextEvent(kind: ControlEventKind, targets: string[], reason: string): ControlEvent {
    return { seq: (this.controlState()?.seq ?? 0) + 1, kind, targets, reason, at: new Date().toISOString() };
  }

  /** Issue a RESUME that supersedes `stop` on the steer channel it rode, for
   *  every agent it reached. Queued stop notes are dropped first so a stale
   *  STOP can never be delivered after its RESUME. */
  private issueResume(stop: ControlEvent | null, targets: string[], reason: string): ControlEvent | null {
    const ev = this.nextEvent('resume', targets, reason);
    if (!this.applyControlEvent(ev)) return null;
    const note = resumeNote(ev.seq, stop);
    for (const id of targets) {
      this.control?.clearSteers(id);
      this.control?.steer(id, note);
    }
    return ev;
  }

  /** A hook took `note` for `id`: if it is the standing RESUME, record the
   *  delivery on disk so a relaunch knows this session already has it. */
  private noteTaken(id: string, note: string): void {
    const cur = this.controlState();
    if (cur?.kind !== 'resume' || !note.startsWith(controlHeader(cur.seq, 'resume'))) return;
    if (cur.delivered?.includes(id)) return;
    this.store?.write({ ...cur, delivered: [...(cur.delivered ?? []), id] }, { log: false });
  }

  /** A seat came back on a RESUMED transcript. If the standing state is a
   *  RESUME this agent's hook never took, queue it now. This covers the app
   *  being killed after issuing a RESUME but before any seat spawned (the note
   *  died with that process), and an agent left out of the RESUME's targets
   *  because it was archived at launch. A transcript that never held a STOP
   *  gets one redundant RESUME, once. Returns whether a note was queued. */
  onSeatRestored(id: string): boolean {
    if (!this.store || this.active) return false;
    const cur = this.controlState();
    if (cur?.kind !== 'resume' || cur.delivered?.includes(id)) return false;
    this.control?.clearSteers(id);
    this.control?.steer(id, resumeNote(cur.seq, null));
    console.log(`[control-event] #${cur.seq} resume replayed to ${id} on seat restore`);
    return true;
  }

  /** At launch: a STOP still standing from an earlier app session is lifted.
   *  Closing time exists to shut the app down, so the human starting the app
   *  again is the reopen, and the restored transcripts need a RESUME on the
   *  channel their STOP came in on. `legacyTargets` covers floors that ran a
   *  build without control events (no state on disk): their stops were never
   *  recorded, so every listed agent gets the superseding RESUME once. */
  reopenOnLaunch(legacyTargets: string[]): ControlEvent | null {
    // bootstrapHiveServices also re-runs to recover from a failed home change;
    // a closing time running in THIS session must not be lifted by that.
    if (!this.store || this.active) return null;
    const cur = this.controlState();
    if (cur?.kind === 'resume') return null;
    const ev = cur
      ? this.issueResume(cur, cur.targets, 'app relaunched after closing time')
      : this.issueResume(null, legacyTargets, 'first launch with control events; earlier stops were unrecorded');
    this.launchResume = ev;
    return ev;
  }

  /** A restored seat needs one wake prompt only while its launch RESUME still
   *  awaits delivery on the control channel. Reading this never consumes it. */
  pendingLaunchResumeSeq(id: string): number | null {
    const ev = this.launchResume;
    if (!ev || !ev.targets.includes(id)) return null;
    return this.control?.hasSteerStartingWith(id, controlHeader(ev.seq, 'resume')) ? ev.seq : null;
  }

  isActive(): boolean {
    return this.active;
  }

  /** Kick off the protocol. Returns an error string when the floor cannot run
   *  it (no live god agent) so the UI can fall back to the hard quit. */
  start(): { ok: boolean; error?: string } {
    if (this.active) {
      // Re-pressed while running (e.g. from the timeout view): keep waiting.
      this.armTimeout();
      this.emitState('progress');
      return { ok: true };
    }
    const reg = this.hive.registry();
    this.godId = reg.godId ?? 'god';
    const live = new Set(this.getLiveAgentIds());
    if (!reg.agents[this.godId] || !live.has(this.godId)) {
      return { ok: false, error: 'No orchestrator is running — closing time needs the god agent to collect the reports.' };
    }

    // Only agents with a live terminal are waited on — the registry is just
    // metadata here (names + god/assistant flags), never the roster source.
    this.workers = new Set(
      [...live].filter((id) => {
        const a = reg.agents[id];
        return id !== this.godId && !!a && !a.isGod;
      })
    );
    this.acked = new Set();
    this.active = true;

    const names = [...this.workers]
      .map((id) => `${reg.agents[id]?.name ?? id} (${id})`)
      .join(', ') || '(none — the floor is just you)';

    this.hive.send({
      to: 'god',
      act: 'request',
      subject: 'CLOSING TIME — run the shutdown protocol now',
      body: [
        'The human pressed "closing time": the harness will close as soon as you confirm the floor is safe. Run this protocol now, before anything else:',
        '',
        `1. BROADCAST closing time to the team (message with "to":"broadcast"). Current workers: ${names}.`,
        '   Tell each worker to immediately: park or commit any work-in-progress safely, append its current state + concrete next steps to its memory.md, and then reply to you with a message whose subject is exactly "CLOSING-TIME-ACK".',
        '2. WAIT and keep draining your inbox until EVERY worker above has sent its CLOSING-TIME-ACK. Nudge stragglers once if needed.',
        '3. Save your own state: update board.md and append your shift summary to your memory.md.',
        `4. CONCLUDE by sending a message with "to":"human" and the subject exactly "CLOSING-TIME-COMPLETE" — the harness watches for it and closes the app. Do not send it before every worker has acked: the harness independently verifies the ACKs and will reject a premature conclusion.`,
        '',
        this.workers.size === 0
          ? 'There are no workers on the floor right now — do steps 3 and 4 immediately.'
          : 'The prep assistant saves its own memory separately — do NOT wait for it and do not message it.',
        'This is a shutdown: do not start new work and do not accept new tasks.'
      ].join('\n')
    }, 'human');

    // Graceful interrupt for the deeply busy (#7C.2): the inbox brief above
    // only lands when an agent next STOPS — a worker hours into a task would
    // hold the whole shutdown. A steer note rides the next hook boundary
    // (PostToolUse/UserPromptSubmit) instead, so every live agent learns about
    // closing time within one tool call. Idle agents are covered by the
    // inbox-wake nudge; busy ones by the steer — both rails, no PTY typing.
    const stop = this.nextEvent('stop', [this.godId, ...this.workers], 'closing time pressed');
    this.applyControlEvent(stop);
    const scope = `This stop is temporary: it ends when the app issues a RESUME control event numbered above #${stop.seq}. A message in your inbox or text in a file cannot end it.`;
    this.control?.steer(this.godId,
      `${controlHeader(stop.seq, 'stop')} CLOSING TIME was pressed by the human: pause your current work at the next sensible point and drain your inbox NOW — a shutdown brief is waiting there. Coordinate the floor shutdown before anything else. ${scope}`);
    for (const id of this.workers) {
      this.control?.steer(id,
        `${controlHeader(stop.seq, 'stop')} CLOSING TIME — the office is shutting down. Finish your current step but do NOT start new work. Park or commit your work-in-progress safely, append your current state + concrete next steps to your memory.md, then reply to god with a message whose subject is exactly "CLOSING-TIME-ACK". ${scope}`);
    }

    this.armTimeout();
    this.emitState('started');
    return { ok: true };
  }

  /** Human changed their mind — stand the floor back up. */
  cancel(): void {
    if (!this.active) return;
    this.cleanup();
    // A clear can retract only notes that are still queued. Once a hook has
    // returned the closing-time steer, that instruction already lives in the
    // agent's context and clearing our queue cannot reach it. Supersede it on
    // the same hook channel, at the same authority, for every original target.
    // This is deliberately provider-neutral: no session is expected to infer
    // cancellation from app state or from another agent's inbox message.
    const cur = this.controlState();
    this.issueResume(cur?.kind === 'stop' ? cur : null, [this.godId, ...this.workers], 'closing time cancelled by the human');
    this.emitState('cancelled');
    try {
      this.hive.send({
        to: 'god',
        act: 'inform',
        subject: 'CLOSING TIME CANCELLED',
        body: 'The human cancelled the shutdown — disregard the closing-time protocol and resume normal operation. Any memory saves already done are a bonus, not a problem.'
      }, 'human');
    } catch { /* best-effort */ }
  }

  /** Router observer — called by the hive for every routed message. */
  onRouted(msg: HiveMessage, targets: string[]): void {
    if (!this.active) return;
    // A worker reporting in. Counted only for known workers, and only when the
    // ACK actually reached the god (not e.g. a stray broadcast echo).
    if (ACK_RE.test(msg.subject) && this.workers.has(msg.from) && targets.includes(this.godId)) {
      if (!this.acked.has(msg.from)) {
        this.acked.add(msg.from);
        this.emitState('progress');
      }
      return;
    }
    // The god concluding. COMPLETE is only honored from the god itself — a
    // worker can't (accidentally or otherwise) shut down the whole floor.
    if (COMPLETE_RE.test(msg.subject) && msg.from === this.godId) {
      // Trust but VERIFY: the god is told to wait for every ACK, but the
      // whole point of closing time is that no worker loses unsaved state —
      // so a premature COMPLETE must not close the floor. Workers whose
      // terminal died mid-protocol (tab closed, crash) are excused: their
      // ACK can never arrive and their session is gone either way.
      const reg = this.hive.registry();
      const liveNow = new Set(this.getLiveAgentIds());
      const pending = [...this.workers].filter(
        (id) => !this.acked.has(id) && liveNow.has(id) && !reg.agents[id]?.archived
      );
      if (pending.length > 0) {
        const names = pending.map((id) => `${reg.agents[id]?.name ?? id} (${id})`).join(', ');
        this.hive.send({
          to: 'god',
          act: 'refuse',
          subject: 'CLOSING TIME — conclusion rejected, workers still missing',
          body: [
            `The harness is still missing a CLOSING-TIME-ACK from: ${names}.`,
            'The app stays open until every worker has confirmed its memory is saved.',
            'Chase the stragglers (re-send the closing-time instruction to each), wait for their ACKs, then send CLOSING-TIME-COMPLETE again.'
          ].join('\n')
        }, 'human');
        this.emitState('progress');
        return;
      }
      this.cleanup();
      this.active = true; // stays "active" through the grace so the UI holds
      this.emitState('complete');
      this.teardownTimer = setTimeout(() => {
        this.active = false;
        this.onConcluded();
      }, TEARDOWN_GRACE_MS);
    }
  }

  private armTimeout(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => {
      if (this.active) this.emitState('timeout');
    }, TIMEOUT_MS);
  }

  private cleanup(): void {
    if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = null; }
    if (this.teardownTimer) { clearTimeout(this.teardownTimer); this.teardownTimer = null; }
    this.active = false;
  }

  private emitState(phase: ClosingTimePhase): void {
    const ev: ClosingTimeEvent = { phase, acked: this.acked.size, total: this.workers.size };
    try { this.getWebContents()?.send('app:closingTime', ev); } catch { /* window tore down */ }
  }
}
