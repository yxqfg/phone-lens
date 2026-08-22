import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { CameraControl, LensConfig, ViewClientMessage, ViewServerMessage } from "../types.js";

/** Per-device camera uplink state; multiple phones coexist without kicking. */
interface CamState {
  ws: WebSocket;
  name: string;
  meta: { width?: number; height?: number; fps?: number; rotation?: number };
  lastFrame: Buffer | null;
  lastFrameAt: number;
  frameCount: number;
  windowStart: number;
  measuredFps: number;
}

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
  private views = new Set<WebSocket>();
  /** captureId → { note, requestedAt } until the matching upload lands or timeout. */
  private pendingCaptures = new Map<string, { note?: string; requestedAt: number }>();
  private readonly captureTimeoutMs = 60_000;

  constructor(
    private readonly config: LensConfig,
    private readonly log: (level: "info" | "warn", msg: string) => void,
  ) {}

  // ── camera side ───────────────────────────────────────────────────────────

  attachCamera(deviceId: string, ws: WebSocket, name: string): void {
    const prev = this.cameras.get(deviceId);
    if (prev) {
      try {
        prev.ws.close(1000, "new-instance");
      } catch {}
      this.cameras.delete(deviceId);
    }
    const cam: CamState = { ws, name, meta: {}, lastFrame: null, lastFrameAt: 0, frameCount: 0, windowStart: Date.now(), measuredFps: 0 };
    this.cameras.set(deviceId, cam);
    if (this.activeDeviceId === null) this.activeDeviceId = deviceId;
    // only the ACTIVE device streams to the PC; others pause immediately
    if (this.activeDeviceId === deviceId) this.sendControl(deviceId, { type: "resume_preview" });
    else this.sendControl(deviceId, { type: "pause_preview" });
    this.log("info", `camera uplink: ${name} (${deviceId.slice(0, 8)})`);

    ws.on("close", () => {
      if (this.cameras.get(deviceId)?.ws === ws) this.detachCamera(deviceId);
    });
    ws.on("message", (data, isBinary) => {
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
    if (cam) this.cameras.delete(deviceId);
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
    for (const cam of this.cameras.values()) {
      if (cam.ws.readyState === cam.ws.OPEN) cam.ws.ping();
    }
  }

  private onCameraControl(deviceId: string, msg: CameraControl | null): void {
    if (!msg) return;
    const cam = this.cameras.get(deviceId);
    if (!cam) return;
    switch (msg.type) {
      case "hello":
        cam.meta = { width: msg.width, height: msg.height, fps: msg.fps, ...(msg.rotation !== void 0 ? { rotation: msg.rotation } : {}) };
        if (this.activeDeviceId === deviceId) {
          this.broadcastToViews({ type: "frame_meta", width: msg.width, height: msg.height, ...(msg.rotation !== void 0 ? { rotation: msg.rotation } : {}) });
        }
        break;
      case "bye":
        this.detachCamera(deviceId);
        break;
      case "claim_active":
        // phone asked to become the active device → switch the view to it.
        this.selectDevice(deviceId);
        break;
      case "capture_result":
        if (msg.status !== "taken") {
          this.pendingCaptures.delete(msg.captureId);
          this.broadcastToViews({ type: "error", code: "CAPTURE_DECLINED", message: `phone reported ${msg.status}${msg.detail ? `: ${msg.detail}` : ""}` });
        }
        break;
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
      for (const view of this.views) {
        if (view.readyState === view.OPEN) view.send(frame, { binary: true });
      }
    }
  }

  // ── view side ─────────────────────────────────────────────────────────────

  attachView(ws: WebSocket, hooks: { onRefreshPairing?: () => void; onRenameDevice?: (deviceId: string, name: string) => void } = {}): void {
    this.views.add(ws);
    ws.on("close", () => this.views.delete(ws));
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
    if (active?.lastFrame && ws.readyState === ws.OPEN) ws.send(active.lastFrame, { binary: true });
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
    if (active?.lastFrame) {
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
          return { id, name: c.name, active: id === this.activeDeviceId };
        }),
      } satisfies ViewServerMessage),
    );
  }

  // ── capture correlation ───────────────────────────────────────────────────

  /** Ask the ACTIVE phone to shoot. Returns the captureId, or null when none. */
  requestCapture(captureId: string, note?: string): string | null {
    const active = this.activeCam();
    if (!active || active.ws.readyState !== active.ws.OPEN) return null;
    this.pendingCaptures.set(captureId, { note, requestedAt: Date.now() });
    active.ws.send(JSON.stringify({ type: "capture", captureId, ...(note ? { note } : {}) } satisfies CameraControl));
    this.broadcastToViews({ type: "capture_pending", captureId, ...(note ? { note } : {}) });
    this.gcCaptures();
    return captureId;
  }

  consumeCapture(captureId: string): { note?: string } | null {
    const pending = this.pendingCaptures.get(captureId);
    if (!pending) return null;
    this.pendingCaptures.delete(captureId);
    return { note: pending.note };
  }

  noteFor(captureId: string): string | undefined {
    return this.pendingCaptures.get(captureId)?.note;
  }

  private gcCaptures(): void {
    const cutoff = Date.now() - this.captureTimeoutMs;
    for (const [id, p] of this.pendingCaptures) {
      if (p.requestedAt < cutoff) this.pendingCaptures.delete(id);
    }
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
