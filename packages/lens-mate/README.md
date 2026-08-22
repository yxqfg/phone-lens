# phone-lens（dsh 插件）

`phone-lens` 是一个 **dsh 双面插件**，让手机相机成为 dsh 会话的即时视觉输入：

- **host 半边**：在 dsh 进程内起接收服务（Node HTTP + WebSocket，默认 `0.0.0.0:8791`），处理配对、上传、并将图片注入 dsh 会话输入框。
- **client 半边**：在 dsh Web UI 右下角注册一个悬浮取景小窗（`shell.overlay` 插槽），实时画面 + 快门 + 配对二维码。

## 环境要求

- Node.js ≥ 20、pnpm
- 一个 dsh web 配置（`dsh plugin --profile web`）

## 安装

```powershell
# 1. 构建
cd packages\lens-mate
pnpm install
pnpm build

# 2. 接入 dsh 的 web profile
dsh plugin --profile web add C:\Users\<you>\phone-lens\packages\lens-mate
```

也可以用仓库根的 `scripts\dev-install.ps1` 一键完成构建与接入，然后重启 `dsh web`，
终端会打印配对二维码。

> 发布到 npm 后，可直接 `dsh plugin --profile web add phone-lens`。

## 配置

默认配置见 `cordis.patch.yml`，可在你的 profile 层覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `server.port` | `8791` | 接收服务端口 |
| `limits.maxUploadBytes` | `10485760` | 单张图片上限 |
| `limits.uploadsPerMinute` | `10` | 上传频率限制 |
| `pairing.codeTtlMs` | `900000` | 配对码有效期（15 分钟） |
| `preview.fps` | `10` | 预览帧率 |
| `inject.notePrefix` | `[手机拍照]` | 注入消息文本块前缀 |
| `target.mode` | `latest` | 目标会话：`latest`（最近活跃）/ `pinned`（固定） |

## 使用

1. 手机 App 扫码配对
2. 手机端拍照（可选裁剪）→ 图片进入当前 dsh 会话
3. 手机端「启动预览」→ 电脑端悬浮小窗实时取景；多设备时手机端「设为主机」抢占预览

详见仓库根 [README](../../README.md) 与 `docs/`。

## 开发

```bash
pnpm build           # tsdown 构建 lib/index.js（host）与 dev.js
pnpm dev:standalone  # 不进入 dsh，独立起接收服务（上传落盘 ~/.dsh/phone-lens/uploads）
node --check lib/client.js   # 手写 client 的语法校验
```

协议与安全设计见 `docs/protocol.md`、`docs/architecture.md`。
