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
  /// The phone App's version (PackageInfo.version), announced in every hello
  /// so the host can surface cross-end version-consistency hints. MUTABLE on
  /// purpose: PackageInfo resolves asynchronously after the socket exists —
  /// the first hello may go out without it, the next announce picks it up.
  /// Older hosts ignore the extra field; older App builds send hello without it.
  String? appVersion;
  final _commands = StreamController<CaptureCommand>.broadcast();
  final _states = StreamController<LensLinkState>.broadcast();

  WebSocketChannel? _ws;
  /// Listen subscription of the CURRENT connection (`_ws`). Cancelling it is
  /// the only way to stop a replaced/abandoned socket's onDone/onError from
  /// firing into the state of whichever connection is live now.
  StreamSubscription? _sub;
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

  CameraSocket(this.url, {this.appVersion}) {
    _connect();
  }

  Stream<CaptureCommand> get commands => _commands.stream;
  Stream<LensLinkState> get states => _states.stream;
  LensLinkState get state => _state;

  /// Called when the host asks this phone to stop/start preview streaming
  /// (another device owns the PC preview, or control switched back to us).
  void Function(bool active)? onPreviewState;

  /// Host-initiated camera parking/waking (the model tools phone_camera_pause
  /// / phone_camera_resume). [reqId] must be echoed back via
  /// [reportCameraState] so the host can correlate its waiter.
  void Function(String type, String? reqId)? onCameraControl;

  void _setState(LensLinkState s) {
    _state = s;
    _states.add(s);
  }

  Future<void> _connect() async {
    if (_closedByUser) return;
    // in-flight mutex: a handshake is already dialing (kick() racing the
    // reconnect timer, or two kicks in a row) — a second _connect() here
    // would create TWO live sockets for one CameraSocket
    if (_state == LensLinkState.connecting) return;
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
      // retire the ghost of a previous connection BEFORE this one takes over:
      // cancel its listeners (its late onDone/onError must never touch the
      // state of the new link) and drop the socket WITHOUT awaiting (close()
      // hangs forever on a dead peer — the LAN black-hole lesson)
      final oldSub = _sub;
      _sub = null;
      unawaited(oldSub?.cancel());
      final prev = _ws;
      if (prev != null && !identical(prev, ws)) {
        unawaited(prev.sink.close());
      }
      _ws = ws;
      _attempt = 0;
      _lastServerMsgAt = DateTime.now();
      _pongSeen = false; // per-connection: re-negotiate with whoever answers
      _setState(LensLinkState.connected);
      _startHeartbeat();
      _sub = ws.stream.listen(
        (data) {
          // identity guard: stale traffic from a replaced connection must not
          // feed the heartbeat timers or re-arm the command stream
          if (!identical(ws, _ws)) return;
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
          } else if (msg['type'] == 'camera_idle' || msg['type'] == 'camera_resume') {
            onCameraControl?.call(msg['type'] as String, msg['reqId'] as String?);
          }
        },
        onDone: () {
          // identity guard: onDone of an ABANDONED socket (half-open link whose
          // sink.close() only completed after the network healed, or one
          // replaced by a newer connection) arrives late — it must never tear
          // down the CURRENT healthy link
          if (!identical(ws, _ws)) return;
          debugPrint('[lens-mate] camera ws closed (code=${ws?.closeCode} reason=${ws?.closeReason}) attempt=$_attempt');
          _scheduleReconnect();
        },
        onError: (Object e) {
          if (!identical(ws, _ws)) return;
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
    // detach the listeners FIRST (null out before cancelling so a re-entrant
    // callback can't see a stale sub): a cancelled subscription never fires
    // onDone, so the dead link can't re-enter _scheduleReconnect after us
    final sub = _sub;
    _sub = null;
    unawaited(sub?.cancel());
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
    // mid-handshake: do NOT dial again (that would create a second live
    // socket); the in-flight _connect() owns the outcome either way
    if (_state == LensLinkState.connecting) return;
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
      if (appVersion != null) 'appVersion': appVersion,
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

  /// Receipt for a host-initiated camera_idle / camera_resume: [reqId] echoes
  /// what the host sent so it can settle the right tool call.
  void reportCameraState(String? reqId, String state) {
    _send(jsonEncode({
      'type': 'camera_state',
      if (reqId != null) 'reqId': reqId,
      'state': state,
    }));
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
    // detach listeners before closing: the socket's onDone must not fire into
    // the shutdown sequence (belt to _closedByUser's braces)
    final sub = _sub;
    _sub = null;
    unawaited(sub?.cancel());
    await _ws?.sink.close();
    _ws = null;
    _setState(LensLinkState.disconnected);
    await _commands.close();
    await _states.close();
  }
}
