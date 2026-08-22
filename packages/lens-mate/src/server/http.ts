import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { DeliveryReceipt, LensConfig } from "../types.js";
import { ERROR_CODES } from "../types.js";
import type { DeliverySink } from "../inject/deliver.js";
import { admitImage, magicMatches, type AttachmentStoreLike } from "../inject/admit.js";
import type { TargetTracker } from "../inject/target.js";
import type { DeviceStore } from "../store/devices.js";
import { hashToken, mintDeviceToken, type PairingStore } from "../store/pairing.js";
import type { ViewHub } from "./hub.js";
import { buildPairingQr } from "./qr.js";
import { VIEW_HTML } from "./static-view.js";
import { clientKey, corsFor, deviceAuth, isLoopback, queryOf, RateLimiter } from "./auth.js";

export interface ServerDeps {
  config: LensConfig;
  pairing: PairingStore;
  devices: DeviceStore;
  hub: ViewHub;
  targets: TargetTracker;
  sink: DeliverySink;
  /** Read the attachment store lazily — the service may mount after us. */
  attachments: () => AttachmentStoreLike | undefined;
  /** Fallback dir for uploads when the attachment service is absent. */
  fallbackDir: string;
  /** Browser-fetchable staging dir for images awaiting user send (composer pre-send). */
  pendingDir: string;
  log: (level: "info" | "warn" | "error", msg: string) => void;
}

export interface LensServerHandle {
  port: number;
  dispose: () => Promise<void>;
}

/** Boot the receiver: HTTP routes + two websocket endpoints. */
export async function startLensServer(deps: ServerDeps): Promise<LensServerHandle> {
  const { config, pairing, devices, hub, targets, sink, log } = deps;
  const pairLimiter = new RateLimiter(60_000, 10);
  const uploadLimiter = new RateLimiter(60_000, config.limits.uploadsPerMinute);
  let currentCameraDeviceId: string | null = null;
  const injectionBox: { last: { at: number; sessionId: string | null; attachmentId: string; ok: boolean } | null } = { last: null };

  const server: HttpServer = createServer((req, res) => {
    handle(deps, req, res, {
      pairLimiter,
      uploadLimiter,
      getCurrentCamera: () => currentCameraDeviceId,
      noteInjection: (receipt, attachmentId) => {
        injectionBox.last = { at: Date.now(), sessionId: receipt.sessionId, attachmentId, ok: receipt.ok };
      },
      getLastInjection: () => injectionBox.last,
    }).catch((error) => {
      log("error", `request failed: ${String(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: { code: ERROR_CODES.INTERNAL, message: String(error) } });
      else res.destroy();
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: config.limits.previewFrameMaxBytes * 4 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://phone-lens.local");
    const done = (status: number, message: string) => {
      socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname === "/ws/camera") {
      const q = url.searchParams;
      const deviceId = q.get("deviceId") ?? "";
      const token = q.get("token") ?? "";
      const record = devices.authenticate(deviceId, token);
      if (!record) return done(401, "Unauthorized");
      wss.handleUpgrade(req, socket, head, (ws) => {
        currentCameraDeviceId = record.deviceId;
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
    done(404, "Not Found");
  });

  const heartbeat = setInterval(() => hub.pingAll(), 20_000);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.server.port, config.server.host, () => resolve());
  });
  log("info", `phone-lens listening on ${config.server.host}:${config.server.port} (paired devices: ${devices.count()})`);

  return {
    port: config.server.port,
    dispose: async () => {
      clearInterval(heartbeat);
      hub.detachAll();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type RouteCtx = {
  pairLimiter: RateLimiter;
  uploadLimiter: RateLimiter;
  getCurrentCamera: () => string | null;
  noteInjection: (receipt: DeliveryReceipt, attachmentId: string) => void;
  getLastInjection: () => { at: number; sessionId: string | null; attachmentId: string; ok: boolean } | null;
};

async function handle(deps: ServerDeps, req: IncomingMessage, res: ServerResponse, ctx: RouteCtx): Promise<void> {
  const { config, pairing, devices, hub, targets, sink, log } = deps;
  const url = new URL(req.url ?? "/", "http://phone-lens.local");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";
  const loop = isLoopback(req);
  const cors = corsFor(req);

  // Preflight from the Web UI page (another loopback origin).
  if (method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  // ── open endpoints ────────────────────────────────────────────────────────
  if (method === "GET" && path === "/info") {
    return sendJson(res, 200, { name: "PhoneLens 直连取景", version: "0.2.0", requiresPairing: true }, cors);
  }

  // ── loopback-only endpoints (preview page, QR, view stream) ──────────────
  if (!loop && (path === "/" || path === "/view.html" || path === "/qr.json" || path === "/qr.png")) {
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
    if (!ctx.uploadLimiter.allow(loop ? "loopback" : clientKey(req))) return sendError(res, 429, ERROR_CODES.RATE_LIMITED, "upload rate exceeded");
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
    const note = q.get("note") ?? (captureId ? hub.noteFor(captureId) : undefined);
    if (captureId) hub.consumeCapture(captureId);
    const name = (q.get("name") ?? `shot_${new Date().toISOString().replace(/[:.]/g, "-")}.${mediaType === "image/png" ? "png" : "jpg"}`).slice(0, 120);

    let admitted;
    try {
      admitted = await admitImage({ data: buf, mediaType, name }, deps.attachments(), deps.fallbackDir);
    } catch (error) {
      log("error", `admit failed: ${String(error)}`);
      return sendError(res, 500, ERROR_CODES.STORE_FAILED, String(error));
    }
    log("info", `stored ${name} (${buf.byteLength}B) → ${admitted.storage}:${admitted.ref.attachmentId}`);

    // keep the local archive bounded (retention: maxStoredUploads oldest-first)
    if (admitted.storage === "file") await pruneUploads(deps.fallbackDir, config.limits.maxStoredUploads).catch((error) => log("warn", `upload pruning failed: ${String(error)}`));

    // Phase 2 (rev): PRE-SEND semantics. The phone's photo is staged for the
    // dsh composer, not injected straight into the model — the browser client
    // fetches this staging copy and drops it into the composer draft; the user
    // types text and hits send. So no agent.followup here.
    const pendingPath = join(deps.pendingDir, `${admitted.ref.attachmentId}.jpg`);
    try {
      mkdirSync(deps.pendingDir, { recursive: true });
      writeFileSync(pendingPath, buf);
      log("info", `staged for composer: ${pendingPath}`);
    } catch (error) {
      log("warn", `staging failed: ${String(error)}`);
    }
    hub.broadcastToViews({ type: "pending_image", attachmentId: admitted.ref.attachmentId, name });
    // no direct delivery; the client owns placing it in the composer

    return sendJson(res, 200, {
      ok: true,
      attachmentId: admitted.ref.attachmentId,
      width: admitted.ref.width,
      height: admitted.ref.height,
      bytes: admitted.ref.bytes,
      storage: admitted.storage,
      delivered: null,
      deliverReason: "staged-in-composer",
    });
  }

  // Browser client fetches the staged photo to place into the composer draft.
  if (method === "GET" && path.startsWith("/pending/") && loop) {
    const id = path.slice("/pending/".length).split("/")[0] ?? "";
    const file = join(deps.pendingDir, `${id}.jpg`);
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store", ...cors });
      res.end(data);
      return;
    } catch {
      return sendError(res, 404, ERROR_CODES.BAD_REQUEST, "pending image not found");
    }
  }

  if (method === "GET" && path === "/status") {
    const cameraDeviceId = ctx.getCurrentCamera();
    return sendJson(res, 200, {
      devices: devices.list().map((d) => ({ id: d.deviceId, name: d.name, model: d.model, online: d.deviceId === cameraDeviceId, streaming: d.deviceId === cameraDeviceId, lastSeenAt: d.lastSeenAt })),
      camera: hub.stats(),
      preview: config.preview,
      target: { mode: targets.mode(), sessionId: targets.resolve()?.sessionId ?? null },
      lastInjection: ctx.getLastInjection(),
    }, cors);
  }

  if (method === "GET" && path === "/targets") {
    return sendJson(res, 200, { targets: targets.list(), default: targets.resolve()?.sessionId ?? null }, cors);
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

/** Delete the oldest files beyond `max` in a directory (mtime order). */
async function pruneUploads(dir: string, max: number): Promise<void> {
  if (max <= 0) return;
  const names = await readdir(dir);
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
