# PhoneLens App（手机端）

Flutter / Android 客户端：扫码配对、实时取景、拍照/裁剪/批量上传、设置与历史。

## 功能

- **扫码配对**：一次性配对码，设备 token 只存哈希，重连免扫码
- **实时取景**：MJPEG-over-WebSocket 推流到电脑端
- **拍照**：全分辨率 `takePicture`，可选裁剪后上传
- **裁剪**：自定义裁剪页（90° 旋转、框不出界、手柄可调）；相册批量连续裁剪
- **多设备**：「设为主机」一键抢占电脑端预览
- **设置**：颜色校正、取景对焦、自动选择可用连接、发送历史三档、关于与帮助

## 构建与安装

```powershell
flutter pub get
flutter build apk --release
adb install -r build\app\outputs\flutter-apk\app-release.apk
```

或使用仓库根 `scripts\adb-install.ps1 -Run`。

## 依赖

`camera`（含 `camera_android`，强制 yuv420 取帧）、`web_socket_channel`、`mobile_scanner`、
`image`、`image_picker`、`shared_preferences`、`permission_handler`、`device_info_plus`、
`sensors_plus`、`path_provider`、`gal` 等。

## 说明

- 应用显示名为 **PhoneLens**（包名沿用 `lens_mate`）。
- 图标由 `flutter_launcher_icons` 生成，配置见 `flutter_launcher_icons.yaml`。
- 更多用法见 [`docs/usage.md`](../../docs/usage.md)。
