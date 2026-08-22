import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

enum LensLinkState { disconnected, connecting, connected }

/// Remote shutter command arriving from the PC side.
class CaptureCommand {
  final String captureId;
  final String? note;
  CaptureCommand(this.captureId, this.note);
}

/// The camera uplink websocket: pushes JPEG preview frames, receives
/// shutter commands. Auto-reconnects with capped backoff; one in-flight
/// encode at a time (slow encode drops frames rather than queueing).
class CameraSocket {
  final String url;
  final _frames = StreamController<Uint8List>.broadcast();
  final _commands = StreamController<CaptureCommand>.broadcast();
  final _states = StreamController<LensLinkState>.broadcast();

  WebSocketChannel? _ws;
  Timer? _reconnect;
  int _attempt = 0;
  bool _closedByUser = false;
  LensLinkState _state = LensLinkState.disconnected;

  CameraSocket(this.url) {
    _connect();
  }

  Stream<CaptureCommand> get commands => _commands.stream;
  Stream<LensLinkState> get states => _states.stream;
  LensLinkState get state => _state;

  /// Called when the host asks this phone to stop/start preview streaming
  /// (another device owns the PC preview, or control switched back to us).
  void Function(bool active)? onPreviewState;

  void _setState(LensLinkState s) {
    _state = s;
    _states.add(s);
  }

  Future<void> _connect() async {
    if (_closedByUser) return;
    _setState(LensLinkState.connecting);
    try {
      final ws = WebSocketChannel.connect(Uri.parse(url));
      await ws.ready.timeout(const Duration(seconds: 6));
      _ws = ws;
      _attempt = 0;
      _setState(LensLinkState.connected);
      ws.stream.listen(
        (data) {
          if (data is! String) return;
          final msg = jsonDecode(data) as Map<String, dynamic>;
          if (msg['type'] == 'capture') {
            _commands.add(CaptureCommand(msg['captureId'] as String, msg['note'] as String?));
          } else if (msg['type'] == 'pause_preview') {
            onPreviewState?.call(false);
          } else if (msg['type'] == 'resume_preview') {
            onPreviewState?.call(true);
          }
        },
        onDone: () {
          debugPrint('[lens-mate] camera ws closed (code=${ws.closeCode} reason=${ws.closeReason}) attempt=$_attempt');
          _scheduleReconnect();
        },
        onError: (Object e) {
          debugPrint('[lens-mate] camera ws error: $e attempt=$_attempt');
          _scheduleReconnect();
        },
        cancelOnError: true,
      );
    } catch (_) {
      _scheduleReconnect();
    }
  }

  void _scheduleReconnect() {
    if (_closedByUser) return;
    _setState(LensLinkState.disconnected);
    _reconnect?.cancel();
    final delay = Duration(milliseconds: (500 * (_attempt + 1)).clamp(500, 5000));
    _attempt++;
    _reconnect = Timer(delay, _connect);
  }

  /// Send hello and one frame (frames dropped while an encode is pending).
  /// [rotation] = clockwise degrees to display the sensor-oriented frames.
  void sendHello(int width, int height, int fps, int rotation) {
    _send(jsonEncode({
      'type': 'hello',
      'width': width,
      'height': height,
      'fps': fps,
      'rotation': rotation,
    }));
  }

  void pushFrame(Uint8List jpeg) {
    if (_state != LensLinkState.connected) {
      _drops++;
      return;
    }
    if (jpeg.length > 450 * 1024 && _lastBigFrameLog + 5000 < DateTime.now().millisecondsSinceEpoch) {
      _lastBigFrameLog = DateTime.now().millisecondsSinceEpoch;
      debugPrint('[lens-mate] big frame ${jpeg.length}B (dropped-ws=$_drops)');
    }
    _ws?.sink.add(jpeg);
  }

  int _drops = 0;
  int _lastBigFrameLog = 0;

  void reportCapture(String captureId, String status, [String? detail]) {
    _send(jsonEncode({
      'type': 'capture_result',
      'captureId': captureId,
      'status': status,
      if (detail != null) 'detail': detail,
    }));
  }

  /// Ask the host to make THIS phone the active preview/shutter device. The
  /// host then pauses every other phone and resumes us.
  void makeMain() {
    _send(jsonEncode({'type': 'claim_active'}));
  }

  void _send(String text) {
    if (_state == LensLinkState.connected) _ws?.sink.add(text);
  }

  Future<void> close() async {
    _closedByUser = true;
    _reconnect?.cancel();
    await _ws?.sink.close();
    _setState(LensLinkState.disconnected);
    await _frames.close();
    await _commands.close();
    await _states.close();
  }
}
