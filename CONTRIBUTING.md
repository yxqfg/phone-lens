# 贡献指南

欢迎参与 PhoneLens 的开发。感谢任何形式的贡献：报告问题、提交修复、补充文档、改进功能。

## 目录

- [开发环境](#开发环境)
- [工作流程](#工作流程)
- [提交规范](#提交规范)
- [代码风格](#代码风格)
- [报告问题](#报告问题)
- [许可证](#许可证)

## 开发环境

本项目为 monorepo，包含两个独立子项目：

- **主机插件**（`packages/phone-lens`，包名 `phone-lens`）：Node/TypeScript，pnpm 构建
- **手机 App**（`packages/app`）：Flutter/Dart

请确保已安装 `pnpm` 与 Flutter SDK。

```bash
# 主机插件
cd packages/phone-lens
pnpm install
pnpm build            # tsdown 构建 lib/index.js + lib/dev.js

# 手机 App
cd packages/app
flutter pub get
flutter run            # 或 flutter build apk --release
```

## 工作流程

1. **Fork** 本仓库并创建特性分支：`git checkout -b feat/your-change`
2. 保持改动聚焦、可评审；一个 PR 只解决一个问题
3. 修改前先阅读 `docs/architecture.md` 与 `docs/protocol.md`，确保改动与既有设计一致
4. 提交前运行相关构建与冒烟测试
5. 向主分支发起 Pull Request，说明动机与测试方式

## 提交规范

建议使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: 新增手机端「设为主机」按钮
fix: 修复批量裁剪时跳回主页的问题
docs: 更新协议规范中的 /info 字段
refactor: 统一模块标识为 phone-lens
```

## 代码风格

- **TypeScript**：遵循项目既有风格；`lib/client.js` 为手写构建产物，改动后请运行 `node --check lib/client.js`
- **Dart/Flutter**：遵循 `analysis_options.yaml`（flutter_lints）
- 中文注释 / 中文用户可见文案

## 报告问题

请在 Issue 中说明：

- 环境（dsh 版本 / Flutter 版本 / Android 版本 / 设备型号）
- 复现步骤
- 期望行为与实际行为
- 相关日志（可脱敏）

涉及安全的问题请走 [SECURITY.md](SECURITY.md) 的流程，**不要**在公开 Issue 中暴露 token、密钥。

## 许可证

本项目以 [MIT](LICENSE) 许可发布；提交即表示同意以该许可证分发你的贡献。
