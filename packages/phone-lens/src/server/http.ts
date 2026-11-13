import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { readFile, readdir, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import QRCode from "qrcode";
import type { LensConfig } from "../types.js";
import { ERROR_CODES } from "../types.js";
import { checkHostUpdate } from "./update-check.js";
import { admitImage, magicMatches, type AttachmentStoreLike } from "../inject/admit.js";
import type { TargetTracker } from "../inject/target.js";
import type { DeviceStore } from "../store/devices.js";
import { hashToken, mintDeviceToken, type PairingStore } from "../store/pairing.js";
import { SAVE_MODES, type AppSettingsStore, type SaveMode } from "../store/settings.js";
import type { ViewHub } from "./hub.js";
import type { WorkBridge } from "../work/bridge.js";
import { refreshAppApkLinks, resolveLatestGiteeApk } from "./apk-link.js";
import { buildPairingQr } from "./qr.js";
import { VIEW_HTML } from "./static-view.js";
import { clientKey, corsFor, deviceAuth, isAllowedHost, isLoopback, queryOf, RateLimiter } from "./auth.js";

export interface ServerDeps {
  config: LensConfig;
  pairing: PairingStore;
  devices: DeviceStore;
  hub: ViewHub;
  targets: TargetTracker;
  /** Read the attachment store lazily — the service may mount after us. */
  attachments: () => AttachmentStoreLike | undefined;
  /** Fallback dir for uploads when the attachment service is absent. */
  fallbackDir: string;
  /** Browser-fetchable staging dir for images awaiting user send (composer pre-send). */
  pendingDir: string;
  /** User-selected capture mode + folder target (web UI settings). */
  appSettings: AppSettingsStore;
  /** 「工作(Beta)」session-mirror bridge (inert while the beta switch is off). */
  workBridge: WorkBridge;
  log: (level: "info" | "warn" | "error", msg: string) => void;
}

export interface LensServerHandle {
  port: number;
  dispose: () => Promise<void>;
}

/** Process-lifetime marker: surfaces service rebuilds via /status. */
const SERVER_BOOT_AT = Date.now();

/** Boot the receiver: HTTP routes + two websocket endpoints. */
// Report our own package version without a hardcoded literal (the old literal
// went stale across releases). Resolved once from ../package.json — the bundle
// lives in lib/, so that resolves to the package root in every install form.
let ownVersion: string | null = null;
function hostVersion(): string {
  if (ownVersion) return ownVersion;
  try {
    ownVersion = String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0");
  } catch {
    ownVersion = "0.0.0";
  }
  return ownVersion;
}

export async function startLensServer(deps: ServerDeps): Promise<LensServerHandle> {
  const { config, pairing, devices, hub, targets, log } = deps;
  const pairLimiter = new RateLimiter(60_000, 10);
  // POST /upload idempotency: the phone's upload queue retries with a stable
  // uploadId, and a retry after a lost response must not store/inject twice.
  const uploadReplays = new Map<string, { expires: number; body: unknown }>();

  const server: HttpServer = createServer((req, res) => {
    handle(deps, req, res, {
      pairLimiter,
      uploadReplays,
    }).catch((error) => {
      log("error", `request failed: ${String(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: { code: ERROR_CODES.INTERNAL, message: String(error) } });
      else res.destroy();
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: config.limits.previewFrameMaxBytes * 4 });
  // work uplink carries base64 image parts inside work_send JSON frames —
  // its own generous ceiling, independent of the camera frame budget
  const workWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://phone-lens.local");
    const done = (status: number, message: string) => {
      socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    // same DNS-rebinding shield as the HTTP routes (see isAllowedHost)
    if (!isAllowedHost(req)) return done(403, "Forbidden");
    if (url.pathname === "/ws/camera") {
      const q = url.searchParams;
      const deviceId = q.get("deviceId") ?? "";
      const token = q.get("token") ?? "";
      const record = devices.authenticate(deviceId, token);
      if (!record) return done(401, "Unauthorized");
      wss.handleUpgrade(req, socket, head, (ws) => {
        hub.attachCamera(record.deviceId, ws, record.name);
      });
      return;
    }
    if (url.pathname === "/ws/view") {
      if (!isLoopback(req)) return done(403, "Forbidden");
      wss.handleUpgrade(req, socket, head, (ws) => hub.attachView(ws as WebSocket, {
        onRefreshPairing: () => pairing.refresh(),
        onRenameDevice: (deviceId, name) => {
          const updated = devices.rename(deviceId, name);
          if (updated) hub.renameDevice(deviceId, updated.name);
        },
      }));
      return;
    }
    // 「工作(Beta)」uplink: paired-device auth (or loopback debugging). The
    // bridge itself re-checks the beta switch and closes 4003 when off.
    if (url.pathname === "/ws/work") {
      const q = url.searchParams;
      const deviceId = q.get("deviceId") ?? "";
      const token = q.get("token") ?? "";
      const record = devices.authenticate(deviceId, token);
      if (!record && !isLoopback(req)) return done(401, "Unauthorized");
      workWss.handleUpgrade(req, socket, head, (ws) => {
        // pass the authenticated record through (lane-08 §8 item 3 / recheck-6
        // R3) — dropping it made every work client fall back to deviceId=""
        // and "本机调试", collapsing work_devices to one row and breaking the
        // self-device marker; loopback debug links carry no record and keep
        // the placeholder identity
        deps.workBridge.attachClient(
          ws as WebSocket,
          record ? { deviceId: record.deviceId, name: record.name } : undefined,
        );
      });
      return;
    }
    done(404, "Not Found");
  });

  const heartbeat = setInterval(() => {
    hub.pingAll();
    deps.workBridge.pingAll();
  }, 20_000);

  // Port fallback: the default 8791 (or the configured port) may be held by a
  // leaked previous instance — walk up to 8800 instead of refusing to start.
  // Only EADDRINUSE moves on to the next candidate; EACCES/EINVAL and friends
  // are real config errors and must rethrow (no silent 10× spin). The wss
  // instances are noServer:true (bound in the "upgrade" handler), so retrying
  // on the same server/wss needs no rebuild.
  const preferredPort = config.server.port;
  const candidates = [preferredPort, ...[8792, 8793, 8794, 8795, 8796, 8797, 8798, 8799, 8800].filter((p) => p !== preferredPort)];
  let boundPort: number | null = null;
  try {
    for (const port of candidates) {
      const ok = await new Promise<boolean>((resolve, reject) => {
        const onError = reject as (e: Error) => void;
        server.once("error", onError);
        server.listen(port, config.server.host, () => {
          // detach the startup reject: leaving it attached would silently swallow
          // RUNTIME server errors into an already-settled promise
          server.removeListener("error", onError);
          server.on("error", (e) => log("warn", `http server error: ${String(e)}`));
          resolve(true);
        });
      }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") return false;
        throw error;
      });
      if (ok) {
        boundPort = port;
        break;
      }
    }
  } catch (error) {
    // listen failed on a non-EADDRINUSE error: the heartbeat interval and the
    // wss/workWss above are ALREADY live — without this cleanup every failed
    // start leaked a 20s timer that pings an empty hub forever and stacks
    // across plugin reloads
    clearInterval(heartbeat);
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    for (const client of workWss.clients) client.terminate();
    await new Promise<void>((resolve) => workWss.close(() => resolve()));
    throw error;
  }
  if (boundPort === null) {
    // every candidate was busy: name the whole range so the boot log points
    // at the actual situation instead of just the preferred port
    throw new Error(`无可用端口: ${preferredPort} 及 8792~8800 均被占用`);
  }
  // Deliberately mutate the SHARED config object: /info, the pairing QR
  // (qr.ts), the stdout announcements and the dev banner all read
  // config.server.port — writing the bound port back keeps every consumer on
  // the real port without threading it through handles. normalizeConfig
  // rebuilds the object on every config apply, so this never persists into
  // the profile's stored port value.
  if (boundPort !== preferredPort) {
    config.server.port = boundPort;
    log("warn", `port ${preferredPort} busy, fell back to ${boundPort}`);
  }
  log("info", `phone-lens listening on ${config.server.host}:${config.server.port} (paired devices: ${devices.count()})`);
  // One-shot boot sweep: the per-upload prunes only run on successful /upload
  // calls, so files that aged past their TTL while the host was down (or just
  // idle — pure viewing / work-session use) sat until the next photo. Sweep
  // once at startup; the per-upload sweeps stay the steady-state path.
  void pruneUploads(deps.fallbackDir, config.limits.maxStoredUploads).catch((error) => log("warn", `upload pruning failed: ${String(error)}`));
  void prunePending(deps.pendingDir, PENDING_TTL_MS).catch(() => {});
  // Warm the APK-link cache so the first rendered download QR already carries
  // the dynamically resolved URL (never blocks startup on the network).
  void resolveLatestGiteeApk().then((url) => {
    if (url) log("info", `APK download link resolved from Gitee API: ${url}`);
  });

  return {
    port: config.server.port,
    dispose: async () => {
      clearInterval(heartbeat);
      hub.dispose();
      hub.detachAll();
      deps.workBridge.dispose();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type RouteCtx = {
  pairLimiter: RateLimiter;
  /** uploadId → cached 200 response, so queued-upload retries are idempotent. */
  uploadReplays: Map<string, { expires: number; body: unknown }>;
};

/** Composer-staged photos older than this get swept (best effort). */
const PENDING_TTL_MS = 24 * 60 * 60_000;

/**
 * Cache an idempotent 200 receipt for a phone retry. The 400 cap must be a
 * HARD cap: within the 10min TTL a retry storm can keep the map full of
 * fresh entries, so once expired ones are gone we still evict oldest-first
 * (Map iteration order = insertion order).
 */
function rememberReplay(ctx: RouteCtx, uploadId: string | null, body: unknown): void {
  if (!uploadId) return;
  if (ctx.uploadReplays.size > 400) {
    for (const [k, v] of ctx.uploadReplays) if (v.expires <= Date.now()) ctx.uploadReplays.delete(k);
    while (ctx.uploadReplays.size >= 400) {
      const oldest = ctx.uploadReplays.keys().next().value;
      if (oldest === undefined) break;
      ctx.uploadReplays.delete(oldest);
    }
  }
  ctx.uploadReplays.set(uploadId, { expires: Date.now() + 10 * 60_000, body });
}

/** Best-effort TTL sweep for composer-staged photos (see the staging site). */
async function prunePending(dir: string, ttlMs: number): Promise<void> {
  const cutoff = Date.now() - ttlMs;
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    const p = join(dir, entry);
    const st = await stat(p).catch(() => null);
    if (st?.isFile() && st.mtimeMs < cutoff) await rm(p, { force: true }).catch(() => {});
  }
}

async function handle(deps: ServerDeps, req: IncomingMessage, res: ServerResponse, ctx: RouteCtx): Promise<void> {
  const { config, pairing, devices, hub, targets, log } = deps;
  const url = new URL(req.url ?? "/", "http://phone-lens.local");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";
  // DNS-rebinding shield (applies to EVERY route incl. preflight): legitimate
  // callers dial an IP literal or localhost, a re-bound attacker page does not
  const allowedHost = isAllowedHost(req);
  const loop = allowedHost && isLoopback(req);
  const cors = corsFor(req);

  if (!allowedHost) {
    // the Host header is a domain (or missing), never an address any
    // legitimate client dials — classic DNS-rebinding signature
    return sendError(res, 403, ERROR_CODES.BAD_HOST, "unrecognized Host header");
  }

  // Preflight from the Web UI page (another loopback origin).
  if (method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  // ── open endpoints ────────────────────────────────────────────────────────
  if (method === "GET" && path === "/info") {
    return sendJson(res, 200, { name: "PhoneLens 直连取景", version: hostVersion(), requiresPairing: true, serverPort: config.server.port }, cors);
  }

  // Loopback: plugin-update check for the floating panel (a colored hint line,
  // never a dialog). Cached 12h host-side — a panel-open costs no API call.
  if (method === "GET" && path === "/update-check") {
    if (!loop) return sendError(res, 403, ERROR_CODES.LOOPBACK_ONLY, "update check is loopback-only");
    return sendJson(res, 200, await checkHostUpdate(), cors);
  }

  // ── loopback-only endpoints (preview page, QR, view stream) ──────────────
  if (!loop && (path === "/" || path === "/view.html" || path === "/qr.json" || path === "/qr.png" || path === "/app-qr.json" || path === "/app-settings")) {
    return sendError(res, 403, ERROR_CODES.LOOPBACK_ONLY, "preview surface is loopback-only");
  }
  if (method === "GET" && (path === "/" || path === "/view.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(VIEW_HTML);
    return;
  }
  if (method === "GET" && path === "/qr.json") {
    const { code, expiresAt } = pairing.current();
    const qr = await buildPairingQr(code, expiresAt, config);
    return sendJson(res, 200, { code: qr.code, expiresAt: qr.expiresAt, payload: qr.payload, urls: qr.urls, pngDataUrl: qr.pngDataUrl }, { ...cors, "cache-control": "no-store" });
  }
  if (method === "GET" && path === "/qr.png") {
    const { code, expiresAt } = pairing.current();
    const qr = await buildPairingQr(code, expiresAt, config);
    const b64 = qr.pngDataUrl.slice(qr.pngDataUrl.indexOf(",") + 1);
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    res.end(Buffer.from(b64, "base64"));
    return;
  }
  // App-download QR: encodes the APK URL (Gitee by default) so a phone can
  // scan it straight from the Web UI overlay and start the download.
  if (method === "GET" && path === "/app-qr.json") {
    // Resolve the Gitee link from the latest-release API (no per-release
    // constant bump); mutates config.app only while defaults are in use.
    await refreshAppApkLinks(config);
    const target = config.app.downloadUrl || config.app.giteeUrl;
    const pngDataUrl = await QRCode.toDataURL(target, { errorCorrectionLevel: "M", margin: 2, width: 320 });
    return sendJson(res, 200, { url: target, gitee: config.app.giteeUrl, github: config.app.githubUrl, pngDataUrl }, { ...cors, "cache-control": "no-store" });
  }

  // ── pairing ──────────────────────────────────────────────────────────────
  // Rate limit only FAILED attempts (anti-brute-force); a legitimate new
  // device entering a valid code is never throttled, so switching phones
  // "just works" instead of hitting "too many pairing attempts".
  if (method === "POST" && path === "/pair") {
    const body = await readJsonBody(req, 4096);
    const code = str(body?.code);
    const device = (body?.device ?? {}) as Record<string, unknown>;
    const deviceId = str(device.id);
    const name = str(device.name) ?? "unnamed device";
    const model = str(device.model) ?? "";
    if (!code || !deviceId) return sendError(res, 400, ERROR_CODES.BAD_REQUEST, "code and device.id are required");
    const verdict = pairing.verify(code);
    if (!verdict.ok) {
      if (!ctx.pairLimiter.allow(clientKey(req))) return sendError(res, 429, ERROR_CODES.RATE_LIMITED, "too many pairing attempts");
      return sendError(res, 401, verdict.reason === "expired" ? ERROR_CODES.PAIR_CODE_EXPIRED : ERROR_CODES.PAIR_CODE_INVALID, `pairing code ${verdict.reason}`);
    }
    const token = mintDeviceToken();
    devices.upsert({ deviceId, name, model, tokenHash: hashToken(token) });
    log("info", `paired device "${name}" (${deviceId.slice(0, 8)})`);
    // the one-time code just burned: tell every view NOW (not when the phone's
    // uplink lands) so the QR rotates immediately — /view.html has no
    // devices-list growth to key off, and a second scan must never hit a
    // dead code. Old clients ignore the unknown type.
    hub.broadcastToViews({ type: "paired", name });
    return sendJson(res, 200, {
      token,
      serverInfo: { preview: config.preview, limits: config.limits },
    });
  }

  // ── authenticated endpoints: loopback or paired device ───────────────────
  const auth = loop ? { ok: true } : deviceAuth(req) && devices.authenticate(deviceAuth(req)!.deviceId, deviceAuth(req)!.token) ? { ok: true } : { ok: false };
  if (!auth.ok) return sendError(res, 401, ERROR_CODES.AUTH_REQUIRED, "pair this device first");

  if (method === "POST" && path === "/upload") {
    const q = queryOf(req);
    // Idempotent replay BEFORE anything else: a queued-upload retry that
    // already stored once replays the original 200. Key format-bounded:
    // uploadId is attacker-controllable input and doubles as the map key.
    const rawUploadId = q.get("uploadId") ?? "";
    const uploadId = /^[\w-]{8,64}$/.test(rawUploadId) ? rawUploadId : null;
    if (uploadId) {
      const hit = ctx.uploadReplays.get(uploadId);
      if (hit && hit.expires > Date.now()) {
        log("info", `idempotent replay for upload ${uploadId.slice(0, 8)}`);
        return sendJson(res, 200, hit.body);
      }
      ctx.uploadReplays.delete(uploadId);
    }
    // No upload rate limiting by design: the phone's queue uploads serially
    // and the per-photo size cap plus archive pruning bound the damage any
    // authenticated (or loopback) client can do.
    const mediaType = (req.headers["content-type"] ?? "").split(";")[0]!.trim();
    if (!config.limits.allowedTypes.includes(mediaType)) {
      return sendError(res, 415, ERROR_CODES.TYPE_NOT_ALLOWED, `allowed: ${config.limits.allowedTypes.join(", ")}`);
    }
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > config.limits.maxUploadBytes) return sendError(res, 413, ERROR_CODES.TOO_LARGE, `> ${config.limits.maxUploadBytes} bytes`);
    const { buf, truncated } = await readRawBody(req, config.limits.maxUploadBytes);
    if (truncated) return sendError(res, 413, ERROR_CODES.TOO_LARGE, `> ${config.limits.maxUploadBytes} bytes`);
    if (!magicMatches(mediaType, buf)) return sendError(res, 415, ERROR_CODES.BAD_MAGIC, "bytes do not match the declared type");

    const captureId = q.get("captureId");
    // PEEK, don't consume: admitImage below can still fail (transient
    // attachments hiccup) and the phone WILL retry — the pending record must
    // survive so the retry still routes the photo to the waiting model tool.
    const pending = captureId ? hub.peekCapture(captureId) : null;
    // a model-direct capture that already timed out (the tool answered
    // "拍照超时" long ago): its late photo must be swallowed, never dropped
    // into the user's composer/folder as a photo nobody asked for
    const abandoned = captureId ? hub.isAbandonedDirect(captureId) : false;
    const note = q.get("note") ?? pending?.note;
    const rawName = (q.get("name") ?? `shot_${new Date().toISOString().replace(/[:.]/g, "-")}.${mediaType === "image/png" ? "png" : "jpg"}`).slice(0, 120);
    const name = sanitizeFileName(rawName);

    let admitted;
    try {
      admitted = await admitImage({ data: buf, mediaType, name }, deps.attachments(), deps.fallbackDir);
    } catch (error) {
      log("error", `admit failed: ${String(error)}`);
      return sendError(res, 500, ERROR_CODES.STORE_FAILED, String(error));
    }
    log("info", `stored ${name} (${buf.byteLength}B) → ${admitted.storage}:${admitted.ref.attachmentId}`);

    // the ledger entry dies only now that admit succeeded
    if (pending) hub.consumeCapture(captureId as string);

    // keep the archives bounded on EVERY upload, not just when the owning
    // branch fired this time: once the attachments service recovered, historic
    // fallback files in uploads/ never got pruned again, and switching to
    // folder-only mode stopped composer-pending sweeps entirely (both had real
    // lingering stockpiles). This sits ABOVE the abandoned-late-direct early
    // return — a swallowed late photo must still sweep, or fallback-mode files
    // from timed-out captures only got cleaned by the NEXT non-abandoned one.
    await pruneUploads(deps.fallbackDir, config.limits.maxStoredUploads).catch((error) => log("warn", `upload pruning failed: ${String(error)}`));
    void prunePending(deps.pendingDir, PENDING_TTL_MS).catch(() => {});

    if (abandoned) {
      log("warn", `dropping late direct-capture photo: ${name} (${admitted.ref.attachmentId})`);
      // NOTE: deliverReason is ALIVE — the phone App's history screen maps it
      // to "saved to folder / staged" labels. The `delivered` object it used
      // to ride with (sessionId per session) is dead and stays deleted.
      const droppedBody = { ok: true, attachmentId: admitted.ref.attachmentId, width: admitted.ref.width, height: admitted.ref.height, bytes: admitted.ref.bytes, storage: admitted.storage, deliverReason: "dropped-late-direct" };
      rememberReplay(ctx, uploadId, droppedBody);
      return sendJson(res, 200, droppedBody);
    }

    // Model-initiated capture (phone_take_photo tool): the photo goes straight
    // to the model as an image context — never staged into the composer, never
    // written to the save folder, regardless of the user's capture mode.
    if (pending?.direct && pending.onImage) {
      pending.onImage(admitted);
      log("info", `direct-to-model photo: ${name} (${admitted.ref.attachmentId})`);
      const directBody = { ok: true, attachmentId: admitted.ref.attachmentId, width: admitted.ref.width, height: admitted.ref.height, bytes: admitted.ref.bytes, storage: admitted.storage, deliverReason: "delivered-to-model" };
      rememberReplay(ctx, uploadId, directBody);
      return sendJson(res, 200, directBody);
    }

    // Capture-mode routing (user-selected in the web UI settings). The photo
    // always lands in the attachment store first; the mode decides what
    // happens next:
    //   composer → stage for the dsh composer draft (paste pre-send)
    //   folder   → additionally/only write the file to the user's folder
    // A failed folder write never loses the photo — it falls back to staging.
    const st = deps.appSettings.get();
    const wantFolder = st.saveMode !== "composer";
    const wantComposer = st.saveMode !== "folder";
    let savedDir: string | null = null;
    if (wantFolder) {
      const dir = deps.appSettings.effectiveSaveDir();
      try {
        mkdirSync(dir, { recursive: true });
        let fileName = nextAvailableName(dir, name);
        for (let attempt = 0; ; attempt++) {
          const target = resolveUnder(dir, fileName);
          if (!target) throw new Error("resolved path escapes the save directory");
          try {
            // "wx" fails if the file appeared between the existsSync probe and
            // this write (two devices racing the same second-resolution name)
            // — retry with the next candidate instead of silently overwriting
            const fd = openSync(target, "wx");
            try {
              writeSync(fd, buf);
            } finally {
              closeSync(fd);
            }
            break;
          } catch (e) {
            if (attempt >= 4 || (e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
            fileName = nextAvailableName(dir, fileName);
          }
        }
        savedDir = dir;
        log("info", `folder-mode saved: ${join(dir, fileName)}`);
      } catch (error) {
        log("warn", `folder save failed (${String(error)}) — falling back to composer staging`);
      }
    }

    // PRE-SEND semantics. The phone's photo is staged for the dsh composer,
    // not injected straight into the model — the browser client fetches this
    // staging copy and drops it into the composer draft; the user types text
    // and hits send. So no agent.followup here.
    if (wantComposer || !savedDir) {
      const pendingPath = resolveUnder(deps.pendingDir, pendingFileName(admitted.ref.attachmentId));
      try {
        if (!pendingPath) throw new Error("resolved path escapes the pending directory");
        mkdirSync(deps.pendingDir, { recursive: true });
        writeFileSync(pendingPath, buf);
        log("info", `staged for composer: ${pendingPath}`);
      } catch (error) {
        log("warn", `staging failed: ${String(error)}`);
      }
      // (TTL sweep moved to the unconditional prune right after admit)
      hub.broadcastToViews({ type: "pending_image", attachmentId: admitted.ref.attachmentId, name });
      // no direct delivery; the client owns placing it in the composer
    } else {
      // folder-only save: bypass the composer; surface a local UI hint on the
      // view — never a chat message (the tool does not speak for the user).
      hub.broadcastToViews({ type: "upload_saved", name, dir: savedDir });
    }

    // Idempotency bookkeeping for queued-upload retries. uploadId serves only
    // as the lookup KEY; the cached receipt is entirely server-generated data
    // (sha refs, probed dimensions, literal enums) and IS the 200 body — one
    // object for both, so they can never drift apart.
    {
      const replayBody = {
        ok: true,
        attachmentId: admitted.ref.attachmentId,
        width: admitted.ref.width,
        height: admitted.ref.height,
        bytes: admitted.ref.bytes,
        storage: admitted.storage,
        deliverReason: savedDir ? (wantComposer ? "saved-and-staged" : "saved-to-folder") : "staged-in-composer",
      };
      rememberReplay(ctx, uploadId, replayBody);
      return sendJson(res, 200, replayBody);
    }
  }

  // Browser client fetches the staged photo to place into the composer draft.
  if (method === "GET" && path.startsWith("/pending/") && loop) {
    const id = path.slice("/pending/".length).split("/")[0] ?? "";
    const file = resolveUnder(deps.pendingDir, pendingFileName(id));
    if (!file) return sendError(res, 404, ERROR_CODES.BAD_REQUEST, "pending image not found");
    try {
      const data = await readFile(file);
      // the staging file may hold any admitted type (high-quality uploads keep
      // their original PNG bytes) — declare the type the BYTES say, not what
      // the flattened .jpg filename implies
      res.writeHead(200, { "content-type": imageContentType(data), "cache-control": "no-store", ...cors });
      res.end(data);
      return;
    } catch {
      return sendError(res, 404, ERROR_CODES.BAD_REQUEST, "pending image not found");
    }
  }

  if (method === "GET" && path === "/status") {
    // online/streaming reflect the hub's LIVE uplinks — the phone's
    // auto-switch and auth probes read this, so a detached device must not
    // linger as "online" off a stale attach-time marker
    const online = hub.onlineDeviceIds();
    return sendJson(res, 200, {
      bootAt: SERVER_BOOT_AT,
      version: hostVersion(),
      devices: devices.list().map((d) => ({ id: d.deviceId, name: d.name, model: d.model, online: online.has(d.deviceId), streaming: online.has(d.deviceId), lastSeenAt: d.lastSeenAt })),
      camera: hub.stats(),
      preview: config.preview,
      target: { mode: targets.mode(), sessionId: targets.resolve()?.sessionId ?? null },
    }, cors);
  }

  if (method === "GET" && path === "/targets") {
    return sendJson(res, 200, { targets: targets.list(), default: targets.resolve()?.sessionId ?? null }, cors);
  }

  // Web UI settings: capture mode (composer / folder / both) + target folder.
  // Loopback-only; the settings live on the host because the folder save runs here.
  if (method === "GET" && path === "/app-settings") {
    const st = deps.appSettings.get();
    return sendJson(res, 200, { saveMode: st.saveMode, saveDir: st.saveDir, effectiveSaveDir: deps.appSettings.effectiveSaveDir(), modelToolsEnabled: st.modelToolsEnabled, modelToolsConfirmFree: st.modelToolsConfirmFree, workBetaEnabled: st.workBetaEnabled }, cors);
  }
  // Save-folder picker backend: lists DIRECTORIES under a path for the web
  // UI's browser-style folder dialog. The browser cannot learn absolute
  // paths of its own (no system dialog in a web page), so the host walks
  // the tree instead — loopback-only, directory names only, never files.
  if (method === "GET" && path === "/fs/dirs") {
    if (!loop) return sendError(res, 403, ERROR_CODES.LOOPBACK_ONLY, "folder browsing is loopback-only");
    return sendJson(res, 200, await listDirs(url.searchParams.get("path") ?? ""), cors);
  }
  if (method === "POST" && path === "/app-settings") {
    const body = await readJsonBody(req, 4096);
    if (!body) return sendError(res, 400, ERROR_CODES.BAD_REQUEST, "invalid JSON body");
    const patch: { saveMode?: SaveMode; saveDir?: string; modelToolsEnabled?: boolean; modelToolsConfirmFree?: boolean; workBetaEnabled?: boolean } = {};
    if (typeof body.saveMode === "string" && SAVE_MODES.includes(body.saveMode as SaveMode)) patch.saveMode = body.saveMode as SaveMode;
    if (typeof body.saveDir === "string") patch.saveDir = body.saveDir;
    if (typeof body.modelToolsEnabled === "boolean") patch.modelToolsEnabled = body.modelToolsEnabled;
    if (typeof body.modelToolsConfirmFree === "boolean") patch.modelToolsConfirmFree = body.modelToolsConfirmFree;
    if (typeof body.workBetaEnabled === "boolean") patch.workBetaEnabled = body.workBetaEnabled;
    const st = deps.appSettings.set(patch);
    // the work bridge reacts to the switch synchronously: off = taps removed
    // and every /ws/work client closed (nothing keeps listening host-side)
    if (typeof patch.workBetaEnabled === "boolean") deps.workBridge.setEnabled(patch.workBetaEnabled);
    log("info", `app settings updated: mode=${st.saveMode} dir=${st.saveDir ? JSON.stringify(st.saveDir) : "(default)"} modelTools=${st.modelToolsEnabled}/${st.modelToolsConfirmFree} workBeta=${st.workBetaEnabled}`);
    return sendJson(res, 200, { saveMode: st.saveMode, saveDir: st.saveDir, effectiveSaveDir: deps.appSettings.effectiveSaveDir(), modelToolsEnabled: st.modelToolsEnabled, modelToolsConfirmFree: st.modelToolsConfirmFree, workBetaEnabled: st.workBetaEnabled }, cors);
  }

  // Unbind a paired device (web UI settings "解绑" button). STRICTLY
  // loopback-only: the auth gate above also passes for paired phones, and a
  // phone must never be able to erase its own or a rival's pairing over the
  // LAN — only the machine's own user may drop a device.
  if (method === "POST" && path === "/devices/remove") {
    if (!loop) return sendError(res, 403, ERROR_CODES.LOOPBACK_ONLY, "device removal is loopback-only");
    const body = await readJsonBody(req, 4096);
    const deviceId = str(body?.deviceId);
    if (!deviceId) return sendError(res, 400, ERROR_CODES.BAD_REQUEST, "deviceId is required");
    const removed = devices.remove(deviceId);
    if (removed) {
      // a live camera uplink of the removed device must not keep pumping
      // frames: detach settles its tool waiters and refreshes the views
      hub.detachCamera(deviceId);
      log("info", `device removed: ${deviceId.slice(0, 8)}`);
    }
    return sendJson(res, 200, { ok: removed }, cors);
  }

  // View-side control also arrives over /ws/view; a loopback HTTP trigger is
  // handy for smoke tests.
  if (method === "POST" && path === "/capture" && loop) {
    const captureId = randomUUID();
    const ok = hub.requestCapture(captureId, queryOf(req).get("note") ?? undefined);
    if (!ok) return sendError(res, 409, ERROR_CODES.NO_CAMERA, "no camera uplink connected");
    return sendJson(res, 202, { captureId });
  }

  return sendError(res, 404, ERROR_CODES.BAD_REQUEST, `no route ${method} ${path}`);
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Cached drive roots (win32: existing C:..Z:, probed once per process). */
let cachedRoots: string[] | null = null;
function listRoots(): string[] {
  if (cachedRoots) return cachedRoots;
  const roots: string[] = [];
  if (process.platform === "win32") {
    for (let c = 67; c <= 90; c++) {
      const drive = `${String.fromCharCode(c)}:\\`;
      if (existsSync(drive)) roots.push(drive);
    }
  } else {
    roots.push("/");
  }
  cachedRoots = roots;
  return roots;
}

/**
 * Directory listing for the save-folder picker (loopback-only route).
 * Directories only — no file names, no contents; a path the process cannot
 * read yields an empty listing plus an error line so the picker shows WHY,
 * never a hard failure the dialog can't recover from. An empty request path
 * starts at the user's home (where the default save dir already lives).
 */
async function listDirs(wanted: string): Promise<{ path: string; parent: string | null; home: string; roots: string[]; dirs: string[]; error?: string }> {
  const home = homedir();
  const target = wanted.trim() === "" ? home : resolve(wanted.trim());
  const parent = dirname(target);
  const base = { path: target, parent: parent !== target ? parent : null, home, roots: listRoots() };
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    return { ...base, dirs: [], error: `无法读取该文件夹(不存在或无权限): ${String((error as Error).message || error).slice(0, 80)}` };
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && e.name !== "." && e.name !== "..")
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "zh"));
  return { ...base, dirs };
}

/** Strip path separators / reserved characters so a phone-supplied upload
 *  name can never escape the target directory or hide as a dotfile. */
function sanitizeFileName(input: string): string {
  const base = basename(input)
    .replace(/[<>:"|?*\u0000-\u001F]/g, "_")
    .replace(/^[\s.]+/, "")
    .trim();
  return base || "shot.jpg";
}

/** Pick `name`, then `name (2).ext`, `name (3).ext`, … — folder saves never overwrite. */
function nextAvailableName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

/** Pending-staging filename for an attachment id. Ids may be URN-ish
 *  ("file:<digest>" without the dsh attachment service) and Windows forbids
 *  ":" in filenames — flatten to a portable name, write and read alike. */
function pendingFileName(attachmentId: string): string {
  return `${attachmentId.replace(/[^A-Za-z0-9._-]/g, "_")}.jpg`;
}

/** Content type for a staged/uploaded image buffer, decided by the bytes:
 *  high-quality uploads pass original PNG (or WebP) through untouched, so a
 *  `.jpg` filename may lie about the payload. */
function imageContentType(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "GIF8") return "image/gif";
  return "application/octet-stream";
}

/** Resolve `name` under `baseDir` and refuse anything that escapes it
 *  (defense in depth on top of sanitizeFileName — e.g. a crafted name that
 *  survives sanitization but still resolves outside the base). */
function resolveUnder(baseDir: string, name: string): string | null {
  const base = resolve(baseDir);
  const target = resolve(base, name);
  return target === base || target.startsWith(base + sep) ? target : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...(extraHeaders ?? {}) });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown> | null> {
  const { buf } = await readRawBody(req, limit);
  try {
    return JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readRawBody(req: IncomingMessage, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        truncated = true;
        chunks.length = 0;
        req.destroy();
        resolve({ buf: Buffer.alloc(0), truncated });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve({ buf: Buffer.concat(chunks), truncated }));
    req.on("error", reject);
  });
}

/** Delete the oldest files beyond `max` in a directory (mtime order). A
 *  missing directory is a no-op: the production attachments mode never
 *  creates uploads/, and warning about it on EVERY /upload just floods
 *  boot.log. */
async function pruneUploads(dir: string, max: number): Promise<void> {
  if (max <= 0) return;
  const names = await readdir(dir).catch(() => [] as string[]);
  if (names.length <= max) return;
  const entries = await Promise.all(
    names.map(async (name) => {
      let mtime = 0;
      try {
        mtime = (await stat(join(dir, name))).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { name, mtime };
    }),
  );
  entries.sort((a, b) => b.mtime - a.mtime);
  for (const entry of entries.slice(max)) {
    await unlink(join(dir, entry.name)).catch(() => {});
  }
}
