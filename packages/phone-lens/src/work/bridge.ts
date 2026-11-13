import { randomUUID } from "node:crypto";
import { readdir, stat as fsStat, open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { WebSocket } from "ws";
import type { AppSettingsStore } from "../store/settings.js";
import type { WorkClientMessage, WorkServerMessage, WorkCommandInfo, WorkDeviceRow, WorkMentionFile, WorkMentionSession, WorkSessionSummary, WorkQuestionItem, WorkStreamFrame } from "../types.js";

/**
 * 「工作(Beta)」bridge: mirrors dsh sessions to the phone over /ws/work and
 * relays remote control back into the host — in-process, straight through the
 * host's own sessionController (the desktop profile mounts the API controllers
 * even though the HTTP /api bridge itself is web-profile-only).
 *
 * SAFETY MODEL (the reason this class exists in this shape):
 * - Everything is gated behind AppSettings.workBetaEnabled (default FALSE).
 *   While off, no host event is subscribed and /ws/work refuses upgrades —
 *   testing code can never lean on the camera receiver's main paths.
 * - Every host-API touch is defensive: the exact sessionController surface is
 *   host-version-dependent, so calls are try/caught, replies degrade into
 *   work_ack{ok:false} and a one-time probe dump lands in the log for
 *   calibration instead of ever throwing into the host.
 * - No approval waterfall is tapped in this phase: approvals are mirrored
 *   read-only (durable approval/asked|decided events), the desktop keeps
 *   answering them — the host's main approval chain stays untouched.
 */

interface WorkClient {
  ws: WebSocket;
  /** The session this client mirrors; null = only global traffic. */
  sessionId: string | null;
  lastSeenAt: number;
  /** Paired device id (devices.json key, from the upgrade's auth record);
   *  "" for loopback debug links without a record. */
  deviceId: string;
  /** Attach-time snapshot of the paired name — a web-side rename shows up on
   *  the next reconnect (lane-08 P6: accepted). */
  deviceName: string;
}

/**
 * Filter out prompt-injection and context events (runtime-context, time-context,
 * skill-catalog, system/developer prompts, model-selection notices, etc.).
 * Dropped both at snapshot delivery and live echo to save bandwidth and keep
 * the phone timeline focused strictly on human/agent dialogue and tool results.
 */
function isContextInjectionEvent(ev: any): boolean {
  if (!ev || typeof ev !== "object") return false;
  const type = ev.type;
  if (type === "system/message" || type === "developer/message") return true;
  if (type === "user/message") {
    const data = ev.data ?? ev.message ?? ev;
    const msg = data.message ?? data;
    const source = msg?.source ?? data?.source;
    if (source && typeof source === "object") {
      const kind = source.kind;
      if (kind && kind !== "user") {
        return true;
      }
    }
  }
  return false;
}

function filterEvents(events: any[]): any[] {
  if (!Array.isArray(events)) return [];
  return events.filter(e => !isContextInjectionEvent(e));
}

/**
 * First-party command identities + their zh/en spellings (mirrors the host's
 * dsh-commands builtin table). The HOST's execute() only resolves canonical
 * lowercase names — alias resolution is a CLIENT concern (the desktop web UI
 * ships its own copy), so the phone bridge carries one too: a `/压缩` typed on
 * the phone must select the same command as on the desktop.
 */
const BUILTIN_COMMAND_TOKENS: Array<{ pkg: string; en: string; zh: string }> = [
  { pkg: "@deepseek-ai/dsh-command-goal", en: "goal", zh: "目标" },
  { pkg: "@deepseek-ai/dsh-plan-mode", en: "plan", zh: "计划" },
  { pkg: "@deepseek-ai/dsh-command-feedback", en: "feedback", zh: "反馈" },
  { pkg: "@deepseek-ai/dsh-command-compact", en: "compact", zh: "压缩" },
  { pkg: "@deepseek-ai/dsh-permission-presets", en: "permission", zh: "权限" },
  { pkg: "@deepseek-ai/dsh-session-log-export", en: "export", zh: "导出" },
];

/** Extra spellings (en+zh) selecting a first-party definition, for the phone UI. */
function commandAliases(descriptor: any): string[] {
  const id = descriptor?.definitionId;
  if (typeof id !== "string") return [];
  const hit = BUILTIN_COMMAND_TOKENS.find((c) => c.pkg === id);
  return hit ? [hit.en, hit.zh] : [];
}

/**
 * Resolve a typed token (canonical name, zh or en alias) against the agent's
 * effective catalog — exact scoped names win, aliases only select their
 * first-party definition (same precedence as the host's resolveCommand).
 */
function resolveCommandToken(token: string, descriptors: any[]): any | undefined {
  const lower = token.toLowerCase();
  const exact = descriptors.find((d) => typeof d?.name === "string" && d.name === lower);
  if (exact) return exact;
  const hit = BUILTIN_COMMAND_TOKENS.find((c) => c.en === lower || c.zh === token);
  if (!hit) return undefined;
  return descriptors.find((d) => d?.definitionId === hit.pkg);
}

/** Static fallback directory when the host exposes no CommandRuntime service
 *  (still names the six first-party commands so the phone UI stays usable). */
const FALLBACK_COMMANDS: WorkCommandInfo[] = BUILTIN_COMMAND_TOKENS.map((c) => ({
  name: c.en,
  aliases: [c.en, c.zh],
}));

/**
 * Events we tap. Verified against dsh-agent 0.2.x runtime-types: the LIVE
 * event surface is the agent layer (durable session events do NOT hit the
 * cordis bus). Waterfall events (approval/request etc.) are DELIBERATELY
 * absent — the desktop keeps answering approvals, we only poll state() for
 * pendingInput visibility.
 */
const TAPPED_EVENTS = [
  "agent/created",
  "agent/disposed",
  "agent/status",
  "agent/inbox/inserted",
  "agent/assistant-stream",
  "agent/error",
] as const;

/**
 * Tool-layer live taps, registered SEPARATELY from TAPPED_EVENTS because
 * both carry two handler parameters. Verified against dsh-tools
 * events.ts/docs (tools.md event catalog):
 * - `tools/pre-execute` (waterfall): (exec, next) — we observe and MUST
 *   return next() to keep dispatching; a plugin-level listener sees every
 *   agent's calls (same posture as the master-switch tap in index.ts).
 * - `tools/result` (plain emit): (exec, result), frozen & lossless-JSON;
 *   listener failures are contained by the tools service.
 *
 * Why: durable tool/call|tool/result events never hit the cordis bus, so a
 * running turn used to show NO tool rows on the phone until it ended (tail
 * refresh on running:false). The phone already renders the durable shapes —
 * we forward these as seq:-1 session_events in exactly those shapes.
 */
const TOOL_RESULT_EVENT = "tools/result";
const TOOL_PRE_EVENT = "tools/pre-execute";

/** Extract the session id from an agent payload defensively. */
function agentSessionId(agent: any): string | null {
  const sid = agent?.session?.sessionId ?? agent?.session?.id ?? agent?.sessionId;
  return typeof sid === "string" && sid ? sid : null;
}

const APPROVAL_POLL_MS = 5_000;

/**
 * Mock mode (dev.js smoke tests only, gated by LENS_MOCK_WORK=1): serves
 * fabricated sessions/events/streams so the phone UI can be exercised end to
 * end without a live dsh host. Never active in production — the env var is
 * only ever set by the standalone dev receiver.
 */
const MOCK = process.env.LENS_MOCK_WORK === "1";

const CLIENT_SILENCE_MS = 90_000; // phone pings every 10s; 90s of nothing = half-open
const SESSION_LIST_DEBOUNCE_MS = 300;

/**
 * UI-presence freshness for the work_devices list (contract frame 1): 25s =
 * 2.5× the app's 10s ping, same doctrine as hub.ts OFFLINE_SILENCE_MS — ONE
 * lost ping (worst-case inbound gap 20s) must never trip it. The judged value
 * is WorkClient.lastSeenAt (the per-frame heartbeat on THIS connection table,
 * NOT the devices.json field of the same name). The three existing parameters
 * keep their own jobs (recheck-6): hub.ts 25s = camera preview UI, the app's
 * 30s _halfOpenAfter = app-side self-heal, and CLIENT_SILENCE_MS above still
 * owns the actual eviction — this constant only corrects the UI semantics.
 */
const PRESENCE_FRESH_MS = 25_000;

export class WorkBridge {
  private clients = new Set<WorkClient>();
  private wired = false;
  private disposers: Array<() => void> = [];
  /** sessionController service (lazily probed; null = not available yet). */
  private sc: any = null;
  /** Which service name the probe resolved the controller under. */
  private scServiceName: string | null = null;
  private probeLogged = false;
  /** sessionId → (approvalId → meta) mirror of pending approvals. */
  private pendingApprovals = new Map<string, Map<string, { toolName?: string; reason?: string }>>();
  /**
   * Interactive requests (approval / question) waiting on the phone leg, by
   * request id. The waterfall answerer HOLDS its promise until either the
   * phone answers, the desktop's remote answerer (raced via next()) settles,
   * or the fallback timer fires. First valid answer wins; the loser's card is
   * torn down by an approval_resolved broadcast — a late tap on a torn-down
   * card resolves nothing (AGENTS.md #22 semantics, user-confirmed).
   */
  private pendingInteractions = new Map<
    string,
    {
      sessionId: string;
      kind: "approval" | "question";
      frame: WorkServerMessage;
      phoneSettle: (value: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
      /** Set when the phone leg's 5-min hold expired: a late answer can no
       *  longer win the race and must be rejected, not ack-true'd into a dead
       *  end whose approval_resolved would never come (recheck-1 §5). */
      timedOut?: boolean;
    }
  >();
  /** sessionId → working directory (learned from readSession / snapshots). */
  private cwdCache = new Map<string, string>();
  private sessionListTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serialized device rows of the last work_devices broadcast (flip detect —
   *  the 10s presence timer only broadcasts on an actual change). */
  private lastDevicesSnapshot = "";
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-session text-delta micro-batch (lane-07 P3): chunk frames carry
   *  ~150-200B of envelope for a few bytes of payload; a 40ms batch cuts the
   *  frame count 5-20×. start/end/non-text frames flush and pass through. */
  private streamBatches = new Map<string, { frame: WorkStreamFrame; timer: ReturnType<typeof setTimeout> }>();
  /** When awaitController last exhausted its probe loop: probe retry is then
   *  cached for CONTROLLER_PROBE_TTL_MS instead of re-spinning a full 5s loop
   *  on every poll/list against a host that simply lacks the controller. */
  private controllerProbeFailedAt = 0;

  constructor(
    private readonly ctx: any,
    private readonly settings: AppSettingsStore,
    private readonly log: (level: "info" | "warn" | "error", msg: string) => void,
    private readonly version: () => string,
  ) {}

  enabled(): boolean {
    // mock mode is dev.js-only: always on, no settings fiddling needed
    return MOCK || this.settings.get().workBetaEnabled === true;
  }

  dispose(): void {
    this.teardown();
    // mock streams are dev-only, but a repeated enable/disable cycle in the
    // standalone dev receiver used to leak their intervals
    for (const t of this.mockStreams.values()) clearInterval(t);
    this.mockStreams.clear();
    for (const c of this.clients) {
      try {
        c.ws.close(1000, "server-dispose");
      } catch {}
    }
    this.clients.clear();
    if (this.sessionListTimer) clearTimeout(this.sessionListTimer);
    this.sessionListTimer = null;
    // belt & braces: teardown() already cleared these, but dispose must not
    // depend on that ordering (presence interval leaks pile up on plugin
    // reload — the http.ts heartbeat lesson)
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
  }

  // ── switch wiring ───────────────────────────────────────────────────────────

  /**
   * React to the settings switch. Turning OFF tears the taps down and closes
   * every work client — nothing keeps listening on the host side.
   */
  setEnabled(on: boolean): void {
    if (on) {
      this.ensureWiring();
      // a client that connected while disabled was refused at the upgrade; but
      // an early-connected client (race) gets its hello now
      for (const c of this.clients) this.sendHello(c);
      return;
    }
    this.teardown();
    for (const c of [...this.clients]) {
      try {
        c.ws.close(4003, "work-beta-disabled");
      } catch {}
    }
    this.clients.clear();
    this.log("info", "work beta disabled — taps removed, clients closed");
  }

  // ── client lifecycle (called from the http upgrade path) ───────────────────

  /**
   * Attach one work client. `device` carries the upgrade's authenticated
   * record ({deviceId, name}) — the http upgrade side owns passing it (same
   * posture as the camera channel's hub.attachCamera); loopback debug links
   * pass undefined and fall back to the placeholder identity below.
   */
  attachClient(ws: WebSocket, device?: { deviceId: string; name: string }): void {
    if (!this.enabled()) {
      try {
        ws.close(4003, "work-beta-disabled");
      } catch {}
      return;
    }
    const client: WorkClient = {
      ws,
      sessionId: null,
      lastSeenAt: Date.now(),
      deviceId: device?.deviceId ?? "",
      deviceName: device?.name ?? "本机调试",
    };
    this.clients.add(client);
    this.ensureWiring();
    ws.on("close", () => {
      this.clients.delete(client);
      this.pushDeviceList();
    });
    ws.on("error", (err: unknown) => {
      // ws contract (same as camera/view): an unhandled error emission throws
      this.log("warn", `work ws error: ${String(err)}`);
    });
    ws.on("pong", () => {
      client.lastSeenAt = Date.now();
    });
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      client.lastSeenAt = Date.now();
      if (isBinary) return;
      let msg: WorkClientMessage | null = null;
      try {
        msg = JSON.parse(data.toString("utf8")) as WorkClientMessage;
      } catch {
        return;
      }
      this.onClientMessage(client, msg);
    });
    this.sendHello(client);
    void this.pushSessionList();
    this.pushDeviceList();
    this.log("info", `work client attached (${this.clients.size} online)`);
  }

  /** Called from the shared 20s heartbeat: evict silent clients. */
  pingAll(): void {
    const now = Date.now();
    for (const c of [...this.clients]) {
      if (c.ws.readyState !== c.ws.OPEN) continue;
      if (now - c.lastSeenAt > CLIENT_SILENCE_MS) {
        this.log("warn", "work client silent — terminating (half-open guard)");
        try {
          c.ws.terminate();
        } catch {}
        this.clients.delete(c);
        continue;
      }
      try {
        c.ws.ping();
      } catch {}
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  // ── device presence (contract frame 1: work_devices) ────────────────────────

  /** Device rows for the work_devices broadcast: deduped per deviceId (a
   *  half-open stale connection plus its reconnect can coexist briefly — the
   *  freshest heartbeat wins), online = ws OPEN + lastSeenAt fresh. */
  private snapshotDevices(): WorkDeviceRow[] {
    const now = Date.now();
    const byDevice = new Map<string, WorkClient>();
    for (const c of this.clients) {
      const prev = byDevice.get(c.deviceId);
      if (!prev || c.lastSeenAt > prev.lastSeenAt) byDevice.set(c.deviceId, c);
    }
    const rows: WorkDeviceRow[] = [];
    for (const c of byDevice.values()) {
      rows.push({
        deviceId: c.deviceId,
        name: c.deviceName,
        deviceName: c.deviceName,
        sessionId: c.sessionId,
        cwd: c.sessionId ? (this.cwdCache.get(c.sessionId) ?? null) : null,
        online: c.ws.readyState === c.ws.OPEN && now - c.lastSeenAt < PRESENCE_FRESH_MS,
        lastSeenAt: c.lastSeenAt,
      });
    }
    return rows;
  }

  /** Broadcast the device list, flip-driven: an unchanged snapshot sends
   *  nothing (the 10s presence timer recomputes; attach/close/subscribe push
   *  eagerly). The phone consumes it for the device card; a frozen link goes
   *  online:false but STAYS in the list until the 90s eviction removes it. */
  private pushDeviceList(): void {
    let snap: string;
    try {
      snap = JSON.stringify(this.snapshotDevices());
    } catch {
      return;
    }
    if (snap === this.lastDevicesSnapshot) return;
    this.lastDevicesSnapshot = snap;
    this.broadcast({ type: "work_devices", devices: JSON.parse(snap) } satisfies WorkServerMessage);
  }

  // ── host-side wiring ────────────────────────────────────────────────────────

  /**
   * Subscribe to host events + grab the sessionController. Idempotent, lazy:
   * nothing here runs while the beta switch is off.
   */
  private ensureWiring(): void {
    if (this.wired) return;
    this.wired = true;
    const ctx = this.ctx;
    // probe the host surface once (calibration log — one line, bounded)
    if (!this.probeLogged) {
      this.probeLogged = true;
      try {
        const keys = Object.keys(ctx).filter((k) => typeof ctx[k] !== "function" || ["sessionController", "sessionQuery", "workspaceFiles", "agents", "sessions", "approval"].includes(k));
        this.log("info", `work probe: ctx services = ${keys.join(",")}`);
      } catch {}
    }
    // sessionController: direct property read (same posture as ctx.tools —
    // imperative ctx.inject never fires on cordis 4.0.2). May mount later than
    // us: re-probe on demand from the request handlers.
    this.probeSessionController();
    const on = (name: string, handler: (payload: unknown) => void) => {
      try {
        const d = ctx.on?.(name, (payload: unknown) => {
          if (!this.enabled()) return;
          try {
            handler(payload);
          } catch (error) {
            this.log("warn", `work tap ${name} handler failed: ${String(error)}`);
          }
          // sync undefined return: never participate in any waterfall
        });
        if (typeof d === "function") this.disposers.push(d);
      } catch (error) {
        this.log("warn", `work tap ${name} unavailable: ${String(error)}`);
      }
    };
    for (const name of TAPPED_EVENTS) {
      on(name, (payload) => this.routeHostEvent(name, payload));
    }
    // tool-call live visibility (see TOOL_*_EVENT docs above)
    try {
      const dPre = ctx.on?.(TOOL_PRE_EVENT, (exec: any, next: () => unknown) => {
        if (this.enabled()) {
          try {
            const sid = agentSessionId(exec?.agent);
            if (sid) {
              this.forward(sid, {
                type: "session_event",
                sessionId: sid,
                event: { type: "tool/call", seq: -1, time: Date.now(), data: { callId: exec.callId, name: exec.name, arguments: exec.arguments } },
              });
            }
          } catch {}
        }
        // waterfall: observe-and-pass, never participate
        return next();
      });
      if (typeof dPre === "function") this.disposers.push(dPre);
    } catch (error) {
      this.log("warn", `work tap ${TOOL_PRE_EVENT} unavailable: ${String(error)}`);
    }
    try {
      const dRes = ctx.on?.(TOOL_RESULT_EVENT, (exec: any, result: any) => {
        if (!this.enabled()) return;
        try {
          const sid = agentSessionId(exec?.agent);
          if (!sid) return;
          const failed = result?.isError === true;
          this.forward(sid, {
            type: "session_event",
            sessionId: sid,
            event: {
              type: "tool/result",
              seq: -1,
              time: Date.now(),
              data: {
                callId: exec.callId,
                // durable tool/result shape: the pairing id rides inside the
                // result message (source.callId == toolCallId == exec.callId)
                message: {
                  role: "tool",
                  source: { kind: "tool", callId: exec.callId },
                  toolCallId: exec.callId,
                  content: Array.isArray(result?.content) ? result.content : [],
                  isError: failed,
                },
                ...(failed ? { error: result.error } : {}),
              },
            },
          });
        } catch {}
      });
      if (typeof dRes === "function") this.disposers.push(dRes);
    } catch (error) {
      this.log("warn", `work tap ${TOOL_RESULT_EVENT} unavailable: ${String(error)}`);
    }
    // slash-command registry changed (plugin registered/removed one): tell the
    // phones to drop their cached command directory (same signal the desktop
    // web UI subscribes to for its CommandDirectory invalidation)
    on("commands/change", () => {
      for (const c of this.clients) this.sendTo(c, { type: "commands_changed" } satisfies WorkServerMessage);
    });
    // desktop-side archive/unarchive must fold into the phone's list too
    // (plain parallel events, no waterfall participation)
    on("workspace/session-archived", () => this.scheduleSessionListRefresh());
    on("workspace/session-unarchiving", (payload: unknown) => {
      this.scheduleSessionListRefresh();
      // contract frame 2: a phone sitting in the chat keeps a stale archived
      // banner until told the session is writable again. The tap payload
      // shape is build-dependent (lane-02 §5.2) — forward only when a
      // sessionId survives the defensive probe; otherwise the phone-side
      // list diff stays the only recovery path.
      const sid = this.sessionIdFromTapPayload(payload);
      if (sid) {
        this.forward(sid, { type: "session_unarchived", sessionId: sid } satisfies WorkServerMessage);
      } else {
        this.logOnce("workspace/session-unarchiving tap carried no usable sessionId — banner clear relies on the phone-side list diff");
      }
    });
    // pending-approval visibility: durable approval events don't hit the live
    // bus either, so poll state() for the subscribed sessions (cheap, and the
    // ONLY signal besides agent/status — the desktop still answers approvals)
    const poll = setInterval(() => void this.pollPendingInput(), APPROVAL_POLL_MS);
    this.disposers.push(() => clearInterval(poll));
    // ── interactive answerers (Beta phase 2) ────────────────────────────────
    // UNLIKE TAPPED_EVENTS these MUST participate in their waterfalls: we hold
    // the request while racing the phone against the desktop's remote
    // answerer (next()). First valid answer wins; the other end gets
    // approval_resolved and tears its card down. No subscriber for the
    // session → don't compete, pass straight through (headless fail-closed
    // semantics stay untouched).
    for (const evt of ["approval/request", "user-questions/request"] as const) {
      try {
        const kind: "approval" | "question" = evt === "approval/request" ? "approval" : "question";
        // prepend is load-bearing: the host's built-in remote bridge
        // registers a HOLD-type answerer for these two events at boot (it
        // parks the request until the desktop web UI answers), and waterfall
        // dispatches in registration order — appended listeners sit BEHIND
        // that hold and are never reached while a desktop UI is attached.
        // Chain-head or nothing; transparent next() when no phone watches.
        const d = ctx.on?.(evt, (req: any, next: () => unknown) => this.raceInteraction(kind, req, next), { prepend: true });
        if (typeof d === "function") this.disposers.push(d);
        this.log("info", `work answerer armed: ${evt} (prepend)`);
      } catch (error) {
        this.log("warn", `work tap ${evt} unavailable: ${String(error)}`);
      }
    }
    this.log("info", `work beta wired (${TAPPED_EVENTS.join(", ")})`);
    // device presence heartbeat: recompute every 10s, broadcast only on a
    // flip (freeze→offline / thaw→online lands within one tick). Cleared in
    // teardown() — an interval leaked across enable cycles would pile up like
    // the http.ts heartbeat timer once did.
    if (!this.presenceTimer) {
      this.presenceTimer = setInterval(() => {
        if (!this.enabled() || this.clients.size === 0) return;
        this.pushDeviceList();
      }, 10_000);
      if (typeof this.presenceTimer.unref === "function") this.presenceTimer.unref();
    }
  }

  /** Defensive sessionId extraction from workspace tap payloads (shape
   *  unverified on this host build — lane-02 §5.2). */
  private sessionIdFromTapPayload(payload: unknown): string | null {
    const p = payload as Record<string, any> | null | undefined;
    if (!p || typeof p !== "object") return null;
    for (const c of [p.sessionId, p.session?.sessionId, p.session?.id, p.id]) {
      if (typeof c === "string" && c) return c;
    }
    return null;
  }

  /** Poll state() for every subscribed session → approval_state mirrors. */
  private async pollPendingInput(): Promise<void> {
    if (!this.enabled() || this.clients.size === 0) return;
    const sc = await this.awaitController();
    if (!sc || typeof sc.state !== "function") return;
    const sids = new Set<string>();
    for (const c of this.clients) if (c.sessionId) sids.add(c.sessionId);
    // mirrors of sessions nobody subscribes anymore are unreachable by this
    // poll (their approval_state has no audience) and would keep stale state
    // forever — drop them (archive / unsubscribe hygiene, H16)
    for (const sid of [...this.pendingApprovals.keys()]) {
      if (!sids.has(sid)) this.pendingApprovals.delete(sid);
    }
    for (const sessionId of sids) {
      try {
        const st = (await sc.state({ sessionId }, AbortSignal.timeout(8_000))) as Record<string, any>;
        const pending = Array.isArray(st?.pendingInput) ? st.pendingInput : [];
        const per = this.pendingApprovals.get(sessionId);
        if (pending.length === 0) {
          if (per) {
            this.pendingApprovals.delete(sessionId);
            this.pushApprovalState(sessionId);
          }
          continue;
        }
        // Rebuild the mirror from the CURRENT pendingInput on EVERY poll: the
        // desktop may answer one of several cards (pending 2 → 1) or a kind
        // may change — both used to fall between the "empty → non-empty" and
        // "non-empty → empty" branches, and the phone kept stale cards until
        // ALL pending cleared (it replaces its approval list wholesale).
        const map = new Map<string, { toolName?: string; reason?: string }>();
        for (const kind of pending) {
          const key = String(kind);
          // preserve richer metadata a previous mirror may have learned
          map.set(key, per?.get(key) ?? { reason: key });
        }
        const changed =
          !per || per.size !== map.size || [...map.keys()].some((k) => !per.has(k));
        this.pendingApprovals.set(sessionId, map);
        if (changed) this.pushApprovalState(sessionId);
      } catch {
        // session gone / cold — the next poll retries
      }
    }
  }

  // ── interactive requests: race phone vs desktop ─────────────────────────────

  /** Any phone currently subscribed to this session (only those get cards). */
  private hasSubscriber(sessionId: string): boolean {
    for (const c of this.clients) if (c.sessionId === sessionId) return true;
    return false;
  }

  /**
   * The phone-leg answer surface: hold until `answerInteraction` resolves it,
   * the desktop leg (raced via next()) settles first, or 5 minutes pass —
   * a phone must never be the reason a turn hangs forever.
   */
  private static INTERACTION_TIMEOUT_MS = 300_000;

  /** Snapshot baseline split threshold (recheck-4 §3.2): slices on EVENT
   *  boundaries into several session_snapshot frames (App merge-by-seq is
   *  idempotent); a single oversized event is never byte-cut. */
  private static SNAPSHOT_CHUNK_BYTES = 8 * 1024 * 1024;

  /** text-delta micro-batch window (lane-07 P3: 30-50ms recommended). */
  private static STREAM_BATCH_MS = 40;

  /** awaitController probe-failure cache TTL (H16). */
  private static CONTROLLER_PROBE_TTL_MS = 30_000;

  private raceInteraction(kind: "approval" | "question", req: any, next: () => unknown): Promise<unknown> {
    if (!this.enabled()) {
      this.log("info", `race ${kind} skip: disabled`);
      return Promise.resolve(next());
    }
    const sessionId = agentSessionId(req?.agent) ?? "";
    // no phone watching this session: stay transparent (desktop answers or
    // the waterfall fails closed — never our call)
    if (!sessionId || !this.hasSubscriber(sessionId)) {
      this.log("info", `race ${kind} skip: sid=${sessionId || "(none)"} clients=${this.clients.size}`);
      return Promise.resolve(next());
    }
    const id = `wi-${randomUUID()}`;
    const frame = this.buildInteractionFrame(kind, sessionId, id, req);
    if (!frame) {
      this.log("info", `race ${kind} skip: frame null keys=[${Object.keys(req ?? {}).join(",")}]`);
      return Promise.resolve(next()); // unusable payload — let the desktop deal with it
    }

    // start the desktop leg FIRST (synchronously enter the chain), then race
    let desktop: Promise<unknown>;
    try {
      desktop = Promise.resolve(next());
    } catch (error) {
      desktop = Promise.resolve("unavailable");
    }
    desktop = desktop.catch(() => "unavailable");

    const raced = new Promise<unknown>((resolve) => {
      let settled = false;
      this.log("info", `race ${kind} enter sid=${sessionId.slice(0, 12)} id=${id}`);
      const finish = (outcome: unknown, extra: "phone" | "desktop") => {
        if (settled) return;
        settled = true;
        this.log("info", `race ${kind} settled via ${extra} outcome=${typeof outcome === "string" ? outcome : "answers"}`);
        clearTimeout(timer);
        this.pendingInteractions.delete(id);
        // lane-01 R5: cards ride forward(sessionId) — resolve notices follow
        // the same route instead of spamming every other session's phones
        // (their App filters the frame out anyway; pure dead bytes).
        this.forward(sessionId, {
          type: "approval_resolved",
          sessionId,
          id,
          ...(typeof outcome === "string" ? { outcome } : outcome && typeof outcome === "object" ? { outcome: "answered" } : {}),
        } satisfies WorkServerMessage);
        if (extra === "phone") this.settleDesktopRemoteLeg(kind, req, outcome);
        resolve(outcome);
      };
      const entry: {
        sessionId: string;
        kind: "approval" | "question";
        frame: WorkServerMessage;
        phoneSettle: (value: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
        timedOut?: boolean;
      } = {
        sessionId,
        kind,
        frame,
        phoneSettle: () => {},
        timer: null as unknown as ReturnType<typeof setTimeout>,
      };
      // phone leg: resolves with a VALID answer (set by answerInteraction) or
      // null (timeout). Must never hold dispose open.
      const timer = setTimeout(() => {
        // mark the entry BEFORE settling: a late answer racing this timeout
        // must be rejected instead of ack-true'd into a dead end (H13)
        entry.timedOut = true;
        entry.phoneSettle(null);
      }, WorkBridge.INTERACTION_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
      entry.timer = timer;
      this.pendingInteractions.set(id, entry);
      const phoneP = new Promise<{ value: unknown; from: "phone" }>((resolvePhone) => {
        entry.phoneSettle = (value: unknown) => resolvePhone({ value, from: "phone" });
      });
      const desktopP = desktop.then((value) => ({ value, from: "desktop" as const }));
      void Promise.race([phoneP, desktopP]).then(async (first) => {
        if (first.from === "phone") {
          if (first.value == null) {
            // phone leg timed out without an answer: stop competing, let the
            // desktop (or the waterfall's fail-closed tail) settle it
            finish(await desktop, "desktop");
          } else {
            finish(first.value, "phone");
          }
        } else {
          finish(first.value, "desktop");
        }
      });
      // announce the card after the race is armed so an instant phone answer
      // can never fall through the cracks
      this.forward(sessionId, frame);
    });
    // lane-10 L3: state().pendingInput only ever carries the bare kind string
    // (host maps getPendingRemoteEvents → "approval"/"question"/"other"), so
    // without this seed the phone's kind-only fallback bar can never show the
    // tool name. pollPendingInput preserves richer metadata across rebuilds.
    // Runs after the executor (the entry is in pendingInteractions by now, so
    // the pushed interactionIds include this card).
    if (kind === "approval") {
      try {
        const cardToolName = (frame as Extract<WorkServerMessage, { type: "approval_request" }>).toolName;
        if (typeof cardToolName === "string" && cardToolName) {
          const per = this.pendingApprovals.get(sessionId) ?? new Map<string, { toolName?: string; reason?: string }>();
          per.set(kind, { ...(per.get(kind) ?? {}), toolName: cardToolName });
          this.pendingApprovals.set(sessionId, per);
          this.pushApprovalState(sessionId);
        }
      } catch {}
    }
    return raced;
  }

  /**
   * Phone won the race → settle the remote bridge's pending waterfall so the
   * gateway pushes cancel frames to every desktop window (card tears down
   * immediately). A desktop click AFTER this is dropped idempotently by the
   * gateway (pending already removed from its map). Uses internal gateway
   * members (pendingRemoteEvents / settleRemoteEvent) — capability-probed,
   * failure just means the desktop card stays until clicked (status quo).
   */
  private settleDesktopRemoteLeg(kind: "approval" | "question", req: any, outcome: unknown): void {
    let gw: any;
    try {
      const ctxAny = this.ctx as Record<string, any>;
      // ctx.get is the ONLY reliable service read on this host (property reads
      // of host-root services return undefined — sessionController probe
      // precedent); keep the property read as a legacy fallback.
      if (typeof ctxAny.get === "function") gw = ctxAny.get("typertGateway");
    } catch {}
    if (!gw) {
      try {
        gw = (this.ctx as any).typertGateway;
      } catch {}
    }
    if (!gw) {
      this.log("warn", "settle desktop leg: typertGateway not resolvable (desktop card stays)");
      return;
    }
    if (typeof gw.hasLiveClient === "function" && !gw.hasLiveClient()) return; // no desktop UI: nothing to settle
    const pendings = gw.pendingRemoteEvents;
    if (!(pendings instanceof Map)) {
      const shape = gw && typeof gw === "object" ? Object.keys(gw).slice(0, 14).join(",") : typeof gw;
      this.log("warn", `settle desktop leg: pendingRemoteEvents not a Map (keys: ${shape})`);
      return;
    }
    const eventName = kind === "approval" ? "approval/request" : "user-questions/request";
    const agentId = req?.agent?.id;
    if (typeof gw.settleRemoteEvent !== "function") {
      this.log("warn", "settle desktop leg: settleRemoteEvent missing (dsh upgrade renamed internals?)");
      return;
    }
    let scanned = 0;
    let settledCount = 0;
    for (const pending of [...pendings.values()]) {
      scanned++;
      const frame = pending?.frame;
      if (frame?.event !== eventName) continue;
      // gateway's carrier key may not equal req.agent.id — only filter when
      // BOTH sides have an id AND they differ; never over-filter on shape
      if (agentId !== undefined && frame?.agentId !== undefined && frame?.agentId !== agentId) continue;
      // R2: the gateway's pending.frame.request is the waterfall request with
      // agent/signal stripped (dsh-api-gateway projectRemoteEventRequest —
      // business fields pass verbatim). Match THIS card's payload so parallel
      // same-kind pendings on one agent stop being torn down together.
      if (!this.sameInteractionRequest(req, frame?.request)) continue;
      try {
        gw.settleRemoteEvent(pending, { kind: "result", value: outcome });
        settledCount++;
      } catch (error) {
        this.log("warn", `settle desktop leg: per-pending settle failed: ${String(error).slice(0, 100)}`);
      }
    }
    if (scanned > 0 && settledCount === 0) {
      this.log("info", `race ${kind} desktop leg: ${scanned} pending scanned but none matched this card's payload (older host without frame.request?) — desktop card left as-is`);
    }
    this.log("info", `race ${kind} desktop leg: scanned=${scanned} settled=${settledCount}`);
  }

  /**
   * Whether the gateway's projected request describes THIS card: compared on
   * the discriminating business fields (toolName/callId/reason/displayReason
   * + question ids). A shape mismatch (older host without frame.request, or
   * an unforeseen projection) just returns false — the desktop card then
   * stays until clicked, which is the documented degradation, instead of the
   * old blast-radius teardown of every same-kind pending.
   */
  private sameInteractionRequest(req: any, projected: any): boolean {
    if (!projected || typeof projected !== "object") return false;
    const eq = (a: any, b: any) => (a ?? undefined) === (b ?? undefined);
    if (!eq(req?.toolName, projected.toolName)) return false;
    if (!eq(req?.callId, projected.callId)) return false;
    if (!eq(req?.reason, projected.reason)) return false;
    if (!eq(req?.displayReason, projected.displayReason)) return false;
    const aq = Array.isArray(req?.questions) ? req.questions : [];
    const bq = Array.isArray(projected.questions) ? projected.questions : [];
    if (aq.length !== bq.length) return false;
    if (aq.length > 0) {
      const ids = (list: any[]) =>
        list
          .map((q: any) => String(q?.id ?? ""))
          .sort()
          .join("|");
      if (ids(aq) !== ids(bq)) return false;
    }
    return true;
  }
  /** Assemble the phone frame for one interactive request (null = unusable). */
  private buildInteractionFrame(kind: "approval" | "question", sessionId: string, id: string, req: any): WorkServerMessage | null {
    if (kind === "approval") {
      const toolName = typeof req?.toolName === "string" ? req.toolName : undefined;
      if (!toolName && !req?.reason) return null;
      return {
        type: "approval_request",
        sessionId,
        id,
        kind,
        ...(toolName ? { toolName } : {}),
        ...(typeof req?.callId === "string" && req.callId ? { callId: req.callId } : {}),
        ...(typeof req?.reason === "string" && req.reason ? { reason: req.reason } : {}),
        ...(typeof req?.displayReason === "string" && req.displayReason ? { displayReason: req.displayReason } : {}),
      };
    }
    const questions = Array.isArray(req?.questions)
      ? req.questions
          .filter((q: any) => q && typeof q === "object")
          .map((q: any) => ({
            id: String(q.id ?? ""),
            question: String(q.question ?? ""),
            ...(typeof q.detail === "string" && q.detail ? { detail: q.detail } : {}),
            ...(typeof q.header === "string" && q.header ? { header: q.header } : {}),
            ...(q.multiSelect === true ? { multiSelect: true } : {}),
            ...(Array.isArray(q.options)
              ? {
                  options: q.options
                    .filter((o: any) => o && typeof o === "object")
                    .map((o: any) => ({
                      label: String(o.label ?? ""),
                      ...(typeof o.description === "string" && o.description ? { description: o.description } : {}),
                    }))
                    .filter((o: any) => o.label),
                }
              : {}),
          }))
          .filter((q: any) => q.id && q.question)
      : [];
    if (questions.length === 0) return null;
    return {
      type: "approval_request",
      sessionId,
      id,
      kind,
      ...(typeof req?.callId === "string" && req.callId ? { callId: req.callId } : {}),
      questions: questions as WorkQuestionItem[],
    };
  }

  /**
   * Phone answered a card. Stores the validated answer on the entry and
   * settles its phone leg (the race in raceInteraction does the rest).
   * Unknown id = the request already settled elsewhere (the desktop answered
   * first and the phone's card was torn down): the tap is simply void.
   */
  private answerInteraction(client: WorkClient, msg: Extract<WorkClientMessage, { type: "approval_answer" | "question_answer" }>): void {
    const entry = this.pendingInteractions.get(msg.id);
    if (!entry || entry.sessionId !== msg.sessionId) {
      return this.ack(client, msg.reqId, false, "该请求已结束（可能在电脑端已处理）");
    }
    // H13: the phone leg already timed out — the desktop leg owns the outcome
    // now, so this answer can no longer win the race. Reject it: an ack true
    // here would grey out the card while its approval_resolved only arrives
    // when the desktop eventually settles (recheck-1 §5's stale-card window).
    if (entry.timedOut === true) {
      return this.ack(client, msg.reqId, false, "该请求已超时关闭，请在电脑端处理");
    }
    if (msg.type === "approval_answer") {
      if (entry.kind !== "approval") return this.ack(client, msg.reqId, false, "请求类型不匹配");
      if (msg.outcome !== "allowed-once" && msg.outcome !== "rejected") {
        return this.ack(client, msg.reqId, false, "无效的审批结果");
      }
      this.ack(client, msg.reqId, true);
      entry.phoneSettle(msg.outcome);
      return;
    }
    // question_answer
    if (entry.kind !== "question") return this.ack(client, msg.reqId, false, "请求类型不匹配");
    const frame = entry.frame as Extract<WorkServerMessage, { type: "approval_request" }>;
    const asked = frame.questions ?? [];
    const answers = Array.isArray(msg.answers) ? msg.answers.filter((a) => a && typeof a.id === "string" && Array.isArray(a.selected)) : [];
    const answeredIds = new Set(answers.map((a) => a.id));
    // the host contract requires every question answered exactly once
    if (answers.length !== asked.length || !asked.every((q) => answeredIds.has(q.id))) {
      return this.ack(client, msg.reqId, false, "答案必须恰好覆盖每个问题一次");
    }
    this.ack(client, msg.reqId, true);
    entry.phoneSettle({
      answers: answers.map((a) => ({
        id: a.id,
        selected: a.selected.map(String),
        ...(typeof a.custom === "string" && a.custom ? { custom: a.custom } : {}),
      })),
    });
  }

  /** Re-send every pending interactive card (phone reconnect handshake). */
  private replayPendingInteractions(client: WorkClient): void {
    for (const entry of this.pendingInteractions.values()) {
      if (entry.sessionId === client.sessionId) this.sendTo(client, entry.frame);
    }
  }

  private teardown(): void {
    for (const d of this.disposers) {
      try {
        d();
      } catch {
        // one broken unsubscribe must not starve the rest
      }
    }
    this.disposers = [];
    this.wired = false;
    this.pendingApprovals.clear();
    // held interaction promises fall through to their desktop leg / timer —
    // the waterfall still settles, just without a phone in the race
    for (const entry of this.pendingInteractions.values()) clearTimeout(entry.timer);
    this.pendingInteractions.clear();
    // learned cwd rows die with the taps that learned them; the next enable
    // re-learns them from snapshots/lists (keeps dispose cycles leak-free)
    this.cwdCache.clear();
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
    // pending text-delta batches would otherwise hold their timers into a
    // disabled bridge
    for (const batch of this.streamBatches.values()) clearTimeout(batch.timer);
    this.streamBatches.clear();
  }

  private probeSessionController(): void {
    if (this.sc) return;
    const ctx = this.ctx as Record<string, any>;
    // cordis service access: ctx.get(name) is the reliable read (attachments
    // precedent); a bare property read only works for some services (tools).
    const candidates = ["sessionController", "apiSessionController", "session"];
    for (const name of candidates) {
      try {
        const viaGet = typeof ctx.get === "function" ? ctx.get(name) : undefined;
        const sc = viaGet ?? ctx[name];
        if (sc && typeof sc === "object") {
          this.sc = sc;
          this.scServiceName = name;
          const proto = Object.getPrototypeOf(sc) ?? {};
          const methods = [...Object.getOwnPropertyNames(proto), ...Object.keys(sc)].filter((m) => typeof (sc as Record<string, unknown>)[m] === "function");
          this.log("info", `work probe: ${name} methods = ${methods.join(",")}`);
          return;
        }
      } catch {
        // try the next candidate
      }
    }
  }

  /**
   * Debug surface for calibration. lane-10 L2 convergence: the full dump
   * (ctx keys + host method signatures) used to reach ANY paired phone —
   * host-internal structure the phone doesn't need. Production now gets the
   * service-availability summary only; the method-signature dump rides the
   * mock receiver (dev.js calibration) exclusively.
   */
  private handleDebugProbe(client: WorkClient, reqId: string): void {
    const ctx = this.ctx as Record<string, any>;
    const gettable: Record<string, boolean> = {};
    for (const name of ["sessionController", "apiSessionController", "sessionQuery", "workspaceFiles", "agents", "sessions", "approval", "tools", "attachments"]) {
      try {
        const v = typeof ctx.get === "function" ? ctx.get(name) : undefined;
        gettable[name] = v !== undefined && v !== null;
      } catch {
        gettable[name] = false;
      }
    }
    if (!MOCK) {
      return this.ack(client, reqId, true, undefined, { gettable, scFound: !!this.sc, scServiceName: this.scServiceName });
    }
    let ctxKeys: string[] = [];
    try {
      ctxKeys = Object.keys(ctx).slice(0, 120);
    } catch {}
    const methodInfo: Record<string, string> = {};
    for (const svcName of ["sessionController", "sessionQuery", "workspaceFiles"]) {
      try {
        const svc = typeof ctx.get === "function" ? ctx.get(svcName) : undefined;
        if (!svc) continue;
        const proto = Object.getPrototypeOf(svc) ?? {};
        for (const m of [...Object.getOwnPropertyNames(proto), ...Object.keys(svc)]) {
          if (typeof svc[m] !== "function" || m === "constructor") continue;
          try {
            methodInfo[`${svcName}.${m}`] = String(svc[m]).slice(0, 240);
          } catch {}
        }
      } catch {}
    }
    this.ack(client, reqId, true, undefined, { ctxKeys, gettable, scFound: !!this.sc, scServiceName: this.scServiceName, methodInfo });
  }

  /**
   * Calibration-only passthrough: invoke a whitelisted READ-ONLY host method
   * with arbitrary args and return the raw JSON. Lets the probe round iterate
   * argument shapes without a rebuild per try. Mutation methods are absent
   * from the whitelist on purpose.
   */
  private async handleDebugCall(client: WorkClient, reqId: string, service: string, method: string, args: unknown[]): Promise<void> {
    const READ_METHODS = new Set([
      "sessionController.list", "sessionController.search", "sessionController.events", "sessionController.page", "sessionController.state",
      "sessionController.projections", "sessionController.modelCatalog", "sessionController.observeState", "sessionController.follow",
      "sessionQuery.listSessions", "sessionQuery.readSession", "sessionQuery.filterSessions",
      "workspaceFiles.list", "workspaceFiles.stat", "workspaceFiles.read", "workspaceFiles.readBytes", "workspaceFiles.changes",
      "agents.get",
    ]);
    const key = `${service}.${method}`;
    if (!READ_METHODS.has(key)) return this.ack(client, reqId, false, `debug_call: ${key} not whitelisted`);
    const ctx = this.ctx as Record<string, any>;
    let svc: any;
    try {
      svc = typeof ctx.get === "function" ? ctx.get(service) : undefined;
    } catch {}
    if (!svc || typeof svc[method] !== "function") return this.ack(client, reqId, false, `debug_call: ${key} unavailable`);
    try {
      // host service methods take (…args, AbortSignal) — JSON can't carry a
      // signal, so the calibration passthrough always appends one
      const result = await svc[method](...args, AbortSignal.timeout(30_000));
      const text = JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? String(v) : v));
      if (text.length > 200_000) {
        return this.ack(client, reqId, true, undefined, { truncated: true, preview: text.slice(0, 100_000) });
      }
      const parsed = JSON.parse(text);
      return this.ack(client, reqId, true, undefined, parsed);
    } catch (error) {
      return this.ack(client, reqId, false, `debug_call ${key} threw: ${String(error).slice(0, 300)}`);
    }
  }

  // ── host event routing (live agent-layer events; shapes per dsh-agent 0.2.x) ─

  private routeHostEvent(name: string, payload: unknown): void {
    const p = payload as Record<string, any> | null | undefined;
    if (!p) return;
    const sessionId = agentSessionId(p.agent);
    switch (name) {
      case "agent/status": {
        if (!sessionId) return;
        const status = typeof p.status === "string" ? p.status : String(p.status ?? "");
        this.forward(sessionId, { type: "session_state", sessionId, running: status === "running", status });
        this.scheduleSessionListRefresh();
        break;
      }
      case "agent/assistant-stream": {
        if (!sessionId || !p.frame) return;
        // H10: text-delta chunks ride a 40ms per-session micro-batch (their
        // wire envelope dwarfs the payload); every other frame flushes the
        // batch first so ordering start → deltas → end is preserved.
        this.enqueueStreamFrame(sessionId, p.frame as WorkStreamFrame);
        break;
      }
      case "agent/inbox/inserted": {
        if (!sessionId || !p.message) return;
        // user-message echo: surface it as a durable-shaped event so the
        // phone folds it into the timeline like any snapshot row.
        // Prompt injections and synthetic context events are dropped.
        if (isContextInjectionEvent({ type: "user/message", data: { message: p.message } })) return;
        this.forward(sessionId, {
          type: "session_event",
          sessionId,
          event: { type: "user/message", seq: -1, time: Date.now(), data: { message: p.message, inbox: "inserted" } },
        });
        break;
      }
      case "agent/error": {
        if (!sessionId) return;
        const detail = String(p.error ?? "");
        this.log("warn", `work: agent error on ${sessionId.slice(0, 8)}: ${detail.slice(0, 160)}`);
        this.forward(sessionId, {
          type: "session_event",
          sessionId,
          event: { type: "agent/error", seq: -1, time: Date.now(), data: { turn: p.turn, step: p.step, error: detail.slice(0, 600) } },
        });
        break;
      }
      case "agent/created":
      case "agent/disposed":
      default:
        this.scheduleSessionListRefresh();
        break;
    }
  }

  // (retireApproval removed): approval retirement is owned entirely by
  // pollPendingInput, which now diffs the mirror on every poll and retires
  // changed/emptied sets within APPROVAL_POLL_MS — the "wire it into snapshot
  // tails" plan below was never implemented and had no callers.

  private pushApprovalState(sessionId: string): void {
    const per = this.pendingApprovals.get(sessionId);
    const pending = per ? [...per.entries()].map(([id, meta]) => ({ id, ...(meta.toolName !== undefined ? { toolName: meta.toolName } : {}), ...(meta.reason !== undefined ? { reason: meta.reason } : {}) })) : [];
    // contract 4: ids of the live interactive cards for THIS session. Always
    // sent (empty array = deliberate "no card pending") so the phone can
    // reconcile pendingRequests against it — a resolved frame lost to a link
    // blip then self-heals within one poll period.
    const interactionIds = [...this.pendingInteractions.entries()].filter(([, e]) => e.sessionId === sessionId).map(([id]) => id);
    this.forward(sessionId, { type: "approval_state", sessionId, pending, interactionIds } satisfies WorkServerMessage);
  }

  /** Send to every client currently subscribed to this session. The old
   *  "no subscriber → dump onto sessionId===null connections" fallback is
   *  GONE (lane-01 R6): the work feature shipped with 1.1.6, and its App
   *  filters every fallback-eligible frame (session_event/approval_state/
   *  model_changed/session_archived/session_state/resolved) against its
   *  subscribedId, so on a subscriberless window those bytes were dropped on
   *  arrival — dead bytes. The list page's running state comes from the
   *  session_list broadcast, not these frames. */
  private forward(sessionId: string, msg: WorkServerMessage): void {
    const text = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.sessionId === sessionId && c.ws.readyState === c.ws.OPEN) {
        try {
          c.ws.send(text);
        } catch {}
      }
    }
  }

  private broadcast(msg: WorkServerMessage): void {
    const text = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.ws.readyState === c.ws.OPEN) {
        try {
          c.ws.send(text);
        } catch {}
      }
    }
  }

  /**
   * H10 (lane-07 P3): buffer per-session text-delta chunks for STREAM_BATCH_MS
   * and emit ONE merged chunk frame — each chunk's ~150-200B envelope used to
   * hit the wire verbatim for a few bytes of text (5-20× amplification). The
   * app's chunk ingestion concatenates `chunk.text`, so a merged frame needs
   * no client change. start/end/non-text frames flush the pending batch and
   * pass through immediately; a new attemptId/revision flushes too.
   */
  private enqueueStreamFrame(sessionId: string, frame: WorkStreamFrame): void {
    const chunk = frame.chunk as { type?: unknown; text?: unknown } | undefined;
    const batchable = frame.type === "chunk" && chunk?.type === "text-delta" && typeof chunk.text === "string";
    if (!batchable) {
      this.flushStreamBatch(sessionId);
      this.forward(sessionId, { type: "stream_frame", sessionId, frame });
      return;
    }
    const existing = this.streamBatches.get(sessionId);
    if (existing && existing.frame.attemptId === frame.attemptId && existing.frame.revision === frame.revision) {
      (existing.frame.chunk as { text: string }).text += (frame.chunk as { text: string }).text;
      if (frame.index !== undefined) existing.frame.index = frame.index;
      return;
    }
    // attempt boundary (or an unflushed stale batch): ship what we hold first
    this.flushStreamBatch(sessionId);
    // copy the first chunk: the host may mutate the frame object after we
    // hand it off to the timer
    const copy: WorkStreamFrame = { ...frame, chunk: { ...(frame.chunk as object) } };
    const timer = setTimeout(() => this.flushStreamBatch(sessionId), WorkBridge.STREAM_BATCH_MS);
    if (typeof timer.unref === "function") timer.unref();
    this.streamBatches.set(sessionId, { frame: copy, timer });
  }

  private flushStreamBatch(sessionId: string): void {
    const batch = this.streamBatches.get(sessionId);
    if (!batch) return;
    this.streamBatches.delete(sessionId);
    clearTimeout(batch.timer);
    this.forward(sessionId, { type: "stream_frame", sessionId, frame: batch.frame });
  }

  private sendHello(client: WorkClient): void {
    let version = "0.0.0";
    try {
      version = this.version();
    } catch {}
    this.sendTo(client, { type: "work_hello", enabled: true, version });
    // reconnect handshake: cards that were live when the phone dropped come
    // back immediately (the 5-min hold outlives the socket)
    this.replayPendingInteractions(client);
  }

  private sendTo(client: WorkClient, msg: WorkServerMessage): void {
    if (client.ws.readyState !== client.ws.OPEN) return;
    try {
      client.ws.send(JSON.stringify(msg));
    } catch {}
  }

  private ack(client: WorkClient, reqId: string, ok: boolean, reason?: string, data?: unknown): void {
    this.sendTo(client, { type: "work_ack", reqId, ok, ...(reason !== undefined ? { reason } : {}), ...(data !== undefined ? { data } : {}) });
  }

  private logOnceCache = new Set<string>();
  private logOnce(key: string): void {
    if (this.logOnceCache.has(key)) return;
    this.logOnceCache.add(key);
    if (this.logOnceCache.size > 20) this.logOnceCache.clear();
    this.log("warn", `work calibration: ${key}`);
  }

  // ── client request handling ─────────────────────────────────────────────────

  private onClientMessage(client: WorkClient, msg: WorkClientMessage | null): void {
    if (!msg || typeof msg.type !== "string") return;
    if (MOCK) {
      this.onMockMessage(client, msg);
      return;
    }
    switch (msg.type) {
      case "ping":
        this.sendTo(client, { type: "pong" });
        return;
      case "session_list_req":
        void this.pushSessionList().then(() => this.ack(client, msg.reqId, true));
        return;
      case "session_subscribe":
        void this.handleSubscribe(client, msg);
        return;
      case "session_create":
        void this.handleSessionCreate(client, msg);
        return;
      case "session_fork":
        void this.handleSessionFork(client, msg);
        return;
      case "session_archive":
        void this.handleSessionArchive(client, msg);
        return;
      case "history_page":
        void this.handleHistoryPage(client, msg);
        return;
      case "work_send":
        void this.handleSend(client, msg);
        return;
      case "work_cancel":
        void this.handleCancel(client, msg);
        return;
      case "model_catalog_req":
        void this.handleModelCatalog(client, msg);
        return;
      case "work_select_model":
        void this.handleSelectModel(client, msg);
        return;
      case "commands_list":
        void this.handleCommandsList(client, msg);
        return;
      case "mention_query":
        void this.handleMentionQuery(client, msg);
        return;
      case "file_list":
        void this.handleFileList(client, msg);
        return;
      case "file_read":
        void this.handleFileRead(client, msg);
        return;
      case "changes_summary":
        this.handleChangesSummary(client, msg);
        return;
      case "approval_answer":
      case "question_answer":
        this.answerInteraction(client, msg);
        return;
      case "debug_probe":
        this.handleDebugProbe(client, msg.reqId);
        return;
      case "debug_call":
        void this.handleDebugCall(client, msg.reqId, String(msg.service ?? ""), String(msg.method ?? ""), Array.isArray(msg.args) ? msg.args : []);
        return;
      default:
        return;
    }
  }

  /**
   * H1/H4/H7/H8: subscribe (or unsubscribe via an empty sessionId — the
   * app's leave-session path). Async because the existence probe rides the
   * host list; the ack only goes out AFTER that verdict so the phone sees
   * exactly one ack. Cards replay AFTER the snapshot lands (timeline first,
   * cards second) — the reconnect/subscribe path that used to lose live
   * cards entirely (replay was dead code: attach-time sessionId is null).
   */
  private async handleSubscribe(client: WorkClient, msg: Extract<WorkClientMessage, { type: "session_subscribe" }>): Promise<void> {
    const requested = msg.sessionId || null;
    client.sessionId = requested;
    this.pushDeviceList();
    if (!requested) return this.ack(client, msg.reqId, true);
    // H4: a bogus id used to subscribe silently into the snapshot fallback's
    // empty session. Only reject when the host list is actually readable and
    // the id is absent from it (null = unknown → allow; archived sessions
    // still appear in the list, so a phone parked in an archived chat keeps
    // its snapshot on reconnect).
    const exists = await this.sessionExists(requested);
    if (exists === false) {
      client.sessionId = null;
      this.pushDeviceList();
      return this.ack(client, msg.reqId, false, "会话不存在（可能已被删除）");
    }
    this.ack(client, msg.reqId, true);
    const sinceSeq = typeof msg.sinceSeq === "number" && Number.isFinite(msg.sinceSeq) && msg.sinceSeq > 0 ? msg.sinceSeq : undefined;
    await this.pushSnapshot(client, requested, sinceSeq);
    this.replayPendingInteractions(client);
  }

  /**
   * Best-effort existence check for a subscribe target against the host's
   * session list. true/false only when the list is readable and non-empty;
   * null = unknown (host cold/unavailable) — the caller then lets the
   * snapshot flow decide instead of rejecting a subscribable session.
   */
  private async sessionExists(sessionId: string): Promise<boolean | null> {
    const sc = await this.awaitController(3_000);
    if (!sc || typeof sc.list !== "function") return null;
    try {
      const items = this.extractItems(await sc.list());
      if (items.length === 0) return null;
      // same visibility as the list broadcast: subagent rows are hidden from
      // the phone, so they are not subscribable targets either
      return items.some((it: any) => it?.origin !== "subagent" && String(it?.sessionId ?? it?.id ?? "") === sessionId);
    } catch {
      return null;
    }
  }

  // ── mock mode (LENS_MOCK_WORK=1, dev.js only) ─────────────────────────────

  private mockSessions: WorkSessionSummary[] = [
    { sessionId: "mock-session-1", title: "修复登录页的空指针崩溃", updatedAt: Date.now() - 60_000, running: false, blank: false, cwd: "C:\\demo\\lens-app" },
    { sessionId: "mock-session-2", title: "重构 WebSocket 重连逻辑", updatedAt: Date.now() - 3_600_000, running: false, blank: false, cwd: "C:\\demo\\lens-app" },
    { sessionId: "mock-session-3", title: "调研竞品的会话镜像方案", updatedAt: Date.now() - 7_200_000, running: false, blank: false, cwd: "C:\\demo\\research" },
  ];
  private mockStreams = new Map<string, NodeJS.Timeout>();

  private onMockMessage(client: WorkClient, msg: WorkClientMessage): void {
    switch (msg.type) {
      case "ping":
        this.sendTo(client, { type: "pong" });
        return;
      case "session_list_req":
        this.broadcast({ type: "session_list", sessions: this.mockSessions });
        this.ack(client, msg.reqId, true);
        return;
      case "session_create": {
        if (msg.cwd && msg.workspaceId) {
          this.ack(client, msg.reqId, false, "cwd 与 workspaceId 只能传其一");
          return;
        }
        const sid = `mock-session-${Date.now()}`;
        const cwd = msg.cwd ?? this.mockSessions[0]?.cwd ?? "C:\\demo\\lens-app";
        this.mockSessions = [
          { sessionId: sid, title: "(新会话)", updatedAt: Date.now(), running: false, blank: true, cwd },
          ...this.mockSessions,
        ];
        this.broadcast({ type: "session_list", sessions: this.mockSessions });
        this.ack(client, msg.reqId, true, undefined, { sessionId: sid });
        return;
      }
      case "session_fork": {
        const srcRow = this.mockSessions.find((r) => r.sessionId === msg.sessionId);
        if (!srcRow) {
          this.ack(client, msg.reqId, false, "源会话不存在");
          return;
        }
        const childId = `mock-session-fork-${Date.now()}`;
        const base = (msg.title ?? srcRow.title ?? "").trim();
        // H14 mock parity: loop to a free slot instead of blind "+1" (two
        // forks of the same source used to produce identical child titles)
        const taken = new Set(this.mockSessions.map((r) => r.title).filter((t): t is string => !!t));
        const nextTitle = this.nextForkTitle(base, taken);
        this.mockSessions = [{ sessionId: childId, title: nextTitle, updatedAt: Date.now(), running: false, blank: false, cwd: srcRow.cwd }, ...this.mockSessions];
        this.broadcast({ type: "session_list", sessions: this.mockSessions });
        this.ack(client, msg.reqId, true, undefined, { sessionId: childId });
        return;
      }
      case "session_archive": {
        const before = this.mockSessions.length;
        this.mockSessions = this.mockSessions.filter((r) => r.sessionId !== msg.sessionId);
        this.broadcast({ type: "session_list", sessions: this.mockSessions });
        this.ack(client, msg.reqId, this.mockSessions.length < before || msg.unarchive === true, undefined, { archivedSessionIds: [] });
        return;
      }
      case "session_subscribe": {
        // keep the mock branch in lockstep with handleSubscribe: presence
        // push on subscribe/unsubscribe (P3 — dev.js smoke must see the
        // device card) + sinceSeq filtering + card replay (a no-op here, the
        // mock never races interactions, but the shape stays comparable).
        client.sessionId = msg.sessionId || null;
        this.pushDeviceList();
        this.ack(client, msg.reqId, true);
        const sid = msg.sessionId;
        if (!sid) return;
        const now = Date.now();
        const sinceSeq = typeof msg.sinceSeq === "number" && Number.isFinite(msg.sinceSeq) && msg.sinceSeq > 0 ? msg.sinceSeq : undefined;
        this.sendSnapshot(client, sid, [
          { type: "session/title", seq: 0, time: now - 120_000, data: { title: "修复登录页的空指针崩溃" } },
          { type: "user/message", seq: 3, time: now - 118_000, data: { content: [{ type: "text", text: "登录页在空表单提交时会崩溃,帮我修一下" }], source: { kind: "user", rpcId: "seed-rpc-1" }, role: "user", id: "seed-1" } },
          { type: "turn/start", seq: 4, time: now - 117_000, data: { turn: 1 } },
          { type: "tool/call", seq: 5, time: now - 116_000, data: { turn: 1, step: 1, callId: "c1", name: "read", arguments: JSON.stringify({ path: "lib/login.dart" }) } },
          { type: "tool/result", seq: 6, time: now - 115_000, data: { turn: 1, step: 1, message: { role: "tool", source: { kind: "tool", callId: "c1" }, toolCallId: "c1", content: [{ type: "text", text: "class LoginPage extends StatefulWidget {...}" }], isError: false } } },
          { type: "tool/call", seq: 7, time: now - 114_000, data: { turn: 1, step: 2, callId: "c2", name: "edit", arguments: JSON.stringify({ path: "lib/login.dart", old: "form.validate()", new: "form?.validate()" }) } },
          { type: "tool/result", seq: 8, time: now - 113_000, data: { turn: 1, step: 2, error: { name: "ToolError", code: "apply_failed" }, message: { role: "tool", source: { kind: "tool", callId: "c2" }, toolCallId: "c2", content: [{ type: "text", text: "old string not found" }], isError: true } } },
          { type: "assistant/message", seq: 10, time: now - 90_000, data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "已修复:空表单时 `form` 为 null 导致崩溃。我把 `form.validate()` 改成了空安全的 `form?.validate()`,并在提交前加了空值检查。现在空表单提交会显示提示而不是崩溃。" }] }, usage: { inputTokens: 1840, outputTokens: 96 } } },
          { type: "workspace/changes", seq: 11, time: now - 89_500, data: { turn: 1 } },
          { type: "turn/end", seq: 12, time: now - 89_000, data: { turn: 1, reason: { kind: "completed" } } },
        ], 12, false, sinceSeq);
        this.sendTo(client, { type: "session_state", sessionId: sid, running: false, status: "completed" });
        this.replayPendingInteractions(client);
        return;
      }
      case "history_page":
        // mock: emit an empty tail snapshot so the phone's merge path runs
        this.sendTo(client, { type: "session_snapshot", sessionId: msg.sessionId, events: [], lastSeq: 99, hasMore: false });
        this.ack(client, msg.reqId, true);
        return;
      case "work_send": {
        const sid = msg.sessionId;
        if (typeof msg.text === "string" && msg.text.trimStart().startsWith("/")) {
          // mock command: journal events + ack carrying the fabricated result
          const token = msg.text.trim().slice(1).split(/\s/, 1)[0] ?? "";
          const cid = "mock-cmd-" + Date.now();
          this.forward(sid, { type: "session_event", sessionId: sid, event: { type: "command/run", seq: -1, time: Date.now(), data: { commandId: cid, name: token, source: { kind: "user" } } } });
          this.ack(client, msg.reqId, true, undefined, { requestId: msg.requestId, command: { commandId: cid, kind: "success", text: "(mock) 命令已执行: /" + token } });
          this.forward(sid, { type: "session_event", sessionId: sid, event: { type: "command/done", seq: -1, time: Date.now(), data: { commandId: cid, kind: "success", text: "(mock) 命令已执行: /" + token } } });
          return;
        }
        this.ack(client, msg.reqId, true, undefined, { requestId: msg.requestId });
        // echo the user message, then stream a fabricated reply
        this.forward(sid, {
          type: "session_event",
          sessionId: sid,
          event: { type: "user/message", seq: -1, time: Date.now(), data: { message: { role: "user", content: [{ type: "text", text: msg.text }], source: { kind: "user", rpcId: msg.requestId } } } },
        });
        this.forward(sid, { type: "session_state", sessionId: sid, running: true });
        this.forward(sid, { type: "stream_frame", sessionId: sid, frame: { type: "start", attemptId: "mock", revision: 1, turn: 2, step: 1 } });
        const reply = `收到「${msg.text.slice(0, 40)}」。这是 mock 模式的流式回复,用来验证手机端的流式渲染、光标动画与折叠交互。包含 \`code span\` 与多行文本。`;
        // L12: a second work_send to the same session used to overwrite the
        // map entry and leak the previous interval (it kept streaming and its
        // completion callback deleted the NEW timer's entry)
        const prevStream = this.mockStreams.get(sid);
        if (prevStream) {
          clearInterval(prevStream);
          this.mockStreams.delete(sid);
        }
        let i = 0;
        const timer = setInterval(() => {
          if (i >= reply.length) {
            clearInterval(timer);
            this.mockStreams.delete(sid);
            this.forward(sid, { type: "stream_frame", sessionId: sid, frame: { type: "end", attemptId: "mock", revision: 1, index: reply.length, outcome: { kind: "committed", eventType: "assistant/message", seq: 99 } } });
            this.forward(sid, {
              type: "session_event",
              sessionId: sid,
              event: { type: "assistant/message", seq: 99, time: Date.now(), data: { turn: 2, step: 1, message: { role: "assistant", content: [{ type: "text", text: reply }] }, usage: { inputTokens: 2100, outputTokens: reply.length } } },
            });
            this.forward(sid, { type: "session_state", sessionId: sid, running: false, status: "completed" });
            return;
          }
          const step = Math.min(3 + Math.floor(Math.random() * 6), reply.length - i);
          const piece = reply.slice(i, i + step);
          i += step;
          this.forward(sid, { type: "stream_frame", sessionId: sid, frame: { type: "chunk", attemptId: "mock", revision: 1, index: i, time: Date.now(), chunk: { type: "text-delta", text: piece } } });
        }, 90);
        this.mockStreams.set(sid, timer);
        return;
      }
      case "work_cancel": {
        this.ack(client, msg.reqId, true);
        const t = this.mockStreams.get(msg.sessionId);
        if (t) {
          clearInterval(t);
          this.mockStreams.delete(msg.sessionId);
          this.forward(msg.sessionId, { type: "stream_frame", sessionId: msg.sessionId, frame: { type: "end", attemptId: "mock", revision: 1, index: 0, outcome: { kind: "abandoned" } } });
          this.forward(msg.sessionId, { type: "session_state", sessionId: msg.sessionId, running: false, status: "interrupted" });
        }
        return;
      }
      case "commands_list":
        this.ack(client, msg.reqId, true, undefined, {
          commands: [
            { name: "goal", description: "Set or review the session goal", aliases: ["goal", "目标"] },
            { name: "plan", description: "Enter plan mode", aliases: ["plan", "计划"] },
            { name: "feedback", description: "Send feedback about the harness", aliases: ["feedback", "反馈"] },
            { name: "compact", description: "Compact the session context", aliases: ["compact", "压缩"] },
            { name: "permission", description: "Switch permission presets", aliases: ["permission", "权限"] },
            { name: "export", description: "Export the session log", aliases: ["export", "导出"] },
          ],
        });
        return;
      case "mention_query": {
        const q = String(msg.query ?? "");
        this.ack(client, msg.reqId, true, undefined, {
          files: [
            { path: "lib/main.dart", kind: "file" },
            { path: "lib/core/api.dart", kind: "file" },
            { path: "packages", kind: "directory" },
            { path: "docs/protocol.md", kind: "file" },
          ].filter((f) => q === "" || f.path.includes(q)),
          sessions: [
            { label: "演示会话A", mention: "@[演示会话A](dsh-session:bW9jay1h)" },
            { label: "演示会话B", mention: "@[演示会话B](dsh-session:bW9jay1i)" },
          ].filter((s) => q === "" || s.label.includes(q)),
        });
        return;
      }
      case "model_catalog_req":
        this.ack(client, msg.reqId, true, undefined, {
          default: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" },
          routableProviders: ["deepseek-official", "zai-coding-cn"],
          groups: [
            {
              id: "deepseek-official",
              name: "DeepSeek",
              models: [
                { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", reasoning: { efforts: [{ id: "off", name: "Off" }, { id: "low", name: "Low" }, { id: "high", name: "High", description: "默认平衡" }, { id: "max", name: "Max" }], defaultEffort: "high" } },
                { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", description: "更强代理编码与复杂推理", reasoning: { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" } },
              ],
            },
            { id: "zai-coding-cn", name: "Zhipu", models: [{ id: "glm-5.3-flash", name: "GLM-5.3-Flash", reasoning: { efforts: [], defaultEffort: null } }] },
          ],
          failures: [],
        });
        return;
      case "work_select_model":
        this.ack(client, msg.reqId, true, undefined, { selected: { provider: msg.provider, model: msg.model, ...(msg.reasoningEffort ? { reasoningEffort: msg.reasoningEffort } : {}) } });
        return;
      case "file_list": {
        const dir = msg.path === "." ? "" : `${msg.path}/`;
        this.ack(client, msg.reqId, true, undefined, {
          path: msg.path,
          entries: [
            { name: "lib", type: "directory" },
            { name: "assets", type: "directory" },
            { name: "README.md", type: "file", size: 2048 },
            { name: "main.dart", type: "file", size: 12340 },
          ].map((e) => ({ ...e, name: dir === "" ? e.name : e.name })),
        });
        return;
      }
      case "file_read":
        this.ack(client, msg.reqId, true, undefined, {
          path: msg.path,
          offset: 0,
          bytesRead: 64,
          totalSize: 64,
          eof: true,
          dataBase64: Buffer.from(`# ${msg.path}\n\n这是 mock 模式的文件预览内容。\nLine 3\nLine 4\n`, "utf8").toString("base64"),
        });
        return;
      case "changes_summary":
        // mock: a one-file summary so the "edited N files" card shows counts
        this.ack(client, msg.reqId, true, undefined, {
          turn: 1,
          cwd: "C:\\demo\\lens-app",
          files: [{ path: "lib/login.dart", display: "lib/login.dart", added: 24, deleted: 3 }],
          total: 1,
          added: 24,
          deleted: 3,
        });
        return;
      case "approval_answer":
      case "question_answer":
        this.ack(client, msg.reqId, true);
        this.forward(msg.sessionId, { type: "approval_resolved", sessionId: msg.sessionId, id: String((msg as any).id ?? ""), outcome: msg.type === "approval_answer" ? String((msg as any).outcome ?? "") : "answered" });
        return;
      default:
        return;
    }
  }

  private requireController(): any {
    this.probeSessionController();
    return this.sc;
  }

  /**
   * Wait (≤5s) for the host's sessionController to mount — phone-lens loads
   * before the API controllers on some boots, and a request landing inside
   * that window must not hard-fail ("服务不可用") when waiting one beat fixes it.
   * A probe loop that ends WITHOUT the controller is cached for
   * CONTROLLER_PROBE_TTL_MS: every 5s poll/list used to re-spin a full 5s
   * probe loop against a host that simply lacks the controller (H16).
   */
  private async awaitController(timeoutMs = 5_000): Promise<any> {
    if (Date.now() - this.controllerProbeFailedAt < WorkBridge.CONTROLLER_PROBE_TTL_MS) return null;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.probeSessionController();
      if (this.sc) return this.sc;
      if (Date.now() >= deadline) {
        this.controllerProbeFailedAt = Date.now();
        return null;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private extractItems(result: any): any[] {
    if (Array.isArray(result)) return result;
    if (result && typeof result === "object") {
      for (const key of ["items", "sessions", "list"]) {
        const v = (result as Record<string, any>)[key];
        if (Array.isArray(v)) return v;
      }
    }
    return [];
  }

  private async pushSessionList(): Promise<void> {
    if (!this.enabled() || this.clients.size === 0) return;
    const sc = await this.awaitController();
    if (!sc || typeof sc.list !== "function") {
      this.logOnce("sessionController.list unavailable");
      return;
    }
    try {
      const result = await sc.list();
      const archived = await this.archivedSessionIds();
      const sessions: WorkSessionSummary[] = this.extractItems(result)
        .filter((it: any) => it?.origin !== "subagent") // desktop hides these too
        .map((it: any) => {
          const sid = String(it?.sessionId ?? it?.id ?? "");
          if (!sid) return null;
          const cwd = typeof it?.cwd === "string" && it.cwd ? it.cwd : undefined;
          if (cwd) this.cwdCache.set(sid, cwd);
          // list items carry projection hints: values.title is the host's own
          // title projection (session/title events) — always preferred over a
          // raw prompt snippet
          const pTitle = it?.projections?.values?.title;
          const title = typeof pTitle === "string" && pTitle.trim() ? pTitle.trim() : undefined;
          return {
            sessionId: sid,
            ...(title !== undefined ? { title } : {}),
            ...(it?.updatedAt !== undefined ? { updatedAt: Number(it.updatedAt) || 0 } : {}),
            ...(it?.running !== undefined ? { running: !!it.running } : {}),
            ...(it?.blank !== undefined ? { blank: !!it.blank } : {}),
            ...(cwd !== undefined ? { cwd } : {}),
          } as WorkSessionSummary;
        })
        .filter((s: WorkSessionSummary | null): s is WorkSessionSummary => !!s)
        .filter((s: WorkSessionSummary) => !archived?.has(s.sessionId)); // desktop hides archived rows too
      await this.enrichSessionMeta(sessions);
      this.broadcast({ type: "session_list", sessions });
    } catch (error) {
      this.log("warn", `work: session list failed: ${String(error)}`);
    }
  }

  private archivedProbeLogged = false;

  /**
   * Best-effort archived-session set. Archival is registry-global (workspace
   * domain state), NOT a SessionSummary field — the desktop workspace tree
   * partitions on it and hides archived rows by default, and the phone must
   * match. The workspace controller's service name is build-dependent: probe
   * a few candidates; failure only means no filtering (logged once so the
   * name can be calibrated from boot.log).
   */
  /**
   * Workspace-domain service candidates (the desktop's ownership ledger).
   * Was three hand-rolled candidate lists that drifted apart (lane-10 L7:
   * archived-set probe / create-cwd mapping / archive-unarchive each had
   * their own, in different orders); callers filter by the method they need.
   */
  private workspaceServiceCandidates(): any[] {
    const ctx = this.ctx as Record<string, any>;
    const found: any[] = [];
    for (const name of ["workspaceController", "workspaceRegistry", "workspace", "apiWorkspaceController", "workspaces"]) {
      try {
        const svc = typeof ctx.get === "function" ? ctx.get(name) : undefined;
        if (svc && typeof svc === "object") found.push(svc);
      } catch {
        // candidate unavailable on this host — try the next
      }
    }
    return found;
  }

  private async archivedSessionIds(): Promise<Set<string> | null> {
    for (const svc of this.workspaceServiceCandidates()) {
      try {
        for (const m of ["getState", "domainState", "state"]) {
          if (typeof svc[m] !== "function") continue;
          let st: any;
          try {
            st = await svc[m]();
          } catch {
            // host service methods may require an AbortSignal second param
            st = await svc[m](AbortSignal.timeout(8_000));
          }
          const ids = st?.archivedSessionIds ?? st?.state?.archivedSessionIds;
          if (Array.isArray(ids)) return new Set(ids.map(String));
        }
        if (Array.isArray(svc.archivedSessionIds)) return new Set(svc.archivedSessionIds.map(String));
      } catch {
        // try the next candidate
      }
    }
    if (!this.archivedProbeLogged) {
      this.archivedProbeLogged = true;
      this.log("info", "work: archived-session set unavailable — archived sessions will list (calibrate workspace service name from this log)");
    }
    return null;
  }

  private scheduleSessionListRefresh(): void {
    if (this.sessionListTimer || !this.enabled()) return;
    this.sessionListTimer = setTimeout(() => {
      this.sessionListTimer = null;
      void this.pushSessionList();
    }, SESSION_LIST_DEBOUNCE_MS);
  }

  /**
   * Read a session's event history. Signature verified against the host's
   * typert schema (0.2.2-rc.1): events(args, signal) → {cursor, records:
   * [{type:'event', event: SessionWireEvent}], hasMore}.
   */
  private async readHistory(sessionId: string, beforeSeq: number | undefined, maxMessages: number): Promise<{ events: any[]; hasMore: boolean } | { error: string }> {
    const sc = await this.awaitController();
    if (!sc || typeof sc.events !== "function") return { error: "sessionController.events unavailable on this host" };
    try {
      const r = await sc.events(
        { address: { kind: "session", sessionId }, ...(beforeSeq !== undefined ? { beforeSeq } : {}), maxMessages },
        AbortSignal.timeout(30_000),
      );
      const rec = (r ?? {}) as Record<string, any>;
      const rows = Array.isArray(rec.records) ? rec.records : [];
      return { events: filterEvents(rows.map((x: any) => x?.event ?? x)), hasMore: !!rec.hasMore };
    } catch (error) {
      return { error: String(error) };
    }
  }

  private async pushSnapshot(client: WorkClient, sessionId: string, sinceSeq?: number): Promise<void> {
    // full baseline via readSession: one call returns session metadata (cwd!)
    // plus the complete durable event list — simpler and cheaper than paging
    const sq = this.sessionQueryService();
    if (sq && typeof sq.readSession === "function") {
      try {
        const full = (await sq.readSession(sessionId, AbortSignal.timeout(60_000))) as Record<string, any>;
        const meta = full?.session ?? {};
        if (typeof meta.cwd === "string" && meta.cwd) this.cwdCache.set(sessionId, meta.cwd);
        const rawEvents = Array.isArray(full?.events) ? full.events : [];
        // lastSeq reflects the session's true head regardless of sinceSeq
        // filtering (the baseline is "aligned up to here")
        const lastSeq = rawEvents.length > 0 ? Number(rawEvents[rawEvents.length - 1]?.seq ?? 0) : 0;
        this.sendSnapshot(client, sessionId, filterEvents(rawEvents), lastSeq, false, sinceSeq);
        return;
      } catch (error) {
        this.logOnce(`readSession failed: ${String(error).slice(0, 200)}`);
      }
    }
    // fallback: paged events without metadata
    const r = await this.readHistory(sessionId, undefined, 200);
    if ("error" in r) {
      this.logOnce(`history read failed: ${r.error.slice(0, 200)}`);
      this.sendSnapshot(client, sessionId, [], 0, false, sinceSeq);
      return;
    }
    const lastSeq = r.events.length > 0 ? Number(r.events[r.events.length - 1]?.seq ?? 0) : 0;
    this.sendSnapshot(client, sessionId, r.events, lastSeq, r.hasMore, sinceSeq);
  }

  /**
   * Serialize one snapshot baseline through the shared guards:
   * - H7 race guard: the phone may have re-subscribed elsewhere while the
   *   60s readSession was in flight — per-session seq spaces overlap
   *   STRUCTURALLY (both start at 0, recheck-3), so a stale baseline would
   *   poison the new session's timeline. Drop when the subscription moved.
   * - H8/contract 3: with sinceSeq only seq > sinceSeq rides along (a
   *   re-subscribing phone already holds the older rows; omitting = full).
   * - H9: an >8MB baseline splits into several session_snapshot frames cut
   *   on EVENT boundaries (the App merges by seq; a single event — measured
   *   up to ~1.1MB — is never byte-cut).
   */
  private sendSnapshot(client: WorkClient, sessionId: string, events: any[], lastSeq: number, hasMore: boolean, sinceSeq?: number): void {
    if (client.sessionId !== sessionId) return;
    const filtered = sinceSeq !== undefined && sinceSeq > 0 ? events.filter((e) => Number(e?.seq ?? 0) > sinceSeq) : events;
    const frames: any[][] = [];
    let current: any[] = [];
    let size = 0;
    for (const ev of filtered) {
      let evSize = 0;
      try {
        evSize = JSON.stringify(ev).length;
      } catch {
        evSize = 4096;
      }
      if (current.length > 0 && size + evSize > WorkBridge.SNAPSHOT_CHUNK_BYTES) {
        frames.push(current);
        current = [];
        size = 0;
      }
      current.push(ev);
      size += evSize;
    }
    if (current.length > 0) frames.push(current);
    if (frames.length > 1) {
      this.log("info", `work snapshot split into ${frames.length} frames (sid ${sessionId.slice(0, 8)})`);
    }
    for (const slice of frames.length > 0 ? frames : [[]]) {
      // the phone may leave mid-stream even between chunks
      if (client.sessionId !== sessionId) return;
      this.sendTo(client, { type: "session_snapshot", sessionId, events: slice, lastSeq, hasMore } satisfies WorkServerMessage);
    }
  }

  private sessionQueryService(): any {
    try {
      const ctx = this.ctx as Record<string, any>;
      return typeof ctx.get === "function" ? ctx.get("sessionQuery") : undefined;
    } catch {
      return undefined;
    }
  }

  private async handleHistoryPage(client: WorkClient, msg: Extract<WorkClientMessage, { type: "history_page" }>): Promise<void> {
    const r = await this.readHistory(msg.sessionId, msg.beforeSeq, Math.min(msg.maxMessages ?? 60, 300));
    if ("error" in r) {
      this.ack(client, msg.reqId, false, `历史读取失败: ${r.error.slice(0, 120)}`);
      return;
    }
    // H11 (lane-07 P4): a turn-tail refresh passes sinceSeq = the phone's
    // newest durable seq — of the window, only the NEW events ride back
    // instead of the whole 40-row JSON (the live stream already delivered
    // the rest this turn). Omitted (older clients) = full window.
    const sinceSeq = typeof msg.sinceSeq === "number" && Number.isFinite(msg.sinceSeq) && msg.sinceSeq > 0 ? msg.sinceSeq : undefined;
    const events = sinceSeq !== undefined ? r.events.filter((e) => Number(e?.seq ?? 0) > sinceSeq) : r.events;
    const lastSeq = events.length > 0 ? Number(events[events.length - 1]?.seq ?? 0) : 0;
    // H7 race guard: a stale page must not fold into a session the phone has
    // since switched to (same overlap semantics as sendSnapshot)
    if (client.sessionId !== msg.sessionId) return;
    // reuse the snapshot frame for paging — same payload, client merges by seq
    this.sendTo(client, { type: "session_snapshot", sessionId: msg.sessionId, events, lastSeq, hasMore: r.hasMore } satisfies WorkServerMessage);
    this.ack(client, msg.reqId, true);
  }

  private async handleSend(client: WorkClient, msg: Extract<WorkClientMessage, { type: "work_send" }>): Promise<void> {
    if (!this.enabled()) return this.ack(client, msg.reqId, false, "工作(Beta)已关闭");
    if ((await this.archivedSessionIds())?.has(msg.sessionId)) {
      // archived on the desktop while the phone was chatting — prompt() would
      // silently queue into a gated agent, so reject with the visible reason
      return this.ack(client, msg.reqId, false, "该会话已在电脑端归档，无法继续对话");
    }
    const text = typeof msg.text === "string" ? msg.text : "";
    const requestId = typeof msg.requestId === "string" && msg.requestId ? msg.requestId : randomUUID();
    const images = (Array.isArray((msg as any).images) ? (msg as any).images : []).filter(
      (i: any): i is { mediaType: string; data: string; name?: string } =>
        !!i && typeof i.mediaType === "string" && typeof i.data === "string" && i.data.length > 0,
    );
    if (!text.trim() && images.length === 0) return this.ack(client, msg.reqId, false, "消息为空");
    // Slash commands NEVER become model messages: like the desktop composer we
    // intercept the line and dispatch through the host's CommandRuntime (which
    // logs command/run|command/done into the session journal), and an unknown
    // name is an error rather than a degraded prompt — same semantics as dsh.
    const trimmed = text.trimStart();
    if (trimmed.startsWith("/")) return this.handleSendCommand(client, msg, requestId, trimmed);
    const sc = await this.awaitController();
    if (!sc || typeof sc.prompt !== "function") return this.ack(client, msg.reqId, false, "宿主会话服务不可用");
    // requestId doubles as the idempotency key: the host dedupes prompts by
    // it at the persistence layer, so a phone retry can never double-send.
    // Images ride as base64 `image` parts of the prompt content — the host's
    // admission stores them as durable attachments (and rejects when the
    // session's current model lacks the image input modality).
    const mode = msg.mode === "steer" ? "steer" : "queue";
    const content: Array<Record<string, unknown>> = [];
    if (text.trim()) content.push({ type: "text", text });
    for (const img of images) {
      content.push({ type: "image", mediaType: img.mediaType, data: img.data, ...(img.name ? { name: img.name } : {}) });
    }
    try {
      await sc.prompt(
        { requestId, sessionId: msg.sessionId, mode, content, clientTimeZone: "Asia/Shanghai" },
        AbortSignal.timeout(60_000),
      );
      this.log("info", `work send → session ${msg.sessionId.slice(0, 8)} (${mode}${images.length ? ` +${images.length}img` : ""}, id ${requestId.slice(0, 8)})`);
      return this.ack(client, msg.reqId, true, undefined, { requestId });
    } catch (error) {
      const lastError = String(error);
      this.log("warn", `work send failed: ${lastError.slice(0, 200)}`);
      return this.ack(client, msg.reqId, false, `发送失败: ${lastError.slice(0, 160)}`, { requestId });
    }
  }

  /**
   * Dispatch a `/name args` line through the host's CommandRuntime instead of
   * prompt(). No requestId idempotency exists on this path (the host mints its
   * own commandId), so the phone deliberately does not auto-retry commands.
   */
  private async handleSendCommand(client: WorkClient, msg: Extract<WorkClientMessage, { type: "work_send" }>, requestId: string, trimmed: string): Promise<void> {
    const commands = this.commandsService();
    const token = trimmed.slice(1).split(/\s/, 1)[0] ?? "";
    if (!token) return this.ack(client, msg.reqId, false, "命令为空(输入 / 查看可用命令)");
    const agent = this.resolveAgent(msg.sessionId);
    if (!commands || typeof commands.execute !== "function" || !agent) {
      return this.ack(client, msg.reqId, false, "宿主命令服务不可用(会话可能已结束)", { requestId });
    }
    let descriptors: any[] = [];
    if (typeof commands.list === "function") {
      try {
        const listed = await commands.list(agent);
        if (Array.isArray(listed)) descriptors = listed;
      } catch (error) {
        this.logOnce(`commands.list failed: ${String(error).slice(0, 160)}`);
      }
    }
    const cmd = resolveCommandToken(token, descriptors);
    if (!cmd || typeof cmd.name !== "string") {
      return this.ack(client, msg.reqId, false, `未知命令: /${token}(输入 / 查看可用命令)`, { requestId });
    }
    const rawInput = trimmed.slice(1 + token.length);
    const line = `/${cmd.name}${rawInput}`;
    try {
      const exec = await commands.execute(agent, line, [], AbortSignal.timeout(90_000));
      if (!exec) return this.ack(client, msg.reqId, false, `命令未能执行: /${token}`, { requestId });
      const result = (exec as any)?.result ?? {};
      this.log("info", `work command /${cmd.name} → ${String(result.kind)} (cid ${String((exec as any).commandId ?? "?").slice(0, 8)})`);
      return this.ack(client, msg.reqId, true, undefined, {
        requestId,
        command: {
          commandId: typeof (exec as any).commandId === "string" ? (exec as any).commandId : "",
          kind: result.kind === "error" ? "error" : "success",
          text: typeof result.text === "string" ? result.text.slice(0, 2000) : undefined,
        },
      });
    } catch (error) {
      const lastError = String(error);
      this.log("warn", `work command /${cmd.name} failed: ${lastError.slice(0, 200)}`);
      return this.ack(client, msg.reqId, false, `命令执行失败: ${lastError.slice(0, 160)}`, { requestId });
    }
  }

  /** Host CommandRuntime service (cordis `commands`), or null when absent. */
  private commandsService(): any | null {
    try {
      const svc = (this.ctx as Record<string, any>).get?.("commands");
      return svc && typeof svc === "object" ? svc : null;
    } catch {
      return null;
    }
  }

  /** Resolve the Agent object behind a session id (null on cold/unknown). */
  private resolveAgent(sessionId: string): any | null {
    try {
      const agents = (this.ctx as Record<string, any>).get?.("agents");
      const agent = agents?.get?.(sessionId);
      return agent ?? null;
    } catch {
      return null;
    }
  }

  /** Slash-command directory for the phone composer's popup. */
  private async handleCommandsList(client: WorkClient, msg: Extract<WorkClientMessage, { type: "commands_list" }>): Promise<void> {
    const svc = this.commandsService();
    let descriptors: any[] = [];
    if (svc && typeof svc.list === "function") {
      const agent = this.resolveAgent(msg.sessionId ?? "");
      try {
        const listed = await svc.list(agent);
        if (Array.isArray(listed)) descriptors = listed;
      } catch (error) {
        this.logOnce(`commands.list failed: ${String(error).slice(0, 160)}`);
      }
    }
    const commands: WorkCommandInfo[] = descriptors
      .filter((d) => typeof d?.name === "string" && d.name)
      .map((d) => ({
        name: String(d.name),
        description: typeof d?.description === "string" ? d.description : undefined,
        aliases: commandAliases(d),
        attachments: d?.input?.attachments === true,
        hint: typeof d?.input?.hint === "string" ? d.input.hint : undefined,
      }));
    // no registry read (service missing or cold session): name-only fallback
    // so the phone popup still lists the six first-party commands
    const payload = commands.length > 0 ? commands : FALLBACK_COMMANDS;
    return this.ack(client, msg.reqId, true, undefined, { commands: payload });
  }

  /** @-mention candidates: cwd files/dirs + referenced sessions, in parallel. */
  private async handleMentionQuery(client: WorkClient, msg: Extract<WorkClientMessage, { type: "mention_query" }>): Promise<void> {
    const agent = this.resolveAgent(msg.sessionId ?? "");
    if (!agent) return this.ack(client, msg.reqId, false, "尚未连接该会话(请先进入会话)");
    const query = typeof msg.query === "string" ? msg.query : "";
    const readFiles = async (): Promise<WorkMentionFile[]> => {
      const svc = (this.ctx as Record<string, any>).get?.("fileReferences");
      if (!svc || typeof svc.list !== "function") return [];
      const rows = await svc.list(agent, query, AbortSignal.timeout(8_000));
      const files = Array.isArray(rows) ? rows : [];
      return files
        .filter((f: any) => typeof f?.path === "string" && f.path)
        .slice(0, 12)
        .map((f: any) => ({ path: String(f.path), kind: f.kind === "directory" ? ("directory" as const) : ("file" as const) }));
    };
    const readSessions = async (): Promise<WorkMentionSession[]> => {
      const svc = (this.ctx as Record<string, any>).get?.("sessionReferenceResolver");
      if (!svc || typeof svc.candidates !== "function") return [];
      const rows = await svc.candidates(agent, query, AbortSignal.timeout(8_000));
      const sessions = Array.isArray(rows) ? rows : [];
      return sessions
        .filter((s: any) => typeof s?.mention === "string" && s.mention)
        .slice(0, 6)
        .map((s: any) => ({
          label: String(s?.label ?? s?.displayTitle ?? "会话"),
          title: typeof s?.title === "string" ? s.title : undefined,
          mention: String(s.mention),
        }));
    };
    const [files, sessions] = await Promise.all([
      readFiles().catch(() => [] as WorkMentionFile[]),
      readSessions().catch(() => [] as WorkMentionSession[]),
    ]);
    return this.ack(client, msg.reqId, true, undefined, { files, sessions });
  }

  private async handleCancel(client: WorkClient, msg: Extract<WorkClientMessage, { type: "work_cancel" }>): Promise<void> {
    if (!this.enabled()) return this.ack(client, msg.reqId, false, "工作(Beta)已关闭");
    const sc = await this.awaitController();
    if (!sc || typeof sc.cancel !== "function") return this.ack(client, msg.reqId, false, "宿主会话服务不可用");
    try {
      // accepted:true only means the request was taken; the terminal state is
      // observed through turn/end reason:interrupted downstream
      await sc.cancel({ sessionId: msg.sessionId }, AbortSignal.timeout(15_000));
      this.log("info", `work cancel → session ${msg.sessionId.slice(0, 8)}`);
      return this.ack(client, msg.reqId, true);
    } catch (error) {
      const lastError = String(error);
      this.log("warn", `work cancel failed: ${lastError.slice(0, 200)}`);
      return this.ack(client, msg.reqId, false, `停止失败: ${lastError.slice(0, 120)}`);
    }
  }

  /**
   * Mint a blank session for the phone's workspace-group "+" button. cwd XOR
   * workspaceId (dsh rejects both); with neither, dsh uses its defaultCwd.
   * Without sessionId dsh always mints a brand-new `session-{uuid}` — the
   * phone disables the button per request to avoid double-tap piling blanks.
   * List refresh rides the existing agent/created → scheduleSessionListRefresh
   * route; the ack also carries sessionId so the phone can subscribe directly.
   */
  private async handleSessionCreate(client: WorkClient, msg: Extract<WorkClientMessage, { type: "session_create" }>): Promise<void> {
    if (!this.enabled()) return this.ack(client, msg.reqId, false, "工作(Beta)已关闭");
    const sc = await this.awaitController();
    if (!sc || typeof sc.create !== "function") return this.ack(client, msg.reqId, false, "宿主会话服务不可用");
    if (msg.cwd && msg.workspaceId) return this.ack(client, msg.reqId, false, "cwd 与 workspaceId 只能传其一");
    const request: Record<string, unknown> = {};
    if (msg.cwd) {
      // phone groups by cwd basename, but the desktop's workspace ledger is
      // the ownership source of truth — a session created with a bare cwd
      // shows as "ungrouped" there. Map cwd → registered workspace first;
      // fall back to bare cwd when unmatched (phone grouping still works).
      const wsId = await this.resolveWorkspaceId(msg.cwd);
      if (wsId) {
        request.workspaceId = wsId;
      } else {
        request.cwd = msg.cwd;
      }
    }
    if (msg.workspaceId) request.workspaceId = msg.workspaceId;
    try {
      const created = (await sc.create(request, AbortSignal.timeout(15_000))) as { sessionId?: string } | undefined;
      const sessionId = typeof created?.sessionId === "string" ? created.sessionId : "";
      if (!sessionId) return this.ack(client, msg.reqId, false, "宿主未返回会话 id");
      this.log("info", `work create → session ${sessionId.slice(0, 8)} (cwd=${msg.cwd ? "yes" : msg.workspaceId ? "ws" : "default"})`);
      this.scheduleSessionListRefresh();
      return this.ack(client, msg.reqId, true, undefined, { sessionId });
    } catch (error) {
      const lastError = String(error);
      this.log("warn", `work create failed: ${lastError.slice(0, 200)}`);
      return this.ack(client, msg.reqId, false, `新建会话失败: ${lastError.slice(0, 120)}`);
    }
  }

  /**
   * Map an absolute cwd to a REGISTERED workspace id (the desktop's ownership
   * ledger — dsh-workspace workspaceRegistry). Path comparison normalizes
   * slashes/case (Windows realpath vs session header shapes); null = no
   * registered workspace covers this cwd.
   */
  private async resolveWorkspaceId(cwd: string): Promise<string | null> {
    const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
    const target = norm(cwd);
    if (!target) return null;
    for (const svc of this.workspaceServiceCandidates()) {
      try {
        if (typeof svc.list !== "function") continue;
        const rows = (await svc.list(AbortSignal.timeout(5_000))) as any;
        if (!Array.isArray(rows)) continue;
        for (const r of rows) {
          if (r && typeof r.path === "string" && r.id !== undefined && r.id !== null && norm(r.path) === target) {
            return String(r.id);
          }
        }
      } catch {
        // try the next candidate
      }
    }
    this.logOnce("work calibration: no registered workspace matched create cwd (session falls back to bare cwd)");
    return null;
  }

  /**
   * Desktop turn-tail fork parity: duplicate the session prefix up to and
   * INCLUDING atSeq into a new session, then best-effort rename the child to
   * the incremented source title ("标题 (1)" → "标题 (2)", plain titles get
   * " (1)" appended — client-side behavior on the desktop, service.ts:476).
   * The child inherits the source cwd; its model is the GLOBAL default (host
   * semantics, not the source's). ack data = { sessionId }.
   */
  private async handleSessionFork(client: WorkClient, msg: Extract<WorkClientMessage, { type: "session_fork" }>): Promise<void> {
    if (!this.enabled()) return this.ack(client, msg.reqId, false, "工作(Beta)已关闭");
    const sc = await this.awaitController();
    if (!sc || typeof sc.fork !== "function") return this.ack(client, msg.reqId, false, "宿主会话服务不可用");
    try {
      const created = (await sc.fork(
        { sessionId: msg.sessionId, ...(msg.atSeq !== undefined ? { atSeq: msg.atSeq } : {}) },
        AbortSignal.timeout(30_000),
      )) as { sessionId?: string } | undefined;
      const childId = typeof created?.sessionId === "string" ? created.sessionId : "";
      if (!childId) return this.ack(client, msg.reqId, false, "宿主未返回分叉会话 id");
      // desktop parity rename: "标题 (N)" increments, plain titles get " (1)".
      // H14 (lane-02 §4): the desktop loops the bumped title through the set
      // of EXISTING titles (increasedForkTitle) — phone-lens only copied the
      // increment, so a second fork of the same source renamed its child to
      // a title already taken by the first child. Loop to a free slot here,
      // full-width brackets included (desktop incrementedTitle parity).
      // rename needs an explicit resume on cold sessions and may fail — log
      // and continue, the child stays usable (untitled → "(未命名会话)").
      if (msg.title && msg.title.trim() !== "" && typeof sc.rename === "function") {
        try {
          const base = msg.title.trim();
          const taken = (await this.existingSessionTitles()) ?? new Set<string>();
          const next = this.nextForkTitle(base, taken);
          await sc.rename({ sessionId: childId, title: next }, AbortSignal.timeout(10_000));
        } catch (error) {
          this.log("warn", `work fork rename skipped: ${String(error).slice(0, 120)}`);
        }
      }
      this.log("info", `work fork → child ${childId.slice(0, 16)} (at ${msg.atSeq ?? "latest"})`);
      this.scheduleSessionListRefresh();
      return this.ack(client, msg.reqId, true, undefined, { sessionId: childId });
    } catch (error) {
      const lastError = String(error);
      this.log("warn", `work fork failed: ${lastError.slice(0, 200)}`);
      return this.ack(client, msg.reqId, false, `分叉失败: ${lastError.slice(0, 140)}`);
    }
  }

  /**
   * Desktop increasedForkTitle parity: bump the "(N)" tail (half- AND
   * full-width brackets, BigInt like the desktop) and loop to a free slot.
   * taken unreadable → a single bump still applies (old behavior).
   */
  private nextForkTitle(base: string, taken: Set<string>): string {
    const bump = (t: string): string => {
      const half = /^(.*?)\((\d+)\)$/.exec(t);
      if (half) return `${half[1] ?? ""}(${BigInt(half[2] ?? "0") + 1n})`;
      const full = /^(.*?)（(\d+)）$/.exec(t);
      if (full) return `${full[1] ?? ""}（${BigInt(full[2] ?? "0") + 1n}）`;
      return `${t} (1)`;
    };
    let next = bump(base);
    while (taken.has(next)) next = bump(next);
    return next;
  }

  /** Existing display titles (projections.values.title — the same source the
   *  list broadcast uses) for fork-rename avoidance; null = list unreadable. */
  private async existingSessionTitles(): Promise<Set<string> | null> {
    const sc = await this.awaitController(3_000);
    if (!sc || typeof sc.list !== "function") return null;
    try {
      const items = this.extractItems(await sc.list());
      const taken = new Set<string>();
      for (const it of items) {
        const t = it?.projections?.values?.title;
        if (typeof t === "string" && t.trim()) taken.add(t.trim());
      }
      return taken;
    } catch {
      return null;
    }
  }

  /**
   * Archive / unarchive via the workspaceController (the desktop's list
   * context-menu channel). Archiving a RUNNING session without stopActivity
   * is rejected by the host (workspace/session-active) — the error text rides
   * the ack reason to the phone. ack data = { archivedSessionIds }.
   */
  private async handleSessionArchive(client: WorkClient, msg: Extract<WorkClientMessage, { type: "session_archive" }>): Promise<void> {
    if (!this.enabled()) return this.ack(client, msg.reqId, false, "工作(Beta)已关闭");
    const method = msg.unarchive === true ? "unarchiveSession" : "archiveSession";
    let svc: any = null;
    for (const candidate of this.workspaceServiceCandidates()) {
      if (typeof candidate[method] === "function") {
        svc = candidate;
        break;
      }
    }
    if (!svc) {
      this.logOnce("work calibration: workspace archive service unavailable");
      return this.ack(client, msg.reqId, false, "宿主无归档服务");
    }
    try {
      const request = msg.unarchive === true ? { sessionId: msg.sessionId } : { sessionId: msg.sessionId, ...(msg.stopActivity === true ? { stopActivity: true } : {}) };
      const result = (await svc[method](request, AbortSignal.timeout(15_000))) as { archivedSessionIds?: string[] } | undefined;
      this.log("info", `work ${method} → ${msg.sessionId.slice(0, 16)}`);
      if (msg.unarchive === true) {
        // contract frame 2: a phone sitting in this chat keeps its archived
        // banner until told the session is writable again (lane-02 缺口 E)
        this.forward(msg.sessionId, { type: "session_unarchived", sessionId: msg.sessionId } satisfies WorkServerMessage);
      } else {
        // the phone sitting in this chat gets a persistent banner (its sends
        // are rejected by handleSend's guard with the same reason)
        this.forward(msg.sessionId, { type: "session_archived", sessionId: msg.sessionId } satisfies WorkServerMessage);
      }
      // H16: the mirror is rebuilt from state() on the next poll if the
      // session comes back; a (un)archived session keeps no stale approvals
      this.pendingApprovals.delete(msg.sessionId);
      this.scheduleSessionListRefresh();
      return this.ack(client, msg.reqId, true, undefined, { archivedSessionIds: Array.isArray(result?.archivedSessionIds) ? result!.archivedSessionIds : [] });
    } catch (error) {
      const lastError = String(error);
      this.log("warn", `work ${method} failed: ${lastError.slice(0, 200)}`);
      return this.ack(client, msg.reqId, false, `归档失败: ${lastError.slice(0, 140)}`);
    }
  }

  private async handleModelCatalog(client: WorkClient, msg: Extract<WorkClientMessage, { type: "model_catalog_req" }>): Promise<void> {
    const sc = await this.awaitController();
    if (!sc || typeof sc.modelCatalog !== "function") return this.ack(client, msg.reqId, false, "宿主模型服务不可用");
    const attempts: Array<() => unknown> = [() => sc.modelCatalog(), () => sc.modelCatalog({})];
    let lastError = "";
    for (const attempt of attempts) {
      try {
        const r = await attempt();
        return this.ack(client, msg.reqId, true, undefined, r);
      } catch (error) {
        lastError = String(error);
      }
    }
    this.log("warn", `work model catalog failed: ${lastError.slice(0, 200)}`);
    this.ack(client, msg.reqId, false, `模型目录读取失败: ${lastError.slice(0, 120)}`);
  }

  private async handleSelectModel(client: WorkClient, msg: Extract<WorkClientMessage, { type: "work_select_model" }>): Promise<void> {
    const sc = await this.awaitController();
    if (!sc || typeof sc.selectModel !== "function") return this.ack(client, msg.reqId, false, "宿主模型服务不可用");
    const sel = { sessionId: msg.sessionId, provider: msg.provider, model: msg.model, ...(msg.reasoningEffort ? { reasoningEffort: msg.reasoningEffort } : {}) };
    try {
      const r = await sc.selectModel(sel, AbortSignal.timeout(15_000));
      this.log("info", `work select-model → ${msg.provider}/${msg.model}`);
      // re-read the catalog so the phone renders authoritative state
      let catalog: unknown;
      try {
        catalog = await sc.modelCatalog();
      } catch {}
      // tell every client subscribed to this session (the initiator gets the
      // ack separately) — without this, phone A's switch left phone B showing
      // the old model, and the desktop's own switch never reached any phone
      this.forward(msg.sessionId, {
        type: "model_changed",
        sessionId: msg.sessionId,
        provider: msg.provider,
        model: msg.model,
        ...(msg.reasoningEffort ? { reasoningEffort: msg.reasoningEffort } : {}),
      });
      return this.ack(client, msg.reqId, true, undefined, { selected: (r as any)?.selected, catalog });
    } catch (error) {
      const lastError = String(error);
      this.log("warn", `work select-model failed: ${lastError.slice(0, 200)}`);
      return this.ack(client, msg.reqId, false, `切换失败: ${lastError.slice(0, 120)}`);
    }
  }

  /**
   * Best-effort titles: for the N most recent sessions pull the projections
   * once and use the latest turn prompt as the display title (+ cache the
   * working directory for the file panel). Projections are read-only and do
   * not resume cold sessions; failures just leave the row title-less.
   */
  private async enrichSessionMeta(sessions: WorkSessionSummary[]): Promise<void> {
    const sc = await this.awaitController();
    if (!sc || typeof sc.projections !== "function") return;
    // only sessions the list itself left title-less need the (slower) hint read
    const recent = sessions.filter((s) => !s.title).slice(0, 12);
    await Promise.allSettled(
      recent.map(async (s) => {
        const p = (await sc.projections({ sessionId: s.sessionId }, AbortSignal.timeout(10_000))) as Record<string, any>;
        const values = p?.values ?? p?.projection?.values ?? {};
        const wd = values?.workingDirectory ?? values?.workspace?.workingDirectory;
        if (typeof wd === "string" && wd) this.cwdCache.set(s.sessionId, wd);
        const outline = Array.isArray(values?.turnOutline) ? values.turnOutline : [];
        for (let i = outline.length - 1; i >= 0; i--) {
          const prompt = typeof outline[i]?.prompt === "string" ? outline[i].prompt.trim() : "";
          // an injected context block as the latest "prompt" is not a title
          if (prompt && !prompt.startsWith("<system-reminder")) {
            s.title = prompt.length > 42 ? `${prompt.slice(0, 42)}…` : prompt;
            break;
          }
        }
      }),
    );
  }

  private async handleFileList(client: WorkClient, msg: Extract<WorkClientMessage, { type: "file_list" }>): Promise<void> {
    // Node fs against the session's working directory (the host's own
    // workspaceFiles service is not callable in-process on this build):
    // same containment semantics — anything resolving outside the cwd is
    // refused, no exceptions for absolute paths or .. segments.
    const cwd = this.cwdCache.get(msg.sessionId);
    if (!cwd) return this.ack(client, msg.reqId, false, "尚未确定该会话的工作目录(请先进入会话)");
    const rel = typeof msg.path === "string" && msg.path.trim() && msg.path.trim() !== "." ? msg.path.trim() : ".";
    const base = resolve(cwd);
    const abs = resolve(cwd, rel);
    if (abs !== base && !abs.startsWith(base + sep)) return this.ack(client, msg.reqId, false, "路径越出会话工作目录");
    try {
      const entries = await readdir(abs, { withFileTypes: true });
      const rows = await Promise.all(
        entries
          .filter((e) => e.name !== "." && e.name !== "..")
          .map(async (e) => {
            let size: number | undefined;
            if (e.isFile()) {
              try {
                size = (await fsStat(resolve(abs, e.name))).size;
              } catch {}
            }
            return { name: e.name, type: e.isDirectory() ? "directory" : e.isFile() ? "file" : "other", ...(size !== undefined ? { size } : {}) };
          }),
      );
      // directories first, then names — mirrors the desktop file panel
      rows.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "zh") : a.type === "directory" ? -1 : 1));
      return this.ack(client, msg.reqId, true, undefined, { path: rel, entries: rows, truncated: false });
    } catch (error) {
      return this.ack(client, msg.reqId, false, `目录读取失败: ${String(error).slice(0, 120)}`);
    }
  }

  private async handleFileRead(client: WorkClient, msg: Extract<WorkClientMessage, { type: "file_read" }>): Promise<void> {
    const cwd = this.cwdCache.get(msg.sessionId);
    if (!cwd) return this.ack(client, msg.reqId, false, "尚未确定该会话的工作目录(请先进入会话)");
    const rel = typeof msg.path === "string" && msg.path.trim() ? msg.path.trim() : "";
    if (!rel) return this.ack(client, msg.reqId, false, "缺少文件路径");
    const base = resolve(cwd);
    const abs = resolve(cwd, rel);
    if (abs !== base && !abs.startsWith(base + sep)) return this.ack(client, msg.reqId, false, "路径越出会话工作目录");
    const offset = Number.isInteger(msg.offsetBytes) && msg.offsetBytes! >= 0 ? msg.offsetBytes! : 0;
    const length = Number.isInteger(msg.lengthBytes) && msg.lengthBytes! > 0 ? Math.min(msg.lengthBytes!, 512 * 1024) : 512 * 1024;
    try {
      const st = await fsStat(abs);
      if (!st.isFile()) return this.ack(client, msg.reqId, false, "目标不是普通文件");
      const fh = await open(abs, "r");
      try {
        const buf = Buffer.alloc(Math.min(length, Math.max(st.size - offset, 0)) || length);
        const { bytesRead } = await fh.read(buf, 0, buf.byteLength, offset);
        const data = buf.subarray(0, bytesRead).toString("base64");
        return this.ack(client, msg.reqId, true, undefined, {
          path: rel,
          offset,
          bytesRead,
          totalSize: st.size,
          eof: offset + bytesRead >= st.size,
          dataBase64: data,
        });
      } finally {
        await fh.close();
      }
    } catch (error) {
      return this.ack(client, msg.reqId, false, `文件读取失败: ${String(error).slice(0, 120)}`);
    }
  }

  /**
   * Line counts for one turn's workspace/changes announcement. The
   * workspaceChanges service is provided in-process by dsh-workspace-changes
   * (summary(sessionId, seq) → {turn, cwd, files[{path,display,added,deleted}],
   * total, added, deleted} | undefined); unavailable when the host lacks the
   * plugin or the session was disposed — the phone then renders file names
   * without counts. Deliberately NOT part of debug_call's read-only whitelist
   * shape: it is its own typed request so the payload stays strict.
   */
  private handleChangesSummary(client: WorkClient, msg: Extract<WorkClientMessage, { type: "changes_summary" }>): void {
    if (!this.enabled()) return this.ack(client, msg.reqId, false, "工作(Beta)已关闭");
    const ctx = this.ctx as Record<string, any>;
    let svc: any;
    try {
      svc = typeof ctx.get === "function" ? ctx.get("workspaceChanges") : undefined;
    } catch {
      svc = undefined;
    }
    if (!svc || typeof svc.summary !== "function") {
      this.logOnce("work calibration: workspaceChanges service unavailable — file cards render without line counts");
      return this.ack(client, msg.reqId, false, "宿主无文件变更统计服务");
    }
    try {
      const summary = svc.summary(msg.sessionId, msg.seq);
      if (!summary || typeof summary !== "object") return this.ack(client, msg.reqId, false, "该回合无变更摘要(会话可能已重置)");
      return this.ack(client, msg.reqId, true, undefined, summary);
    } catch (error) {
      return this.ack(client, msg.reqId, false, `变更统计读取失败: ${String(error).slice(0, 120)}`);
    }
  }
}
