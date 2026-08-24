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
.fab-cam { display: inline-flex; align-items: center; justify-content: center; }
.fab-cam svg { display: block; }
@keyframes lm-blast { 0%,100% { background: #6cc0ff; box-shadow: 0 0 16px rgba(108,192,255,.9); } 50% { background: #2a6db8; box-shadow: 0 0 4px rgba(108,192,255,.2); } }
.lm-fab.connected { background: #1f2937; color: #46a758; }
.lm-fab.connecting { color: #ffffff; background: #6cc0ff; animation: lm-blast .5s ease-in-out 3; }
.lm-fab.disconnected { background: #23303c; color: #8fa1b5; }
.lm-status .warn-big { color: #d9a441; font-weight: 600; font-size: 11px; line-height: 1.4; white-space: normal; }
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
		// into the model: the user types text next and hits send. Uses the dsh
		// channel confirmed from source: sessions.scope(sessionId) → conversation
		// service → createDraftImages(files) → input.for(actx).addImages(ids).
		let hostCtx = null; // set in apply() so the component can reach the runtime

		function currentSessionId(ctx) {
			try {
				// cordis: accessing a service as a ctx property requires it in
				// `inject`; use ctx.get() instead (never throws for absent).
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

		async function stageIntoComposer(ctx, port, attachmentId) {
			if (!ctx) throw new Error("no runtime ctx (phone-lens host not wired)");
			const resp = await fetch(`http://127.0.0.1:${port}/pending/${attachmentId}`).catch((e) => { throw new Error("fetch pending: " + String(e)); });
			if (!resp.ok) throw new Error("pending fetch HTTP " + resp.status);
			const buf = await resp.arrayBuffer();
			const file = new File([buf], `phone-${attachmentId.slice(0, 8)}.jpg`, { type: "image/jpeg" });
			const sid = currentSessionId(ctx);
			if (!sid) throw new Error("no current session id");
			// scope-addressed: ctx.get('sessions').scope(sid) → scoped actx
			const sessions = ctx.get("sessions");
			const actx = sessions.scope(sid);
			if (!actx) throw new Error("no session scope for " + sid);
			const conv = actx.get("conversation");
			if (!conv) throw new Error("no conversation service in scope");
			const atts = conv.createDraftImages([file]);
			if (!atts || !atts.length) throw new Error("createDraftImages empty");
			const input = conv.input.for(actx);
			const ok = input.addImages(atts.map((a) => a.id));
			if (ok !== true) throw new Error("input.addImages rejected (busy admission?)");
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
			const [flash, setFlash] = useState("");
			const [pending, setPending] = useState([]); // [{id, name}] waiting to be staged
			const [devices, setDevices] = useState([]); // [{id,name,active}]
			const [rename, setRename] = useState(null); // {id, name} — self-drawn rename dialog
			const canvasRef = useRef(null);
			const wsRef = useRef(null);
			const framesRef = useRef(0);
			const rotRef = useRef(0);

			const baseUrl = `http://127.0.0.1:${port}`;
			const wsUrl = `ws://127.0.0.1:${port}/ws/view`;

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
									setFlashOk("照片已放入对话框输入框,输入文字后发送");
								})
								.catch((e) => setFlashErr("自动放入失败: " + String(e && e.message || e).slice(0, 90)));
						} else if (m.type === "devices") {
							setDevices(m.devices);
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

			async function refreshQr() {
				try {
					const r = await fetch(`${baseUrl}/qr.json`, { cache: "no-store" });
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					setQr(await r.json());
				} catch (e) {
					setFlashErr(`接收服务不可达(${String(e).slice(0, 60)})`);
				}
			}

			// pairing QR appears when the panel opens without a camera
			useEffect(() => {
				if (open && !camOn && !qr) void refreshQr();
			}, [open, camOn]);

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
								// only show the viewfinder canvas when a camera is actually
								// streaming; a disconnected phone left a big black rectangle
								camOn ? h("canvas", { ref: canvasRef, className: "lm-canvas", width: 360, height: 640 }) : null,
								h("div", { className: "lm-status" }, h("span", null, fps > 0 ? `${fps} fps` : "—"), h("span", { className: camOn ? "" : "warn-big" }, camOn ? "预览中" : "手机未连接！相同局域网下扫码添加配对设备；若已配对过的手机，请在设置内点击本电脑端，激活为活动设备")),
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
									h("button", { className: "lm-btn primary", disabled: !camOn, onClick: shoot }, "◉ 拍照并放入输入框"),
									h("button", { className: "lm-btn", onClick: () => void refreshQr() }, "↻ 二维码"),
								),
								!camOn
									? h(
											"div",
											{ className: "lm-qr" },
											qr && qr.pngDataUrl ? h("img", { src: qr.pngDataUrl, alt: "配对二维码" }) : h("div", { className: "hint" }, "二维码加载中…"),
											qr ? h("div", { className: "code" }, qr.code) : null,
											h("div", { className: "hint" }, "手机 App 扫码配对;或在 App 内手动输入", h("br", null), qr && qr.urls && qr.urls[0] ? `${qr.urls[0].replace("http://", "")}:${qr.code}` : ""),
									h("a", { className: "lm-dl", href: "https://github.com/yxqfg/phone-lens/releases/latest/download/app-release.apk", target: "_blank", rel: "noopener" }, "手机还没装 App？点此下载（Android APK）"),
										)
									: null,
								h("span", { className: `lm-flash${flash.startsWith("已") ? " ok" : ""}` }, flash),
								h(
									"div",
									{ className: "lm-port" },
									"接收端口",
									h("input", { value: portDraft, onChange: (e) => setPortDraft(e.target.value), onKeyDown: (e) => e.key === "Enter" && savePort(), inputMode: "numeric" }),
									h("button", { className: "lm-btn", style: { flex: "none", padding: "3px 8px" }, onClick: savePort }, "切换"),
								),
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
			);
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
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
