# PhoneLens 传输协议规范 v1

电脑端接收服务(默认 `0.0.0.0:8791`)。所有响应均为 JSON(除二进制端点),错误统一为:
`{ "error": { "code": "<CODE>", "message": "<人类可读>" } }`

## 0. 鉴权总则

| 判定 | 结果 |
|---|---|
| 来源 IP 为回环(127.0.0.1 / ::1) | 全部端点放行(本机降级页 / Web UI 小窗 / 冒烟脚本) |
| 非回环 + `POST /pair` + 有效配对码 | 放行,签发设备 token |
| 非回环 + 其余请求 + 有效 `X-LM-Device` + `X-LM-Token` | 放行 |
| 非回环访问 `/ws/view` `/view.html` `/qr*` | **403**(预览与二维码不外泄) |
| 其余 | 401 `AUTH_REQUIRED` |

Header:`X-LM-Device: <deviceId>`、`X-LM-Token: <deviceToken>`

## 1. HTTP 端点

### GET /info —— 无鉴权(非回环可达,供探测)
```json
{ "name": "PhoneLens 直连取景", "version": "0.2.0", "requiresPairing": true }
```

### POST /pair —— 配对(非回环)
请求:`{ "code": "12345678", "device": { "id": "<uuid>", "name": "Pixel 8", "model": "<model>" } }`
成功:`{ "token": "<64hex>", "serverInfo": { "preview": { "maxWidth": 854, "maxHeight": 480, "fps": 6, "jpegQuality": 60 }, "limits": { "maxUploadBytes": 10485760, "allowedTypes": ["image/jpeg","image/png"] } } }`
错误:`PAIR_CODE_INVALID` / `PAIR_CODE_EXPIRED` / `RATE_LIMITED`
配对码一次性,使用即焚;同 deviceId 重复配对=换发 token(旧的失效)。

### POST /upload —— 上传图片(回环或已配对设备)
- Header:`Content-Type: image/jpeg|image/png`,body = 原始字节
- Query:`?name=shot_20260214_153001.jpg&captureId=<可选,关联快门指令>&note=<可选,URL-encoded 备注>&target=<可选,sessionId>`
- 成功:`{ "ok": true, "attachmentId": "<dsh attachmentId>", "width": 4000, "height": 3000, "bytes": 2330112, "delivered": { "sessionId": "...", "mode": "followup" } }`
- `delivered: null` 表示已入库但未注入(无活动 agent)
- 错误:`AUTH_REQUIRED` / `TYPE_NOT_ALLOWED` / `TOO_LARGE` / `BAD_MAGIC` / `RATE_LIMITED` / `STORE_FAILED` / `NO_TARGET`

校验顺序:鉴权 → 限流 → Content-Type 白名单 → Content-Length ≤ max → 读入(流式,超限即断)→ magic bytes → `ctx.attachments.saveImages`(深度校验+持久化)→ 注入。

### GET /status —— 运行状态(鉴权同上)
```json
{ "devices": [ { "id": "...", "name": "Pixel 8", "online": true, "streaming": true, "lastSeenAt": 0 } ],
  "camera": { "connected": true, "fps": 5.8, "latencyMs": 310 },
  "target": { "mode": "latest", "sessionId": "...", "sessionTitle": "..." },
  "lastInjection": { "at": 0, "sessionId": "...", "attachmentId": "..." } }
```

### GET /targets —— 可注入会话列表(鉴权同上)
`{ "targets": [ { "sessionId": "...", "title": "...", "active": true, "running": false } ], "default": "<sessionId|null>" }`

### GET /qr.png / GET /qr.json —— 配对二维码(仅回环)
`qr.json`:`{ "code": "12345678", "expiresAt": 0, "payload": "lensmate://pair?v=1&host=192.168.1.20&port=8791&code=12345678", "urls": [ "http://192.168.1.20:8791" ], "pngDataUrl": "data:image/png;base64,..." }`

二维码 payload 字段:`v`(协议版本)、`host`(单选主 IP;多网卡时取最优,其余在 /qr.json urls)、`port`、`code`。

## 2. WebSocket

### 2.1 /ws/camera —— 手机 uplink(非回环 + 设备 token;每设备仅 1 连接,新顶旧)
- 连接 query:`?deviceId=...&token=...`
- **二进制消息** = 单帧 JPEG(无头;尺寸/质量以 hello 协商为准),单帧 ≤ previewFrameMaxBytes
- **文本消息**(JSON):
  - 手机→服:`{"type":"hello","width":854,"height":480,"fps":6}`
  - 手机→服:`{"type":"bye"}`(主动停流)
  - 服→手机:`{"type":"set_preview","maxWidth":854,"maxHeight":480,"fps":6,"jpegQuality":60}`(服务端可动态调)
  - 服→手机:`{"type":"capture","captureId":"<uuid>","note":"可选备注"}`
  - 手机→服:`{"type":"capture_result","captureId":"<uuid>","status":"taken"|"declined"|"failed"}`
    (随后照片走 `POST /upload?captureId=...`;captureId 关联回执)
- 心心:双方 20s ping/pong(ws 协议层);90s 无帧且无 pong 判离线

### 2.2 /ws/view —— 浏览器 downlink(仅回环;Web UI 小窗与降级页共用)
- 连接即收:`{"type":"meta","camera":{"connected":true},"preview":{"width":854,"height":480}}` + 缓存的最近 1 帧
- 后续:二进制 JPEG 帧(与 camera uplink 同节拍扇出)
- 事件:`{"type":"device","online":true,"name":"Pixel 8"}` / `{"type":"capture_pending","captureId":"..."}` / `{"type":"injected","captureId":"...","sessionId":"...","attachmentId":"...","ok":true}` / `{"type":"error","code":"NO_CAMERA"}`
- 控制:客户端发 `{"type":"capture","note":"可选"}`(服务端生成 captureId 转发手机,并回 `capture_pending`)

## 3. 注入消息形态(dsh 会话内)

`createUserMessage` 的 content:
```json
[ { "type": "text", "text": "[手机拍照] <note 或缺省>" },
  { "type": "image", "attachment": { "attachmentId": "...", "mediaType": "image/jpeg", "bytes": 2330112, "width": 4000, "height": 3000, "name": "shot_....jpg" } } ]
```
`source: { "kind": "plugin", "plugin": "phone-lens" }`;手动发送 `followup`,`lens_capture` 触发 `steer`。

## 4. 错误码汇总

`AUTH_REQUIRED` `PAIR_CODE_INVALID` `PAIR_CODE_EXPIRED` `RATE_LIMITED` `TYPE_NOT_ALLOWED` `TOO_LARGE` `BAD_MAGIC` `STORE_FAILED` `NO_TARGET` `NO_CAMERA` `CAPTURE_TIMEOUT` `LOOPBACK_ONLY`
