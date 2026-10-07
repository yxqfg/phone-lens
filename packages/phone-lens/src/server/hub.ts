import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { AdmittedImage, CameraControl, CameraStateOutcome, LensConfig, ViewClientMessage, ViewServerMessage } from "../types.js";

/** Per-device camera uplink state; multiple phones coexist without kicking. */
interface CamState {
  ws: WebSocket;
  name: string;
  meta: { width?: number; height?: number; fps?: number; rotation?: number; appVersion?: string };
  lastFrame: Buffer | null;
  lastFrameAt: number;
  /** Any inbound traffic (frame, control, ws-pong) — drives the dead-link watchdog. */
  lastSeenAt: number;
  frameCount: number;
  windowStart: number;
  measuredFps: number;
}

/**
 * One in-flight capture request. Normal requests only track the note; model-
 * initiated (direct) ones also carry the settle callbacks the tool awaits.
 */
interface PendingCapture {
  note?: string;
  requestedAt: number;
  /** true = model-initiated (phone_take_photo): photo goes to the model, not the capture mode. */
  direct?: boolean;
  /** direct only: called once the uploaded photo is admitted. */
  onImage?: (admitted: AdmittedImage) => void;
  /** direct only: called when the phone declines/fails or the request times out. */
  onFail?: (reason: string) => void;
}

/**
 * A camera uplink with NO inbound traffic for this long is presumed half-open
 * (phone switched wifi / laptop slept mid-link): the OS keeps the socket
 * "open" without a FIN, so we evict it ourselves. Generous vs the phone's own
 * 30s app-level silence limit so the phone normally tears down first.
 */
const CAM_SILENCE_MS = 60_000;

/**
 * How long the ACTIVE device's stream may go silent before the hub starts
 * DERIVING its state (see checkPreviewStall). The phone app never announces
 * "preview off" — it just stops its frame pump while the WS stays up and the
 * app-level keepalive ping (every 10s, independent of the preview state)
 * keeps flowing. So the discriminator is INBOUND TRAFFIC: "frames stalled +
 * keepalive still arriving" = user turned preview off (confirmed event-side
 * in confirmPreviewOff the moment a ping lands during a stall); "frames
 * stalled + keepalive dead" = the link itself died.
 */
const PREVIEW_STALL_MS = 3_000;

/**
 * No frames AND no inbound traffic at all (no app ping, no ws pong, no
 * control) for this long = the link is dead, e.g. the phone left the wifi
 * while the OS keeps the TCP socket half-open without a FIN. 25s = 2.5× the
 * app's 10s keepalive period, so ONE lost ping (worst-case inbound gap 20s)
 * can NEVER trip it — offline is only ever declared on the COMBINATION
 * "frames stalled + inbound silent past this floor". Single-condition
 * verdicts are forbidden here: 宁可晚判,不可误判. The 60s CAM_SILENCE_MS
 * terminate below still owns the actual eviction; this only corrects the
 * UI semantics ~35s earlier.
 */
const OFFLINE_SILENCE_MS = 25_000;

/**
 * The viewfinder hub: MULTIPLE camera uplinks (one per phone, keyed by
 * deviceId), N loopback view downlinks. The "active" device is auto-selected
 * as the last one to send a frame; the view side can switch it via
 * `select_device`. Only the active device's frames are fanned out — a second
 * phone connecting no longer kicks the first, so several paired phones coexist
 * and the user picks which one to watch / shoot from.
 */
export class ViewHub {
  private cameras = new Map<string, CamState>();
  private activeDeviceId: string | null = null;
  /**
   * The device the flow last settled on EXPLICITLY: picked in the view,
   * claimed from a phone, or simply the first to come online. When that
   * device drops and a fallback takes over, detach does NOT clear this — so
   * the preferred phone reconnecting (network blip, host reboot, delayed
   * wifi join) takes its hot seat back instead of being parked as "another
   * device is using the preview". Any explicit switch updates it.
   */
  private preferredDeviceId: string | null = null;
  private views = new Set<WebSocket>();
  /** captureId → { note, requestedAt } until the matching upload lands or timeout. */
  private pendingCaptures = new Map<string, PendingCapture>();
  private readonly captureTimeoutMs = 60_000;
  /** reqId → settle callback for in-flight camera_idle/camera_resume requests. */
  private cameraStateWaiters = new Map<string, { deviceId: string; settle: (r: CameraStateOutcome) => void }>();
  /**
   * Derived stream state of the ACTIVE device, read off the traffic mix:
   *   "on"      — frames flowing
   *   "off"     — frames stalled but the app keepalive ping still arrives
   *               (hard evidence the link is alive) → user turned preview
   *               off on the phone
   *   "offline" — frames stalled AND no inbound at all past
   *               OFFLINE_SILENCE_MS → the link itself died (wifi drop,
   *               half-open TCP), which is NOT "preview closed"
   */
  private previewState: "on" | "off" | "offline" = "off";
  private stallTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: LensConfig,
    private readonly log: (level: "info" | "warn", msg: string) => void,
  ) {
    this.stallTimer = setInterval(() => this.checkPreviewStall(), 1_000);
  }

  /** Stop the stall watchdog (server dispose). */
  dispose(): void {
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = null;
    // settle any in-flight model-tool requests so their promises don't dangle
    for (const [id, waiter] of this.cameraStateWaiters) {
      waiter.settle({ ok: false, reason: "接收端服务已停止" });
      this.cameraStateWaiters.delete(id);
    }
    for (const [id, p] of this.pendingCaptures) {
      p.onFail?.("接收端服务已停止");
      this.pendingCaptures.delete(id);
    }
  }

  // ── camera side ───────────────────────────────────────────────────────────

  attachCamera(deviceId: string, ws: WebSocket, name: string): void {
    const prev = this.cameras.get(deviceId);
    if (prev) {
      this.log("warn", `camera re-attach: kicking previous ws for ${deviceId.slice(0, 8)}`);
      try {
        prev.ws.close(1000, "new-instance");
      } catch {}
      this.cameras.delete(deviceId);
    }
    const cam: CamState = { ws, name, meta: {}, lastFrame: null, lastFrameAt: 0, lastSeenAt: Date.now(), frameCount: 0, windowStart: Date.now(), measuredFps: 0 };
    this.cameras.set(deviceId, cam);
    if (this.activeDeviceId === null) {
      this.activeDeviceId = deviceId;
      this.preferredDeviceId = deviceId;
    } else if (this.preferredDeviceId === deviceId && this.activeDeviceId !== deviceId) {
      // the preferred phone is back and a fallback currently holds the hot
      // seat it only got because the preferred one dropped — hand it back
      this.selectDevice(deviceId);
    }
    // only the ACTIVE device streams to the PC; others pause immediately
    if (this.activeDeviceId === deviceId) this.sendControl(deviceId, { type: "resume_preview" });
    else this.sendControl(deviceId, { type: "pause_preview" });
    this.log("info", `camera uplink: ${name} (${deviceId.slice(0, 8)})`);

    ws.on("close", (code, reason) => {
      this.log("warn", `camera ws closed: code=${code} reason=${reason.toString("utf8") || "-"} (${name} ${deviceId.slice(0, 8)})`);
      if (this.cameras.get(deviceId)?.ws === ws) this.detachCamera(deviceId);
    });
    ws.on("pong", () => {
      // identity guard (same as close): a replaced uplink's late pong must not
      // refresh the NEW connection's watchdog timestamp
      const c = this.cameras.get(deviceId);
      if (c?.ws !== ws) return;
      c.lastSeenAt = Date.now();
    });
    ws.on("message", (data, isBinary) => {
      // identity guard (same as close): stale traffic from a replaced uplink
      // must not refresh liveness, inject frames, or run controls into the
      // state of the connection that owns this deviceId now
      const c = this.cameras.get(deviceId);
      if (c?.ws !== ws) return;
      c.lastSeenAt = Date.now();
      if (isBinary) {
        this.ingestFrame(deviceId, data as Buffer);
        return;
      }
      this.onCameraControl(deviceId, safeJson(data.toString()));
    });
    // greet the new device to views
    this.broadcastDevices();
  }

  detachCamera(deviceId: string): void {
    const cam = this.cameras.get(deviceId);
    this.log("warn", `detachCamera(${deviceId.slice(0, 8)}) had-camera=${!!cam}`);
    if (cam) this.cameras.delete(deviceId);
    // the phone is GONE: any camera_idle/resume waiter aimed at it can never
    // get a receipt — settle now with the real cause instead of the 8s timer
    for (const [id, waiter] of this.cameraStateWaiters) {
      if (waiter.deviceId === deviceId) {
        waiter.settle({ ok: false, reason: "手机已断开连接" });
        this.cameraStateWaiters.delete(id);
      }
    }
    if (this.activeDeviceId === deviceId) {
      const next = [...this.cameras.keys()].at(-1) ?? null;
      this.activeDeviceId = next;
      if (next) this.sendControl(next, { type: "resume_preview" });
      this.pushActiveFrameToViews();
    }
    this.broadcastDevices();
  }

  detachAll(): void {
    for (const cam of this.cameras.values()) {
      try {
        cam.ws.close(1000, "server-dispose");
      } catch {}
    }
    this.cameras.clear();
    this.activeDeviceId = null;
    this.broadcastDevices();
  }

  pingAll(): void {
    const now = Date.now();
    for (const [deviceId, cam] of this.cameras) {
      if (cam.ws.readyState !== cam.ws.OPEN) continue;
      if (now - cam.lastSeenAt > CAM_SILENCE_MS) {
        // No frames, no controls, no ws-pong: the phone is gone without a
        // FIN (wifi hop). Terminate — the close handler detaches and the
        // devices list tells the truth again. The phone's own 30s app-level
        // watchdog normally tears its side down first.
        this.log("warn", `camera uplink silent >${CAM_SILENCE_MS}ms — terminating ${deviceId.slice(0, 8)}`);
        cam.ws.terminate();
        continue;
      }
      cam.ws.ping();
    }
  }

  /** Device ids with a live camera uplink right now (for /status truth). */
  onlineDeviceIds(): Set<string> {
    const ids = new Set<string>();
    for (const [deviceId, cam] of this.cameras) {
      if (cam.ws.readyState === cam.ws.OPEN) ids.add(deviceId);
    }
    return ids;
  }

  private onCameraControl(deviceId: string, msg: CameraControl | null): void {
    if (!msg) return;
    const cam = this.cameras.get(deviceId);
    if (!cam) return;
    switch (msg.type) {
      case "hello":
        cam.meta = { width: msg.width, height: msg.height, fps: msg.fps, ...(msg.rotation !== void 0 ? { rotation: msg.rotation } : {}), ...(msg.appVersion !== void 0 ? { appVersion: msg.appVersion } : {}) };
        if (this.activeDeviceId === deviceId) {
          // hello is the phone's "stream starting" announcement (sent on every
          // _startStream) — treat it as preview-on for the view side.
          this.markPreviewActive();
          this.broadcastToViews({ type: "frame_meta", width: msg.width, height: msg.height, ...(msg.rotation !== void 0 ? { rotation: msg.rotation } : {}) });
        }
        break;
      case "bye":
        this.log("warn", `camera sent bye: ${deviceId.slice(0, 8)}`);
        this.detachCamera(deviceId);
        break;
      case "claim_active":
        // phone asked to become the active device → switch the view to it.
        this.selectDevice(deviceId);
        break;
      case "ping":
        // app-level keepalive echo (see types.ts); lets the phone detect a
        // half-open link its OS would keep "connected" for minutes
        this.sendControl(deviceId, { type: "pong" });
        // and it lets US discriminate: a stalled stream + a live ping = the
        // user closed the preview on the phone, NOT a dead link. A wifi drop
        // kills frames AND pings together — see confirmPreviewOff.
        this.confirmPreviewOff(deviceId);
        break;
      case "capture_result":
        if (msg.status !== "taken") {
          const failed = this.pendingCaptures.get(msg.captureId);
          failed?.onFail?.(`手机拒绝了拍摄(${msg.status}${msg.detail ? `: ${msg.detail}` : ""})`);
          this.pendingCaptures.delete(msg.captureId);
          // a MODEL-initiated capture declining is already handled by the
          // tool's own failure path — flashing the panel too would be noise
          if (!failed?.direct) {
            this.broadcastToViews({ type: "error", code: "CAPTURE_DECLINED", message: `phone reported ${msg.status}${msg.detail ? `: ${msg.detail}` : ""}` });
          }
        }
        break;
      case "camera_state": {
        // receipt for the model tools' camera_idle/camera_resume requests
        if (msg.reqId) {
          const waiter = this.cameraStateWaiters.get(msg.reqId);
          if (waiter) {
            this.cameraStateWaiters.delete(msg.reqId);
            waiter.settle(msg.state === "failed" ? { ok: false, reason: "手机报告执行失败(相机不可用或权限被拒)" } : { ok: true, state: msg.state });
          }
        }
        break;
      }
      default:
        break;
    }
  }

  private ingestFrame(deviceId: string, frame: Buffer): void {
    const cam = this.cameras.get(deviceId);
    if (!cam || frame.byteLength === 0) return;
    if (frame.byteLength > this.config.limits.previewFrameMaxBytes) {
      this.log("warn", `dropping oversized preview frame from ${deviceId.slice(0, 8)} (${frame.byteLength}B > ${this.config.limits.previewFrameMaxBytes}B)`);
      return;
    }
    const now = Date.now();
    cam.lastFrame = frame;
    cam.lastFrameAt = now;
    cam.frameCount++;
    if (now - cam.windowStart >= 2000) {
      cam.measuredFps = (cam.frameCount * 1000) / (now - cam.windowStart);
      cam.windowStart = now;
      cam.frameCount = 0;
    }
    // only the ACTIVE device drives the view; others just keep their own state
    if (this.activeDeviceId === deviceId) {
      this.markPreviewActive();
      for (const view of this.views) {
        if (view.readyState === view.OPEN) view.send(frame, { binary: true });
      }
    }
  }

  /** Flip the view-side preview state to on (once) when stream activity returns. */
  private markPreviewActive(): void {
    this.setPreviewState("on");
  }

  /**
   * The phone's app-level keepalive ping just arrived (10s cadence, runs
   * regardless of the preview state). If the ACTIVE stream has been stalled
   * past PREVIEW_STALL_MS, that ping is hard evidence the LINK is alive and
   * only the frame pump stopped → "user turned preview off on the phone",
   * NOT a disconnect. It also de-escalates a premature "offline" verdict
   * back to "off" once inbound traffic returns (the consecutive-lost-pings
   * edge case). Only the app-level ping qualifies as the discriminator:
   * ws-pongs fire from the OS network stack even when the app is wedged, and
   * hello announces a stream STARTING, so neither may drive this verdict.
   */
  private confirmPreviewOff(deviceId: string): void {
    if (deviceId !== this.activeDeviceId) return;
    const cam = this.cameras.get(deviceId);
    if (!cam || Date.now() - cam.lastFrameAt <= PREVIEW_STALL_MS) return;
    this.setPreviewState("off");
  }

  /** Single choke point for preview-state transitions + view notification. */
  private setPreviewState(next: "on" | "off" | "offline"): void {
    if (this.previewState === next) return;
    this.previewState = next;
    this.broadcastToViews({ type: "preview_state", on: next === "on", ...(next === "offline" ? { reason: "offline" } : {}) });
    this.log(next === "offline" ? "warn" : "info", `active preview state → ${next}`);
  }

  /**
   * Watchdog tick (1s): derives the ACTIVE device's stream state from the
   * traffic mix. The phone never announces "preview off" — the host reads it
   * off the wire:
   *
   *   frames flowing                             → "on"  (set in ingestFrame)
   *   frames stalled + app ping still arriving   → "off" (flipped the moment
   *                                               a ping lands during a stall,
   *                                               in confirmPreviewOff)
   *   frames stalled + NO inbound at all past
   *   OFFLINE_SILENCE_MS (2.5 keepalive periods) → "offline" (half-open link:
   *                                               wifi drop — NOT "preview
   *                                               closed"; this is the bug
   *                                               where a dead wifi used to
   *                                               render as "preview off")
   *
   * Between 3s and 25s of stall the hub deliberately says NOTHING (the view
   * keeps the last frame): a wifi drop and a preview-off look identical for
   * the first seconds, and guessing early is exactly the misjudgment this
   * watchdog must not make. 宁可晚判,不可误判. The 60s CAM_SILENCE_MS
   * terminate in pingAll still owns the actual eviction; this only fixes
   * the UI semantics ~35s earlier.
   */
  private checkPreviewStall(): void {
    const active = this.activeCam();
    if (!active || active.ws.readyState !== active.ws.OPEN) return;
    const now = Date.now();
    if (now - active.lastFrameAt <= PREVIEW_STALL_MS) return;
    if (now - active.lastSeenAt < OFFLINE_SILENCE_MS) {
      // stalled, but the keepalive window hasn't expired: either a ping is
      // about to land (→ confirmPreviewOff flips to "off") or the silence
      // will outlast OFFLINE_SILENCE_MS (→ "offline" below). Wait. Also note
      // an existing "off" upgrades to "offline" here if the keepalive dies
      // later (preview closed first, THEN the wifi dropped).
      return;
    }
    // double condition, both strong: frames stalled >3s AND zero inbound for
    // ≥25s (2.5 ping periods). A single lost ping can never reach this.
    this.setPreviewState("offline");
  }

  // ── view side ─────────────────────────────────────────────────────────────

  attachView(ws: WebSocket, hooks: { onRefreshPairing?: () => void; onRenameDevice?: (deviceId: string, name: string) => void } = {}): void {
    this.views.add(ws);
    ws.on("close", (code, reason) => {
      this.log("warn", `view ws closed: code=${code} reason=${reason.toString("utf8") || "-"} (views left: ${this.views.size - 1})`);
      this.views.delete(ws);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const msg = parseViewClient(data.toString());
      if (!msg) return;
      if (msg.type === "capture") {
        const captureId = randomUUID();
        if (!this.requestCapture(captureId, msg.note)) {
          this.broadcastToViews({ type: "error", code: "NO_CAMERA", message: "no camera uplink connected" });
        }
      } else if (msg.type === "select_device") {
        this.selectDevice(msg.deviceId);
      } else if (msg.type === "rename_device") {
        hooks.onRenameDevice?.(msg.deviceId, msg.name);
      } else if (msg.type === "refresh_pairing") {
        hooks.onRefreshPairing?.();
      }
    });
    const active = this.activeCam();
    ws.send(
      JSON.stringify({
        type: "meta",
        camera: active ? { connected: true, name: active.name, ...active.meta } : { connected: false },
        preview: this.config.preview,
        paired: true,
      } satisfies ViewServerMessage),
    );
    this.broadcastDevicesTo(ws);
    // initial preview state so a freshly (re)loaded view renders the correct
    // canvas/placeholder instead of guessing (reason carries the offline
    // verdict so a mid-incident reload still says "connection lost")
    ws.send(JSON.stringify({ type: "preview_state", on: this.previewState === "on", ...(this.previewState === "offline" ? { reason: "offline" } : {}) } satisfies ViewServerMessage));
    // only replay a cached frame while the stream is confirmed fresh; a stale
    // frame would flash an old picture before the "preview off" state lands
    if (this.previewState === "on" && active?.lastFrame && ws.readyState === ws.OPEN) ws.send(active.lastFrame, { binary: true });
  }

  viewCount(): number {
    return this.views.size;
  }

  /** Update one device's display name and re-broadcast the device list. */
  renameDevice(deviceId: string, name: string): void {
    const cam = this.cameras.get(deviceId);
    if (cam) cam.name = name;
    this.broadcastDevices();
  }

  /** Switch which phone's frames / shutter the view follows. */
  selectDevice(deviceId: string): void {
    if (!this.cameras.has(deviceId)) return;
    const prevActive = this.activeDeviceId;
    if (prevActive === deviceId) return;
    this.activeDeviceId = deviceId;
    this.preferredDeviceId = deviceId;
    if (prevActive) this.sendControl(prevActive, { type: "pause_preview" });
    this.sendControl(deviceId, { type: "resume_preview" });
    this.broadcastDevices();
    this.pushActiveFrameToViews();
  }

  /** Send one control message to a specific phone uplink. */
  private sendControl(deviceId: string, msg: CameraControl): void {
    const cam = this.cameras.get(deviceId);
    if (cam && cam.ws.readyState === cam.ws.OPEN) cam.ws.send(JSON.stringify(msg));
  }

  private pushActiveFrameToViews(): void {
    const active = this.activeCam();
    // replay the cached frame only when the preview is confirmed streaming;
    // otherwise views would briefly show an old picture before the stall
    // watchdog reports "preview off"
    if (this.previewState === "on" && active?.lastFrame) {
      for (const view of this.views) {
        if (view.readyState === view.OPEN) view.send(active.lastFrame, { binary: true });
      }
    }
    // re-announce frame size/rotation for the newly selected device
    if (active) {
      this.broadcastToViews({ type: "frame_meta", width: active.meta.width ?? 0, height: active.meta.height ?? 0, ...(active.meta.rotation !== void 0 ? { rotation: active.meta.rotation } : {}) });
    }
  }

  private activeCam(): CamState | undefined {
    return this.activeDeviceId ? this.cameras.get(this.activeDeviceId) : undefined;
  }

  private broadcastDevices(): void {
    for (const view of this.views) this.broadcastDevicesTo(view);
  }

  private broadcastDevicesTo(view: WebSocket): void {
    if (view.readyState !== view.OPEN) return;
    view.send(
      JSON.stringify({
        type: "devices",
        devices: [...this.cameras.values()].map((c, i) => {
          const id = [...this.cameras.keys()][i]!;
          return { id, name: c.name, active: id === this.activeDeviceId, ...(c.meta.appVersion !== void 0 ? { appVersion: c.meta.appVersion } : {}) };
        }),
      } satisfies ViewServerMessage),
    );
  }

  // ── capture correlation ───────────────────────────────────────────────────

  /** Ask the ACTIVE phone to shoot. Returns the captureId, or null when none. */
  requestCapture(captureId: string, note?: string, opts: { direct?: boolean; onImage?: (admitted: AdmittedImage) => void; onFail?: (reason: string) => void } = {}): string | null {
    const active = this.activeCam();
    if (!active || active.ws.readyState !== active.ws.OPEN) return null;
    this.pendingCaptures.set(captureId, { note, requestedAt: Date.now(), direct: opts.direct, onImage: opts.onImage, onFail: opts.onFail });
    active.ws.send(JSON.stringify({ type: "capture", captureId, ...(note ? { note } : {}), ...(opts.direct ? { direct: true } : {}) } satisfies CameraControl));
    this.broadcastToViews({ type: "capture_pending", captureId, ...(note ? { note } : {}) });
    this.gcCaptures();
    return captureId;
  }

  consumeCapture(captureId: string): PendingCapture | null {
    const pending = this.pendingCaptures.get(captureId);
    if (!pending) return null;
    this.pendingCaptures.delete(captureId);
    return pending;
  }

  noteFor(captureId: string): string | undefined {
    return this.pendingCaptures.get(captureId)?.note;
  }

  private gcCaptures(): void {
    const cutoff = Date.now() - this.captureTimeoutMs;
    for (const [id, p] of this.pendingCaptures) {
      if (p.requestedAt < cutoff) {
        p.onFail?.("拍摄请求已超时");
        this.pendingCaptures.delete(id);
      }
    }
  }

  /**
   * Model tool: ask the ACTIVE phone to shoot and settle with the uploaded
   * photo. The photo bypasses the user-selected capture mode entirely — the
   * /upload handler calls onImage instead of routing to composer/folder.
   */
  requestCaptureDirect(note: string | undefined, timeoutMs: number): Promise<{ ok: true; admitted: AdmittedImage } | { ok: false; reason: string }> {
    return new Promise((resolve) => {
      const active = this.activeCam();
      if (!active || active.ws.readyState !== active.ws.OPEN) {
        resolve({ ok: false, reason: "没有已连接的手机" });
        return;
      }
      const captureId = randomUUID();
      let settled = false;
      const timer = setTimeout(() => finish({ ok: false, reason: `拍照超时(手机未在 ${Math.round(timeoutMs / 1000)} 秒内上传照片)` }), timeoutMs);
      const finish = (r: { ok: true; admitted: AdmittedImage } | { ok: false; reason: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingCaptures.delete(captureId);
        resolve(r);
      };
      this.requestCapture(captureId, note, { direct: true, onImage: (admitted) => finish({ ok: true, admitted }), onFail: (reason) => finish({ ok: false, reason }) });
      if (!this.pendingCaptures.has(captureId)) {
        // requestCapture bailed (device dropped between the two checks)
        clearTimeout(timer);
        resolve({ ok: false, reason: "没有已连接的手机" });
      }
    });
  }

  /**
   * Model tool: park the active phone's camera into the idle state, or wake
   * it back up. Settles with the phone's camera_state receipt (or a timeout).
   * Old App builds (no appVersion in hello) never answer camera_idle/resume —
   * fail fast with an actionable reason instead of burning the 8s timeout.
   */
  requestCameraState(action: "camera_idle" | "camera_resume", timeoutMs: number): Promise<CameraStateOutcome> {
    return new Promise((resolve) => {
      const active = this.activeCam();
      if (!active || active.ws.readyState !== active.ws.OPEN || this.activeDeviceId === null) {
        resolve({ ok: false, reason: "没有已连接的手机" });
        return;
      }
      if (active.meta.appVersion === undefined) {
        resolve({ ok: false, reason: "手机 App 版本过旧(需 ≥ 1.0.4),请先更新手机端" });
        return;
      }
      const reqId = randomUUID();
      const deviceId = this.activeDeviceId;
      let settled = false;
      const timer = setTimeout(() => finish({ ok: false, reason: "手机未在时限内回执(可能不在前台或已断连)" }), timeoutMs);
      const finish = (r: CameraStateOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cameraStateWaiters.delete(reqId);
        resolve(r);
      };
      this.cameraStateWaiters.set(reqId, { deviceId, settle: finish });
      this.sendControl(deviceId, { type: action, reqId } satisfies CameraControl);
    });
  }

  broadcastToViews(msg: ViewServerMessage): void {
    const text = JSON.stringify(msg);
    for (const view of this.views) {
      if (view.readyState === view.OPEN) view.send(text);
    }
  }

  stats(): { connected: boolean; fps: number; lastFrameAt: number; views: number; devices: number } {
    const active = this.activeCam();
    return {
      connected: this.cameras.size > 0,
      fps: active ? Math.round(active.measuredFps * 10) / 10 : 0,
      lastFrameAt: active?.lastFrameAt ?? 0,
      views: this.views.size,
      devices: this.cameras.size,
    };
  }
}

function safeJson(text: string): CameraControl | null {
  try {
    return JSON.parse(text) as CameraControl;
  } catch {
    return null;
  }
}

function parseViewClient(text: string): ViewClientMessage | null {
  try {
    return JSON.parse(text) as ViewClientMessage;
  } catch {
    return null;
  }
}
