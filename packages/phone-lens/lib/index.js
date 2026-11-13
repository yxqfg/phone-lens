import { basename, dirname, join, resolve, sep } from "node:path";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { open, readFile, readdir, rm, stat, unlink } from "node:fs/promises";
import * as os from "node:os";
import { homedir } from "node:os";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { env } from "node:process";

//#region src/config.ts
/**

* Offline fallback for the Gitee APK download link. Since v1.0.2 the actual

* link is resolved from Gitee's public latest-release API at runtime (see

* server/apk-link.ts), so this constant needs NO per-release bump anymore —

* it only serves when the API is unreachable, and deliberately points at a

* release known to exist (pointing it at a future tag would 404 until that

* release is actually published).

*/
const GITEE_APK_DEFAULT = "https://gitee.com/qianfengbingtang/phone-lens/releases/download/v1.1.0/app-release.apk";
/** Coerce an unknown config object (cordis patch row / CLI overrides) into LensConfig. */
function normalizeConfig(raw) {
	const r = raw ?? {};
	const server = r.server ?? {};
	const limits = r.limits ?? {};
	const pairing = r.pairing ?? {};
	const preview = r.preview ?? {};
	const target = r.target ?? {};
	const app = r.app ?? {};
	const GITHUB_APK = "https://github.com/yxqfg/phone-lens/releases/latest/download/app-release.apk";
	const giteeUrl = typeof app.giteeUrl === "string" && app.giteeUrl ? app.giteeUrl : GITEE_APK_DEFAULT;
	const allowed = Array.isArray(limits.allowedTypes) ? limits.allowedTypes.filter((t) => typeof t === "string") : void 0;
	return {
		server: {
			host: typeof server.host === "string" && server.host ? server.host : "0.0.0.0",
			port: Number.isInteger(server.port) && server.port > 0 && server.port < 65536 ? server.port : 8791
		},
		limits: {
			maxUploadBytes: positiveInt(limits.maxUploadBytes, 10 * 1024 * 1024),
			allowedTypes: allowed && allowed.length > 0 ? allowed : ["image/jpeg", "image/png"],
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
		try {
			const tmp = `${this.file}.tmp`;
			writeFileSync(tmp, JSON.stringify({
				version: 1,
				devices: [...this.devices.values()]
			}, null, 2), "utf8");
			renameSync(tmp, this.file);
		} catch {}
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
		this.persist();
		return record;
	}
	/** Authenticate deviceId + token; refreshes lastSeenAt on success. */
	authenticate(deviceId, token) {
		const record = this.devices.get(deviceId);
		if (!record) return null;
		if (!tokenHashMatches(record.tokenHash, token)) return null;
		if (Date.now() - record.lastSeenAt > 6e4) {
			record.lastSeenAt = Date.now();
			this.persist();
		} else record.lastSeenAt = Date.now();
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
//#region src/store/settings.ts
const SAVE_MODES = [
	"composer",
	"folder",
	"both"
];
/**
* User-facing capture settings, persisted as JSON under the plugin data dir.
* Stored host-side on purpose: the folder save happens on this machine, and
* every loopback view (overlay, /view.html) must see the same mode.
*/
var AppSettingsStore = class {
	data;
	constructor(file, defaultSaveDir) {
		this.file = file;
		this.defaultSaveDir = defaultSaveDir;
		this.data = {
			saveMode: "composer",
			saveDir: "",
			modelToolsEnabled: true,
			modelToolsConfirmFree: false,
			workBetaEnabled: false
		};
		this.load();
	}
	load() {
		if (!existsSync(this.file)) return;
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8"));
			if (SAVE_MODES.includes(raw.saveMode)) this.data.saveMode = raw.saveMode;
			if (typeof raw.saveDir === "string") this.data.saveDir = raw.saveDir;
			if (typeof raw.modelToolsEnabled === "boolean") this.data.modelToolsEnabled = raw.modelToolsEnabled;
			if (typeof raw.modelToolsConfirmFree === "boolean") this.data.modelToolsConfirmFree = raw.modelToolsConfirmFree;
			if (typeof raw.workBetaEnabled === "boolean") this.data.workBetaEnabled = raw.workBetaEnabled;
		} catch {}
	}
	get() {
		return { ...this.data };
	}
	/** Effective absolute folder (resolved default when unset). */
	effectiveSaveDir() {
		return this.data.saveDir.trim() || this.defaultSaveDir;
	}
	set(patch) {
		if (patch.saveMode && SAVE_MODES.includes(patch.saveMode)) this.data.saveMode = patch.saveMode;
		if (typeof patch.saveDir === "string") this.data.saveDir = patch.saveDir.replace(/^["']|["']$/g, "").trim();
		if (typeof patch.modelToolsEnabled === "boolean") this.data.modelToolsEnabled = patch.modelToolsEnabled;
		if (typeof patch.modelToolsConfirmFree === "boolean") this.data.modelToolsConfirmFree = patch.modelToolsConfirmFree;
		if (typeof patch.workBetaEnabled === "boolean") this.data.workBetaEnabled = patch.workBetaEnabled;
		this.persist();
		return this.get();
	}
	persist() {
		try {
			mkdirSync(join(this.file, ".."), { recursive: true });
			const tmp = `${this.file}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
			renameSync(tmp, this.file);
		} catch {}
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
	NO_CAMERA: "NO_CAMERA",
	CAPTURE_TIMEOUT: "CAPTURE_TIMEOUT",
	LOOPBACK_ONLY: "LOOPBACK_ONLY",
	BAD_HOST: "BAD_HOST",
	BAD_REQUEST: "BAD_REQUEST",
	INTERNAL: "INTERNAL"
};

//#endregion
//#region src/server/update-check.ts
const GITEE_RELEASES_API$1 = "https://gitee.com/api/v5/repos/qianfengbingtang/phone-lens/releases?per_page=10&direction=desc";
/** A fresh result suppresses further API calls for 12h (host sits open all day). */
const OK_TTL_MS = 12 * 60 * 60 * 1e3;
/** A failed check retries after 30min instead of hammering the API per panel-open. */
const FAIL_TTL_MS = 30 * 60 * 1e3;
const TIMEOUT_MS = 6e3;
let cached$1 = null;
let inflight$1 = null;
/** Running plugin version. `../package.json` matches http.ts's hostVersion():
* tsdown flattens every entry into lib/*.js, so ONE level up is the package
* root in BOTH bundle shapes (lib/index.js, lib/dev.js). A failed read (or
* "0.0.0") makes the caller report null — never a bogus "update available". */
function ownVersion$1() {
	try {
		const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
		return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}
/** Three-segment x.y.z compare, tolerant of a leading "v" (missing segments = 0). */
function compareVersions(a, b) {
	const parse = (v) => v.trim().replace(/^v/, "").split(".").map((seg) => Number.parseInt(seg, 10) || 0);
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < 3; i++) {
		const av = pa[i] ?? 0;
		const bv = pb[i] ?? 0;
		if (av !== bv) return av < bv ? -1 : 1;
	}
	return 0;
}
/** Highest release tag across the first page of the trusted Gitee feed, or
*  null on any failure. Client-side max() over tag_name, so a stale-but-recently
*  edited release can never shadow the real newest version. */
async function fetchLatestGiteeTag() {
	try {
		const url = new URL(GITEE_RELEASES_API$1);
		if (url.protocol !== "https:" || url.host !== "gitee.com") return null;
		const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) return null;
		const data = await res.json();
		if (!Array.isArray(data)) return null;
		let best = null;
		for (const row of data) {
			const tag = row?.tag_name;
			if (typeof tag !== "string" || !tag.trim()) continue;
			const clean = tag.trim();
			if (best === null || compareVersions(clean, best) > 0) best = clean;
		}
		return best;
	} catch {
		return null;
	}
}
/**
* Check for a host-side plugin update (cached; called per panel-open).
* Returns null when the feed is unreachable — the UI then shows nothing.
*/
async function checkHostUpdate() {
	if (cached$1 && Date.now() - cached$1.at < (cached$1.info ? OK_TTL_MS : FAIL_TTL_MS)) return cached$1.info;
	if (inflight$1) return inflight$1;
	inflight$1 = (async () => {
		const current = ownVersion$1();
		let info = null;
		const latest = current === "0.0.0" ? null : await fetchLatestGiteeTag();
		if (latest && current !== "0.0.0") info = {
			current,
			latest,
			updateAvailable: compareVersions(latest, current) > 0,
			checkedAt: Date.now()
		};
		cached$1 = {
			info,
			at: Date.now()
		};
		return info;
	})().finally(() => {
		inflight$1 = null;
	});
	return inflight$1;
}

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
//#region src/server/apk-link.ts
const GITEE_RELEASES_API = "https://gitee.com/api/v5/repos/qianfengbingtang/phone-lens/releases?per_page=10&direction=desc";
const CACHE_TTL_MS = 10 * 60 * 1e3;
const REQUEST_TIMEOUT_MS = 6e3;
let cached = null;
let inflight = null;
/** The asset URL comes from an external API response, so re-validate it before
*  it ever reaches a QR code: https only, and only the expected release host —
*  never localhost/loopback/private addresses or any other origin. */
function isTrustedGiteeAsset(raw) {
	if (typeof raw !== "string" || !raw.startsWith("https://")) return false;
	try {
		const u = new URL(raw);
		return u.protocol === "https:" && u.host === "gitee.com";
	} catch {
		return false;
	}
}
async function fetchLatestGiteeApk() {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
	try {
		const resp = await fetch(GITEE_RELEASES_API, {
			signal: ctrl.signal,
			headers: { accept: "application/json" }
		});
		if (!resp.ok) return null;
		const data = await resp.json();
		if (!Array.isArray(data)) return null;
		const rows = data.filter((row) => typeof row?.tag_name === "string" && !!row.tag_name.trim()).sort((a, b) => compareVersions(b.tag_name.trim(), a.tag_name.trim()));
		const newest = rows[0];
		if (!newest || !Array.isArray(newest.assets)) return null;
		for (const asset of newest.assets) {
			const row = asset;
			if (typeof row.name === "string" && row.name.startsWith("app-release.apk") && isTrustedGiteeAsset(row.browser_download_url)) return row.browser_download_url;
		}
		return null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
/** Resolve the latest APK URL (cached 10 min, in-flight deduped).
*  Resolves null when the API is unreachable or carries no trusted asset. */
function resolveLatestGiteeApk() {
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.url);
	if (inflight) return inflight;
	inflight = fetchLatestGiteeApk().then((url) => {
		if (url) cached = {
			url,
			at: Date.now()
		};
		return url;
	}).finally(() => {
		inflight = null;
	});
	return inflight;
}
/**
* Refresh config.app download links in place, but only while they still carry
* the built-in defaults — an explicit user config always wins. Mutating the
* shared config object lets the QR endpoints keep reading the plain fields.
*/
async function refreshAppApkLinks(config) {
	if (config.app.giteeUrl !== GITEE_APK_DEFAULT) return;
	const url = await resolveLatestGiteeApk();
	if (!url) return;
	config.app.giteeUrl = url;
	if (config.app.downloadUrl === GITEE_APK_DEFAULT) config.app.downloadUrl = url;
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
      <button id="shoot" disabled>◉ 拍照</button>
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
// The newest transient-error log entry (capture declined / no camera / timeout).
// These describe a MOMENTARY condition — the moment the world recovers (stream
// back on, phone back online, photo actually landing) the stale complaint must
// go, instead of sitting in the log forever like a permanent failure.
let lastTransientErr = null;
function clearTransientErr() {
  if (lastTransientErr && lastTransientErr.isConnected) lastTransientErr.remove();
  lastTransientErr = null;
}
const TRANSIENT_ERR_CODES = new Set(['CAPTURE_DECLINED', 'NO_CAMERA', 'CAPTURE_TIMEOUT']);

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
  // truncated/corrupt JPEG: onload never fires and the blob URL leaks —
  // revoke on error too (same fix the main client already has)
  img.onerror = () => URL.revokeObjectURL(url);
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
        if (m.camera.connected) clearTransientErr();
        break;
      case 'frame_meta':
        if (m.rotation !== undefined) streamRotation = m.rotation;
        break;
      case 'paired':
        // pairing consumed the one-time code: rotate the QR now, don't wait
        // for the uplink (this page keys off nothing else to trigger it)
        log('设备已配对' + (m.name ? ': ' + m.name : '') + ',二维码已更换', 'ok');
        void refreshQr();
        break;
      case 'capture_pending':
        pendingShot = m.captureId;
        log('快门已触发' + (m.note ? '(' + m.note + ')' : '') + '…');
        break;
      // modern-protocol branches (this page previously only knew the retired
      // messages, so photos succeeded silently and preview-off was invisible)
      case 'pending_image':
        if (pendingShot) { pendingShot = null; log('照片已入库,已放入输入框' + (m.name ? ': ' + m.name : ''), 'ok'); }
        else log('照片已入库,已放入输入框' + (m.name ? ': ' + m.name : ''), 'ok');
        clearTransientErr();
        break;
      case 'upload_saved':
        if (pendingShot) pendingShot = null;
        log('已保存至 ' + (m.dir || '指定文件夹') + (m.name ? ' · ' + m.name : ''), 'ok');
        clearTransientErr();
        break;
      case 'preview_state':
        if (!m.on && m.reason === 'offline') { $('dev').textContent = '连接已断开'; $('hint').textContent = '等待手机连接…'; $('hint').style.display = ''; }
        else if (!m.on) { $('dev').textContent = '预览已关闭'; $('hint').textContent = '手机端已停止预览'; $('hint').style.display = ''; }
        else if (m.on) clearTransientErr();
        break;
      case 'devices': {
        const active = (m.devices || []).find((d) => d.active);
        $('dot').className = active ? 'on' : '';
        $('dev').textContent = active ? (active.name || '已连接') : '未连接';
        $('shoot').disabled = !active;
        $('hint').style.display = active ? 'none' : '';
        $('hint').textContent = '等待手机连接…';
        if (active) clearTransientErr();
        break;
      }
      case 'error': {
        // hub broadcasts carry a human-readable Chinese message now — show it
        // alone; the wire code is only a fallback for unknown/legacy types
        log(m.message || ('错误 ' + m.code), 'err');
        if (TRANSIENT_ERR_CODES.has(m.code)) lastTransientErr = logEl.firstElementChild;
        break;
      }
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
    // stop the PREVIOUS stream's tracks before replacing srcObject — each
    // unchecked re-request used to leak one live MediaStream per click
    const old = v.srcObject;
    if (old instanceof MediaStream) old.getTracks().forEach((t) => t.stop());
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
		if (list.length === 0) this.hits.delete(key);
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

* DNS-rebinding shield: a hostile page's domain re-binds to 127.0.0.1, so the

* connection LOOKS loopback and sails past isLoopback — but its Host header

* still carries the attacker's DOMAIN, never an address this server is dialed

* by. Every legitimate client (phone App, dsh web UI, desktop shell) connects

* to an address paired/typed as an IP literal or localhost, so anything else

* is refused. HTTP/1.0-style requests without a Host header fail the same way.

*/
function isAllowedHost(req) {
	const host = req.headers.host;
	if (typeof host !== "string" || host === "") return false;
	const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
	return hostname.toLowerCase() === "localhost" || isIP(hostname) !== 0;
}
/**

* CORS for the dsh Web UI page (served on another loopback port, or the

* desktop shell's `dsh-app://` origin) so it can fetch /qr.json and /status

* from this receiver. Only same-machine origins are echoed — a foreign page

* must not read the pairing code, and its cross-origin JSON POST fails the

* preflight we never answer. `dsh-app:` is a privileged scheme registered by

* the desktop shell; only the shell's own renderer can ever present it.

*/
function corsFor(req) {
	const origin = req.headers.origin;
	if (typeof origin !== "string" || origin === "") return {};
	try {
		const u = new URL(origin);
		const host = u.hostname.replace(/^\[|\]$/g, "");
		if (u.protocol === "http:" && LOOPBACK.has(host) || u.protocol === "dsh-app:") return {
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
/** Process-lifetime marker: surfaces service rebuilds via /status. */
const SERVER_BOOT_AT = Date.now();
/** Boot the receiver: HTTP routes + two websocket endpoints. */
let ownVersion = null;
function hostVersion() {
	if (ownVersion) return ownVersion;
	try {
		ownVersion = String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0");
	} catch {
		ownVersion = "0.0.0";
	}
	return ownVersion;
}
async function startLensServer(deps) {
	const { config, pairing, devices, hub, targets, log } = deps;
	const pairLimiter = new RateLimiter(6e4, 10);
	const uploadReplays = new Map();
	const server = createServer((req, res) => {
		handle(deps, req, res, {
			pairLimiter,
			uploadReplays
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
	const workWss = new WebSocketServer({
		noServer: true,
		maxPayload: 16 * 1024 * 1024
	});
	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://phone-lens.local");
		const done = (status, message) => {
			socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
			socket.destroy();
		};
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
			wss.handleUpgrade(req, socket, head, (ws) => hub.attachView(ws, {
				onRefreshPairing: () => pairing.refresh(),
				onRenameDevice: (deviceId, name) => {
					const updated = devices.rename(deviceId, name);
					if (updated) hub.renameDevice(deviceId, updated.name);
				}
			}));
			return;
		}
		if (url.pathname === "/ws/work") {
			const q = url.searchParams;
			const deviceId = q.get("deviceId") ?? "";
			const token = q.get("token") ?? "";
			const record = devices.authenticate(deviceId, token);
			if (!record && !isLoopback(req)) return done(401, "Unauthorized");
			workWss.handleUpgrade(req, socket, head, (ws) => {
				deps.workBridge.attachClient(ws, record ? {
					deviceId: record.deviceId,
					name: record.name
				} : void 0);
			});
			return;
		}
		done(404, "Not Found");
	});
	const heartbeat = setInterval(() => {
		hub.pingAll();
		deps.workBridge.pingAll();
	}, 2e4);
	const preferredPort = config.server.port;
	const candidates = [preferredPort, ...[
		8792,
		8793,
		8794,
		8795,
		8796,
		8797,
		8798,
		8799,
		8800
	].filter((p) => p !== preferredPort)];
	let boundPort = null;
	try {
		for (const port of candidates) {
			const ok = await new Promise((resolve$1, reject) => {
				const onError = reject;
				server.once("error", onError);
				server.listen(port, config.server.host, () => {
					server.removeListener("error", onError);
					server.on("error", (e) => log("warn", `http server error: ${String(e)}`));
					resolve$1(true);
				});
			}).catch((error) => {
				if (error?.code === "EADDRINUSE") return false;
				throw error;
			});
			if (ok) {
				boundPort = port;
				break;
			}
		}
	} catch (error) {
		clearInterval(heartbeat);
		for (const client of wss.clients) client.terminate();
		await new Promise((resolve$1) => wss.close(() => resolve$1()));
		for (const client of workWss.clients) client.terminate();
		await new Promise((resolve$1) => workWss.close(() => resolve$1()));
		throw error;
	}
	if (boundPort === null) throw new Error(`无可用端口: ${preferredPort} 及 8792~8800 均被占用`);
	if (boundPort !== preferredPort) {
		config.server.port = boundPort;
		log("warn", `port ${preferredPort} busy, fell back to ${boundPort}`);
	}
	log("info", `phone-lens listening on ${config.server.host}:${config.server.port} (paired devices: ${devices.count()})`);
	pruneUploads(deps.fallbackDir, config.limits.maxStoredUploads).catch((error) => log("warn", `upload pruning failed: ${String(error)}`));
	prunePending(deps.pendingDir, PENDING_TTL_MS).catch(() => {});
	resolveLatestGiteeApk().then((url) => {
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
			await new Promise((resolve$1) => server.close(() => resolve$1()));
		}
	};
}
/** Composer-staged photos older than this get swept (best effort). */
const PENDING_TTL_MS = 24 * 60 * 6e4;
/**

* Cache an idempotent 200 receipt for a phone retry. The 400 cap must be a

* HARD cap: within the 10min TTL a retry storm can keep the map full of

* fresh entries, so once expired ones are gone we still evict oldest-first

* (Map iteration order = insertion order).

*/
function rememberReplay(ctx, uploadId, body) {
	if (!uploadId) return;
	if (ctx.uploadReplays.size > 400) {
		for (const [k, v] of ctx.uploadReplays) if (v.expires <= Date.now()) ctx.uploadReplays.delete(k);
		while (ctx.uploadReplays.size >= 400) {
			const oldest = ctx.uploadReplays.keys().next().value;
			if (oldest === void 0) break;
			ctx.uploadReplays.delete(oldest);
		}
	}
	ctx.uploadReplays.set(uploadId, {
		expires: Date.now() + 10 * 6e4,
		body
	});
}
/** Best-effort TTL sweep for composer-staged photos (see the staging site). */
async function prunePending(dir, ttlMs) {
	const cutoff = Date.now() - ttlMs;
	for (const entry of await readdir(dir).catch(() => [])) {
		const p = join(dir, entry);
		const st = await stat(p).catch(() => null);
		if (st?.isFile() && st.mtimeMs < cutoff) await rm(p, { force: true }).catch(() => {});
	}
}
async function handle(deps, req, res, ctx) {
	const { config, pairing, devices, hub, targets, log } = deps;
	const url = new URL(req.url ?? "/", "http://phone-lens.local");
	const path = url.pathname.replace(/\/+$/, "") || "/";
	const method = req.method ?? "GET";
	const allowedHost = isAllowedHost(req);
	const loop = allowedHost && isLoopback(req);
	const cors = corsFor(req);
	if (!allowedHost) return sendError(res, 403, ERROR_CODES.BAD_HOST, "unrecognized Host header");
	if (method === "OPTIONS") {
		res.writeHead(204, cors);
		res.end();
		return;
	}
	if (method === "GET" && path === "/info") return sendJson(res, 200, {
		name: "PhoneLens 直连取景",
		version: hostVersion(),
		requiresPairing: true,
		serverPort: config.server.port
	}, cors);
	if (method === "GET" && path === "/update-check") {
		if (!loop) return sendError(res, 403, ERROR_CODES.LOOPBACK_ONLY, "update check is loopback-only");
		return sendJson(res, 200, await checkHostUpdate(), cors);
	}
	if (!loop && (path === "/" || path === "/view.html" || path === "/qr.json" || path === "/qr.png" || path === "/app-qr.json" || path === "/app-settings")) return sendError(res, 403, ERROR_CODES.LOOPBACK_ONLY, "preview surface is loopback-only");
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
		await refreshAppApkLinks(config);
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
		hub.broadcastToViews({
			type: "paired",
			name
		});
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
		const mediaType = (req.headers["content-type"] ?? "").split(";")[0].trim();
		if (!config.limits.allowedTypes.includes(mediaType)) return sendError(res, 415, ERROR_CODES.TYPE_NOT_ALLOWED, `allowed: ${config.limits.allowedTypes.join(", ")}`);
		const declared = Number(req.headers["content-length"] ?? "0");
		if (declared > config.limits.maxUploadBytes) return sendError(res, 413, ERROR_CODES.TOO_LARGE, `> ${config.limits.maxUploadBytes} bytes`);
		const { buf, truncated } = await readRawBody(req, config.limits.maxUploadBytes);
		if (truncated) return sendError(res, 413, ERROR_CODES.TOO_LARGE, `> ${config.limits.maxUploadBytes} bytes`);
		if (!magicMatches(mediaType, buf)) return sendError(res, 415, ERROR_CODES.BAD_MAGIC, "bytes do not match the declared type");
		const captureId = q.get("captureId");
		const pending = captureId ? hub.peekCapture(captureId) : null;
		const abandoned = captureId ? hub.isAbandonedDirect(captureId) : false;
		const note = q.get("note") ?? pending?.note;
		const rawName = (q.get("name") ?? `shot_${new Date().toISOString().replace(/[:.]/g, "-")}.${mediaType === "image/png" ? "png" : "jpg"}`).slice(0, 120);
		const name = sanitizeFileName(rawName);
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
		if (pending) hub.consumeCapture(captureId);
		await pruneUploads(deps.fallbackDir, config.limits.maxStoredUploads).catch((error) => log("warn", `upload pruning failed: ${String(error)}`));
		prunePending(deps.pendingDir, PENDING_TTL_MS).catch(() => {});
		if (abandoned) {
			log("warn", `dropping late direct-capture photo: ${name} (${admitted.ref.attachmentId})`);
			const droppedBody = {
				ok: true,
				attachmentId: admitted.ref.attachmentId,
				width: admitted.ref.width,
				height: admitted.ref.height,
				bytes: admitted.ref.bytes,
				storage: admitted.storage,
				deliverReason: "dropped-late-direct"
			};
			rememberReplay(ctx, uploadId, droppedBody);
			return sendJson(res, 200, droppedBody);
		}
		if (pending?.direct && pending.onImage) {
			pending.onImage(admitted);
			log("info", `direct-to-model photo: ${name} (${admitted.ref.attachmentId})`);
			const directBody = {
				ok: true,
				attachmentId: admitted.ref.attachmentId,
				width: admitted.ref.width,
				height: admitted.ref.height,
				bytes: admitted.ref.bytes,
				storage: admitted.storage,
				deliverReason: "delivered-to-model"
			};
			rememberReplay(ctx, uploadId, directBody);
			return sendJson(res, 200, directBody);
		}
		const st = deps.appSettings.get();
		const wantFolder = st.saveMode !== "composer";
		const wantComposer = st.saveMode !== "folder";
		let savedDir = null;
		if (wantFolder) {
			const dir = deps.appSettings.effectiveSaveDir();
			try {
				mkdirSync(dir, { recursive: true });
				let fileName = nextAvailableName(dir, name);
				for (let attempt = 0;; attempt++) {
					const target = resolveUnder(dir, fileName);
					if (!target) throw new Error("resolved path escapes the save directory");
					try {
						const fd = openSync(target, "wx");
						try {
							writeSync(fd, buf);
						} finally {
							closeSync(fd);
						}
						break;
					} catch (e) {
						if (attempt >= 4 || e?.code !== "EEXIST") throw e;
						fileName = nextAvailableName(dir, fileName);
					}
				}
				savedDir = dir;
				log("info", `folder-mode saved: ${join(dir, fileName)}`);
			} catch (error) {
				log("warn", `folder save failed (${String(error)}) — falling back to composer staging`);
			}
		}
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
			hub.broadcastToViews({
				type: "pending_image",
				attachmentId: admitted.ref.attachmentId,
				name
			});
		} else hub.broadcastToViews({
			type: "upload_saved",
			name,
			dir: savedDir
		});
		{
			const replayBody = {
				ok: true,
				attachmentId: admitted.ref.attachmentId,
				width: admitted.ref.width,
				height: admitted.ref.height,
				bytes: admitted.ref.bytes,
				storage: admitted.storage,
				deliverReason: savedDir ? wantComposer ? "saved-and-staged" : "saved-to-folder" : "staged-in-composer"
			};
			rememberReplay(ctx, uploadId, replayBody);
			return sendJson(res, 200, replayBody);
		}
	}
	if (method === "GET" && path.startsWith("/pending/") && loop) {
		const id = path.slice(9).split("/")[0] ?? "";
		const file = resolveUnder(deps.pendingDir, pendingFileName(id));
		if (!file) return sendError(res, 404, ERROR_CODES.BAD_REQUEST, "pending image not found");
		try {
			const data = await readFile(file);
			res.writeHead(200, {
				"content-type": imageContentType(data),
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
		const online = hub.onlineDeviceIds();
		return sendJson(res, 200, {
			bootAt: SERVER_BOOT_AT,
			version: hostVersion(),
			devices: devices.list().map((d) => ({
				id: d.deviceId,
				name: d.name,
				model: d.model,
				online: online.has(d.deviceId),
				streaming: online.has(d.deviceId),
				lastSeenAt: d.lastSeenAt
			})),
			camera: hub.stats(),
			preview: config.preview,
			target: {
				mode: targets.mode(),
				sessionId: targets.resolve()?.sessionId ?? null
			}
		}, cors);
	}
	if (method === "GET" && path === "/targets") return sendJson(res, 200, {
		targets: targets.list(),
		default: targets.resolve()?.sessionId ?? null
	}, cors);
	if (method === "GET" && path === "/app-settings") {
		const st = deps.appSettings.get();
		return sendJson(res, 200, {
			saveMode: st.saveMode,
			saveDir: st.saveDir,
			effectiveSaveDir: deps.appSettings.effectiveSaveDir(),
			modelToolsEnabled: st.modelToolsEnabled,
			modelToolsConfirmFree: st.modelToolsConfirmFree,
			workBetaEnabled: st.workBetaEnabled
		}, cors);
	}
	if (method === "GET" && path === "/fs/dirs") {
		if (!loop) return sendError(res, 403, ERROR_CODES.LOOPBACK_ONLY, "folder browsing is loopback-only");
		return sendJson(res, 200, await listDirs(url.searchParams.get("path") ?? ""), cors);
	}
	if (method === "POST" && path === "/app-settings") {
		const body = await readJsonBody(req, 4096);
		if (!body) return sendError(res, 400, ERROR_CODES.BAD_REQUEST, "invalid JSON body");
		const patch = {};
		if (typeof body.saveMode === "string" && SAVE_MODES.includes(body.saveMode)) patch.saveMode = body.saveMode;
		if (typeof body.saveDir === "string") patch.saveDir = body.saveDir;
		if (typeof body.modelToolsEnabled === "boolean") patch.modelToolsEnabled = body.modelToolsEnabled;
		if (typeof body.modelToolsConfirmFree === "boolean") patch.modelToolsConfirmFree = body.modelToolsConfirmFree;
		if (typeof body.workBetaEnabled === "boolean") patch.workBetaEnabled = body.workBetaEnabled;
		const st = deps.appSettings.set(patch);
		if (typeof patch.workBetaEnabled === "boolean") deps.workBridge.setEnabled(patch.workBetaEnabled);
		log("info", `app settings updated: mode=${st.saveMode} dir=${st.saveDir ? JSON.stringify(st.saveDir) : "(default)"} modelTools=${st.modelToolsEnabled}/${st.modelToolsConfirmFree} workBeta=${st.workBetaEnabled}`);
		return sendJson(res, 200, {
			saveMode: st.saveMode,
			saveDir: st.saveDir,
			effectiveSaveDir: deps.appSettings.effectiveSaveDir(),
			modelToolsEnabled: st.modelToolsEnabled,
			modelToolsConfirmFree: st.modelToolsConfirmFree,
			workBetaEnabled: st.workBetaEnabled
		}, cors);
	}
	if (method === "POST" && path === "/devices/remove") {
		if (!loop) return sendError(res, 403, ERROR_CODES.LOOPBACK_ONLY, "device removal is loopback-only");
		const body = await readJsonBody(req, 4096);
		const deviceId = str(body?.deviceId);
		if (!deviceId) return sendError(res, 400, ERROR_CODES.BAD_REQUEST, "deviceId is required");
		const removed = devices.remove(deviceId);
		if (removed) {
			hub.detachCamera(deviceId);
			log("info", `device removed: ${deviceId.slice(0, 8)}`);
		}
		return sendJson(res, 200, { ok: removed }, cors);
	}
	if (method === "POST" && path === "/capture" && loop) {
		const captureId = randomUUID();
		const ok = hub.requestCapture(captureId, queryOf(req).get("note") ?? void 0);
		if (!ok) return sendError(res, 409, ERROR_CODES.NO_CAMERA, "no camera uplink connected");
		return sendJson(res, 202, { captureId });
	}
	return sendError(res, 404, ERROR_CODES.BAD_REQUEST, `no route ${method} ${path}`);
}
/** Cached drive roots (win32: existing C:..Z:, probed once per process). */
let cachedRoots = null;
function listRoots() {
	if (cachedRoots) return cachedRoots;
	const roots = [];
	if (process.platform === "win32") for (let c = 67; c <= 90; c++) {
		const drive = `${String.fromCharCode(c)}:\\`;
		if (existsSync(drive)) roots.push(drive);
	}
	else roots.push("/");
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
async function listDirs(wanted) {
	const home = homedir();
	const target = wanted.trim() === "" ? home : resolve(wanted.trim());
	const parent = dirname(target);
	const base = {
		path: target,
		parent: parent !== target ? parent : null,
		home,
		roots: listRoots()
	};
	let entries;
	try {
		entries = await readdir(target, { withFileTypes: true });
	} catch (error) {
		return {
			...base,
			dirs: [],
			error: `无法读取该文件夹(不存在或无权限): ${String(error.message || error).slice(0, 80)}`
		};
	}
	const dirs = entries.filter((e) => e.isDirectory() && e.name !== "." && e.name !== "..").map((e) => e.name).sort((a, b) => a.localeCompare(b, "zh"));
	return {
		...base,
		dirs
	};
}
/** Strip path separators / reserved characters so a phone-supplied upload

*  name can never escape the target directory or hide as a dotfile. */
function sanitizeFileName(input) {
	const base = basename(input).replace(/[<>:"|?*\u0000-\u001F]/g, "_").replace(/^[\s.]+/, "").trim();
	return base || "shot.jpg";
}
/** Pick `name`, then `name (2).ext`, `name (3).ext`, … — folder saves never overwrite. */
function nextAvailableName(dir, name) {
	if (!existsSync(join(dir, name))) return name;
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	for (let n = 2;; n++) {
		const candidate = `${stem} (${n})${ext}`;
		if (!existsSync(join(dir, candidate))) return candidate;
	}
}
/** Pending-staging filename for an attachment id. Ids may be URN-ish

*  ("file:<digest>" without the dsh attachment service) and Windows forbids

*  ":" in filenames — flatten to a portable name, write and read alike. */
function pendingFileName(attachmentId) {
	return `${attachmentId.replace(/[^A-Za-z0-9._-]/g, "_")}.jpg`;
}
/** Content type for a staged/uploaded image buffer, decided by the bytes:

*  high-quality uploads pass original PNG (or WebP) through untouched, so a

*  `.jpg` filename may lie about the payload. */
function imageContentType(buf) {
	if (buf.length >= 8 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71) return "image/png";
	if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216) return "image/jpeg";
	if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
	if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "GIF8") return "image/gif";
	return "application/octet-stream";
}
/** Resolve `name` under `baseDir` and refuse anything that escapes it

*  (defense in depth on top of sanitizeFileName — e.g. a crafted name that

*  survives sanitization but still resolves outside the base). */
function resolveUnder(baseDir, name) {
	const base = resolve(baseDir);
	const target = resolve(base, name);
	return target === base || target.startsWith(base + sep) ? target : null;
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
	return new Promise((resolve$1, reject) => {
		const chunks = [];
		let size = 0;
		let truncated = false;
		req.on("data", (chunk) => {
			size += chunk.byteLength;
			if (size > maxBytes) {
				truncated = true;
				chunks.length = 0;
				req.destroy();
				resolve$1({
					buf: Buffer.alloc(0),
					truncated
				});
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve$1({
			buf: Buffer.concat(chunks),
			truncated
		}));
		req.on("error", reject);
	});
}
/** Delete the oldest files beyond `max` in a directory (mtime order). A

*  missing directory is a no-op: the production attachments mode never

*  creates uploads/, and warning about it on EVERY /upload just floods

*  boot.log. */
async function pruneUploads(dir, max) {
	if (max <= 0) return;
	const names = await readdir(dir).catch(() => []);
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

* A camera uplink with NO inbound traffic for this long is presumed half-open

* (phone switched wifi / laptop slept mid-link): the OS keeps the socket

* "open" without a FIN, so we evict it ourselves. Generous vs the phone's own

* 30s app-level silence limit so the phone normally tears down first.

*/
const CAM_SILENCE_MS = 6e4;
/** Oldest phone App that understands the camera_zoom control (zoom tools).

* MUST track the release the zoom tools actually ship in — the app version

* itself is 1.1.2 (zoom rides a patch release), not 1.2.0. */
const ZOOM_MIN_APP = "1.1.2";
/** Oldest phone App that understands the camera_lens control (lens tool).

* The lens switch ships in 1.1.3 together with the app_info handshake. */
const LENS_MIN_APP = "1.1.3";
/** Oldest phone App that understands the camera_torch control (torch tool).

* The torch on/off/query ships in 1.1.6. */
const TORCH_MIN_APP = "1.1.6";
/** Oldest phone App that answers camera_idle/resume (the appVersion handshake

* landed together with the camera_state receipt in 1.0.4). */
const CAMSTATE_MIN_APP = "1.0.4";
/** How long a timed-out direct capture stays "abandoned" (late-photo guard). */
const ABANDON_DIRECT_TTL_MS = 5 * 6e4;
/**

* Panel flash is user-facing: map the phone's raw capture_result status/detail

* (see reportCapture on the app side) into plain Chinese instead of leaking

* wire strings like "phone reported declined: throttled".

*/
function captureDeclineText(status, detail) {
	if (status === "declined") {
		if (detail === "throttled") return "手机忙:刚拍过一张,稍候再试";
		if (detail === "busy") return "手机正在处理上一张";
		if (detail === "cancelled") return "拍照已取消";
		return "手机拒绝了本次拍摄";
	}
	if (status === "failed") return "拍摄失败:手机相机不可用";
	return `手机报告拍摄异常(${status ?? "未知"}${detail ? `: ${detail}` : ""})`;
}
/**

* Compare "1.2.0"-style dotted versions. Malformed/missing segments parse as

* 0, so "1.2" >= "1.2.0" and garbage never accidentally passes a floor.

*/
function versionAtLeast(v, need) {
	if (!v) return false;
	const seg = (s) => {
		const m = /^(\d+)/.exec(s.trim());
		return m ? Number(m[1]) : 0;
	};
	const a = v.split(".");
	const b = need.split(".");
	for (let i = 0; i < 3; i++) {
		const x = seg(a[i] ?? "");
		const y = seg(b[i] ?? "");
		if (x !== y) return x > y;
	}
	return true;
}
/**

* How long the ACTIVE device's stream may go silent before the hub starts

* DERIVING its state (see checkPreviewStall). The phone app never announces

* "preview off" — it just stops its frame pump while the WS stays up and the

* app-level keepalive ping (every 10s, independent of the preview state)

* keeps flowing. So the discriminator is INBOUND TRAFFIC: "frames stalled +

* keepalive still arriving" = user turned preview off (confirmed event-side

* in confirmPreviewOff the moment a ping lands during a stall); "frames

* stalled + keepalive dead" = the link itself died.

*/
const PREVIEW_STALL_MS = 3e3;
/**

* No frames AND no inbound traffic at all (no app ping, no ws pong, no

* control) for this long = the link is dead, e.g. the phone left the wifi

* while the OS keeps the TCP socket half-open without a FIN. 25s = 2.5× the

* app's 10s keepalive period, so ONE lost ping (worst-case inbound gap 20s)

* can NEVER trip it — offline is only ever declared on the COMBINATION

* "frames stalled + inbound silent past this floor". Single-condition

* verdicts are forbidden here: 宁可晚判,不可误判. The 60s CAM_SILENCE_MS

* terminate below still owns the actual eviction; this only corrects the

* UI semantics ~35s earlier.

*/
const OFFLINE_SILENCE_MS = 25e3;
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
	/**
	
	* The device the flow last settled on EXPLICITLY: picked in the view,
	
	* claimed from a phone, or simply the first to come online. When that
	
	* device drops and a fallback takes over, detach does NOT clear this — so
	
	* the preferred phone reconnecting (network blip, host reboot, delayed
	
	* wifi join) takes its hot seat back instead of being parked as "another
	
	* device is using the preview". Any explicit switch updates it.
	
	*/
	preferredDeviceId = null;
	views = new Set();
	/** captureId → { note, requestedAt } until the matching upload lands or timeout. */
	pendingCaptures = new Map();
	captureTimeoutMs = 6e4;
	/** reqId → settle callback for in-flight camera_idle/camera_resume requests. */
	cameraStateWaiters = new Map();
	/** reqId → settle callback for in-flight camera_zoom requests (set/step/query). */
	zoomWaiters = new Map();
	/** reqId → settle callback for in-flight camera_lens requests (switch/query). */
	lensWaiters = new Map();
	/** reqId → settle callback for in-flight camera_torch requests (on/off/query). */
	torchWaiters = new Map();
	/**
	
	* Derived stream state of the ACTIVE device, read off the traffic mix:
	
	*   "on"      — frames flowing
	
	*   "off"     — frames stalled but the app keepalive ping still arrives
	
	*               (hard evidence the link is alive) → user turned preview
	
	*               off on the phone
	
	*   "offline" — frames stalled AND no inbound at all past
	
	*               OFFLINE_SILENCE_MS → the link itself died (wifi drop,
	
	*               half-open TCP), which is NOT "preview closed"
	
	*/
	previewState = "off";
	stallTimer = null;
	constructor(config, log) {
		this.config = config;
		this.log = log;
		this.stallTimer = setInterval(() => this.checkPreviewStall(), 1e3);
	}
	/** Stop the stall watchdog (server dispose). */
	dispose() {
		if (this.stallTimer) clearInterval(this.stallTimer);
		this.stallTimer = null;
		for (const [id, waiter] of this.cameraStateWaiters) {
			waiter.settle({
				ok: false,
				reason: "接收端服务已停止"
			});
			this.cameraStateWaiters.delete(id);
		}
		for (const [id, waiter] of this.zoomWaiters) {
			waiter.settle({
				ok: false,
				reason: "接收端服务已停止"
			});
			this.zoomWaiters.delete(id);
		}
		for (const [id, waiter] of this.lensWaiters) {
			waiter.settle({
				ok: false,
				reason: "接收端服务已停止"
			});
			this.lensWaiters.delete(id);
		}
		for (const [id, waiter] of this.torchWaiters) {
			waiter.settle({
				ok: false,
				reason: "接收端服务已停止"
			});
			this.torchWaiters.delete(id);
		}
		for (const [id, p] of this.pendingCaptures) {
			p.onFail?.("接收端服务已停止");
			this.pendingCaptures.delete(id);
		}
		this.abandonedDirect.clear();
	}
	attachCamera(deviceId, ws, name) {
		const prev = this.cameras.get(deviceId);
		if (prev) {
			this.log("warn", `camera re-attach: kicking previous ws for ${deviceId.slice(0, 8)}`);
			try {
				prev.ws.close(1e3, "new-instance");
			} catch {}
			this.cameras.delete(deviceId);
		}
		const cam = {
			ws,
			name,
			meta: {},
			helloSeen: false,
			lastFrame: null,
			lastFrameAt: 0,
			lastSeenAt: Date.now(),
			frameCount: 0,
			windowStart: Date.now(),
			measuredFps: 0
		};
		this.cameras.set(deviceId, cam);
		if (this.activeDeviceId === null) {
			this.activeDeviceId = deviceId;
			this.preferredDeviceId = deviceId;
		} else if (this.preferredDeviceId === deviceId && this.activeDeviceId !== deviceId) this.selectDevice(deviceId);
		if (this.activeDeviceId === deviceId) this.sendControl(deviceId, { type: "resume_preview" });
		else this.sendControl(deviceId, { type: "pause_preview" });
		this.log("info", `camera uplink: ${name} (${deviceId.slice(0, 8)})`);
		ws.on("close", (code, reason) => {
			this.log("warn", `camera ws closed: code=${code} reason=${reason.toString("utf8") || "-"} (${name} ${deviceId.slice(0, 8)})`);
			if (this.cameras.get(deviceId)?.ws === ws) this.detachCamera(deviceId);
		});
		ws.on("error", (err) => {
			this.log("warn", `camera ws error: ${String(err)} (${name} ${deviceId.slice(0, 8)})`);
		});
		ws.on("pong", () => {
			const c = this.cameras.get(deviceId);
			if (c?.ws !== ws) return;
			c.lastSeenAt = Date.now();
		});
		ws.on("message", (data, isBinary) => {
			const c = this.cameras.get(deviceId);
			if (c?.ws !== ws) return;
			c.lastSeenAt = Date.now();
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
		this.log("warn", `detachCamera(${deviceId.slice(0, 8)}) had-camera=${!!cam}`);
		if (cam) this.cameras.delete(deviceId);
		for (const [id, waiter] of this.cameraStateWaiters) if (waiter.deviceId === deviceId) {
			waiter.settle({
				ok: false,
				reason: "手机已断开连接"
			});
			this.cameraStateWaiters.delete(id);
		}
		for (const [id, waiter] of this.zoomWaiters) if (waiter.deviceId === deviceId) {
			waiter.settle({
				ok: false,
				reason: "手机已断开连接"
			});
			this.zoomWaiters.delete(id);
		}
		for (const [id, waiter] of this.lensWaiters) if (waiter.deviceId === deviceId) {
			waiter.settle({
				ok: false,
				reason: "手机已断开连接"
			});
			this.lensWaiters.delete(id);
		}
		for (const [id, waiter] of this.torchWaiters) if (waiter.deviceId === deviceId) {
			waiter.settle({
				ok: false,
				reason: "手机已断开连接"
			});
			this.torchWaiters.delete(id);
		}
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
		const now = Date.now();
		for (const [deviceId, cam] of this.cameras) {
			if (cam.ws.readyState !== cam.ws.OPEN) continue;
			if (now - cam.lastSeenAt > CAM_SILENCE_MS) {
				this.log("warn", `camera uplink silent >${CAM_SILENCE_MS}ms — terminating ${deviceId.slice(0, 8)}`);
				cam.ws.terminate();
				continue;
			}
			cam.ws.ping();
		}
	}
	/** Device ids with a live camera uplink right now (for /status truth). */
	onlineDeviceIds() {
		const ids = new Set();
		for (const [deviceId, cam] of this.cameras) if (cam.ws.readyState === cam.ws.OPEN) ids.add(deviceId);
		return ids;
	}
	onCameraControl(deviceId, msg) {
		if (!msg) return;
		const cam = this.cameras.get(deviceId);
		if (!cam) return;
		switch (msg.type) {
			case "hello":
				cam.helloSeen = true;
				cam.meta = {
					width: msg.width,
					height: msg.height,
					fps: msg.fps,
					...msg.rotation !== void 0 ? { rotation: msg.rotation } : {},
					...msg.appVersion !== void 0 ? { appVersion: msg.appVersion } : {}
				};
				if (this.activeDeviceId === deviceId) {
					this.markPreviewActive();
					this.broadcastToViews({
						type: "frame_meta",
						width: msg.width,
						height: msg.height,
						...msg.rotation !== void 0 ? { rotation: msg.rotation } : {}
					});
				}
				break;
			case "app_info":
				if (msg.appVersion !== void 0) {
					cam.helloSeen = true;
					cam.meta = {
						...cam.meta,
						appVersion: msg.appVersion
					};
				}
				break;
			case "bye":
				this.log("warn", `camera sent bye: ${deviceId.slice(0, 8)}`);
				this.detachCamera(deviceId);
				break;
			case "claim_active":
				this.selectDevice(deviceId);
				break;
			case "ping":
				this.sendControl(deviceId, { type: "pong" });
				this.confirmPreviewOff(deviceId);
				break;
			case "capture_result":
				if (msg.status !== "taken") {
					const failed = this.pendingCaptures.get(msg.captureId);
					failed?.onFail?.(`手机拒绝了拍摄(${msg.status}${msg.detail ? `: ${msg.detail}` : ""})`);
					this.pendingCaptures.delete(msg.captureId);
					if (!failed?.direct) this.broadcastToViews({
						type: "error",
						code: "CAPTURE_DECLINED",
						message: captureDeclineText(msg.status, msg.detail)
					});
				}
				break;
			case "camera_state": {
				if (msg.reqId) {
					const waiter = this.cameraStateWaiters.get(msg.reqId);
					if (waiter) {
						this.cameraStateWaiters.delete(msg.reqId);
						waiter.settle(msg.state === "idle" || msg.state === "live" ? {
							ok: true,
							state: msg.state
						} : {
							ok: false,
							reason: "手机报告执行失败(相机不可用或权限被拒)"
						});
					}
				}
				break;
			}
			case "zoom_result": {
				if (msg.reqId) {
					const waiter = this.zoomWaiters.get(msg.reqId);
					if (waiter) {
						this.zoomWaiters.delete(msg.reqId);
						waiter.settle(msg.ok && typeof msg.factor === "number" && Number.isFinite(msg.factor) ? {
							ok: true,
							factor: msg.factor,
							...typeof msg.min === "number" ? { min: msg.min } : {},
							...typeof msg.max === "number" ? { max: msg.max } : {}
						} : {
							ok: false,
							reason: msg.reason ?? "手机报告变焦执行失败"
						});
					}
				}
				break;
			}
			case "lens_result": {
				if (msg.reqId) {
					const waiter = this.lensWaiters.get(msg.reqId);
					if (waiter) {
						this.lensWaiters.delete(msg.reqId);
						waiter.settle(msg.ok && (msg.lens === "front" || msg.lens === "back") ? {
							ok: true,
							lens: msg.lens,
							...Array.isArray(msg.available) ? { available: msg.available } : {}
						} : {
							ok: false,
							reason: msg.reason ?? "手机报告镜头切换失败"
						});
					}
				}
				break;
			}
			case "torch_result": {
				if (msg.reqId) {
					const waiter = this.torchWaiters.get(msg.reqId);
					if (waiter) {
						this.torchWaiters.delete(msg.reqId);
						waiter.settle(msg.ok && typeof msg.on === "boolean" ? {
							ok: true,
							on: msg.on
						} : {
							ok: false,
							reason: msg.reason ?? "手机报告手电筒操作失败"
						});
					}
				}
				break;
			}
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
			this.markPreviewActive();
			for (const view of this.views) if (view.readyState === view.OPEN) view.send(frame, { binary: true });
		}
	}
	/** Flip the view-side preview state to on (once) when stream activity returns. */
	markPreviewActive() {
		this.setPreviewState("on");
	}
	/**
	
	* The phone's app-level keepalive ping just arrived (10s cadence, runs
	
	* regardless of the preview state). If the ACTIVE stream has been stalled
	
	* past PREVIEW_STALL_MS, that ping is hard evidence the LINK is alive and
	
	* only the frame pump stopped → "user turned preview off on the phone",
	
	* NOT a disconnect. It also de-escalates a premature "offline" verdict
	
	* back to "off" once inbound traffic returns (the consecutive-lost-pings
	
	* edge case). Only the app-level ping qualifies as the discriminator:
	
	* ws-pongs fire from the OS network stack even when the app is wedged, and
	
	* hello announces a stream STARTING, so neither may drive this verdict.
	
	*/
	confirmPreviewOff(deviceId) {
		if (deviceId !== this.activeDeviceId) return;
		const cam = this.cameras.get(deviceId);
		if (!cam || Date.now() - cam.lastFrameAt <= PREVIEW_STALL_MS) return;
		this.setPreviewState("off");
	}
	/** Single choke point for preview-state transitions + view notification. */
	setPreviewState(next) {
		if (this.previewState === next) return;
		this.previewState = next;
		this.broadcastToViews({
			type: "preview_state",
			on: next === "on",
			...next === "offline" ? { reason: "offline" } : {}
		});
		this.log(next === "offline" ? "warn" : "info", `active preview state → ${next}`);
	}
	/**
	
	* Watchdog tick (1s): derives the ACTIVE device's stream state from the
	
	* traffic mix. The phone never announces "preview off" — the host reads it
	
	* off the wire:
	
	*
	
	*   frames flowing                             → "on"  (set in ingestFrame)
	
	*   frames stalled + app ping still arriving   → "off" (flipped the moment
	
	*                                               a ping lands during a stall,
	
	*                                               in confirmPreviewOff)
	
	*   frames stalled + NO inbound at all past
	
	*   OFFLINE_SILENCE_MS (2.5 keepalive periods) → "offline" (half-open link:
	
	*                                               wifi drop — NOT "preview
	
	*                                               closed"; this is the bug
	
	*                                               where a dead wifi used to
	
	*                                               render as "preview off")
	
	*
	
	* Between 3s and 25s of stall the hub deliberately says NOTHING (the view
	
	* keeps the last frame): a wifi drop and a preview-off look identical for
	
	* the first seconds, and guessing early is exactly the misjudgment this
	
	* watchdog must not make. 宁可晚判,不可误判. The 60s CAM_SILENCE_MS
	
	* terminate in pingAll still owns the actual eviction; this only fixes
	
	* the UI semantics ~35s earlier.
	
	*/
	checkPreviewStall() {
		this.gcCaptures();
		this.gcAbandonedDirect();
		const active = this.activeCam();
		if (!active || active.ws.readyState !== active.ws.OPEN) return;
		const now = Date.now();
		if (now - active.lastFrameAt <= PREVIEW_STALL_MS) return;
		if (now - active.lastSeenAt < OFFLINE_SILENCE_MS) return;
		this.setPreviewState("offline");
	}
	attachView(ws, hooks = {}) {
		this.views.add(ws);
		ws.on("close", (code, reason) => {
			this.log("warn", `view ws closed: code=${code} reason=${reason.toString("utf8") || "-"} (views left: ${this.views.size - 1})`);
			this.views.delete(ws);
		});
		ws.on("error", (err) => {
			this.log("warn", `view ws error: ${String(err)}`);
		});
		ws.on("message", (data, isBinary) => {
			if (isBinary) return;
			const msg = parseViewClient(data.toString());
			if (!msg) return;
			if (msg.type === "capture") {
				const captureId = randomUUID();
				if (!this.requestCapture(captureId, msg.note)) this.broadcastToViews({
					type: "error",
					code: "NO_CAMERA",
					message: "手机未连接,暂无可用相机"
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
		ws.send(JSON.stringify({
			type: "preview_state",
			on: this.previewState === "on",
			...this.previewState === "offline" ? { reason: "offline" } : {}
		}));
		if (this.previewState === "on" && active?.lastFrame && ws.readyState === ws.OPEN) ws.send(active.lastFrame, { binary: true });
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
		this.preferredDeviceId = deviceId;
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
		if (this.previewState === "on" && active?.lastFrame) {
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
					active: id === this.activeDeviceId,
					...c.meta.appVersion !== void 0 ? { appVersion: c.meta.appVersion } : {}
				};
			})
		}));
	}
	/** Ask the ACTIVE phone to shoot. Returns the captureId, or null when none. */
	requestCapture(captureId, note, opts = {}) {
		const active = this.activeCam();
		if (!active || active.ws.readyState !== active.ws.OPEN) return null;
		this.pendingCaptures.set(captureId, {
			note,
			requestedAt: Date.now(),
			direct: opts.direct,
			onImage: opts.onImage,
			onFail: opts.onFail
		});
		active.ws.send(JSON.stringify({
			type: "capture",
			captureId,
			...note ? { note } : {},
			...opts.direct ? { direct: true } : {}
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
		return pending;
	}
	/** Read a pending capture WITHOUT consuming it (admit-first flow: the
	
	* record must survive an admitImage failure so the phone's retry can still
	
	* route the photo to the waiting model tool). */
	peekCapture(captureId) {
		return this.pendingCaptures.get(captureId) ?? null;
	}
	gcCaptures() {
		const cutoff = Date.now() - this.captureTimeoutMs;
		for (const [id, p] of this.pendingCaptures) if (p.requestedAt < cutoff) {
			p.onFail?.("拍摄请求已超时");
			this.pendingCaptures.delete(id);
			if (!p.direct) this.broadcastToViews({
				type: "error",
				code: "CAPTURE_TIMEOUT",
				message: "拍摄请求已超时(手机未上传)"
			});
		}
	}
	/** captureId → abandon time: direct captures that timed out but whose photo
	
	* may STILL arrive. The upload handler drops those instead of injecting a
	
	* surprise photo into the user's composer/folder after the tool already
	
	* reported failure. */
	abandonedDirect = new Map();
	gcAbandonedDirect() {
		const cutoff = Date.now() - ABANDON_DIRECT_TTL_MS;
		for (const [id, at] of this.abandonedDirect) if (at < cutoff) this.abandonedDirect.delete(id);
	}
	/** True when this captureId belongs to a model-direct capture that already
	
	* timed out (its late photo must not fall into the capture mode). */
	isAbandonedDirect(captureId) {
		return this.abandonedDirect.has(captureId);
	}
	/**
	
	* Model tool: ask the ACTIVE phone to shoot and settle with the uploaded
	
	* photo. The photo bypasses the user-selected capture mode entirely — the
	
	* /upload handler calls onImage instead of routing to composer/folder.
	
	*/
	requestCaptureDirect(note, timeoutMs) {
		return new Promise((resolve$1) => {
			const active = this.activeCam();
			if (!active || active.ws.readyState !== active.ws.OPEN) {
				resolve$1({
					ok: false,
					reason: "没有已连接的手机"
				});
				return;
			}
			const captureId = randomUUID();
			let settled = false;
			const timer = setTimeout(() => {
				this.abandonedDirect.set(captureId, Date.now());
				finish({
					ok: false,
					reason: `拍照超时(手机未在 ${Math.round(timeoutMs / 1e3)} 秒内上传照片)`
				});
			}, timeoutMs);
			const finish = (r) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.pendingCaptures.delete(captureId);
				resolve$1(r);
			};
			this.requestCapture(captureId, note, {
				direct: true,
				onImage: (admitted) => finish({
					ok: true,
					admitted
				}),
				onFail: (reason) => finish({
					ok: false,
					reason
				})
			});
			if (!this.pendingCaptures.has(captureId)) {
				clearTimeout(timer);
				resolve$1({
					ok: false,
					reason: "没有已连接的手机"
				});
			}
		});
	}
	/**
	
	* Wait (≤ cap) for the ACTIVE phone's first identity message. A reconnected
	
	* phone starts with meta={} and appVersion rides the hello/app_info; judging
	
	* a version gate inside that window misreported "app too old" for perfectly
	
	* current builds (the exact bug this fixes). Callers re-read the active
	
	* camera AFTER this resolves — the active device may have switched mid-wait.
	
	*/
	async awaitHandshake(capMs = 1e3) {
		const deadline = Date.now() + capMs;
		for (;;) {
			const active = this.activeCam();
			if (!active || active.ws.readyState !== active.ws.OPEN) return;
			if (active.helloSeen) return;
			if (Date.now() >= deadline) return;
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	/**
	
	* Model tool: park the active phone's camera into the idle state, or wake
	
	* it back up. Settles with the phone's camera_state receipt (or a timeout).
	
	* Old App builds (no appVersion in hello) never answer camera_idle/resume —
	
	* fail fast with an actionable reason instead of burning the 8s timeout.
	
	*/
	async requestCameraState(action, timeoutMs) {
		await this.awaitHandshake();
		return new Promise((resolve$1) => {
			const active = this.activeCam();
			if (!active || active.ws.readyState !== active.ws.OPEN || this.activeDeviceId === null) {
				resolve$1({
					ok: false,
					reason: "没有已连接的手机"
				});
				return;
			}
			if (!active.helloSeen) {
				resolve$1({
					ok: false,
					reason: "手机刚重连,连接握手尚未完成,请稍候重试(或在手机端打开预览)"
				});
				return;
			}
			if (active.meta.appVersion === void 0) {
				resolve$1({
					ok: false,
					reason: `手机 App 版本过旧(需 ≥ ${CAMSTATE_MIN_APP}),请先更新手机端`
				});
				return;
			}
			const reqId = randomUUID();
			const deviceId = this.activeDeviceId;
			let settled = false;
			const timer = setTimeout(() => finish({
				ok: false,
				reason: "手机未在时限内回执(可能不在前台或已断连)"
			}), timeoutMs);
			const finish = (r) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.cameraStateWaiters.delete(reqId);
				resolve$1(r);
			};
			this.cameraStateWaiters.set(reqId, {
				deviceId,
				settle: finish
			});
			this.sendControl(deviceId, {
				type: action,
				reqId
			});
		});
	}
	/**
	
	* Model tool: set / step / query the ACTIVE phone's zoom ratio. Settles with
	
	* the phone's zoom_result receipt (or a timeout). App builds before 1.1.2
	
	* have no camera_zoom branch at all — they would silently swallow the
	
	* command and burn the whole timeout, so fail fast with an upgrade hint
	
	* instead (undefined appVersion after a SEEN hello = pre-1.0.4 build; an
	
	* UNSEEN handshake is a reconnect gap and must not read as "too old").
	
	*/
	async requestZoom(params, timeoutMs) {
		await this.awaitHandshake();
		return new Promise((resolve$1) => {
			const active = this.activeCam();
			if (!active || active.ws.readyState !== active.ws.OPEN || this.activeDeviceId === null) {
				resolve$1({
					ok: false,
					reason: "没有已连接的手机"
				});
				return;
			}
			if (!active.helloSeen) {
				resolve$1({
					ok: false,
					reason: "手机刚重连,连接握手尚未完成,请稍候重试(或在手机端打开预览)"
				});
				return;
			}
			if (active.meta.appVersion === void 0 || !versionAtLeast(active.meta.appVersion, ZOOM_MIN_APP)) {
				resolve$1({
					ok: false,
					reason: `手机 App 版本过旧(变焦需 ≥ ${ZOOM_MIN_APP}),请先更新手机端`
				});
				return;
			}
			const reqId = randomUUID();
			const deviceId = this.activeDeviceId;
			let settled = false;
			const timer = setTimeout(() => finish({
				ok: false,
				reason: "手机未在时限内回执(可能不在前台或已断连)"
			}), timeoutMs);
			const finish = (r) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.zoomWaiters.delete(reqId);
				resolve$1(r);
			};
			this.zoomWaiters.set(reqId, {
				deviceId,
				settle: finish
			});
			this.sendControl(deviceId, {
				type: "camera_zoom",
				...params.factor !== void 0 ? { factor: params.factor } : {},
				...params.step !== void 0 ? { step: params.step } : {},
				reqId
			});
		});
	}
	/**
	
	* Model tool: switch the ACTIVE phone's front/back lens (lens given) or
	
	* query which lens is live (no lens). Settles with the phone's lens_result
	
	* receipt (or a timeout). App builds before 1.1.3 have no camera_lens
	
	* branch — same failure modes as zoom: handshake gap ≠ old build.
	
	*/
	async requestLens(params, timeoutMs) {
		await this.awaitHandshake();
		return new Promise((resolve$1) => {
			const active = this.activeCam();
			if (!active || active.ws.readyState !== active.ws.OPEN || this.activeDeviceId === null) {
				resolve$1({
					ok: false,
					reason: "没有已连接的手机"
				});
				return;
			}
			if (!active.helloSeen) {
				resolve$1({
					ok: false,
					reason: "手机刚重连,连接握手尚未完成,请稍候重试(或在手机端打开预览)"
				});
				return;
			}
			if (active.meta.appVersion === void 0 || !versionAtLeast(active.meta.appVersion, LENS_MIN_APP)) {
				resolve$1({
					ok: false,
					reason: `手机 App 版本过旧(镜头切换需 ≥ ${LENS_MIN_APP}),请先更新手机端`
				});
				return;
			}
			const reqId = randomUUID();
			const deviceId = this.activeDeviceId;
			let settled = false;
			const timer = setTimeout(() => finish({
				ok: false,
				reason: "手机未在时限内回执(可能不在前台或已断连)"
			}), timeoutMs);
			const finish = (r) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.lensWaiters.delete(reqId);
				resolve$1(r);
			};
			this.lensWaiters.set(reqId, {
				deviceId,
				settle: finish
			});
			this.sendControl(deviceId, {
				type: "camera_lens",
				...params.lens !== void 0 ? { lens: params.lens } : {},
				reqId
			});
		});
	}
	/**
	
	* Model tool: turn the ACTIVE phone's torch (flashlight) on/off (on given)
	
	* or query its state (on omitted). Settles with the phone's torch_result
	
	* receipt (or a timeout). App builds before 1.1.6 have no camera_torch
	
	* branch — same failure modes as zoom/lens: handshake gap ≠ old build.
	
	* Note the torch needs a live camera session: an idle camera answers
	
	* "相机未开启"; use phone_camera_resume to wake it first.
	
	*/
	async requestTorch(params, timeoutMs) {
		await this.awaitHandshake();
		return new Promise((resolve$1) => {
			const active = this.activeCam();
			if (!active || active.ws.readyState !== active.ws.OPEN || this.activeDeviceId === null) {
				resolve$1({
					ok: false,
					reason: "没有已连接的手机"
				});
				return;
			}
			if (!active.helloSeen) {
				resolve$1({
					ok: false,
					reason: "手机刚重连,连接握手尚未完成,请稍候重试(或在手机端打开预览)"
				});
				return;
			}
			if (active.meta.appVersion === void 0 || !versionAtLeast(active.meta.appVersion, TORCH_MIN_APP)) {
				resolve$1({
					ok: false,
					reason: `手机 App 版本过旧(手电筒需 ≥ ${TORCH_MIN_APP}),请先更新手机端`
				});
				return;
			}
			const reqId = randomUUID();
			const deviceId = this.activeDeviceId;
			let settled = false;
			const timer = setTimeout(() => finish({
				ok: false,
				reason: "手机未在时限内回执(可能不在前台或已断连)"
			}), timeoutMs);
			const finish = (r) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.torchWaiters.delete(reqId);
				resolve$1(r);
			};
			this.torchWaiters.set(reqId, {
				deviceId,
				settle: finish
			});
			this.sendControl(deviceId, {
				type: "camera_torch",
				...params.on !== void 0 ? { on: params.on } : {},
				reqId
			});
		});
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
//#region src/work/bridge.ts
/**
* Filter out prompt-injection and context events (runtime-context, time-context,
* skill-catalog, system/developer prompts, model-selection notices, etc.).
* Dropped both at snapshot delivery and live echo to save bandwidth and keep
* the phone timeline focused strictly on human/agent dialogue and tool results.
*/
function isContextInjectionEvent(ev) {
	if (!ev || typeof ev !== "object") return false;
	const type = ev.type;
	if (type === "system/message" || type === "developer/message") return true;
	if (type === "user/message") {
		const data = ev.data ?? ev.message ?? ev;
		const msg = data.message ?? data;
		const source = msg?.source ?? data?.source;
		if (source && typeof source === "object") {
			const kind = source.kind;
			if (kind && kind !== "user") return true;
		}
	}
	return false;
}
function filterEvents(events) {
	if (!Array.isArray(events)) return [];
	return events.filter((e) => !isContextInjectionEvent(e));
}
/**
* First-party command identities + their zh/en spellings (mirrors the host's
* dsh-commands builtin table). The HOST's execute() only resolves canonical
* lowercase names — alias resolution is a CLIENT concern (the desktop web UI
* ships its own copy), so the phone bridge carries one too: a `/压缩` typed on
* the phone must select the same command as on the desktop.
*/
const BUILTIN_COMMAND_TOKENS = [
	{
		pkg: "@deepseek-ai/dsh-command-goal",
		en: "goal",
		zh: "目标"
	},
	{
		pkg: "@deepseek-ai/dsh-plan-mode",
		en: "plan",
		zh: "计划"
	},
	{
		pkg: "@deepseek-ai/dsh-command-feedback",
		en: "feedback",
		zh: "反馈"
	},
	{
		pkg: "@deepseek-ai/dsh-command-compact",
		en: "compact",
		zh: "压缩"
	},
	{
		pkg: "@deepseek-ai/dsh-permission-presets",
		en: "permission",
		zh: "权限"
	},
	{
		pkg: "@deepseek-ai/dsh-session-log-export",
		en: "export",
		zh: "导出"
	}
];
/** Extra spellings (en+zh) selecting a first-party definition, for the phone UI. */
function commandAliases(descriptor) {
	const id = descriptor?.definitionId;
	if (typeof id !== "string") return [];
	const hit = BUILTIN_COMMAND_TOKENS.find((c) => c.pkg === id);
	return hit ? [hit.en, hit.zh] : [];
}
/**
* Resolve a typed token (canonical name, zh or en alias) against the agent's
* effective catalog — exact scoped names win, aliases only select their
* first-party definition (same precedence as the host's resolveCommand).
*/
function resolveCommandToken(token, descriptors) {
	const lower = token.toLowerCase();
	const exact = descriptors.find((d) => typeof d?.name === "string" && d.name === lower);
	if (exact) return exact;
	const hit = BUILTIN_COMMAND_TOKENS.find((c) => c.en === lower || c.zh === token);
	if (!hit) return void 0;
	return descriptors.find((d) => d?.definitionId === hit.pkg);
}
/** Static fallback directory when the host exposes no CommandRuntime service
*  (still names the six first-party commands so the phone UI stays usable). */
const FALLBACK_COMMANDS = BUILTIN_COMMAND_TOKENS.map((c) => ({
	name: c.en,
	aliases: [c.en, c.zh]
}));
/**
* Events we tap. Verified against dsh-agent 0.2.x runtime-types: the LIVE
* event surface is the agent layer (durable session events do NOT hit the
* cordis bus). Waterfall events (approval/request etc.) are DELIBERATELY
* absent — the desktop keeps answering approvals, we only poll state() for
* pendingInput visibility.
*/
const TAPPED_EVENTS = [
	"agent/created",
	"agent/disposed",
	"agent/status",
	"agent/inbox/inserted",
	"agent/assistant-stream",
	"agent/error"
];
/**
* Tool-layer live taps, registered SEPARATELY from TAPPED_EVENTS because
* both carry two handler parameters. Verified against dsh-tools
* events.ts/docs (tools.md event catalog):
* - `tools/pre-execute` (waterfall): (exec, next) — we observe and MUST
*   return next() to keep dispatching; a plugin-level listener sees every
*   agent's calls (same posture as the master-switch tap in index.ts).
* - `tools/result` (plain emit): (exec, result), frozen & lossless-JSON;
*   listener failures are contained by the tools service.
*
* Why: durable tool/call|tool/result events never hit the cordis bus, so a
* running turn used to show NO tool rows on the phone until it ended (tail
* refresh on running:false). The phone already renders the durable shapes —
* we forward these as seq:-1 session_events in exactly those shapes.
*/
const TOOL_RESULT_EVENT = "tools/result";
const TOOL_PRE_EVENT = "tools/pre-execute";
/** Extract the session id from an agent payload defensively. */
function agentSessionId(agent) {
	const sid = agent?.session?.sessionId ?? agent?.session?.id ?? agent?.sessionId;
	return typeof sid === "string" && sid ? sid : null;
}
const APPROVAL_POLL_MS = 5e3;
/**
* Mock mode (dev.js smoke tests only, gated by LENS_MOCK_WORK=1): serves
* fabricated sessions/events/streams so the phone UI can be exercised end to
* end without a live dsh host. Never active in production — the env var is
* only ever set by the standalone dev receiver.
*/
const MOCK = process.env.LENS_MOCK_WORK === "1";
const CLIENT_SILENCE_MS = 9e4;
const SESSION_LIST_DEBOUNCE_MS = 300;
/**
* UI-presence freshness for the work_devices list (contract frame 1): 25s =
* 2.5× the app's 10s ping, same doctrine as hub.ts OFFLINE_SILENCE_MS — ONE
* lost ping (worst-case inbound gap 20s) must never trip it. The judged value
* is WorkClient.lastSeenAt (the per-frame heartbeat on THIS connection table,
* NOT the devices.json field of the same name). The three existing parameters
* keep their own jobs (recheck-6): hub.ts 25s = camera preview UI, the app's
* 30s _halfOpenAfter = app-side self-heal, and CLIENT_SILENCE_MS above still
* owns the actual eviction — this constant only corrects the UI semantics.
*/
const PRESENCE_FRESH_MS = 25e3;
var WorkBridge = class WorkBridge {
	clients = new Set();
	wired = false;
	disposers = [];
	/** sessionController service (lazily probed; null = not available yet). */
	sc = null;
	/** Which service name the probe resolved the controller under. */
	scServiceName = null;
	probeLogged = false;
	/** sessionId → (approvalId → meta) mirror of pending approvals. */
	pendingApprovals = new Map();
	/**
	* Interactive requests (approval / question) waiting on the phone leg, by
	* request id. The waterfall answerer HOLDS its promise until either the
	* phone answers, the desktop's remote answerer (raced via next()) settles,
	* or the fallback timer fires. First valid answer wins; the loser's card is
	* torn down by an approval_resolved broadcast — a late tap on a torn-down
	* card resolves nothing (AGENTS.md #22 semantics, user-confirmed).
	*/
	pendingInteractions = new Map();
	/** sessionId → working directory (learned from readSession / snapshots). */
	cwdCache = new Map();
	sessionListTimer = null;
	/** Serialized device rows of the last work_devices broadcast (flip detect —
	*  the 10s presence timer only broadcasts on an actual change). */
	lastDevicesSnapshot = "";
	presenceTimer = null;
	/** Per-session text-delta micro-batch (lane-07 P3): chunk frames carry
	*  ~150-200B of envelope for a few bytes of payload; a 40ms batch cuts the
	*  frame count 5-20×. start/end/non-text frames flush and pass through. */
	streamBatches = new Map();
	/** When awaitController last exhausted its probe loop: probe retry is then
	*  cached for CONTROLLER_PROBE_TTL_MS instead of re-spinning a full 5s loop
	*  on every poll/list against a host that simply lacks the controller. */
	controllerProbeFailedAt = 0;
	constructor(ctx, settings, log, version) {
		this.ctx = ctx;
		this.settings = settings;
		this.log = log;
		this.version = version;
	}
	enabled() {
		return MOCK || this.settings.get().workBetaEnabled === true;
	}
	dispose() {
		this.teardown();
		for (const t of this.mockStreams.values()) clearInterval(t);
		this.mockStreams.clear();
		for (const c of this.clients) try {
			c.ws.close(1e3, "server-dispose");
		} catch {}
		this.clients.clear();
		if (this.sessionListTimer) clearTimeout(this.sessionListTimer);
		this.sessionListTimer = null;
		if (this.presenceTimer) {
			clearInterval(this.presenceTimer);
			this.presenceTimer = null;
		}
	}
	/**
	* React to the settings switch. Turning OFF tears the taps down and closes
	* every work client — nothing keeps listening on the host side.
	*/
	setEnabled(on) {
		if (on) {
			this.ensureWiring();
			for (const c of this.clients) this.sendHello(c);
			return;
		}
		this.teardown();
		for (const c of [...this.clients]) try {
			c.ws.close(4003, "work-beta-disabled");
		} catch {}
		this.clients.clear();
		this.log("info", "work beta disabled — taps removed, clients closed");
	}
	/**
	* Attach one work client. `device` carries the upgrade's authenticated
	* record ({deviceId, name}) — the http upgrade side owns passing it (same
	* posture as the camera channel's hub.attachCamera); loopback debug links
	* pass undefined and fall back to the placeholder identity below.
	*/
	attachClient(ws, device) {
		if (!this.enabled()) {
			try {
				ws.close(4003, "work-beta-disabled");
			} catch {}
			return;
		}
		const client = {
			ws,
			sessionId: null,
			lastSeenAt: Date.now(),
			deviceId: device?.deviceId ?? "",
			deviceName: device?.name ?? "本机调试"
		};
		this.clients.add(client);
		this.ensureWiring();
		ws.on("close", () => {
			this.clients.delete(client);
			this.pushDeviceList();
		});
		ws.on("error", (err) => {
			this.log("warn", `work ws error: ${String(err)}`);
		});
		ws.on("pong", () => {
			client.lastSeenAt = Date.now();
		});
		ws.on("message", (data, isBinary) => {
			client.lastSeenAt = Date.now();
			if (isBinary) return;
			let msg = null;
			try {
				msg = JSON.parse(data.toString("utf8"));
			} catch {
				return;
			}
			this.onClientMessage(client, msg);
		});
		this.sendHello(client);
		this.pushSessionList();
		this.pushDeviceList();
		this.log("info", `work client attached (${this.clients.size} online)`);
	}
	/** Called from the shared 20s heartbeat: evict silent clients. */
	pingAll() {
		const now = Date.now();
		for (const c of [...this.clients]) {
			if (c.ws.readyState !== c.ws.OPEN) continue;
			if (now - c.lastSeenAt > CLIENT_SILENCE_MS) {
				this.log("warn", "work client silent — terminating (half-open guard)");
				try {
					c.ws.terminate();
				} catch {}
				this.clients.delete(c);
				continue;
			}
			try {
				c.ws.ping();
			} catch {}
		}
	}
	clientCount() {
		return this.clients.size;
	}
	/** Device rows for the work_devices broadcast: deduped per deviceId (a
	*  half-open stale connection plus its reconnect can coexist briefly — the
	*  freshest heartbeat wins), online = ws OPEN + lastSeenAt fresh. */
	snapshotDevices() {
		const now = Date.now();
		const byDevice = new Map();
		for (const c of this.clients) {
			const prev = byDevice.get(c.deviceId);
			if (!prev || c.lastSeenAt > prev.lastSeenAt) byDevice.set(c.deviceId, c);
		}
		const rows = [];
		for (const c of byDevice.values()) rows.push({
			deviceId: c.deviceId,
			name: c.deviceName,
			deviceName: c.deviceName,
			sessionId: c.sessionId,
			cwd: c.sessionId ? this.cwdCache.get(c.sessionId) ?? null : null,
			online: c.ws.readyState === c.ws.OPEN && now - c.lastSeenAt < PRESENCE_FRESH_MS,
			lastSeenAt: c.lastSeenAt
		});
		return rows;
	}
	/** Broadcast the device list, flip-driven: an unchanged snapshot sends
	*  nothing (the 10s presence timer recomputes; attach/close/subscribe push
	*  eagerly). The phone consumes it for the device card; a frozen link goes
	*  online:false but STAYS in the list until the 90s eviction removes it. */
	pushDeviceList() {
		let snap;
		try {
			snap = JSON.stringify(this.snapshotDevices());
		} catch {
			return;
		}
		if (snap === this.lastDevicesSnapshot) return;
		this.lastDevicesSnapshot = snap;
		this.broadcast({
			type: "work_devices",
			devices: JSON.parse(snap)
		});
	}
	/**
	* Subscribe to host events + grab the sessionController. Idempotent, lazy:
	* nothing here runs while the beta switch is off.
	*/
	ensureWiring() {
		if (this.wired) return;
		this.wired = true;
		const ctx = this.ctx;
		if (!this.probeLogged) {
			this.probeLogged = true;
			try {
				const keys = Object.keys(ctx).filter((k) => typeof ctx[k] !== "function" || [
					"sessionController",
					"sessionQuery",
					"workspaceFiles",
					"agents",
					"sessions",
					"approval"
				].includes(k));
				this.log("info", `work probe: ctx services = ${keys.join(",")}`);
			} catch {}
		}
		this.probeSessionController();
		const on = (name, handler) => {
			try {
				const d = ctx.on?.(name, (payload) => {
					if (!this.enabled()) return;
					try {
						handler(payload);
					} catch (error) {
						this.log("warn", `work tap ${name} handler failed: ${String(error)}`);
					}
				});
				if (typeof d === "function") this.disposers.push(d);
			} catch (error) {
				this.log("warn", `work tap ${name} unavailable: ${String(error)}`);
			}
		};
		for (const name of TAPPED_EVENTS) on(name, (payload) => this.routeHostEvent(name, payload));
		try {
			const dPre = ctx.on?.(TOOL_PRE_EVENT, (exec, next) => {
				if (this.enabled()) try {
					const sid = agentSessionId(exec?.agent);
					if (sid) this.forward(sid, {
						type: "session_event",
						sessionId: sid,
						event: {
							type: "tool/call",
							seq: -1,
							time: Date.now(),
							data: {
								callId: exec.callId,
								name: exec.name,
								arguments: exec.arguments
							}
						}
					});
				} catch {}
				return next();
			});
			if (typeof dPre === "function") this.disposers.push(dPre);
		} catch (error) {
			this.log("warn", `work tap ${TOOL_PRE_EVENT} unavailable: ${String(error)}`);
		}
		try {
			const dRes = ctx.on?.(TOOL_RESULT_EVENT, (exec, result) => {
				if (!this.enabled()) return;
				try {
					const sid = agentSessionId(exec?.agent);
					if (!sid) return;
					const failed = result?.isError === true;
					this.forward(sid, {
						type: "session_event",
						sessionId: sid,
						event: {
							type: "tool/result",
							seq: -1,
							time: Date.now(),
							data: {
								callId: exec.callId,
								message: {
									role: "tool",
									source: {
										kind: "tool",
										callId: exec.callId
									},
									toolCallId: exec.callId,
									content: Array.isArray(result?.content) ? result.content : [],
									isError: failed
								},
								...failed ? { error: result.error } : {}
							}
						}
					});
				} catch {}
			});
			if (typeof dRes === "function") this.disposers.push(dRes);
		} catch (error) {
			this.log("warn", `work tap ${TOOL_RESULT_EVENT} unavailable: ${String(error)}`);
		}
		on("commands/change", () => {
			for (const c of this.clients) this.sendTo(c, { type: "commands_changed" });
		});
		on("workspace/session-archived", () => this.scheduleSessionListRefresh());
		on("workspace/session-unarchiving", (payload) => {
			this.scheduleSessionListRefresh();
			const sid = this.sessionIdFromTapPayload(payload);
			if (sid) this.forward(sid, {
				type: "session_unarchived",
				sessionId: sid
			});
			else this.logOnce("workspace/session-unarchiving tap carried no usable sessionId — banner clear relies on the phone-side list diff");
		});
		const poll = setInterval(() => void this.pollPendingInput(), APPROVAL_POLL_MS);
		this.disposers.push(() => clearInterval(poll));
		for (const evt of ["approval/request", "user-questions/request"]) try {
			const kind = evt === "approval/request" ? "approval" : "question";
			const d = ctx.on?.(evt, (req, next) => this.raceInteraction(kind, req, next), { prepend: true });
			if (typeof d === "function") this.disposers.push(d);
			this.log("info", `work answerer armed: ${evt} (prepend)`);
		} catch (error) {
			this.log("warn", `work tap ${evt} unavailable: ${String(error)}`);
		}
		this.log("info", `work beta wired (${TAPPED_EVENTS.join(", ")})`);
		if (!this.presenceTimer) {
			this.presenceTimer = setInterval(() => {
				if (!this.enabled() || this.clients.size === 0) return;
				this.pushDeviceList();
			}, 1e4);
			if (typeof this.presenceTimer.unref === "function") this.presenceTimer.unref();
		}
	}
	/** Defensive sessionId extraction from workspace tap payloads (shape
	*  unverified on this host build — lane-02 §5.2). */
	sessionIdFromTapPayload(payload) {
		const p = payload;
		if (!p || typeof p !== "object") return null;
		for (const c of [
			p.sessionId,
			p.session?.sessionId,
			p.session?.id,
			p.id
		]) if (typeof c === "string" && c) return c;
		return null;
	}
	/** Poll state() for every subscribed session → approval_state mirrors. */
	async pollPendingInput() {
		if (!this.enabled() || this.clients.size === 0) return;
		const sc = await this.awaitController();
		if (!sc || typeof sc.state !== "function") return;
		const sids = new Set();
		for (const c of this.clients) if (c.sessionId) sids.add(c.sessionId);
		for (const sid of [...this.pendingApprovals.keys()]) if (!sids.has(sid)) this.pendingApprovals.delete(sid);
		for (const sessionId of sids) try {
			const st = await sc.state({ sessionId }, AbortSignal.timeout(8e3));
			const pending = Array.isArray(st?.pendingInput) ? st.pendingInput : [];
			const per = this.pendingApprovals.get(sessionId);
			if (pending.length === 0) {
				if (per) {
					this.pendingApprovals.delete(sessionId);
					this.pushApprovalState(sessionId);
				}
				continue;
			}
			const map = new Map();
			for (const kind of pending) {
				const key = String(kind);
				map.set(key, per?.get(key) ?? { reason: key });
			}
			const changed = !per || per.size !== map.size || [...map.keys()].some((k) => !per.has(k));
			this.pendingApprovals.set(sessionId, map);
			if (changed) this.pushApprovalState(sessionId);
		} catch {}
	}
	/** Any phone currently subscribed to this session (only those get cards). */
	hasSubscriber(sessionId) {
		for (const c of this.clients) if (c.sessionId === sessionId) return true;
		return false;
	}
	/**
	* The phone-leg answer surface: hold until `answerInteraction` resolves it,
	* the desktop leg (raced via next()) settles first, or 5 minutes pass —
	* a phone must never be the reason a turn hangs forever.
	*/
	static INTERACTION_TIMEOUT_MS = 3e5;
	/** Snapshot baseline split threshold (recheck-4 §3.2): slices on EVENT
	*  boundaries into several session_snapshot frames (App merge-by-seq is
	*  idempotent); a single oversized event is never byte-cut. */
	static SNAPSHOT_CHUNK_BYTES = 8 * 1024 * 1024;
	/** text-delta micro-batch window (lane-07 P3: 30-50ms recommended). */
	static STREAM_BATCH_MS = 40;
	/** awaitController probe-failure cache TTL (H16). */
	static CONTROLLER_PROBE_TTL_MS = 3e4;
	raceInteraction(kind, req, next) {
		if (!this.enabled()) {
			this.log("info", `race ${kind} skip: disabled`);
			return Promise.resolve(next());
		}
		const sessionId = agentSessionId(req?.agent) ?? "";
		if (!sessionId || !this.hasSubscriber(sessionId)) {
			this.log("info", `race ${kind} skip: sid=${sessionId || "(none)"} clients=${this.clients.size}`);
			return Promise.resolve(next());
		}
		const id = `wi-${randomUUID()}`;
		const frame = this.buildInteractionFrame(kind, sessionId, id, req);
		if (!frame) {
			this.log("info", `race ${kind} skip: frame null keys=[${Object.keys(req ?? {}).join(",")}]`);
			return Promise.resolve(next());
		}
		let desktop;
		try {
			desktop = Promise.resolve(next());
		} catch (error) {
			desktop = Promise.resolve("unavailable");
		}
		desktop = desktop.catch(() => "unavailable");
		const raced = new Promise((resolve$1) => {
			let settled = false;
			this.log("info", `race ${kind} enter sid=${sessionId.slice(0, 12)} id=${id}`);
			const finish = (outcome, extra) => {
				if (settled) return;
				settled = true;
				this.log("info", `race ${kind} settled via ${extra} outcome=${typeof outcome === "string" ? outcome : "answers"}`);
				clearTimeout(timer);
				this.pendingInteractions.delete(id);
				this.forward(sessionId, {
					type: "approval_resolved",
					sessionId,
					id,
					...typeof outcome === "string" ? { outcome } : outcome && typeof outcome === "object" ? { outcome: "answered" } : {}
				});
				if (extra === "phone") this.settleDesktopRemoteLeg(kind, req, outcome);
				resolve$1(outcome);
			};
			const entry = {
				sessionId,
				kind,
				frame,
				phoneSettle: () => {},
				timer: null
			};
			const timer = setTimeout(() => {
				entry.timedOut = true;
				entry.phoneSettle(null);
			}, WorkBridge.INTERACTION_TIMEOUT_MS);
			if (typeof timer.unref === "function") timer.unref();
			entry.timer = timer;
			this.pendingInteractions.set(id, entry);
			const phoneP = new Promise((resolvePhone) => {
				entry.phoneSettle = (value) => resolvePhone({
					value,
					from: "phone"
				});
			});
			const desktopP = desktop.then((value) => ({
				value,
				from: "desktop"
			}));
			Promise.race([phoneP, desktopP]).then(async (first) => {
				if (first.from === "phone") if (first.value == null) finish(await desktop, "desktop");
				else finish(first.value, "phone");
				else finish(first.value, "desktop");
			});
			this.forward(sessionId, frame);
		});
		if (kind === "approval") try {
			const cardToolName = frame.toolName;
			if (typeof cardToolName === "string" && cardToolName) {
				const per = this.pendingApprovals.get(sessionId) ?? new Map();
				per.set(kind, {
					...per.get(kind) ?? {},
					toolName: cardToolName
				});
				this.pendingApprovals.set(sessionId, per);
				this.pushApprovalState(sessionId);
			}
		} catch {}
		return raced;
	}
	/**
	* Phone won the race → settle the remote bridge's pending waterfall so the
	* gateway pushes cancel frames to every desktop window (card tears down
	* immediately). A desktop click AFTER this is dropped idempotently by the
	* gateway (pending already removed from its map). Uses internal gateway
	* members (pendingRemoteEvents / settleRemoteEvent) — capability-probed,
	* failure just means the desktop card stays until clicked (status quo).
	*/
	settleDesktopRemoteLeg(kind, req, outcome) {
		let gw;
		try {
			const ctxAny = this.ctx;
			if (typeof ctxAny.get === "function") gw = ctxAny.get("typertGateway");
		} catch {}
		if (!gw) try {
			gw = this.ctx.typertGateway;
		} catch {}
		if (!gw) {
			this.log("warn", "settle desktop leg: typertGateway not resolvable (desktop card stays)");
			return;
		}
		if (typeof gw.hasLiveClient === "function" && !gw.hasLiveClient()) return;
		const pendings = gw.pendingRemoteEvents;
		if (!(pendings instanceof Map)) {
			const shape = gw && typeof gw === "object" ? Object.keys(gw).slice(0, 14).join(",") : typeof gw;
			this.log("warn", `settle desktop leg: pendingRemoteEvents not a Map (keys: ${shape})`);
			return;
		}
		const eventName = kind === "approval" ? "approval/request" : "user-questions/request";
		const agentId = req?.agent?.id;
		if (typeof gw.settleRemoteEvent !== "function") {
			this.log("warn", "settle desktop leg: settleRemoteEvent missing (dsh upgrade renamed internals?)");
			return;
		}
		let scanned = 0;
		let settledCount = 0;
		for (const pending of [...pendings.values()]) {
			scanned++;
			const frame = pending?.frame;
			if (frame?.event !== eventName) continue;
			if (agentId !== void 0 && frame?.agentId !== void 0 && frame?.agentId !== agentId) continue;
			if (!this.sameInteractionRequest(req, frame?.request)) continue;
			try {
				gw.settleRemoteEvent(pending, {
					kind: "result",
					value: outcome
				});
				settledCount++;
			} catch (error) {
				this.log("warn", `settle desktop leg: per-pending settle failed: ${String(error).slice(0, 100)}`);
			}
		}
		if (scanned > 0 && settledCount === 0) this.log("info", `race ${kind} desktop leg: ${scanned} pending scanned but none matched this card's payload (older host without frame.request?) — desktop card left as-is`);
		this.log("info", `race ${kind} desktop leg: scanned=${scanned} settled=${settledCount}`);
	}
	/**
	* Whether the gateway's projected request describes THIS card: compared on
	* the discriminating business fields (toolName/callId/reason/displayReason
	* + question ids). A shape mismatch (older host without frame.request, or
	* an unforeseen projection) just returns false — the desktop card then
	* stays until clicked, which is the documented degradation, instead of the
	* old blast-radius teardown of every same-kind pending.
	*/
	sameInteractionRequest(req, projected) {
		if (!projected || typeof projected !== "object") return false;
		const eq = (a, b) => (a ?? void 0) === (b ?? void 0);
		if (!eq(req?.toolName, projected.toolName)) return false;
		if (!eq(req?.callId, projected.callId)) return false;
		if (!eq(req?.reason, projected.reason)) return false;
		if (!eq(req?.displayReason, projected.displayReason)) return false;
		const aq = Array.isArray(req?.questions) ? req.questions : [];
		const bq = Array.isArray(projected.questions) ? projected.questions : [];
		if (aq.length !== bq.length) return false;
		if (aq.length > 0) {
			const ids = (list) => list.map((q) => String(q?.id ?? "")).sort().join("|");
			if (ids(aq) !== ids(bq)) return false;
		}
		return true;
	}
	/** Assemble the phone frame for one interactive request (null = unusable). */
	buildInteractionFrame(kind, sessionId, id, req) {
		if (kind === "approval") {
			const toolName = typeof req?.toolName === "string" ? req.toolName : void 0;
			if (!toolName && !req?.reason) return null;
			return {
				type: "approval_request",
				sessionId,
				id,
				kind,
				...toolName ? { toolName } : {},
				...typeof req?.callId === "string" && req.callId ? { callId: req.callId } : {},
				...typeof req?.reason === "string" && req.reason ? { reason: req.reason } : {},
				...typeof req?.displayReason === "string" && req.displayReason ? { displayReason: req.displayReason } : {}
			};
		}
		const questions = Array.isArray(req?.questions) ? req.questions.filter((q) => q && typeof q === "object").map((q) => ({
			id: String(q.id ?? ""),
			question: String(q.question ?? ""),
			...typeof q.detail === "string" && q.detail ? { detail: q.detail } : {},
			...typeof q.header === "string" && q.header ? { header: q.header } : {},
			...q.multiSelect === true ? { multiSelect: true } : {},
			...Array.isArray(q.options) ? { options: q.options.filter((o) => o && typeof o === "object").map((o) => ({
				label: String(o.label ?? ""),
				...typeof o.description === "string" && o.description ? { description: o.description } : {}
			})).filter((o) => o.label) } : {}
		})).filter((q) => q.id && q.question) : [];
		if (questions.length === 0) return null;
		return {
			type: "approval_request",
			sessionId,
			id,
			kind,
			...typeof req?.callId === "string" && req.callId ? { callId: req.callId } : {},
			questions
		};
	}
	/**
	* Phone answered a card. Stores the validated answer on the entry and
	* settles its phone leg (the race in raceInteraction does the rest).
	* Unknown id = the request already settled elsewhere (the desktop answered
	* first and the phone's card was torn down): the tap is simply void.
	*/
	answerInteraction(client, msg) {
		const entry = this.pendingInteractions.get(msg.id);
		if (!entry || entry.sessionId !== msg.sessionId) return this.ack(client, msg.reqId, false, "该请求已结束（可能在电脑端已处理）");
		if (entry.timedOut === true) return this.ack(client, msg.reqId, false, "该请求已超时关闭，请在电脑端处理");
		if (msg.type === "approval_answer") {
			if (entry.kind !== "approval") return this.ack(client, msg.reqId, false, "请求类型不匹配");
			if (msg.outcome !== "allowed-once" && msg.outcome !== "rejected") return this.ack(client, msg.reqId, false, "无效的审批结果");
			this.ack(client, msg.reqId, true);
			entry.phoneSettle(msg.outcome);
			return;
		}
		if (entry.kind !== "question") return this.ack(client, msg.reqId, false, "请求类型不匹配");
		const frame = entry.frame;
		const asked = frame.questions ?? [];
		const answers = Array.isArray(msg.answers) ? msg.answers.filter((a) => a && typeof a.id === "string" && Array.isArray(a.selected)) : [];
		const answeredIds = new Set(answers.map((a) => a.id));
		if (answers.length !== asked.length || !asked.every((q) => answeredIds.has(q.id))) return this.ack(client, msg.reqId, false, "答案必须恰好覆盖每个问题一次");
		this.ack(client, msg.reqId, true);
		entry.phoneSettle({ answers: answers.map((a) => ({
			id: a.id,
			selected: a.selected.map(String),
			...typeof a.custom === "string" && a.custom ? { custom: a.custom } : {}
		})) });
	}
	/** Re-send every pending interactive card (phone reconnect handshake). */
	replayPendingInteractions(client) {
		for (const entry of this.pendingInteractions.values()) if (entry.sessionId === client.sessionId) this.sendTo(client, entry.frame);
	}
	teardown() {
		for (const d of this.disposers) try {
			d();
		} catch {}
		this.disposers = [];
		this.wired = false;
		this.pendingApprovals.clear();
		for (const entry of this.pendingInteractions.values()) clearTimeout(entry.timer);
		this.pendingInteractions.clear();
		this.cwdCache.clear();
		if (this.presenceTimer) {
			clearInterval(this.presenceTimer);
			this.presenceTimer = null;
		}
		for (const batch of this.streamBatches.values()) clearTimeout(batch.timer);
		this.streamBatches.clear();
	}
	probeSessionController() {
		if (this.sc) return;
		const ctx = this.ctx;
		const candidates = [
			"sessionController",
			"apiSessionController",
			"session"
		];
		for (const name of candidates) try {
			const viaGet = typeof ctx.get === "function" ? ctx.get(name) : void 0;
			const sc = viaGet ?? ctx[name];
			if (sc && typeof sc === "object") {
				this.sc = sc;
				this.scServiceName = name;
				const proto = Object.getPrototypeOf(sc) ?? {};
				const methods = [...Object.getOwnPropertyNames(proto), ...Object.keys(sc)].filter((m) => typeof sc[m] === "function");
				this.log("info", `work probe: ${name} methods = ${methods.join(",")}`);
				return;
			}
		} catch {}
	}
	/**
	* Debug surface for calibration. lane-10 L2 convergence: the full dump
	* (ctx keys + host method signatures) used to reach ANY paired phone —
	* host-internal structure the phone doesn't need. Production now gets the
	* service-availability summary only; the method-signature dump rides the
	* mock receiver (dev.js calibration) exclusively.
	*/
	handleDebugProbe(client, reqId) {
		const ctx = this.ctx;
		const gettable = {};
		for (const name of [
			"sessionController",
			"apiSessionController",
			"sessionQuery",
			"workspaceFiles",
			"agents",
			"sessions",
			"approval",
			"tools",
			"attachments"
		]) try {
			const v = typeof ctx.get === "function" ? ctx.get(name) : void 0;
			gettable[name] = v !== void 0 && v !== null;
		} catch {
			gettable[name] = false;
		}
		if (!MOCK) return this.ack(client, reqId, true, void 0, {
			gettable,
			scFound: !!this.sc,
			scServiceName: this.scServiceName
		});
		let ctxKeys = [];
		try {
			ctxKeys = Object.keys(ctx).slice(0, 120);
		} catch {}
		const methodInfo = {};
		for (const svcName of [
			"sessionController",
			"sessionQuery",
			"workspaceFiles"
		]) try {
			const svc = typeof ctx.get === "function" ? ctx.get(svcName) : void 0;
			if (!svc) continue;
			const proto = Object.getPrototypeOf(svc) ?? {};
			for (const m of [...Object.getOwnPropertyNames(proto), ...Object.keys(svc)]) {
				if (typeof svc[m] !== "function" || m === "constructor") continue;
				try {
					methodInfo[`${svcName}.${m}`] = String(svc[m]).slice(0, 240);
				} catch {}
			}
		} catch {}
		this.ack(client, reqId, true, void 0, {
			ctxKeys,
			gettable,
			scFound: !!this.sc,
			scServiceName: this.scServiceName,
			methodInfo
		});
	}
	/**
	* Calibration-only passthrough: invoke a whitelisted READ-ONLY host method
	* with arbitrary args and return the raw JSON. Lets the probe round iterate
	* argument shapes without a rebuild per try. Mutation methods are absent
	* from the whitelist on purpose.
	*/
	async handleDebugCall(client, reqId, service, method, args) {
		const READ_METHODS = new Set([
			"sessionController.list",
			"sessionController.search",
			"sessionController.events",
			"sessionController.page",
			"sessionController.state",
			"sessionController.projections",
			"sessionController.modelCatalog",
			"sessionController.observeState",
			"sessionController.follow",
			"sessionQuery.listSessions",
			"sessionQuery.readSession",
			"sessionQuery.filterSessions",
			"workspaceFiles.list",
			"workspaceFiles.stat",
			"workspaceFiles.read",
			"workspaceFiles.readBytes",
			"workspaceFiles.changes",
			"agents.get"
		]);
		const key = `${service}.${method}`;
		if (!READ_METHODS.has(key)) return this.ack(client, reqId, false, `debug_call: ${key} not whitelisted`);
		const ctx = this.ctx;
		let svc;
		try {
			svc = typeof ctx.get === "function" ? ctx.get(service) : void 0;
		} catch {}
		if (!svc || typeof svc[method] !== "function") return this.ack(client, reqId, false, `debug_call: ${key} unavailable`);
		try {
			const result = await svc[method](...args, AbortSignal.timeout(3e4));
			const text = JSON.stringify(result, (_k, v) => typeof v === "bigint" ? String(v) : v);
			if (text.length > 2e5) return this.ack(client, reqId, true, void 0, {
				truncated: true,
				preview: text.slice(0, 1e5)
			});
			const parsed = JSON.parse(text);
			return this.ack(client, reqId, true, void 0, parsed);
		} catch (error) {
			return this.ack(client, reqId, false, `debug_call ${key} threw: ${String(error).slice(0, 300)}`);
		}
	}
	routeHostEvent(name, payload) {
		const p = payload;
		if (!p) return;
		const sessionId = agentSessionId(p.agent);
		switch (name) {
			case "agent/status": {
				if (!sessionId) return;
				const status = typeof p.status === "string" ? p.status : String(p.status ?? "");
				this.forward(sessionId, {
					type: "session_state",
					sessionId,
					running: status === "running",
					status
				});
				this.scheduleSessionListRefresh();
				break;
			}
			case "agent/assistant-stream": {
				if (!sessionId || !p.frame) return;
				this.enqueueStreamFrame(sessionId, p.frame);
				break;
			}
			case "agent/inbox/inserted": {
				if (!sessionId || !p.message) return;
				if (isContextInjectionEvent({
					type: "user/message",
					data: { message: p.message }
				})) return;
				this.forward(sessionId, {
					type: "session_event",
					sessionId,
					event: {
						type: "user/message",
						seq: -1,
						time: Date.now(),
						data: {
							message: p.message,
							inbox: "inserted"
						}
					}
				});
				break;
			}
			case "agent/error": {
				if (!sessionId) return;
				const detail = String(p.error ?? "");
				this.log("warn", `work: agent error on ${sessionId.slice(0, 8)}: ${detail.slice(0, 160)}`);
				this.forward(sessionId, {
					type: "session_event",
					sessionId,
					event: {
						type: "agent/error",
						seq: -1,
						time: Date.now(),
						data: {
							turn: p.turn,
							step: p.step,
							error: detail.slice(0, 600)
						}
					}
				});
				break;
			}
			case "agent/created":
			case "agent/disposed":
			default:
				this.scheduleSessionListRefresh();
				break;
		}
	}
	pushApprovalState(sessionId) {
		const per = this.pendingApprovals.get(sessionId);
		const pending = per ? [...per.entries()].map(([id, meta]) => ({
			id,
			...meta.toolName !== void 0 ? { toolName: meta.toolName } : {},
			...meta.reason !== void 0 ? { reason: meta.reason } : {}
		})) : [];
		const interactionIds = [...this.pendingInteractions.entries()].filter(([, e]) => e.sessionId === sessionId).map(([id]) => id);
		this.forward(sessionId, {
			type: "approval_state",
			sessionId,
			pending,
			interactionIds
		});
	}
	/** Send to every client currently subscribed to this session. The old
	*  "no subscriber → dump onto sessionId===null connections" fallback is
	*  GONE (lane-01 R6): the work feature shipped with 1.1.6, and its App
	*  filters every fallback-eligible frame (session_event/approval_state/
	*  model_changed/session_archived/session_state/resolved) against its
	*  subscribedId, so on a subscriberless window those bytes were dropped on
	*  arrival — dead bytes. The list page's running state comes from the
	*  session_list broadcast, not these frames. */
	forward(sessionId, msg) {
		const text = JSON.stringify(msg);
		for (const c of this.clients) if (c.sessionId === sessionId && c.ws.readyState === c.ws.OPEN) try {
			c.ws.send(text);
		} catch {}
	}
	broadcast(msg) {
		const text = JSON.stringify(msg);
		for (const c of this.clients) if (c.ws.readyState === c.ws.OPEN) try {
			c.ws.send(text);
		} catch {}
	}
	/**
	* H10 (lane-07 P3): buffer per-session text-delta chunks for STREAM_BATCH_MS
	* and emit ONE merged chunk frame — each chunk's ~150-200B envelope used to
	* hit the wire verbatim for a few bytes of text (5-20× amplification). The
	* app's chunk ingestion concatenates `chunk.text`, so a merged frame needs
	* no client change. start/end/non-text frames flush the pending batch and
	* pass through immediately; a new attemptId/revision flushes too.
	*/
	enqueueStreamFrame(sessionId, frame) {
		const chunk = frame.chunk;
		const batchable = frame.type === "chunk" && chunk?.type === "text-delta" && typeof chunk.text === "string";
		if (!batchable) {
			this.flushStreamBatch(sessionId);
			this.forward(sessionId, {
				type: "stream_frame",
				sessionId,
				frame
			});
			return;
		}
		const existing = this.streamBatches.get(sessionId);
		if (existing && existing.frame.attemptId === frame.attemptId && existing.frame.revision === frame.revision) {
			existing.frame.chunk.text += frame.chunk.text;
			if (frame.index !== void 0) existing.frame.index = frame.index;
			return;
		}
		this.flushStreamBatch(sessionId);
		const copy = {
			...frame,
			chunk: { ...frame.chunk }
		};
		const timer = setTimeout(() => this.flushStreamBatch(sessionId), WorkBridge.STREAM_BATCH_MS);
		if (typeof timer.unref === "function") timer.unref();
		this.streamBatches.set(sessionId, {
			frame: copy,
			timer
		});
	}
	flushStreamBatch(sessionId) {
		const batch = this.streamBatches.get(sessionId);
		if (!batch) return;
		this.streamBatches.delete(sessionId);
		clearTimeout(batch.timer);
		this.forward(sessionId, {
			type: "stream_frame",
			sessionId,
			frame: batch.frame
		});
	}
	sendHello(client) {
		let version = "0.0.0";
		try {
			version = this.version();
		} catch {}
		this.sendTo(client, {
			type: "work_hello",
			enabled: true,
			version
		});
		this.replayPendingInteractions(client);
	}
	sendTo(client, msg) {
		if (client.ws.readyState !== client.ws.OPEN) return;
		try {
			client.ws.send(JSON.stringify(msg));
		} catch {}
	}
	ack(client, reqId, ok, reason, data) {
		this.sendTo(client, {
			type: "work_ack",
			reqId,
			ok,
			...reason !== void 0 ? { reason } : {},
			...data !== void 0 ? { data } : {}
		});
	}
	logOnceCache = new Set();
	logOnce(key) {
		if (this.logOnceCache.has(key)) return;
		this.logOnceCache.add(key);
		if (this.logOnceCache.size > 20) this.logOnceCache.clear();
		this.log("warn", `work calibration: ${key}`);
	}
	onClientMessage(client, msg) {
		if (!msg || typeof msg.type !== "string") return;
		if (MOCK) {
			this.onMockMessage(client, msg);
			return;
		}
		switch (msg.type) {
			case "ping":
				this.sendTo(client, { type: "pong" });
				return;
			case "session_list_req":
				this.pushSessionList().then(() => this.ack(client, msg.reqId, true));
				return;
			case "session_subscribe":
				this.handleSubscribe(client, msg);
				return;
			case "session_create":
				this.handleSessionCreate(client, msg);
				return;
			case "session_fork":
				this.handleSessionFork(client, msg);
				return;
			case "session_archive":
				this.handleSessionArchive(client, msg);
				return;
			case "history_page":
				this.handleHistoryPage(client, msg);
				return;
			case "work_send":
				this.handleSend(client, msg);
				return;
			case "work_cancel":
				this.handleCancel(client, msg);
				return;
			case "model_catalog_req":
				this.handleModelCatalog(client, msg);
				return;
			case "work_select_model":
				this.handleSelectModel(client, msg);
				return;
			case "commands_list":
				this.handleCommandsList(client, msg);
				return;
			case "mention_query":
				this.handleMentionQuery(client, msg);
				return;
			case "file_list":
				this.handleFileList(client, msg);
				return;
			case "file_read":
				this.handleFileRead(client, msg);
				return;
			case "changes_summary":
				this.handleChangesSummary(client, msg);
				return;
			case "approval_answer":
			case "question_answer":
				this.answerInteraction(client, msg);
				return;
			case "debug_probe":
				this.handleDebugProbe(client, msg.reqId);
				return;
			case "debug_call":
				this.handleDebugCall(client, msg.reqId, String(msg.service ?? ""), String(msg.method ?? ""), Array.isArray(msg.args) ? msg.args : []);
				return;
			default: return;
		}
	}
	/**
	* H1/H4/H7/H8: subscribe (or unsubscribe via an empty sessionId — the
	* app's leave-session path). Async because the existence probe rides the
	* host list; the ack only goes out AFTER that verdict so the phone sees
	* exactly one ack. Cards replay AFTER the snapshot lands (timeline first,
	* cards second) — the reconnect/subscribe path that used to lose live
	* cards entirely (replay was dead code: attach-time sessionId is null).
	*/
	async handleSubscribe(client, msg) {
		const requested = msg.sessionId || null;
		client.sessionId = requested;
		this.pushDeviceList();
		if (!requested) return this.ack(client, msg.reqId, true);
		const exists = await this.sessionExists(requested);
		if (exists === false) {
			client.sessionId = null;
			this.pushDeviceList();
			return this.ack(client, msg.reqId, false, "会话不存在（可能已被删除）");
		}
		this.ack(client, msg.reqId, true);
		const sinceSeq = typeof msg.sinceSeq === "number" && Number.isFinite(msg.sinceSeq) && msg.sinceSeq > 0 ? msg.sinceSeq : void 0;
		await this.pushSnapshot(client, requested, sinceSeq);
		this.replayPendingInteractions(client);
	}
	/**
	* Best-effort existence check for a subscribe target against the host's
	* session list. true/false only when the list is readable and non-empty;
	* null = unknown (host cold/unavailable) — the caller then lets the
	* snapshot flow decide instead of rejecting a subscribable session.
	*/
	async sessionExists(sessionId) {
		const sc = await this.awaitController(3e3);
		if (!sc || typeof sc.list !== "function") return null;
		try {
			const items = this.extractItems(await sc.list());
			if (items.length === 0) return null;
			return items.some((it) => it?.origin !== "subagent" && String(it?.sessionId ?? it?.id ?? "") === sessionId);
		} catch {
			return null;
		}
	}
	mockSessions = [
		{
			sessionId: "mock-session-1",
			title: "修复登录页的空指针崩溃",
			updatedAt: Date.now() - 6e4,
			running: false,
			blank: false,
			cwd: "C:\\demo\\lens-app"
		},
		{
			sessionId: "mock-session-2",
			title: "重构 WebSocket 重连逻辑",
			updatedAt: Date.now() - 36e5,
			running: false,
			blank: false,
			cwd: "C:\\demo\\lens-app"
		},
		{
			sessionId: "mock-session-3",
			title: "调研竞品的会话镜像方案",
			updatedAt: Date.now() - 72e5,
			running: false,
			blank: false,
			cwd: "C:\\demo\\research"
		}
	];
	mockStreams = new Map();
	onMockMessage(client, msg) {
		switch (msg.type) {
			case "ping":
				this.sendTo(client, { type: "pong" });
				return;
			case "session_list_req":
				this.broadcast({
					type: "session_list",
					sessions: this.mockSessions
				});
				this.ack(client, msg.reqId, true);
				return;
			case "session_create": {
				if (msg.cwd && msg.workspaceId) {
					this.ack(client, msg.reqId, false, "cwd 与 workspaceId 只能传其一");
					return;
				}
				const sid = `mock-session-${Date.now()}`;
				const cwd = msg.cwd ?? this.mockSessions[0]?.cwd ?? "C:\\demo\\lens-app";
				this.mockSessions = [{
					sessionId: sid,
					title: "(新会话)",
					updatedAt: Date.now(),
					running: false,
					blank: true,
					cwd
				}, ...this.mockSessions];
				this.broadcast({
					type: "session_list",
					sessions: this.mockSessions
				});
				this.ack(client, msg.reqId, true, void 0, { sessionId: sid });
				return;
			}
			case "session_fork": {
				const srcRow = this.mockSessions.find((r) => r.sessionId === msg.sessionId);
				if (!srcRow) {
					this.ack(client, msg.reqId, false, "源会话不存在");
					return;
				}
				const childId = `mock-session-fork-${Date.now()}`;
				const base = (msg.title ?? srcRow.title ?? "").trim();
				const taken = new Set(this.mockSessions.map((r) => r.title).filter((t) => !!t));
				const nextTitle = this.nextForkTitle(base, taken);
				this.mockSessions = [{
					sessionId: childId,
					title: nextTitle,
					updatedAt: Date.now(),
					running: false,
					blank: false,
					cwd: srcRow.cwd
				}, ...this.mockSessions];
				this.broadcast({
					type: "session_list",
					sessions: this.mockSessions
				});
				this.ack(client, msg.reqId, true, void 0, { sessionId: childId });
				return;
			}
			case "session_archive": {
				const before = this.mockSessions.length;
				this.mockSessions = this.mockSessions.filter((r) => r.sessionId !== msg.sessionId);
				this.broadcast({
					type: "session_list",
					sessions: this.mockSessions
				});
				this.ack(client, msg.reqId, this.mockSessions.length < before || msg.unarchive === true, void 0, { archivedSessionIds: [] });
				return;
			}
			case "session_subscribe": {
				client.sessionId = msg.sessionId || null;
				this.pushDeviceList();
				this.ack(client, msg.reqId, true);
				const sid = msg.sessionId;
				if (!sid) return;
				const now = Date.now();
				const sinceSeq = typeof msg.sinceSeq === "number" && Number.isFinite(msg.sinceSeq) && msg.sinceSeq > 0 ? msg.sinceSeq : void 0;
				this.sendSnapshot(client, sid, [
					{
						type: "session/title",
						seq: 0,
						time: now - 12e4,
						data: { title: "修复登录页的空指针崩溃" }
					},
					{
						type: "user/message",
						seq: 3,
						time: now - 118e3,
						data: {
							content: [{
								type: "text",
								text: "登录页在空表单提交时会崩溃,帮我修一下"
							}],
							source: {
								kind: "user",
								rpcId: "seed-rpc-1"
							},
							role: "user",
							id: "seed-1"
						}
					},
					{
						type: "turn/start",
						seq: 4,
						time: now - 117e3,
						data: { turn: 1 }
					},
					{
						type: "tool/call",
						seq: 5,
						time: now - 116e3,
						data: {
							turn: 1,
							step: 1,
							callId: "c1",
							name: "read",
							arguments: JSON.stringify({ path: "lib/login.dart" })
						}
					},
					{
						type: "tool/result",
						seq: 6,
						time: now - 115e3,
						data: {
							turn: 1,
							step: 1,
							message: {
								role: "tool",
								source: {
									kind: "tool",
									callId: "c1"
								},
								toolCallId: "c1",
								content: [{
									type: "text",
									text: "class LoginPage extends StatefulWidget {...}"
								}],
								isError: false
							}
						}
					},
					{
						type: "tool/call",
						seq: 7,
						time: now - 114e3,
						data: {
							turn: 1,
							step: 2,
							callId: "c2",
							name: "edit",
							arguments: JSON.stringify({
								path: "lib/login.dart",
								old: "form.validate()",
								new: "form?.validate()"
							})
						}
					},
					{
						type: "tool/result",
						seq: 8,
						time: now - 113e3,
						data: {
							turn: 1,
							step: 2,
							error: {
								name: "ToolError",
								code: "apply_failed"
							},
							message: {
								role: "tool",
								source: {
									kind: "tool",
									callId: "c2"
								},
								toolCallId: "c2",
								content: [{
									type: "text",
									text: "old string not found"
								}],
								isError: true
							}
						}
					},
					{
						type: "assistant/message",
						seq: 10,
						time: now - 9e4,
						data: {
							turn: 1,
							step: 2,
							message: {
								role: "assistant",
								content: [{
									type: "text",
									text: "已修复:空表单时 `form` 为 null 导致崩溃。我把 `form.validate()` 改成了空安全的 `form?.validate()`,并在提交前加了空值检查。现在空表单提交会显示提示而不是崩溃。"
								}]
							},
							usage: {
								inputTokens: 1840,
								outputTokens: 96
							}
						}
					},
					{
						type: "workspace/changes",
						seq: 11,
						time: now - 89500,
						data: { turn: 1 }
					},
					{
						type: "turn/end",
						seq: 12,
						time: now - 89e3,
						data: {
							turn: 1,
							reason: { kind: "completed" }
						}
					}
				], 12, false, sinceSeq);
				this.sendTo(client, {
					type: "session_state",
					sessionId: sid,
					running: false,
					status: "completed"
				});
				this.replayPendingInteractions(client);
				return;
			}
			case "history_page":
				this.sendTo(client, {
					type: "session_snapshot",
					sessionId: msg.sessionId,
					events: [],
					lastSeq: 99,
					hasMore: false
				});
				this.ack(client, msg.reqId, true);
				return;
			case "work_send": {
				const sid = msg.sessionId;
				if (typeof msg.text === "string" && msg.text.trimStart().startsWith("/")) {
					const token = msg.text.trim().slice(1).split(/\s/, 1)[0] ?? "";
					const cid = "mock-cmd-" + Date.now();
					this.forward(sid, {
						type: "session_event",
						sessionId: sid,
						event: {
							type: "command/run",
							seq: -1,
							time: Date.now(),
							data: {
								commandId: cid,
								name: token,
								source: { kind: "user" }
							}
						}
					});
					this.ack(client, msg.reqId, true, void 0, {
						requestId: msg.requestId,
						command: {
							commandId: cid,
							kind: "success",
							text: "(mock) 命令已执行: /" + token
						}
					});
					this.forward(sid, {
						type: "session_event",
						sessionId: sid,
						event: {
							type: "command/done",
							seq: -1,
							time: Date.now(),
							data: {
								commandId: cid,
								kind: "success",
								text: "(mock) 命令已执行: /" + token
							}
						}
					});
					return;
				}
				this.ack(client, msg.reqId, true, void 0, { requestId: msg.requestId });
				this.forward(sid, {
					type: "session_event",
					sessionId: sid,
					event: {
						type: "user/message",
						seq: -1,
						time: Date.now(),
						data: { message: {
							role: "user",
							content: [{
								type: "text",
								text: msg.text
							}],
							source: {
								kind: "user",
								rpcId: msg.requestId
							}
						} }
					}
				});
				this.forward(sid, {
					type: "session_state",
					sessionId: sid,
					running: true
				});
				this.forward(sid, {
					type: "stream_frame",
					sessionId: sid,
					frame: {
						type: "start",
						attemptId: "mock",
						revision: 1,
						turn: 2,
						step: 1
					}
				});
				const reply = `收到「${msg.text.slice(0, 40)}」。这是 mock 模式的流式回复,用来验证手机端的流式渲染、光标动画与折叠交互。包含 \`code span\` 与多行文本。`;
				const prevStream = this.mockStreams.get(sid);
				if (prevStream) {
					clearInterval(prevStream);
					this.mockStreams.delete(sid);
				}
				let i = 0;
				const timer = setInterval(() => {
					if (i >= reply.length) {
						clearInterval(timer);
						this.mockStreams.delete(sid);
						this.forward(sid, {
							type: "stream_frame",
							sessionId: sid,
							frame: {
								type: "end",
								attemptId: "mock",
								revision: 1,
								index: reply.length,
								outcome: {
									kind: "committed",
									eventType: "assistant/message",
									seq: 99
								}
							}
						});
						this.forward(sid, {
							type: "session_event",
							sessionId: sid,
							event: {
								type: "assistant/message",
								seq: 99,
								time: Date.now(),
								data: {
									turn: 2,
									step: 1,
									message: {
										role: "assistant",
										content: [{
											type: "text",
											text: reply
										}]
									},
									usage: {
										inputTokens: 2100,
										outputTokens: reply.length
									}
								}
							}
						});
						this.forward(sid, {
							type: "session_state",
							sessionId: sid,
							running: false,
							status: "completed"
						});
						return;
					}
					const step = Math.min(3 + Math.floor(Math.random() * 6), reply.length - i);
					const piece = reply.slice(i, i + step);
					i += step;
					this.forward(sid, {
						type: "stream_frame",
						sessionId: sid,
						frame: {
							type: "chunk",
							attemptId: "mock",
							revision: 1,
							index: i,
							time: Date.now(),
							chunk: {
								type: "text-delta",
								text: piece
							}
						}
					});
				}, 90);
				this.mockStreams.set(sid, timer);
				return;
			}
			case "work_cancel": {
				this.ack(client, msg.reqId, true);
				const t = this.mockStreams.get(msg.sessionId);
				if (t) {
					clearInterval(t);
					this.mockStreams.delete(msg.sessionId);
					this.forward(msg.sessionId, {
						type: "stream_frame",
						sessionId: msg.sessionId,
						frame: {
							type: "end",
							attemptId: "mock",
							revision: 1,
							index: 0,
							outcome: { kind: "abandoned" }
						}
					});
					this.forward(msg.sessionId, {
						type: "session_state",
						sessionId: msg.sessionId,
						running: false,
						status: "interrupted"
					});
				}
				return;
			}
			case "commands_list":
				this.ack(client, msg.reqId, true, void 0, { commands: [
					{
						name: "goal",
						description: "Set or review the session goal",
						aliases: ["goal", "目标"]
					},
					{
						name: "plan",
						description: "Enter plan mode",
						aliases: ["plan", "计划"]
					},
					{
						name: "feedback",
						description: "Send feedback about the harness",
						aliases: ["feedback", "反馈"]
					},
					{
						name: "compact",
						description: "Compact the session context",
						aliases: ["compact", "压缩"]
					},
					{
						name: "permission",
						description: "Switch permission presets",
						aliases: ["permission", "权限"]
					},
					{
						name: "export",
						description: "Export the session log",
						aliases: ["export", "导出"]
					}
				] });
				return;
			case "mention_query": {
				const q = String(msg.query ?? "");
				this.ack(client, msg.reqId, true, void 0, {
					files: [
						{
							path: "lib/main.dart",
							kind: "file"
						},
						{
							path: "lib/core/api.dart",
							kind: "file"
						},
						{
							path: "packages",
							kind: "directory"
						},
						{
							path: "docs/protocol.md",
							kind: "file"
						}
					].filter((f) => q === "" || f.path.includes(q)),
					sessions: [{
						label: "演示会话A",
						mention: "@[演示会话A](dsh-session:bW9jay1h)"
					}, {
						label: "演示会话B",
						mention: "@[演示会话B](dsh-session:bW9jay1i)"
					}].filter((s) => q === "" || s.label.includes(q))
				});
				return;
			}
			case "model_catalog_req":
				this.ack(client, msg.reqId, true, void 0, {
					default: {
						provider: "deepseek-official",
						model: "deepseek-flash",
						reasoningEffort: "high"
					},
					routableProviders: ["deepseek-official", "zai-coding-cn"],
					groups: [{
						id: "deepseek-official",
						name: "DeepSeek",
						models: [{
							id: "deepseek-flash",
							name: "DeepSeek-V4.1-Flash",
							reasoning: {
								efforts: [
									{
										id: "off",
										name: "Off"
									},
									{
										id: "low",
										name: "Low"
									},
									{
										id: "high",
										name: "High",
										description: "默认平衡"
									},
									{
										id: "max",
										name: "Max"
									}
								],
								defaultEffort: "high"
							}
						}, {
							id: "deepseek-v4-pro",
							name: "DeepSeek-V4-Pro",
							description: "更强代理编码与复杂推理",
							reasoning: {
								efforts: [{
									id: "high",
									name: "High"
								}],
								defaultEffort: "high"
							}
						}]
					}, {
						id: "zai-coding-cn",
						name: "Zhipu",
						models: [{
							id: "glm-5.3-flash",
							name: "GLM-5.3-Flash",
							reasoning: {
								efforts: [],
								defaultEffort: null
							}
						}]
					}],
					failures: []
				});
				return;
			case "work_select_model":
				this.ack(client, msg.reqId, true, void 0, { selected: {
					provider: msg.provider,
					model: msg.model,
					...msg.reasoningEffort ? { reasoningEffort: msg.reasoningEffort } : {}
				} });
				return;
			case "file_list": {
				const dir = msg.path === "." ? "" : `${msg.path}/`;
				this.ack(client, msg.reqId, true, void 0, {
					path: msg.path,
					entries: [
						{
							name: "lib",
							type: "directory"
						},
						{
							name: "assets",
							type: "directory"
						},
						{
							name: "README.md",
							type: "file",
							size: 2048
						},
						{
							name: "main.dart",
							type: "file",
							size: 12340
						}
					].map((e) => ({
						...e,
						name: dir === "" ? e.name : e.name
					}))
				});
				return;
			}
			case "file_read":
				this.ack(client, msg.reqId, true, void 0, {
					path: msg.path,
					offset: 0,
					bytesRead: 64,
					totalSize: 64,
					eof: true,
					dataBase64: Buffer.from(`# ${msg.path}\n\n这是 mock 模式的文件预览内容。\nLine 3\nLine 4\n`, "utf8").toString("base64")
				});
				return;
			case "changes_summary":
				this.ack(client, msg.reqId, true, void 0, {
					turn: 1,
					cwd: "C:\\demo\\lens-app",
					files: [{
						path: "lib/login.dart",
						display: "lib/login.dart",
						added: 24,
						deleted: 3
					}],
					total: 1,
					added: 24,
					deleted: 3
				});
				return;
			case "approval_answer":
			case "question_answer":
				this.ack(client, msg.reqId, true);
				this.forward(msg.sessionId, {
					type: "approval_resolved",
					sessionId: msg.sessionId,
					id: String(msg.id ?? ""),
					outcome: msg.type === "approval_answer" ? String(msg.outcome ?? "") : "answered"
				});
				return;
			default: return;
		}
	}
	requireController() {
		this.probeSessionController();
		return this.sc;
	}
	/**
	* Wait (≤5s) for the host's sessionController to mount — phone-lens loads
	* before the API controllers on some boots, and a request landing inside
	* that window must not hard-fail ("服务不可用") when waiting one beat fixes it.
	* A probe loop that ends WITHOUT the controller is cached for
	* CONTROLLER_PROBE_TTL_MS: every 5s poll/list used to re-spin a full 5s
	* probe loop against a host that simply lacks the controller (H16).
	*/
	async awaitController(timeoutMs = 5e3) {
		if (Date.now() - this.controllerProbeFailedAt < WorkBridge.CONTROLLER_PROBE_TTL_MS) return null;
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			this.probeSessionController();
			if (this.sc) return this.sc;
			if (Date.now() >= deadline) {
				this.controllerProbeFailedAt = Date.now();
				return null;
			}
			await new Promise((r) => setTimeout(r, 250));
		}
	}
	extractItems(result) {
		if (Array.isArray(result)) return result;
		if (result && typeof result === "object") for (const key of [
			"items",
			"sessions",
			"list"
		]) {
			const v = result[key];
			if (Array.isArray(v)) return v;
		}
		return [];
	}
	async pushSessionList() {
		if (!this.enabled() || this.clients.size === 0) return;
		const sc = await this.awaitController();
		if (!sc || typeof sc.list !== "function") {
			this.logOnce("sessionController.list unavailable");
			return;
		}
		try {
			const result = await sc.list();
			const archived = await this.archivedSessionIds();
			const sessions = this.extractItems(result).filter((it) => it?.origin !== "subagent").map((it) => {
				const sid = String(it?.sessionId ?? it?.id ?? "");
				if (!sid) return null;
				const cwd = typeof it?.cwd === "string" && it.cwd ? it.cwd : void 0;
				if (cwd) this.cwdCache.set(sid, cwd);
				const pTitle = it?.projections?.values?.title;
				const title = typeof pTitle === "string" && pTitle.trim() ? pTitle.trim() : void 0;
				return {
					sessionId: sid,
					...title !== void 0 ? { title } : {},
					...it?.updatedAt !== void 0 ? { updatedAt: Number(it.updatedAt) || 0 } : {},
					...it?.running !== void 0 ? { running: !!it.running } : {},
					...it?.blank !== void 0 ? { blank: !!it.blank } : {},
					...cwd !== void 0 ? { cwd } : {}
				};
			}).filter((s) => !!s).filter((s) => !archived?.has(s.sessionId));
			await this.enrichSessionMeta(sessions);
			this.broadcast({
				type: "session_list",
				sessions
			});
		} catch (error) {
			this.log("warn", `work: session list failed: ${String(error)}`);
		}
	}
	archivedProbeLogged = false;
	/**
	* Best-effort archived-session set. Archival is registry-global (workspace
	* domain state), NOT a SessionSummary field — the desktop workspace tree
	* partitions on it and hides archived rows by default, and the phone must
	* match. The workspace controller's service name is build-dependent: probe
	* a few candidates; failure only means no filtering (logged once so the
	* name can be calibrated from boot.log).
	*/
	/**
	* Workspace-domain service candidates (the desktop's ownership ledger).
	* Was three hand-rolled candidate lists that drifted apart (lane-10 L7:
	* archived-set probe / create-cwd mapping / archive-unarchive each had
	* their own, in different orders); callers filter by the method they need.
	*/
	workspaceServiceCandidates() {
		const ctx = this.ctx;
		const found = [];
		for (const name of [
			"workspaceController",
			"workspaceRegistry",
			"workspace",
			"apiWorkspaceController",
			"workspaces"
		]) try {
			const svc = typeof ctx.get === "function" ? ctx.get(name) : void 0;
			if (svc && typeof svc === "object") found.push(svc);
		} catch {}
		return found;
	}
	async archivedSessionIds() {
		for (const svc of this.workspaceServiceCandidates()) try {
			for (const m of [
				"getState",
				"domainState",
				"state"
			]) {
				if (typeof svc[m] !== "function") continue;
				let st;
				try {
					st = await svc[m]();
				} catch {
					st = await svc[m](AbortSignal.timeout(8e3));
				}
				const ids = st?.archivedSessionIds ?? st?.state?.archivedSessionIds;
				if (Array.isArray(ids)) return new Set(ids.map(String));
			}
			if (Array.isArray(svc.archivedSessionIds)) return new Set(svc.archivedSessionIds.map(String));
		} catch {}
		if (!this.archivedProbeLogged) {
			this.archivedProbeLogged = true;
			this.log("info", "work: archived-session set unavailable — archived sessions will list (calibrate workspace service name from this log)");
		}
		return null;
	}
	scheduleSessionListRefresh() {
		if (this.sessionListTimer || !this.enabled()) return;
		this.sessionListTimer = setTimeout(() => {
			this.sessionListTimer = null;
			this.pushSessionList();
		}, SESSION_LIST_DEBOUNCE_MS);
	}
	/**
	* Read a session's event history. Signature verified against the host's
	* typert schema (0.2.2-rc.1): events(args, signal) → {cursor, records:
	* [{type:'event', event: SessionWireEvent}], hasMore}.
	*/
	async readHistory(sessionId, beforeSeq, maxMessages) {
		const sc = await this.awaitController();
		if (!sc || typeof sc.events !== "function") return { error: "sessionController.events unavailable on this host" };
		try {
			const r = await sc.events({
				address: {
					kind: "session",
					sessionId
				},
				...beforeSeq !== void 0 ? { beforeSeq } : {},
				maxMessages
			}, AbortSignal.timeout(3e4));
			const rec = r ?? {};
			const rows = Array.isArray(rec.records) ? rec.records : [];
			return {
				events: filterEvents(rows.map((x) => x?.event ?? x)),
				hasMore: !!rec.hasMore
			};
		} catch (error) {
			return { error: String(error) };
		}
	}
	async pushSnapshot(client, sessionId, sinceSeq) {
		const sq = this.sessionQueryService();
		if (sq && typeof sq.readSession === "function") try {
			const full = await sq.readSession(sessionId, AbortSignal.timeout(6e4));
			const meta = full?.session ?? {};
			if (typeof meta.cwd === "string" && meta.cwd) this.cwdCache.set(sessionId, meta.cwd);
			const rawEvents = Array.isArray(full?.events) ? full.events : [];
			const lastSeq$1 = rawEvents.length > 0 ? Number(rawEvents[rawEvents.length - 1]?.seq ?? 0) : 0;
			this.sendSnapshot(client, sessionId, filterEvents(rawEvents), lastSeq$1, false, sinceSeq);
			return;
		} catch (error) {
			this.logOnce(`readSession failed: ${String(error).slice(0, 200)}`);
		}
		const r = await this.readHistory(sessionId, void 0, 200);
		if ("error" in r) {
			this.logOnce(`history read failed: ${r.error.slice(0, 200)}`);
			this.sendSnapshot(client, sessionId, [], 0, false, sinceSeq);
			return;
		}
		const lastSeq = r.events.length > 0 ? Number(r.events[r.events.length - 1]?.seq ?? 0) : 0;
		this.sendSnapshot(client, sessionId, r.events, lastSeq, r.hasMore, sinceSeq);
	}
	/**
	* Serialize one snapshot baseline through the shared guards:
	* - H7 race guard: the phone may have re-subscribed elsewhere while the
	*   60s readSession was in flight — per-session seq spaces overlap
	*   STRUCTURALLY (both start at 0, recheck-3), so a stale baseline would
	*   poison the new session's timeline. Drop when the subscription moved.
	* - H8/contract 3: with sinceSeq only seq > sinceSeq rides along (a
	*   re-subscribing phone already holds the older rows; omitting = full).
	* - H9: an >8MB baseline splits into several session_snapshot frames cut
	*   on EVENT boundaries (the App merges by seq; a single event — measured
	*   up to ~1.1MB — is never byte-cut).
	*/
	sendSnapshot(client, sessionId, events, lastSeq, hasMore, sinceSeq) {
		if (client.sessionId !== sessionId) return;
		const filtered = sinceSeq !== void 0 && sinceSeq > 0 ? events.filter((e) => Number(e?.seq ?? 0) > sinceSeq) : events;
		const frames = [];
		let current = [];
		let size = 0;
		for (const ev of filtered) {
			let evSize = 0;
			try {
				evSize = JSON.stringify(ev).length;
			} catch {
				evSize = 4096;
			}
			if (current.length > 0 && size + evSize > WorkBridge.SNAPSHOT_CHUNK_BYTES) {
				frames.push(current);
				current = [];
				size = 0;
			}
			current.push(ev);
			size += evSize;
		}
		if (current.length > 0) frames.push(current);
		if (frames.length > 1) this.log("info", `work snapshot split into ${frames.length} frames (sid ${sessionId.slice(0, 8)})`);
		for (const slice of frames.length > 0 ? frames : [[]]) {
			if (client.sessionId !== sessionId) return;
			this.sendTo(client, {
				type: "session_snapshot",
				sessionId,
				events: slice,
				lastSeq,
				hasMore
			});
		}
	}
	sessionQueryService() {
		try {
			const ctx = this.ctx;
			return typeof ctx.get === "function" ? ctx.get("sessionQuery") : void 0;
		} catch {
			return void 0;
		}
	}
	async handleHistoryPage(client, msg) {
		const r = await this.readHistory(msg.sessionId, msg.beforeSeq, Math.min(msg.maxMessages ?? 60, 300));
		if ("error" in r) {
			this.ack(client, msg.reqId, false, `历史读取失败: ${r.error.slice(0, 120)}`);
			return;
		}
		const sinceSeq = typeof msg.sinceSeq === "number" && Number.isFinite(msg.sinceSeq) && msg.sinceSeq > 0 ? msg.sinceSeq : void 0;
		const events = sinceSeq !== void 0 ? r.events.filter((e) => Number(e?.seq ?? 0) > sinceSeq) : r.events;
		const lastSeq = events.length > 0 ? Number(events[events.length - 1]?.seq ?? 0) : 0;
		if (client.sessionId !== msg.sessionId) return;
		this.sendTo(client, {
			type: "session_snapshot",
			sessionId: msg.sessionId,
			events,
			lastSeq,
			hasMore: r.hasMore
		});
		this.ack(client, msg.reqId, true);
	}
	async handleSend(client, msg) {
		if (!this.enabled()) return this.ack(client, msg.reqId, false, "工作(Beta)已关闭");
		if ((await this.archivedSessionIds())?.has(msg.sessionId)) return this.ack(client, msg.reqId, false, "该会话已在电脑端归档，无法继续对话");
		const text = typeof msg.text === "string" ? msg.text : "";
		const requestId = typeof msg.requestId === "string" && msg.requestId ? msg.requestId : randomUUID();
		const images = (Array.isArray(msg.images) ? msg.images : []).filter((i) => !!i && typeof i.mediaType === "string" && typeof i.data === "string" && i.data.length > 0);
		if (!text.trim() && images.length === 0) return this.ack(client, msg.reqId, false, "消息为空");
		const trimmed = text.trimStart();
		if (trimmed.startsWith("/")) return this.handleSendCommand(client, msg, requestId, trimmed);
		const sc = await this.awaitController();
		if (!sc || typeof sc.prompt !== "function") return this.ack(client, msg.reqId, false, "宿主会话服务不可用");
		const mode = msg.mode === "steer" ? "steer" : "queue";
		const content = [];
		if (text.trim()) content.push({
			type: "text",
			text
		});
		for (const img of images) content.push({
			type: "image",
			mediaType: img.mediaType,
			data: img.data,
			...img.name ? { name: img.name } : {}
		});
		try {
			await sc.prompt({
				requestId,
				sessionId: msg.sessionId,
				mode,
				content,
				clientTimeZone: "Asia/Shanghai"
			}, AbortSignal.timeout(6e4));
			this.log("info", `work send → session ${msg.sessionId.slice(0, 8)} (${mode}${images.length ? ` +${images.length}img` : ""}, id ${requestId.slice(0, 8)})`);
			return this.ack(client, msg.reqId, true, void 0, { requestId });
		} catch (error) {
			const lastError = String(error);
			this.log("warn", `work send failed: ${lastError.slice(0, 200)}`);
			return this.ack(client, msg.reqId, false, `发送失败: ${lastError.slice(0, 160)}`, { requestId });
		}
	}
	/**
	* Dispatch a `/name args` line through the host's CommandRuntime instead of
	* prompt(). No requestId idempotency exists on this path (the host mints its
	* own commandId), so the phone deliberately does not auto-retry commands.
	*/
	async handleSendCommand(client, msg, requestId, trimmed) {
		const commands = this.commandsService();
		const token = trimmed.slice(1).split(/\s/, 1)[0] ?? "";
		if (!token) return this.ack(client, msg.reqId, false, "命令为空(输入 / 查看可用命令)");
		const agent = this.resolveAgent(msg.sessionId);
		if (!commands || typeof commands.execute !== "function" || !agent) return this.ack(client, msg.reqId, false, "宿主命令服务不可用(会话可能已结束)", { requestId });
		let descriptors = [];
		if (typeof commands.list === "function") try {
			const listed = await commands.list(agent);
			if (Array.isArray(listed)) descriptors = listed;
		} catch (error) {
			this.logOnce(`commands.list failed: ${String(error).slice(0, 160)}`);
		}
		const cmd = resolveCommandToken(token, descriptors);
		if (!cmd || typeof cmd.name !== "string") return this.ack(client, msg.reqId, false, `未知命令: /${token}(输入 / 查看可用命令)`, { requestId });
		const rawInput = trimmed.slice(1 + token.length);
		const line = `/${cmd.name}${rawInput}`;
		try {
			const exec = await commands.execute(agent, line, [], AbortSignal.timeout(9e4));
			if (!exec) return this.ack(client, msg.reqId, false, `命令未能执行: /${token}`, { requestId });
			const result = exec?.result ?? {};
			this.log("info", `work command /${cmd.name} → ${String(result.kind)} (cid ${String(exec.commandId ?? "?").slice(0, 8)})`);
			return this.ack(client, msg.reqId, true, void 0, {
				requestId,
				command: {
					commandId: typeof exec.commandId === "string" ? exec.commandId : "",
					kind: result.kind === "error" ? "error" : "success",
					text: typeof result.text === "string" ? result.text.slice(0, 2e3) : void 0
				}
			});
		} catch (error) {
			const lastError = String(error);
			this.log("warn", `work command /${cmd.name} failed: ${lastError.slice(0, 200)}`);
			return this.ack(client, msg.reqId, false, `命令执行失败: ${lastError.slice(0, 160)}`, { requestId });
		}
	}
	/** Host CommandRuntime service (cordis `commands`), or null when absent. */
	commandsService() {
		try {
			const svc = this.ctx.get?.("commands");
			return svc && typeof svc === "object" ? svc : null;
		} catch {
			return null;
		}
	}
	/** Resolve the Agent object behind a session id (null on cold/unknown). */
	resolveAgent(sessionId) {
		try {
			const agents = this.ctx.get?.("agents");
			const agent = agents?.get?.(sessionId);
			return agent ?? null;
		} catch {
			return null;
		}
	}
	/** Slash-command directory for the phone composer's popup. */
	async handleCommandsList(client, msg) {
		const svc = this.commandsService();
		let descriptors = [];
		if (svc && typeof svc.list === "function") {
			const agent = this.resolveAgent(msg.sessionId ?? "");
			try {
				const listed = await svc.list(agent);
				if (Array.isArray(listed)) descriptors = listed;
			} catch (error) {
				this.logOnce(`commands.list failed: ${String(error).slice(0, 160)}`);
			}
		}
		const commands = descriptors.filter((d) => typeof d?.name === "string" && d.name).map((d) => ({
			name: String(d.name),
			description: typeof d?.description === "string" ? d.description : void 0,
			aliases: commandAliases(d),
			attachments: d?.input?.attachments === true,
			hint: typeof d?.input?.hint === "string" ? d.input.hint : void 0
		}));
		const payload = commands.length > 0 ? commands : FALLBACK_COMMANDS;
		return this.ack(client, msg.reqId, true, void 0, { commands: payload });
	}
	/** @-mention candidates: cwd files/dirs + referenced sessions, in parallel. */
	async handleMentionQuery(client, msg) {
		const agent = this.resolveAgent(msg.sessionId ?? "");
		if (!agent) return this.ack(client, msg.reqId, false, "尚未连接该会话(请先进入会话)");
		const query = typeof msg.query === "string" ? msg.query : "";
		const readFiles = async () => {
			const svc = this.ctx.get?.("fileReferences");
			if (!svc || typeof svc.list !== "function") return [];
			const rows = await svc.list(agent, query, AbortSignal.timeout(8e3));
			const files$1 = Array.isArray(rows) ? rows : [];
			return files$1.filter((f) => typeof f?.path === "string" && f.path).slice(0, 12).map((f) => ({
				path: String(f.path),
				kind: f.kind === "directory" ? "directory" : "file"
			}));
		};
		const readSessions = async () => {
			const svc = this.ctx.get?.("sessionReferenceResolver");
			if (!svc || typeof svc.candidates !== "function") return [];
			const rows = await svc.candidates(agent, query, AbortSignal.timeout(8e3));
			const sessions$1 = Array.isArray(rows) ? rows : [];
			return sessions$1.filter((s) => typeof s?.mention === "string" && s.mention).slice(0, 6).map((s) => ({
				label: String(s?.label ?? s?.displayTitle ?? "会话"),
				title: typeof s?.title === "string" ? s.title : void 0,
				mention: String(s.mention)
			}));
		};
		const [files, sessions] = await Promise.all([readFiles().catch(() => []), readSessions().catch(() => [])]);
		return this.ack(client, msg.reqId, true, void 0, {
			files,
			sessions
		});
	}
	async handleCancel(client, msg) {
		if (!this.enabled()) return this.ack(client, msg.reqId, false, "工作(Beta)已关闭");
		const sc = await this.awaitController();
		if (!sc || typeof sc.cancel !== "function") return this.ack(client, msg.reqId, false, "宿主会话服务不可用");
		try {
			await sc.cancel({ sessionId: msg.sessionId }, AbortSignal.timeout(15e3));
			this.log("info", `work cancel → session ${msg.sessionId.slice(0, 8)}`);
			return this.ack(client, msg.reqId, true);
		} catch (error) {
			const lastError = String(error);
			this.log("warn", `work cancel failed: ${lastError.slice(0, 200)}`);
			return this.ack(client, msg.reqId, false, `停止失败: ${lastError.slice(0, 120)}`);
		}
	}
	/**
	* Mint a blank session for the phone's workspace-group "+" button. cwd XOR
	* workspaceId (dsh rejects both); with neither, dsh uses its defaultCwd.
	* Without sessionId dsh always mints a brand-new `session-{uuid}` — the
	* phone disables the button per request to avoid double-tap piling blanks.
	* List refresh rides the existing agent/created → scheduleSessionListRefresh
	* route; the ack also carries sessionId so the phone can subscribe directly.
	*/
	async handleSessionCreate(client, msg) {
		if (!this.enabled()) return this.ack(client, msg.reqId, false, "工作(Beta)已关闭");
		const sc = await this.awaitController();
		if (!sc || typeof sc.create !== "function") return this.ack(client, msg.reqId, false, "宿主会话服务不可用");
		if (msg.cwd && msg.workspaceId) return this.ack(client, msg.reqId, false, "cwd 与 workspaceId 只能传其一");
		const request = {};
		if (msg.cwd) {
			const wsId = await this.resolveWorkspaceId(msg.cwd);
			if (wsId) request.workspaceId = wsId;
			else request.cwd = msg.cwd;
		}
		if (msg.workspaceId) request.workspaceId = msg.workspaceId;
		try {
			const created = await sc.create(request, AbortSignal.timeout(15e3));
			const sessionId = typeof created?.sessionId === "string" ? created.sessionId : "";
			if (!sessionId) return this.ack(client, msg.reqId, false, "宿主未返回会话 id");
			this.log("info", `work create → session ${sessionId.slice(0, 8)} (cwd=${msg.cwd ? "yes" : msg.workspaceId ? "ws" : "default"})`);
			this.scheduleSessionListRefresh();
			return this.ack(client, msg.reqId, true, void 0, { sessionId });
		} catch (error) {
			const lastError = String(error);
			this.log("warn", `work create failed: ${lastError.slice(0, 200)}`);
			return this.ack(client, msg.reqId, false, `新建会话失败: ${lastError.slice(0, 120)}`);
		}
	}
	/**
	* Map an absolute cwd to a REGISTERED workspace id (the desktop's ownership
	* ledger — dsh-workspace workspaceRegistry). Path comparison normalizes
	* slashes/case (Windows realpath vs session header shapes); null = no
	* registered workspace covers this cwd.
	*/
	async resolveWorkspaceId(cwd) {
		const norm = (p) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
		const target = norm(cwd);
		if (!target) return null;
		for (const svc of this.workspaceServiceCandidates()) try {
			if (typeof svc.list !== "function") continue;
			const rows = await svc.list(AbortSignal.timeout(5e3));
			if (!Array.isArray(rows)) continue;
			for (const r of rows) if (r && typeof r.path === "string" && r.id !== void 0 && r.id !== null && norm(r.path) === target) return String(r.id);
		} catch {}
		this.logOnce("work calibration: no registered workspace matched create cwd (session falls back to bare cwd)");
		return null;
	}
	/**
	* Desktop turn-tail fork parity: duplicate the session prefix up to and
	* INCLUDING atSeq into a new session, then best-effort rename the child to
	* the incremented source title ("标题 (1)" → "标题 (2)", plain titles get
	* " (1)" appended — client-side behavior on the desktop, service.ts:476).
	* The child inherits the source cwd; its model is the GLOBAL default (host
	* semantics, not the source's). ack data = { sessionId }.
	*/
	async handleSessionFork(client, msg) {
		if (!this.enabled()) return this.ack(client, msg.reqId, false, "工作(Beta)已关闭");
		const sc = await this.awaitController();
		if (!sc || typeof sc.fork !== "function") return this.ack(client, msg.reqId, false, "宿主会话服务不可用");
		try {
			const created = await sc.fork({
				sessionId: msg.sessionId,
				...msg.atSeq !== void 0 ? { atSeq: msg.atSeq } : {}
			}, AbortSignal.timeout(3e4));
			const childId = typeof created?.sessionId === "string" ? created.sessionId : "";
			if (!childId) return this.ack(client, msg.reqId, false, "宿主未返回分叉会话 id");
			if (msg.title && msg.title.trim() !== "" && typeof sc.rename === "function") try {
				const base = msg.title.trim();
				const taken = await this.existingSessionTitles() ?? new Set();
				const next = this.nextForkTitle(base, taken);
				await sc.rename({
					sessionId: childId,
					title: next
				}, AbortSignal.timeout(1e4));
			} catch (error) {
				this.log("warn", `work fork rename skipped: ${String(error).slice(0, 120)}`);
			}
			this.log("info", `work fork → child ${childId.slice(0, 16)} (at ${msg.atSeq ?? "latest"})`);
			this.scheduleSessionListRefresh();
			return this.ack(client, msg.reqId, true, void 0, { sessionId: childId });
		} catch (error) {
			const lastError = String(error);
			this.log("warn", `work fork failed: ${lastError.slice(0, 200)}`);
			return this.ack(client, msg.reqId, false, `分叉失败: ${lastError.slice(0, 140)}`);
		}
	}
	/**
	* Desktop increasedForkTitle parity: bump the "(N)" tail (half- AND
	* full-width brackets, BigInt like the desktop) and loop to a free slot.
	* taken unreadable → a single bump still applies (old behavior).
	*/
	nextForkTitle(base, taken) {
		const bump = (t) => {
			const half = /^(.*?)\((\d+)\)$/.exec(t);
			if (half) return `${half[1] ?? ""}(${BigInt(half[2] ?? "0") + 1n})`;
			const full = /^(.*?)（(\d+)）$/.exec(t);
			if (full) return `${full[1] ?? ""}（${BigInt(full[2] ?? "0") + 1n}）`;
			return `${t} (1)`;
		};
		let next = bump(base);
		while (taken.has(next)) next = bump(next);
		return next;
	}
	/** Existing display titles (projections.values.title — the same source the
	*  list broadcast uses) for fork-rename avoidance; null = list unreadable. */
	async existingSessionTitles() {
		const sc = await this.awaitController(3e3);
		if (!sc || typeof sc.list !== "function") return null;
		try {
			const items = this.extractItems(await sc.list());
			const taken = new Set();
			for (const it of items) {
				const t = it?.projections?.values?.title;
				if (typeof t === "string" && t.trim()) taken.add(t.trim());
			}
			return taken;
		} catch {
			return null;
		}
	}
	/**
	* Archive / unarchive via the workspaceController (the desktop's list
	* context-menu channel). Archiving a RUNNING session without stopActivity
	* is rejected by the host (workspace/session-active) — the error text rides
	* the ack reason to the phone. ack data = { archivedSessionIds }.
	*/
	async handleSessionArchive(client, msg) {
		if (!this.enabled()) return this.ack(client, msg.reqId, false, "工作(Beta)已关闭");
		const method = msg.unarchive === true ? "unarchiveSession" : "archiveSession";
		let svc = null;
		for (const candidate of this.workspaceServiceCandidates()) if (typeof candidate[method] === "function") {
			svc = candidate;
			break;
		}
		if (!svc) {
			this.logOnce("work calibration: workspace archive service unavailable");
			return this.ack(client, msg.reqId, false, "宿主无归档服务");
		}
		try {
			const request = msg.unarchive === true ? { sessionId: msg.sessionId } : {
				sessionId: msg.sessionId,
				...msg.stopActivity === true ? { stopActivity: true } : {}
			};
			const result = await svc[method](request, AbortSignal.timeout(15e3));
			this.log("info", `work ${method} → ${msg.sessionId.slice(0, 16)}`);
			if (msg.unarchive === true) this.forward(msg.sessionId, {
				type: "session_unarchived",
				sessionId: msg.sessionId
			});
			else this.forward(msg.sessionId, {
				type: "session_archived",
				sessionId: msg.sessionId
			});
			this.pendingApprovals.delete(msg.sessionId);
			this.scheduleSessionListRefresh();
			return this.ack(client, msg.reqId, true, void 0, { archivedSessionIds: Array.isArray(result?.archivedSessionIds) ? result.archivedSessionIds : [] });
		} catch (error) {
			const lastError = String(error);
			this.log("warn", `work ${method} failed: ${lastError.slice(0, 200)}`);
			return this.ack(client, msg.reqId, false, `归档失败: ${lastError.slice(0, 140)}`);
		}
	}
	async handleModelCatalog(client, msg) {
		const sc = await this.awaitController();
		if (!sc || typeof sc.modelCatalog !== "function") return this.ack(client, msg.reqId, false, "宿主模型服务不可用");
		const attempts = [() => sc.modelCatalog(), () => sc.modelCatalog({})];
		let lastError = "";
		for (const attempt of attempts) try {
			const r = await attempt();
			return this.ack(client, msg.reqId, true, void 0, r);
		} catch (error) {
			lastError = String(error);
		}
		this.log("warn", `work model catalog failed: ${lastError.slice(0, 200)}`);
		this.ack(client, msg.reqId, false, `模型目录读取失败: ${lastError.slice(0, 120)}`);
	}
	async handleSelectModel(client, msg) {
		const sc = await this.awaitController();
		if (!sc || typeof sc.selectModel !== "function") return this.ack(client, msg.reqId, false, "宿主模型服务不可用");
		const sel = {
			sessionId: msg.sessionId,
			provider: msg.provider,
			model: msg.model,
			...msg.reasoningEffort ? { reasoningEffort: msg.reasoningEffort } : {}
		};
		try {
			const r = await sc.selectModel(sel, AbortSignal.timeout(15e3));
			this.log("info", `work select-model → ${msg.provider}/${msg.model}`);
			let catalog;
			try {
				catalog = await sc.modelCatalog();
			} catch {}
			this.forward(msg.sessionId, {
				type: "model_changed",
				sessionId: msg.sessionId,
				provider: msg.provider,
				model: msg.model,
				...msg.reasoningEffort ? { reasoningEffort: msg.reasoningEffort } : {}
			});
			return this.ack(client, msg.reqId, true, void 0, {
				selected: r?.selected,
				catalog
			});
		} catch (error) {
			const lastError = String(error);
			this.log("warn", `work select-model failed: ${lastError.slice(0, 200)}`);
			return this.ack(client, msg.reqId, false, `切换失败: ${lastError.slice(0, 120)}`);
		}
	}
	/**
	* Best-effort titles: for the N most recent sessions pull the projections
	* once and use the latest turn prompt as the display title (+ cache the
	* working directory for the file panel). Projections are read-only and do
	* not resume cold sessions; failures just leave the row title-less.
	*/
	async enrichSessionMeta(sessions) {
		const sc = await this.awaitController();
		if (!sc || typeof sc.projections !== "function") return;
		const recent = sessions.filter((s) => !s.title).slice(0, 12);
		await Promise.allSettled(recent.map(async (s) => {
			const p = await sc.projections({ sessionId: s.sessionId }, AbortSignal.timeout(1e4));
			const values = p?.values ?? p?.projection?.values ?? {};
			const wd = values?.workingDirectory ?? values?.workspace?.workingDirectory;
			if (typeof wd === "string" && wd) this.cwdCache.set(s.sessionId, wd);
			const outline = Array.isArray(values?.turnOutline) ? values.turnOutline : [];
			for (let i = outline.length - 1; i >= 0; i--) {
				const prompt = typeof outline[i]?.prompt === "string" ? outline[i].prompt.trim() : "";
				if (prompt && !prompt.startsWith("<system-reminder")) {
					s.title = prompt.length > 42 ? `${prompt.slice(0, 42)}…` : prompt;
					break;
				}
			}
		}));
	}
	async handleFileList(client, msg) {
		const cwd = this.cwdCache.get(msg.sessionId);
		if (!cwd) return this.ack(client, msg.reqId, false, "尚未确定该会话的工作目录(请先进入会话)");
		const rel = typeof msg.path === "string" && msg.path.trim() && msg.path.trim() !== "." ? msg.path.trim() : ".";
		const base = resolve(cwd);
		const abs = resolve(cwd, rel);
		if (abs !== base && !abs.startsWith(base + sep)) return this.ack(client, msg.reqId, false, "路径越出会话工作目录");
		try {
			const entries = await readdir(abs, { withFileTypes: true });
			const rows = await Promise.all(entries.filter((e) => e.name !== "." && e.name !== "..").map(async (e) => {
				let size;
				if (e.isFile()) try {
					size = (await stat(resolve(abs, e.name))).size;
				} catch {}
				return {
					name: e.name,
					type: e.isDirectory() ? "directory" : e.isFile() ? "file" : "other",
					...size !== void 0 ? { size } : {}
				};
			}));
			rows.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, "zh") : a.type === "directory" ? -1 : 1);
			return this.ack(client, msg.reqId, true, void 0, {
				path: rel,
				entries: rows,
				truncated: false
			});
		} catch (error) {
			return this.ack(client, msg.reqId, false, `目录读取失败: ${String(error).slice(0, 120)}`);
		}
	}
	async handleFileRead(client, msg) {
		const cwd = this.cwdCache.get(msg.sessionId);
		if (!cwd) return this.ack(client, msg.reqId, false, "尚未确定该会话的工作目录(请先进入会话)");
		const rel = typeof msg.path === "string" && msg.path.trim() ? msg.path.trim() : "";
		if (!rel) return this.ack(client, msg.reqId, false, "缺少文件路径");
		const base = resolve(cwd);
		const abs = resolve(cwd, rel);
		if (abs !== base && !abs.startsWith(base + sep)) return this.ack(client, msg.reqId, false, "路径越出会话工作目录");
		const offset = Number.isInteger(msg.offsetBytes) && msg.offsetBytes >= 0 ? msg.offsetBytes : 0;
		const length = Number.isInteger(msg.lengthBytes) && msg.lengthBytes > 0 ? Math.min(msg.lengthBytes, 512 * 1024) : 512 * 1024;
		try {
			const st = await stat(abs);
			if (!st.isFile()) return this.ack(client, msg.reqId, false, "目标不是普通文件");
			const fh = await open(abs, "r");
			try {
				const buf = Buffer.alloc(Math.min(length, Math.max(st.size - offset, 0)) || length);
				const { bytesRead } = await fh.read(buf, 0, buf.byteLength, offset);
				const data = buf.subarray(0, bytesRead).toString("base64");
				return this.ack(client, msg.reqId, true, void 0, {
					path: rel,
					offset,
					bytesRead,
					totalSize: st.size,
					eof: offset + bytesRead >= st.size,
					dataBase64: data
				});
			} finally {
				await fh.close();
			}
		} catch (error) {
			return this.ack(client, msg.reqId, false, `文件读取失败: ${String(error).slice(0, 120)}`);
		}
	}
	/**
	* Line counts for one turn's workspace/changes announcement. The
	* workspaceChanges service is provided in-process by dsh-workspace-changes
	* (summary(sessionId, seq) → {turn, cwd, files[{path,display,added,deleted}],
	* total, added, deleted} | undefined); unavailable when the host lacks the
	* plugin or the session was disposed — the phone then renders file names
	* without counts. Deliberately NOT part of debug_call's read-only whitelist
	* shape: it is its own typed request so the payload stays strict.
	*/
	handleChangesSummary(client, msg) {
		if (!this.enabled()) return this.ack(client, msg.reqId, false, "工作(Beta)已关闭");
		const ctx = this.ctx;
		let svc;
		try {
			svc = typeof ctx.get === "function" ? ctx.get("workspaceChanges") : void 0;
		} catch {
			svc = void 0;
		}
		if (!svc || typeof svc.summary !== "function") {
			this.logOnce("work calibration: workspaceChanges service unavailable — file cards render without line counts");
			return this.ack(client, msg.reqId, false, "宿主无文件变更统计服务");
		}
		try {
			const summary = svc.summary(msg.sessionId, msg.seq);
			if (!summary || typeof summary !== "object") return this.ack(client, msg.reqId, false, "该回合无变更摘要(会话可能已重置)");
			return this.ack(client, msg.reqId, true, void 0, summary);
		} catch (error) {
			return this.ack(client, msg.reqId, false, `变更统计读取失败: ${String(error).slice(0, 120)}`);
		}
	}
};

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
	static inject = ["tools", "typertGateway"];
	static Config = z.any();
	constructor(ctx, rawConfig) {
		super(ctx, "phoneLens");
		const config = normalizeConfig(rawConfig);
		const dataDir = lensDataDir();
		const log = (level, msg) => {
			const target = ctx.logger ?? console;
			target[level]?.(`[phone-lens] ${msg}`);
			try {
				const file = join(dataDir, "boot.log");
				try {
					if (statSync(file).size > 1e6) renameSync(file, `${file}.1`);
				} catch {}
				appendFileSync(file, `${new Date().toISOString()} [${level}] ${msg}\n`, "utf8");
			} catch {}
		};
		const pairing = new PairingStore(config.pairing.codeTtlMs);
		const devices = new DeviceStore(dataDir);
		const appSettings = new AppSettingsStore(join(dataDir, "settings.json"), join(dataDir, "saved"));
		const hub = new ViewHub(config, (level, msg) => log(level, msg));
		const targets = new TargetTracker(config);
		const workBridge = new WorkBridge(ctx, appSettings, log, () => {
			try {
				return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0");
			} catch {
				return "0.0.0";
			}
		});
		const attachments = () => ctx.get?.("attachments");
		try {
			const PHONE_TOOLS = new Set([
				"phone_take_photo",
				"phone_camera_pause",
				"phone_camera_resume",
				"phone_camera_zoom",
				"phone_camera_lens",
				"phone_camera_torch"
			]);
			const toolsSvc = ctx.tools;
			const disposers = [];
			const guardDisposers = disposers;
			if (toolsSvc && typeof toolsSvc.guard === "function") {
				const unguard = toolsSvc.guard((exec) => {
					if (!PHONE_TOOLS.has(exec?.name ?? "")) return void 0;
					if (!appSettings.get().modelToolsEnabled) return "PhoneLens 模型相机工具已在设置中关闭(电脑端 PhoneLens 设置页可重新开启)";
					return void 0;
				});
				guardDisposers.push(unguard);
			}
			ctx.on?.("tools/pre-execute", async (exec, next) => {
				if (!PHONE_TOOLS.has(exec?.name ?? "")) return next();
				const st = appSettings.get();
				if (!st.modelToolsEnabled) return {
					kind: "deny",
					reason: "PhoneLens 模型相机工具已在设置中关闭(电脑端 PhoneLens 设置页可重新开启)"
				};
				if (st.modelToolsConfirmFree) return { kind: "allow" };
				return {
					kind: "ask",
					reason: "PhoneLens 模型相机工具调用(模型免确认调用未开启)",
					displayReason: {
						en: "PhoneLens wants to use the phone camera (confirm-free mode is off)",
						"zh-CN": "PhoneLens 请求调用手机相机(模型免确认调用未开启)"
					}
				};
			});
			if (toolsSvc && typeof toolsSvc.register === "function") {
				const textOutput = {
					schema: { type: "string" },
					render: (_args, value) => [{
						type: "text",
						text: String(value)
					}]
				};
				const asText = (args, key) => {
					const v = args?.[key];
					return typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : void 0;
				};
				const numArg = (args, key) => {
					const v = args?.[key];
					return typeof v === "number" && Number.isFinite(v) ? v : void 0;
				};
				const boolArg = (args, key) => {
					const v = args?.[key];
					return typeof v === "boolean" ? v : void 0;
				};
				disposers.push(toolsSvc.register(defineTool({
					name: "phone_take_photo",
					description: "通过用户配对的手机(PhoneLens)立即拍摄一张照片,照片会直接作为图片提供给你。照片不进入用户输入框、不保存到用户文件夹(与用户的拍照注入模式设置无关)。没有手机连接、手机拒绝拍摄或超时会返回失败原因。仅在对话需要查看手机相机画面时使用(例如用户让你拍摄桌上的文件、白板、实物)。",
					parameters: { note: {
						type: "string",
						description: "可选的照片备注,会出现在文件名里(如'白板'、'发票')"
					} },
					output: textOutput,
					async execute(args, exec) {
						const capture = hub.requestCaptureDirect(asText(args, "note"), 45e3);
						const result = await new Promise((resolve$1) => {
							let done = false;
							const settle = (v) => {
								if (done) return;
								done = true;
								resolve$1(v);
							};
							capture.then((r) => settle(r)).catch((e) => settle({
								ok: false,
								reason: String(e)
							}));
							const sig = exec?.signal;
							if (sig?.aborted) settle({
								ok: false,
								reason: "调用已被取消"
							});
							else if (sig?.addEventListener) sig.addEventListener("abort", () => settle({
								ok: false,
								reason: "调用已被取消"
							}), { once: true });
						});
						if (!result.ok) return `拍照失败: ${result.reason}`;
						if (result.admitted.storage === "attachments" && typeof exec?.deferContext === "function") {
							exec.deferContext(createUserMessage({
								content: [{
									type: "image",
									attachment: result.admitted.ref
								}],
								source: { kind: "plugin:phone-lens" }
							}));
							const dim = result.admitted.ref.width ? `, ${result.admitted.ref.width}x${result.admitted.ref.height}` : "";
							return `照片已拍摄并作为图片直接提供给你(附件 ${result.admitted.ref.attachmentId}${dim}),请结合画面内容回应。`;
						}
						return `照片已拍摄并保存到 ${result.admitted.filePath ?? result.admitted.ref.attachmentId}(当前环境无法直接展示图片)。`;
					}
				})));
				disposers.push(toolsSvc.register(defineTool({
					name: "phone_camera_pause",
					description: "让用户配对的手机摄像头立即进入空闲状态(关闭相机与预览流,省电散热)。适用于用户明确要求关闭手机摄像头、或一段时间内不再需要取景时。手机会回执执行结果。",
					parameters: {},
					output: textOutput,
					async execute() {
						const r = await hub.requestCameraState("camera_idle", 8e3);
						return r.ok ? `手机摄像头已进入空闲状态。` : `操作失败: ${r.reason}`;
					}
				})));
				disposers.push(toolsSvc.register(defineTool({
					name: "phone_camera_resume",
					description: "立即恢复用户配对手机的拍摄状态(打开相机并恢复预览流)。适用于用户要求重新打开手机摄像头、或接下来需要拍照/取景时。手机会回执执行结果。",
					parameters: {},
					output: textOutput,
					async execute() {
						const r = await hub.requestCameraState("camera_resume", 8e3);
						return r.ok ? `手机摄像头已恢复拍摄状态。` : `操作失败: ${r.reason}`;
					}
				})));
				disposers.push(toolsSvc.register(defineTool({
					name: "phone_camera_zoom",
					description: "调整或查询用户配对手机摄像头的变焦倍数。三种用法:设定绝对倍数(如 factor=2.0 表示放大到 2 倍,1.0 为原始大小),相对当前倍数步进(如 step=1 放大一档、step=-1 缩小一档;档位大小由手机决定),或不带任何参数直接查询当前倍数与设备支持的变焦范围。设定/步进超出设备支持范围时会自动收拢到最近的可用倍数,返回设置后的实际倍数与设备支持范围。相机未开启、设备不支持变焦或手机 App 版本过旧时返回失败原因。变焦会同时作用于取景画面与后续拍摄的照片。",
					parameters: {
						factor: {
							type: "number",
							description: "目标变焦倍数(绝对值),如 1.0=原始、2.0=放大到 2 倍"
						},
						step: {
							type: "number",
							description: "相对当前倍数的步进量,正值放大、负值缩小,如 1 或 -1"
						}
					},
					output: textOutput,
					async execute(args) {
						const factor = numArg(args, "factor");
						const step = numArg(args, "step");
						const r = await hub.requestZoom({
							factor,
							step
						}, 8e3);
						if (!r.ok) return `变焦失败: ${r.reason}`;
						const range = r.min !== void 0 && r.max !== void 0 ? `,设备支持 ${fmtX(r.min)} - ${fmtX(r.max)}` : "";
						return factor === void 0 && step === void 0 ? `当前变焦 ${fmtX(r.factor)}${range}。` : `变焦成功:当前 ${fmtX(r.factor)}${range}。`;
					}
				})));
				disposers.push(toolsSvc.register(defineTool({
					name: "phone_camera_lens",
					description: "切换或查询用户配对手机摄像头正在使用的前置/后置镜头。两种用法:lens 传 \"front\" 或 \"back\" 切换到指定镜头(手机会重开相机,约需 1-2 秒);或不带参数查询当前使用的镜头与设备可用的镜头列表。适用于:拍摄 selfie/自己、用户要求切换前后摄像头、或拍照前先确认当前是哪个镜头。相机未开启时仅记录偏好,下次打开相机生效,同样返回成功。手机 App 版本过旧(需 ≥ 1.1.3)或设备只有一个镜头时返回失败或说明。",
					parameters: { lens: {
						type: "string",
						description: "目标镜头方向:\"front\"(前置)或 \"back\"(后置);不传即查询当前镜头"
					} },
					output: textOutput,
					async execute(args) {
						const raw = asText(args, "lens")?.toLowerCase();
						const lens = raw === "front" || raw === "前置" ? "front" : raw === "back" || raw === "后置" ? "back" : void 0;
						if (raw && lens === void 0) return `无法识别的镜头方向 \"${raw}\",请传 \"front\"(前置)或 \"back\"(后置),或不带参数查询。`;
						const r = await hub.requestLens({ lens }, 12e3);
						if (!r.ok) return `镜头操作失败: ${r.reason}`;
						const now = r.lens === "front" ? "前置" : "后置";
						const avail = r.available && r.available.length > 1 ? `,设备可用镜头: ${r.available.map((d) => d === "front" ? "前置" : d === "back" ? "后置" : d).join("、")}` : "";
						return lens === void 0 ? `当前使用${now}摄像头${avail}。` : `已切换到${now}摄像头${avail}。`;
					}
				})));
				disposers.push(toolsSvc.register(defineTool({
					name: "phone_camera_torch",
					description: "打开、关闭或查询用户配对手机的手电筒(闪光灯常亮)。三种用法:on=true 打开常亮照明、on=false 关闭、或不带参数查询当前开关状态。适用于光线不足的拍摄环境:先打开手电筒补光,再调用拍照,拍完关闭。注意:需要相机处于开启状态(相机未开启时返回失败,可先调用 phone_camera_resume 唤醒);前置镜头通常没有闪光灯硬件,部分设备会静默不亮;手机空闲自动关闭相机时手电筒会一同熄灭,长时间照明需保持相机活跃。手机 App 版本过旧(需 ≥ 1.1.6)时返回失败原因。",
					parameters: { on: {
						type: "boolean",
						description: "true 打开常亮照明 / false 关闭;不传即查询当前状态"
					} },
					output: textOutput,
					async execute(args) {
						const on = boolArg(args, "on");
						const r = await hub.requestTorch({ on }, 8e3);
						if (!r.ok) return `手电筒操作失败: ${r.reason}`;
						return on === void 0 ? `手电筒当前${r.on ? "已开启" : "已关闭"}。` : `手电筒已${r.on ? "开启" : "关闭"}。`;
					}
				})));
				const fmtX = (v) => Number.isInteger(v) ? `${v}x` : `${v.toFixed(2).replace(/\.?0+$/, "")}x`;
				ctx.effect?.(() => () => {
					for (const d of disposers) try {
						d();
					} catch {}
				}, "phone-lens.modelTools()");
				log("info", "model camera tools registered (phone_take_photo / phone_camera_pause / phone_camera_resume / phone_camera_zoom / phone_camera_lens / phone_camera_torch)");
			} else log("info", "no tools service on this ctx — model camera tools skipped (standalone/dev)");
		} catch (error) {
			log("warn", `model camera tools not wired (receiver unaffected): ${String(error)}`);
		}
		let handle$1 = null;
		let disposed = false;
		startLensServer({
			config,
			pairing,
			devices,
			hub,
			targets,
			attachments,
			fallbackDir: join(dataDir, "uploads"),
			pendingDir: join(dataDir, "pending"),
			appSettings,
			workBridge,
			log
		}).then(async (h) => {
			if (disposed) {
				h.dispose();
				return;
			}
			handle$1 = h;
			if (appSettings.get().workBetaEnabled) workBridge.setEnabled(true);
			const { code, expiresAt } = pairing.current();
			const qr = await buildPairingQr(code, expiresAt, config);
			process.stdout.write(`\n[phone-lens] 手机扫码配对(或浏览器打开 http://127.0.0.1:${h.port}/view.html):\n${qr.ascii}\n[phone-lens] 备用地址: ${qr.urls.join("  ")}\n\n`);
		}).catch((error) => {
			log("error", `receiver failed to start: ${String(error)}`);
			hub.dispose();
		});
		ctx.effect(() => () => {
			disposed = true;
			handle$1?.dispose();
			handle$1 = null;
		}, "phone-lens.server()");
	}
};

//#endregion
export { PhoneLens as default };
//# sourceMappingURL=index.js.map