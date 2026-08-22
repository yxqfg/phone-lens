/** Shared vocabulary for the phone-lens host half. */

/** Normalized plugin config (see cordis.patch.yml / config.ts defaults). */
export interface LensConfig {
  server: { host: string; port: number };
  limits: {
    maxUploadBytes: number;
    allowedTypes: string[];
    uploadsPerMinute: number;
    previewFrameMaxBytes: number;
    maxStoredUploads: number;
  };
  pairing: { codeTtlMs: number };
  preview: { maxWidth: number; maxHeight: number; fps: number; jpegQuality: number };
  inject: { mode: "followup" | "steer"; notePrefix: string };
  target: { mode: "latest" | "pinned"; pinnedSessionId: string | null };
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
  | { type: "hello"; width: number; height: number; fps: number; rotation?: number }
  | { type: "bye" }
  | { type: "set_preview"; maxWidth: number; maxHeight: number; fps: number; jpegQuality: number }
  | { type: "capture"; captureId: string; note?: string }
  | { type: "capture_result"; captureId: string; status: "taken" | "declined" | "failed"; detail?: string }
  // phone→host: make THIS phone the active preview/shutter device
  | { type: "claim_active" }
  // host→phone: another device owns the PC preview; stop/start streaming
  | { type: "pause_preview" }
  | { type: "resume_preview" };

/** JSON message on the view websocket. */
export type ViewServerMessage =
  | { type: "meta"; camera: { connected: boolean; width?: number; height?: number; fps?: number; rotation?: number; name?: string }; preview: { maxWidth: number; maxHeight: number; fps: number; jpegQuality: number }; paired: boolean }
  | { type: "frame_meta"; width: number; height: number; rotation?: number }
  | { type: "devices"; devices: { id: string; name: string; active: boolean }[] }
  | { type: "device"; online: boolean; name?: string }
  | { type: "capture_pending"; captureId: string; note?: string }
  | { type: "pending_image"; attachmentId: string; name?: string }
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
  BAD_REQUEST: "BAD_REQUEST",
  INTERNAL: "INTERNAL",
} as const;
