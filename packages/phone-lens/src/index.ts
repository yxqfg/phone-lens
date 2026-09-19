import { join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { normalizeConfig } from "./config.js";
import { HostDeliverySink, type EventedAgent } from "./inject/host-sink.js";
import { TargetTracker } from "./inject/target.js";
import { DeviceStore } from "./store/devices.js";
import { PairingStore } from "./store/pairing.js";
import { startLensServer, type LensServerHandle } from "./server/http.js";
import { ViewHub } from "./server/hub.js";
import { buildPairingQr } from "./server/qr.js";
import type { AttachmentStoreLike } from "./inject/admit.js";
import { lensDataDir } from "./paths.js";

type LogLevel = "info" | "warn" | "error";

/**
 * phone-lens host plugin.
 *
 * Boots the receiver inside the dsh process so uploads can flow straight
 * into `ctx.attachments` (and, from Phase 2 on, into agent inboxes) with no
 * extra IPC. Everything registered here unwinds with the fiber.
 */
export default class PhoneLens extends Service {
  static inject: string[] = [];
  static Config = z.any();

  constructor(ctx: any, rawConfig: unknown) {
    super(ctx, "phoneLens");
    const config = normalizeConfig(rawConfig);
    const dataDir = lensDataDir();
    const log = (level: LogLevel, msg: string) => {
      const target = (ctx.logger as Record<LogLevel, (m: string) => void> | undefined) ?? console;
      target[level]?.(`[phone-lens] ${msg}`);
    };

    const pairing = new PairingStore(config.pairing.codeTtlMs);
    const devices = new DeviceStore(dataDir);
    const hub = new ViewHub(config, (level, msg) => log(level, msg));
    const targets = new TargetTracker(config);
    // Phase 2: real delivery into a live dsh session; the LoggingSink remains
    // the standalone/dev fallback. Agent events keep the sink's active target.
    const sink = new HostDeliverySink(config, (level, msg) => log(level, msg));
    const attachments = (): AttachmentStoreLike | undefined => ctx.get?.("attachments") as AttachmentStoreLike | undefined;

    // agent wiring (scope-filtered events fire on the root ctx for global
    // listeners): the sink tracks the last-active session for delivery.
    const onAgent = (agent: EventedAgent) => sink.track(agent);
    const offAgent = (agent: EventedAgent) => sink.untrack(agent);
    ctx.on?.("agent/session-start", (payload: { agent: EventedAgent }) => onAgent(payload.agent));
    ctx.on?.("agent/inbox/inserted", (payload: { agent: EventedAgent }) => onAgent(payload.agent));
    ctx.on?.("agent/status", (payload: { agent: EventedAgent; status: string }) => {
      if (payload.status === "running") onAgent(payload.agent);
    });
    ctx.on?.("agent/disposed", (payload: { agent: EventedAgent }) => offAgent(payload.agent));

    let handle: LensServerHandle | null = null;
    startLensServer({
      config,
      pairing,
      devices,
      hub,
      targets,
      sink,
      attachments,
      fallbackDir: join(dataDir, "uploads"),
      pendingDir: join(dataDir, "pending"),
      log,
    })
      .then(async (h) => {
        handle = h;
        const { code, expiresAt } = pairing.current();
        const qr = await buildPairingQr(code, expiresAt, config);
        // ASCII QR goes to the real stdout; prefixing it through the logger
        // would mangle the block characters.
        process.stdout.write(`\n[phone-lens] 手机扫码配对(或浏览器打开 http://127.0.0.1:${h.port}/view.html):\n${qr.ascii}\n[phone-lens] 备用地址: ${qr.urls.join("  ")}\n\n`);
      })
      .catch((error: unknown) => {
        log("error", `receiver failed to start: ${String(error)} (check port ${config.server.port})`);
      });

    ctx.effect(() => () => {
      void handle?.dispose();
      handle = null;
    }, "phone-lens.server()");
  }
}
