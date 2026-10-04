import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../core/api.dart';
import '../../core/camera_socket.dart';
import '../../core/global_link.dart';
import '../../core/update_check.dart';import '../../ui/background_art.dart';
import 'about_screen.dart';
import 'settings_subpages.dart';

/// Settings hub: a few grouped entry points, with "检查更新" kept as a
/// standalone top-level action. Each entry opens a subpage (see
/// settings_subpages.dart) holding the original tiles, unchanged.
class SettingsScreen extends StatefulWidget {
  final LensStore store;
  final VoidCallback onChanged;
  const SettingsScreen({super.key, required this.store, required this.onChanged});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  String _currentVersion = '';
  bool _checkingUpdate = false;

  @override
  void initState() {
    super.initState();
    PackageInfo.fromPlatform().then((info) {
      if (mounted) setState(() => _currentVersion = info.version);
    }).catchError((_) {});
  }

  /// Manual check from Settings: unlike the throttled startup check this
  /// always queries the feeds and always reports the outcome.
  Future<void> _manualCheckUpdate() async {
    if (_checkingUpdate) return;
    setState(() => _checkingUpdate = true);
    final info = await checkForUpdate();
    if (!mounted) return;
    setState(() => _checkingUpdate = false);
    if (info == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('检查失败,请确认网络后重试')),
      );
    } else if (!info.isNewer) {
      await widget.store.setUpdateAvailable(false);
      globalUpdateAvailable.value = false;
      if (!mounted) return;
      setState(() {});
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('已是最新版本 v${info.latestVersion}')),
      );
    } else {
      await widget.store.setUpdateAvailable(true);
      globalUpdateAvailable.value = true;
      if (!mounted) return;
      setState(() {});
      await showUpdateDialog(context, info);
    }
  }

  Future<void> _pushSub(Widget page) async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => page),
    );
    // push() resolves as soon as the pop STARTS; rebuilding here would fight
    // the ~300ms pop transition for frames (visible stutter). Let the
    // transition finish, then refresh the entry subtitles.
    await Future<void>.delayed(const Duration(milliseconds: 350));
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final active = widget.store.server;
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      // The illustration is a FIXED watermark pinned to the viewport's
      // bottom-right (below the scroll layer, tap-transparent) — as an inline
      // list footer it sat wherever the content happened to end, leaving a
      // large gap to the screen bottom whenever the list was shorter than
      // one viewport.
      body: Stack(
        children: [
          const BackgroundArt(positioned: true, widthFactor: 0.45),
          ListView(
            children: [
          ListTile(
            leading: const Icon(Icons.computer_outlined),
            title: const Text('连接与配对'),
            subtitle: Text(active == null ? '未配对任何电脑' : active.name),
            trailing: ValueListenableBuilder<LensLinkState>(
              valueListenable: globalLink,
              builder: (_, link, __) => Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (active != null) linkChip(link),
                  const SizedBox(width: 4),
                  const Icon(Icons.chevron_right, color: Colors.white54),
                ],
              ),
            ),
            onTap: () => _pushSub(ConnectionSettingsPage(store: widget.store, onChanged: widget.onChanged)),
          ),
          ListTile(
            leading: const Icon(Icons.photo_camera_outlined),
            title: const Text('拍摄与上传'),
            subtitle: Text(
              '画质:${qualityLabel(widget.store.uploadQuality)} · 裁剪 ${(widget.store.defaultCropRatio * 100).round()}%',
            ),
            trailing: const Icon(Icons.chevron_right, color: Colors.white54),
            onTap: () => _pushSub(CaptureSettingsPage(store: widget.store)),
          ),
          ListTile(
            leading: const Icon(Icons.history),
            title: const Text('发送历史'),
            subtitle: Text(historyModeLabel(widget.store.historyMode)),
            trailing: const Icon(Icons.chevron_right, color: Colors.white54),
            onTap: () => _pushSub(HistorySettingsPage(store: widget.store)),
          ),
          const Divider(color: Colors.white12, height: 1),
          // 检查更新 stays a standalone top-level action by design.
          ListTile(
            leading: _checkingUpdate
                ? const SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.system_update_alt),
            title: const Text('检查更新'),
            subtitle: Text(_currentVersion.isEmpty ? '查询应用最新版本' : '当前版本 v$_currentVersion'),
            trailing: ValueListenableBuilder<bool>(
              valueListenable: globalUpdateAvailable,
              builder: (_, hasUpdate, __) => hasUpdate
                  ? Row(mainAxisSize: MainAxisSize.min, children: [
                      const Text(
                        '有更新!',
                        style: TextStyle(color: Colors.amber, fontWeight: FontWeight.bold, fontSize: 13),
                      ),
                      const SizedBox(width: 6),
                      const Icon(Icons.chevron_right, color: Colors.white54),
                    ])
                  : const Icon(Icons.chevron_right, color: Colors.white54),
            ),
            onTap: _manualCheckUpdate,
          ),
          ListTile(
            leading: const Icon(Icons.info_outline),
            title: const Text('关于和帮助'),
            subtitle: const Text('新手操作 / 连接与异常处理'),
            trailing: const Icon(Icons.chevron_right, color: Colors.white54),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const AboutScreen()),
            ),
          ),
            ],
          ),
        ],
      ),
    );
  }
}

class SectionHeader extends StatelessWidget {
  final String text;
  const SectionHeader(this.text, {super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w600,
          color: Theme.of(context).colorScheme.primary,
          letterSpacing: 1.2,
        ),
      ),
    );
  }
}
