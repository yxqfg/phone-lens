import { join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";
import * as os from "node:os";
import { homedir } from "node:os";
import { env } from "node:process";

//#region src/config.ts
/** Coerce an unknown config object (cordis patch row / CLI overrides) into LensConfig. */
function normalizeConfig(raw) {
	const r = raw ?? {};
	const server = r.server ?? {};
	const limits = r.limits ?? {};
	const pairing = r.pairing ?? {};
	const preview = r.preview ?? {};
	const inject = r.inject ?? {};
	const target = r.target ?? {};
	const app = r.app ?? {};
	const GITEE_APK = "https://gitee.com/qianfengbingtang/phone-lens/releases/download/v0.2.0/app-release.apk";
	const GITHUB_APK = "https://github.com/yxqfg/phone-lens/releases/latest/download/app-release.apk";
	const giteeUrl = typeof app.giteeUrl === "string" && app.giteeUrl ? app.giteeUrl : GITEE_APK;
	const allowed = Array.isArray(limits.allowedTypes) ? limits.allowedTypes.filter((t) => typeof t === "string") : void 0;
	const mode = inject.mode === "steer" ? "steer" : "followup";
	return {
		server: {
			host: typeof server.host === "string" && server.host ? server.host : "0.0.0.0",
			port: Number.isInteger(server.port) && server.port > 0 && server.port < 65536 ? server.port : 8791
		},
		limits: {
			maxUploadBytes: positiveInt(limits.maxUploadBytes, 10 * 1024 * 1024),
			allowedTypes: allowed && allowed.length > 0 ? allowed : ["image/jpeg", "image/png"],
			uploadsPerMinute: positiveInt(limits.uploadsPerMinute, 10),
			previewFrameMaxBytes: positiveInt(limits.previewFrameMaxBytes, 512 * 1024),
			maxStoredUploads: positiveInt(limits.maxStoredUploads, 200)
		},
		pairing: { codeTtlMs: positiveInt(pairing.codeTtlMs, 15 * 60 * 1e3) },
		preview: {
			maxWidth: positiveInt(preview.maxWidth, 854),
			maxHeight: positiveInt(preview.maxHeight, 480),
			fps: clampInt(preview.fps, 1, 30, 10),
			jpegQuality: clampInt(preview.jpegQuality, 20, 95, 70)
		},
		inject: {
			mode,
			notePrefix: typeof inject.notePrefix === "string" ? inject.notePrefix : "[手机拍照]"
		},
		target: {
			mode: target.mode === "pinned" ? "pinned" : "latest",
			pinnedSessionId: typeof target.pinnedSessionId === "string" && target.pinnedSessionId ? target.pinnedSessionId : null
		},
		app: {
			giteeUrl,
			githubUrl: typeof app.githubUrl === "string" && app.githubUrl ? app.githubUrl : GITHUB_APK,
			downloadUrl: typeof app.downloadUrl === "string" && app.downloadUrl ? app.downloadUrl : giteeUrl
		}
	};
}
function positiveInt(value, fallback) {
	return Number.isInteger(value) && value > 0 ? value : fallback;
}
function clampInt(value, min, max, fallback) {
	if (!Number.isInteger(value)) return fallback;
	const n = value;
	return Math.min(max, Math.max(min, n));
}

//#endregion
//#region src/inject/host-sink.ts
/**

* Phase 2 delivery seam: turns a stored image into a durable dsh user message

* attached to the current/last-active session, so the model sees it on the

* next turn.

*

* The active session is tracked from live agent events (inbox inserts and

* `running` status flips). With no live session the image stays stored but

* no delivery occurs — a real state, not an error.

*/
var HostDeliverySink = class {
	lastActiveId = null;
	agents = new Map();
	constructor(config, log) {
		this.config = config;
		this.log = log;
	}
	/** Track an agent that appeared / got input. Call from ctx event handlers. */
	track(agent) {
		const id = agent.id ?? String(agent.session.id);
		this.agents.set(id, agent);
		this.lastActiveId = id;
		this.log("info", `tracking agent ${id} (active target)`);
	}
	/** Forget a disposed agent. */
	untrack(agent) {
		const id = agent.id ?? String(agent.session.id);
		this.agents.delete(id);
		if (this.lastActiveId === id) this.lastActiveId = this.agents.keys().next().value ?? null;
	}
	/** The session an upload targets right now, if any. */
	resolve() {
		if (this.config.target.mode === "pinned" && this.config.target.pinnedSessionId) {
			const pinned = [...this.agents.values()].find((a) => String(a.session.id) === this.config.target.pinnedSessionId);
			if (pinned) return pinned;
			this.log("warn", `pinned session ${this.config.target.pinnedSessionId} has no live agent`);
		}
		return (this.lastActiveId ? this.agents.get(this.lastActiveId) : null) ?? null;
	}
	async deliver(admitted, note, mode) {
		const agent = this.resolve();
		if (!agent) return {
			ok: false,
			sessionId: null,
			mode: "none",
			reason: "no active session"
		};
		try {
			const content = [{
				type: "text",
				text: note ?? this.config.inject.notePrefix
			}, {
				type: "image",
				attachment: admitted.ref
			}];
			const message = createUserMessage({
				content,
				source: {
					kind: "plugin",
					plugin: "phone-lens"
				}
			});
			this.log("info", `delivering image (${admitted.ref.attachmentId}) to session ${agent.session.id} via ${mode}`);
			if (mode === "steer") agent.steer(message);
			else agent.followup(message);
			return {
				ok: true,
				sessionId: String(agent.session.id),
				mode
			};
		} catch (e) {
			this.log("warn", `delivery failed: ${String(e)}`);
			return {
				ok: false,
				sessionId: null,
				mode: "none",
				reason: String(e)
			};
		}
	}
};

//#endregion
//#region src/inject/target.ts
/**

* Resolves the session an upload should be injected into.

*

* Phase 1: pure config view, no live agents (the agent-event wiring that

* feeds `latest` lands in Phase 2 — see architecture.md §2 D4).

*/
var TargetTracker = class {
	constructor(config) {
		this.config = config;
	}
	/** The session an incoming image would target right now, if any. */
	resolve() {
		if (this.config.target.mode === "pinned" && this.config.target.pinnedSessionId) return {
			sessionId: this.config.target.pinnedSessionId,
			title: "(pinned)",
			active: true,
			running: false
		};
		return null;
	}
	/** Choosable targets for GET /targets. */
	list() {
		const pinned = this.resolve();
		return pinned ? [pinned] : [];
	}
	mode() {
		return this.config.target.mode;
	}
};

//#endregion
//#region src/store/pairing.ts
/** One-shot pairing-code lifecycle: create / verify / burn, with TTL. */
var PairingStore = class {
	code = null;
	createdAt = 0;
	expiresAt = 0;
	used = false;
	constructor(ttlMs) {
		this.ttlMs = ttlMs;
	}
	/** Current live code, or a freshly minted one. */
	current() {
		const now = Date.now();
		if (this.code === null || this.used || now >= this.expiresAt) this.mint(now);
		return {
			code: this.code,
			expiresAt: this.expiresAt
		};
	}
	/** Force a fresh code (manual refresh). Invalidates the previous one. */
	refresh() {
		this.mint(Date.now());
		return {
			code: this.code,
			expiresAt: this.expiresAt
		};
	}
	/**
	
	* Verify a submitted code and burn it on success.
	
	* Constant-time compare; expired codes read as invalid.
	
	*/
	verify(submitted) {
		if (this.code === null || this.used) return {
			ok: false,
			reason: "invalid"
		};
		const now = Date.now();
		if (now >= this.expiresAt) return {
			ok: false,
			reason: "expired"
		};
		const a = Buffer.from(submitted);
		const b = Buffer.from(this.code);
		const same = a.length === b.length && timingSafeEqual(a, b);
		if (!same) return {
			ok: false,
			reason: "invalid"
		};
		this.used = true;
		return { ok: true };
	}
	mint(now) {
		this.code = String(randomInt(0, 1e8)).padStart(8, "0");
		this.createdAt = now;
		this.expiresAt = now + this.ttlMs;
		this.used = false;
	}
};
/** Mint a per-device token. Only its SHA-256 may be persisted. */
function mintDeviceToken() {
	return randomBytes(32).toString("hex");
}
function hashToken(token) {
	return createHash("sha256").update(token).digest("hex");
}
/** Constant-time token-hash comparison. */
function tokenHashMatches(recordHash, presentedToken) {
	const a = Buffer.from(recordHash, "hex");
	const b = Buffer.from(hashToken(presentedToken), "hex");
	return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

//#endregion
//#region src/store/devices.ts
/**

* Paired-device registry, persisted as JSON under the plugin data dir.

* Records carry token HASHES only; the raw token exists solely in the

* pairing response and the phone's secure storage.

*/
var DeviceStore = class {
	devices = new Map();
	file;
	dirty = false;
	constructor(dataDir) {
		mkdirSync(dataDir, { recursive: true });
		this.file = join(dataDir, "devices.json");
		this.load();
	}
	load() {
		if (!existsSync(this.file)) return;
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8"));
			for (const d of raw.devices ?? []) if (typeof d?.deviceId === "string" && typeof d?.tokenHash === "string") this.devices.set(d.deviceId, {
				...d,
				name: d.name ?? "unknown",
				model: d.model ?? "",
				firstPairedAt: d.firstPairedAt ?? Date.now(),
				lastSeenAt: d.lastSeenAt ?? 0
			});
		} catch {}
	}
	persist() {
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, JSON.stringify({
			version: 1,
			devices: [...this.devices.values()]
		}, null, 2), "utf8");
		renameSync(tmp, this.file);
	}
	/** Register/re-register a device, uniquifying the name against others. */
	upsert(record) {
		const prior = this.devices.get(record.deviceId);
		const full = {
			...record,
			name: this.uniquifyName(record.deviceId, record.name),
			firstPairedAt: prior?.firstPairedAt ?? Date.now(),
			lastSeenAt: Date.now()
		};
		this.devices.set(record.deviceId, full);
		this.dirty = true;
		this.persist();
		return full;
	}
	/** Make a display name unique among other devices (x, x (2), x (3), …). */
	uniquifyName(deviceId, name) {
		const others = [...this.devices.values()].map((d) => d.name).filter((n, i, arr) => arr.indexOf(n) === i);
		const base = name.trim() || "Android 设备";
		if (!others.includes(base)) return base;
		for (let n = 2;; n++) {
			const candidate = `${base} (${n})`;
			if (!others.includes(candidate)) return candidate;
		}
	}
	/** Rename a device (user-editable in the web UI); returns the updated record. */
	rename(deviceId, name) {
		const record = this.devices.get(deviceId);
		if (!record) return null;
		record.name = name.trim() || record.name;
		this.dirty = true;
		this.persist();
		return record;
	}
	/** Authenticate deviceId + token; refreshes lastSeenAt on success. */
	authenticate(deviceId, token) {
		const record = this.devices.get(deviceId);
		if (!record) return null;
		if (!tokenHashMatches(record.tokenHash, token)) return null;
		record.lastSeenAt = Date.now();
		this.dirty = true;
		return record;
	}
	remove(deviceId) {
		const had = this.devices.delete(deviceId);
		if (had) this.persist();
		return had;
	}
	list() {
		return [...this.devices.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
	}
	count() {
		return this.devices.size;
	}
};

//#endregion
//#region src/types.ts
const ERROR_CODES = {
	AUTH_REQUIRED: "AUTH_REQUIRED",
	PAIR_CODE_INVALID: "PAIR_CODE_INVALID",
	PAIR_CODE_EXPIRED: "PAIR_CODE_EXPIRED",
	RATE_LIMITED: "RATE_LIMITED",
	TYPE_NOT_ALLOWED: "TYPE_NOT_ALLOWED",
	TOO_LARGE: "TOO_LARGE",
	BAD_MAGIC: "BAD_MAGIC",
	STORE_FAILED: "STORE_FAILED",
	NO_TARGET: "NO_TARGET",
	NO_CAMERA: "NO_CAMERA",
	CAPTURE_TIMEOUT: "CAPTURE_TIMEOUT",
	LOOPBACK_ONLY: "LOOPBACK_ONLY",
	BAD_REQUEST: "BAD_REQUEST",
	INTERNAL: "INTERNAL"
};

//#endregion
//#region src/inject/admit.ts
/** Magic-byte whitelist check — never trust Content-Type alone. */
function magicMatches(mediaType, head) {
	if (mediaType === "image/jpeg") return head.length >= 3 && head[0] === 255 && head[1] === 216 && head[2] === 255;
	if (mediaType === "image/png") return head.length >= 4 && head[0] === 137 && head[1] === 80 && head[2] === 78 && head[3] === 71;
	return false;
}
/**

* Persist one image through the durable attachment seam.

* Falls back to a content-addressed file when the dsh attachments service is

* not mounted (standalone dev / unusual profile), so uploads never vanish.

*/
async function admitImage(input, attachments, fallbackDir) {
	if (attachments) {
		const refs = await attachments.saveImages([{
			data: input.data,
			mediaType: input.mediaType,
			name: input.name
		}]);
		const ref = refs[0];
		if (!ref) throw new Error("attachment store returned no reference");
		return {
			ref,
			storage: "attachments"
		};
	}
	const ext = input.mediaType === "image/png" ? "png" : "jpg";
	const digest = createHash("sha1").update(input.data).digest("hex").slice(0, 16);
	mkdirSync(fallbackDir, { recursive: true });
	const filePath = join(fallbackDir, `${digest}-${input.name.replace(/[^\w.-]+/g, "_") || "image"}.${ext}`);
	writeFileSync(filePath, input.data);
	return {
		ref: {
			attachmentId: `file:${digest}`,
			mediaType: input.mediaType,
			bytes: input.data.byteLength,
			width: 0,
			height: 0,
			name: input.name
		},
		storage: "file",
		filePath
	};
}

//#endregion
//#region src/server/qr.ts
/** Enumerate LAN IPv4 candidates: private ranges first, virtual/tethering included. */
function lanAddresses() {
	const out = [];
	for (const [iface, addrs] of Object.entries(os.networkInterfaces())) for (const addr of addrs ?? []) {
		if (addr.family !== "IPv4" || addr.internal) continue;
		out.push({
			ip: addr.address,
			iface
		});
	}
	const rank = (ip) => {
		if (ip.startsWith("192.168.")) return 0;
		if (ip.startsWith("172.")) return 1;
		if (ip.startsWith("10.")) return 2;
		return 3;
	};
	return out.sort((a, b) => rank(a.ip) - rank(b.ip) || a.ip.localeCompare(b.ip));
}
/** Build the full pairing payload + rendered QR (data URL for browsers, ASCII for terminals). */
async function buildPairingQr(code, expiresAt, config, originOverride) {
	const addrs = lanAddresses();
	const host = originOverride ?? addrs[0]?.ip ?? "127.0.0.1";
	const port = config.server.port;
	const payload = `lensmate://pair?v=1&host=${encodeURIComponent(host)}&port=${port}&code=${code}`;
	const urls = (addrs.length > 0 ? addrs : [{
		ip: "127.0.0.1",
		iface: "loopback"
	}]).map((a) => `http://${a.ip}:${port}`);
	const [pngDataUrl, ascii] = await Promise.all([QRCode.toDataURL(payload, {
		errorCorrectionLevel: "M",
		margin: 2,
		width: 320
	}), QRCode.toString(payload, {
		type: "terminal",
		small: true
	})]);
	return {
		code,
		expiresAt,
		payload,
		urls,
		pngDataUrl,
		ascii
	};
}

//#endregion
//#region src/server/static-view.ts
/**

* The standalone fallback viewfinder page, served at /view.html (loopback only).

* Same protocol as the future Web UI overlay: WS /ws/view frames + capture control.

* Picture-in-Picture turns it into a true always-on-top mini window.

*/
const VIEW_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PhoneLens 直连取景</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #101418; color: #dfe7ee; display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #171d24; border-bottom: 1px solid #232c36; }
  header h1 { font-size: 13px; margin: 0; font-weight: 600; }
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #e5484d; transition: background .2s; }
  #dot.on { background: #46a758; }
  #fps { margin-left: auto; color: #7d8da0; font-variant-numeric: tabular-nums; }
  main { flex: 1; display: flex; min-height: 0; }
  #stage { flex: 1; display: flex; align-items: center; justify-content: center; background: #0b0e11; position: relative; min-width: 0; }
  canvas { max-width: 100%; max-height: 100%; object-fit: contain; background: #000; }
  #hint { position: absolute; color: #7d8da0; }
  aside { width: 240px; border-left: 1px solid #232c36; padding: 12px; overflow: auto; }
  aside h2 { font-size: 12px; margin: 0 0 8px; color: #9fb0c3; text-transform: uppercase; letter-spacing: .08em; }
  #qrimg { width: 100%; image-rendering: pixelated; background: #fff; padding: 8px; border-radius: 8px; }
  .row { display: flex; gap: 6px; align-items: center; margin: 6px 0; }
  .row code { background: #1d242d; padding: 2px 8px; border-radius: 6px; letter-spacing: .12em; font-size: 15px; }
  .row a { color: #3b7cb5; text-decoration: none; }
  .row a:hover { text-decoration: underline; }
  button { background: #1f2937; border: 1px solid #2f3b48; color: #dfe7ee; padding: 6px 10px; border-radius: 8px; cursor: pointer; font-size: 12px; }
  button:hover { background: #28323e; }
  button:disabled { opacity: .45; cursor: default; }
  #shoot { padding: 10px; font-size: 14px; background: #2a5d8f; border-color: #3b7cb5; }
  #pip { display: none; }
  #log { margin-top: 10px; font-size: 12px; color: #8fa1b5; max-height: 160px; overflow: auto; }
  #log div { padding: 2px 0; border-bottom: 1px dashed #202832; }
  #log .ok { color: #58b368; } #log .err { color: #e5696e; }
</style>
</head>
<body>
<header>
  <div id="dot"></div><h1>PhoneLens 直连取景</h1>
  <span id="dev"></span>
  <span id="fps"></span><span id="age"></span>
</header>
<main>
  <div id="stage"><canvas width="854" height="480"></canvas><div id="hint">等待手机连接…</div></div>
  <aside>
    <h2>配对</h2>
    <img id="qrimg" alt="配对二维码">
    <div class="row"><code id="paircode"></code><button id="refresh">刷新</button></div>
    <div class="row" id="urls"></div>
    <div class="row"><a href="https://github.com/yxqfg/phone-lens/releases/latest/download/app-release.apk" target="_blank" rel="noopener">📱 手机还没装 App？点此下载（Android APK）</a></div>
    <h2 style="margin-top:14px">快门</h2>
    <div class="row">
      <button id="shoot" disabled>◉ 拍照并注入</button>
      <button id="pip">置顶小窗</button>
    </div>
    <div id="log"></div>
  </aside>
</main>
<video id="pipvid" muted playsinline style="display:none"></video>
<script>
'use strict';
const $ = (id) => document.getElementById(id);
const canvas = $('stage').querySelector('canvas');
const ctx2d = canvas.getContext('2d');
const logEl = $('log');
let lastFrameAt = 0, frames = 0, fpsTimer = 0, pendingShot = null;
let streamRotation = 0;

function log(msg, cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = new Date().toLocaleTimeString() + ' ' + msg;
  logEl.prepend(d);
  while (logEl.childElementCount > 50) logEl.lastChild.remove();
}

async function refreshQr() {
  try {
    const r = await fetch('/qr.json');
    const j = await r.json();
    $('qrimg').src = j.pngDataUrl;
    $('paircode').textContent = j.code;
    $('urls').innerHTML = (j.urls || []).map(u => '<span style="color:#7d8da0">' + u + '</span>').join('<br>');
  } catch (e) { log('二维码加载失败: ' + e.message, 'err'); }
}
$('refresh').onclick = () => { wsSend({ type: 'refresh_pairing' }); setTimeout(refreshQr, 150); };

function drawFrame(buf) {
  const blob = new Blob([buf], { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const r = ((streamRotation % 360) + 360) % 360;
    const swap = r === 90 || r === 270;
    const w = swap ? img.height : img.width;
    const h = swap ? img.width : img.height;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx2d.save();
    ctx2d.translate(w / 2, h / 2);
    ctx2d.rotate(r * Math.PI / 180);
    ctx2d.drawImage(img, -img.width / 2, -img.height / 2);
    ctx2d.restore();
    URL.revokeObjectURL(url);
    $('hint').style.display = 'none';
    frames++;
    const now = performance.now();
    if (now - fpsTimer >= 1000) { $('fps').textContent = (frames * 1000 / (now - fpsTimer)).toFixed(1) + ' fps'; frames = 0; fpsTimer = now; }
    lastFrameAt = now;
  };
  img.src = url;
}

let ws = null;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws/view');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { log('已连接'); refreshQr(); };
  ws.onclose = () => { $('dot').className = ''; setTimeout(connect, 1500); };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) { drawFrame(ev.data); return; }
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'meta':
        $('dot').className = m.camera.connected ? 'on' : '';
        $('dev').textContent = m.camera.name || (m.camera.connected ? '已连接' : '未连接');
        $('shoot').disabled = !m.camera.connected;
        if (m.camera.rotation !== undefined) streamRotation = m.camera.rotation;
        $('hint').style.display = m.camera.connected ? 'none' : '';
        break;
      case 'frame_meta':
        if (m.rotation !== undefined) streamRotation = m.rotation;
        break;
      case 'device':
        $('dot').className = m.online ? 'on' : '';
        $('dev').textContent = m.online ? (m.name || '已连接') : '未连接';
        $('shoot').disabled = !m.online;
        $('hint').style.display = m.online ? 'none' : '';
        $('hint').textContent = '等待手机连接…';
        break;
      case 'capture_pending':
        pendingShot = m.captureId;
        log('快门已触发' + (m.note ? '(' + m.note + ')' : '') + '…');
        break;
      case 'injected':
        pendingShot = null;
        if (m.ok) log('已注入会话 ' + (m.sessionId || '').slice(0, 8) + (m.name ? ' · ' + m.name : ''), 'ok');
        else log('入库成功,注入未完成: ' + (m.reason || ''), 'err');
        break;
      case 'upload':
        log('图片已入库 ' + (m.name || ''), 'ok');
        break;
      case 'error':
        log('错误 ' + m.code + (m.message ? ': ' + m.message : ''), 'err');
        break;
    }
  };
}
function wsSend(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

$('shoot').onclick = () => wsSend({ type: 'capture', note: '' });

// PiP: mirror the canvas into a video stream, then request Picture-in-Picture.
$('pip').onclick = async () => {
  try {
    const stream = canvas.captureStream(10);
    const v = $('pipvid');
    v.srcObject = stream;
    await v.play();
    await v.requestPictureInPicture();
  } catch (e) { log('画中画失败: ' + e.message, 'err'); }
};

setInterval(() => {
  if (document.pictureInPictureElement) return;
  if (performance.now() - lastFrameAt > 4000 && lastFrameAt > 0) $('hint').style.display = '';
  $('age').textContent = lastFrameAt > 0 ? ' · ' + ((performance.now() - lastFrameAt) / 1000).toFixed(1) + 's前' : '';
}, 1000);
if (document.pictureInPictureEnabled) $('pip').style.display = '';

connect();
</script>
</body>
</html>
`;

//#endregion
//#region src/server/auth.ts
/** Sliding-window rate limiter (in-memory; resets with the process). */
var RateLimiter = class {
	hits = new Map();
	constructor(windowMs, max) {
		this.windowMs = windowMs;
		this.max = max;
	}
	/** Record one hit and report whether the key is still within budget. */
	allow(key) {
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
};
const LOOPBACK = new Set([
	"127.0.0.1",
	"::1",
	"::ffff:127.0.0.1"
]);
/** Whether the connection originates from this machine (loopback). */
function isLoopback(req) {
	const addr = req.socket.remoteAddress ?? "";
	return LOOPBACK.has(addr);
}
/**

* CORS for the dsh Web UI page (served on another loopback port) so it can

* fetch /qr.json and /status from this receiver. Only same-machine origins

* are echoed — a foreign page must not read the pairing code, and its

* cross-origin JSON POST fails the preflight we never answer.

*/
function corsFor(req) {
	const origin = req.headers.origin;
	if (typeof origin !== "string" || origin === "") return {};
	try {
		const u = new URL(origin);
		const host = u.hostname.replace(/^\[|\]$/g, "");
		if (u.protocol === "http:" && LOOPBACK.has(host)) return {
			"access-control-allow-origin": origin,
			"access-control-allow-methods": "GET, POST, OPTIONS",
			"access-control-allow-headers": "content-type, x-lm-device, x-lm-token",
			"access-control-max-age": "600"
		};
	} catch {}
	return {};
}
/** Extract a stable client key for rate limiting. */
function clientKey(req) {
	return req.socket.remoteAddress ?? "unknown";
}
/** Read the device auth headers, if present. */
function deviceAuth(req) {
	const deviceId = req.headers["x-lm-device"];
	const token = req.headers["x-lm-token"];
	if (typeof deviceId !== "string" || typeof token !== "string" || !deviceId || !token) return null;
	return {
		deviceId,
		token
	};
}
/** Query-string parser (URLSearchParams handles plus-encoding for notes). */
function queryOf(req) {
	const url = new URL(req.url ?? "/", "http://phone-lens.local");
	return url.searchParams;
}

//#endregion
//#region src/server/http.ts
/** Boot the receiver: HTTP routes + two websocket endpoints. */
async function startLensServer(deps) {
	const { config, pairing, devices, hub, targets, sink, log } = deps;
	const pairLimiter = new RateLimiter(6e4, 10);
	const uploadLimiter = new RateLimiter(6e4, config.limits.uploadsPerMinute);
	let currentCameraDeviceId = null;
	const injectionBox = { last: null };
	const server = createServer((req, res) => {
		handle(deps, req, res, {
			pairLimiter,
			uploadLimiter,
			getCurrentCamera: () => currentCameraDeviceId,
			noteInjection: (receipt, attachmentId) => {
				injectionBox.last = {
					at: Date.now(),
					sessionId: receipt.sessionId,
					attachmentId,
					ok: receipt.ok
				};
			},
			getLastInjection: () => injectionBox.last
		}).catch((error) => {
			log("error", `request failed: ${String(error)}`);
			if (!res.headersSent) sendJson(res, 500, { error: {
				code: ERROR_CODES.INTERNAL,
				message: String(error)
			} });
			else res.destroy();
		});
	});
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: config.limits.previewFrameMaxBytes * 4
	});
	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://phone-lens.local");
		const done = (status, message) => {
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
			wss.handleUpgrade(req, socket, head, (ws) => hub.attachView(ws, {
				onRefreshPairing: () => pairing.refresh(),
				onRenameDevice: (deviceId, name) => {
					const updated = devices.rename(deviceId, name);
					if (updated) hub.renameDevice(deviceId, updated.name);
				}
			}));
			return;
		}
		done(404, "Not Found");
	});
	const heartbeat = setInterval(() => hub.pingAll(), 2e4);
	await new Promise((resolve, reject) => {
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
			await new Promise((resolve) => server.close(() => resolve()));
		}
	};
}
async function handle(deps, req, res, ctx) {
	const { config, pairing, devices, hub, targets, sink, log } = deps;
	const url = new URL(req.url ?? "/", "http://phone-lens.local");
	const path = url.pathname.replace(/\/+$/, "") || "/";
	const method = req.method ?? "GET";
	const loop = isLoopback(req);
	const cors = corsFor(req);
	if (method === "OPTIONS") {
		res.writeHead(204, cors);
		res.end();
		return;
	}
	if (method === "GET" && path === "/info") return sendJson(res, 200, {
		name: "PhoneLens 直连取景",
		version: "0.3.0",
		requiresPairing: true
	}, cors);
	if (!loop && (path === "/" || path === "/view.html" || path === "/qr.json" || path === "/qr.png" || path === "/app-qr.json")) return sendError(res, 403, ERROR_CODES.LOOPBACK_ONLY, "preview surface is loopback-only");
	if (method === "GET" && (path === "/" || path === "/view.html")) {
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store"
		});
		res.end(VIEW_HTML);
		return;
	}
	if (method === "GET" && path === "/qr.json") {
		const { code, expiresAt } = pairing.current();
		const qr = await buildPairingQr(code, expiresAt, config);
		return sendJson(res, 200, {
			code: qr.code,
			expiresAt: qr.expiresAt,
			payload: qr.payload,
			urls: qr.urls,
			pngDataUrl: qr.pngDataUrl
		}, {
			...cors,
			"cache-control": "no-store"
		});
	}
	if (method === "GET" && path === "/qr.png") {
		const { code, expiresAt } = pairing.current();
		const qr = await buildPairingQr(code, expiresAt, config);
		const b64 = qr.pngDataUrl.slice(qr.pngDataUrl.indexOf(",") + 1);
		res.writeHead(200, {
			"content-type": "image/png",
			"cache-control": "no-store"
		});
		res.end(Buffer.from(b64, "base64"));
		return;
	}
	if (method === "GET" && path === "/app-qr.json") {
		const target = config.app.downloadUrl || config.app.giteeUrl;
		const pngDataUrl = await QRCode.toDataURL(target, {
			errorCorrectionLevel: "M",
			margin: 2,
			width: 320
		});
		return sendJson(res, 200, {
			url: target,
			gitee: config.app.giteeUrl,
			github: config.app.githubUrl,
			pngDataUrl
		}, {
			...cors,
			"cache-control": "no-store"
		});
	}
	if (method === "POST" && path === "/pair") {
		const body = await readJsonBody(req, 4096);
		const code = str(body?.code);
		const device = body?.device ?? {};
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
		devices.upsert({
			deviceId,
			name,
			model,
			tokenHash: hashToken(token)
		});
		log("info", `paired device "${name}" (${deviceId.slice(0, 8)})`);
		return sendJson(res, 200, {
			token,
			serverInfo: {
				preview: config.preview,
				limits: config.limits
			}
		});
	}
	const auth = loop ? { ok: true } : deviceAuth(req) && devices.authenticate(deviceAuth(req).deviceId, deviceAuth(req).token) ? { ok: true } : { ok: false };
	if (!auth.ok) return sendError(res, 401, ERROR_CODES.AUTH_REQUIRED, "pair this device first");
	if (method === "POST" && path === "/upload") {
		const q = queryOf(req);
		if (!ctx.uploadLimiter.allow(loop ? "loopback" : clientKey(req))) return sendError(res, 429, ERROR_CODES.RATE_LIMITED, "upload rate exceeded");
		const mediaType = (req.headers["content-type"] ?? "").split(";")[0].trim();
		if (!config.limits.allowedTypes.includes(mediaType)) return sendError(res, 415, ERROR_CODES.TYPE_NOT_ALLOWED, `allowed: ${config.limits.allowedTypes.join(", ")}`);
		const declared = Number(req.headers["content-length"] ?? "0");
		if (declared > config.limits.maxUploadBytes) return sendError(res, 413, ERROR_CODES.TOO_LARGE, `> ${config.limits.maxUploadBytes} bytes`);
		const { buf, truncated } = await readRawBody(req, config.limits.maxUploadBytes);
		if (truncated) return sendError(res, 413, ERROR_CODES.TOO_LARGE, `> ${config.limits.maxUploadBytes} bytes`);
		if (!magicMatches(mediaType, buf)) return sendError(res, 415, ERROR_CODES.BAD_MAGIC, "bytes do not match the declared type");
		const captureId = q.get("captureId");
		const note = q.get("note") ?? (captureId ? hub.noteFor(captureId) : void 0);
		if (captureId) hub.consumeCapture(captureId);
		const name = (q.get("name") ?? `shot_${new Date().toISOString().replace(/[:.]/g, "-")}.${mediaType === "image/png" ? "png" : "jpg"}`).slice(0, 120);
		let admitted;
		try {
			admitted = await admitImage({
				data: buf,
				mediaType,
				name
			}, deps.attachments(), deps.fallbackDir);
		} catch (error) {
			log("error", `admit failed: ${String(error)}`);
			return sendError(res, 500, ERROR_CODES.STORE_FAILED, String(error));
		}
		log("info", `stored ${name} (${buf.byteLength}B) → ${admitted.storage}:${admitted.ref.attachmentId}`);
		if (admitted.storage === "file") await pruneUploads(deps.fallbackDir, config.limits.maxStoredUploads).catch((error) => log("warn", `upload pruning failed: ${String(error)}`));
		const pendingPath = join(deps.pendingDir, `${admitted.ref.attachmentId}.jpg`);
		try {
			mkdirSync(deps.pendingDir, { recursive: true });
			writeFileSync(pendingPath, buf);
			log("info", `staged for composer: ${pendingPath}`);
		} catch (error) {
			log("warn", `staging failed: ${String(error)}`);
		}
		hub.broadcastToViews({
			type: "pending_image",
			attachmentId: admitted.ref.attachmentId,
			name
		});
		return sendJson(res, 200, {
			ok: true,
			attachmentId: admitted.ref.attachmentId,
			width: admitted.ref.width,
			height: admitted.ref.height,
			bytes: admitted.ref.bytes,
			storage: admitted.storage,
			delivered: null,
			deliverReason: "staged-in-composer"
		});
	}
	if (method === "GET" && path.startsWith("/pending/") && loop) {
		const id = path.slice(9).split("/")[0] ?? "";
		const file = join(deps.pendingDir, `${id}.jpg`);
		try {
			const data = await readFile(file);
			res.writeHead(200, {
				"content-type": "image/jpeg",
				"cache-control": "no-store",
				...cors
			});
			res.end(data);
			return;
		} catch {
			return sendError(res, 404, ERROR_CODES.BAD_REQUEST, "pending image not found");
		}
	}
	if (method === "GET" && path === "/status") {
		const cameraDeviceId = ctx.getCurrentCamera();
		return sendJson(res, 200, {
			devices: devices.list().map((d) => ({
				id: d.deviceId,
				name: d.name,
				model: d.model,
				online: d.deviceId === cameraDeviceId,
				streaming: d.deviceId === cameraDeviceId,
				lastSeenAt: d.lastSeenAt
			})),
			camera: hub.stats(),
			preview: config.preview,
			target: {
				mode: targets.mode(),
				sessionId: targets.resolve()?.sessionId ?? null
			},
			lastInjection: ctx.getLastInjection()
		}, cors);
	}
	if (method === "GET" && path === "/targets") return sendJson(res, 200, {
		targets: targets.list(),
		default: targets.resolve()?.sessionId ?? null
	}, cors);
	if (method === "POST" && path === "/capture" && loop) {
		const captureId = randomUUID();
		const ok = hub.requestCapture(captureId, queryOf(req).get("note") ?? void 0);
		if (!ok) return sendError(res, 409, ERROR_CODES.NO_CAMERA, "no camera uplink connected");
		return sendJson(res, 202, { captureId });
	}
	return sendError(res, 404, ERROR_CODES.BAD_REQUEST, `no route ${method} ${path}`);
}
function sendJson(res, status, body, extraHeaders) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		...extraHeaders ?? {}
	});
	res.end(JSON.stringify(body));
}
function sendError(res, status, code, message) {
	sendJson(res, status, { error: {
		code,
		message
	} });
}
function str(v) {
	return typeof v === "string" ? v : void 0;
}
async function readJsonBody(req, limit) {
	const { buf } = await readRawBody(req, limit);
	try {
		return JSON.parse(buf.toString("utf8"));
	} catch {
		return null;
	}
}
function readRawBody(req, maxBytes) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let truncated = false;
		req.on("data", (chunk) => {
			size += chunk.byteLength;
			if (size > maxBytes) {
				truncated = true;
				chunks.length = 0;
				req.destroy();
				resolve({
					buf: Buffer.alloc(0),
					truncated
				});
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve({
			buf: Buffer.concat(chunks),
			truncated
		}));
		req.on("error", reject);
	});
}
/** Delete the oldest files beyond `max` in a directory (mtime order). */
async function pruneUploads(dir, max) {
	if (max <= 0) return;
	const names = await readdir(dir);
	if (names.length <= max) return;
	const entries = await Promise.all(names.map(async (name) => {
		let mtime = 0;
		try {
			mtime = (await stat(join(dir, name))).mtimeMs;
		} catch {
			mtime = 0;
		}
		return {
			name,
			mtime
		};
	}));
	entries.sort((a, b) => b.mtime - a.mtime);
	for (const entry of entries.slice(max)) await unlink(join(dir, entry.name)).catch(() => {});
}

//#endregion
//#region src/server/hub.ts
/**

* The viewfinder hub: MULTIPLE camera uplinks (one per phone, keyed by

* deviceId), N loopback view downlinks. The "active" device is auto-selected

* as the last one to send a frame; the view side can switch it via

* `select_device`. Only the active device's frames are fanned out — a second

* phone connecting no longer kicks the first, so several paired phones coexist

* and the user picks which one to watch / shoot from.

*/
var ViewHub = class {
	cameras = new Map();
	activeDeviceId = null;
	views = new Set();
	/** captureId → { note, requestedAt } until the matching upload lands or timeout. */
	pendingCaptures = new Map();
	captureTimeoutMs = 6e4;
	constructor(config, log) {
		this.config = config;
		this.log = log;
	}
	attachCamera(deviceId, ws, name) {
		const prev = this.cameras.get(deviceId);
		if (prev) {
			try {
				prev.ws.close(1e3, "new-instance");
			} catch {}
			this.cameras.delete(deviceId);
		}
		const cam = {
			ws,
			name,
			meta: {},
			lastFrame: null,
			lastFrameAt: 0,
			frameCount: 0,
			windowStart: Date.now(),
			measuredFps: 0
		};
		this.cameras.set(deviceId, cam);
		if (this.activeDeviceId === null) this.activeDeviceId = deviceId;
		if (this.activeDeviceId === deviceId) this.sendControl(deviceId, { type: "resume_preview" });
		else this.sendControl(deviceId, { type: "pause_preview" });
		this.log("info", `camera uplink: ${name} (${deviceId.slice(0, 8)})`);
		ws.on("close", () => {
			if (this.cameras.get(deviceId)?.ws === ws) this.detachCamera(deviceId);
		});
		ws.on("message", (data, isBinary) => {
			if (isBinary) {
				this.ingestFrame(deviceId, data);
				return;
			}
			this.onCameraControl(deviceId, safeJson(data.toString()));
		});
		this.broadcastDevices();
	}
	detachCamera(deviceId) {
		const cam = this.cameras.get(deviceId);
		if (cam) this.cameras.delete(deviceId);
		if (this.activeDeviceId === deviceId) {
			const next = [...this.cameras.keys()].at(-1) ?? null;
			this.activeDeviceId = next;
			if (next) this.sendControl(next, { type: "resume_preview" });
			this.pushActiveFrameToViews();
		}
		this.broadcastDevices();
	}
	detachAll() {
		for (const cam of this.cameras.values()) try {
			cam.ws.close(1e3, "server-dispose");
		} catch {}
		this.cameras.clear();
		this.activeDeviceId = null;
		this.broadcastDevices();
	}
	pingAll() {
		for (const cam of this.cameras.values()) if (cam.ws.readyState === cam.ws.OPEN) cam.ws.ping();
	}
	onCameraControl(deviceId, msg) {
		if (!msg) return;
		const cam = this.cameras.get(deviceId);
		if (!cam) return;
		switch (msg.type) {
			case "hello":
				cam.meta = {
					width: msg.width,
					height: msg.height,
					fps: msg.fps,
					...msg.rotation !== void 0 ? { rotation: msg.rotation } : {}
				};
				if (this.activeDeviceId === deviceId) this.broadcastToViews({
					type: "frame_meta",
					width: msg.width,
					height: msg.height,
					...msg.rotation !== void 0 ? { rotation: msg.rotation } : {}
				});
				break;
			case "bye":
				this.detachCamera(deviceId);
				break;
			case "claim_active":
				this.selectDevice(deviceId);
				break;
			case "capture_result":
				if (msg.status !== "taken") {
					this.pendingCaptures.delete(msg.captureId);
					this.broadcastToViews({
						type: "error",
						code: "CAPTURE_DECLINED",
						message: `phone reported ${msg.status}${msg.detail ? `: ${msg.detail}` : ""}`
					});
				}
				break;
			default: break;
		}
	}
	ingestFrame(deviceId, frame) {
		const cam = this.cameras.get(deviceId);
		if (!cam || frame.byteLength === 0) return;
		if (frame.byteLength > this.config.limits.previewFrameMaxBytes) {
			this.log("warn", `dropping oversized preview frame from ${deviceId.slice(0, 8)} (${frame.byteLength}B > ${this.config.limits.previewFrameMaxBytes}B)`);
			return;
		}
		const now = Date.now();
		cam.lastFrame = frame;
		cam.lastFrameAt = now;
		cam.frameCount++;
		if (now - cam.windowStart >= 2e3) {
			cam.measuredFps = cam.frameCount * 1e3 / (now - cam.windowStart);
			cam.windowStart = now;
			cam.frameCount = 0;
		}
		if (this.activeDeviceId === deviceId) {
			for (const view of this.views) if (view.readyState === view.OPEN) view.send(frame, { binary: true });
		}
	}
	attachView(ws, hooks = {}) {
		this.views.add(ws);
		ws.on("close", () => this.views.delete(ws));
		ws.on("message", (data, isBinary) => {
			if (isBinary) return;
			const msg = parseViewClient(data.toString());
			if (!msg) return;
			if (msg.type === "capture") {
				const captureId = randomUUID();
				if (!this.requestCapture(captureId, msg.note)) this.broadcastToViews({
					type: "error",
					code: "NO_CAMERA",
					message: "no camera uplink connected"
				});
			} else if (msg.type === "select_device") this.selectDevice(msg.deviceId);
			else if (msg.type === "rename_device") hooks.onRenameDevice?.(msg.deviceId, msg.name);
			else if (msg.type === "refresh_pairing") hooks.onRefreshPairing?.();
		});
		const active = this.activeCam();
		ws.send(JSON.stringify({
			type: "meta",
			camera: active ? {
				connected: true,
				name: active.name,
				...active.meta
			} : { connected: false },
			preview: this.config.preview,
			paired: true
		}));
		this.broadcastDevicesTo(ws);
		if (active?.lastFrame && ws.readyState === ws.OPEN) ws.send(active.lastFrame, { binary: true });
	}
	viewCount() {
		return this.views.size;
	}
	/** Update one device's display name and re-broadcast the device list. */
	renameDevice(deviceId, name) {
		const cam = this.cameras.get(deviceId);
		if (cam) cam.name = name;
		this.broadcastDevices();
	}
	/** Switch which phone's frames / shutter the view follows. */
	selectDevice(deviceId) {
		if (!this.cameras.has(deviceId)) return;
		const prevActive = this.activeDeviceId;
		if (prevActive === deviceId) return;
		this.activeDeviceId = deviceId;
		if (prevActive) this.sendControl(prevActive, { type: "pause_preview" });
		this.sendControl(deviceId, { type: "resume_preview" });
		this.broadcastDevices();
		this.pushActiveFrameToViews();
	}
	/** Send one control message to a specific phone uplink. */
	sendControl(deviceId, msg) {
		const cam = this.cameras.get(deviceId);
		if (cam && cam.ws.readyState === cam.ws.OPEN) cam.ws.send(JSON.stringify(msg));
	}
	pushActiveFrameToViews() {
		const active = this.activeCam();
		if (active?.lastFrame) {
			for (const view of this.views) if (view.readyState === view.OPEN) view.send(active.lastFrame, { binary: true });
		}
		if (active) this.broadcastToViews({
			type: "frame_meta",
			width: active.meta.width ?? 0,
			height: active.meta.height ?? 0,
			...active.meta.rotation !== void 0 ? { rotation: active.meta.rotation } : {}
		});
	}
	activeCam() {
		return this.activeDeviceId ? this.cameras.get(this.activeDeviceId) : void 0;
	}
	broadcastDevices() {
		for (const view of this.views) this.broadcastDevicesTo(view);
	}
	broadcastDevicesTo(view) {
		if (view.readyState !== view.OPEN) return;
		view.send(JSON.stringify({
			type: "devices",
			devices: [...this.cameras.values()].map((c, i) => {
				const id = [...this.cameras.keys()][i];
				return {
					id,
					name: c.name,
					active: id === this.activeDeviceId
				};
			})
		}));
	}
	/** Ask the ACTIVE phone to shoot. Returns the captureId, or null when none. */
	requestCapture(captureId, note) {
		const active = this.activeCam();
		if (!active || active.ws.readyState !== active.ws.OPEN) return null;
		this.pendingCaptures.set(captureId, {
			note,
			requestedAt: Date.now()
		});
		active.ws.send(JSON.stringify({
			type: "capture",
			captureId,
			...note ? { note } : {}
		}));
		this.broadcastToViews({
			type: "capture_pending",
			captureId,
			...note ? { note } : {}
		});
		this.gcCaptures();
		return captureId;
	}
	consumeCapture(captureId) {
		const pending = this.pendingCaptures.get(captureId);
		if (!pending) return null;
		this.pendingCaptures.delete(captureId);
		return { note: pending.note };
	}
	noteFor(captureId) {
		return this.pendingCaptures.get(captureId)?.note;
	}
	gcCaptures() {
		const cutoff = Date.now() - this.captureTimeoutMs;
		for (const [id, p] of this.pendingCaptures) if (p.requestedAt < cutoff) this.pendingCaptures.delete(id);
	}
	broadcastToViews(msg) {
		const text = JSON.stringify(msg);
		for (const view of this.views) if (view.readyState === view.OPEN) view.send(text);
	}
	stats() {
		const active = this.activeCam();
		return {
			connected: this.cameras.size > 0,
			fps: active ? Math.round(active.measuredFps * 10) / 10 : 0,
			lastFrameAt: active?.lastFrameAt ?? 0,
			views: this.views.size,
			devices: this.cameras.size
		};
	}
};
function safeJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
function parseViewClient(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

//#endregion
//#region src/paths.ts
/** Where pairing records + fallback uploads live (mirrors dsh-home conventions). */
function lensDataDir() {
	const home = env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "phone-lens");
}

//#endregion
//#region src/index.ts
/**

* phone-lens host plugin.

*

* Boots the receiver inside the dsh process so uploads can flow straight

* into `ctx.attachments` (and, from Phase 2 on, into agent inboxes) with no

* extra IPC. Everything registered here unwinds with the fiber.

*/
var PhoneLens = class extends Service {
	static inject = [];
	static Config = z.any();
	constructor(ctx, rawConfig) {
		super(ctx, "phoneLens");
		const config = normalizeConfig(rawConfig);
		const dataDir = lensDataDir();
		const log = (level, msg) => {
			const target = ctx.logger ?? console;
			target[level]?.(`[phone-lens] ${msg}`);
		};
		const pairing = new PairingStore(config.pairing.codeTtlMs);
		const devices = new DeviceStore(dataDir);
		const hub = new ViewHub(config, (level, msg) => log(level, msg));
		const targets = new TargetTracker(config);
		const sink = new HostDeliverySink(config, (level, msg) => log(level, msg));
		const attachments = () => ctx.get?.("attachments");
		const onAgent = (agent) => sink.track(agent);
		const offAgent = (agent) => sink.untrack(agent);
		ctx.on?.("agent/session-start", (payload) => onAgent(payload.agent));
		ctx.on?.("agent/inbox/inserted", (payload) => onAgent(payload.agent));
		ctx.on?.("agent/status", (payload) => {
			if (payload.status === "running") onAgent(payload.agent);
		});
		ctx.on?.("agent/disposed", (payload) => offAgent(payload.agent));
		let handle$1 = null;
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
			log
		}).then(async (h) => {
			handle$1 = h;
			const { code, expiresAt } = pairing.current();
			const qr = await buildPairingQr(code, expiresAt, config);
			process.stdout.write(`\n[phone-lens] 手机扫码配对(或浏览器打开 http://127.0.0.1:${h.port}/view.html):\n${qr.ascii}\n[phone-lens] 备用地址: ${qr.urls.join("  ")}\n\n`);
		}).catch((error) => {
			log("error", `receiver failed to start: ${String(error)} (check port ${config.server.port})`);
		});
		ctx.effect(() => () => {
			handle$1?.dispose();
			handle$1 = null;
		}, "phone-lens.server()");
	}
};

//#endregion
export { PhoneLens as default };
//# sourceMappingURL=index.js.map