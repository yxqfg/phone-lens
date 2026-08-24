/**
 * Standalone receiver for protocol development and smoke tests — no dsh
 * runtime required. Uploads fall back to content-addressed files under
 * ./.data/uploads and delivery is simulated (Phase 1 behaviour).
 *
 * Run: node lib/dev.js   (after `pnpm build`)
 */
import { join } from "node:path";
import { normalizeConfig } from "./config.js";
import { LoggingSink } from "./inject/deliver.js";
import { TargetTracker } from "./inject/target.js";
import { DeviceStore } from "./store/devices.js";
import { PairingStore } from "./store/pairing.js";
import { startLensServer } from "./server/http.js";
import { ViewHub } from "./server/hub.js";
import { buildPairingQr } from "./server/qr.js";
import { lensDataDir } from "./paths.js";

const config = normalizeConfig(process.env.LENS_PORT ? { server: { port: Number(process.env.LENS_PORT) } } : undefined);
const dataDir = process.env.LENS_DATA_DIR ?? lensDataDir();
const log = (level: "info" | "warn" | "error", msg: string) => console[level](`[phone-lens:dev] ${msg}`);

const pairing = new PairingStore(config.pairing.codeTtlMs);
const devices = new DeviceStore(dataDir);
const hub = new ViewHub(config, (lvl, msg) => log(lvl, msg));
const targets = new TargetTracker(config);
const sink = new LoggingSink((lvl, msg) => log(lvl, msg));

const handle = await startLensServer({
  config,
  pairing,
  devices,
  hub,
  targets,
  sink,
  attachments: () => undefined,
  fallbackDir: join(dataDir, "uploads"),
  pendingDir: join(dataDir, "pending"),
  log,
});

const qr = await buildPairingQr(pairing.current().code, pairing.current().expiresAt, config);
process.stdout.write(`\n[phone-lens:dev] standalone receiver on :${handle.port}\n${qr.ascii}\n[phone-lens:dev] view page: http://127.0.0.1:${handle.port}/view.html\n\n`);

const stats = setInterval(() => {
  log("info", `camera=${hub.stats().connected ? "on" : "off"} fps=${hub.stats().fps} views=${hub.stats().views} devices=${devices.count()}`);
}, 30_000);

const shutdown = async () => {
  clearInterval(stats);
  await handle.dispose();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
