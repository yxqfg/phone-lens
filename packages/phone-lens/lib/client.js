/**
 * phone-lens browser half — the floating viewfinder window inside the dsh Web UI.
 *
 * Registers into the additive `shell.overlay` slot (list kind, frame-wide
 * floating layer). Speaks the same protocol as /view.html:
 *   WS  ws://127.0.0.1:<port>/ws/view   (frames + events + shutter control)
 *   GET http://127.0.0.1:<port>/qr.json (pairing QR; loopback CORS is allowed)
 *
 * No bundler pipeline: this file IS the artifact (lazy-CJS factory registered
 * into window.__ModuleLoader__), react comes from the shell static table.
 */
window.__ModuleLoader__.load({
	id: "phone-lens",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		const { useState, useEffect, useRef } = react;

		const NS = "phone-lens";
		const PORT_KEY = "phoneLens.port";
		// Capture modes (user-selected in the settings panel; stored host-side).
		const SAVE_MODES = [
			{ id: "composer", title: "自动注入对话", desc: "拍照后自动放入输入框", flash: "已切换:拍照后自动注入输入框" },
			{ id: "both", title: "注入对话并保存", desc: "放入输入框,同时保存到指定文件夹", flash: "已切换:注入对话并保存到文件夹" },
			{ id: "folder", title: "仅保存到文件夹", desc: "不放入输入框,只保存到指定电脑文件夹", flash: "已切换:仅保存到文件夹" },
		];
		// App download fallbacks (used when /app-qr.json is unavailable on an older host).
		// Gitee release carrying the newest APK.
		const APP_GITEE = "https://gitee.com/qianfengbingtang/phone-lens/releases/download/v1.1.0/app-release.apk";
		const APP_GITHUB = "https://github.com/yxqfg/phone-lens/releases/latest/download/app-release.apk";
		const h = react.createElement;

		// ── styles ────────────────────────────────────────────────────────────
		const styleSheet = document.createElement("style");
		styleSheet.id = `${NS}/overlay.css`;
		styleSheet.textContent = `
.lm-root { position: fixed; right: 16px; bottom: 16px; z-index: 9999; font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
.lm-fab { width: 46px; height: 46px; border-radius: 50%; border: 1px solid #3b7cb5; background: linear-gradient(160deg, #2a5d8f, #1d3f61); color: #eaf2fa; font-size: 20px; line-height: 1; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.45); }
.lm-fab:hover { filter: brightness(1.15); }
.lm-fab .dot { position: absolute; top: 4px; right: 4px; width: 8px; height: 8px; border-radius: 50%; background: #e5484d; }
.lm-fab .dot.on { background: #46a758; }
.lm-panel { position: absolute; right: 0; bottom: 56px; width: 268px; background: #14181d; border: 1px solid #2a333e; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.55); color: #dfe7ee; overflow: hidden; }
.lm-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: #1a2129; border-bottom: 1px solid #232c36; font-size: 12px; }
.lm-head b { font-weight: 600; }
.lm-head .x { margin-left: auto; background: none; border: none; color: #8fa1b5; cursor: pointer; font-size: 14px; }
.lm-body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.lm-canvas { width: 100%; height: auto; max-height: 300px; background: #000; border-radius: 8px; display: block; object-fit: contain; }
.lm-status { font-size: 11px; color: #8fa1b5; display: flex; gap: 8px; align-items: center; min-height: 15px; }
.lm-status .ok { color: #58b368; }
.lm-status .warn { color: #d9a441; }
.lm-row { display: flex; gap: 6px; }
.lm-btn { flex: 1; padding: 7px 8px; border-radius: 8px; border: 1px solid #2f3b48; background: #1f2937; color: #dfe7ee; font-size: 12px; cursor: pointer; }
.lm-btn:hover { background: #28323e; }
.lm-btn:disabled { opacity: .45; cursor: default; }
.lm-btn.primary { background: #2a5d8f; border-color: #3b7cb5; }
.lm-qr { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px; background: #10141a; border: 1px dashed #2a333e; border-radius: 8px; }
.lm-qr img { width: 148px; height: 148px; image-rendering: pixelated; background: #fff; border-radius: 6px; }
.lm-qr .code { font-size: 16px; letter-spacing: .18em; }
.lm-qr .hint { font-size: 10px; color: #7d8da0; text-align: center; line-height: 1.45; }
.lm-qr a.lm-dl { display: block; margin-top: 4px; font-size: 11px; color: #3b7cb5; text-decoration: none; }
.lm-qr a.lm-dl:hover { text-decoration: underline; }
.lm-port { display: flex; gap: 6px; align-items: center; font-size: 11px; color: #7d8da0; }
.lm-port input { width: 64px; background: #0d1117; color: #dfe7ee; border: 1px solid #2f3b48; border-radius: 6px; padding: 3px 6px; font-size: 12px; }
.lm-settings { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid #232c36; padding-top: 9px; }
.lm-sethead { display: flex; align-items: center; gap: 8px; }
.lm-sethead b { font-size: 12px; color: #dfe7ee; font-weight: 600; }
.lm-setlabel { font-size: 10px; color: #7d8da0; }
.lm-mode { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 8px; border: 1px solid #2f3b48; background: #1f2937; cursor: pointer; text-align: left; }
.lm-mode:hover { background: #28323e; }
.lm-mode.selected { border-color: #3b7cb5; background: #1d3f61; }
.lm-mode .dot { width: 9px; height: 9px; border-radius: 50%; border: 2px solid #8fa1b5; flex: none; }
.lm-mode.selected .dot { border-color: #6cc0ff; background: #6cc0ff; }
.lm-mode .txt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.lm-mode .t { font-size: 12px; color: #dfe7ee; }
.lm-mode .d { font-size: 10px; color: #7d8da0; }
.lm-setrow { display: flex; gap: 6px; }
.lm-setrow input { flex: 1; min-width: 0; background: #0d1117; color: #dfe7ee; border: 1px solid #2f3b48; border-radius: 6px; padding: 5px 8px; font-size: 11px; }
.lm-sethint { font-size: 10px; color: #7d8da0; line-height: 1.45; word-break: break-all; }
.lm-preview-off { height: 220px; display: flex; align-items: center; justify-content: center; background: #10141a; border: 1px dashed #2a333e; border-radius: 8px; color: #d9a441; font-size: 12px; text-align: center; padding: 0 12px; }
.lm-flash { font-size: 11px; color: #8fa1b5; min-height: 14px; }
.lm-flash.ok { color: #58b368; }
.lm-flash.err { color: #e5696e; }
.lm-pending { display: flex; flex-direction: column; gap: 4px; padding: 6px; background: #10141a; border: 1px dashed #2a333e; border-radius: 8px; }
.lm-pending-label { font-size: 10px; color: #7d8da0; }
.lm-devices { display: flex; flex-wrap: wrap; gap: 6px; }
.lm-device { flex: none; padding: 4px 8px; border-radius: 14px; border: 1px solid #2f3b48; background: #1f2937; color: #8fa1b5; font-size: 11px; cursor: pointer; }
.lm-device.active { border-color: #46a758; color: #d2f5d8; background: #1f4a2c; }
.lm-device:hover { background: #28323e; }
.lm-rename { position: absolute; right: 0; bottom: 56px; width: 268px; background: #14181d; border: 1px solid #2a333e; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.6); padding: 12px; display: flex; flex-direction: column; gap: 8px; z-index: 5; }
.lm-rename-title { font-size: 13px; color: #dfe7ee; font-weight: 600; }
.lm-rename-input { background: #0d1117; color: #dfe7ee; border: 1px solid #2f3b48; border-radius: 8px; padding: 8px; font-size: 13px; }
.lm-appqr { position: absolute; right: 0; bottom: 56px; width: 268px; background: #14181d; border: 1px solid #2a333e; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.6); padding: 12px; display: flex; flex-direction: column; align-items: center; gap: 8px; z-index: 6; }
.lm-appqr-title { font-size: 13px; color: #dfe7ee; font-weight: 600; }
.lm-appqr-img { width: 168px; height: 168px; image-rendering: pixelated; background: #fff; border-radius: 8px; }
.lm-appqr-hint { font-size: 10px; color: #7d8da0; text-align: center; line-height: 1.45; }
.lm-appqr-links { font-size: 11px; display: flex; gap: 5px; align-items: center; color: #7d8da0; }
.lm-appqr-links a { color: #3b7cb5; text-decoration: none; }
.lm-appqr-links a:hover { text-decoration: underline; }
.fab-cam { display: inline-flex; align-items: center; justify-content: center; }
.fab-cam svg { display: block; }
@keyframes lm-blast { 0%,100% { background: #6cc0ff; box-shadow: 0 0 16px rgba(108,192,255,.9); } 50% { background: #2a6db8; box-shadow: 0 0 4px rgba(108,192,255,.2); } }
.lm-fab.connected { background: #1f2937; color: #46a758; }
.lm-fab.connecting { color: #ffffff; background: #6cc0ff; animation: lm-blast .5s ease-in-out 3; }
.lm-fab.disconnected { background: #23303c; color: #8fa1b5; }
.lm-status .warn-big { color: #d9a441; font-weight: 600; font-size: 11px; line-height: 1.4; white-space: normal; }
.lm-updwarn { font-size: 11px; line-height: 1.5; color: #d9a441; }
.lm-appver { font-size: 10px; line-height: 1.5; color: #7d8da0; }
.lm-appver.mismatch { color: #d9a441; }
.lm-setsec { display: flex; flex-direction: column; gap: 12px; max-width: 760px; }
.lm-setsec-head { display: flex; align-items: center; gap: 10px; }
.lm-setsec-headtitle { font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6edf5); }
.lm-setsec-badge { font-size: 11px; line-height: 18px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.14)); color: var(--dsw-alias-label-secondary, #9fb0c0); }
.lm-setsec-intro { font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary, #7d8da0); }
.lm-setsec-card { border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.10)); border-radius: 16px; background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,.03)); overflow: hidden; }
.lm-setsec-cardhead { padding: 12px 16px 10px; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6edf5); }
.lm-setsec-rows { display: flex; flex-direction: column; }
.lm-set-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06)); }
.lm-set-rowtext { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.lm-set-rowtitle { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary, #e6edf5); }
.lm-set-rowdesc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #7d8da0); }
.lm-set-control { flex: none; display: inline-flex; align-items: center; }
.lm-set-switch { position: relative; display: inline-flex; flex: none; cursor: pointer; }
.lm-set-switch input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; }
.lm-set-track { display: inline-flex; align-items: center; width: 36px; height: 20px; padding: 2px; box-sizing: border-box; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.14)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.05)); transition: background .15s ease, border-color .15s ease; }
.lm-set-thumb { display: block; width: 14px; height: 14px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #8fa1b5); transition: transform .15s ease, background .15s ease; }
.lm-set-switch:hover .lm-set-track { border-color: var(--dsw-alias-label-dimmed, #5c6b7a); }
.lm-set-switch input:checked + .lm-set-track { border-color: var(--dsw-alias-button-primary-fill, #3b82f6); background: var(--dsw-alias-button-primary-fill, #3b82f6); }
.lm-set-switch input:checked + .lm-set-track .lm-set-thumb { transform: translateX(16px); background: var(--dsw-alias-bg-layer-3, #0f141a); }
.lm-set-switch input:focus-visible + .lm-set-track { outline: 2px solid var(--dsw-alias-button-primary-fill, #3b82f6); outline-offset: 2px; }
.lm-setsec-note { font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary, #7d8da0); }
`;
		// The factory runs at materialization (first import), so the document
		// head is guaranteed to exist; remove-then-add keeps HMR idempotent.
		{
			const prior = document.getElementById(styleSheet.id);
			if (prior) prior.remove();
			document.head.appendChild(styleSheet);
		}

		// ── helpers ───────────────────────────────────────────────────────────
		function drawJpeg(canvas, arrayBuffer, rotation) {
			if (!canvas) return;
			const blob = new Blob([arrayBuffer], { type: "image/jpeg" });
			const url = URL.createObjectURL(blob);
			const img = new Image();
			img.onload = () => {
				const r = ((rotation % 360) + 360) % 360;
				const swap = r === 90 || r === 270;
				const w = swap ? img.height : img.width;
				const h = swap ? img.width : img.height;
				if (canvas.width !== w || canvas.height !== h) {
					canvas.width = w;
					canvas.height = h;
				}
				const ctx = canvas.getContext("2d");
				ctx.save();
				ctx.translate(w / 2, h / 2);
				ctx.rotate((r * Math.PI) / 180);
				ctx.drawImage(img, -img.width / 2, -img.height / 2);
				ctx.restore();
				URL.revokeObjectURL(url);
			};
			img.onerror = () => URL.revokeObjectURL(url);
			img.src = url;
		}

		// ── composable pre-send (dsh composer draft) ───────────────────────────
		// The phone photo is staged as a composer draft attachment, NOT injected
		// into the model: the user types text next and hits send. On dsh 0.1.7+
		// the composer is a Lexical editor whose intake is package-internal, so
		// we dispatch a synthetic paste event and the editor's own paste handler
		// admits the file (intakeFiles → createDrafts) — the only stable seam.
		let hostCtx = null; // set in apply() so the component can reach the runtime

		function currentSessionId(ctx) {
			try {
				// rc.2: the current session lives on the uiSession binding source,
				// not on sessions.list.getSnapshot().current (removed in 0.1.7).
				const ui = ctx.get("uiSession");
				const key = ui?.current?.value?.key;
				if (key) return key;
				// pre-0.1.7 fallback.
				const sessions = ctx.get("sessions");
				if (!sessions) throw new Error("no sessions service");
				const list = sessions.list;
				if (!list) throw new Error("no sessions.list");
				const snap = typeof list.getSnapshot === "function" ? list.getSnapshot() : list.snapshot;
				if (!snap) throw new Error("no session list snapshot");
				return snap.current;
			} catch (e) {
				throw new Error("currentSessionId: " + String(e));
			}
		}

		// rc.2 composer is a Lexical editor; its root element carries the
		// data-lexical-editor marker. Fall back to any visible contenteditable.
		function findComposerEditor() {
			const lexical = document.querySelector('div[data-lexical-editor="true"][contenteditable="true"]');
			if (lexical) return lexical;
			const candidates = document.querySelectorAll('[contenteditable="true"]');
			for (const el of candidates) {
				if (el.getClientRects().length > 0) return el;
			}
			return null;
		}

		async function stageIntoComposer(ctx, port, attachmentId) {
			const resp = await fetch(`http://127.0.0.1:${port}/pending/${attachmentId}`).catch((e) => { throw new Error("fetch pending: " + String(e)); });
			if (!resp.ok) throw new Error("pending fetch HTTP " + resp.status);
			const buf = await resp.arrayBuffer();
			const file = new File([buf], `phone-${attachmentId.slice(0, 8)}.jpg`, { type: "image/jpeg" });
			// rc.2 path: the composer's own paste handler admits image files
			// through the official intake (intakeFiles → createDrafts), so we
			// dispatch a synthetic paste instead of touching package-internal
			// draft APIs. The composer is bound to the current session already.
			const editor = findComposerEditor();
			if (!editor) throw new Error("no composer input (open a session first)");
			editor.focus({ preventScroll: true });
			const dt = new DataTransfer();
			dt.items.add(file);
			const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
			editor.dispatchEvent(ev);
			return true;
		}

		// Minimal single-line camera glyph; state expressed by accent + a small
		// overlay mark (slash = disconnected, green dot = connected, pulse =
		// connecting). Keeps the FAB clean instead of an emoji.
		function CameraIcon({ state }) {
			const cls = "fab-cam" + (state === "connected" ? " connected" : state === "connecting" ? " connecting" : " disconnected");
			return h(
				"span",
				{ className: cls },
				h(
					"svg",
					{ viewBox: "0 0 24 24", width: 24, height: 24, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" },
					h("path", { d: "M4 8h3l1.7-2.3h6.6L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" }),
					h("circle", { cx: 12, cy: 13.4, r: 3.4 }),
					state === "connected" ? h("circle", { cx: 12, cy: 13.4, r: 1.5, fill: "#46a758", stroke: "none" }) : null,
					state === "disconnected" ? h("path", { d: "M3.5 3.5l17 17", stroke: "#e5484d", strokeWidth: 1.9 }) : null,
				),
			);
		}

		function LensOverlay(_props) {
			const [open, setOpen] = useState(false);
			const [port, setPort] = useState(() => {
				try {
					return window.localStorage.getItem(PORT_KEY) || "8791";
				} catch {
					return "8791";
				}
			});
			const [portDraft, setPortDraft] = useState(port);
			const [camOn, setCamOn] = useState(false);
			const [link, setLink] = useState("disconnected"); // disconnected | connecting | connected
			const [fps, setFps] = useState(0);
			const [qr, setQr] = useState(null);
			const [, setTick] = useState(0); // 1s heartbeat: re-renders the QR countdown while pairing is visible
			const [flash, setFlash] = useState("");
			const [pending, setPending] = useState([]); // [{id, name}] waiting to be staged
			const [devices, setDevices] = useState([]); // [{id,name,active,appVersion?}]
			// Host plugin-update check (update-check.ts): null = unchecked/failed —
			// the hint line simply doesn't render. Fetched once per panel-open; the
			// host caches the Gitee lookup for 12h so this costs no API call.
			const [upd, setUpd] = useState(null);
				const [rename, setRename] = useState(null); // {id, name} — self-drawn rename dialog
				const [appQr, setAppQr] = useState(null); // app-download QR dialog payload (or {loading}/{fallback:true})
				const [previewOff, setPreviewOff] = useState(false); // host says the phone's stream stopped (preview off on the phone)
				const [settingsOpen, setSettingsOpen] = useState(false); // collapsible settings section under the main card
				const [appSt, setAppSt] = useState(null); // {saveMode, saveDir, effectiveSaveDir} | null (null = host too old)
				const [dirDraft, setDirDraft] = useState("");
			const canvasRef = useRef(null);
			const lastQrCode = useRef(null); // last pairing code seen — detects auto rotation for the "已更新" flash
			const wsRef = useRef(null);
			const framesRef = useRef(0);
			const rotRef = useRef(0);

			const baseUrl = `http://127.0.0.1:${port}`;
			const wsUrl = `ws://127.0.0.1:${port}/ws/view`;

			// plugin-update check, once per panel-open (host caches the Gitee
			// lookup 12h / failures 30min — this fetch never hits the API itself)
			useEffect(() => {
				if (!open) return;
				let alive = true;
				void (async () => {
					try {
						const r = await fetch(`${baseUrl}/update-check`, { cache: "no-store" });
						if (!r.ok) throw new Error(String(r.status));
						const data = await r.json();
						if (alive) setUpd(data && data.current ? data : null);
					} catch {
						if (alive) setUpd(null);
					}
				})();
				return () => {
					alive = false;
				};
			}, [open, port]);

			// view websocket: ALWAYS connected (independent of panel open state),
			// so the connection status and pending-photo events refresh even when
			// the FAB is collapsed. Frames are only drawn when the canvas exists.
			useEffect(() => {
				let stopped = false;
				let timer = null;
				const connect = () => {
					if (stopped) return;
					let ws;
					try {
						ws = new WebSocket(wsUrl);
					} catch {
						timer = setTimeout(connect, 2000);
						return;
					}
					ws.binaryType = "arraybuffer";
					wsRef.current = ws;
					ws.onopen = () => setFlash("");
					ws.onmessage = (ev) => {
						if (ev.data instanceof ArrayBuffer) {
							framesRef.current++;
							drawJpeg(canvasRef.current, ev.data, rotRef.current);
							return;
						}
						let m;
						try {
							m = JSON.parse(ev.data);
						} catch {
							return;
						}
						if (m.type === "meta" || m.type === "device") {
							const on = m.type === "meta" ? m.camera.connected : m.online;
							setCamOn(Boolean(on));
							setLink((prev) => {
								if (!on) return "disconnected";
								return prev === "disconnected" ? "connecting" : prev;
							});
							if (m.type === "meta" && m.camera.rotation !== undefined) rotRef.current = m.camera.rotation;
						} else if (m.type === "frame_meta") {
							if (m.rotation !== undefined) rotRef.current = m.rotation;
						} else if (m.type === "preview_state") {
							// host-derived: the ACTIVE phone's stream stopped (user turned
							// preview off in the app) or started again
							setPreviewOff(!m.on);
						} else if (m.type === "upload_saved") {
							// folder-only mode: the photo bypassed the composer; local hint
							setFlashOk(`已保存至 ${m.dir || "指定文件夹"}`);
						} else if (m.type === "injected") {
							if (m.ok) setFlashOk(`已注入会话 ${(m.sessionId || "").slice(0, 8)}…`);
							else setFlashErr(`已保存到电脑 ✓(未注入:${m.reason || "无活动会话"})`);
						} else if (m.type === "upload") {
							setFlashOk("图片已入库…");
						} else if (m.type === "pending_image") {
							// pre-send: stage this photo into the composer draft
							setPending((p) => [...p, { id: m.attachmentId, name: m.name || "" }]);
							stageIntoComposer(hostCtx, port, m.attachmentId)
								.then(() => {
									setPending((p) => p.filter((x) => x.id !== m.attachmentId));
									setFlashOk("照片已注入输入框,输入文字后发送");
								})
								.catch((e) => setFlashErr("自动放入失败: " + String(e && e.message || e).slice(0, 90)));
						} else if (m.type === "devices") {
							// side effects OUT of the updater (updaters must stay pure —
							// StrictMode double-invokes them); compare here, setState below
							const grew = (m.devices || []).length > (devices ? devices.length : 0);
							setDevices(m.devices || []);
							// a NEW device came online → the one-time pairing code was
							// consumed; rotate the QR so the next scan sees a fresh code
							if (grew) void refreshQr(true);
							// an active device present == camera linked; derive both the
							// canvas visibility and the header/FAB link state from the
							// device list (host no longer emits `device`)
							const active = (m.devices || []).find((d) => d.active);
							setCamOn(Boolean(active));
							setLink((prev) => {
								if (!active) return "disconnected";
								// fresh link plays the triple-flash greeting
								if (prev === "disconnected") return "connecting";
								return prev;
							});
						} else if (m.type === "error") {
							setFlashErr(`${m.code}${m.message ? ":" + m.message : ""}`);
						}
					};
						ws.onclose = () => {
							setCamOn(false);
							setPreviewOff(false);
							if (!stopped) timer = setTimeout(connect, 2000);
						};
				};
				connect();
				return () => {
					stopped = true;
					if (timer) clearTimeout(timer);
					const ws = wsRef.current;
					if (ws) {
						ws.onclose = null;
						try {
							ws.close();
						} catch {}
					}
					wsRef.current = null;
				};
			}, [wsUrl]);

			// connecting → connected after the 1.5s triple-flash greeting
			useEffect(() => {
				if (link !== "connecting") return;
				const t = setTimeout(() => setLink("connected"), 1500);
				return () => clearTimeout(t);
			}, [link]);

			// fps meter
			useEffect(() => {
				if (!open) return;
				const iv = setInterval(() => {
					setFps(framesRef.current);
					framesRef.current = 0;
				}, 1000);
				return () => clearInterval(iv);
			}, [open]);

			function setFlashOk(t) {
				setFlash(t);
			}
			function setFlashErr(t) {
				setFlash(t);
			}

			async function refreshQr(auto) {
				try {
					const r = await fetch(`${baseUrl}/qr.json`, { cache: "no-store" });
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					const data = await r.json();
					// surfaced only on automatic rotation, so the user sees the code change
					if (auto && lastQrCode.current && lastQrCode.current !== data.code) setFlashOk("二维码已更新,请扫描最新码");
					lastQrCode.current = data.code;
					setQr(data);
				} catch (e) {
					setFlashErr(`接收服务不可达(${String(e).slice(0, 60)})`);
				}
			}

			// Manual refresh must FORCE a new pairing code server-side: /qr.json
			// alone keeps returning the still-live code (same QR, same countdown),
			// which read as a dead button. Same recipe as /view.html: ask the host
			// to burn the current code via WS, then fetch the fresh one.
			function manualRefreshQr() {
				const ws = wsRef.current;
				if (ws && ws.readyState === 1) {
					ws.send(JSON.stringify({ type: "refresh_pairing" }));
					setTimeout(() => void refreshQr(true), 150);
				} else {
					void refreshQr(true);
				}
			}

			// ── settings (capture mode / folder / port) ───────────────────────────
			async function loadAppSt() {
				try {
					const r = await fetch(`${baseUrl}/app-settings`, { cache: "no-store" });
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					const data = await r.json();
					setAppSt(data);
					setDirDraft(data.effectiveSaveDir || data.saveDir || "");
				} catch {
					setAppSt(null); // older host without /app-settings: port-only settings
				}
			}

			async function saveAppSt(patch) {
				try {
					const r = await fetch(`${baseUrl}/app-settings`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(patch),
					});
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					const data = await r.json();
					setAppSt(data);
					setDirDraft(data.effectiveSaveDir || data.saveDir || "");
					return true;
				} catch (e) {
					setFlashErr("设置保存失败: " + String(e && e.message || e).slice(0, 60));
					return false;
				}
			}

			function saveDirDraft() {
				void saveAppSt({ saveDir: dirDraft }).then((ok) => ok && setFlashOk("保存目录已更新"));
			}

			// Open the app-download dialog: QR (from the host) + source links.
			// Falls back to the built-in Gitee/GitHub links when the endpoint is
			// missing (older host half running an older release).
			async function openAppQr() {
				setAppQr({ loading: true });
				try {
					const r = await fetch(`${baseUrl}/app-qr.json`, { cache: "no-store" });
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					setAppQr(await r.json());
				} catch (_) {
					setAppQr({ fallback: true, gitee: APP_GITEE, github: APP_GITHUB });
				}
			}

			// pairing QR lifecycle: fetch on first show, then keep itself alive —
			// refreshes right after expiry (one-time codes burn after 15min),
			// every 30s as a drift/sleep safety net, and beats a 1s heart so the
			// countdown stays honest.
			useEffect(() => {
				if (!open || camOn) return;
				if (!qr) {
					void refreshQr();
					return;
				}
				const remainMs = qr.expiresAt - Date.now();
				const expireTimer = setTimeout(() => void refreshQr(true), Math.max(remainMs, 0) + 800);
				const driftTimer = setInterval(() => void refreshQr(true), 30_000);
				const heartbeat = setInterval(() => setTick((t) => (t + 1) % 1e9), 1000);
				return () => {
					clearTimeout(expireTimer);
					clearInterval(driftTimer);
					clearInterval(heartbeat);
				};
			}, [open, camOn, qr]);

			function shoot() {
				const ws = wsRef.current;				if (ws && ws.readyState === 1) {
					ws.send(JSON.stringify({ type: "capture" }));
					setFlash("快门已触发,等待手机上传…");
				}
			}

			function selectDevice(id) {
				const ws = wsRef.current;
				if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "select_device", deviceId: id }));
			}

			function renameDevice(id, current) {
				setRename({ id, name: current || "" });
			}
			function confirmRename() {
				const ws = wsRef.current;
				const trimmed = String((rename && rename.name) || "").trim();
				if (trimmed && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "rename_device", deviceId: rename.id, name: trimmed }));
				setRename(null);
			}

			function savePort() {
				const p = String(portDraft).trim() || "8791";
				setPort(p);
				try {
					window.localStorage.setItem(PORT_KEY, p);
				} catch {}
				setFlash(`端口已切换为 ${p}`);
			}

			return h(
				"div",
				{ className: "lm-root" },
				open
					? h(
							"div",
							{ className: "lm-panel" },
							h(
								"div",
								{ className: "lm-head" },
								h("b", null, "PhoneLens 直连取景"),
								h("span", { className: link === "connected" ? "ok" : "warn", style: { fontSize: 11 } }, link === "connected" ? "已连接" : link === "connecting" ? "连接中…" : "未连接"),
								h("button", { className: "x", onClick: () => setOpen(false), title: "收起" }, "✕"),
							),
							h(
								"div",
								{ className: "lm-body" },
								// only show the viewfinder canvas while a camera is actually
								// streaming; when the phone turned preview off, clear the last
								// frame and say so instead of freezing on a stale picture
								camOn && !previewOff
									? h("canvas", { ref: canvasRef, className: "lm-canvas", width: 360, height: 640 })
									: camOn && previewOff
										? h("div", { className: "lm-preview-off" }, "您在手机端已关闭预览功能")
										: null,
								h(
									"div",
									{ className: "lm-status" },
									h("span", null, camOn && !previewOff && fps > 0 ? `${fps} fps` : "—"),
									h(
										"span",
										{ className: !camOn ? "warn-big" : previewOff ? "warn" : "" },
										!camOn
											? "手机未连接！相同局域网下扫码添加配对设备；若已配对过的手机，请在设置内点击本电脑端，激活为活动设备"
											: previewOff
												? "预览已关闭,在手机端重新开启后恢复"
												: "预览中",
									),
								),
								// ── version hints (plain colored lines, never dialogs) ──
								upd && upd.updateAvailable
									? h("div", { className: "lm-updwarn", key: "upd" }, `⬆ 电脑端有新版本 v${upd.latest} — 请在 设置 → 插件市场 更新`)
									: null,
								(() => {
									// cross-end consistency: the phone reports its App version
									// in hello; a mismatch (both ends known) warms the line
									const app = (devices || []).find((d) => d.active)?.appVersion;
									if (!app) return null;
									const host = upd && upd.current;
									if (host && app !== host) {
										return h("div", { className: "lm-appver mismatch", key: "appver" }, `手机 App v${app} 与电脑端 v${host} 版本不一致,建议两端同时更新`);
									}
									return h("div", { className: "lm-appver", key: "appver" }, `手机 App v${app}`);
								})(),
								devices && devices.length > 1
									? h(
											"div",
											{ className: "lm-devices" },
											devices.map((d) =>
												h(
													"button",
													{ key: d.id, className: "lm-device" + (d.active ? " active" : ""), onClick: () => selectDevice(d.id), onDoubleClick: () => renameDevice(d.id, d.name), title: "单击切换 · 双击重命名" },
													(d.active ? "● " : "○ ") + d.name,
												),
											),
										)
									: null,
							pending && pending.length
								? h(
										"div",
										{ className: "lm-pending" },
										h("span", { className: "lm-pending-label" }, `待发图 ×${pending.length}:`),
										pending.map((p) =>
											h(
												"div",
												{ key: p.id, className: "lm-row" },
												h("span", { style: { fontSize: 11, color: "#7d8da0", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, p.name || p.id.slice(0, 8)),
												h(
													"button",
													{ className: "lm-btn", onClick: () => void stageIntoComposer(hostCtx, port, p.id).then(() => { setPending((prev) => prev.filter((x) => x.id !== p.id)); setFlashOk("已放入输入框"); }).catch((e) => setFlashErr("放入失败: " + String(e && e.message || e).slice(0, 90))) },
													"放入输入框",
												),
											),
										),
									)
								: null,
								h(
									"div",
									{ className: "lm-row" },
									h("button", { className: "lm-btn primary", disabled: !camOn || previewOff, onClick: shoot }, "◉ 拍照并注入"),
									h("button", { className: "lm-btn", onClick: manualRefreshQr, title: "作废当前配对码并生成新码" }, "↻ 二维码"),
								),
								!camOn
									? h(
											"div",
											{ className: "lm-qr" },
											qr && qr.pngDataUrl ? h("img", { src: qr.pngDataUrl, alt: "配对二维码" }) : h("div", { className: "hint" }, "二维码加载中…"),
											qr ? h("div", { className: "code" }, qr.code) : null,
											h(
												"div",
												{ className: "hint" },
												"手机 App 扫码配对;或在 App 内手动输入",
												h("br", null),
												qr && qr.urls && qr.urls[0] ? `${qr.urls[0].replace("http://", "")}:${qr.code}` : "",
												h("br", null),
												qr
													? (() => {
															const s = Math.max(0, Math.floor((qr.expiresAt - Date.now()) / 1000));
															return s > 0
																? `有效期剩余 ${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")} · 到期自动更新`
																: "已到期,正在自动更新…";
														})()
													: "",
											),
									h("a", { className: "lm-dl", href: "#", onClick: (e) => { e.preventDefault(); void openAppQr(); }, title: "弹出二维码,手机扫码下载" }, "手机还没装 App？点此扫码下载"),
										)
									: null,
								h("span", { className: `lm-flash${flash.startsWith("已") ? " ok" : ""}` }, flash),
								h(
									"div",
									{ className: "lm-row" },
									h("button", { className: "lm-btn", onClick: () => { const next = !settingsOpen; setSettingsOpen(next); if (next) void loadAppSt(); } }, settingsOpen ? "▲ 收起设置" : "⚙ 设置"),
								),
								settingsOpen
									? h(
											"div",
											{ className: "lm-settings" },
											appSt
												? [
														h("div", { className: "lm-setlabel" }, "拍照模式"),
														...SAVE_MODES.map((m) =>
															h(
																"button",
																{
																	key: m.id,
																	className: "lm-mode" + (appSt.saveMode === m.id ? " selected" : ""),
																	onClick: () => {
																		if (appSt.saveMode === m.id) return;
																		void saveAppSt({ saveMode: m.id }).then((ok) => ok && setFlashOk(m.flash));
																	},
																},
																h("span", { className: "dot" }),
																h(
																	"span",
																	{ className: "txt" },
																	h("span", { className: "t" }, m.title),
																	h("span", { className: "d" }, m.desc),
																),
															),
														),
														appSt.saveMode !== "composer"
															? h(
																	"div",
																	{ className: "lm-setrow" },
																	h("input", { value: dirDraft, onChange: (e) => setDirDraft(e.target.value), onKeyDown: (e) => e.key === "Enter" && saveDirDraft(), placeholder: "保存文件夹的绝对路径(手输或粘贴)" }),
																	h("button", { className: "lm-btn", style: { flex: "none" }, onClick: saveDirDraft }, "保存"),
																)
															: null,
														appSt.saveMode !== "composer"
															? h("div", { className: "lm-sethint" }, `留空路径即恢复默认目录: ${appSt.effectiveSaveDir}`)
															: null,
													]
												: h("div", { className: "lm-sethint" }, "设置服务不可用(电脑端版本较旧),仅可调整端口。"),
											h(
												"div",
												{ className: "lm-port" },
												"接收端口",
												h("input", { value: portDraft, onChange: (e) => setPortDraft(e.target.value), onKeyDown: (e) => e.key === "Enter" && savePort(), inputMode: "numeric" }),
												h("button", { className: "lm-btn", style: { flex: "none", padding: "3px 8px" }, onClick: savePort }, "切换"),
											),
										)
									: null,
							),
						)
					: null,
				h(
					"button",
					{ className: "lm-fab" + (link === "connected" ? " connected" : link === "connecting" ? " connecting" : " disconnected"), style: { position: "relative" }, onClick: () => setOpen(!open), title: "PhoneLens 直连取景" },
					h(CameraIcon, { state: link }),
				),
				rename
					? h(
							"div",
							{ className: "lm-rename" },
							h("div", { className: "lm-rename-title" }, "重命名设备"),
							h("input", { className: "lm-rename-input", value: rename.name, onChange: (e) => setRename({ ...rename, name: e.target.value }), onKeyDown: (e) => e.key === "Enter" && confirmRename(), autoFocus: true }),
							h(
								"div",
								{ className: "lm-row" },
								h("button", { className: "lm-btn", onClick: () => setRename(null) }, "取消"),
								h("button", { className: "lm-btn primary", onClick: confirmRename }, "确定"),
							),
						)
					: null,
				appQr
					? h(
							"div",
							{ className: "lm-appqr" },
							h("div", { className: "lm-appqr-title" }, "扫码下载 PhoneLens App"),
							appQr.loading
								? h("div", { className: "lm-appqr-hint" }, "二维码生成中…")
								: appQr.pngDataUrl
									? h("img", { className: "lm-appqr-img", src: appQr.pngDataUrl, alt: "App 下载二维码" })
									: h("div", { className: "lm-appqr-hint" }, "二维码暂不可用,请使用下方链接"),
							h("div", { className: "lm-appqr-hint" }, appQr.fallback ? "手机端请通过以下链接下载 APK" : "手机扫码直接下载 Android APK(默认 Gitee 国内源)"),
							h(
								"div",
								{ className: "lm-appqr-links" },
								h("a", { href: appQr.gitee || APP_GITEE, target: "_blank", rel: "noopener" }, "Gitee 国内源"),
								h("span", null, "·"),
								h("a", { href: appQr.github || APP_GITHUB, target: "_blank", rel: "noopener" }, "GitHub 国际源"),
							),
							h("div", { className: "lm-row", style: { width: "100%" } }, h("button", { className: "lm-btn", onClick: () => setAppQr(null) }, "关闭")),
						)
					: null,
			);
		}

		// ── settings.section — the official settings-page panel ───────────────
		// Privacy-bearing switches live here with an honest description of what
		// the model can do and where photos go. The high-frequency capture-mode
		// settings stay in the overlay ⚙ panel on purpose (switched constantly).
		function currentLensPort() {
			try {
				return window.localStorage.getItem(PORT_KEY) || "8791";
			} catch {
				return "8791";
			}
		}

		// Custom switch per the DSH settings-row recipe: a real checkbox (native
		// semantics + focus) driving a styled track/thumb — 36×20 track, 14px
		// thumb, primary fill when checked. Sizes/tokens mirror dsh-better-sidebar.
		function LensSwitch({ checked, onChange }) {
			return h(
				"label",
				{ className: "lm-set-switch" },
				h("input", {
					type: "checkbox",
					checked: !!checked,
					onChange: (e) => onChange(e.target.checked),
				}),
				h("span", { className: "lm-set-track", "aria-hidden": "true" }, h("span", { className: "lm-set-thumb" })),
			);
		}

		// One settings row: title/desc on the left, control on the right.
		function LensSetRow({ title, desc, children }) {
			return h(
				"div",
				{ className: "lm-set-row" },
				h(
					"span",
					{ className: "lm-set-rowtext" },
					h("span", { className: "lm-set-rowtitle" }, title),
					desc ? h("span", { className: "lm-set-rowdesc" }, desc) : null,
				),
				h("span", { className: "lm-set-control" }, children),
			);
		}

		function LensSettingsSection() {
			const [st, setSt] = useState(undefined); // undefined=loading, false=unavailable, object=live
			const [flash, setFlash] = useState("");

			useEffect(() => {
				let alive = true;
				void (async () => {
					try {
						const r = await fetch(`http://127.0.0.1:${currentLensPort()}/app-settings`, { cache: "no-store" });
						if (!r.ok) throw new Error(String(r.status));
						const data = await r.json();
						if (alive) setSt(data);
					} catch {
						if (alive) setSt(false);
					}
				})();
				return () => {
					alive = false;
				};
			}, []);

			async function patch(p) {
				try {
					const r = await fetch(`http://127.0.0.1:${currentLensPort()}/app-settings`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(p),
					});
					if (!r.ok) throw new Error("HTTP " + r.status);
					setSt(await r.json());
					setFlash("已保存");
					setTimeout(() => setFlash(""), 1800);
				} catch (e) {
					setFlash("保存失败: " + String((e && e.message) || e).slice(0, 60));
				}
			}

			const infoRow = (title, desc, key) =>
				h(
					"div",
					{ className: "lm-set-row", key },
					h(
						"span",
						{ className: "lm-set-rowtext" },
						h("span", { className: "lm-set-rowtitle" }, title),
						h("span", { className: "lm-set-rowdesc" }, desc),
					),
				);

			return h(
				"div",
				{ className: "lm-setsec" },
				h(
					"div",
					{ className: "lm-setsec-head" },
					h("span", { className: "lm-setsec-headtitle" }, "PhoneLens 手机相机"),
					h("span", { className: "lm-setsec-badge" }, "phone-lens"),
				),
				h("div", { className: "lm-setsec-intro" }, "管理对话中模型对本机手机相机的调用能力与隐私行为。"),
				st === undefined
					? h("div", { className: "lm-setsec-note" }, "加载中…")
					: st === false
						? h("div", { className: "lm-setsec-note" }, "设置服务不可用(需电脑端 phone-lens ≥ 1.0.4)")
						: [
								h(
									"div",
									{ className: "lm-setsec-card", key: "privacy" },
									h("div", { className: "lm-setsec-cardhead" }, "隐私开关"),
									h(
										"div",
										{ className: "lm-setsec-rows" },
										h(LensSetRow, {
											key: "t1",
											title: "启用模型相机工具",
											desc: "关闭后模型调用会被拒绝,手机摄像头完全由你自己控制",
										}, h(LensSwitch, { checked: st.modelToolsEnabled, onChange: (v) => void patch({ modelToolsEnabled: v }) })),
										h(LensSetRow, {
											key: "t2",
											title: "模型免确认调用",
											desc: "开启时模型调用不弹确认框;关闭后每次调用需你在弹窗中确认(若宿主不支持审批弹窗,则视为拒绝)",
										}, h(LensSwitch, { checked: st.modelToolsConfirmFree, onChange: (v) => void patch({ modelToolsConfirmFree: v }) })),
										// pointer to the high-frequency settings, parked INSIDE
										// the toggles card (user-requested placement)
										h(
											"div",
											{ className: "lm-set-row", key: "ft" },
											h("span", { className: "lm-set-rowtext" }, h("span", { className: "lm-set-rowdesc" }, "高频的「拍照注入模式 / 保存目录」设置仍在右下角悬浮窗 ⚙ 面板")),
										),
									),
								),
								h(
									"div",
									{ className: "lm-setsec-card", key: "what" },
									h("div", { className: "lm-setsec-cardhead" }, "打开上述开关后,对话内模型将被允许:"),
									h(
										"div",
										{ className: "lm-setsec-rows" },
										// tool names in the open (user-requested): what the
										// model will actually see in its tool list
										infoRow("拍摄照片(phone_take_photo)", "手机立即拍照,照片直接进入模型视野——不放入输入框、不保存到电脑文件夹,与拍照注入模式设置无关。", "w1"),
										infoRow("关闭手机摄像头(phone_camera_pause)", "让手机相机提前进入空闲省电状态。", "w2"),
										infoRow("恢复手机摄像头(phone_camera_resume)", "立即打开相机并恢复预览拍摄。", "w3"),
									),
								),
								flash ? h("div", { className: "lm-setsec-note", key: "f" }, flash) : null,
							],
			);
		}

		// ── settings nav icon ─────────────────────────────────────────────────
		// settings.section alone yields the nav row; this paints a camera icon
		// onto it with the same CSS-mask trick dshmarket uses (mark the row
		// whose text matches our label, inject a ::before mask).
		const LENS_NAV_SVG =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3.5"/></svg>';

		function installSettingsNavIcon(ctx, resolveLabel) {
			if (typeof document === "undefined") return;
			const MARKER = "data-phone-lens-nav-icon";
			const SELECTOR = '[role="dialog"] nav button';
			const maskUrl = `data:image/svg+xml,${encodeURIComponent(LENS_NAV_SVG)}`;
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "phone-lens";
				tag.textContent = [
					`[${MARKER}] > svg { display: none; }`,
					`[${MARKER}]::before {`,
					`  content: '';`,
					`  flex: none;`,
					`  width: 16px;`,
					`  height: 16px;`,
					`  background-color: currentColor;`,
					`  -webkit-mask-image: url("${maskUrl}");`,
					`  mask-image: url("${maskUrl}");`,
					`  -webkit-mask-repeat: no-repeat;`,
					`  mask-repeat: no-repeat;`,
					`  -webkit-mask-position: center;`,
					`  mask-position: center;`,
					`  -webkit-mask-size: 16px 16px;`,
					`  mask-size: 16px 16px;`,
					`}`,
				].join("\n");
				document.head.appendChild(tag);
				let disposed = false;
				let scheduled = false;
				const sync = () => {
					scheduled = false;
					if (disposed) return;
					// cheap early-out: the settings dialog isn't even mounted — skip
					// the querySelectorAll sweep while chat tokens stream in
					if (!document.querySelector('[role="dialog"] nav')) return;
					const wanted = resolveLabel();
					for (const row of document.querySelectorAll(SELECTOR)) {
						if ((row.textContent || "").trim() === wanted) row.setAttribute(MARKER, "");
						else row.removeAttribute(MARKER);
					}
				};
				const schedule = () => {
					if (scheduled || disposed) return;
					scheduled = true;
					queueMicrotask(sync);
				};
				sync();
				const observer = new MutationObserver(schedule);
				observer.observe(document.body, { childList: true, subtree: true, characterData: true });
				return () => {
					disposed = true;
					observer.disconnect();
					for (const row of document.querySelectorAll(`[${MARKER}]`)) row.removeAttribute(MARKER);
					tag.remove();
				};
			}, "phone-lens: settings nav icon");
		}

		// ── plugin face ───────────────────────────────────────────────────────
		const inject = ["slots"];
		function apply(ctx) {
			hostCtx = ctx;
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{ name: "shell.overlay", id: "phone-lens.overlay", order: 100, label: () => "PhoneLens" },
					LensOverlay,
				),
			);
			// official settings page: additive section — the host renders it as a
			// dedicated entry in the settings dialog's left nav (same as dshmarket)
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{ name: "settings.section", id: "phone-lens", order: 50, label: () => "PhoneLens" },
					() => h(LensSettingsSection),
				),
			);
			installSettingsNavIcon(ctx, () => "PhoneLens");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
