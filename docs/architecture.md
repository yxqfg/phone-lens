# PhoneLens 架构方案 —— 手机拍照直连编码 agent

> 状态:方案稿(v1,待确认后动工)
> 前置调研:见 `docs/dsh-caps.md`(基于 DSH 0.1.1-rc.2 编译产物源码阅读,含文件行号依据)

## 1. 总览:两端一链路

```
┌───────────────── 手机(Flutter / Android)─────────────────┐
│  扫码配对 → 取景(YUV→JPEG@480p 5-8fps)→ 拍照/裁剪 → 上传   │
└──────────────┬───────────────────────────▲────────────────┘
      WiFi/USB-tethering(同一 HTTP 协议)  │ 快门指令/注入回执
               │                           │
┌──────────────▼───────────────────────────┴────────────────┐
│  电脑端 = 单个 dsh 双面插件 phone-lens(host 进程内)          │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ 接收服务(node:http + ws, 默认 :8791)                 │ │
│  │  /pair 一次性码配对 · /upload 白名单校验 · /ws/camera  │ │
│  │  /ws/view(仅回环) · /view.html 降级取景页 · /qr       │ │
│  ├──────────────────────────────────────────────────────┤ │
│  │ 注入管线:saveImages→ImageBlock→createUserMessage     │ │
│  │          →agent.followup/steer(进程内直调)            │ │
│  ├──────────────────────────────────────────────────────┤ │
│  │ 模型工具:lens_capture / lens_status / lens_pairing    │ │
│  ├──────────────────────────────────────────────────────┤ │
│  │ client 半边(dsh.client web):shell.overlay 悬浮取景窗 │ │
│  └──────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────┘
               │
               ▼
        dsh 会话(模型多模态直读图片)
```

## 2. 关键架构决策(附源码依据)

### D1 · 接收服务内嵌于 dsh 插件,不独立进程
接收服务就是插件的 host 半边,在 dsh 进程内起 `node:http + ws`。
理由:上传落库需要调 `ctx.attachments.saveImages()`(进程内 Service,见 `dsh-attachment/lib/index.js`),注入需要 agent 句柄(`agent.followup/steer`,见 `dsh-agent/lib/types/runtime-types.d.ts` L109-132)。独立进程就要再造一层 IPC,纯属浪费。插件生命周期(cordis Fiber)天然管理服务的启停可逆性。

### D2 · 一个双面 cordis 插件包,标准方式接入 profile
- package.json 同时声明 `dsh.bundle.patch: "./cordis.patch.yml"`(host 行 insert 进 profile,参考 `dsh-web-app/cordis.patch.yml`)与 `dsh.client: { platform: "web", inject: [...] }`(浏览器 roster,参考 `dsh-client-ui-attachment/package.json`)。
- 接入命令:`dsh plugin --profile web add <本项目 packages/lens-mate 路径>`(内部转发 pnpm 并自动 reconcile bundles 层,见 `dsh/lib/plugin-9h8shc4d.js`)。
- client bundle 用 tsdown 构建(官方 dsh.client 包同款),React 等由 shell 静态表供给,额外依赖走 `dsh.client.external`。

### D3 · 附件注入管线(核心链路)
```
手机 JPEG bytes
  → 白名单校验(mediaType + magic bytes + ≤10MB)     [server/routes/upload.ts]
  → ctx.attachments.saveImages([{data, mediaType, name}])  [inject/admit.ts]
      ← ImageAttachmentRef(dsh 持久化,content-addressed,即"落盘")
  → createUserMessage({ content:[{type:'image',attachment:ref},
        {type:'text',text:'[手机拍照] <备注>'}],      [inject/deliver.ts]
        source:{kind:'plugin',plugin:'phone-lens'} })
  → agent.followup(默认,排队下一轮)/ steer(工具触发时,当前步即见)
```
模型侧由 DSH 适配器完成 `readImageRequest` 投影并进 provider 请求(`dsh-llm-deepseek/lib/index.js` L1237-1244),模型直接看到图,无需我们做任何请求侧工作。

### D4 · 注入目标:"最近活跃 agent",可锁定
host 侧没有"当前会话"概念,维护规则:
- 订阅 `agent/inbox/inserted`、`agent/status`(→running)更新 `lastActiveAgentId`;`agent/created/disposed` 维护存活表。
- 配置 `target.mode: 'latest' | 'pinned'`(pinned 固定 sessionId)。
- 手机端可拉取 `GET /targets` 选择目标(默认最近活跃)。
- 全部失败(无 agent)时:图片仍入库保存,回执标注"未注入(无活动会话)",不丢数据。

### D5 · 鉴权模型(硬性要求落法)
| 来源 | 规则 |
|---|---|
| 回环 127.0.0.1/::1 | 免 token,可访问 /ws/view、/view.html、/qr、/upload(本机降级页与 Web UI 小窗用) |
| 非回环(局域网/USB 网段) | 一律 `X-LM-Device` + `X-LM-Token`;`/ws/view`、`/view.html`、`/qr` 对非回环直接 403(二维码与预览不外泄) |
| `/pair` | 仅非回环 + 正确一次性配对码;码即焚,默认 TTL 15min,可手动刷新 |

- 配对码:8 位数字(`crypto.randomInt`),二维码内容 `lensmate://pair?v=1&host=<ip>&port=<port>&code=<code>`,同时给出 `http://<ip>:<port>/pair-help` 兜底。
- 设备 token:32B random hex,**只存 SHA-256**(`~/.dsh/phone-lens/devices.json`),文件泄露不可伪造。
- 上传白名单:`image/jpeg`、`image/png`;magic bytes 双验(JPEG `FFD8FF`,PNG `89504E47`);默认 ≤10MB(可配)。深度校验(尺寸/像素)复用 `saveImages` 内置 `validateImageFile`。
- 速率限制:上传令牌桶(默认 10 次/分钟);WS 预览帧单帧 ≤512KB。

### D6 · 视频链路:MJPEG-over-WebSocket + hub
- 手机 → `WS /ws/camera`(二进制 JPEG 帧,文本 JSON 控制):
  `hello{width,height,fps}` / `capture{captureId}`(电脑→手机)/ `capture_result{captureId,ok}`。
- 服务器 hub:保留最近 1 帧,向所有 view 订阅者扇出;统计帧率/延迟。
- 电脑 → `WS /ws/view`(仅回环):收二进制帧 + JSON 事件(`injected{captureId,sessionId,attachmentId}`、`device{online,streaming}`);可发 `capture{}` 触发手机快门。
- **拍照帧不走预览流**:手机收到 capture 指令后 `CameraController.takePicture()` 全分辨率 → 裁剪(可选)→ `POST /upload`(带 captureId 关联)→ 注入 → 回执广播。
- 预览参数默认 480p / 6fps / JPEG q60(局域网 200-400ms 可达);均可配。

### D7 · Web UI 内嵌小窗:shell.overlay(已确认可行)
- client 半边注册:`ctx.slots.inject("shell.overlay", () => ctx.slots.register({...}, Overlay))`。
- `shell.overlay` 是 list 型帧级浮动层、默认点击穿透、可多 entry 共存(`dsh-client-ui-layout/types/client/index.d.ts` L67-80)——正是右下角取景小窗的官方座位。
- 小窗 = React 组件(构建期 JSX → `React.createElement`,产物无 JSX);内部 `<canvas>` 绘帧 + 快门按钮 + 目标会话名 + 连接态;离线时折叠为相机图标。
- Host↔Client 桥:`harness.handle('lm/<method>')`(host)/ `host.call('lm/<method>')`(client),仅传 JSON(拿 WS 地址、二维码、触发配对等)。
- **降级路径**:同一小窗逻辑渲染成接收服务的静态页 `/view.html`(127.0.0.1:8791),用 `canvas.captureStream()→<video>→requestPictureInPicture()` 实现真·系统置顶小窗。Web UI 注入失败不影响主链路。

### D8 · 模型工具(原生 cordis 工具,非 MCP server)
让模型能主动"要一张照片":
- `lens_capture({note?, timeoutMs?})`:向手机发 capture 指令,等待上传+注入完成(按 captureId 关联),返回注入回执;手机离线返回明确错误。
- `lens_status()`:设备连接/取景状态/最近注入记录。
- `lens_pairing()`:返回配对码与二维码 dataURL(模型可引导用户扫码)。
实现走 DSH 工具注册面(以 `dsh-tools` 类型为准,见风险清单 R2)。
> 说明:DSH 消费 MCP 的方向是"host 作为 MCP client 挂外部 server",给模型供工具的惯用法是 cordis 工具注册——进程内、零配置、会话天然可用。跨 IDE 复用的薄 MCP 适配层列为 Phase 4 可选项。

### D9 · Hook:不用 Claude Code 格式,用 DSH agent 事件
DSH 无 `UserPromptSubmit` 等 hooks(`docs/dsh-caps.md` Q3)。本项目用到的:
- `agent/inbox/inserted` / `agent/status` → 活跃目标跟踪(D4)
- `agent/created` / `agent/disposed` → 存活表维护
- `agent/session-start` → 新会话广播给手机端(可选目标列表刷新)
- 预留 `agent/pre-step`(waterfall)做"注入前改写备注文本"等扩展,Phase 2 不实现。

## 3. 目录结构

```
ds_siu/
├── README.md                      # 快速开始(装插件/装 App/扫码)
├── .gitignore
├── docs/
│   ├── architecture.md            # 本方案
│   ├── protocol.md                # 配对/上传/取景协议规范(HTTP+WS 帧)
│   └── dsh-caps.md                # DSH 能力缝调研结论(附件/slot/事件)
├── packages/
│   ├── lens-mate/                 # dsh 双面插件(电脑端主体)
│   │   ├── package.json           # dsh.bundle.patch + dsh.client 声明
│   │   ├── cordis.patch.yml       # 向 profile insert 本插件 host 行(含默认 config)
│   │   ├── tsdown.config.ts       # 构建 lib/index.js(host)与 lib/client.js(browser)
│   │   ├── src/                   # ── host 半边(Node)──
│   │   │   ├── index.ts           # apply(ctx):装配 server+inject+tools+events
│   │   │   ├── config.ts          # Config schema(端口/绑定/白名单/注入方式/预览参数)
│   │   │   ├── events.ts          # agent 事件订阅(活跃跟踪/存活表)
│   │   │   ├── store/
│   │   │   │   ├── pairing.ts     # 一次性配对码生命周期(TTL/即焚/刷新)
│   │   │   │   └── devices.ts     # 设备注册表(持久化, token 仅存 SHA-256)
│   │   │   ├── server/
│   │   │   │   ├── http.ts        # node:http 路由分发(零框架)+ 优雅关闭
│   │   │   │   ├── auth.ts        # 回环放行/设备 token/限流/帧大小限制
│   │   │   │   ├── routes/
│   │   │   │   │   ├── pair.ts    # POST /pair
│   │   │   │   │   ├── upload.ts  # POST /upload(白名单/magic/大小/capture 关联)
│   │   │   │   │   ├── info.ts    # GET /info /status
│   │   │   │   │   ├── targets.ts # GET /targets(可注入会话列表)
│   │   │   │   │   └── qr.ts      # GET /qr.png + GET /qr.json(dataURL)
│   │   │   │   ├── ws/
│   │   │   │   │   ├── hub.ts     # 帧扇出/最近帧缓存/统计
│   │   │   │   │   ├── camera.ts  # /ws/camera 手机 uplink(帧+capture 指令)
│   │   │   │   │   └── view.ts    # /ws/view 浏览器 downlink(仅回环)
│   │   │   │   └── static/
│   │   │   │       └── view.html  # 降级取景页(canvas+PiP 置顶+快门)
│   │   │   ├── inject/
│   │   │   │   ├── admit.ts       # saveImages 封装 + 校验错误映射
│   │   │   │   ├── target.ts      # 目标 agent 解析(latest/pinned)
│   │   │   │   └── deliver.ts     # createUserMessage + followup/steer + 回执
│   │   │   └── tools.ts           # lens_capture / lens_status / lens_pairing
│   │   └── client/                # ── browser 半边(构建产物 lib/client.js)──
│   │       ├── index.ts           # apply(ctx):slots.inject("shell.overlay")
│   │       ├── overlay.tsx        # 悬浮取景小窗(canvas/快门/状态/目标名)
│   │       └── bridge.ts          # host.call('lm/*') 封装
│   └── app/                       # ── Flutter 手机端 ──
│       ├── pubspec.yaml           # camera/web_socket_channel/mobile_scanner/
│       │                          # image_cropper/shared_preferences/permission_handler
│       ├── lib/
│       │   ├── main.dart
│       │   ├── core/
│       │   │   ├── api_client.dart    # HTTP:pair/upload/status/targets
│       │   │   ├── camera_socket.dart # WS uplink:推帧/收 capture 指令/心跳
│       │   │   ├── jpeg.dart          # YUV420→JPEG(v1 纯 Dart;v2 预留 native)
│       │   │   └── pairing_store.dart # 设备 token 持久化(secure storage)
│       │   ├── features/
│       │   │   ├── pair/pair_screen.dart       # 扫码+手动输入兜底
│       │   │   ├── camera/
│       │   │   │   ├── viewfinder_screen.dart  # 取景/快门/预览开关
│       │   │   │   ├── crop_screen.dart        # 可选裁剪
│       │   │   │   └── send_flow.dart          # 发送→注入回执展示
│       │   │   ├── history/history_screen.dart # 最近发送记录/重发
│       │   │   └── settings/settings_screen.dart# 服务器地址/目标会话/画质
│       │   └── ui/                 # theme.dart + 通用组件(状态点/回执卡)
│       ├── android/                # 权限:CAMERA/INTERNET;applicationId com.lensmate.app
│       └── test/
└── scripts/
    ├── dev-install.ps1            # dsh plugin --profile web add <本地路径>
    ├── firewall.ps1               # New-NetFirewallRule 放行 8791(可限私有网段)
    ├── adb-install.ps1            # flutter build apk --release + adb install -r
    └── smoke/                     # curl/WS 协议冒烟(pair→upload→view)
```

## 4. 三条主数据流

### 4.1 配对
```
电脑:apply(ctx) 起服务 → 生成配对码 → 终端打印 ASCII 码 + /qr.png
手机:扫二维码 → POST /pair{code, device{id,name,model}}
电脑:验码(即焚)→ 签发 deviceToken(存 hash)→ 200{token, serverInfo}
手机:secure storage 保存;此后重连免扫码
```

### 4.2 拍照 → 注入
```
手机:takePicture(全分辨率)→ 可选裁剪 → 压缩至 ≤10MB → POST /upload
电脑:鉴权→白名单→saveImages→ref→createUserMessage→agent.followup
     → 广播 injected{captureId,sessionId,attachmentId} 给 /ws/view
手机/小窗:回执 UI(已注入会话 X)
```

### 4.3 实时取景 + 双端快门
```
手机:/ws/camera 连接,hello 后持续推 JPEG 帧(480p@6fps)
电脑 Web UI 小窗(或降级页):/ws/view 收帧绘 canvas
任一端按快门 → capture 指令 → 手机 takePicture → 走 4.2 管线 → 双端回执
```

## 5. 配置 schema(cordis Config,patch 行可覆盖)

```yaml
phoneLens:
  server:
    host: "0.0.0.0"        # 默认全接口,但仅接受已配对来源(回环除外)
    port: 8791
  limits:
    maxUploadBytes: 10485760      # 10MB
    allowedTypes: ["image/jpeg","image/png"]
    uploadsPerMinute: 10
    previewFrameMaxBytes: 524288
  pairing:
    codeTtlMs: 900000             # 15min
  preview:
    maxWidth: 854
    maxHeight: 480
    fps: 6
    jpegQuality: 60
  inject:
    mode: "followup"              # 手动发送:followup(排队)| steer(插队)
    notePrefix: "[手机拍照]"       # 注入消息的文本块前缀
  target:
    mode: "latest"                # latest | pinned
    pinnedSessionId: null
```

## 6. 阶段计划(细化原 4 步,每步可独立验收)

**Phase 1 · 最小闭环(电脑服务 + 手机拍照上传 + 降级页取景)**
- phone-lens host:server 骨架、pairing、devices、upload(白名单+落库)、/view.html 取景页
- Flutter:扫码配对、拍照/裁剪、上传、历史
- 验收:手机拍照 → 图片出现在 dsh 附件存储;降级页能实时取景、按快门
- (此时注入暂以日志模拟,Phase 2 接通)

**Phase 2 · dsh 插件接入(注入 + 工具 + 事件)**
- inject/admit+target+deliver 接通 saveImages→agent.followup/steer
- events.ts 活跃跟踪;GET /targets;lens_capture/lens_status/lens_pairing
- 验收:手机拍照后模型在下一轮直接描述图片内容;lens_capture 由模型调用成功

**Phase 3 · Web UI 内嵌小窗 + 双端快门**
- client 半边(tsdown 构建 + shell.overlay 注册)、host 桥、快门联动、回执 UI
- 验收:dsh web 页面右下角出现悬浮取景窗,双端快门均触发同一管线

**Phase 4 · USB/防火墙/分发**
- USB tethering 网段验证(多网卡枚举进二维码/选择)、firewall.ps1、打包、README
- 可选:MCP 适配层、`agent/pre-step` 扩展

## 7. 风险与待验证清单(实现前逐项确认)

- **R1** `ctx.slots.register` 精确签名(单 entry 字段:name/order/priority/owner 等)——读 `dsh-client-ui-slots` 包的 `SlotCore.register` 类型(它不在顶层 node_modules,定位后确认)。
- **R2** 模型工具注册面——读 `dsh-tools` 的 Service/注册 API(tools registry 形状)。
- **R3** client bundle `dsh.client.external` 精确声明(ws 客户端、canvas 无需 external;React/cordis 由 shell 供)。
- **R4** Flutter YUV420→JPEG 纯 Dart 编码性能(480p@6fps 目标;不达则 native 通道编码,接口已在 `jpeg.dart` 预留)。
- **R5** Web UI 页面(127.0.0.1:3080)跨端口连 ws://127.0.0.1:8791 的 Origin 策略(view 限回环已规避大部分;必要时 allowOrigins 配置)。
- **R6** pnpm add 本地相对路径在 profile 目录的解析(dsh 已做 anchorPathSpec 重写,验证一次即可)。
- **R7** `dsh plugin add` 后 profile 的 cordis.patch.yml 与本包 cordis.patch.yml 的层叠顺序(默认行为验证)。

## 8. 明确不做

- 不做 AOA/adb 端口转发(USB 走手机 tethering,复用 HTTP)
- 不做视频通话级流媒体(WebRTC 等),MJPEG 足够
- 不做云端中转,全部本地/局域网
- 不做 Claude Code hooks 兼容层(DSH 无此机制)
- v1 不做通用文件类型(仅 JPEG/PNG 图片)
