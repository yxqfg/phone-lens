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
		// Floating-ball geometry (localStorage, pure client preference):
		//   { mode: "corner"|"free", corner: "tl"|"tr"|"bl"|"br", x, y, size, locked }
		// null/absent = factory default (bottom-right corner, standard size,
		// draggable). The settings page and the overlay sync through the
		// FAB_EV CustomEvent so both stay live without a host round-trip.
		const FAB_KEY = "phoneLens.fab";
		const FAB_EV = "phone-lens:fab-changed";
		// port edits from the settings page push the overlay to re-point its
		// URLs without a page reload
		const PORT_EV = "phone-lens:port-changed";
		const FAB_SIZES = [
			{ id: "s", label: "小", px: 38 },
			{ id: "m", label: "标准", px: 46 },
			{ id: "l", label: "大", px: 58 },
		];
		function loadFabSt() {
			try {
				const v = JSON.parse(window.localStorage.getItem(FAB_KEY) || "null");
				if (!v || typeof v !== "object") return null;
				if (v.mode !== "free" && v.mode !== "corner") return null;
				return v;
			} catch {
				return null;
			}
		}
		function saveFabSt(v) {
			try {
				if (v) window.localStorage.setItem(FAB_KEY, JSON.stringify(v));
				else window.localStorage.removeItem(FAB_KEY);
				window.dispatchEvent(new CustomEvent(FAB_EV));
			} catch {}
		}
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
.lm-root { position: fixed; right: 16px; bottom: 16px; z-index: 9999; font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; --fab-size: 46px; }
/* corner anchors (settings-page selectable); .lm-root default = bottom-right */
.lm-corner-tl { left: 16px; top: 16px; right: auto; bottom: auto; }
.lm-corner-tr { right: 16px; top: 16px; left: auto; bottom: auto; }
.lm-corner-bl { left: 16px; bottom: 16px; right: auto; top: auto; }
.lm-corner-br { right: 16px; bottom: 16px; left: auto; top: auto; }
.lm-fab { width: var(--fab-size); height: var(--fab-size); border-radius: 50%; border: 1px solid #3b7cb5; background: linear-gradient(160deg, #2a5d8f, #1d3f61); color: #eaf2fa; font-size: 20px; line-height: 1; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.45); touch-action: none; user-select: none; -webkit-user-select: none; }
.lm-fab:hover { filter: brightness(1.15); }
.lm-fab.dragging { cursor: grabbing; filter: brightness(1.25); transition: box-shadow .15s ease; }
.lm-fab .dot { position: absolute; top: 8%; right: 8%; width: 17%; height: 17%; border-radius: 50%; background: #e5484d; }
.lm-fab .dot.on { background: #46a758; }
.lm-panel { position: absolute; right: 0; bottom: 56px; width: 268px; background: #14181d; border: 1px solid #2a333e; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.55); color: #dfe7ee; overflow: hidden auto; max-height: calc(100vh - 110px); }
/* popup anchoring: the JS picks a variant from the FAB's on-screen position
   (and the panel's measured height) so the card opens toward free space no
   matter where the button was dragged; defaults above stay as the no-JS fallback. */
.lm-root .lm-anchor-up-right { right: 0; bottom: calc(var(--fab-size, 46px) + 10px); left: auto; top: auto; }
.lm-root .lm-anchor-up-left { left: 0; bottom: calc(var(--fab-size, 46px) + 10px); right: auto; top: auto; }
.lm-root .lm-anchor-down-right { right: 0; top: calc(var(--fab-size, 46px) + 10px); left: auto; bottom: auto; }
.lm-root .lm-anchor-down-left { left: 0; top: calc(var(--fab-size, 46px) + 10px); right: auto; bottom: auto; }
@keyframes lm-pop-up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes lm-pop-down { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
.lm-panel, .lm-rename, .lm-appqr, .lm-dirpick { animation: lm-pop-up .16s ease; }
.lm-anchor-down-right.lm-panel, .lm-anchor-down-right.lm-rename, .lm-anchor-down-right.lm-appqr, .lm-anchor-down-right.lm-dirpick,
.lm-anchor-down-left.lm-panel, .lm-anchor-down-left.lm-rename, .lm-anchor-down-left.lm-appqr, .lm-anchor-down-left.lm-dirpick { animation-name: lm-pop-down; }
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
.lm-rename { position: absolute; right: 0; bottom: 56px; width: 268px; background: #14181d; border: 1px solid #2a333e; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.6); padding: 12px; display: flex; flex-direction: column; gap: 8px; z-index: 5; }.lm-rename-title { font-size: 13px; color: #dfe7ee; font-weight: 600; }
.lm-rename-input { background: #0d1117; color: #dfe7ee; border: 1px solid #2f3b48; border-radius: 8px; padding: 8px; font-size: 13px; }
.lm-appqr { position: absolute; right: 0; bottom: 56px; width: 268px; background: #14181d; border: 1px solid #2a333e; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.6); padding: 12px; display: flex; flex-direction: column; align-items: center; gap: 8px; z-index: 6; }
.lm-appqr-title { font-size: 13px; color: #dfe7ee; font-weight: 600; }
.lm-appqr-img { width: 168px; height: 168px; image-rendering: pixelated; background: #fff; border-radius: 8px; }
.lm-appqr-hint { font-size: 10px; color: #7d8da0; text-align: center; line-height: 1.45; }
.lm-appqr-links { font-size: 11px; display: flex; gap: 5px; align-items: center; color: #7d8da0; }
.lm-appqr-links a { color: #3b7cb5; text-decoration: none; }
.lm-appqr-links a:hover { text-decoration: underline; }
/* folder picker (browser-style save-folder dialog, host lists the dirs) */
.lm-dirpick { position: absolute; right: 0; bottom: 56px; width: 300px; background: #14181d; border: 1px solid #2a333e; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.6); padding: 10px; display: flex; flex-direction: column; gap: 8px; z-index: 7; }
.lm-dirpick-title { font-size: 13px; color: #dfe7ee; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.lm-dirpick-title .x { margin-left: auto; background: none; border: none; color: #8fa1b5; cursor: pointer; font-size: 14px; }
.lm-dirpick-crumbs { display: flex; gap: 4px; align-items: center; font-size: 11px; color: #7d8da0; }
.lm-dirpick-crumbs button { background: none; border: none; color: #3b7cb5; cursor: pointer; font-size: 11px; padding: 0; }
.lm-dirpick-crumbs button:hover { text-decoration: underline; }
.lm-dirpick-list { max-height: 240px; min-height: 120px; overflow-y: auto; border: 1px solid #232c36; border-radius: 8px; background: #0d1117; display: flex; flex-direction: column; }
.lm-dirpick-item { display: flex; align-items: center; gap: 7px; padding: 6px 9px; font-size: 12px; color: #dfe7ee; cursor: pointer; border: none; background: none; text-align: left; }
.lm-dirpick-item:hover { background: #1f2937; }
.lm-dirpick-item.special { color: #8fa1b5; }
.lm-dirpick-item .fdico { flex: none; color: #d9a441; }
.lm-dirpick-empty { padding: 14px 10px; font-size: 11px; color: #7d8da0; text-align: center; line-height: 1.5; }
.lm-dirpick-err { padding: 8px 10px; font-size: 11px; color: #e5696e; line-height: 1.5; word-break: break-all; }
.lm-dirpick-foot { font-size: 10px; color: #7d8da0; word-break: break-all; line-height: 1.45; }
.lm-dirpick-roots { display: flex; flex-wrap: wrap; gap: 4px; }
.lm-dirpick-roots button { padding: 2px 8px; border-radius: 10px; border: 1px solid #2f3b48; background: #1f2937; color: #8fa1b5; font-size: 11px; cursor: pointer; }
.lm-dirpick-roots button:hover { color: #dfe7ee; }
/* settings-page segmented control (size / corner pickers) */
.lm-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.14)); border-radius: 9px; overflow: hidden; }
.lm-seg button { padding: 5px 12px; font-size: 12px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #9fb0c0); cursor: pointer; }
.lm-seg button + button { border-left: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.08)); }
.lm-seg button.on { background: var(--dsw-alias-button-primary-fill, #3b82f6); color: #fff; }
.lm-seg button:not(.on):hover { color: var(--dsw-alias-label-primary, #e6edf5); }
.fab-cam { display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
.fab-cam svg { display: block; width: 58%; height: 58%; }
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
					{ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" },
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
				const [previewOffline, setPreviewOffline] = useState(false); // host flagged the LINK itself dead (wifi drop, no frames AND no keepalive) — not a preview toggle
				const [settingsOpen, setSettingsOpen] = useState(false); // collapsible settings section under the main card
				const [appSt, setAppSt] = useState(null); // {saveMode, saveDir, effectiveSaveDir} | null (null = host too old)
				const [dirDraft, setDirDraft] = useState("");
				// ── floating-ball geometry (draggable / sized / lockable) ──
				const [fabSt, setFabSt] = useState(loadFabSt); // null = factory default (corner br)
				const [anchor, setAnchor] = useState("up-right"); // popup direction, recomputed on open/move
				const [dragging, setDragging] = useState(false);
				const [dirPick, setDirPick] = useState(null); // folder picker state (see openDirPick)
				const canvasRef = useRef(null);
				const rootRef = useRef(null);
				const panelRef = useRef(null);
				const dragRef = useRef(null); // active pointer drag { sx, sy, ox, oy, moved, id }
				const clickGuard = useRef(false); // a finished drag must not toggle the panel via the trailing click
			const lastQrCode = useRef(null); // last pairing code seen — detects auto rotation for the "已更新" flash
			const wsRef = useRef(null);
			const framesRef = useRef(0);
			const rotRef = useRef(0);
			// last devices-broadcast length — the onmessage closure never re-runs
			// (the WS effect depends only on wsUrl), so comparing against the
			// `devices` STATE there read a stale first-render value and fired the
			// QR-rotation flash on EVERY broadcast instead of only on growth
			const lastDeviceCount = useRef(0);

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
							// host-derived: the ACTIVE phone's stream stopped — either the
							// user turned preview off in the app (keepalive still alive) or
							// the link itself died (no frames AND no keepalive for 25s →
							// reason:"offline"). Old hosts never send `reason` → legacy
							// behavior is kept bit-for-bit.
							setPreviewOff(!m.on);
							setPreviewOffline(!m.on && m.reason === "offline");
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
							// StrictMode double-invokes them); compare against the ref,
							// NOT the `devices` state (stale-closure trap), then setState
							const grew = (m.devices || []).length > lastDeviceCount.current;
							lastDeviceCount.current = (m.devices || []).length;
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
						} else if (m.type === "paired") {
							// a phone completed /pair — the one-time pairing code burned
							// with it. Rotate the QR right now; the devices-list growth
							// path also rotates, but only once the uplink actually lands.
							setFlashOk(`设备已配对${m.name ? ": " + m.name : ""},二维码已更换`);
							void refreshQr(true);
						} else if (m.type === "error") {
							setFlashErr(`${m.code}${m.message ? ":" + m.message : ""}`);
						}
					};
						ws.onclose = () => {
							setCamOn(false);
							setPreviewOff(false);
							setPreviewOffline(false);
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

			// settings-page edits to the ball geometry arrive via FAB_EV — adopt
			// them live (both components share one localStorage but no React tree)
			useEffect(() => {
				const onFab = () => setFabSt(loadFabSt());
				window.addEventListener(FAB_EV, onFab);
				return () => window.removeEventListener(FAB_EV, onFab);
			}, []);

			// a free-positioned ball can end up off-screen after the window
			// shrinks (or devtools opens) — clamp it back inside on every resize
			useEffect(() => {
				if (!fabSt || fabSt.mode !== "free") return;
				const onResize = () => {
					const size = fabSt.size || 46;
					const x = Math.min(Math.max(fabSt.x, 4), Math.max(4, window.innerWidth - size - 4));
					const y = Math.min(Math.max(fabSt.y, 4), Math.max(4, window.innerHeight - size - 4));
					if (x !== fabSt.x || y !== fabSt.y) setFabSt({ ...fabSt, x, y });
				};
				onResize();
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, [fabSt]);

			// popup direction: open toward free space, decided from the ball's
			// position AND the panel's measured height (re-run when the content
			// grows — settings section, QR card, pending list). The 268px panel
			// width pairs with a fixed 10px gap (see the .lm-anchor-* rules).
			useEffect(() => {
				if (!open && !rename && !appQr && !dirPick) return;
				const root = rootRef.current;
				if (!root) return;
				const r = root.getBoundingClientRect();
				const ph = Math.max(panelRef.current?.offsetHeight || 420, 200);
				const above = r.top;
				const below = window.innerHeight - r.bottom;
				const vertical = above >= ph + 12 || above >= below ? "up" : "down";
				// NOTE the class semantics: "-right" = the panel's RIGHT edge sticks
				// to the ball → it opens LEFTWARD (needs room on the left); "-left"
				// opens RIGHTWARD. So the side with MORE room wins the opposite name:
				// ball hugging the left edge (rightRoom big) → "left" (opens right).
				const leftRoom = r.left;
				const rightRoom = window.innerWidth - r.right;
				const horizontal = leftRoom > rightRoom ? "right" : "left";
				setAnchor(`${vertical}-${horizontal}`);
			}, [open, rename, appQr, dirPick, settingsOpen, camOn, previewOff, Boolean(qr), pending.length, fabSt]);

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
			// port now lives in the settings page; edits arrive via PORT_EV so
			// the overlay re-points baseUrl/wsUrl without a reload
			useEffect(() => {
				const onPort = () => {
					try {
						setPort(window.localStorage.getItem(PORT_KEY) || "8791");
					} catch {}
				};
				window.addEventListener(PORT_EV, onPort);
				return () => window.removeEventListener(PORT_EV, onPort);
			}, []);

			// ── floating-ball drag ──────────────────────────────────────────────
			// Pointer capture keeps the drag alive outside the window; a 5px
			// threshold separates click (toggle panel) from drag (reposition);
			// locked balls never drag. Position commits to localStorage on
			// pointerup only — the moves just setState.
			const fabSize = (fabSt && fabSt.size) || 46;
			const fabPosRef = useRef(null); // live free-position during the current drag

			function onFabPointerDown(e) {
				if (fabSt && fabSt.locked) return;
				if (e.pointerType === "mouse" && e.button !== 0) return;
				const rect = rootRef.current ? rootRef.current.getBoundingClientRect() : null;
				if (!rect) return;
				try {
					e.currentTarget.setPointerCapture(e.pointerId);
				} catch {}
				dragRef.current = { sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top, moved: false, id: e.pointerId };
			}
			function onFabPointerMove(e) {
				const d = dragRef.current;
				if (!d || e.pointerId !== d.id) return;
				const dx = e.clientX - d.sx;
				const dy = e.clientY - d.sy;
				if (!d.moved && Math.hypot(dx, dy) < 5) return;
				if (!d.moved) {
					d.moved = true;
					setDragging(true);
				}
				const size = (fabSt && fabSt.size) || 46;
				const x = Math.min(Math.max(d.ox + dx, 4), Math.max(4, window.innerWidth - size - 4));
				const y = Math.min(Math.max(d.oy + dy, 4), Math.max(4, window.innerHeight - size - 4));
				fabPosRef.current = { x, y };
				setFabSt((prev) => ({ mode: "free", x, y, size: (prev && prev.size) || 46, locked: false }));
			}
			function onFabPointerEnd(e) {
				const d = dragRef.current;
				if (!d || e.pointerId !== d.id) return;
				dragRef.current = null;
				setDragging(false);
				if (d.moved && fabPosRef.current) {
					clickGuard.current = true; // swallow the trailing click
					saveFabSt({ mode: "free", x: fabPosRef.current.x, y: fabPosRef.current.y, size: (fabSt && fabSt.size) || 46, locked: false });
				}
			}
			function onFabClick() {
				if (clickGuard.current) {
					clickGuard.current = false;
					return;
				}
				setOpen(!open);
			}

			// ── save-folder picker (the host walks the tree; a web page cannot
			// learn absolute paths on its own — see /fs/dirs) ───────────────────
			async function browseDirs(path) {
				setDirPick({ loading: true, path: path || "", dirs: [], roots: [], parent: null });
				try {
					const r = await fetch(`${baseUrl}/fs/dirs?path=${encodeURIComponent(path || "")}`, { cache: "no-store" });
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					setDirPick(await r.json());
				} catch (e) {
					setDirPick({ error: "读取目录失败: " + String((e && e.message) || e).slice(0, 80), dirs: [], roots: [], path: path || "", parent: null });
				}
			}
			function openDirPick() {
				void browseDirs(dirDraft || "");
			}
			function chooseDir() {
				const p = dirPick && dirPick.path;
				if (!p) return;
				setDirDraft(p);
				setDirPick(null);
				void saveAppSt({ saveDir: p }).then((ok) => ok && setFlashOk(`保存目录已设置: ${p}`));
			}

			// root geometry: corner mode via CSS class (survives any window
			// size), free mode via inline px (clamped on resize)
			const fabClass = "lm-root" + (fabSt && fabSt.mode === "corner" ? ` lm-corner-${fabSt.corner || "br"}` : "");
			const fabStyle = { "--fab-size": `${fabSize}px` };
			if (fabSt && fabSt.mode === "free") {
				fabStyle.left = `${fabSt.x}px`;
				fabStyle.top = `${fabSt.y}px`;
				fabStyle.right = "auto";
				fabStyle.bottom = "auto";
			}
			return h(
				"div",
				{ className: fabClass, style: fabStyle, ref: rootRef },
				open
					? h(
							"div",
							{ className: `lm-panel lm-anchor-${anchor}`, ref: panelRef },
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
								// frame and say so instead of freezing on a stale picture.
								// previewOffline = the host proved the LINK died (no frames AND
								// no keepalive 25s): say "connection lost", never "preview off"
								camOn && !previewOff
									? h("canvas", { ref: canvasRef, className: "lm-canvas", width: 360, height: 640 })
									: camOn && previewOff
										? h("div", { className: "lm-preview-off" }, previewOffline ? "与手机的连接已中断(设备离线)" : "您在手机端已关闭预览功能")
										: null,
								h(
									"div",
									{ className: "lm-status" },
									h("span", null, camOn && !previewOff && fps > 0 ? `${fps} fps` : "—"),
									h(
										"span",
										{ className: !camOn || previewOffline ? "warn-big" : previewOff ? "warn" : "" },
										!camOn
											? "手机未连接！相同局域网下扫码添加配对设备；若已配对过的手机，请在设置内点击本电脑端，激活为活动设备"
											: previewOffline
												? "连接已断开(手机离线),请检查手机网络;网络恢复后将自动重连"
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
																	h("input", { value: dirDraft, onChange: (e) => setDirDraft(e.target.value), onKeyDown: (e) => e.key === "Enter" && saveDirDraft(), placeholder: "保存文件夹(可浏览选择,或手输/粘贴)" }),
																		h("button", { className: "lm-btn", style: { flex: "none" }, onClick: openDirPick, title: "浏览电脑文件夹选择" }, "浏览…"),
																		h("button", { className: "lm-btn", style: { flex: "none" }, onClick: saveDirDraft }, "保存"),
																)
															: null,
														appSt.saveMode !== "composer"
															? h("div", { className: "lm-sethint" }, `留空路径即恢复默认目录: ${appSt.effectiveSaveDir}`)
															: null,
													]
													: h("div", { className: "lm-sethint" }, "设置服务不可用(电脑端版本较旧),请更新后再调整拍照模式与保存目录;端口设置在 设置 → PhoneLens 内。"),
										)
									: null,
							),
						)
					: null,
				h(
					"button",
					{
						className: "lm-fab" + (link === "connected" ? " connected" : link === "connecting" ? " connecting" : " disconnected") + (dragging ? " dragging" : ""),
						style: { position: "relative" },
						onClick: onFabClick,
						onPointerDown: onFabPointerDown,
						onPointerMove: onFabPointerMove,
						onPointerUp: onFabPointerEnd,
						onPointerCancel: onFabPointerEnd,
						title: fabSt && fabSt.locked ? "PhoneLens 直连取景(位置已锁定)" : "PhoneLens 直连取景(按住可拖动)",
					},
					h(CameraIcon, { state: link }),
				),
					rename
						? h(
								"div",
								{ className: `lm-rename lm-anchor-${anchor}` },
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
								{ className: `lm-appqr lm-anchor-${anchor}` },
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
				dirPick
					? h(
							"div",
							{ className: `lm-dirpick lm-anchor-${anchor}` },
							h(
								"div",
								{ className: "lm-dirpick-title" },
								"选择保存文件夹",
								h("button", { className: "x", onClick: () => setDirPick(null), title: "关闭" }, "✕"),
							),
							h(
								"div",
								{ className: "lm-dirpick-roots" },
								dirPick.parent ? h("button", { onClick: () => void browseDirs(dirPick.parent) }, "↑ 上一级") : null,
								dirPick.home && dirPick.home !== dirPick.path ? h("button", { onClick: () => void browseDirs(dirPick.home) }, "🏠 主目录") : null,
								(dirPick.roots || []).map((r) => h("button", { key: r, onClick: () => void browseDirs(r) }, r.replace(/\\/g, ""))),
							),
							h("div", { className: "lm-dirpick-crumbs", title: dirPick.path || "" }, dirPick.path || "(主目录)"),
							h(
								"div",
								{ className: "lm-dirpick-list" },
								dirPick.loading
									? h("div", { className: "lm-dirpick-empty" }, "读取中…")
									: dirPick.error
										? h("div", { className: "lm-dirpick-err" }, dirPick.error)
										: (dirPick.dirs || []).length
											? (dirPick.dirs || []).map((d) =>
													h(
														"button",
														{ key: d, className: "lm-dirpick-item", onClick: () => void browseDirs(/[\\/]$/.test(dirPick.path) ? dirPick.path + d : dirPick.path + "\\" + d) },
														h("span", { className: "fdico" }, "📁"),
														d,
													),
												)
											: h("div", { className: "lm-dirpick-empty" }, "此文件夹内没有子文件夹"),
							),
							h("div", { className: "lm-dirpick-foot" }, "将保存到: ", dirPick.path || "(主目录)"),
							h(
								"div",
								{ className: "lm-row", style: { width: "100%" } },
								h("button", { className: "lm-btn primary", disabled: !dirPick.path || dirPick.loading, onClick: chooseDir }, "选择此文件夹"),
								h("button", { className: "lm-btn", onClick: () => setDirPick(null) }, "取消"),
							),
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
			const [st, setSt] = useState(undefined); // host app-settings: undefined=loading, false=unavailable, object=live
			const [flash, setFlash] = useState("");
			const [fab, setFab] = useState(loadFabSt); // ball geometry (local, synced with the overlay via FAB_EV)
			const [portDraft, setPortDraft] = useState(currentLensPort);

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

			// the overlay drags the ball, this page edits it — stay in sync both ways
			useEffect(() => {
				const onFab = () => setFab(loadFabSt());
				window.addEventListener(FAB_EV, onFab);
				return () => window.removeEventListener(FAB_EV, onFab);
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

			// ball-geometry edit from THIS page: persist + broadcast (the overlay
			// adopts it through FAB_EV), and reflect locally
			function fabPatch(next) {
				saveFabSt(next);
				setFab(next || null);
			}
			function savePortDraft() {
				const p = String(portDraft).trim() || "8791";
				setPortDraft(p);
				try {
					window.localStorage.setItem(PORT_KEY, p);
					window.dispatchEvent(new CustomEvent(PORT_EV));
					setFlash("端口已保存");
					setTimeout(() => setFlash(""), 1800);
				} catch {}
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

			// segmented control: one pill, mutually exclusive options
			const seg = (options, currentId, onPick) =>
				h(
					"span",
					{ className: "lm-seg" },
					options.map((o) => h("button", { key: o.id, type: "button", className: o.id === currentId ? "on" : "", onClick: () => onPick(o.id) }, o.label)),
				);
			const CORNERS = [
				{ id: "tl", label: "左上" },
				{ id: "tr", label: "右上" },
				{ id: "bl", label: "左下" },
				{ id: "br", label: "右下" },
			];
			const fabSizeId = (() => {
				const px = (fab && fab.size) || 46;
				const hit = FAB_SIZES.find((s) => s.px === px);
				return hit ? hit.id : "m";
			})();
			const fabCornerId = fab && fab.mode === "corner" ? fab.corner || "br" : null;

			return h(
				"div",
				{ className: "lm-setsec" },
				h(
					"div",
					{ className: "lm-setsec-head" },
					h("span", { className: "lm-setsec-headtitle" }, "PhoneLens 手机相机"),
					h("span", { className: "lm-setsec-badge" }, "phone-lens"),
				),
				h("div", { className: "lm-setsec-intro" }, "管理对话中模型对本机手机相机的调用能力,以及悬浮球与接收服务的偏好设置。"),
				// ── card: model camera tools (host-backed) ──
				h(
					"div",
					{ className: "lm-setsec-card", key: "tools" },
					h("div", { className: "lm-setsec-cardhead" }, "模型相机工具"),
					h(
						"div",
						{ className: "lm-setsec-rows" },
						st === undefined
							? h("div", { className: "lm-setsec-note", style: { padding: "12px 16px" }, key: "loading" }, "加载中…")
							: st === false
								? h("div", { className: "lm-setsec-note", style: { padding: "12px 16px" }, key: "unavail" }, "设置服务不可用(需电脑端 phone-lens ≥ 1.0.4)")
								: [
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
										// tool names in the open (user-requested): what the
										// model will actually see in its tool list
										infoRow("拍摄照片(phone_take_photo)", "手机立即拍照,照片直接进入模型视野——不放入输入框、不保存到电脑文件夹,与拍照注入模式设置无关。", "w1"),
										infoRow("关闭手机摄像头(phone_camera_pause)", "让手机相机提前进入空闲省电状态。", "w2"),
										infoRow("恢复手机摄像头(phone_camera_resume)", "立即打开相机并恢复预览拍摄。", "w3"),
										infoRow("调整/查询变焦(phone_camera_zoom)", "按指定倍数(或步进)拉近/拉远手机镜头;不带参数调用即查询当前倍数与支持范围。超出设备范围自动收拢。", "w4"),
										infoRow("切换/查询镜头(phone_camera_lens)", "切换手机前置/后置摄像头;不带参数调用即查询当前使用的镜头与设备可用镜头。需手机端 ≥ 1.1.3。", "w5"),
										h(
											"div",
											{ className: "lm-set-row", key: "ft" },
											h("span", { className: "lm-set-rowtext" }, h("span", { className: "lm-set-rowdesc" }, "高频的「拍照注入模式 / 保存目录(可浏览选择文件夹)」设置仍在悬浮窗 ⚙ 面板")),
										),
									],
					),
				),
				// ── card: floating ball (pure client preference) ──
				h(
					"div",
					{ className: "lm-setsec-card", key: "fab" },
					h("div", { className: "lm-setsec-cardhead" }, "悬浮球"),
					h(
						"div",
						{ className: "lm-setsec-rows" },
						h(LensSetRow, { key: "f1", title: "大小", desc: "悬浮球的显示尺寸" }, seg(FAB_SIZES, fabSizeId, (id) => {
							const hit = FAB_SIZES.find((s) => s.id === id);
							if (!hit) return;
							fabPatch({ ...(fab || { mode: "corner", corner: "br" }), size: hit.px });
						})),
						h(LensSetRow, { key: "f2", title: "停靠位置", desc: fabCornerId ? "屏幕四角之一;也可直接按住悬浮球拖到任意位置" : "当前为自由位置(拖动悬浮球随时调整);选一角即可重新吸附" }, seg(CORNERS, fabCornerId, (id) => {
							fabPatch({ mode: "corner", corner: id, size: (fab && fab.size) || 46, locked: (fab && fab.locked) || false });
						})),
						h(LensSetRow, { key: "f3", title: "锁定位置", desc: "锁定后悬浮球不再响应拖拽,避免误拖" }, h(LensSwitch, { checked: !!(fab && fab.locked), onChange: (v) => fabPatch({ ...(fab || { mode: "corner", corner: "br", size: 46 }), locked: v }) })),
						h(
							"div",
							{ className: "lm-set-row", key: "f4" },
							h("span", { className: "lm-set-rowtext" }, h("span", { className: "lm-set-rowdesc" }, "恢复默认:右下角停靠 · 标准大小 · 可拖动")),
							h("button", { type: "button", className: "lm-seg", style: { cursor: "pointer" }, onClick: () => fabPatch(null) }, h("span", { style: { padding: "5px 12px", display: "inline-block", fontSize: 12 } }, "恢复默认")),
						),
					),
				),
				// ── card: connection ──
				h(
					"div",
					{ className: "lm-setsec-card", key: "conn" },
					h("div", { className: "lm-setsec-cardhead" }, "连接"),
					h(
						"div",
						{ className: "lm-setsec-rows" },
						h(LensSetRow, { key: "c1", title: "接收端口", desc: "phone-lens 接收服务监听的端口(默认 8791,多实例/端口冲突时调整)" },
							h("input", { value: portDraft, onChange: (e) => setPortDraft(e.target.value), onKeyDown: (e) => e.key === "Enter" && savePortDraft(), inputMode: "numeric", style: { width: 72, background: "var(--dsw-alias-bg-layer-2, rgba(255,255,255,.05))", color: "var(--dsw-alias-label-primary, #e6edf5)", border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.14))", borderRadius: 8, padding: "5px 8px", fontSize: 13 } }),
							h("button", { type: "button", onClick: savePortDraft, style: { marginLeft: 8, padding: "5px 12px", borderRadius: 8, border: "1px solid var(--dsw-alias-button-primary-fill, #3b82f6)", background: "var(--dsw-alias-button-primary-fill, #3b82f6)", color: "#fff", fontSize: 12, cursor: "pointer" } }, "保存"),
						),
					),
				),
				flash ? h("div", { className: "lm-setsec-note", key: "f" }, flash) : null,
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
