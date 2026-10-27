/**
 * WorkerWakeWatchdog — main-process inbox-wake watchdog for worker agents (#151).
 *
 * The renderer polls quickly for worker inbox mail; this main-process watchdog
 * also wakes workers when a throttled/occluded renderer misses that mail. Both
 * paths share announcement and in-flight state here so only one types a nudge.
 *
 * This watchdog is the worker-side counterpart: on a cadence it finds live
 * workers that are genuinely idle, have newly arrived inbox mail, are not
 * paused / not awaiting a human decision, and have not been nudged recently —
 * then types the same guarded nudge the renderer would have, directly into the
 * PTY. Message ids make this edge-triggered: unchanged undrained mail is never
 * re-announced once a minute forever.
 *
 * Safety mirrors the renderer's guarded queue-drain (useHive.ts dispatch):
 *  - only a GENUINELY idle worker is nudged (no PTY output for IDLE_MS — the
 *    same quiescence the renderer's idle fallback uses), never a mid-turn one,
 *  - never inside the boot sequence (BOOT_GRACE_MS from spawn, mirroring the
 *    renderer's bootGraceUntil),
 *  - delivery paused / agent paused / halted → no nudge (ControlRegistry),
 *  - a recent permission/HITL notification re-arms a block (HITL_REARM_MS) so a
 *    prompt the human is deciding on is never typed into,
 *  - a renderer-observed draft or interactive picker blocks a main-process
 *    nudge until the same expiry used by the renderer queue,
 *  - a per-worker cooldown (NUDGE_COOLDOWN_MS) against repeated watchdog attempts.
 *
 * Deliberately the renderer's own nudge text, and the same type pattern the
 * renderer's submitToPty uses (text first, Enter as a separate keystroke).
 *
 * No electron import — unit-testable (mirrors ControlRegistry).
 */

/** The exact nudge the renderer's inbox-wake loop would have typed. */
export const WORKER_WAKE_NUDGE =
  'You have new hive inbox message(s) — read your inbox, act on them now, and move handled ones to inbox/.done/. Act autonomously; only message god if you genuinely need a decision.';

/** A wake prompt only. The event itself must arrive via the control hook. */
export const CONTROL_EVENT_PENDING_NUDGE = 'A control event is pending. Continue this session to receive it.';

/** No PTY output for this long = genuinely idle (renderer QUIESCE_IDLE_MS). */
export const WORKER_WAKE_IDLE_MS = 12_000;
/** Never nudge inside the boot sequence (renderer BOOT_GRACE_MS). */
export const WORKER_WAKE_BOOT_GRACE_MS = 35_000;
/** Minimum gap between two watchdog nudges of the same worker. */
export const WORKER_WAKE_COOLDOWN_MS = 60_000;
/** A permission/HITL notification blocks nudges for this long after it fires. */
export const WORKER_WAKE_HITL_REARM_MS = 5 * 60_000;
/** Mail this old with NO session activity since it landed = a STALLED worker:
 *  its CLI never took the first turn (a boot-time nudge lost while the TUI was
 *  still drawing, an occluded renderer that never typed one). PTY output cannot
 *  vouch for such a worker — a TUI redraws its chrome without doing any work,
 *  and the boot sequence itself is output — so past this age the quiet-output
 *  and never-output rules are bypassed, and so is the announced-ids edge trigger
 *  (#358 is for a worker that HEARD the announcement; a stalled one did not),
 *  still subject to paused/halted/HITL/boot-grace/cooldown. Observed live
 *  2026-09-06: a worker sat 17 minutes on its work order with 0 tokens and no
 *  transcript until the human typed "read your inbox" by hand; this watchdog
 *  never fired.
 *
 *  "Session activity" is a tool span or a usage sample with tokens (telemetry,
 *  which only Claude Code exports) OR a hook event that proves a turn
 *  (UserPromptSubmit / PreToolUse / PostToolUse / Stop — every engine the
 *  harness shims sends those). The rule is OFF for an agent that has produced
 *  neither a telemetry sample nor a single hook event: with no channel that
 *  could ever show a turn, "no activity" is not evidence of anything, and a
 *  Codex/Gemini/grok worker would otherwise read as stalled forever and be
 *  nudged every cooldown while working — the repeated nudging #368 removed. */
export const WORKER_WAKE_STALL_MS = 90_000;
/** Minimum age of pending mail before a held worker is reported in the log. */
export const WORKER_WAKE_REPORT_MS = 60_000;
/** A typed wake is HEARD only when the worker's CLI shows a UserPromptSubmit
 *  this soon after the typing began; otherwise its ids are released for a retry
 *  (AEON-2660). A successful Enter WRITE proves nothing: on 2026-10-27 a nudge
 *  typed while the worker was mid-turn sat in its input box as a draft for
 *  58 minutes, announced and therefore never retyped, while the stall rule read
 *  the rest of that same turn as work done on the mail. */
export const WORKER_WAKE_ACK_MS = 10_000;

/** A hook event message that means "the agent needs the human" — permission /
 *  approve / confirm prompts (mirrors the renderer's needsHuman detection in
 *  useHive.ts). Anything matching the idle-waiting shape is NOT a HITL hold. */
export type HookClass = 'needsHuman' | 'idle' | null;

export function classifyHook(event: string | undefined, message: string | undefined): HookClass {
  if (event === 'Notification') {
    const msg = (message ?? '').toLowerCase();
    const idleWaiting = !msg
      || msg.includes('waiting for your input')
      || msg.includes('is idle')
      || msg.includes('waiting for input');
    const needsHuman = msg.includes('permission')
      || msg.includes('approve')
      || msg.includes('confirm')
      || msg.includes('needs your');
    if (needsHuman && !idleWaiting) return 'needsHuman';
    return 'idle';
  }
  return null;
}

/** A hook event that proves the CLI took a turn — the activity signal every
 *  engine the harness shims produces (Codex, Gemini, grok, … are mapped onto
 *  these names in hive.ts), unlike telemetry, which only Claude Code exports.
 *  SessionStart is the CLI coming up, not a turn: a worker whose boot nudge was
 *  lost has exactly that and nothing else. Notification is the CLI waiting. */
export function isTurnHook(event: string | undefined): boolean {
  switch (event) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'Stop':
    case 'StopFailure':
    case 'SubagentStart':
    case 'SubagentStop':
      return true;
    default:
      return false;
  }
}

/** One worker's live facts, gathered by the caller each beat. */
export interface WorkerWakeFacts {
  /** Worker agent id (god is never a candidate). */
  agentId: string;
  /** True when this agent is the orchestrator — god is never nudged. */
  isGod?: boolean;
  /** Live PTY id, or undefined when the agent has no terminal. */
  ptyId?: string;
  /** Timestamp of the PTY's last output (0 = never output). */
  lastOutputAt: number;
  /** Renderer-observed terminal draft/picker block deadline. */
  terminalBlockedUntil?: number;
  /** IDs of undrained inbox messages (empty → nothing to wake for). */
  inboxIds: readonly string[];
  /** Launch event still queued on the control channel, if any. */
  pendingResumeSeq?: number | null;
  /** ControlRegistry snapshot flags. */
  autoDeliveryPaused: boolean;
  paused: boolean;
  halted: boolean;
  /** When telemetry last showed the CLI doing a turn — a tool span, or a usage
   *  sample WITH tokens (activityEvidenceAt) — or 0/undefined when it never has. */
  lastActivityAt?: number;
  /** True when the telemetry collector holds ANY usage sample for the agent
   *  (even the zero-token one stamped at session start): its CLI exports
   *  telemetry, so a missing turn there means something. Only Claude Code
   *  does; for every other engine the hooks are the activity channel. */
  hasTelemetry?: boolean;
  /** created_at of the OLDEST undrained inbox message, or 0/undefined when
   *  unknown (the stall rule then stays off — fail closed, as before). */
  oldestMailAt?: number;
}

/** Why a worker with pending mail is NOT being nudged right now. */
export type WorkerWakeHold =
  | 'god' | 'no-mail' | 'no-pty'
  | 'delivery-paused' | 'paused' | 'halted'
  | 'renderer-claim' | 'booting' | 'mid-turn' | 'draft' | 'boot-grace' | 'hitl' | 'announced' | 'awaiting-ack' | 'cooldown';

/** A typed wake whose UserPromptSubmit never came: the ids went back to unheard. */
export interface UnackedWake {
  agentId: string;
  ids: string[];
  /** When the typing that was never acknowledged began. */
  typedAt: number;
}

/** The inbox ids that count as mail: non-empty strings only. */
function liveInboxIds(f: WorkerWakeFacts): Set<string> {
  return new Set(f.inboxIds.filter((id) => typeof id === 'string' && id.length > 0));
}

/** Mail has waited WORKER_WAKE_STALL_MS and the CLI has shown no session
 *  activity since it landed: whatever its terminal is printing, this worker is
 *  not working the mail. */
export function isStalledWorker(f: WorkerWakeFacts, now = Date.now()): boolean {
  const mailAt = f.oldestMailAt ?? 0;
  if (mailAt <= 0 || liveInboxIds(f).size === 0) return false;
  if (now - mailAt < WORKER_WAKE_STALL_MS) return false;
  return (f.lastActivityAt ?? 0) < mailAt;
}

/** The subset of telemetry the activity rule reads. Structural so the beat can
 *  hand it the collector's own types and tests can hand it literals. */
export interface ActivityEvidence {
  /** The agent's latest usage sample (cumulative counters, ts = last update). */
  usage?: { ts: number; input: number; output: number } | null;
  /** Tool spans the agent has run, in arrival order. */
  spans?: ReadonlyArray<{ ts: number }> | null;
}

/** When the CLI last demonstrably did a turn, or 0 when it never has.
 *
 *  A usage sample only counts when it carries tokens: the collector stamps a
 *  sample at session start with every counter at zero, and a boot-time sample
 *  is exactly what a worker that never took its first turn has. A tool span is
 *  always a turn. Observed live 2026-09-07: a worker with 0 tokens, no tool and
 *  no transcript read as "last activity 63s ago" and was held as mid-turn. */
export function activityEvidenceAt(ev: ActivityEvidence): number {
  const u = ev.usage;
  const worked = u && (Number(u.input) || 0) + (Number(u.output) || 0) > 0 ? Number(u.ts) || 0 : 0;
  let span = 0;
  for (const s of ev.spans ?? []) if (s && Number(s.ts) > span) span = Number(s.ts);
  return Math.max(worked, span);
}

export class WorkerWakeWatchdog {
  /** ptyId → spawn timestamp (boot grace). */
  private spawnedAt = new Map<string, number>();
  /** agentId → last nudge timestamp (cooldown). */
  private lastNudgeAt = new Map<string, number>();
  /** agentId → inbox ids included in the last nudge. This turns the watchdog
   *  into an edge trigger: a worker is nudged again only when a new id appears. */
  private announcedInboxIds = new Map<string, Set<string>>();
  /** A renderer queue delivery reserved before it starts typing. The expiry
   *  releases a reservation if its renderer disappears mid-delivery. */
  private rendererClaims = new Map<string, { token: number; ids: string[]; since: number; until: number }>();
  private nextRendererToken = 1;
  private announcedResumeSeq = new Map<string, number>();
  /** agentId → timestamp of the last needsHuman hook notification. */
  private lastHumanNeedsAt = new Map<string, number>();
  /** agentId → timestamp of its last hook event of ANY kind: the agent's hooks
   *  are alive, so a missing turn hook means something. */
  private hookSeenAt = new Map<string, number>();
  /** agentId → timestamp of its last hook event that proves a turn. */
  private lastTurnHookAt = new Map<string, number>();
  /** agentId → when its hold was last reported, so the beat logs a held worker
   *  once per cooldown instead of every 15 s. */
  private lastHoldReportAt = new Map<string, number>();
  /** agentId → its latest UserPromptSubmit hook: the proof a typed wake was heard. */
  private lastPromptAt = new Map<string, number>();
  /** agentId → a typed wake awaiting its UserPromptSubmit (WORKER_WAKE_ACK_MS). */
  private pendingAcks = new Map<string, { ids: Set<string>; since: number }>();
  /** agentId → when its last unacknowledged wake was released: both delivery
   *  paths wait a cooldown before typing again, so a CLI that keeps swallowing
   *  the Enter is not handed a growing draft every few seconds. */
  private lastUnackedAt = new Map<string, number>();
  /** Released wakes not yet collected by the beat's log (takeUnacked). */
  private unacked: UnackedWake[] = [];

  /** Record a PTY spawn so its boot sequence is left alone. */
  noteSpawn(ptyId: string, at = Date.now()): void {
    this.spawnedAt.set(ptyId, at);
  }

  /** Feed hook events (from HookServer): a HITL prompt blocks nudges, and any
   *  turn-proving event is activity the stall rule credits — the one channel
   *  every engine has, telemetry being Claude-only. */
  noteHook(agentId: string | undefined, event: string | undefined, message: string | undefined, at = Date.now()): void {
    if (!agentId) return;
    this.hookSeenAt.set(agentId, at);
    if (isTurnHook(event) && at > (this.lastTurnHookAt.get(agentId) ?? 0)) this.lastTurnHookAt.set(agentId, at);
    if (event === 'UserPromptSubmit') {
      if (at > (this.lastPromptAt.get(agentId) ?? 0)) this.lastPromptAt.set(agentId, at);
      const pending = this.pendingAcks.get(agentId);
      if (pending && at >= pending.since) {
        this.pendingAcks.delete(agentId);
        this.announcedInboxIds.set(agentId, pending.ids);
      }
    }
    if (classifyHook(event, message) === 'needsHuman') this.lastHumanNeedsAt.set(agentId, at);
  }

  /** When the agent's hooks last proved a turn, or 0 when they never have. */
  turnHookAt(agentId: string): number {
    return this.lastTurnHookAt.get(agentId) ?? 0;
  }

  /** The stall rule on everything known: the beat's telemetry evidence plus
   *  the hooks' — and OFF for an agent that has produced neither a telemetry
   *  sample nor a single hook event, because such an agent cannot show a turn
   *  even when it takes one (see WORKER_WAKE_STALL_MS). */
  private isStalled(f: WorkerWakeFacts, now: number): boolean {
    const observable = !!f.hasTelemetry || this.hookSeenAt.has(f.agentId);
    if (!observable) return false;
    const lastActivityAt = Math.max(f.lastActivityAt ?? 0, this.turnHookAt(f.agentId));
    return isStalledWorker({ ...f, lastActivityAt }, now);
  }

  /** Forget per-agent state (e.g. the agent's PTY was closed). */
  forget(agentId: string, ptyId?: string): void {
    this.lastNudgeAt.delete(agentId);
    this.announcedInboxIds.delete(agentId);
    this.rendererClaims.delete(agentId);
    this.announcedResumeSeq.delete(agentId);
    this.lastHumanNeedsAt.delete(agentId);
    this.hookSeenAt.delete(agentId);
    this.lastTurnHookAt.delete(agentId);
    this.lastHoldReportAt.delete(agentId);
    this.lastPromptAt.delete(agentId);
    this.pendingAcks.delete(agentId);
    this.lastUnackedAt.delete(agentId);
    if (ptyId) this.spawnedAt.delete(ptyId);
  }

  /** Why this worker is held right now, or null when it should be nudged.
   *  The same checks decide() applies, in the same order, exposed so the beat
   *  can LOG why a worker with old pending mail is not being woken — the
   *  watchdog's silence used to be indistinguishable from "nothing to do".
   *  Pure: never touches the announcement / cooldown memory. */
  explain(f: WorkerWakeFacts, now = Date.now()): WorkerWakeHold | null {
    const inboxIds = liveInboxIds(f);
    // A launch RESUME still queued on the control channel is a wake reason of its
    // own (AEON-1784/1807), even with an empty inbox and even for god.
    const newResume = typeof f.pendingResumeSeq === 'number' && f.pendingResumeSeq > 0
      && this.announcedResumeSeq.get(f.agentId) !== f.pendingResumeSeq;
    if (inboxIds.size === 0 && !newResume) return 'no-mail';
    if (f.isGod && !newResume) return 'god';
    if (!f.ptyId) return 'no-pty';
    const claim = this.rendererClaims.get(f.agentId);
    if (claim && claim.until > now) return 'renderer-claim';
    if (f.autoDeliveryPaused) return 'delivery-paused';
    if (f.paused) return 'paused';
    if (f.halted) return 'halted';
    const stalled = this.isStalled(f, now);
    if (f.lastOutputAt <= 0 && !stalled) return 'booting'; // never produced output → still booting
    if (now - f.lastOutputAt < WORKER_WAKE_IDLE_MS && !stalled) return 'mid-turn';
    if ((f.terminalBlockedUntil ?? 0) > now) return 'draft'; // a human owns the prompt, stalled or not
    const spawned = this.spawnedAt.get(f.ptyId) ?? 0;
    if (spawned > 0 && now - spawned < WORKER_WAKE_BOOT_GRACE_MS) return 'boot-grace';
    const lastHuman = this.lastHumanNeedsAt.get(f.agentId) ?? 0;
    if (lastHuman > 0 && now - lastHuman < WORKER_WAKE_HITL_REARM_MS) return 'hitl';
    // Edge trigger (#358): mail already announced is not announced again — unless
    // the worker is stalled, i.e. it demonstrably never acted on the announcement.
    const announced = this.announcedInboxIds.get(f.agentId);
    if (!newResume && announced && !stalled && !Array.from(inboxIds).some((id) => !announced.has(id))) return 'announced';
    // A wake typed moments ago may still be answered; typing again now would
    // stack a second copy into the same input box.
    const pending = this.pendingAcks.get(f.agentId);
    if (!newResume && pending && now - pending.since < WORKER_WAKE_ACK_MS
      && !Array.from(inboxIds).some((id) => !pending.ids.has(id))) return 'awaiting-ack';
    const lastNudge = Math.max(this.lastNudgeAt.get(f.agentId) ?? 0, this.lastUnackedAt.get(f.agentId) ?? 0);
    if (lastNudge > 0 && now - lastNudge < WORKER_WAKE_COOLDOWN_MS) return 'cooldown';
    return null;
  }

  /** The worker ids that should be nudged right now, in stable registry order.
   *  Remembers when it attempted (the cooldown); only submitted() marks the
   *  content heard (the edge trigger), so a failed write stays eligible. */
  decide(facts: readonly WorkerWakeFacts[], now = Date.now()): string[] {
    this.releaseUnacked(now);
    const out: string[] = [];
    for (const f of facts) {
      const inboxIds = liveInboxIds(f);
      if (inboxIds.size === 0) {
        this.announcedInboxIds.delete(f.agentId);
      }
      if (this.explain(f, now) !== null) continue;
      if (this.rendererClaims.has(f.agentId)) this.rendererClaims.delete(f.agentId); // expired: explain() held a live one
      this.lastNudgeAt.set(f.agentId, now);
      out.push(f.agentId);
    }
    return out;
  }

  /** Record a wake that made it through both PTY writes (text + Enter). A failed
   *  write leaves the event eligible after the attempt cooldown.
   *
   *  The written Enter is not the CLI taking a turn, so for a worker whose hooks
   *  are live the ids are only announced once its UserPromptSubmit arrives at or
   *  after `since` (when the typing began); without one inside WORKER_WAKE_ACK_MS
   *  they are released (releaseUnacked). A worker that has never sent a hook
   *  cannot prove a prompt either way and is announced at once, as before: the
   *  #368 repeated-nudge loop otherwise comes back for every hook-less engine. */
  submitted(agentId: string, inboxIds: readonly string[], resumeSeq?: number | null, since?: number): void {
    if (typeof resumeSeq === 'number' && resumeSeq > 0) {
      this.announcedResumeSeq.set(agentId, resumeSeq);
      return;
    }
    const ids = new Set(inboxIds.filter((id) => typeof id === 'string' && id.length > 0));
    const typedAt = since ?? this.lastNudgeAt.get(agentId) ?? Date.now();
    if (!this.hookSeenAt.has(agentId) || (this.lastPromptAt.get(agentId) ?? 0) >= typedAt) {
      this.pendingAcks.delete(agentId);
      this.announcedInboxIds.set(agentId, ids);
      return;
    }
    this.pendingAcks.set(agentId, { ids, since: typedAt });
  }

  /** Release every wake whose UserPromptSubmit did not come within
   *  WORKER_WAKE_ACK_MS: its ids become unheard again (so the edge trigger allows
   *  a retry after the cooldown) and it is queued for takeUnacked(). */
  private releaseUnacked(now: number): void {
    for (const [agentId, pending] of this.pendingAcks) {
      if (now - pending.since < WORKER_WAKE_ACK_MS) continue;
      this.pendingAcks.delete(agentId);
      // From the end of the ack window, not from now: the first beat after a
      // long turn is often the first to look, and must not then wait a cooldown.
      this.lastUnackedAt.set(agentId, pending.since + WORKER_WAKE_ACK_MS);
      this.unacked.push({ agentId, ids: Array.from(pending.ids), typedAt: pending.since });
    }
  }

  /** Released unacknowledged wakes since the last call, for the beat to log. */
  takeUnacked(): UnackedWake[] {
    const out = this.unacked;
    this.unacked = [];
    return out;
  }

  /** Reserve a worker's currently unread ids for the fast renderer queue.
   *  A watchdog attempt has already reserved the prompt for its 140ms Enter
   *  delay; the renderer retries on its next flush instead of typing twice. */
  claimRendererInbox(agentId: string, inboxIds: readonly string[], now = Date.now()):
    { status: 'claimed'; token: number } | { status: 'busy' } | { status: 'delivered' } {
    const ids = Array.from(new Set(inboxIds.filter((id) => typeof id === 'string' && id.length > 0)));
    if (!ids.length) return { status: 'delivered' };
    this.releaseUnacked(now);
    const announced = this.announcedInboxIds.get(agentId);
    if (announced && ids.every((id) => announced.has(id))) return { status: 'delivered' };
    // Still waiting on the last typed wake, or just gave up on one: keep the
    // queued nudge and come back, rather than typing onto an unanswered draft.
    const pending = this.pendingAcks.get(agentId);
    if (pending && ids.every((id) => pending.ids.has(id))) return { status: 'busy' };
    const unackedAt = this.lastUnackedAt.get(agentId) ?? 0;
    if (unackedAt > 0 && now - unackedAt < WORKER_WAKE_COOLDOWN_MS) return { status: 'busy' };
    const claim = this.rendererClaims.get(agentId);
    if (claim && claim.until > now) return { status: 'busy' };
    if (claim) this.rendererClaims.delete(agentId);
    const lastMainAttempt = this.lastNudgeAt.get(agentId) ?? 0;
    if (lastMainAttempt > 0 && now - lastMainAttempt < 1_000) return { status: 'busy' };
    const token = this.nextRendererToken++;
    this.rendererClaims.set(agentId, { token, ids, since: now, until: now + 30_000 });
    return { status: 'claimed', token };
  }

  /** Commit only after the renderer confirms both PTY writes. A failed write
   *  releases the claim so the main beat can still wake the worker. */
  completeRendererInbox(agentId: string, token: number, sent: boolean, now = Date.now()): void {
    const claim = this.rendererClaims.get(agentId);
    if (!claim || claim.token !== token) return;
    this.rendererClaims.delete(agentId);
    if (sent && claim.until > now) this.submitted(agentId, claim.ids, null, claim.since);
  }

  /** True once per WORKER_WAKE_COOLDOWN_MS per worker — the beat's log gate. */
  shouldReportHold(agentId: string, now = Date.now()): boolean {
    const last = this.lastHoldReportAt.get(agentId) ?? 0;
    if (last > 0 && now - last < WORKER_WAKE_COOLDOWN_MS) return false;
    this.lastHoldReportAt.set(agentId, now);
    return true;
  }

  /** Last time this worker was nudged (0 = never) — useful for diagnostics. */
  lastNudge(agentId: string): number {
    return this.lastNudgeAt.get(agentId) ?? 0;
  }
}
