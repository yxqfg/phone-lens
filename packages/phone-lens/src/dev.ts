/**
 * Standalone receiver for protocol development and smoke tests — no dsh
 * runtime required. Uploads fall back to content-addressed files under
 * ./.data/uploads and are staged pre-send (no agent delivery).
 *
 * Run: node lib/dev.js   (after `pnpm build`)
 */
import { join } from "node:path";
import { normalizeConfig } from "./config.js";
import { TargetTracker } from "./inject/target.js";
import { DeviceStore } from "./store/devices.js";
import { PairingStore } from "./store/pairing.js";
import { AppSettingsStore } from "./store/settings.js";
import { startLensServer } from "./server/http.js";
import { ViewHub } from "./server/hub.js";
import { buildPairingQr } from "./server/qr.js";
import { WorkBridge } from "./work/bridge.js";
import { lensDataDir } from "./paths.js";

const config = normalizeConfig(process.env.LENS_PORT ? { server: { port: Number(process.env.LENS_PORT) } } : undefined);
// Smoke tests must NOT write the real registry: without this, every dev.js
// run upserted its sim device straight into ~/.dsh/phone-lens/devices.json
// ("模拟手机 (N)" entries). Default to a dedicated sibling dir; set
// LENS_DATA_DIR explicitly to reuse an existing data directory.
const dataDir = process.env.LENS_DATA_DIR ?? `${lensDataDir()}-dev`;
const log = (level: "info" | "warn" | "error", msg: string) => console[level](`[phone-lens:dev] ${msg}`);

const pairing = new PairingStore(config.pairing.codeTtlMs);
const devices = new DeviceStore(dataDir);
const appSettings = new AppSettingsStore(join(dataDir, "settings.json"), join(dataDir, "saved"));
const hub = new ViewHub(config, (lvl, msg) => log(lvl, msg));
const targets = new TargetTracker(config);
// standalone: no dsh host around the bridge — every tap/session call degrades
// into a warn log or an ok:false ack, exactly the posture the bridge is built for
const workBridge = new WorkBridge({}, appSettings, (lvl, msg) => log(lvl, msg), () => "dev");

const handle = await startLensServer({
  config,
  pairing,
  devices,
  hub,
  targets,
  workBridge,
  attachments: () => undefined,
  fallbackDir: join(dataDir, "uploads"),
  pendingDir: join(dataDir, "pending"),
  appSettings,
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
