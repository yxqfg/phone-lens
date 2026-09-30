import 'dart:io';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/upload_queue.dart';

/// Queue management: every photo waiting to reach the receiver, with its live
/// status (waiting / uploading / hard-failed), per-item cancel + retry, and a
/// retry-all / clear-all escape hatch. Backed by the global UploadQueue
/// ValueNotifier, so it updates live while the worker runs behind it.
class UploadQueueScreen extends StatefulWidget {
  final LensStore store;
  const UploadQueueScreen({super.key, required this.store});

  @override
  State<UploadQueueScreen> createState() => _UploadQueueScreenState();
}

class _UploadQueueScreenState extends State<UploadQueueScreen> {
  Future<void> _cancel(UploadItem item) async {
    await UploadQueue.instance.cancel(item.id);
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('已取消上传「${item.name}」,本地文件已删除')),
      );
    }
  }

  Future<void> _clearAll() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('清空上传队列?'),
        content: const Text('队列中的全部照片及其本地文件将被删除,不会再上传。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('清空')),
        ],
      ),
    );
    if (ok == true) await UploadQueue.instance.clear();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('上传队列'),
        actions: [
          ValueListenableBuilder<List<UploadItem>>(
            valueListenable: UploadQueue.instance.items,
            builder: (_, items, __) {
              final failedCount = items.where((i) => i.status == UploadStatus.failed).length;
              return Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (failedCount > 0)
                    TextButton.icon(
                      onPressed: () => UploadQueue.instance.retryAllFailed(),
                      icon: const Icon(Icons.refresh, size: 18),
                      label: Text('重试失败($failedCount)'),
                    ),
                  if (items.isNotEmpty)
                    IconButton(
                      tooltip: '清空队列',
                      icon: const Icon(Icons.delete_sweep_outlined),
                      onPressed: _clearAll,
                    ),
                ],
              );
            },
          ),
        ],
      ),
      body: ValueListenableBuilder<List<UploadItem>>(
        valueListenable: UploadQueue.instance.items,
        builder: (_, items, __) {
          if (items.isEmpty) {
            return const Center(
              child: Text(
                '队列为空\n\n拍好的照片会先临时存放在这里,\n由后台自动依次上传;网络不稳时\n拍照不受影响,恢复后自动续传。',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white54, height: 1.7),
              ),
            );
          }
          return ListView.builder(
            itemCount: items.length,
            itemBuilder: (context, i) => _row(items[i]),
          );
        },
      ),
    );
  }

  Widget _row(UploadItem item) {
    final file = File(item.filePath);
    final (statusText, statusColor, statusIcon) = _status(item);
    return ListTile(
      leading: ClipRRect(
        borderRadius: BorderRadius.circular(6),
        child: SizedBox(
          width: 56,
          height: 56,
          // a vanished file renders as a broken-image box, not a crash
          child: file.existsSync()
              ? Image.file(
                  file,
                  fit: BoxFit.cover,
                  cacheWidth: 112,
                  errorBuilder: (_, __, ___) => const ColoredBox(
                    color: Colors.white12,
                    child: Icon(Icons.broken_image_outlined, color: Colors.white38),
                  ),
                )
              : const ColoredBox(
                  color: Colors.white12,
                  child: Icon(Icons.broken_image_outlined, color: Colors.white38),
                ),
        ),
      ),
      title: Text(
        item.name,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 14),
      ),
      subtitle: Text(
        [
          statusText,
          '${(item.bytes / 1024).toStringAsFixed(0)} KB',
          if (item.captureId != null) '远程快门',
          if (item.status == UploadStatus.queued && item.attempts > 0) '第 ${item.attempts + 1} 次等待',
        ].where((s) => s.isNotEmpty).join(' · '),
        style: TextStyle(fontSize: 12, color: statusColor),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (item.status == UploadStatus.failed)
            IconButton(
              tooltip: '重新上传',
              icon: const Icon(Icons.refresh, size: 22),
              onPressed: () => UploadQueue.instance.retry(item.id),
            ),
          IconButton(
            tooltip: '取消并删除',
            icon: Icon(Icons.close, size: 20, color: statusIcon == UploadStatus.uploading ? Colors.white38 : Colors.white54),
            onPressed: () => _cancel(item),
          ),
        ],
      ),
    );
  }

  (String, Color, UploadStatus) _status(UploadItem item) {
    switch (item.status) {
      case UploadStatus.uploading:
        return ('上传中…', Colors.lightBlueAccent, UploadStatus.uploading);
      case UploadStatus.failed:
        return ('失败:${uploadErrorText(item.errorCode)},可重试', Colors.red, UploadStatus.failed);
      case UploadStatus.queued:
        if (item.errorCode == 'NETWORK_ERROR') {
          return ('网络异常,将自动重试', Colors.orange, UploadStatus.queued);
        }
        if (item.attempts > 0) {
          return ('上次失败(${uploadErrorText(item.errorCode)}),将自动重试', Colors.orange, UploadStatus.queued);
        }
        return ('等待上传', Colors.white54, UploadStatus.queued);
    }
  }
}
