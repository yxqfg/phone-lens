/**
 * Dynamic APK-link resolution for the download QR.
 *
 * Gitee has no GitHub-style `releases/latest/download/<file>` short link (it
 * 302s to /repository/archive/ and 404s), so a hardcoded asset URL goes stale
 * the moment a new release ships — v1.0.0 shipped with a v0.3.11 link exactly
 * this way. Instead of bumping a constant on every release, ask Gitee's public
 * releases list API for the current asset URL and cache it; the constant in
 * config.ts is only the offline fallback and needs no per-release bump.
 */
import { GITEE_APK_DEFAULT } from "../config.js";
import type { LensConfig } from "../types.js";
import { compareVersions } from "./update-check.js";

// List endpoint + client-side compare, NOT /releases/latest — Gitee's "latest"
// endpoint returns the most-recently-EDITED release, so touching an old release
// (rename, reformat) would surface a stale APK as current (hit for real on
// 2026-11-04, see update-check.ts). Ordered by creation date; we pick the
// highest tag client-side.
const GITEE_RELEASES_API = "https://gitee.com/api/v5/repos/qianfengbingtang/phone-lens/releases?per_page=10&direction=desc";
const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 6000;

let cached: { url: string; at: number } | null = null;
let inflight: Promise<string | null> | null = null;

/** The asset URL comes from an external API response, so re-validate it before
 *  it ever reaches a QR code: https only, and only the expected release host —
 *  never localhost/loopback/private addresses or any other origin. */
function isTrustedGiteeAsset(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw.startsWith("https://")) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.host === "gitee.com";
  } catch {
    return false;
  }
}

async function fetchLatestGiteeApk(): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(GITEE_RELEASES_API, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!resp.ok) return null;
    const data: unknown = await resp.json();
    if (!Array.isArray(data)) return null;
    // Newest tag first (client-side compare), then that release's APK asset —
    // only the newest release is consulted: if it carries no trusted APK the
    // upload is broken and falling back beats silently serving an older APK.
    const rows = (data as { tag_name?: unknown; assets?: unknown }[])
      .filter((row): row is { tag_name: string; assets?: unknown } => typeof row?.tag_name === "string" && !!row.tag_name.trim())
      .sort((a, b) => compareVersions(b.tag_name.trim(), a.tag_name.trim()));
    const newest = rows[0];
    if (!newest || !Array.isArray(newest.assets)) return null;
    for (const asset of newest.assets) {
      const row = asset as { name?: unknown; browser_download_url?: unknown };
      // startsWith tolerates Gitee's double-suffix quirk (uploads have landed
      // as "app-release.apk.apk"); the trusted-host check below still gates
      // whatever URL follows the name.
      if (typeof row.name === "string" && row.name.startsWith("app-release.apk") && isTrustedGiteeAsset(row.browser_download_url)) {
        return row.browser_download_url;
      }
    }
    return null;
  } catch {
    return null; // network error / timeout / malformed body — caller falls back
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the latest APK URL (cached 10 min, in-flight deduped).
 *  Resolves null when the API is unreachable or carries no trusted asset. */
export function resolveLatestGiteeApk(): Promise<string | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.url);
  if (inflight) return inflight;
  inflight = fetchLatestGiteeApk()
    .then((url) => {
      if (url) cached = { url, at: Date.now() };
      return url;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Refresh config.app download links in place, but only while they still carry
 * the built-in defaults — an explicit user config always wins. Mutating the
 * shared config object lets the QR endpoints keep reading the plain fields.
 */
export async function refreshAppApkLinks(config: LensConfig): Promise<void> {
  if (config.app.giteeUrl !== GITEE_APK_DEFAULT) return;
  const url = await resolveLatestGiteeApk();
  if (!url) return;
  config.app.giteeUrl = url;
  if (config.app.downloadUrl === GITEE_APK_DEFAULT) config.app.downloadUrl = url;
}
