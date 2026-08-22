import type { AdmittedImage, DeliveryReceipt } from "../types.js";

/** Pluggable delivery seam (architecture.md §2 D3). */
export interface DeliverySink {
  deliver(admitted: AdmittedImage, note: string | undefined, mode: "followup" | "steer"): Promise<DeliveryReceipt>;
}

/**
 * Phase 1 sink: logs the delivery that Phase 2 will perform through
 * createUserMessage + agent.followup/steer inside the dsh process.
 */
export class LoggingSink implements DeliverySink {
  constructor(private readonly log: (level: "info" | "warn", msg: string) => void) {}

  async deliver(admitted: AdmittedImage, note: string | undefined, mode: "followup" | "steer"): Promise<DeliveryReceipt> {
    this.log(
      "info",
      `[deliver:${mode}] ${admitted.ref.mediaType} ${admitted.ref.width}x${admitted.ref.height} ${admitted.ref.bytes}B ` +
        `(attachmentId=${admitted.ref.attachmentId}, storage=${admitted.storage}` +
        `${admitted.filePath ? `, file=${admitted.filePath}` : ""})${note ? ` note="${note}"` : ""} — Phase 2 will inject this into the active session`,
    );
    return { ok: false, sessionId: null, mode: "none", reason: "delivery activates in Phase 2" };
  }
}
