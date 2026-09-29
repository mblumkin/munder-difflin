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
  private rendererClaims = new Map<string, { token: number; ids: string[]; until: number }>();
  private nextRendererToken = 1;
  private announcedResumeSeq = new Map<string, number>();
  /** agentId → timestamp of the last needsHuman hook notification. */
  private lastHumanNeedsAt = new Map<string, number>();

  /** Record a PTY spawn so its boot sequence is left alone. */
  noteSpawn(ptyId: string, at = Date.now()): void {
    this.spawnedAt.set(ptyId, at);
  }

  /** Feed hook events (from HookServer) so a HITL prompt blocks nudges. */
  noteHook(agentId: string | undefined, event: string | undefined, message: string | undefined, at = Date.now()): void {
    if (!agentId) return;
    if (classifyHook(event, message) === 'needsHuman') this.lastHumanNeedsAt.set(agentId, at);
  }

  /** Forget per-agent state (e.g. the agent's PTY was closed). */
  forget(agentId: string, ptyId?: string): void {
    this.lastNudgeAt.delete(agentId);
    this.announcedInboxIds.delete(agentId);
    this.rendererClaims.delete(agentId);
    this.announcedResumeSeq.delete(agentId);
    this.lastHumanNeedsAt.delete(agentId);
    if (ptyId) this.spawnedAt.delete(ptyId);
  }

  /** The worker ids that should be nudged right now, in stable registry order.
   *  An attempt starts cooldown, but only submitted() marks its content heard. */
  decide(facts: readonly WorkerWakeFacts[], now = Date.now()): string[] {
    const out: string[] = [];
    for (const f of facts) {
      const inboxIds = new Set(f.inboxIds.filter((id) => typeof id === 'string' && id.length > 0));
      if (inboxIds.size === 0) {
        // A fully drained inbox starts a fresh announcement cycle and bounds the
        // remembered set even for a worker that lives for months.
        this.announcedInboxIds.delete(f.agentId);
      }
      const newResume = typeof f.pendingResumeSeq === 'number' && f.pendingResumeSeq > 0
        && this.announcedResumeSeq.get(f.agentId) !== f.pendingResumeSeq;
      const announced = this.announcedInboxIds.get(f.agentId);
      const newInbox = inboxIds.size > 0 && (!announced || Array.from(inboxIds).some((id) => !announced.has(id)));
      if (!newResume && !newInbox) continue;
      const rendererClaim = this.rendererClaims.get(f.agentId);
      if (rendererClaim && rendererClaim.until > now) continue;
      if (rendererClaim) this.rendererClaims.delete(f.agentId);
      if ((f.isGod && !newResume) || !f.ptyId) continue;
      if (f.autoDeliveryPaused || f.paused || f.halted) continue;
      if (f.lastOutputAt <= 0) continue; // never produced output → still booting
      if (now - f.lastOutputAt < WORKER_WAKE_IDLE_MS) continue; // mid-turn
      if ((f.terminalBlockedUntil ?? 0) > now) continue; // human owns the prompt
      const spawned = this.spawnedAt.get(f.ptyId) ?? 0;
      if (spawned > 0 && now - spawned < WORKER_WAKE_BOOT_GRACE_MS) continue;
      const lastHuman = this.lastHumanNeedsAt.get(f.agentId) ?? 0;
      if (lastHuman > 0 && now - lastHuman < WORKER_WAKE_HITL_REARM_MS) continue;
      const lastNudge = this.lastNudgeAt.get(f.agentId) ?? 0;
      if (lastNudge > 0 && now - lastNudge < WORKER_WAKE_COOLDOWN_MS) continue;
      this.lastNudgeAt.set(f.agentId, now);
      out.push(f.agentId);
    }
    return out;
  }

  /** Commit the exact wake that made it through both PTY writes (text + Enter).
   *  A failed write leaves the event eligible after the attempt cooldown. */
  submitted(agentId: string, inboxIds: readonly string[], resumeSeq?: number | null): void {
    if (typeof resumeSeq === 'number' && resumeSeq > 0) {
      this.announcedResumeSeq.set(agentId, resumeSeq);
    } else {
      this.announcedInboxIds.set(agentId, new Set(inboxIds.filter((id) => typeof id === 'string' && id.length > 0)));
    }
  }

  /** Reserve a worker's currently unread ids for the fast renderer queue.
   *  A watchdog attempt has already reserved the prompt for its 140ms Enter
   *  delay; the renderer retries on its next flush instead of typing twice. */
  claimRendererInbox(agentId: string, inboxIds: readonly string[], now = Date.now()):
    { status: 'claimed'; token: number } | { status: 'busy' } | { status: 'delivered' } {
    const ids = Array.from(new Set(inboxIds.filter((id) => typeof id === 'string' && id.length > 0)));
    if (!ids.length) return { status: 'delivered' };
    const announced = this.announcedInboxIds.get(agentId);
    if (announced && ids.every((id) => announced.has(id))) return { status: 'delivered' };
    const claim = this.rendererClaims.get(agentId);
    if (claim && claim.until > now) return { status: 'busy' };
    if (claim) this.rendererClaims.delete(agentId);
    const lastMainAttempt = this.lastNudgeAt.get(agentId) ?? 0;
    if (lastMainAttempt > 0 && now - lastMainAttempt < 1_000) return { status: 'busy' };
    const token = this.nextRendererToken++;
    this.rendererClaims.set(agentId, { token, ids, until: now + 30_000 });
    return { status: 'claimed', token };
  }

  /** Commit only after the renderer confirms both PTY writes. A failed write
   *  releases the claim so the main beat can still wake the worker. */
  completeRendererInbox(agentId: string, token: number, sent: boolean, now = Date.now()): void {
    const claim = this.rendererClaims.get(agentId);
    if (!claim || claim.token !== token) return;
    this.rendererClaims.delete(agentId);
    if (sent && claim.until > now) this.submitted(agentId, claim.ids);
  }

  /** Last time this worker was nudged (0 = never) — useful for diagnostics. */
  lastNudge(agentId: string): number {
    return this.lastNudgeAt.get(agentId) ?? 0;
  }
}
