import { basename, dirname, join, resolve, sep } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, rm, stat, unlink } from "node:fs/promises";
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
	const inject = r.inject ?? {};
	const target = r.target ?? {};
	const app = r.app ?? {};
	const GITHUB_APK = "https://github.com/yxqfg/phone-lens/releases/latest/download/app-release.apk";
	const giteeUrl = typeof app.giteeUrl === "string" && app.giteeUrl ? app.giteeUrl : GITEE_APK_DEFAULT;
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
	/**
	
	* Record an agent as alive WITHOUT promoting it to the active target —
	
	* hot-reload backfill only. A *running* agent claims the target via track();
	
	* idle ones land here so pinned-mode delivery still resolves against the
	
	* alive-map instead of reporting "no live agent".
	
	*/
	trackIdle(agent) {
		const id = agent.id ?? String(agent.session.id);
		this.agents.set(id, agent);
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
				source: { kind: "plugin:phone-lens" }
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
			modelToolsConfirmFree: false
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
	NO_TARGET: "NO_TARGET",
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
      case 'injected':
        pendingShot = null;
        if (m.ok) log('已注入会话 ' + (m.sessionId || '').slice(0, 8) + (m.name ? ' · ' + m.name : ''), 'ok');
        else log('入库成功,注入未完成: ' + (m.reason || ''), 'err');
        break;
      case 'upload':
        log('图片已入库 ' + (m.name || ''), 'ok');
        break;
      // modern-protocol branches (this page previously only knew the retired
      // messages, so photos succeeded silently and preview-off was invisible)
      case 'pending_image':
        if (pendingShot) { pendingShot = null; log('照片已入库,已放入输入框' + (m.name ? ': ' + m.name : ''), 'ok'); }
        else log('照片已入库,已放入输入框' + (m.name ? ': ' + m.name : ''), 'ok');
        break;
      case 'upload_saved':
        if (pendingShot) pendingShot = null;
        log('已保存至 ' + (m.dir || '指定文件夹') + (m.name ? ' · ' + m.name : ''), 'ok');
        break;
      case 'preview_state':
        if (!m.on && m.reason === 'offline') { $('dev').textContent = '连接已断开'; $('hint').textContent = '等待手机连接…'; $('hint').style.display = ''; }
        else if (!m.on) { $('dev').textContent = '预览已关闭'; $('hint').textContent = '手机端已停止预览'; $('hint').style.display = ''; }
        break;
      case 'devices': {
        const active = (m.devices || []).find((d) => d.active);
        $('dot').className = active ? 'on' : '';
        $('dev').textContent = active ? (active.name || '已连接') : '未连接';
        $('shoot').disabled = !active;
        $('hint').style.display = active ? 'none' : '';
        $('hint').textContent = '等待手机连接…';
        break;
      }
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
	const { config, pairing, devices, hub, targets, sink, log } = deps;
	const pairLimiter = new RateLimiter(6e4, 10);
	const uploadReplays = new Map();
	const injectionBox = { last: null };
	const server = createServer((req, res) => {
		handle(deps, req, res, {
			pairLimiter,
			uploadReplays,
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
		done(404, "Not Found");
	});
	const heartbeat = setInterval(() => hub.pingAll(), 2e4);
	try {
		await new Promise((resolve$1, reject) => {
			const onError = reject;
			server.once("error", onError);
			server.listen(config.server.port, config.server.host, () => {
				server.removeListener("error", onError);
				server.on("error", (e) => log("warn", `http server error: ${String(e)}`));
				resolve$1();
			});
		});
	} catch (error) {
		clearInterval(heartbeat);
		for (const client of wss.clients) client.terminate();
		await new Promise((resolve$1) => wss.close(() => resolve$1()));
		throw error;
	}
	log("info", `phone-lens listening on ${config.server.host}:${config.server.port} (paired devices: ${devices.count()})`);
	resolveLatestGiteeApk().then((url) => {
		if (url) log("info", `APK download link resolved from Gitee API: ${url}`);
	});
	return {
		port: config.server.port,
		dispose: async () => {
			clearInterval(heartbeat);
			hub.dispose();
			hub.detachAll();
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
	const { config, pairing, devices, hub, targets, sink, log } = deps;
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
		requiresPairing: true
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
		if (abandoned) {
			log("warn", `dropping late direct-capture photo: ${name} (${admitted.ref.attachmentId})`);
			const droppedBody = {
				ok: true,
				attachmentId: admitted.ref.attachmentId,
				width: admitted.ref.width,
				height: admitted.ref.height,
				bytes: admitted.ref.bytes,
				storage: admitted.storage,
				delivered: null,
				deliverReason: "dropped-late-direct"
			};
			rememberReplay(ctx, uploadId, droppedBody);
			return sendJson(res, 200, droppedBody);
		}
		if (admitted.storage === "file") await pruneUploads(deps.fallbackDir, config.limits.maxStoredUploads).catch((error) => log("warn", `upload pruning failed: ${String(error)}`));
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
				delivered: null,
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
				const fileName = nextAvailableName(dir, name);
				const target = resolveUnder(dir, fileName);
				if (!target) throw new Error("resolved path escapes the save directory");
				writeFileSync(target, buf);
				savedDir = dir;
				log("info", `folder-mode saved: ${target}`);
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
			prunePending(deps.pendingDir, PENDING_TTL_MS).catch(() => {});
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
				delivered: null,
				deliverReason: savedDir ? wantComposer ? "saved-and-staged" : "saved-to-folder" : "staged-in-composer"
			};
			rememberReplay(ctx, uploadId, replayBody);
			return sendJson(res, 200, {
				ok: true,
				attachmentId: admitted.ref.attachmentId,
				width: admitted.ref.width,
				height: admitted.ref.height,
				bytes: admitted.ref.bytes,
				storage: admitted.storage,
				delivered: null,
				deliverReason: savedDir ? wantComposer ? "saved-and-staged" : "saved-to-folder" : "staged-in-composer"
			});
		}
	}
	if (method === "GET" && path.startsWith("/pending/") && loop) {
		const id = path.slice(9).split("/")[0] ?? "";
		const file = resolveUnder(deps.pendingDir, pendingFileName(id));
		if (!file) return sendError(res, 404, ERROR_CODES.BAD_REQUEST, "pending image not found");
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
			},
			lastInjection: ctx.getLastInjection()
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
			modelToolsConfirmFree: st.modelToolsConfirmFree
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
		const st = deps.appSettings.set(patch);
		log("info", `app settings updated: mode=${st.saveMode} dir=${st.saveDir ? JSON.stringify(st.saveDir) : "(default)"} modelTools=${st.modelToolsEnabled}/${st.modelToolsConfirmFree}`);
		return sendJson(res, 200, {
			saveMode: st.saveMode,
			saveDir: st.saveDir,
			effectiveSaveDir: deps.appSettings.effectiveSaveDir(),
			modelToolsEnabled: st.modelToolsEnabled,
			modelToolsConfirmFree: st.modelToolsConfirmFree
		}, cors);
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
/** How long a timed-out direct capture stays "abandoned" (late-photo guard). */
const ABANDON_DIRECT_TTL_MS = 5 * 6e4;
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
		for (const [id, p] of this.pendingCaptures) {
			p.onFail?.("接收端服务已停止");
			this.pendingCaptures.delete(id);
		}
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
						message: `phone reported ${msg.status}${msg.detail ? `: ${msg.detail}` : ""}`
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
	noteFor(captureId) {
		return this.pendingCaptures.get(captureId)?.note;
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
					reason: "手机 App 版本过旧(需 ≥ 1.0.4),请先更新手机端"
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
	static inject = ["tools"];
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
		const appSettings = new AppSettingsStore(join(dataDir, "settings.json"), join(dataDir, "saved"));
		const hub = new ViewHub(config, (level, msg) => log(level, msg));
		const targets = new TargetTracker(config);
		const sink = new HostDeliverySink(config, (level, msg) => log(level, msg));
		const attachments = () => ctx.get?.("attachments");
		const onAgent = (agent) => sink.track(agent);
		const offAgent = (agent) => sink.untrack(agent);
		ctx.on?.("agent/created", (payload) => onAgent(payload.agent));
		ctx.on?.("agent/inbox/inserted", (payload) => onAgent(payload.agent));
		ctx.on?.("agent/status", (payload) => {
			if (payload.status === "running") onAgent(payload.agent);
		});
		ctx.on?.("agent/disposed", (payload) => offAgent(payload.agent));
		let backfilled = false;
		const runBackfill = (registry) => {
			if (backfilled) return;
			if (!registry) try {
				registry = ctx.agents;
			} catch {
				return;
			}
			if (!registry || typeof registry.list !== "function") return;
			const live = registry.list() ?? [];
			let running = 0;
			for (const agent of live) if (agent?.status === "running") {
				running++;
				onAgent(agent);
			} else sink.trackIdle(agent);
			backfilled = true;
			if (live.length > 0) log("info", `backfilled ${live.length} live agent(s) (${running} running) from ctx.agents`);
		};
		ctx.inject?.(["agents"], (injectCtx) => {
			try {
				runBackfill(injectCtx.agents);
			} catch {}
		});
		setTimeout(() => {
			if (!backfilled) runBackfill();
		}, 0).unref?.();
		try {
			const PHONE_TOOLS = new Set([
				"phone_take_photo",
				"phone_camera_pause",
				"phone_camera_resume",
				"phone_camera_zoom",
				"phone_camera_lens"
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
							capture.then((r) => settle(r));
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
				const fmtX = (v) => Number.isInteger(v) ? `${v}x` : `${v.toFixed(2).replace(/\.?0+$/, "")}x`;
				ctx.effect?.(() => () => {
					for (const d of disposers) try {
						d();
					} catch {}
				}, "phone-lens.modelTools()");
				log("info", "model camera tools registered (phone_take_photo / phone_camera_pause / phone_camera_resume / phone_camera_zoom / phone_camera_lens)");
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
			sink,
			attachments,
			fallbackDir: join(dataDir, "uploads"),
			pendingDir: join(dataDir, "pending"),
			appSettings,
			log
		}).then(async (h) => {
			if (disposed) {
				h.dispose();
				return;
			}
			handle$1 = h;
			const { code, expiresAt } = pairing.current();
			const qr = await buildPairingQr(code, expiresAt, config);
			process.stdout.write(`\n[phone-lens] 手机扫码配对(或浏览器打开 http://127.0.0.1:${h.port}/view.html):\n${qr.ascii}\n[phone-lens] 备用地址: ${qr.urls.join("  ")}\n\n`);
		}).catch((error) => {
			log("error", `receiver failed to start: ${String(error)} (check port ${config.server.port})`);
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