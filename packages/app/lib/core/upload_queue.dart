import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:uuid/uuid.dart';

import 'api.dart';

enum UploadStatus { queued, uploading, failed }

/// One photo waiting in the on-device upload queue. The file on disk holds
/// the FINAL upload bytes (orientation baked, quality preset applied).
class UploadItem {
  final String id;
  /// Idempotency key for POST /upload — a retry after a lost response must
  /// never store or composer-stage the same photo twice.
  final String uploadId;
  final String filePath;
  final String name;
  final String? note;
  final String? captureId;
  final int capturedAt;
  final int bytes;
  UploadStatus status;
  int attempts;
  String errorCode;
  /// Epoch ms when the worker may pick this up again (0 = immediately).
  int nextAttemptAt;

  UploadItem({
    required this.id,
    required this.uploadId,
    required this.filePath,
    required this.name,
    required this.bytes,
    required this.capturedAt,
    this.note,
    this.captureId,
    this.status = UploadStatus.queued,
    this.attempts = 0,
    this.errorCode = '',
    this.nextAttemptAt = 0,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'uploadId': uploadId,
        'filePath': filePath,
        'name': name,
        'note': note,
        'captureId': captureId,
        'capturedAt': capturedAt,
        'bytes': bytes,
        'status': status.name,
        'attempts': attempts,
        'errorCode': errorCode,
        'nextAttemptAt': nextAttemptAt,
      };

  static UploadItem fromJson(Map<String, dynamic> j) => UploadItem(
        id: j['id'] as String,
        uploadId: j['uploadId'] as String? ?? const Uuid().v4(),
        filePath: j['filePath'] as String,
        name: j['name'] as String? ?? 'photo.jpg',
        note: j['note'] as String?,
        captureId: j['captureId'] as String?,
        capturedAt: (j['capturedAt'] as num?)?.toInt() ?? 0,
        bytes: (j['bytes'] as num?)?.toInt() ?? 0,
        status: UploadStatus.values.firstWhere(
          (s) => s.name == j['status'],
          orElse: () => UploadStatus.queued,
        ),
        attempts: (j['attempts'] as num?)?.toInt() ?? 0,
        errorCode: j['errorCode'] as String? ?? '',
        nextAttemptAt: (j['nextAttemptAt'] as num?)?.toInt() ?? 0,
      );
}

/// Declare the format from magic bytes, not the file extension — the receiver
/// validates the declared content-type against the actual byte header.
String sniffMediaType(Uint8List bytes) {
  if (bytes.length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47) {
    return 'image/png';
  }
  return 'image/jpeg'; // unknown formats: let the receiver's check reject them
}

/// Human text for a receipt error code (shared by the queue screen).
String uploadErrorText(String code) {
  switch (code) {
    case 'RATE_LIMITED':
      return '发送过于频繁';
    case 'TOO_LARGE':
      return '图片过大';
    case 'BAD_MAGIC':
    case 'TYPE_NOT_ALLOWED':
      return '图片格式不支持';
    case 'AUTH_REQUIRED':
      return '配对已失效,请重新扫码';
    case 'NETWORK_ERROR':
      return '网络异常';
    default:
      return code.isEmpty ? '未知错误' : code;
  }
}

/// Receiver-side codes where a retry can NEVER succeed (the bytes, format or
/// token are the problem — not the network). Everything else backs off.
const _hardErrors = {'TOO_LARGE', 'TYPE_NOT_ALLOWED', 'BAD_MAGIC', 'AUTH_REQUIRED'};

/// Serial FIFO background uploader.
///
/// Photos land here as final bytes and are written to
/// `documents/upload_queue/` BEFORE the shutter unlocks, so a flaky network
/// never blocks or loses a shot. One upload in flight at a time keeps the
/// receiver's folder naming and composer staging in capture order; failures
/// back off (capped) and retry automatically until the network returns.
class UploadQueue {
  UploadQueue._();
  static final UploadQueue instance = UploadQueue._();

  /// Progressively quieter retries; the last interval repeats forever, so a
  /// queued photo eventually uploads whenever the network recovers.
  static const _backoffMs = [5000, 15000, 30000, 60000];

  final ValueNotifier<List<UploadItem>> items = ValueNotifier(const []);

  LensStore? _store;
  final LensApi _api = LensApi();
  String? _dirPath;
  bool _pumping = false;
  Timer? _timer;

  /// Unfinished entries (queued + uploading + failed) — the badge count.
  int get pendingCount => items.value.length;

  /// Wire the store and restore any queue persisted by a previous session.
  /// Crash-survivors stuck in `uploading` go back to `queued` (the HTTP
  /// request died with the process; the idempotency key makes a redelivery
  /// safe even if the receiver did store it).
  Future<void> init(LensStore store) async {
    _store = store;
    try {
      final dir = await getApplicationDocumentsDirectory();
      _dirPath = '${dir.path}/upload_queue';
      final meta = File('$_dirPath/queue.json');
      if (await meta.exists()) {
        final raw = jsonDecode(await meta.readAsString()) as List;
        final restored = raw
            .map((e) => UploadItem.fromJson(Map<String, dynamic>.from(e as Map)))
            .toList();
        for (final it in restored) {
          if (it.status != UploadStatus.failed) {
            it
              ..status = UploadStatus.queued
              ..nextAttemptAt = 0;
          }
        }
        items.value = restored;
      }
    } catch (e) {
      debugPrint('[lens-mate] upload queue restore failed: $e');
    }
    kick();
  }

  /// Enqueue final upload bytes; the file is on disk before this returns so
  /// the shutter can unlock immediately afterwards.
  Future<void> enqueue({
    required Uint8List bytes,
    required String name,
    String? note,
    String? captureId,
  }) async {
    final id = const Uuid().v4();
    final dir = _dirPath;
    if (dir == null) {
      debugPrint('[lens-mate] upload queue not ready — photo dropped');
      return;
    }
    // id prefix keeps names unique even when two shots share a second
    final filePath = '$dir/${id.substring(0, 8)}__$name';
    try {
      await Directory(dir).create(recursive: true);
      await File(filePath).writeAsBytes(bytes, flush: true);
    } catch (e) {
      debugPrint('[lens-mate] queue write failed: $e');
      rethrow;
    }
    final item = UploadItem(
      id: id,
      uploadId: id,
      filePath: filePath,
      name: name,
      bytes: bytes.length,
      capturedAt: DateTime.now().millisecondsSinceEpoch,
      note: note,
      captureId: captureId,
    );
    items.value = [...items.value, item];
    await _persist();
    kick();
  }

  /// Drop one entry and its file (user cancel; safe even mid-upload — the
  /// worker discards the result of an entry that left the queue).
  Future<void> cancel(String id) async {
    final item = _byId(id);
    if (item == null) return;
    items.value = items.value.where((i) => i.id != id).toList();
    await _persist();
    _deleteFileQuietly(item.filePath);
  }

  /// Manual retry of a hard-failed entry (resets the backoff).
  Future<void> retry(String id) async {
    final item = _byId(id);
    if (item == null || item.status == UploadStatus.uploading) return;
    item
      ..status = UploadStatus.queued
      ..attempts = 0
      ..errorCode = ''
      ..nextAttemptAt = 0;
    _notify();
    await _persist();
    kick();
  }

  Future<void> retryAllFailed() async {
    var changed = false;
    for (final it in items.value) {
      if (it.status == UploadStatus.failed) {
        it
          ..status = UploadStatus.queued
          ..attempts = 0
          ..errorCode = ''
          ..nextAttemptAt = 0;
        changed = true;
      }
    }
    if (!changed) return;
    _notify();
    await _persist();
    kick();
  }

  /// Clear every entry and file (explicit user action).
  Future<void> clear() async {
    final old = items.value;
    items.value = const [];
    await _persist();
    for (final it in old) {
      _deleteFileQuietly(it.filePath);
    }
  }

  /// Nudge the worker (enqueue, retry, network back, app start). Cheap and
  /// idempotent: while a pump is running this does nothing.
  void kick() {
    _timer?.cancel();
    _timer = null;
    scheduleMicrotask(_pump);
  }

  UploadItem? _byId(String id) {
    for (final it in items.value) {
      if (it.id == id) return it;
    }
    return null;
  }

  /// CRITICAL: every worker exit with a waiting head must come through here.
  /// A kick() arriving during a back-off cancels the pending timer; without
  /// re-arming, the queue would sleep FOREVER (seen live: burst shots kept
  /// kicking while the head was rate-limit waiting → stuck on "限流等待").
  void _armHeadTimer() {
    final now = DateTime.now().millisecondsSinceEpoch;
    int? soonest;
    for (final it in items.value) {
      if (it.status != UploadStatus.queued || it.nextAttemptAt <= now) continue;
      if (soonest == null || it.nextAttemptAt < soonest) soonest = it.nextAttemptAt;
    }
    if (soonest == null) return; // queue idle (empty / all failed) — nothing to wake up for
    _timer?.cancel();
    _timer = Timer(Duration(milliseconds: soonest - now), kick);
  }

  /// First entry the worker may send NOW: FIFO order, skipping hard-failed
  /// ones so a single bad photo can't stall the whole queue.
  UploadItem? _nextReady() {
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final it in items.value) {
      if (it.status == UploadStatus.failed || it.status == UploadStatus.uploading) continue;
      if (it.nextAttemptAt > now) return null; // head-of-line is waiting → stop
      return it;
    }
    return null;
  }

  Future<void> _pump() async {
    if (_pumping) return;
    _pumping = true;
    try {
      while (true) {
        final item = _nextReady();
        if (item == null) {
          _armHeadTimer(); // never exit without a wake-up scheduled
          return;
        }
        final server = _store?.server;
        if (server == null) return; // nothing paired; retry on the next kick
        item
          ..status = UploadStatus.uploading
          ..errorCode = '';
        _notify();

        final Uint8List bytes;
        try {
          bytes = await File(item.filePath).readAsBytes();
        } catch (_) {
          // queued file vanished (storage cleanup) — nothing left to send
          items.value = items.value.where((i) => i.id != item.id).toList();
          await _persist();
          continue;
        }

        UploadReceipt receipt;
        try {
          receipt = await _api.upload(
            server,
            bytes: bytes,
            mediaType: sniffMediaType(bytes),
            name: item.name,
            note: item.note,
            captureId: item.captureId,
            uploadId: item.uploadId,
          );
        } catch (e) {
          debugPrint('[lens-mate] queued upload error: $e');
          receipt = UploadReceipt(ok: false, errorCode: 'NETWORK_ERROR');
        }

        // cancelled while in flight → the entry is gone; discard the result
        if (_byId(item.id) == null) {
          _deleteFileQuietly(item.filePath);
          continue;
        }

        if (receipt.ok) {
          await _finish(item, receipt, server.name);
          continue;
        }

        if (_hardErrors.contains(receipt.errorCode)) {
          item
            ..status = UploadStatus.failed
            ..errorCode = receipt.errorCode
            ..nextAttemptAt = 0;
          _notify();
          await _persist();
          await _recordFailure(item, receipt, server.name);
          continue; // move on to the rest of the queue
        }

        // Soft failure: back off and loop on — the head is now waiting, so
        // the exit path re-arms the wake-up timer. (The receiver no longer
        // rate-limits uploads; any 429 from a legacy/override host simply
        // rides the normal backoff ladder.)
        item.attempts++;
        item
          ..status = UploadStatus.queued
          ..errorCode = receipt.errorCode
          ..nextAttemptAt = DateTime.now().millisecondsSinceEpoch +
              _backoffMs[(item.attempts - 1).clamp(0, _backoffMs.length - 1)];
        _notify();
        await _persist();
      }
    } finally {
      _pumping = false;
    }
  }

  /// Success: archive per the user's history mode, then leave the queue.
  Future<void> _finish(UploadItem item, UploadReceipt receipt, String serverName) async {
    final store = _store;
    if (store == null) return;
    String? imagePath;
    final mode = store.historyMode;
    if (mode != LensStore.historyNoTrace) {
      try {
        if (mode == LensStore.historyKeepImage) {
          final dir = await getApplicationDocumentsDirectory();
          final dest = File('${dir.path}/history/${DateTime.now().millisecondsSinceEpoch}_${item.name}');
          await dest.parent.create(recursive: true);
          // the queued copy IS the archive copy — move it, don't duplicate
          // (rename throws on failure, which lands in the catch below)
          await File(item.filePath).rename(dest.path);
          imagePath = dest.path;
        }
      } catch (_) {
        imagePath = null; // archive failure must not lose the history row
      }
      await store.addHistory({
        'at': DateTime.fromMillisecondsSinceEpoch(item.capturedAt).toIso8601String(),
        'name': item.name,
        'bytes': item.bytes,
        'ok': true,
        'attachmentId': receipt.attachmentId,
        'reason': receipt.reason,
        'errorCode': '',
        'captureId': item.captureId,
        'server': serverName,
        'imagePath': imagePath,
      });
    }
    items.value = items.value.where((i) => i.id != item.id).toList();
    await _persist();
    if (imagePath == null) _deleteFileQuietly(item.filePath);
  }

  /// Hard failure lands in history too, so it stays visible after the user
  /// dismisses the queue screen.
  Future<void> _recordFailure(UploadItem item, UploadReceipt receipt, String serverName) async {
    final store = _store;
    if (store == null || store.historyMode == LensStore.historyNoTrace) return;
    await store.addHistory({
      'at': DateTime.fromMillisecondsSinceEpoch(item.capturedAt).toIso8601String(),
      'name': item.name,
      'bytes': item.bytes,
      'ok': false,
      'attachmentId': null,
      'reason': null,
      'errorCode': receipt.errorCode,
      'captureId': item.captureId,
      'server': serverName,
      'imagePath': null,
    });
  }

  void _deleteFileQuietly(String path) {
    // .ignore() marks both result and error as handled — a missing file is
    // not an event worth surfacing
    File(path).delete().ignore();
  }

  void _notify() {
    items.value = List<UploadItem>.unmodifiable(items.value);
  }

  Future<void> _persist() async {
    final dir = _dirPath;
    if (dir == null) return;
    try {
      final meta = File('$dir/queue.json');
      await meta.parent.create(recursive: true);
      await meta.writeAsString(jsonEncode(items.value.map((e) => e.toJson()).toList()), flush: true);
    } catch (e) {
      debugPrint('[lens-mate] queue persist failed: $e');
    }
  }
}
