import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

/** Sliding-window rate limiter (in-memory; resets with the process). */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly windowMs: number, private readonly max: number) {}

  /** Record one hit and report whether the key is still within budget. */
  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Whether the connection originates from this machine (loopback). */
export function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return LOOPBACK.has(addr);
}

/**
 * DNS-rebinding shield: a hostile page's domain re-binds to 127.0.0.1, so the
 * connection LOOKS loopback and sails past isLoopback — but its Host header
 * still carries the attacker's DOMAIN, never an address this server is dialed
 * by. Every legitimate client (phone App, dsh web UI, desktop shell) connects
 * to an address paired/typed as an IP literal or localhost, so anything else
 * is refused. HTTP/1.0-style requests without a Host header fail the same way.
 */
export function isAllowedHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (typeof host !== "string" || host === "") return false;
  // "[::1]:8791" → ::1 ; "192.168.1.5:8791" / "localhost" → first segment
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0]!;
  return hostname.toLowerCase() === "localhost" || isIP(hostname) !== 0;
}

/**
 * CORS for the dsh Web UI page (served on another loopback port, or the
 * desktop shell's `dsh-app://` origin) so it can fetch /qr.json and /status
 * from this receiver. Only same-machine origins are echoed — a foreign page
 * must not read the pairing code, and its cross-origin JSON POST fails the
 * preflight we never answer. `dsh-app:` is a privileged scheme registered by
 * the desktop shell; only the shell's own renderer can ever present it.
 */
export function corsFor(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin === "") return {};
  try {
    const u = new URL(origin);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if ((u.protocol === "http:" && LOOPBACK.has(host)) || u.protocol === "dsh-app:") {
      return {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-lm-device, x-lm-token",
        "access-control-max-age": "600",
      };
    }
  } catch {
    /* malformed origin: no CORS headers */
  }
  return {};
}

/** Extract a stable client key for rate limiting. */
export function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

/** Read the device auth headers, if present. */
export function deviceAuth(req: IncomingMessage): { deviceId: string; token: string } | null {
  const deviceId = req.headers["x-lm-device"];
  const token = req.headers["x-lm-token"];
  if (typeof deviceId !== "string" || typeof token !== "string" || !deviceId || !token) return null;
  return { deviceId, token };
}

/** Query-string parser (URLSearchParams handles plus-encoding for notes). */
export function queryOf(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? "/", "http://phone-lens.local");
  return url.searchParams;
}
