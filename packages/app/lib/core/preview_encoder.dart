import 'dart:async';
import 'dart:isolate';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'jpeg.dart';

/// Preview JPEG encoder.
///
/// Primary path: the native Android channel (`lensmate/jpeg`), which uses the
/// system libjpeg. Fallback: one resident Dart isolate. Defensive by design:
/// a stuck or failed native call degrades to the isolate instead of silently
/// dropping every frame (the "connected but 0 fps" failure we shipped once).
class PreviewEncoder {
  static const _channel = MethodChannel('lensmate/jpeg');
  static bool? _nativeOk;

  SendPort? _cmd;
  final _port = ReceivePort();
  Isolate? _iso;
  final _ready = Completer<void>();
  void Function(Uint8List jpeg)? onFrame;
  bool _busy = false;
  bool _closed = false;
  String _lastError = "";
  int _timeouts = 0;
  int _failures = 0;

  Future<void> get ready => _ready.future;
  bool get busy => _busy;
  String get engineLabel => _nativeOk == true ? "native" : (_nativeOk == false ? "dart" : "init");
  String get lastError => _lastError;

  static Future<bool> _probeNative() async {
    if (_nativeOk != null) return _nativeOk!;
    try {
      final ok = await _channel.invokeMethod<bool>('ping').timeout(const Duration(seconds: 3)) ?? false;
      _nativeOk = ok;
    } catch (_) {
      _nativeOk = false;
    }
    return _nativeOk!;
  }

  Future<void> start() async {
    if (_closed) return;
    try {
      if (_iso == null) {
        final boot = ReceivePort();
        _iso = await Isolate.spawn(_encoderMain, boot.sendPort, debugName: 'lens-preview-encoder');
        _cmd = await boot.first.timeout(const Duration(seconds: 5)) as SendPort;
        boot.close();
        _cmd!.send(_port.sendPort);
        _port.listen((msg) {
          final m = msg as List;
          _busy = false;
          if (!_closed && m[0] == 'ok') onFrame?.call(m[1] as Uint8List);
        });
      }
      await _probeNative();
    } catch (e) {
      _lastError = "start: $e";
      debugPrint('[lens-mate] encoder start failed: $e');
    } finally {
      if (!_ready.isCompleted) _ready.complete();
    }
  }

  /// Encode one snapshot; dropped while busy, but NEVER stuck: a native call
  /// that times out flips the permanent fallback flag and releases the slot.
  void encode(YuvSnapshot snap, int maxShort, int maxLong, int quality) {
    if (_closed || _busy) return;
    _busy = true;
    if (_nativeOk == true) {
      _channel
          .invokeMethod<Uint8List>('encode', {
            'w': snap.width,
            'h': snap.height,
            'quality': quality,
            // bound the long edge — full-res sensor JPEGs drown the stream
            'target': maxLong,
            'y': snap.y,
            'u': snap.u,
            'v': snap.v,
          })
          .timeout(const Duration(milliseconds: 800), onTimeout: () {
            _timeouts++;
            _lastError = "native timeout #$_timeouts";
            if (_timeouts >= 3) {
              _nativeOk = false; // degrade permanently after repeated stalls
              debugPrint('[lens-mate] native encode timed out 3x, falling back to dart');
            }
            return null;
          })
          .then((data) {
            _busy = false;
            if (!_closed && data != null) {
              _timeouts = 0;
              onFrame?.call(data);
            }
          })
          .catchError((Object e) {
            _busy = false;
            _failures++;
            _lastError = "native error: $e";
            debugPrint('[lens-mate] native encode failed ($_failures): $e');
            if (_failures >= 3) {
              _nativeOk = false;
              debugPrint('[lens-mate] native failed 3x, falling back to dart');
            }
          });
      return;
    }
    if (_cmd == null) {
      _busy = false; // isolate still booting; drop this frame
      return;
    }
    _cmd!.send(['encode', snap, maxShort, maxLong, quality]);
  }

  void stop() {
    _closed = true;
    try {
      _cmd?.send(['stop']);
    } catch (_) {/* isolate already gone */}
    _port.close();
    _iso?.kill(priority: Isolate.immediate);
    _iso = null;
  }
}

void _encoderMain(SendPort boot) {
  final port = ReceivePort();
  boot.send(port.sendPort);
  SendPort? reply;
  port.listen((msg) {
    // handshake: first message is the main isolate's reply port
    if (msg is SendPort) {
      reply = msg;
      return;
    }
    final m = msg as List;
    if (m[0] == 'stop') {
      port.close();
      Isolate.current.kill(priority: Isolate.immediate);
    }
    if (m[0] != 'encode') return;
    try {
      final bytes = encodeSnapshotJpeg(
        m[1] as YuvSnapshot,
        m[2] as int,
        m[3] as int,
        m[4] as int,
      );
      reply?.send(['ok', bytes]);
    } catch (_) {
      reply?.send(['err']);
    }
  });
}
