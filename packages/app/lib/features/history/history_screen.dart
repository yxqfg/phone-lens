import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:gal/gal.dart';

import '../../core/api.dart';
import '../../core/open_with.dart';

/// 历史记录页:
/// - 发送历史 (包含留档图片、多选删除、清空全部)
/// - 工作下载 (仅在启用工作(Beta)时出现; 按工作区上下并排分类, 单项删除彻底删除本地文件, 右上角一键清空带5s警告)
class HistoryScreen extends StatefulWidget {
  final LensStore store;
  const HistoryScreen({super.key, required this.store});

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  int _currentTab = 0; // 0: 发送历史, 1: 工作下载

  // 发送历史多选与清空状态
  final Set<String> _selected = {};
  bool _selecting = false;
  int _clearArm = -1; // 发送历史倒计时; -1 = 未激活

  // 工作下载清空5s警告状态
  int _clearDownloadsArm = -1; // -1 = 未激活, 5..1 = 倒计时警告中, 0 = 可确认清空

  @override
  void initState() {
    super.initState();
    globalWorkDownloadsVersion.addListener(_onVersionChanged);
  }

  @override
  void dispose() {
    globalWorkDownloadsVersion.removeListener(_onVersionChanged);
    super.dispose();
  }

  void _onVersionChanged() {
    if (mounted) setState(() {});
  }

  // ── 发送历史逻辑 ──────────────────────────────────────────────────────────

  Future<void> _deleteSelected() async {
    final count = _selected.length;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('删除所选 $count 条?'),
        content: const Text('所选记录及其留档图片将被删除。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    await widget.store.removeHistory({..._selected});
    if (mounted) {
      setState(() {
        _selected.clear();
        _selecting = false;
      });
    }
  }

  Future<void> _clearAll() async {
    if (_clearArm != 0) return;
    await widget.store.clearHistory();
    if (mounted) {
      setState(() {
        _selected.clear();
        _selecting = false;
        _clearArm = -1;
      });
    }
  }

  void _startArming() {
    if (_clearArm >= 0) return;
    _clearArm = 3;
    setState(() {});
    Future.doWhile(() async {
      await Future<void>.delayed(const Duration(seconds: 1));
      if (!mounted) return false;
      _clearArm--;
      setState(() {});
      return _clearArm > 0;
    });
    Future<void>.delayed(const Duration(seconds: 8)).then((_) {
      if (mounted && _clearArm == 0) setState(() => _clearArm = -1);
    });
  }

  Future<void> _openViewer(Map<String, dynamic> item) async {
    final path = item['imagePath'] as String?;
    if (path == null) return;
    final file = File(path);
    if (!await file.exists()) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('留档图片文件不存在(可能已被清理)')),
        );
      }
      return;
    }
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => Dialog(
        insetPadding: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      item['name'] as String? ?? '',
                      style: const TextStyle(fontSize: 13),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.pop(ctx),
                  ),
                ],
              ),
            ),
            Flexible(child: Image.file(file, fit: BoxFit.contain)),
            Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: () => Navigator.pop(ctx),
                    child: const Text('关闭'),
                  ),
                  FilledButton.icon(
                    icon: const Icon(Icons.save_alt, size: 18),
                    label: const Text('保存到相册'),
                    onPressed: () async {
                      try {
                        await Gal.putImage(path);
                        if (ctx.mounted) {
                          ScaffoldMessenger.of(ctx).showSnackBar(
                            const SnackBar(content: Text('已保存到相册')),
                          );
                        }
                      } catch (e) {
                        debugPrint('gal save failed: $e');
                        if (ctx.mounted) {
                          ScaffoldMessenger.of(ctx).showSnackBar(
                            const SnackBar(content: Text('保存失败,请重试')),
                          );
                        }
                      }
                    },
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ── 工作下载逻辑与 5s 警告 ────────────────────────────────────────────────

  void _startArmingDownloads() {
    if (_clearDownloadsArm >= 0) return;
    _clearDownloadsArm = 5; // 5s 警告
    setState(() {});
    Future.doWhile(() async {
      await Future<void>.delayed(const Duration(seconds: 1));
      if (!mounted) return false;
      _clearDownloadsArm--;
      setState(() {});
      return _clearDownloadsArm > 0;
    });
    Future<void>.delayed(const Duration(seconds: 10)).then((_) {
      if (mounted && _clearDownloadsArm == 0) setState(() => _clearDownloadsArm = -1);
    });
  }

  Future<void> _clearAllDownloads() async {
    if (_clearDownloadsArm != 0) return;
    await widget.store.clearWorkDownloads();
    if (mounted) {
      setState(() {
        _clearDownloadsArm = -1;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已清空全部工作下载文件及历史记录')),
      );
    }
  }

  Future<void> _deleteSingleDownload(WorkDownloadItem item) async {
    await widget.store.removeWorkDownload(item.id);
    if (mounted) {
      setState(() {});
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('已删除 ${item.fileName}')),
      );
    }
  }

  static bool _isImageFile(String name) {
    final ext = name.split('.').last.toLowerCase();
    return {'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'}.contains(ext);
  }

  static bool _isTxtFile(String name) {
    final ext = name.split('.').last.toLowerCase();
    return ext == 'txt';
  }

  Future<void> _openDownloadedFileViewer(WorkDownloadItem item) async {
    final file = File(item.localPath);
    if (!file.existsSync()) {
      await widget.store.removeWorkDownload(item.id);
      if (mounted) {
        setState(() {});
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('文件在本地已不存在(已被清理)')),
        );
      }
      return;
    }

    final isImg = _isImageFile(item.fileName);
    final isTxt = _isTxtFile(item.fileName);

    if (isImg) {
      await showDialog<void>(
        context: context,
        builder: (ctx) => Dialog(
          insetPadding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(item.fileName, style: const TextStyle(fontSize: 13), overflow: TextOverflow.ellipsis),
                    ),
                    IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(ctx)),
                  ],
                ),
              ),
              Flexible(child: InteractiveViewer(child: Image.file(file, fit: BoxFit.contain))),
              Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('关闭')),
                    FilledButton.icon(
                      icon: const Icon(Icons.save_alt, size: 18),
                      label: const Text('保存到相册'),
                      onPressed: () async {
                        try {
                          await Gal.putImage(item.localPath);
                          if (ctx.mounted) {
                            ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('已保存到相册')));
                          }
                        } catch (e) {
                          if (ctx.mounted) {
                            ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('保存失败,请重试')));
                          }
                        }
                      },
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
      return;
    }

    if (isTxt) {
      String content = '';
      try {
        final bytes = await file.readAsBytes();
        try {
          content = utf8.decode(bytes);
        } catch (_) {
          content = String.fromCharCodes(bytes);
        }
      } catch (e) {
        content = '读取失败: $e';
      }
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => Dialog(
          insetPadding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(item.fileName, style: const TextStyle(fontSize: 13, fontFamily: 'monospace'), overflow: TextOverflow.ellipsis),
                    ),
                    IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(ctx)),
                  ],
                ),
              ),
              const Divider(height: 1),
              Flexible(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.all(12),
                  child: SelectableText(content, style: const TextStyle(fontSize: 12, fontFamily: 'monospace', height: 1.4)),
                ),
              ),
            ],
          ),
        ),
      );
      return;
    }

    // 其他格式文件: 弹出包含“以txt打开”和“用其他应用打开”的双按钮弹窗
    bool openAsTxt = false;
    String txtContent = '';

    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) {
          return Dialog(
            insetPadding: const EdgeInsets.all(16),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: openAsTxt
                  ? Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Row(
                          children: [
                            Expanded(child: Text(item.fileName, style: const TextStyle(fontSize: 13, fontFamily: 'monospace'), overflow: TextOverflow.ellipsis)),
                            IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(ctx)),
                          ],
                        ),
                        const Divider(height: 1),
                        Flexible(
                          child: SingleChildScrollView(
                            padding: const EdgeInsets.all(12),
                            child: SelectableText(txtContent, style: const TextStyle(fontSize: 12, fontFamily: 'monospace', height: 1.4)),
                          ),
                        ),
                      ],
                    )
                  : Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(item.fileName, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600), textAlign: TextAlign.center),
                        const SizedBox(height: 8),
                        const Text('该文件非纯文本/图片格式', style: TextStyle(fontSize: 12, color: Colors.white38)),
                        const SizedBox(height: 24),
                        SizedBox(
                          width: 180,
                          child: ElevatedButton.icon(
                            style: ElevatedButton.styleFrom(
                              backgroundColor: const Color(0xFF2C4A66),
                              foregroundColor: Colors.white,
                              padding: const EdgeInsets.symmetric(vertical: 12),
                            ),
                            icon: const Icon(Icons.text_snippet_outlined, size: 18),
                            label: const Text('以txt打开'),
                            onPressed: () async {
                              try {
                                final bytes = await file.readAsBytes();
                                try {
                                  txtContent = utf8.decode(bytes);
                                } catch (_) {
                                  txtContent = String.fromCharCodes(bytes);
                                }
                              } catch (e) {
                                txtContent = '读取失败: $e';
                              }
                              setDialogState(() => openAsTxt = true);
                            },
                          ),
                        ),
                        const SizedBox(height: 12),
                        SizedBox(
                          width: 180,
                          child: ElevatedButton.icon(
                            style: ElevatedButton.styleFrom(
                              backgroundColor: const Color(0xFF3B5E3F),
                              foregroundColor: Colors.white,
                              padding: const EdgeInsets.symmetric(vertical: 12),
                            ),
                            icon: const Icon(Icons.open_in_new, size: 18),
                            label: const Text('用其他应用打开'),
                            onPressed: () async {
                              Navigator.pop(ctx);
                              final err = await openWithChooser(item.localPath);
                              if (err != null && mounted) {
                                ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
                              }
                            },
                          ),
                        ),
                        const SizedBox(height: 8),
                      ],
                    ),
            ),
          );
        },
      ),
    );
  }

  // ── 界面构建 ──────────────────────────────────────────────────────────────

  Widget _buildTitle() {
    if (!widget.store.workBetaEnabled) {
      return const Text('发送历史');
    }
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () => setState(() {
            _currentTab = 0;
            _selected.clear();
            _selecting = false;
          }),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
            child: Text(
              '发送历史',
              style: TextStyle(
                fontSize: 16,
                fontWeight: _currentTab == 0 ? FontWeight.bold : FontWeight.normal,
                color: _currentTab == 0 ? Colors.white : Colors.white38,
              ),
            ),
          ),
        ),
        const SizedBox(width: 4),
        const Text('|', style: TextStyle(color: Colors.white24, fontSize: 13)),
        const SizedBox(width: 4),
        InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () => setState(() {
            _currentTab = 1;
            _selected.clear();
            _selecting = false;
          }),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
            child: Text(
              '工作下载',
              style: TextStyle(
                fontSize: 16,
                fontWeight: _currentTab == 1 ? FontWeight.bold : FontWeight.normal,
                color: _currentTab == 1 ? Colors.white : Colors.white38,
              ),
            ),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    // 若工作(Beta)在设置中关闭,强制回到发送历史
    if (!widget.store.workBetaEnabled && _currentTab != 0) {
      _currentTab = 0;
    }

    if (_currentTab == 1) {
      return _buildWorkDownloadsScaffold();
    }
    return _buildSendHistoryScaffold();
  }

  Widget _buildSendHistoryScaffold() {
    final items = widget.store.history;
    return Scaffold(
      appBar: _selecting
          ? AppBar(
              leading: IconButton(
                icon: const Icon(Icons.close),
                onPressed: () => setState(() {
                  _selected.clear();
                  _selecting = false;
                }),
              ),
              title: Text('已选 ${_selected.length} 项'),
              actions: [
                TextButton(
                  onPressed: _selected.isEmpty ? null : () => _deleteSelected(),
                  child: const Text('删除所选'),
                ),
              ],
            )
          : AppBar(
              title: _buildTitle(),
              actions: [
                if (items.isNotEmpty)
                  TextButton.icon(
                    onPressed: _clearArm == 0 ? _clearAll : _startArming,
                    icon: Icon(
                      Icons.delete_forever,
                      color: _clearArm == 0 ? Theme.of(context).colorScheme.error : null,
                    ),
                    label: Text(
                      _clearArm > 0 ? '清空($_clearArm)' : _clearArm == 0 ? '确认清空' : '清空全部',
                      style: TextStyle(
                        color: _clearArm == 0 ? Theme.of(context).colorScheme.error : null,
                      ),
                    ),
                  ),
              ],
            ),
      body: items.isEmpty
          ? Center(
              child: Text(
                widget.store.historyMode == LensStore.historyNoTrace
                    ? '已开启「不留任何痕迹」,发送不会留记录\n(可在 设置 → 发送历史 中更改)'
                    : '还没有发送记录',
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white54),
              ),
            )
          : ListView.builder(
              itemCount: items.length,
              itemBuilder: (context, i) {
                final it = items[i];
                final ok = it['ok'] == true;
                // receiver v0.3.7 reports WHERE the photo went; the legacy
                // injected/已注入 branch (delivered.sessionId) is dead because
                // delivery is staged pre-send and never reported per session
                final savedToFolder = it['reason'] == 'saved-to-folder';
                final stagedAndSaved = it['reason'] == 'saved-and-staged';
                final hasImage = (it['imagePath'] as String?) != null;
                final key = LensStore.historyKey(it);
                // 注意: at 字段是 ISO 8601 字符串(历史遗留格式), 必须用 tryParse;
                // 用毫秒戳强转 int 会在 build 时抛 TypeError 导致整页灰屏
                final at = DateTime.tryParse(it['at'] as String? ?? '');
                final kb = ((it['bytes'] as num?) ?? 0) / 1024;
                return ListTile(
                  onLongPress: () => setState(() {
                    _selecting = true;
                    _selected.add(key);
                  }),
                  leading: _selecting
                      ? Checkbox(
                          value: _selected.contains(key),
                          onChanged: (v) => setState(() {
                            if (v == true) {
                              _selected.add(key);
                            } else {
                              _selected.remove(key);
                            }
                          }),
                        )
                      : Icon(
                          hasImage ? Icons.image_outlined : (ok ? Icons.check_circle : Icons.error_outline),
                          color: hasImage ? Colors.lightBlueAccent : (ok ? Colors.green : Colors.red),
                        ),
                  title: Text(it['name'] as String? ?? '(未命名)'),
                  subtitle: Text(
                    [
                      at != null
                          ? '${at.month}/${at.day} ${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}'
                          : '',
                      '${kb.toStringAsFixed(0)} KB',
                      it['server'] as String? ?? '',
                      if (it['captureId'] != null) '远程快门',
                      if (!ok) it['reason'] as String? ?? '发送失败',
                    ].where((s) => s.toString().isNotEmpty).join(' · '),
                  ),
                  trailing: _selecting
                      ? null
                      : Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              !ok
                                  ? '失败'
                                  : savedToFolder
                                      ? '已存文件夹'
                                      : stagedAndSaved
                                          ? '已发送+存档'
                                          : '已发送',
                              style: TextStyle(
                                color: !ok ? Colors.red : (savedToFolder ? Colors.lightBlueAccent : Colors.green),
                                fontSize: 12,
                              ),
                            ),
                            IconButton(
                              icon: const Icon(Icons.delete_outline, size: 20),
                              tooltip: '删除此条',
                              onPressed: () => widget.store.removeHistory({key}).then((_) {
                                if (mounted) setState(() {});
                              }),
                            ),
                          ],
                        ),
                  onTap: hasImage && !_selecting ? () => _openViewer(it) : null,
                );
              },
            ),
    );
  }

  Widget _buildWorkDownloadsScaffold() {
    final downloads = widget.store.workDownloads();

    // 按工作区分类
    final groups = <String, List<WorkDownloadItem>>{};
    for (final it in downloads) {
      final key = it.workspace.isNotEmpty ? it.workspace : '默认工作区';
      groups.putIfAbsent(key, () => []).add(it);
    }

    return Scaffold(
      appBar: AppBar(
        title: _buildTitle(),
        actions: [
          if (downloads.isNotEmpty)
            TextButton.icon(
              onPressed: _clearDownloadsArm == 0 ? _clearAllDownloads : _startArmingDownloads,
              icon: Icon(
                Icons.delete_forever,
                color: _clearDownloadsArm == 0 ? Theme.of(context).colorScheme.error : null,
              ),
              label: Text(
                _clearDownloadsArm > 0
                    ? '清空($_clearDownloadsArm)'
                    : _clearDownloadsArm == 0
                        ? '确认清空'
                        : '清空全部',
                style: TextStyle(
                  color: _clearDownloadsArm >= 0 ? Theme.of(context).colorScheme.error : null,
                  fontWeight: _clearDownloadsArm == 0 ? FontWeight.bold : FontWeight.normal,
                ),
              ),
            ),
        ],
      ),
      body: downloads.isEmpty
          ? const Center(
              child: Text(
                '暂无工作下载文件\n(在工作会话中点击文件下载后将在此留存)',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white38, height: 1.5),
              ),
            )
          : ListView(
              padding: const EdgeInsets.only(bottom: 24),
              children: [
                for (final entry in groups.entries) ...[
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
                    child: Row(
                      children: [
                        const Icon(Icons.folder_outlined, size: 14, color: Colors.white38),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            entry.key,
                            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Colors.white54),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        Text('${entry.value.length}', style: const TextStyle(fontSize: 11, color: Colors.white24)),
                      ],
                    ),
                  ),
                  for (final item in entry.value)
                    ListTile(
                      dense: true,
                      leading: Icon(
                        _isImageFile(item.fileName)
                            ? Icons.image_outlined
                            : Icons.insert_drive_file_outlined,
                        size: 20,
                        color: _isImageFile(item.fileName) ? const Color(0xFF81D4FA) : Colors.white38,
                      ),
                      title: Text(item.fileName, style: const TextStyle(fontSize: 13, fontFamily: 'monospace')),
                      subtitle: Text(
                        '${_fmtSize(item.size)} · ${_fmtTime(item.downloadedAt)}',
                        style: const TextStyle(fontSize: 11, color: Colors.white24),
                      ),
                      trailing: IconButton(
                        icon: const Icon(Icons.delete_outline, size: 18),
                        color: Colors.white38,
                        onPressed: () => _deleteSingleDownload(item),
                      ),
                      onTap: () => _openDownloadedFileViewer(item),
                    ),
                ],
              ],
            ),
    );
  }

  String _fmtSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
  }

  String _fmtTime(int millis) {
    final when = DateTime.fromMillisecondsSinceEpoch(millis);
    return '${when.month}/${when.day} ${when.hour.toString().padLeft(2, '0')}:${when.minute.toString().padLeft(2, '0')}';
  }
}
