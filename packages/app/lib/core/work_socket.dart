import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'camera_socket.dart' show LensLinkState;
import 'global_link.dart';

/// 「工作(Beta)」websocket client.
///
/// Engineering guards mirror CameraSocket (they were paid for there):
/// - exponential reconnect backoff, capped;
/// - app-level ping/pong keepalive (10s) with a half-open watchdog that only
///   fires after we've SEEN a pong (older hosts answer everything, so the
///   pong gate keeps the verdict honest);
/// - identity guard: a replaced connection's late onDone/onError/frames must
///   never touch the new one's state (subscription is cancelled on takeover
///   AND every callback checks `identical(ws, _ws)`);
/// - never `await sink.close()` — a black-holed LAN peer must not wedge us.
class WorkSocket {
  WorkSocket({required this.host, required this.port, required this.deviceId, required this.token, required this.onFrame});

  final String host;
  final int port;
  final String deviceId;
  final String token;

  /// Every JSON text frame the host sends, already decoded.
  final void Function(Map<String, dynamic> frame) onFrame;

  /// True while the last disconnect was a 4003 "work beta off on the PC"
  /// close: the session list shows a dedicated hint instead of a generic
  /// "未连接" (the phone side is on, but the PC side is off — a state the
  /// user can actually fix, unlike a flaky link).
  final ValueNotifier<bool> hostRefused = ValueNotifier(false);
  /// Fired once per teardown caused by the LINK dying (dispose() suppresses
  /// it): the store raises an in-chat "connection lost" banner, since the
  /// streaming row and the stop button would otherwise look alive while
  /// nothing can reach the host.
  void Function()? onDisconnected;

  WebSocketChannel? _ws;
  StreamSubscription<dynamic>? _sub;
  Timer? _reconnect;
  Timer? _ping;
  DateTime _lastInbound = DateTime.now();
  bool _pongSeen = false;
  bool _closedByUser = false;
  bool _connecting = false;
  int _sendDrops = 0;
  // host closed us with 4003 (work beta off on the PC side): the timer-driven
  // retry loop pauses — reconnecting is futile until the host flips the
  // switch — while user-driven kicks still retry once.
  bool _hostRefused = false;
  int _attempt = 0;

  static const _pingEvery = Duration(seconds: 10);
  static const _halfOpenAfter = Duration(seconds: 30);

  bool get isConnected => _ws != null;

  Future<void> connect() async {
    if (_connecting || _ws != null) return;
    _closedByUser = false;
    _connecting = true;
    final url = Uri.parse('ws://$host:$port/ws/work?deviceId=$deviceId&token=$token');
    WebSocketChannel? ws;
    try {
      ws = WebSocketChannel.connect(url);
      await ws.ready.timeout(const Duration(seconds: 6));
    } catch (_) {
      // handshake timed out or threw: the channel may still complete its TCP
      // handshake in the background — drop it or it lingers forever (the
      // CameraSocket lesson: a LAN SYN black hole holds these indefinitely)
      try {
        unawaited(ws?.sink.close());
      } catch (_) {}
      _connecting = false;
      _scheduleReconnect();
      return;
    }
    _connecting = false;
    // user detached while the handshake was in flight — tear down at once
    if (_closedByUser) {
      try {
        ws.sink.close();
      } catch (_) {}
      return;
    }
    // retire the ghost of a previous connection BEFORE this one takes over:
    // cancel its listeners (its late onDone/onError must never tear down the
    // state of the new link) and drop the socket WITHOUT awaiting
    final oldSub = _sub;
    _sub = null;
    try {
      unawaited(oldSub?.cancel());
    } catch (_) {}
    final prev = _ws;
    if (prev != null && !identical(prev, ws)) {
      try {
        prev.sink.close();
      } catch (_) {}
    }
    _ws = ws;
    _attempt = 0;
    _lastInbound = DateTime.now();
    _pongSeen = false;
    _sendDrops = 0;
    hostRefused.value = false;
    globalWorkLink.value = LensLinkState.connected;
    _ping = Timer.periodic(_pingEvery, (_) => _tick());
    _sub = ws.stream.listen(
      (data) {
        // identity guard: stale traffic from a replaced connection must not
        // feed the keepalive timers or the store
        if (!identical(ws, _ws)) return;
        _lastInbound = DateTime.now();
        if (data is! String) return;
        try {
          final frame = jsonDecode(data);
          if (frame is Map<String, dynamic>) {
            if (frame['type'] == 'pong') {
              _pongSeen = true;
              return;
            }
            onFrame(frame);
          }
        } catch (_) {
          // a malformed frame must never kill the link
        }
      },
      onError: (_) {
        if (!identical(ws, _ws)) return;
        _teardown(reconnect: true);
      },
      onDone: () {
        // identity guard: onDone of an ABANDONED socket (one replaced by a
        // newer connection, or whose sink.close() only completed after the
        // network healed) arrives late — it must never tear down the CURRENT
        // healthy link
        if (!identical(ws, _ws)) return;
        if (ws?.closeCode == 4003) {
          _teardown(reconnect: false);
          _hostRefused = true;
          hostRefused.value = true;
          return;
        }
        _teardown(reconnect: !_closedByUser);
      },
      cancelOnError: true,
    );
  }

  void _tick() {
    if (_ws == null) return;
    // half-open verdict needs BOTH conditions (same doctrine as CameraSocket):
    // app-level silence past the watchdog AND evidence the host answers pings.
    // A single lost ping (worst inbound gap 20s) can never trip the 30s gate.
    final silentFor = DateTime.now().difference(_lastInbound);
    if (_pongSeen && silentFor > _halfOpenAfter) {
      _teardown(reconnect: true);
      return;
    }
    send({'type': 'ping'});
  }

  void send(Map<String, dynamic> frame) {
    final ws = _ws;
    if (ws == null) return;
    try {
      ws.sink.add(jsonEncode(frame));
    } catch (_) {
      // send failures surface through onDone/onError teardown; count them so
      // a silently-dead link leaves a trace in the debug log
      _sendDrops++;
      if (_sendDrops <= 3 || _sendDrops % 50 == 0) debugPrint('WorkSocket: send drop #$_sendDrops');
    }
  }

  void _teardown({required bool reconnect}) {
    _ping?.cancel();
    _ping = null;
    // detach the listeners FIRST: a cancelled subscription never fires
    // onDone, so the dead link can't re-enter the teardown after us
    _sub?.cancel();
    _sub = null;
    final ws = _ws;
    _ws = null;
    globalWorkLink.value = LensLinkState.disconnected;
    if (!_closedByUser) onDisconnected?.call();
    if (ws != null) {
      // fire-and-forget close: awaiting a dead peer's ack on a LAN black hole
      // would stall this zone (CameraSocket lesson)
      try {
        ws.sink.close();
      } catch (_) {}
    }
    if (reconnect && !_closedByUser) _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_closedByUser || _hostRefused || _reconnect != null) return;
    _attempt++;
    final delay = Duration(milliseconds: (500 * (_attempt + 1)).clamp(500, 5000));
    _reconnect = Timer(delay, () {
      _reconnect = null;
      connect();
    });
  }

  /// Foreground/route-return kick: retry NOW instead of waiting out the timer.
  void kick() {
    if (_ws != null) {
      // connected: probe liveness immediately instead of waiting for the next
      // heartbeat tick (same as CameraSocket.kick) — a pong refreshes
      // _lastInbound; a dead link lets the watchdog converge sooner
      send({'type': 'ping'});
      return;
    }
    if (_connecting) return;
    _reconnect?.cancel();
    _reconnect = null;
    _hostRefused = false; // user-driven retry: the host beta may be back on
    connect();
  }

  void dispose() {
    _closedByUser = true;
    _reconnect?.cancel();
    _reconnect = null;
    _teardown(reconnect: false);
  }
}
