import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** One-shot pairing-code lifecycle: create / verify / burn, with TTL. */
export class PairingStore {
  private code: string | null = null;
  private createdAt = 0;
  private expiresAt = 0;
  private used = false;

  constructor(private readonly ttlMs: number) {}

  /** Current live code, or a freshly minted one. */
  current(): { code: string; expiresAt: number } {
    const now = Date.now();
    if (this.code === null || this.used || now >= this.expiresAt) this.mint(now);
    return { code: this.code!, expiresAt: this.expiresAt };
  }

  /** Force a fresh code (manual refresh). Invalidates the previous one. */
  refresh(): { code: string; expiresAt: number } {
    this.mint(Date.now());
    return { code: this.code!, expiresAt: this.expiresAt };
  }

  /**
   * Verify a submitted code and burn it on success.
   * Constant-time compare; expired codes read as invalid.
   */
  verify(submitted: string): { ok: true } | { ok: false; reason: "invalid" | "expired" } {
    if (this.code === null || this.used) return { ok: false, reason: "invalid" };
    const now = Date.now();
    if (now >= this.expiresAt) return { ok: false, reason: "expired" };
    const a = Buffer.from(submitted);
    const b = Buffer.from(this.code);
    const same = a.length === b.length && timingSafeEqual(a, b);
    if (!same) return { ok: false, reason: "invalid" };
    this.used = true;
    return { ok: true };
  }

  private mint(now: number) {
    // 8 decimal digits, zero-padded (human-typable fallback).
    this.code = String(randomInt(0, 100_000_000)).padStart(8, "0");
    this.createdAt = now;
    this.expiresAt = now + this.ttlMs;
    this.used = false;
  }
}

/** Mint a per-device token. Only its SHA-256 may be persisted. */
export function mintDeviceToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time token-hash comparison. */
export function tokenHashMatches(recordHash: string, presentedToken: string): boolean {
  const a = Buffer.from(recordHash, "hex");
  const b = Buffer.from(hashToken(presentedToken), "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
