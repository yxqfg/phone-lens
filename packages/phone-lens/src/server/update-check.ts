/**
 * Host-side plugin update check: compare the running version against the
 * latest Gitee release tag (same feed the phone App uses). The result surfaces
 * as a one-line colored hint in the floating panel — never a dialog.
 *
 * Mirrors apk-link.ts's hygiene: constant https://gitee.com API URL, short
 * abort timeout, success-only caching with a longer TTL, and in-flight
 * dedupe. Failures stay silent (the hint simply doesn't render).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GITEE_LATEST_API = "https://gitee.com/api/v5/repos/qianfengbingtang/phone-lens/releases/latest";
/** A fresh result suppresses further API calls for 12h (host sits open all day). */
const OK_TTL_MS = 12 * 60 * 60 * 1000;
/** A failed check retries after 30min instead of hammering the API per panel-open. */
const FAIL_TTL_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 6_000;

export interface HostUpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
  checkedAt: number;
}

let cached: { info: HostUpdateInfo | null; at: number } | null = null;
let inflight: Promise<HostUpdateInfo | null> | null = null;

/** Running plugin version. `../package.json` matches http.ts's hostVersion():
 * tsdown flattens every entry into lib/*.js, so ONE level up is the package
 * root in BOTH bundle shapes (lib/index.js, lib/dev.js). A failed read (or
 * "0.0.0") makes the caller report null — never a bogus "update available". */
function ownVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version?: string };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Three-segment x.y.z compare, tolerant of a leading "v" (missing segments = 0). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/, "")
      .split(".")
      .map((seg) => Number.parseInt(seg, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/** Latest release tag from the trusted Gitee feed, or null on any failure. */
async function fetchLatestGiteeTag(): Promise<string | null> {
  try {
    const url = new URL(GITEE_LATEST_API);
    // request-URL hygiene: only https on the trusted release host
    if (url.protocol !== "https:" || url.host !== "gitee.com") return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: unknown };
    return typeof data.tag_name === "string" && data.tag_name.trim() ? data.tag_name.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Check for a host-side plugin update (cached; called per panel-open).
 * Returns null when the feed is unreachable — the UI then shows nothing.
 */
export async function checkHostUpdate(): Promise<HostUpdateInfo | null> {
  if (cached && Date.now() - cached.at < (cached.info ? OK_TTL_MS : FAIL_TTL_MS)) return cached.info;
  if (inflight) return inflight;
  inflight = (async () => {
    const current = ownVersion();
    let info: HostUpdateInfo | null = null;
    const latest = current === "0.0.0" ? null : await fetchLatestGiteeTag();
    if (latest && current !== "0.0.0") {
      info = { current, latest, updateAvailable: compareVersions(latest, current) > 0, checkedAt: Date.now() };
    }
    cached = { info, at: Date.now() };
    return info;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
