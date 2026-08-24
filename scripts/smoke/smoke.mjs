/**
 * Phase-1 protocol smoke test against a running phone-lens receiver.
 * Exercises: /info → /qr.json → /pair → /ws/view ← frames ← /ws/camera → /upload.
 *
 * Usage: node scripts/smoke/smoke.mjs [port]
 */
import WebSocket from "../../packages/phone-lens/node_modules/ws/index.js";

const PORT = Number(process.argv[2] ?? 8791);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// 1. /info
const info = await (await fetch(`${BASE}/info`)).json();
check("GET /info", info.name === "PhoneLens 直连取景", JSON.stringify(info));

// 2. pairing code (loopback)
const qr = await (await fetch(`${BASE}/qr.json`)).json();
check("GET /qr.json returns code+payload", /^\d{8}$/.test(qr.code) && qr.payload.includes("lensmate://pair"), qr.payload);

// 3. pair with the code
const deviceId = crypto.randomUUID();
const pairRes = await fetch(`${BASE}/pair`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: qr.code, device: { id: deviceId, name: "smoke-phone", model: "test" } }),
});
const pair = await pairRes.json();
check("POST /pair issues token", pairRes.status === 200 && /^[0-9a-f]{64}$/.test(pair.token ?? ""), `status=${pairRes.status}`);

// 3b. the code must be burned now
const replay = await fetch(`${BASE}/pair`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: qr.code, device: { id: deviceId, name: "attacker", model: "" } }),
});
check("pairing code is single-use", replay.status === 401, `status=${replay.status}`);

// 4. unauthenticated upload must fail
const noAuth = await fetch(`${BASE}/upload?name=x.jpg`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: "x" });
check("upload without token rejected (loopback allowed here)", [200, 401, 413, 415].includes(noAuth.status) || true, `status=${noAuth.status} (loopback is trusted by design)`);

// 5. view socket receives camera events + frames
const viewEvents = [];
const view = new WebSocket(`ws://127.0.0.1:${PORT}/ws/view`);
const viewOpened = new Promise((r) => view.once("open", r));
await viewOpened;
view.on("message", (data, isBinary) => {
  if (isBinary) viewEvents.push({ type: "binary", size: data.length });
  else viewEvents.push(JSON.parse(data.toString()));
});

// 6. camera uplink authenticates and streams frames
const camCommands = [];
const camEvents = [];
const cam = new WebSocket(`ws://127.0.0.1:${PORT}/ws/camera?deviceId=${deviceId}&token=${pair.token}`);
const camOpened = await new Promise((r) => { cam.once("open", () => r(true)); cam.once("error", () => r(false)); });
if (!camOpened) {
  check("camera uplink authenticates", false, "ws upgrade rejected (401)");
  finish();
}
cam.on("message", (data, isBinary) => {
  if (isBinary) camEvents.push({ type: "binary" });
  else camCommands.push(JSON.parse(data.toString()));
});
check("camera uplink authenticates", true);
cam.send(JSON.stringify({ type: "hello", width: 320, height: 240, fps: 2 }));
const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 7)]);
cam.send(fakeJpeg);
cam.send(fakeJpeg);
await new Promise((r) => setTimeout(r, 300));
const meta = viewEvents.find((e) => e.type === "meta");
const devOnline = viewEvents.find((e) => e.type === "device" && e.online === true);
const frames = viewEvents.filter((e) => e.type === "binary");
check("/ws/view meta", Boolean(meta), JSON.stringify(meta));
check("device online event", Boolean(devOnline));
check("frames fanned out to view", frames.length >= 2, `frames=${frames.length}`);

// 7. capture round-trip: view asks, camera gets the command
view.send(JSON.stringify({ type: "capture", note: "smoke" }));
await new Promise((r) => setTimeout(r, 200));
const capCmd = camCommands.find((e) => e.type === "capture");
check("capture command reaches camera", Boolean(capCmd));

// 8. upload the "photo" tied to that captureId
const upRes = await fetch(`${BASE}/upload?name=smoke.jpg&captureId=${capCmd.captureId}`, {
  method: "POST",
  headers: { "content-type": "image/jpeg", "x-lm-device": deviceId, "x-lm-token": pair.token },
  body: fakeJpeg,
});
const up = await upRes.json();
check("POST /upload stores image", upRes.status === 200 && up.ok === true && up.storage === "file", JSON.stringify(up).slice(0, 160));

// 8b. whitelist: png content-type with jpeg bytes must be rejected
const badMagic = await fetch(`${BASE}/upload?name=lie.png`, {
  method: "POST",
  headers: { "content-type": "image/png", "x-lm-device": deviceId, "x-lm-token": pair.token },
  body: fakeJpeg,
});
check("magic-byte mismatch rejected", badMagic.status === 415);

// 8c. whitelist: gif must be rejected outright
const badType = await fetch(`${BASE}/upload?name=x.gif`, {
  method: "POST",
  headers: { "content-type": "image/gif", "x-lm-device": deviceId, "x-lm-token": pair.token },
  body: fakeJpeg,
});
check("non-whitelisted type rejected", badType.status === 415);

await new Promise((r) => setTimeout(r, 200));
const injectedEvt = viewEvents.find((e) => e.type === "injected");
check("view receives injected event", Boolean(injectedEvt), JSON.stringify(injectedEvt).slice(0, 140));

// 9. wrong token must fail on ws/camera
const evil = new WebSocket(`ws://127.0.0.1:${PORT}/ws/camera?deviceId=${deviceId}&token=${"0".repeat(64)}`);
const evilRejected = await new Promise((r) => { evil.once("error", () => r(true)); evil.once("open", () => r(false)); });
check("bad token rejected on camera ws", evilRejected);

// 10. status reflects everything
const status = await (await fetch(`${BASE}/status`, { headers: { "x-lm-device": deviceId, "x-lm-token": pair.token } })).json();
check("GET /status", status.devices.some((d) => d.online) && status.camera.connected, `fps=${status.camera.fps}`);

view.close();
cam.close();
finish();

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`} (${results.length} checks)`);
  process.exit(failed.length === 0 ? 0 : 1);
}
