import type { LensConfig } from "./types.js";

/** Coerce an unknown config object (cordis patch row / CLI overrides) into LensConfig. */
export function normalizeConfig(raw: unknown): LensConfig {
  const r = (raw ?? {}) as Record<string, any>;
  const server = (r.server ?? {}) as Record<string, any>;
  const limits = (r.limits ?? {}) as Record<string, any>;
  const pairing = (r.pairing ?? {}) as Record<string, any>;
  const preview = (r.preview ?? {}) as Record<string, any>;
  const inject = (r.inject ?? {}) as Record<string, any>;
  const target = (r.target ?? {}) as Record<string, any>;
  const app = (r.app ?? {}) as Record<string, any>;
  // App download sources: Gitee first (CN-friendly), GitHub as the fallback link.
  // Points at the Gitee release carrying the newest APK — the App itself has
  // not changed since v0.2.0; bump this only when a new APK ships.
  const GITEE_APK = "https://gitee.com/qianfengbingtang/phone-lens/releases/download/v0.2.0/app-release.apk";
  const GITHUB_APK = "https://github.com/yxqfg/phone-lens/releases/latest/download/app-release.apk";
  const giteeUrl = typeof app.giteeUrl === "string" && app.giteeUrl ? app.giteeUrl : GITEE_APK;
  const allowed = Array.isArray(limits.allowedTypes) ? limits.allowedTypes.filter((t: unknown): t is string => typeof t === "string") : undefined;
  const mode = inject.mode === "steer" ? "steer" : "followup";
  return {
    server: {
      host: typeof server.host === "string" && server.host ? server.host : "0.0.0.0",
      port: Number.isInteger(server.port) && server.port! > 0 && server.port! < 65536 ? server.port! : 8791,
    },
    limits: {
      maxUploadBytes: positiveInt(limits.maxUploadBytes, 10 * 1024 * 1024),
      allowedTypes: allowed && allowed.length > 0 ? allowed : ["image/jpeg", "image/png"],
      uploadsPerMinute: positiveInt(limits.uploadsPerMinute, 10),
      previewFrameMaxBytes: positiveInt(limits.previewFrameMaxBytes, 512 * 1024),
      // keep the local upload archive bounded: oldest files are pruned past this
      maxStoredUploads: positiveInt(limits.maxStoredUploads, 200),
    },
    pairing: { codeTtlMs: positiveInt(pairing.codeTtlMs, 15 * 60 * 1000) },
    preview: {
      maxWidth: positiveInt(preview.maxWidth, 854),
      maxHeight: positiveInt(preview.maxHeight, 480),
      fps: clampInt(preview.fps, 1, 30, 10),
      jpegQuality: clampInt(preview.jpegQuality, 20, 95, 70),
    },
    inject: {
      mode,
      notePrefix: typeof inject.notePrefix === "string" ? inject.notePrefix : "[手机拍照]",
    },
    target: {
      mode: target.mode === "pinned" ? "pinned" : "latest",
      pinnedSessionId: typeof target.pinnedSessionId === "string" && target.pinnedSessionId ? target.pinnedSessionId : null,
    },
    app: {
      giteeUrl,
      githubUrl: typeof app.githubUrl === "string" && app.githubUrl ? app.githubUrl : GITHUB_APK,
      // The QR encodes this URL; defaults to the Gitee release asset.
      downloadUrl: typeof app.downloadUrl === "string" && app.downloadUrl ? app.downloadUrl : giteeUrl,
    },
  };
}

function positiveInt(value: unknown, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  const n = value as number;
  return Math.min(max, Math.max(min, n));
}
