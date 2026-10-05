import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../core/api.dart';
import '../../core/camera_socket.dart';
import '../../core/global_link.dart';
import '../pair/pair_screen.dart';
import 'settings_screen.dart' show SectionHeader;

/// The settings screen collapsed into a few entry points; each page here
/// keeps the original tiles and behaviour verbatim, just regrouped.

/// 连接与配对 — device list, add-pairing, auto-select fallback.
class ConnectionSettingsPage extends StatefulWidget {
  final LensStore store;
  final VoidCallback onChanged;
  const ConnectionSettingsPage({super.key, required this.store, required this.onChanged});

  @override
  State<ConnectionSettingsPage> createState() => _ConnectionSettingsPageState();
}

class _ConnectionSettingsPageState extends State<ConnectionSettingsPage> {
  final _api = LensApi();
  // Cross-end version consistency: the active receiver's host version (from
  // /status) vs the local App version. Older hosts omit `version` → "—" and
  // no hint (graceful degradation).
  String? _hostVersion;
  String? _appVersion;
  bool _probingVersion = false;

  @override
  void initState() {
    super.initState();
    _loadVersions();
  }

  @override
  void dispose() {
    _api.dispose();
    super.dispose();
  }

  Future<void> _loadVersions() async {
    final s = widget.store.server;
    if (s == null || _probingVersion) return;
    _probingVersion = true;
    try {
      final info = await _api.status(s);
      if (!mounted) return;
      setState(() => _hostVersion = info['version'] as String?);
    } catch (_) {
      if (mounted) setState(() => _hostVersion = null);
    } finally {
      _probingVersion = false;
    }
    try {
      final pi = await PackageInfo.fromPlatform();
      if (mounted) setState(() => _appVersion = pi.version);
    } catch (_) {}
  }

  Future<void> _serverActions(PairedServer s) async {
    final active = widget.store.server?.id == s.id;
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.check_circle_outline),
              title: Text(active ? '当前活动连接' : '设为活动连接'),
              enabled: !active,
              onTap: () => Navigator.pop(ctx, 'activate'),
            ),
            ListTile(
              leading: const Icon(Icons.edit_outlined),
              title: const Text('重命名'),
              onTap: () => Navigator.pop(ctx, 'rename'),
            ),
            ListTile(
              leading: const Icon(Icons.delete_outline, color: Colors.red),
              title: const Text('删除此配对'),
              onTap: () => Navigator.pop(ctx, 'delete'),
            ),
          ],
        ),
      ),
    );
    if (!mounted || action == null) return;
    if (action == 'activate') {
      await widget.store.setActive(s.id);
    } else if (action == 'rename') {
      if (!mounted) return;
      final ctrl = TextEditingController(text: s.name);
      final name = await showDialog<String>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('重命名'),
          content: TextField(controller: ctrl, autofocus: true, decoration: const InputDecoration(hintText: '如:工作电脑')),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: const Text('保存')),
          ],
        ),
      );
      if (name != null && name.isNotEmpty) await widget.store.renameServer(s.id, name);
    } else if (action == 'delete') {
      if (!mounted) return;
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text('删除配对「${s.name}」?'),
          content: const Text('删除后需要重新扫码才能连接这台电脑。'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
          ],
        ),
      );
      if (ok != true) return;
      await widget.store.removeServer(s.id);
    }
    if (mounted) setState(() {});
    widget.onChanged();
  }

  Future<void> _addPairing() async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => PairScreen(store: widget.store, onPaired: () {
        if (mounted) setState(() {});
        widget.onChanged();
      })),
    );
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final servers = widget.store.servers();
    final activeId = widget.store.server?.id;
    return Scaffold(
      appBar: AppBar(title: const Text('连接与配对')),
      body: ListView(
        children: [
          const SectionHeader('已配对电脑'),
          ValueListenableBuilder<LensLinkState>(
            valueListenable: globalLink,
            builder: (_, link, __) => Column(
              children: [
                for (final s in servers)
                  ListTile(
                    leading: Icon(
                      activeId == s.id ? Icons.computer : Icons.computer_outlined,
                      color: activeId == s.id ? Colors.green : null,
                    ),
                    title: Text(s.name),
                    subtitle: Text('${s.host}:${s.port}'),
                    trailing: activeId == s.id
                        ? linkChip(link)
                        : null,
                    onTap: () => _serverActions(s),
                  ),
                if (activeId != null)
                  Builder(
                    builder: (_) {
                      final mismatch = _hostVersion != null && _appVersion != null && _hostVersion != _appVersion;
                      return ListTile(
                        dense: true,
                        leading: Icon(
                          mismatch ? Icons.warning_amber_rounded : Icons.verified_user_outlined,
                          size: 20,
                          color: mismatch ? const Color(0xFFD9A441) : Colors.white38,
                        ),
                        title: Text('电脑端版本', style: TextStyle(color: mismatch ? const Color(0xFFD9A441) : null)),
                        subtitle: mismatch
                            ? const Text('两端版本不一致,建议两端同时更新', style: TextStyle(color: Color(0xFFD9A441), fontSize: 11))
                            : null,
                        trailing: Text(_hostVersion ?? '—', style: const TextStyle(color: Colors.white70)),
                      );
                    },
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: OutlinedButton.icon(
              onPressed: _addPairing,
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('扫码新增配对'),
            ),
          ),
          const SectionHeader('配对通道'),
          SwitchListTile(
            title: const Text('自动选择可用连接'),
            subtitle: const Text('当前电脑不可达(如切换网络)时,自动扫描并切换到可用的已配对电脑;默认关闭'),
            value: widget.store.autoSelect,
            onChanged: (v) async {
              await widget.store.setAutoSelect(v);
              if (mounted) setState(() {});
            },
          ),
        ],
      ),
    );
  }
}

/// 拍摄与上传 — picture tuning, crop defaults, upload quality.
class CaptureSettingsPage extends StatefulWidget {
  final LensStore store;
  const CaptureSettingsPage({super.key, required this.store});

  @override
  State<CaptureSettingsPage> createState() => _CaptureSettingsPageState();
}

class _CaptureSettingsPageState extends State<CaptureSettingsPage> {
  static const _idleOptions = <int, String>{
    0: '不自动关闭',
    1: '1 分钟',
    5: '5 分钟(推荐)',
    30: '30 分钟',
  };

  static const _wakeFocusOptions = <int, String>{
    0: '直接拍(无等待)',
    800: '0.8 秒',
    1500: '1.5 秒(推荐)',
    3000: '3 秒',
  };

  String get _wakeFocusLabel =>
      _wakeFocusOptions[widget.store.wakeFocusDelayMs] ?? '${widget.store.wakeFocusDelayMs} 毫秒';

  Future<void> _pickWakeFocusDelay() async {
    final v = await showModalBottomSheet<int>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.all(14),
              child: Text('唤醒后对焦等待', style: TextStyle(fontWeight: FontWeight.w600)),
            ),
            for (final e in _wakeFocusOptions.entries)
              ListTile(
                leading: Icon(
                  widget.store.wakeFocusDelayMs == e.key ? Icons.check_circle : Icons.radio_button_unchecked,
                  color: widget.store.wakeFocusDelayMs == e.key ? Theme.of(ctx).colorScheme.primary : null,
                ),
                title: Text(e.value),
                onTap: () => Navigator.pop(ctx, e.key),
              ),
            const SizedBox(height: 6),
          ],
        ),
      ),
    );
    if (v != null) {
      await widget.store.setWakeFocusDelayMs(v);
      if (mounted) setState(() {});
    }
  }

  String get _idleLabel => _idleOptions[widget.store.cameraIdleTimeoutMin] ?? '${widget.store.cameraIdleTimeoutMin} 分钟';

  Future<void> _pickIdleTimeout() async {
    final v = await showModalBottomSheet<int>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.all(14),
              child: Text('空闲自动关闭相机', style: TextStyle(fontWeight: FontWeight.w600)),
            ),
            for (final e in _idleOptions.entries)
              ListTile(
                leading: Icon(
                  widget.store.cameraIdleTimeoutMin == e.key ? Icons.check_circle : Icons.radio_button_unchecked,
                  color: widget.store.cameraIdleTimeoutMin == e.key ? Theme.of(ctx).colorScheme.primary : null,
                ),
                title: Text(e.value),
                onTap: () => Navigator.pop(ctx, e.key),
              ),
            const SizedBox(height: 6),
          ],
        ),
      ),
    );
    if (v == null) return;
    await widget.store.setCameraIdleTimeoutMin(v);
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('拍摄与上传')),
      body: ListView(
        children: [
          const SectionHeader('相机'),
          ListTile(
            leading: const Icon(Icons.timer_outlined),
            title: const Text('空闲自动关闭相机'),
            subtitle: const Text('长时间无拍摄时自动关闭摄像头与预览(降温省电);点拍摄键或「启动预览」立即恢复'),
            trailing: Text(_idleLabel, style: const TextStyle(color: Colors.white70)),
            onTap: _pickIdleTimeout,
          ),
          const SectionHeader('画面'),
          SwitchListTile(
            title: const Text('取景对焦'),
            subtitle: const Text('开启后可在取景画面点击对焦、长按锁定对焦；关闭则使用相机自动对焦'),
            value: widget.store.focusEnabled,
            onChanged: (v) async {
              await widget.store.setFocusEnabled(v);
              if (mounted) setState(() {});
            },
          ),
          SwitchListTile(
            title: const Text('拍照提醒'),
            subtitle: const Text('电脑端(含对话内模型)请求本机拍照上传时,弹出消息条并震动提醒'),
            value: widget.store.remoteCaptureAlert,
            onChanged: (v) async {
              await widget.store.setRemoteCaptureAlert(v);
              if (mounted) setState(() {});
            },
          ),
          ListTile(
            title: const Text('唤醒后对焦等待'),
            subtitle: const Text('摄像头从休眠被远程请求唤醒后,先等待自动对焦收敛再拍,避免糊片;0 为直接拍'),
            trailing: Text(_wakeFocusLabel, style: const TextStyle(color: Colors.white70)),
            onTap: _pickWakeFocusDelay,
          ),
          const SectionHeader('裁剪'),
          _buildCropRatioTile(),
          _buildHandleSizeTile(),
          const SectionHeader('上传画质'),
          for (final entry in const [
            (LensStore.qualityHigh, '高(原图直传)', '保持相机原始画质,仅超出电脑端大小限制时压缩;文件最大'),
            (LensStore.qualityMedium, '中(推荐)', '重编码至长边 2560px,画质几乎无损,体积约为原图的 1/3'),
            (LensStore.qualityLow, '低(省流量)', '重编码至长边 1600px,弱网环境下上传更快'),
          ])
            RadioListTile<String>(
              value: entry.$1,
              // ignore: deprecated_member_use
              groupValue: widget.store.uploadQuality,
              title: Text(entry.$2),
              subtitle: Text(entry.$3),
              // ignore: deprecated_member_use
              onChanged: (v) async {
                if (v == null) return;
                await widget.store.setUploadQuality(v);
                if (mounted) setState(() {});
              },
            ),
        ],
      ),
    );
  }

  Widget _buildCropRatioTile() {
    final ratio = widget.store.defaultCropRatio;
    return Column(
      children: [
        ListTile(
          leading: const Icon(Icons.crop),
          title: const Text('默认裁剪范围'),
          subtitle: Text('进入裁剪页面时,默认框选图片中心区域的 ${(ratio * 100).round()}%'),
          trailing: Text('${(ratio * 100).round()}%', style: const TextStyle(color: Colors.white70)),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Slider(
            value: ratio,
            min: 0.2,
            max: 0.9,
            divisions: 14,
            label: '${(ratio * 100).round()}%',
            onChanged: (v) async {
              await widget.store.setDefaultCropRatio(v);
              if (mounted) setState(() {});
            },
          ),
        ),
      ],
    );
  }

  Widget _buildHandleSizeTile() {
    final hs = widget.store.handleSize;
    return Column(
      children: [
        ListTile(
          leading: const Icon(Icons.open_with),
          title: const Text('裁剪手柄大小'),
          subtitle: const Text('裁剪框四角控制手柄的显示尺寸与交互命中半径'),
          trailing: Text('${hs.round()}px', style: const TextStyle(color: Colors.white70)),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Slider(
            value: hs,
            min: 10,
            max: 22,
            divisions: 12,
            label: '${hs.round()}px',
            onChanged: (v) async {
              await widget.store.setHandleSize(v);
              if (mounted) setState(() {});
            },
          ),
        ),
      ],
    );
  }
}

/// 发送历史 — history retention mode.
class HistorySettingsPage extends StatefulWidget {
  final LensStore store;
  const HistorySettingsPage({super.key, required this.store});

  @override
  State<HistorySettingsPage> createState() => _HistorySettingsPageState();
}

class _HistorySettingsPageState extends State<HistorySettingsPage> {
  static const _cleanOptions = <(String, String)>[
    (LensStore.historyCleanOff, '不自动清除'),
    (LensStore.historyCleanStartup, '每次启动 APP 时'),
    (LensStore.historyCleanDaily, '每天'),
    (LensStore.historyCleanWeekly, '每周'),
    (LensStore.historyCleanMonthly, '每月'),
  ];

  String get _cleanLabel =>
      _cleanOptions.firstWhere((e) => e.$1 == widget.store.historyAutoClean, orElse: () => _cleanOptions.first).$2;

  Future<void> _pickAutoClean() async {
    final v = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.all(14),
              child: Text('自动清除发送历史', style: TextStyle(fontWeight: FontWeight.w600)),
            ),
            for (final e in _cleanOptions)
              ListTile(
                leading: Icon(
                  widget.store.historyAutoClean == e.$1 ? Icons.check_circle : Icons.radio_button_unchecked,
                  color: widget.store.historyAutoClean == e.$1 ? Theme.of(ctx).colorScheme.primary : null,
                ),
                title: Text(e.$2),
                onTap: () => Navigator.pop(ctx, e.$1),
              ),
            const SizedBox(height: 6),
          ],
        ),
      ),
    );
    if (v == null || v == widget.store.historyAutoClean) return;
    await widget.store.setHistoryAutoClean(v);
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('发送历史')),
      body: ListView(
        children: [
          const SectionHeader('历史保留方式'),
          for (final entry in const [
            (LensStore.historyUploadOnly, '仅上传', '仅保留发送记录,不在本机存储图片'),
            (LensStore.historyKeepImage, '图片留档', '历史条目附带图片,可查看并保存至系统相册'),
            (LensStore.historyNoTrace, '不留任何痕迹', '不在本机保留任何发送记录'),
          ])
            RadioListTile<String>(
              value: entry.$1,
              // ignore: deprecated_member_use
              groupValue: widget.store.historyMode,
              title: Text(entry.$2),
              subtitle: Text(entry.$3),
              // ignore: deprecated_member_use
              onChanged: (v) async {
                if (v == null) return;
                await widget.store.setHistoryMode(v);
                if (mounted) setState(() {});
              },
            ),
          const SectionHeader('自动清除'),
          ListTile(
            leading: const Icon(Icons.auto_delete_outlined),
            title: const Text('定期自动清除历史'),
            subtitle: const Text('按周期删除全部发送记录与留档图片;不影响配对与连接记忆'),
            trailing: Text(_cleanLabel, style: const TextStyle(color: Colors.white70)),
            onTap: _pickAutoClean,
          ),
        ],
      ),
    );
  }
}

/// Connection state chip shared by the settings entry list and the
/// connection page's device tiles.
Chip linkChip(LensLinkState link) {
  final (label, color) = switch (link) {
    LensLinkState.connected => ('已连接', Colors.green),
    LensLinkState.connecting => ('连接中', Colors.lightBlue),
    LensLinkState.disconnected => ('未连接', Colors.white38),
  };
  return Chip(
    label: Text(label, style: TextStyle(color: color, fontSize: 12)),
    visualDensity: VisualDensity.compact,
    side: BorderSide(color: color),
    backgroundColor: color.withValues(alpha: 0.12),
  );
}

/// Quality label helper for the capture entry's summary line.
String qualityLabel(String quality) => switch (quality) {
  LensStore.qualityHigh => '高(原图直传)',
  LensStore.qualityMedium => '中(推荐)',
  LensStore.qualityLow => '低(省流量)',
  _ => quality,
};

/// History-mode label helper for the history entry's summary line.
String historyModeLabel(String mode) => switch (mode) {
  LensStore.historyUploadOnly => '仅上传',
  LensStore.historyKeepImage => '图片留档',
  LensStore.historyNoTrace => '不留任何痕迹',
  _ => mode,
};
