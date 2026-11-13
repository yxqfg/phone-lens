import { join } from "node:path";
import { appendFileSync, readFileSync, renameSync, statSync } from "node:fs";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { normalizeConfig } from "./config.js";
import { TargetTracker } from "./inject/target.js";
import { DeviceStore } from "./store/devices.js";
import { PairingStore } from "./store/pairing.js";
import { AppSettingsStore } from "./store/settings.js";
import { startLensServer, type LensServerHandle } from "./server/http.js";
import { ViewHub } from "./server/hub.js";
import { buildPairingQr } from "./server/qr.js";
import { WorkBridge } from "./work/bridge.js";
import type { AttachmentStoreLike } from "./inject/admit.js";
import { lensDataDir } from "./paths.js";

type LogLevel = "info" | "warn" | "error";

/**
 * phone-lens host plugin.
 *
 * Boots the receiver inside the dsh process so uploads can flow straight
 * into `ctx.attachments` (and, from Phase 2 on, into agent inboxes) with no
 * extra IPC. Everything registered here unwinds with the fiber.
 */
export default class PhoneLens extends Service {
  // 'tools' is REQUIRED for the model camera tools — and this is a deliberate
  // product coupling, not an oversight: cordis 4.0.2's imperative
  // ctx.inject(['tools'], cb) NEVER fires (verified by probe, service present
  // or not), so static injection is the only reliable way to see the service.
  // Hosts that run dsh conversations always bundle dsh-tools (the desktop
  // asar ships it); a host without it has no model to serve anyway. The
  // trade-off: on such a host this whole plugin (receiver included) stays
  // dormant rather than running half-broken.
  // 'typertGateway' (dsh-api-remotes) powers the phone-side approval/question
  // answerer's desktop-card teardown: after the phone answers first we settle
  // the remote bridge's pending waterfall so the gateway cancels the desktop
  // card. api-remotes is on the plugin manager's PROTECTED list (same tier as
  // dsh-tools) — every dsh host ships it, same trade-off as 'tools'.
  static inject: string[] = ["tools", "typertGateway"];
  static Config = z.any();

  constructor(ctx: any, rawConfig: unknown) {
    super(ctx, "phoneLens");
    const config = normalizeConfig(rawConfig);
    const dataDir = lensDataDir();
    const log = (level: LogLevel, msg: string) => {
      const target = (ctx.logger as Record<LogLevel, (m: string) => void> | undefined) ?? console;
      target[level]?.(`[phone-lens] ${msg}`);
      // the desktop logger swallows plugin output; keep a tiny boot trace on
      // disk so a receiver that never starts is diagnosable at all. The file
      // is append-only and previously grew without bound — cap it at ~1MB,
      // rotating to .1 (one generation of history is plenty for diagnosis).
      try {
        const file = join(dataDir, "boot.log");
        try {
          if (statSync(file).size > 1_000_000) renameSync(file, `${file}.1`);
        } catch {}
        appendFileSync(file, `${new Date().toISOString()} [${level}] ${msg}\n`, "utf8");
      } catch {}
    };

    const pairing = new PairingStore(config.pairing.codeTtlMs);
    const devices = new DeviceStore(dataDir);
    // user-selected capture mode + folder target (web UI settings panel)
    const appSettings = new AppSettingsStore(join(dataDir, "settings.json"), join(dataDir, "saved"));
    const hub = new ViewHub(config, (level, msg) => log(level, msg));
    const targets = new TargetTracker(config);
    // 「工作(Beta)」bridge: inert until the settings switch is flipped — the
    // constructor subscribes to nothing and /ws/work refuses upgrades while
    // the beta is off, so camera-receiver paths stay untouched by default.
    const workBridge = new WorkBridge(ctx, appSettings, log, () => {
      try {
        return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0");
      } catch {
        return "0.0.0";
      }
    });
    const attachments = (): AttachmentStoreLike | undefined => ctx.get?.("attachments") as AttachmentStoreLike | undefined;

    // ── model-facing camera tools (dsh-tools) ─────────────────────────────
    // The WHOLE wiring sits inside a try/catch and must NEVER throw out: an
    // exception here (1.0.4's direct ctx.tools read hit an unmounted service
    // during host startup) cascaded into the desktop host dying with
    // INACTIVE_EFFECT and took the receiver down with it. The receiver is
    // mandatory; the tools are optional.
    try {
      const PHONE_TOOLS = new Set(["phone_take_photo", "phone_camera_pause", "phone_camera_resume", "phone_camera_zoom", "phone_camera_lens", "phone_camera_torch"]);
    // Direct ctx.tools access, same as dsh-better-sidebar's registerOpenTool:
    // on the real host the tools service is already mounted by the time
    // plugins load, so a plain property read works. (ctx.inject(['tools'], …)
    // never fired there — the tools were silently never registered and the
    // model never saw them.) Environments without the service (dev.js
    // standalone) skip registration cleanly.
    const toolsSvc = (ctx as { tools?: { register: (d: never) => () => void; guard?: (g: never) => unknown } }).tools;
    // everything registered below unwinds through this one list — guards and
    // tools alike; each disposer is run isolated so one throwing cannot star
    // the rest of the cleanup
    const disposers: Array<() => void> = [];
    const guardDisposers: Array<() => void> = disposers;
    // Registry-level guard for the must-hold master switch: guards fire for
    // EVERY call regardless of event-scope dispatch, and no later listener
    // can override a guard denial. The pre-execute listener below alone was
    // bypassable; this is the authoritative off switch.
    if (toolsSvc && typeof toolsSvc.guard === "function") {
      // the disposer matters: guards live on the TOOLS service's layers, not
      // this fiber — dropping it would leak a stale guard (reading a stale
      // appSettings) across plugin reloads
      const unguard = toolsSvc.guard(((exec: { name?: string }) => {
        if (!PHONE_TOOLS.has(exec?.name ?? "")) return undefined;
        if (!appSettings.get().modelToolsEnabled) {
          return "PhoneLens 模型相机工具已在设置中关闭(电脑端 PhoneLens 设置页可重新开启)";
        }
        return undefined;
      }) as never);
      guardDisposers.push(unguard as () => void);
    }
    ctx.on?.(
      "tools/pre-execute",
      async (exec: { name?: string }, next: () => Promise<unknown>) => {
        if (!PHONE_TOOLS.has(exec?.name ?? "")) return next();
        const st = appSettings.get();
        if (!st.modelToolsEnabled) {
          return { kind: "deny", reason: "PhoneLens 模型相机工具已在设置中关闭(电脑端 PhoneLens 设置页可重新开启)" };
        }
        // CRITICAL: the host's pre-execute waterfall chain tail DEFAULTS TO
        // `resolve({kind:"allow"})` — returning next() here meant "no
        // confirmation ever". Asking the user requires explicitly returning
        // {kind:"ask"}, which routes into the host's approval service.
        if (st.modelToolsConfirmFree) return { kind: "allow" };
        return {
          kind: "ask",
          reason: "PhoneLens 模型相机工具调用(模型免确认调用未开启)",
          displayReason: {
            en: "PhoneLens wants to use the phone camera (confirm-free mode is off)",
            "zh-CN": "PhoneLens 请求调用手机相机(模型免确认调用未开启)",
          },
        };
      },
    );
    if (toolsSvc && typeof toolsSvc.register === "function") {
      // NOTE: no shadowing `disposers` here — the outer array (which also
      // carries the guard disposer) must be the one and only cleanup list.
      // A shadowed inner list once left the stale guard on the tools service
      // across plugin reloads, permanently denying the model tools.
      const textOutput = { schema: { type: "string" } as const, render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: String(value) }] };
      const asText = (args: unknown, key: string): string | undefined => {
        const v = (args as Record<string, unknown> | null)?.[key];
        return typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : undefined;
      };
      // Number.isFinite guard: the model can hand back NaN/Infinity-flavoured
      // junk that must never travel down to the phone as a zoom target
      const numArg = (args: unknown, key: string): number | undefined => {
        const v = (args as Record<string, unknown> | null)?.[key];
        return typeof v === "number" && Number.isFinite(v) ? v : undefined;
      };
      const boolArg = (args: unknown, key: string): boolean | undefined => {
        const v = (args as Record<string, unknown> | null)?.[key];
        return typeof v === "boolean" ? v : undefined;
      };
      disposers.push(
        toolsSvc.register(
          defineTool({
            name: "phone_take_photo",
            description:
              "通过用户配对的手机(PhoneLens)立即拍摄一张照片,照片会直接作为图片提供给你。" +
              "照片不进入用户输入框、不保存到用户文件夹(与用户的拍照注入模式设置无关)。" +
              "没有手机连接、手机拒绝拍摄或超时会返回失败原因。" +
              "仅在对话需要查看手机相机画面时使用(例如用户让你拍摄桌上的文件、白板、实物)。",
            parameters: {
              note: { type: "string", description: "可选的照片备注,会出现在文件名里(如'白板'、'发票')" },
            },
            output: textOutput,
            async execute(args: unknown, exec: any) {
              // tool contract: observe exec.signal so a CANCELLED turn settles
              // immediately instead of burning the 45s shutter window (the
              // phone may still shoot if the capture already left — inherent
              // race — but the model stops waiting on a dead turn)
              const capture = hub.requestCaptureDirect(asText(args, "note"), 45_000);
              const result = await new Promise((resolve: (v: Awaited<typeof capture>) => void) => {
                let done = false;
                const settle = (v: unknown) => {
                  if (done) return;
                  done = true;
                  resolve(v as Awaited<typeof capture>);
                };
                void capture.then((r) => settle(r)).catch((e) => settle({ ok: false, reason: String(e) }));
                const sig = exec?.signal as { aborted?: boolean; addEventListener?: (t: string, l: () => void, o?: unknown) => void } | undefined;
                if (sig?.aborted) {
                  settle({ ok: false, reason: "调用已被取消" });
                } else if (sig?.addEventListener) {
                  sig.addEventListener("abort", () => settle({ ok: false, reason: "调用已被取消" }), { once: true });
                }
              });
              if (!result.ok) return `拍照失败: ${result.reason}`;
              if (result.admitted.storage === "attachments" && typeof exec?.deferContext === "function") {
                exec.deferContext(
                  createUserMessage({
                    content: [{ type: "image", attachment: result.admitted.ref }],
                    // v4 session format REQUIRES a producer-owned source kind:
                    // the retired `{kind:"plugin",plugin:...}` wrapper is
                    // rejected outright ("format v4 message requires a
                    // producer-owned source kind"). Third-party plugins map to
                    // `plugin:<name>` (the host's producerKind() normalization).
                    // `as never`: the pinned dsh-llm 0.1.5 types still narrow
                    // the kind union; the 0.2.0 host widened it merge-style.
                    source: { kind: "plugin:phone-lens" } as never,
                  }),
                );
                const dim = result.admitted.ref.width ? `, ${result.admitted.ref.width}x${result.admitted.ref.height}` : "";
                return `照片已拍摄并作为图片直接提供给你(附件 ${result.admitted.ref.attachmentId}${dim}),请结合画面内容回应。`;
              }
              return `照片已拍摄并保存到 ${result.admitted.filePath ?? result.admitted.ref.attachmentId}(当前环境无法直接展示图片)。`;
            },
          }) as never,
        ),
      );
      disposers.push(
        toolsSvc.register(
          defineTool({
            name: "phone_camera_pause",
            description:
              "让用户配对的手机摄像头立即进入空闲状态(关闭相机与预览流,省电散热)。" +
              "适用于用户明确要求关闭手机摄像头、或一段时间内不再需要取景时。手机会回执执行结果。",
            parameters: {},
            output: textOutput,
            async execute() {
              const r = await hub.requestCameraState("camera_idle", 8_000);
              return r.ok ? `手机摄像头已进入空闲状态。` : `操作失败: ${r.reason}`;
            },
          }) as never,
        ),
      );
      disposers.push(
        toolsSvc.register(
          defineTool({
            name: "phone_camera_resume",
            description:
              "立即恢复用户配对手机的拍摄状态(打开相机并恢复预览流)。" +
              "适用于用户要求重新打开手机摄像头、或接下来需要拍照/取景时。手机会回执执行结果。",
            parameters: {},
            output: textOutput,
            async execute() {
              const r = await hub.requestCameraState("camera_resume", 8_000);
              return r.ok ? `手机摄像头已恢复拍摄状态。` : `操作失败: ${r.reason}`;
            },
          }) as never,
        ),
      );
      disposers.push(
        toolsSvc.register(
          defineTool({
            name: "phone_camera_zoom",
            description:
              "调整或查询用户配对手机摄像头的变焦倍数。" +
              "三种用法:设定绝对倍数(如 factor=2.0 表示放大到 2 倍,1.0 为原始大小)," +
              "相对当前倍数步进(如 step=1 放大一档、step=-1 缩小一档;档位大小由手机决定)," +
              "或不带任何参数直接查询当前倍数与设备支持的变焦范围。" +
              "设定/步进超出设备支持范围时会自动收拢到最近的可用倍数,返回设置后的实际倍数与设备支持范围。" +
              "相机未开启、设备不支持变焦或手机 App 版本过旧时返回失败原因。" +
              "变焦会同时作用于取景画面与后续拍摄的照片。",
            parameters: {
              factor: { type: "number", description: "目标变焦倍数(绝对值),如 1.0=原始、2.0=放大到 2 倍" },
              step: { type: "number", description: "相对当前倍数的步进量,正值放大、负值缩小,如 1 或 -1" },
            },
            output: textOutput,
            async execute(args: unknown) {
              const factor = numArg(args, "factor");
              const step = numArg(args, "step");
              // no args = pure query (the phone answers with the current ratio
              // and its supported range — absorbed phone_camera_zoom_info)
              const r = await hub.requestZoom({ factor, step }, 8_000);
              if (!r.ok) return `变焦失败: ${r.reason}`;
              const range = r.min !== undefined && r.max !== undefined ? `,设备支持 ${fmtX(r.min)} - ${fmtX(r.max)}` : "";
              return factor === undefined && step === undefined
                ? `当前变焦 ${fmtX(r.factor)}${range}。`
                : `变焦成功:当前 ${fmtX(r.factor)}${range}。`;
            },
          }) as never,
        ),
      );
      disposers.push(
        toolsSvc.register(
          defineTool({
            name: "phone_camera_lens",
            description:
              "切换或查询用户配对手机摄像头正在使用的前置/后置镜头。" +
              "两种用法:lens 传 \"front\" 或 \"back\" 切换到指定镜头(手机会重开相机,约需 1-2 秒);" +
              "或不带参数查询当前使用的镜头与设备可用的镜头列表。" +
              "适用于:拍摄 selfie/自己、用户要求切换前后摄像头、或拍照前先确认当前是哪个镜头。" +
              "相机未开启时仅记录偏好,下次打开相机生效,同样返回成功。" +
              "手机 App 版本过旧(需 ≥ 1.1.3)或设备只有一个镜头时返回失败或说明。",
            parameters: {
              lens: { type: "string", description: "目标镜头方向:\"front\"(前置)或 \"back\"(后置);不传即查询当前镜头" },
            },
            output: textOutput,
            async execute(args: unknown) {
              const raw = asText(args, "lens")?.toLowerCase();
              const lens = raw === "front" || raw === "前置" ? "front" : raw === "back" || raw === "后置" ? "back" : undefined;
              if (raw && lens === undefined) {
                return `无法识别的镜头方向 \"${raw}\",请传 \"front\"(前置)或 \"back\"(后置),或不带参数查询。`;
              }
              const r = await hub.requestLens({ lens }, 12_000);
              if (!r.ok) return `镜头操作失败: ${r.reason}`;
              const now = r.lens === "front" ? "前置" : "后置";
              const avail = r.available && r.available.length > 1 ? `,设备可用镜头: ${r.available.map((d) => (d === "front" ? "前置" : d === "back" ? "后置" : d)).join("、")}` : "";
              return lens === undefined ? `当前使用${now}摄像头${avail}。` : `已切换到${now}摄像头${avail}。`;
            },
          }) as never,
        ),
      );
      disposers.push(
        toolsSvc.register(
          defineTool({
            name: "phone_camera_torch",
            description:
              "打开、关闭或查询用户配对手机的手电筒(闪光灯常亮)。" +
              "三种用法:on=true 打开常亮照明、on=false 关闭、或不带参数查询当前开关状态。" +
              "适用于光线不足的拍摄环境:先打开手电筒补光,再调用拍照,拍完关闭。" +
              "注意:需要相机处于开启状态(相机未开启时返回失败,可先调用 phone_camera_resume 唤醒);" +
              "前置镜头通常没有闪光灯硬件,部分设备会静默不亮;" +
              "手机空闲自动关闭相机时手电筒会一同熄灭,长时间照明需保持相机活跃。" +
              "手机 App 版本过旧(需 ≥ 1.1.6)时返回失败原因。",
            parameters: {
              on: { type: "boolean", description: "true 打开常亮照明 / false 关闭;不传即查询当前状态" },
            },
            output: textOutput,
            async execute(args: unknown) {
              const on = boolArg(args, "on");
              const r = await hub.requestTorch({ on }, 8_000);
              if (!r.ok) return `手电筒操作失败: ${r.reason}`;
              return on === undefined ? `手电筒当前${r.on ? "已开启" : "已关闭"}。` : `手电筒已${r.on ? "开启" : "关闭"}。`;
            },
          }) as never,
        ),
      );
      // "2x" for whole numbers, "1.5x" otherwise — human-readable ratios
      const fmtX = (v: number): string => (Number.isInteger(v) ? `${v}x` : `${v.toFixed(2).replace(/\.?0+$/, "")}x`);
      ctx.effect?.(() => () => {
        for (const d of disposers) {
          try {
            d();
          } catch {
            // one broken unregister must not starve the rest of the cleanup
          }
        }
      }, "phone-lens.modelTools()");
      log("info", "model camera tools registered (phone_take_photo / phone_camera_pause / phone_camera_resume / phone_camera_zoom / phone_camera_lens / phone_camera_torch)");
    } else {
      log("info", "no tools service on this ctx — model camera tools skipped (standalone/dev)");
    }
    } catch (error) {
      // never propagate: a broken tool wiring must not take the receiver down
      log("warn", `model camera tools not wired (receiver unaffected): ${String(error)}`);
    }

    let handle: LensServerHandle | null = null;
    // set the moment the fiber disposes: the server promise may still be
    // mid-listen, and without this flag its .then would park a live server
    // (http + heartbeat + wss + hub timers) that nobody will ever dispose —
    // EADDRINUSE on the next load, timers stacking on every reload
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
      log,
    })
      .then(async (h) => {
        if (disposed) {
          void h.dispose();
          return;
        }
        handle = h;
        // boot-time safety net: if settings.json already has the beta on
        // (persisted from a previous run), wire the taps now — otherwise the
        // bridge stays fully inert until /app-settings flips it
        if (appSettings.get().workBetaEnabled) workBridge.setEnabled(true);
        const { code, expiresAt } = pairing.current();
        const qr = await buildPairingQr(code, expiresAt, config);
        // ASCII QR goes to the real stdout; prefixing it through the logger
        // would mangle the block characters.
        process.stdout.write(`\n[phone-lens] 手机扫码配对(或浏览器打开 http://127.0.0.1:${h.port}/view.html):\n${qr.ascii}\n[phone-lens] 备用地址: ${qr.urls.join("  ")}\n\n`);
      })
      .catch((error: unknown) => {
        // the thrown message already names the full busy range when every
        // candidate port (8791~8800) was taken — no stale single-port hint
        log("error", `receiver failed to start: ${String(error)}`);
        // the hub's 1s stall watchdog was armed in its constructor — without
        // this it (and the http heartbeat) would keep ticking on a dead
        // receiver and pile up across plugin reloads
        hub.dispose();
      });

    ctx.effect(() => () => {
      disposed = true;
      void handle?.dispose();
      handle = null;
    }, "phone-lens.server()");
  }
}
