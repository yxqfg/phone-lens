import type { LensConfig } from "../types.js";

export interface SessionTarget {
  sessionId: string;
  title: string;
  active: boolean;
  running: boolean;
}

/**
 * Resolves the session an upload should be injected into.
 *
 * Phase 1: pure config view, no live agents (the agent-event wiring that
 * feeds `latest` lands in Phase 2 — see architecture.md §2 D4).
 */
export class TargetTracker {
  constructor(private readonly config: LensConfig) {}

  /** The session an incoming image would target right now, if any. */
  resolve(): SessionTarget | null {
    if (this.config.target.mode === "pinned" && this.config.target.pinnedSessionId) {
      return { sessionId: this.config.target.pinnedSessionId, title: "(pinned)", active: true, running: false };
    }
    return null;
  }

  /** Choosable targets for GET /targets. */
  list(): SessionTarget[] {
    const pinned = this.resolve();
    return pinned ? [pinned] : [];
  }

  mode(): string {
    return this.config.target.mode;
  }
}
