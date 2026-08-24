/**
 * The standalone fallback viewfinder page, served at /view.html (loopback only).
 * Same protocol as the future Web UI overlay: WS /ws/view frames + capture control.
 * Picture-in-Picture turns it into a true always-on-top mini window.
 */
export const VIEW_HTML = `<!doctype html>
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
