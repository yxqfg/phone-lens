# DSH 能力缝调研结论(0.1.1-rc.2 编译产物源码阅读)

> 依据:`C:\Users\Lenovo\AppData\Local\nvm\v22.22.1\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\*`
> 说明:monorepo 的 docs/(capability-seams 等)未随包发布,以下均直接读 `lib/*.js` / `lib/types/*.d.ts`(含源码注释)。

## 插件模型

- 插件 = cordis 插件:`{ inject: [...], apply(ctx) {...} }`;能力 = 消费/提供 Service、监听事件、注册模型工具、注册浏览器 Slot UI(`dsh-tool-cordis/lib/index.js` `CORDIS_SYSTEM_PROMPT`,L6873 起)。
- Service 定义:类继承 `Service`,`super(ctx, "名字")`(例:`dsh-web/lib/index.js` 的 `WebRuntime` → `ctx.web`)。
- 接入 profile:插件包声明 `dsh.bundle.patch: "./cordis.patch.yml"` + exports 暴露该文件;`dsh plugin --profile web add <pkg>` 经 pnpm 安装并自动 reconcile 层列表(`dsh/lib/plugin-9h8shc4d.js`)。patch 形状参考 `dsh-web-app/cordis.patch.yml`(`- insert: [- id: x, name: <pkg>, config: {...}]`)。
- 双面包:package.json 再声明 `"dsh": { "client": { "platform": "web", "inject": [...] } }` + `exports["./client"]`;client bundle 由 `dsh-client-modules` 扫描、经 `/plugins/<id>/client.js` 下发、浏览器端 cordis 执行 `apply(ctx)`。参考 `dsh-client-ui-attachment`。

## Q1 附件:能,且模型直读

- `ctx.attachments` = Service "attachments"(`dsh-attachment/lib/index.js` L100-103);默认实现 `LocalAttachmentStore`(`dsh-attachment-local/lib/index.js` L808),媒体白名单 `image/png|jpeg|webp|gif`(L838-843)。
- 进程内入口:`ctx.attachments.saveImages([{ data: Uint8Array, mediaType, name }])` → `ImageAttachmentRef[]`(持久化 content-addressed,即落盘);wire 入口 `admitEncodedImages`(base64)。
- host 把 prompt 的 image part 提升为 `{type:"image", attachment: ref}`(`dsh-host-apiproxy/lib/index.js` L888-902)。
- 模型侧:适配器 `prepareRequestImages` 遍历消息收集 ImageBlock → `readImageRequest(ref, policy)` 投影后进 provider 请求(`dsh-llm-deepseek/lib/index.js` L1237-1244)。
- 注入会话:`createUserMessage({content:[{type:'image',attachment:ref},...], source:{kind:'plugin',plugin:'<id>'}})` → `agent.followup / steer / send / inject`(`dsh-agent/lib/types/runtime-types.d.ts` L109-132)。DSH 自身的 runtime-context 注入即此模式(`dsh-agent-loop/lib/index.js` L67-82)。
- 限制:仅图片 v1;默认 20 张/消息、单消息 200MB、单图 20MB/64MP/8192px;请求前归一化 ≤2048px/4MB;无 GC。

## Q2 Web UI:能注入,必须走 Slot(React 组件,无 JSX)

- 聊天内图片渲染位:`conversation.message.images`(single,owner 给 `images[]` + `loadImage(ref)` + `align`);节点级:`conversation.chat.node`(按 `ChatNodeKind` keyed,`ChatNodeDataMap` 可合并扩展新 kind)。注册范例:`dsh-client-ui-attachment/lib/client.js` L765-774:`ctx.slots.inject(key, () => ctx.slots.register({name, locale}, Component))`。
- 悬浮层:`shell.overlay` —— list 型、root scope、帧级浮动、默认点击穿透、entry 主动 opt-in 指针事件(`dsh-client-ui-layout/lib/types/client/index.d.ts` L67-80)。悬浮取景小窗的官方座位。
- 边界:`root/conversation/sidebar/details/conversation.session` 等为 single 席位,注册即**替换**整块(勿碰);加法用 list/keyed/chain(`shell.overlay`、`conversation.chat.node`、`conversation.view`、`conversation.session.header.actions`…)。
- Host↔Client:仅 Client→Host 的包私有 JSON RPC(`harness.handle` / `host.call`),只传 lossless JSON。client 代码不转译(无 TS/JSX/bundler),React 用 `createElement`;副作用必须可逆(ctx.effect/on + disposer)。

## Q3 hooks:无 Claude Code 兼容

- 全树无 `UserPromptSubmit/PreToolUse/PostToolUse/hooks` 配置面。
- 等价物 = cordis agent 事件(`dsh-agent/lib/types/runtime-types.d.ts`):
  - `agent/created` `agent/disposed` `agent/status`(emit)
  - `agent/inbox/inserted` `agent/inbox/claimed` `agent/inbox/discarded`(emit)
  - `agent/session-start`(emit;配 `agent.inject()` 播种上下文)
  - **`agent/pre-step`(waterfall)** ≈ UserPromptSubmit:payload `{agent, messages, turn, step, signal}`,`next()` 保留 / 返回 `{kind:'reject'}` 拒绝 / `{kind:'enter', messages}` 替换进入该步的消息;触发点 `dsh-agent-loop/lib/index.js` L501-514
  - `agent/request`(waterfall,改 LLM 配置,不能改 messages)、`agent/request-error`(waterfall)、`agent/turn-stopping`(serial)、`agent/error`(emit)
- 注册:`apply(ctx)` 内 `ctx.on("agent/pre-step", (payload, next) => {...})`;agent 事件经 `agentEvents`→`scopeTarget` 分发,无 scope 监听者全局放行(`dsh-scope/lib/index.js` L327-338),普通 host 插件可收到。
