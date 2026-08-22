import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/camera_socket.dart';
import '../../core/global_link.dart';
import '../../ui/background_art.dart';
import '../pair/pair_screen.dart';
import 'about_screen.dart';

/// Receiver management (multiple pairings, one active), target session, history.
class SettingsScreen extends StatefulWidget {
  final LensStore store;
  final VoidCallback onChanged;
  const SettingsScreen({super.key, required this.store, required this.onChanged});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _api = LensApi();
  List<SessionTarget> _targets = [];
  bool _loadingTargets = false;

  @override
  void initState() {
    super.initState();
    _loadTargets();
  }

  @override
  void dispose() {
    _api.dispose();
    super.dispose();
  }

  Future<void> _loadTargets() async {
    final server = widget.store.server;
    if (server == null) return;
    setState(() => _loadingTargets = true);
    try {
      final targets = await _api.targets(server);
      if (mounted) setState(() => _targets = targets);
    } catch (_) {
      if (mounted) setState(() => _targets = const []);
    } finally {
      if (mounted) setState(() => _loadingTargets = false);
    }
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
    final selected = widget.store.targetSession;
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        children: [
          const SectionHeader('配对与设备'),
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
                        ? _linkChip(link)
                        : null,
                    onTap: () => _serverActions(s),
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
          const SectionHeader('注入目标'),
          ListTile(
            leading: const Icon(Icons.center_focus_strong),
            title: const Text('最近活跃会话(默认)'),
            trailing: selected == null ? const Icon(Icons.check, color: Colors.green) : null,
            onTap: () async {
              await widget.store.setTargetSession(null);
              if (mounted) setState(() {});
            },
          ),
          if (_loadingTargets) const Padding(padding: EdgeInsets.all(12), child: Center(child: CircularProgressIndicator())),
          for (final t in _targets)
            ListTile(
              leading: const Icon(Icons.tag),
              title: Text('${t.title.isEmpty ? t.sessionId.substring(0, 12) : t.title} ${t.active ? "(活跃)" : ""}'),
              subtitle: Text(t.sessionId, overflow: TextOverflow.ellipsis),
              trailing: selected == t.sessionId ? const Icon(Icons.check, color: Colors.green) : null,
              onTap: () async {
                await widget.store.setTargetSession(t.sessionId);
                if (mounted) setState(() {});
              },
            ),
          TextButton.icon(
            onPressed: _loadTargets,
            icon: const Icon(Icons.refresh),
            label: const Text('刷新目标列表'),
          ),
          const SectionHeader('画面'),
          SwitchListTile(
            title: const Text('颜色校正(红蓝互换)'),
            subtitle: const Text('当预览画面出现红/蓝色通道颠倒或肤色失真时启用；不同设备色度通道布局可能不同'),
            value: widget.store.chromaSwap,
            onChanged: (v) async {
              await widget.store.setChromaSwap(v);
              if (mounted) setState(() {});
            },
          ),
          SwitchListTile(
            title: const Text('取景对焦'),
            subtitle: const Text('开启后可在取景画面点击对焦、长按锁定对焦；关闭则使用相机自动对焦'),
            value: widget.store.focusEnabled,
            onChanged: (v) async {
              await widget.store.setFocusEnabled(v);
              if (mounted) setState(() {});
            },
          ),
          const SectionHeader('裁剪'),
          _buildCropRatioTile(),
          _buildHandleSizeTile(),
          const SectionHeader('发送历史'),
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
          const SizedBox(height: 8),
          const Divider(color: Colors.white12, height: 1),
          const SectionHeader('关于和帮助'),
          ListTile(
            leading: const Icon(Icons.info_outline),
            title: const Text('关于和帮助'),
            subtitle: const Text('新手操作 / 连接与异常处理'),
            trailing: const Icon(Icons.chevron_right, color: Colors.white54),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const AboutScreen()),
            ),
          ),
          // only appears at the very bottom of the settings list
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: BackgroundArt(positioned: false, widthFactor: 0.45),
          ),
        ],
      ),
    );
  }

  Widget _linkChip(LensLinkState link) {
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
