/** Shared vocabulary for the phone-lens host half. */

/** Normalized plugin config (see cordis.patch.yml / config.ts defaults). */
export interface LensConfig {
  server: { host: string; port: number };
  limits: {
    maxUploadBytes: number;
    allowedTypes: string[];
    previewFrameMaxBytes: number;
    maxStoredUploads: number;
  };
  pairing: { codeTtlMs: number };
  preview: { maxWidth: number; maxHeight: number; fps: number; jpegQuality: number };
  inject: { mode: "followup" | "steer"; notePrefix: string };
  target: { mode: "latest" | "pinned"; pinnedSessionId: string | null };
  /** Where the phone App APK can be fetched from (QR + fallback links). */
  app: { downloadUrl: string; giteeUrl: string; githubUrl: string };
}

/** Minimal structural view of a dsh ImageAttachmentRef (docs/dsh-caps.md Q1). */
export interface ImageAttachmentRef {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
  originalDimensions?: { width: number; height: number };
}

/** One durable image ready for session injection. */
export interface AdmittedImage {
  ref: ImageAttachmentRef;
  /** Where the bytes physically landed: "attachments" (dsh store) or "file" (fallback dir). */
  storage: "attachments" | "file";
  /** Fallback file path when storage === "file". */
  filePath?: string;
}

/** Result of the deliver step. */
export interface DeliveryReceipt {
  ok: boolean;
  sessionId: string | null;
  mode: "followup" | "steer" | "none";
  reason?: string;
}

/** Settle shape for the model tools' camera_idle / camera_resume requests. */
export type CameraStateOutcome = { ok: true; state: "idle" | "live" } | { ok: false; reason: string };

/**
 * Settle shape for the model tools' camera_zoom set/step/query requests.
 * min/max are the device's hardware zoom range (omitted when unknown).
 */
export type ZoomOutcome = { ok: true; factor: number; min?: number; max?: number } | { ok: false; reason: string };

/**
 * Settle shape for the model tools' camera_lens switch/query requests.
 * `available` lists the directions the device can switch to (omitted when
 * the phone did not report them).
 */
export type LensStateOutcome = { ok: true; lens: "front" | "back"; available?: string[] } | { ok: false; reason: string };

/** Persistent paired-device record. The raw token never touches disk — only its SHA-256. */
export interface DeviceRecord {
  deviceId: string;
  name: string;
  model: string;
  tokenHash: string;
  firstPairedAt: number;
  lastSeenAt: number;
}

/** Live pairing-code state. */
export interface PairingState {
  code: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

/** JSON message on the camera websocket (text frames). */
export type CameraControl =
  | { type: "bye" }
  | { type: "set_preview"; maxWidth: number; maxHeight: number; fps: number; jpegQuality: number }
  // direct=true: model-initiated capture (phone_take_photo tool) — the phone
  // shoots and uploads as usual, but the host routes the photo to the model
  // instead of the user-selected capture mode
  | { type: "capture"; captureId: string; note?: string; direct?: boolean }
  | { type: "capture_result"; captureId: string; status: "taken" | "declined" | "failed"; detail?: string }
  // phone→host: make THIS phone the active preview/shutter device
  | { type: "claim_active" }
  // app-level keepalive (both directions): the phone pings every 10s and the
  // host answers pong — a half-open TCP (wifi switch, host reboot) would
  // otherwise stay "connected" for OS-internal timeouts on both sides
  | { type: "ping" }
  | { type: "pong" }
  // host→phone: another device owns the PC preview; stop/start streaming
  | { type: "pause_preview" }
  | { type: "resume_preview" }
  // host→phone (model tools): park the camera into the idle-shutdown state,
  // or wake it back up and resume streaming. The phone answers camera_state.
  | { type: "camera_idle"; reqId?: string }
  | { type: "camera_resume"; reqId?: string }
  // phone→host: receipt for camera_idle/camera_resume (reqId echoed back)
  | { type: "camera_state"; reqId?: string; state: "idle" | "live" | "failed" }
  // host→phone (model tools, App ≥ 1.1.2): set/step/query the zoom ratio.
  // factor = absolute target (2.0 = 2x); step = relative nudge (positive zooms
  // in); neither = pure query of the current ratio. The phone answers zoom_result.
  | { type: "camera_zoom"; reqId?: string; factor?: number; step?: number }
  // phone→host: receipt for camera_zoom (reqId echoed back)
  | { type: "zoom_result"; reqId?: string; ok: boolean; factor?: number; min?: number; max?: number; reason?: string }
  // host→phone (model tools, App ≥ 1.1.3): switch the front/back lens, or
  // (lens omitted) query which lens is live. The phone answers lens_result.
  | { type: "camera_lens"; reqId?: string; lens?: "front" | "back" }
  // phone→host: receipt for camera_lens (reqId echoed back). `lens` = the
  // direction now live; `available` = directions this device can switch to.
  | { type: "lens_result"; reqId?: string; ok: boolean; lens?: "front" | "back"; available?: string[]; reason?: string }
  // hello carries the phone App's version for cross-end consistency hints
  // (optional: older App builds omit it and the host shows nothing)
  | { type: "hello"; width: number; height: number; fps: number; rotation?: number; appVersion?: string }
  // phone→host (App ≥ 1.1.3): fired on EVERY fresh connection, before any
  // stream starts — keeps the host's version gates truthful while the preview
  // is closed (hello only rides _startStream). A version-less copy (PackageInfo
  // unresolved) is legal; the re-announce after it resolves carries the value.
  | { type: "app_info"; appVersion?: string };

/** JSON message on the view websocket. */
export type ViewServerMessage =
  | { type: "meta"; camera: { connected: boolean; width?: number; height?: number; fps?: number; rotation?: number; name?: string }; preview: { maxWidth: number; maxHeight: number; fps: number; jpegQuality: number }; paired: boolean }
  | { type: "frame_meta"; width: number; height: number; rotation?: number }
  | { type: "devices"; devices: { id: string; name: string; active: boolean; appVersion?: string }[] }
  | { type: "device"; online: boolean; name?: string }
  // host→view: the ACTIVE phone's stream stalled (user turned preview off on
  // the phone) or resumed. `on:false` lets the web UI clear the last frame.
  // `reason:"offline"` = the LINK died (no frames AND no inbound keepalive
  // past the offline threshold — wifi drop / half-open TCP), NOT a preview
  // toggle; the UI must say "connection lost", not "preview closed".
  // Optional field: old clients ignore it (they just show the old text), and
  // old hosts never send it (client keeps legacy behavior).
  | { type: "preview_state"; on: boolean; reason?: "offline" }
  | { type: "capture_pending"; captureId: string; note?: string }
  | { type: "pending_image"; attachmentId: string; name?: string }
  // folder-only save: the photo bypassed the composer; surface a local hint.
  | { type: "upload_saved"; name?: string; dir: string }
  // host→view: a phone completed pairing (POST /pair). The one-time code just
  // burned with it — views rotate the QR immediately instead of waiting for
  // the phone's uplink, so a second scan never hits a dead code.
  | { type: "paired"; name?: string }
  | { type: "injected"; captureId?: string; attachmentId: string; sessionId: string | null; ok: boolean; reason?: string; name?: string }
  | { type: "upload"; attachmentId: string; storage: string; name?: string }
  | { type: "error"; code: string; message?: string };

export type ViewClientMessage =
  | { type: "capture"; note?: string }
  | { type: "select_device"; deviceId: string }
  | { type: "rename_device"; deviceId: string; name: string }
  | { type: "refresh_pairing" }
  | { type: "ping" };

/** Wire error body. */
export interface ErrorBody {
  error: { code: string; message: string };
}

export const ERROR_CODES = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  PAIR_CODE_INVALID: "PAIR_CODE_INVALID",
  PAIR_CODE_EXPIRED: "PAIR_CODE_EXPIRED",
  RATE_LIMITED: "RATE_LIMITED",
  TYPE_NOT_ALLOWED: "TYPE_NOT_ALLOWED",
  TOO_LARGE: "TOO_LARGE",
  BAD_MAGIC: "BAD_MAGIC",
  STORE_FAILED: "STORE_FAILED",
  NO_TARGET: "NO_TARGET",
  NO_CAMERA: "NO_CAMERA",
  CAPTURE_TIMEOUT: "CAPTURE_TIMEOUT",
  LOOPBACK_ONLY: "LOOPBACK_ONLY",
  BAD_HOST: "BAD_HOST",
  BAD_REQUEST: "BAD_REQUEST",
  INTERNAL: "INTERNAL",
} as const;
