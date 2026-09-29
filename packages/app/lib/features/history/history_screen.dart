import 'dart:io';

import 'package:flutter/material.dart';
import 'package:gal/gal.dart';

import '../../core/api.dart';

/// Send history with per-entry image archive:
/// - entries carrying an archived image are badged and tappable (viewer +
///   save-to-gallery)
/// - swipe-free single delete (trailing icon, no confirmation)
/// - long-press enters multi-select for batch delete
/// - "clear all" arms after a 3-second countdown
class HistoryScreen extends StatefulWidget {
  final LensStore store;
  const HistoryScreen({super.key, required this.store});

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  // entry KEYS (LensStore.historyKey), never indices — remote captures can
  // insert rows while the user has a selection, which would silently shift
  // indices and delete the wrong entries
  final Set<String> _selected = {};
  bool _selecting = false;
  int _clearArm = -1; // countdown seconds; -1 = disarmed

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
      return _clearArm > 0; // stop at 0 (armed) — auto-reset after idle
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

  @override
  Widget build(BuildContext context) {
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
              title: const Text('发送历史'),
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
              // "no records" vs "recording disabled" are different truths
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
}
