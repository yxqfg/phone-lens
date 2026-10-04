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
  final _commands = StreamController<CaptureCommand>.broadcast();
  final _states = StreamController<LensLinkState>.broadcast();

  WebSocketChannel? _ws;
  Timer? _reconnect;
  int _attempt = 0;
  bool _closedByUser = false;
  LensLinkState _state = LensLinkState.disconnected;

  // ── keepalive ────────────────────────────────────────────────────────────
  // A wifi switch (or laptop sleep) kills the TCP path without a FIN: the OS
  // keeps the dead socket "open" for minutes and the UI keeps claiming
  // "已连接" while nothing flows. The ws protocol layer auto-answers host
  // pings, so transport-level keepalive can't expose this — we need an
  // APPLICATION-level echo: ping every 10s, and if no server message arrived
  // for 30s, declare the link half-open and rebuild it.
  //
  // OLD-HOST COMPATIBILITY: hosts before v1.0.3 silently ignore "ping"
  // (never answer pong) and send no other downstream traffic while the
  // preview is idle — the silence-based eviction would murder those links
  // every 30s in a reconnect loop. So eviction is only ARMED once a pong has
  // actually been seen on THIS connection; against an old host it stays
  // disarmed forever and we degrade to OS-level detection (the pre-1.0.3
  // behaviour).
  Timer? _heartbeat;
  DateTime _lastServerMsgAt = DateTime.now();
  bool _pongSeen = false;

  static const _heartbeatInterval = Duration(seconds: 10);
  static const _serverSilenceLimit = Duration(seconds: 30);

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
    WebSocketChannel? ws;
    try {
      ws = WebSocketChannel.connect(Uri.parse(url));
      await ws.ready.timeout(const Duration(seconds: 6));
      // close() raced us while we were awaiting the handshake — this fresh
      // connection belongs to nobody, drop it instead of leaking it
      if (_closedByUser) {
        unawaited(ws.sink.close());
        return;
      }
      _ws = ws;
      _attempt = 0;
      _lastServerMsgAt = DateTime.now();
      _pongSeen = false; // per-connection: re-negotiate with whoever answers
      _setState(LensLinkState.connected);
      _startHeartbeat();
      ws.stream.listen(
        (data) {
          _lastServerMsgAt = DateTime.now();
          if (data is! String) return;
          final msg = jsonDecode(data) as Map<String, dynamic>;
          if (msg['type'] == 'pong') {
            _pongSeen = true; // host speaks keepalive — arm the eviction
            return;
          }
          if (msg['type'] == 'capture') {
            _commands.add(CaptureCommand(msg['captureId'] as String, msg['note'] as String?));
          } else if (msg['type'] == 'pause_preview') {
            onPreviewState?.call(false);
          } else if (msg['type'] == 'resume_preview') {
            onPreviewState?.call(true);
          }
        },
        onDone: () {
          debugPrint('[lens-mate] camera ws closed (code=${ws?.closeCode} reason=${ws?.closeReason}) attempt=$_attempt');
          _scheduleReconnect();
        },
        onError: (Object e) {
          debugPrint('[lens-mate] camera ws error: $e attempt=$_attempt');
          _scheduleReconnect();
        },
        cancelOnError: true,
      );
    } catch (_) {
      // Abandon the half-open channel WITHOUT awaiting its close: sink.close()
      // waits on the underlying handshake, which hangs forever when the
      // receiver is unreachable (LAN SYN black hole) — awaiting it stalled the
      // reconnect loop at "connecting" indefinitely (seen live: phone app
      // started before the desktop could never auto-reconnect).
      try {
        unawaited(ws?.sink.close());
      } catch (_) {}
      _scheduleReconnect();
    }
  }

  void _scheduleReconnect() {
    if (_closedByUser) return;
    _stopHeartbeat();
    _setState(LensLinkState.disconnected);
    _reconnect?.cancel();
    final delay = Duration(milliseconds: (500 * (_attempt + 1)).clamp(500, 5000));
    _attempt++;
    _reconnect = Timer(delay, _connect);
  }

  // ── keepalive internals ───────────────────────────────────────────────────

  void _startHeartbeat() {
    _heartbeat?.cancel();
    _heartbeat = Timer.periodic(_heartbeatInterval, (_) {
      // silence beyond the limit = half-open link (wifi switch, host reboot
      // without FIN): tear it down ourselves instead of trusting the OS to
      // notice sometime in the next quarter hour. Gated on _pongSeen so a
      // pre-1.0.3 host (which never answers) isn't evicted on its silence.
      if (_pongSeen && DateTime.now().difference(_lastServerMsgAt) > _serverSilenceLimit) {
        debugPrint('[lens-mate] camera ws half-open (no server message '
            '${_serverSilenceLimit.inSeconds}s) — forcing reconnect');
        _abortConnection();
        return;
      }
      _send(jsonEncode({'type': 'ping'}));
    });
  }

  void _stopHeartbeat() {
    _heartbeat?.cancel();
    _heartbeat = null;
  }

  /// Drop the current ws without awaiting its close (close() hangs on a dead
  /// peer — the LAN black-hole lesson) and go straight to the retry loop.
  void _abortConnection() {
    final dead = _ws;
    _ws = null;
    unawaited(dead?.sink.close());
    _scheduleReconnect();
  }

  /// Foreground / route-return nudge: if we're mid-backoff, retry NOW (timers
  /// freeze while Android backgrounds the app, so the pending retry may be
  /// stale); if connected, probe liveness immediately instead of waiting for
  /// the next heartbeat tick.
  void kick() {
    if (_closedByUser) return;
    if (_state == LensLinkState.connected) {
      _send(jsonEncode({'type': 'ping'}));
      return;
    }
    _reconnect?.cancel();
    _attempt = 0;
    unawaited(_connect());
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
    try {
      _ws?.sink.add(jpeg);
    } catch (_) {
      // sink can already be closed when onDone hasn't reached us yet
      _drops++;
    }
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
    if (_state != LensLinkState.connected) return;
    try {
      _ws?.sink.add(text);
    } catch (_) {}
  }

  Future<void> close() async {
    _closedByUser = true;
    _stopHeartbeat();
    _reconnect?.cancel();
    await _ws?.sink.close();
    _setState(LensLinkState.disconnected);
    await _commands.close();
    await _states.close();
  }
}
