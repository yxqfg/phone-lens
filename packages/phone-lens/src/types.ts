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

/**
 * Settle shape for the model tools' camera_torch on/off/query requests.
 * `on` = torch state after the operation (query echoes the current state).
 */
export type TorchStateOutcome = { ok: true; on: boolean } | { ok: false; reason: string };

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
  // host→phone (model tools, App ≥ 1.1.6): turn the torch (flashlight) on or
  // off, or (on omitted) query its state. The phone answers torch_result.
  | { type: "camera_torch"; reqId?: string; on?: boolean }
  // phone→host: receipt for camera_torch (reqId echoed back). `on` = the
  // torch state after the operation / the current state for a pure query.
  | { type: "torch_result"; reqId?: string; ok: boolean; on?: boolean; reason?: string }
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
  | { type: "error"; code: string; message?: string };

export type ViewClientMessage =
  | { type: "capture"; note?: string }
  | { type: "select_device"; deviceId: string }
  | { type: "rename_device"; deviceId: string; name: string }
  | { type: "refresh_pairing" };

/** Wire error body. */
export interface ErrorBody {
  error: { code: string; message: string };
}

// ── Work (Beta) domain ────────────────────────────────────────────────────────
// Session mirroring + remote control over /ws/work. Gated behind the
// workBetaEnabled app setting: when off, the endpoint refuses upgrades and the
// bridge subscribes to NOTHING — the camera receiver must stay untouched.

/**
 * A durable session event as the host records it (SessionWireEvent shape we
 * rely on). We keep the typing loose: the wire event is forwarded verbatim and
 * the phone renders defensively — unknown shapes degrade to a plain text row.
 */
export interface WorkWireEvent {
  type: string;
  seq: number;
  time: number;
  data?: unknown;
  ignorable?: boolean;
}

/** One assistant streaming frame (delta chunk of the in-flight reply). */
export interface WorkStreamFrame {
  type: "start" | "chunk" | "end";
  attemptId?: string;
  revision?: number;
  turn?: number;
  step?: number;
  index?: number;
  time?: number;
  /** Chunk payload: host passes through whatever the event carried. */
  chunk?: unknown;
  /** end frame only: why the stream ended (committed / abandoned / interrupted). */
  outcome?: unknown;
}

/** Compact row of the session list (mirrors sessionController.list() fields). */
export interface WorkSessionSummary {
  sessionId: string;
  title?: string;
  updatedAt?: number;
  running?: boolean;
  blank?: boolean;
  /** Working directory of the session (grouping key on the phone). */
  cwd?: string;
}

/** One image riding a work_send — becomes a base64 `image` part of the prompt
 *  (the host's sessionController.prompt admits it natively; mediaType must be
 *  image/jpeg or image/png to pass the attachment admission). */
export interface WorkSendImage {
  /** "image/jpeg" | "image/png" */
  mediaType: string;
  /** base64 payload, no data: prefix */
  data: string;
  name?: string;
}

/** Slash command descriptor mirrored from the host CommandRuntime. */
export interface WorkCommandInfo {
  /** Canonical lowercase name (without the leading slash). */
  name: string;
  description?: string;
  /** Alternative spellings that also select this command (zh/en builtins). */
  aliases?: string[];
  /** Whether the command accepts composer attachments. */
  attachments?: boolean;
  /** Placeholder hint for free-form input. */
  hint?: string;
}

/** @-mention candidate: file/dir path or a referenced session. */
export interface WorkMentionFile {
  path: string;
  kind: "file" | "directory";
}
export interface WorkMentionSession {
  label: string;
  title?: string;
  /** Canonical `@[label](dsh-session:…)` text to insert. */
  mention: string;
}

/** One row of the work_devices presence broadcast (contract frame 1). */
export interface WorkDeviceRow {
  /** Paired device id (devices.json key); "" for loopback debug links. */
  deviceId: string;
  /** Attach-time snapshot of the paired device name ("本机调试" without a record). */
  name: string;
  /**
   * Same value as `name`. The contract text and the design doc disagree on
   * the field name (deviceName vs name) — both are sent until the contract
   * text settles on one; consumers read either.
   */
  deviceName: string;
  /** The session this device currently mirrors; null = list page / none. */
  sessionId: string | null;
  /** Working directory of that session (host cwdCache); null = unknown. */
  cwd: string | null;
  /** Host-computed: ws OPEN and lastSeenAt fresh within PRESENCE_FRESH_MS. */
  online: boolean;
  /** Last inbound heartbeat on the live connection table (per-frame — NOT
   *  the devices.json field of the same name). */
  lastSeenAt: number;
}

/** Host→phone: work channel handshake (first frame after the upgrade). */
export type WorkServerMessage =
  | { type: "work_hello"; enabled: true; version: string }
  | { type: "session_list"; sessions: WorkSessionSummary[] }
  // the host command registry changed — drop any phone-side command cache
  | { type: "commands_changed" }
  // full or incremental baseline for the subscribed session (events in order).
  // A >8MB baseline splits across several of these frames on EVENT boundaries
  // (same type, merge-by-seq is idempotent) — never a byte-cut frame.
  | { type: "session_snapshot"; sessionId: string; events: WorkWireEvent[]; lastSeq: number; hasMore: boolean }
  | { type: "session_event"; sessionId: string; event: WorkWireEvent }
  | { type: "stream_frame"; sessionId: string; frame: WorkStreamFrame }
  | { type: "session_state"; sessionId: string; running: boolean; status?: string }
  // approval visibility (Beta phase 1: read-only — the desktop still answers).
  // interactionIds (contract 4): the host-side ids of live interactive cards
  // for this session — the phone reconciles pendingRequests against them so a
  // lost approval_resolved self-heals within one poll period. Empty array =
  // no card is pending (a deliberate clear, unlike an absent field).
  | {
      type: "approval_state";
      sessionId: string;
      pending: { id: string; toolName?: string; reason?: string }[];
      interactionIds?: string[];
    }
  // device presence list (contract 1): broadcast on attach/close/subscribe
  // flips + a 10s presence timer; `online` is host-computed (25s window)
  | { type: "work_devices"; devices: WorkDeviceRow[] }
  // the session became writable again (desktop tap or phone unarchive) — the
  // phone clears its archived banner (contract 2)
  | { type: "session_unarchived"; sessionId: string }
  // interactive approval/question card (Beta phase 2): full payload forwarded
  // the moment the host's waterfall hands the request to every answerer —
  // whichever end answers FIRST wins (waterfall semantics), the other end's
  // card is torn down by approval_resolved
  | {
      type: "approval_request";
      sessionId: string;
      id: string;
      kind: "approval" | "question";
      toolName?: string;
      callId?: string;
      reason?: string;
      displayReason?: string;
      /** question kind only: the model's prompts (single/multi select etc.) */
      questions?: WorkQuestionItem[];
    }
  // the request was settled (either end): phone tears down its card
  | { type: "approval_resolved"; sessionId: string; id: string; outcome?: string }
  // the session was archived on the desktop while the phone sat in it — the
  // phone shows a persistent banner; sends get rejected with the same reason
  | { type: "session_archived"; sessionId: string }
  // a session's model selection changed (phone A switched, or the desktop
  // did) — subscribers re-render their model chip; the initiator also gets
  // its work_ack with the authoritative catalog
  | { type: "model_changed"; sessionId: string; provider: string; model: string; reasoningEffort?: string }
  // receipt for any phone→host request (reqId echoed)
  | { type: "work_ack"; reqId: string; ok: boolean; reason?: string; data?: unknown }
  | { type: "error"; code: string; message?: string }
  | { type: "pong" };

/** Phone→host work requests. Everything is client-triggered (AGENTS.md #22). */
export type WorkClientMessage =
  | { type: "ping" }
  | { type: "session_list_req"; reqId: string }
  // subscribe / unsubscribe (empty sessionId = unsubscribe, normalized to null
  // on the host). sinceSeq (contract 3, optional): the snapshot baseline is
  // filtered to seq > sinceSeq — a phone that already holds durable rows
  // re-subscribes incrementally; omitting it (older clients) = full snapshot.
  | { type: "session_subscribe"; reqId: string; sessionId: string; sinceSeq?: number }
  // mint a blank session (cwd XOR workspaceId — dsh rejects both); the group
  // "+" button passes the group's representative cwd so the session lands in
  // the same phone-side grouping bucket
  | { type: "session_create"; reqId: string; cwd?: string; workspaceId?: string }
  // fork (desktop turn-tail parity): duplicate the session's event prefix up
  // to and INCLUDING atSeq into a new session. Omitting atSeq forks from the
  // latest completed turn. title = the source's display title, used for the
  // desktop-style "标题 (1)" increment rename of the child (best-effort).
  | { type: "session_fork"; reqId: string; sessionId: string; atSeq?: number; title?: string }
  // archive / unarchive (workspaceController parity with the desktop's list
  // context menu). Archiving a running session without stopActivity is
  // rejected by the host (workspace/session-active) — surfaced via ack reason.
  | { type: "session_archive"; reqId: string; sessionId: string; unarchive?: boolean; stopActivity?: boolean }
  // sinceSeq (same shape as session_subscribe's, contract 3): turn-tail
  // refreshes pass the phone's newest durable seq so the host returns ONLY
  // the newly added events instead of the full 40-row window; omitted (older
  // clients) = full window as before. beforeSeq keeps its paging meaning.
  | { type: "history_page"; reqId: string; sessionId: string; beforeSeq?: number; maxMessages?: number; sinceSeq?: number }
  | { type: "work_send"; reqId: string; sessionId: string; requestId: string; text: string; mode?: "queue" | "steer"; images?: WorkSendImage[] }
  | { type: "work_cancel"; reqId: string; sessionId: string }
  | { type: "model_catalog_req"; reqId: string }
  | { type: "work_select_model"; reqId: string; sessionId: string; provider: string; model: string; reasoningEffort?: string }
  // slash-command directory for the session (agent-scoped view when available)
  | { type: "commands_list"; reqId: string; sessionId: string }
  // @-mention candidates for the composer (files under cwd + sessions)
  | { type: "mention_query"; reqId: string; sessionId: string; query: string }
  | { type: "file_list"; reqId: string; sessionId: string; path: string }
  | { type: "file_read"; reqId: string; sessionId: string; path: string; offsetBytes?: number; lengthBytes?: number }
  // line-count summary for one turn's workspace/changes announcement (the
  // "edited N files +X -Y" card; git-numstat parity with the desktop UI)
  | { type: "changes_summary"; reqId: string; sessionId: string; seq: number }
  // calibration helper (read-only host introspection, same beta gate)
  | { type: "debug_probe"; reqId: string }
  | { type: "debug_call"; reqId: string; service: string; method: string; args: unknown[] }
  // answer an interactive approval card: exactly the two real user outcomes —
  // never fabricated 'cancelled'/'unavailable' (those are host-internal)
  | { type: "approval_answer"; reqId: string; sessionId: string; id: string; outcome: "allowed-once" | "rejected" }
  // answer a question card: one entry per question id; selected = option
  // labels (empty + custom text = free-form reply)
  | { type: "question_answer"; reqId: string; sessionId: string; id: string; answers: { id: string; selected: string[]; custom?: string }[] };

/** One prompt inside a question card (desktop AskUserQuestionItem parity). */
export interface WorkQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
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
  NO_CAMERA: "NO_CAMERA",
  CAPTURE_TIMEOUT: "CAPTURE_TIMEOUT",
  LOOPBACK_ONLY: "LOOPBACK_ONLY",
  BAD_HOST: "BAD_HOST",
  BAD_REQUEST: "BAD_REQUEST",
  INTERNAL: "INTERNAL",
} as const;
