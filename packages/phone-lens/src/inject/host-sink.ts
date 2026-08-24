import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { AdmittedImage, DeliveryReceipt, LensConfig } from "../types.js";
import type { DeliverySink } from "./deliver.js";

/** Minimal structural view of a live dsh agent (docs/dsh-caps.md Q1/Q3). */
interface LiveAgent {
  id: string;
  session: { id: string };
  followup(message: unknown): void;
  steer(message: unknown): void;
  ctx?: { sessions?: unknown };
}

export interface EventedAgent {
  send(message: unknown, target: "next-turn" | "next-step", wakeup: boolean): void;
  followup(message: unknown): void;
  steer(message: unknown): void;
  session: { id: string };
  id?: string;
}

/**
 * Phase 2 delivery seam: turns a stored image into a durable dsh user message
 * attached to the current/last-active session, so the model sees it on the
 * next turn.
 *
 * The active session is tracked from live agent events (inbox inserts and
 * `running` status flips). With no live session the image stays stored but
 * no delivery occurs — a real state, not an error.
 */
export class HostDeliverySink implements DeliverySink {
  private lastActiveId: string | null = null;
  private agents = new Map<string, EventedAgent>();

  constructor(
    private readonly config: LensConfig,
    private readonly log: (level: "info" | "warn", msg: string) => void,
  ) {
    // subscribe via injected listeners; the caller wires these to the context
    // because the sink must stay cordis-agnostic for standalone tests.
  }

  /** Track an agent that appeared / got input. Call from ctx event handlers. */
  track(agent: EventedAgent): void {
    const id = agent.id ?? String(agent.session.id);
    this.agents.set(id, agent);
    this.lastActiveId = id;
    this.log("info", `tracking agent ${id} (active target)`);
  }

  /** Forget a disposed agent. */
  untrack(agent: EventedAgent): void {
    const id = agent.id ?? String(agent.session.id);
    this.agents.delete(id);
    if (this.lastActiveId === id) this.lastActiveId = this.agents.keys().next().value ?? null;
  }

  /** The session an upload targets right now, if any. */
  private resolve(): EventedAgent | null {
    if (this.config.target.mode === "pinned" && this.config.target.pinnedSessionId) {
      const pinned = [...this.agents.values()].find((a) => String(a.session.id) === this.config.target.pinnedSessionId);
      if (pinned) return pinned;
      this.log("warn", `pinned session ${this.config.target.pinnedSessionId} has no live agent`);
    }
    return (this.lastActiveId ? this.agents.get(this.lastActiveId) : null) ?? null;
  }

  async deliver(admitted: AdmittedImage, note: string | undefined, mode: "followup" | "steer"): Promise<DeliveryReceipt> {
    const agent = this.resolve();
    if (!agent) {
      return { ok: false, sessionId: null, mode: "none", reason: "no active session" };
    }
    try {
      const content: unknown[] = [
        { type: "text", text: note ?? this.config.inject.notePrefix },
        { type: "image", attachment: admitted.ref },
      ];
      const message = createUserMessage({
        content,
        source: { kind: "plugin", plugin: "phone-lens" },
      });
      this.log("info", `delivering image (${admitted.ref.attachmentId}) to session ${agent.session.id} via ${mode}`);
      if (mode === "steer") agent.steer(message);
      else agent.followup(message);
      return { ok: true, sessionId: String(agent.session.id), mode };
    } catch (e) {
      this.log("warn", `delivery failed: ${String(e)}`);
      return { ok: false, sessionId: null, mode: "none", reason: String(e) };
    }
  }
}
