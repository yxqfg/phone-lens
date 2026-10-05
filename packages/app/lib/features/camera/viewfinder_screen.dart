import 'dart:async';
import 'dart:io';

import 'package:camera/camera.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:image/image.dart' as img;
import 'package:image_picker/image_picker.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:sensors_plus/sensors_plus.dart';
import 'package:vibration/vibration.dart';

import '../../core/api.dart';
import '../../core/camera_socket.dart';
import '../../core/jpeg.dart';
import '../../core/preview_encoder.dart';
import '../../core/routes.dart';
import '../../core/global_link.dart';
import '../../core/upload_queue.dart';
import '../../ui/background_art.dart';
import '../pair/pair_screen.dart';
import '../upload/upload_queue_screen.dart';
import 'crop_screen.dart';

/// Camera-app style viewfinder: full-ratio (never cropped) preview with
/// translucent top/bottom chrome floating OVER the video, so what you frame
/// is exactly what the photo contains.
///
/// RouteAware: the pairing screen's QR scanner competes for the SAME back
/// camera (both via CameraX, one process). When a route covers us we release
/// the camera; when it pops we reacquire — otherwise the scanner's unbind
/// leaves our preview frozen and takePicture broken until app restart.
class ViewfinderScreen extends StatefulWidget {
  final LensStore store;
  const ViewfinderScreen({super.key, required this.store});

  @override
  State<ViewfinderScreen> createState() => _ViewfinderScreenState();
}

class _ViewfinderScreenState extends State<ViewfinderScreen>
    with WidgetsBindingObserver, RouteAware {
  final _api = LensApi();
  CameraController? _camera;
  bool _cameraReady = false;
  String? _cameraError;
  bool _streaming = false;
  /// True while the host has parked this phone's preview (another device owns it).
  bool _hostPaused = false;
  /// True once the user explicitly stopped the preview. Auto-resume paths
  /// (crop return, app foreground, ws reconnect handshake) must respect it —
  /// only an explicit "启动预览" or "设为主机" clears it.
  bool _userStopped = false;
  // focus interaction (opt-in; pure mode = no focus UI/gestures)
  Offset? _focusLocal;
  bool _focusLocked = false;
  bool _showFocus = false;
  Timer? _focusHideTimer;
  // ── pinch zoom ────────────────────────────────────────────────────────────
  // Camera2 zoom ratio (what setZoomLevel speaks): the OS transparently does
  // the multi-camera switch, so within the optical range of a multi-lens
  // phone this IS the optical magnification — the pill just reports it. The
  // ValueNotifier keeps pinch updates off the whole-screen rebuild path.
  final ValueNotifier<double> _zoom = ValueNotifier(1.0);
  double? _zoomMin; // null = this device has no zoom control
  double? _zoomMax;
  double? _scaleStartZoom;
  // ── flash (off → auto → torch cycle) ─────────────────────────────────────
  // torch = always-on light (preview AND photos); auto = the OS fires the
  // flash at capture time when the scene is dark. Torch dies with the idle
  // auto-off (camera release) and comes back on revive via _applyFlash.
  FlashMode _flash = FlashMode.off;
  bool _sending = false;
  bool _cropBeforeSend = false;
  int _lastSendAt = 0;

  CameraSocket? _socket;
  LensLinkState _link = LensLinkState.disconnected;
  StreamSubscription? _cmdSub;
  DateTime _lastFramePushed = DateTime.now();
  final _encoder = PreviewEncoder();
  // real per-second fps (window counter reset every second — the old
  // cumulative counter kept growing across reconnects and looked absurd)
  int _fpsWindowFrames = 0;
  int _currentFps = 0;
  Timer? _fpsTimer;
  // physical (sensor) orientation — independent of the system auto-rotate
  // setting, so rotation sent to the PC follows how the phone is held.
  bool _physLandscape = false;
  bool _physLeanLeft = false; // ax > 0 when held rotated-left
  StreamSubscription? _accelSub;
  // ── pipeline diagnostics (reported every second to logcat + top strip) ──
  int _camFrames = 0; // camera stream callbacks fired
  int _busyDrops = 0; // frames rejected because an encode was in flight
  int _snapNulls = 0; // copyYuv420 returned null
  int _gapDrops = 0; // frames dropped by the fps throttle

  // ── idle auto camera-off (heat management) ────────────────────────────────
  // After store.cameraIdleTimeoutMin without a capture the camera AND the
  // preview stream are shut down. Every passive re-open path (didPopNext /
  // app resume / crop-screen return) must honour the shutdown — only an
  // explicit shutter / 启动预览 / 设为主机 tap re-opens the camera.
  Timer? _idleTimer;
  DateTime _lastCamActivity = DateTime.now();
  bool _autoClosed = false;
  /// Who parked the camera: the idle timer (default) or the host's
  /// camera_idle request — the black veil says the right thing.
  bool _closedByHost = false;

  PairedServer? get _server => widget.store.server;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // cache the App version once for the hello handshake (cross-end hint);
    // the socket field is mutable so late resolution still reaches the NEXT
    // announce — the very first hello on a cold start may miss it
    () async {
      try {
        final p = await PackageInfo.fromPlatform();
        _appVersion = p.version;
        _socket?.appVersion = p.version;
      } catch (_) {}
    }();
    _initCamera();
    _connectSocket();
    _initOrientation();
    _idleTimer = Timer.periodic(const Duration(seconds: 10), (_) => _idleCheck());
    // camera re-open gating is tab-aware: coming back from another tab must
    // restore the camera (a covering route may have released it), but the
    // re-open itself is deferred to exactly that moment
    homeTab.addListener(_onHomeTabChanged);
  }

  /// IndexedStack fires no route/lifecycle events on tab switches, so this
  /// listener is the only "viewfinder became visible again" signal. Reopens
  /// the camera only if it isn't already up; `_autoClosed` (idle shutdown)
  /// still requires an explicit shutter/preview tap.
  void _onHomeTabChanged() {
    if (!mounted || homeTab.value != 0 || cameraReadyCheck) return;
    _initCamera();
  }

  /// Track physical device orientation via the accelerometer, so the rotation
  /// sent to the PC (and the shutter bar's 90° flip) follows how the phone is
  /// HELD, not whether the system auto-rotate is on.
  void _initOrientation() {
    try {
      _accelSub = accelerometerEventStream().listen((e) {
        final ax = e.x;
        final ay = e.y;
        // Dead zone: when the phone is near flat (shooting a document on a
        // table) gravity sits on Z and X/Y are close to 0 — deciding "was it
        // landscape?" from that tiny signal would flip back and forth. Only
        // switch when X/Y differ enough; otherwise KEEP the last orientation.
        final diff = ax.abs() - ay.abs();
        if (diff.abs() < 2.0) return;
        final landscape = diff > 0;
        final leanLeft = ax > 0;
        if (landscape != _physLandscape || leanLeft != _physLeanLeft) {
          setState(() {
            _physLandscape = landscape;
            _physLeanLeft = leanLeft;
          });
          // re-announce rotation so the PC-side canvas follows the sensor
          if (_streaming) _announceStream();
        }
      });
    } catch (_) {
      // no sensor/stream → fall back to UI orientation via _streamRotation
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final route = ModalRoute.of(context);
    if (route is PageRoute) routeObserver.subscribe(this, route);
  }

  @override
  void didPushNext() => _releaseCamera();

  @override
  void didPopNext() {
    // back from a covering route (pair scanner, cropper, …): nudge the socket
    // right away (it may have gone stale behind our back), but reopen the
    // camera ONLY when the viewfinder is the visible tab — spinning up
    // CameraX + the preview stream while the user pops back into the
    // SETTINGS tab is invisible work that stuttered the pop transition
    // (the "ghost frame" jank), on fast phones too.
    _socket?.kick();
    if (homeTab.value == 0) _initCamera();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Free the camera when backgrounded; reacquire on resume.
    if (state == AppLifecycleState.inactive) {
      _releaseCamera();
    } else if (state == AppLifecycleState.resumed) {
      // OS-frozen timers may have stalled the retry loop or left a half-open
      // link undetected while we were away — nudge the socket right away
      // instead of waiting out the backoff. The camera only comes back when
      // the viewfinder is actually the visible tab (same gating as
      // didPopNext); returning to the tab later reopens it.
      _socket?.kick();
      if (homeTab.value == 0) _initCamera();
    }
  }

  @override
  void didChangeMetrics() {
    // Screen rotated: rebuild the local preview aspect AND re-announce the
    // rotation so the PC-side canvas flips along with the phone (the hello
    // handshake is the only channel that reports orientation).
    if (!mounted) return;
    setState(() {});
    if (_streaming) _announceStream();
  }

  bool _cameraInitBusy = false;
  bool _cameraInitPending = false;
  /// Re-arms on every successful open; consumed by the one-shot init retry.
  bool _cameraInitRetry = true;
  // Camera epoch: bumped by every release; an init whose epoch is superseded
  // must dispose its controller instead of assigning it (covers "release ran
  // while initialize() was in flight" — camera under a covering route).
  int _cameraGen = 0;
  Future<void>? _cameraDisposing;
  /// True when the stream delivers plugin-encoded JPEG frames directly
  /// (color-correct by construction — no hand-rolled YUV assembly).
  bool _jpegStreamMode = false;

  Future<void> _initCamera() async {
    // Idle auto-off fired earlier: every PASSIVE path lands here (crop-screen
    // return, app foreground, tab return) and must NOT re-open the camera.
    // Only the explicit user taps clear _autoClosed first.
    if (_autoClosed) return;
    if (_cameraInitBusy) {
      _cameraInitPending = true; // re-run after the in-flight one settles
      return;
    }
    _cameraInitBusy = true;
    try {
      // let any dispose from a previous release finish BEFORE opening the
      // next controller — parallel open/close can raise CAMERA_IN_USE
      await _cameraDisposing;
      await _releaseCamera();
      final gen = _cameraGen;
      try {
        final cameras = await availableCameras();
        final back = cameras.firstWhere(
          (c) => c.lensDirection == CameraLensDirection.back,
          orElse: () => cameras.first,
        );
        // NOTE: ImageFormatGroup.jpeg initializes but never delivers a single
        // frame on this device family (measured: cam=0 forever), so we stay
        // on yuv420 and assemble ourselves — chroma order is settled from the
        // logged plane census, not guesses.
        final controller = CameraController(
          back,
          ResolutionPreset.high,
          enableAudio: false,
          imageFormatGroup: ImageFormatGroup.yuv420,
        );
        await controller.initialize();
        final jpeg = false;
        if (!mounted || gen != _cameraGen) {
          await controller.dispose();
          return;
        }
        // resume the preview stream if it was live before the camera went away
        if (_streaming) {
          try {
            await controller.startImageStream(_onCameraImage);
          } catch (_) {}
          // the stream start is a real async gap — re-check that neither a
          // release (gen bump) nor an idle shutdown happened meanwhile, or a
          // backgrounded/host-parked phone would end up "ready" with a live
          // stream under the black veil
          if (!mounted || gen != _cameraGen || _autoClosed) {
            await controller.dispose();
            return;
          }
        }
        setState(() {
          _camera = controller;
          _cameraReady = true;
          _cameraError = null;
          _jpegStreamMode = jpeg;
          _cameraInitRetry = true; // a successful open re-arms the one-shot heal
        });
        debugPrint('[lens-mate] camera stream mode: yuv420(hand-assembled) — jpeg stream delivers no frames on this device');
        _touchCamera(); // camera (re)opened = idle clock restarts
        // zoom range is per-device AND per-session: re-read after every open
        // (re-applies the remembered ratio so release/init cycles keep zoom)
        await _applyZoomAfterInit(controller);
        await _applyFlash(controller);
        // preview streaming defaults ON — it's a framing aid, not a video
        // upload; users turn it off explicitly when they want to.
        // A host-paused phone must NOT resume by itself (multi-device rule),
        // and neither may a user-stopped one: returning from the cropper or
        // the app foreground used to silently re-open the stream here.
        if (!_streaming && !_hostPaused && !_userStopped) _toggleStream();
      } catch (e) {
        debugPrint('[lens-mate] camera init failed: $e');
        if (mounted) setState(() => _cameraError = '相机初始化失败,请检查相机权限未被占用后重试');
        // One-shot self-heal for the pairing→viewfinder hand-off: the QR
        // scanner's CameraX unbind races our re-open for the same back camera
        // (first launch pairs, then swaps to this screen). One delayed retry;
        // a second consecutive failure is a real problem worth the error UI.
        if (mounted && _cameraInitRetry && !_autoClosed && !_userStopped) {
          _cameraInitRetry = false;
          Future.delayed(const Duration(milliseconds: 1500), () {
            // skip while backgrounded: Android forbids background camera opens,
            // the attempt would just burn the one-shot retry and flash a
            // misleading error (the resumed-path init recovers on return)
            if (mounted &&
                !cameraReadyCheck &&
                !_autoClosed &&
                homeTab.value == 0 &&
                WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed) {
              _initCamera();
            }
          });
        }
      }
    } finally {
      _cameraInitBusy = false;
      if (_cameraInitPending) {
        _cameraInitPending = false;
        scheduleMicrotask(_initCamera);
      }
    }
  }

  /// Dispose the controller (stops any image stream); `_streaming` survives
  /// as the desired state and is restored by the next [_initCamera].
  Future<void> _releaseCamera() async {
    _cameraGen++;
    final cam = _camera;
    _camera = null;
    if (mounted) setState(() => _cameraReady = false);
    final f = cam?.dispose();
    if (f != null) _cameraDisposing = f;
    await f;
  }

  // ── idle auto-off ──────────────────────────────────────────────────────────

  void _touchCamera() => _lastCamActivity = DateTime.now();

  /// Every 10s: shut the camera down after N idle minutes (no capture).
  Future<void> _idleCheck() async {
    if (!mounted || _autoClosed || !cameraReadyCheck) return;
    final min = widget.store.cameraIdleTimeoutMin;
    if (min <= 0) return; // 不自动关闭
    if (DateTime.now().difference(_lastCamActivity).inMinutes < min) return;
    await _autoCloseCamera();
  }

  /// Heat/Power valve: kill the camera AND the preview stream, black out the
  /// viewfinder with a notice. `_userStopped` is set too so the existing
  /// auto-stream gate in [_initCamera] also stays shut for passive paths.
  Future<void> _autoCloseCamera({bool byHost = false}) async {
    _autoClosed = true;
    _closedByHost = byHost;
    _userStopped = true;
    await _stopStream();
    await _releaseCamera();
    debugPrint('[lens-mate] idle ${widget.store.cameraIdleTimeoutMin}min → camera auto-closed${byHost ? ' (host requested)' : ''}');
    if (mounted) setState(() {});
  }

  /// Explicit user intent (shutter / 启动预览 / 设为主机): the ONLY way out of
  /// the idle shutdown, and the generic "camera is down, bring it back" path
  /// (e.g. released under a covering route while another tab was showing —
  /// a remote shutter must self-heal that). Re-opens the camera, then the
  /// caller proceeds.
  Future<bool> _reviveFromAutoClose() async {
    if (!_autoClosed) {
      if (!cameraReadyCheck) {
        await _initCamera();
        _touchCamera();
      }
      return cameraReadyCheck;
    }
    _autoClosed = false;
    _closedByHost = false;
    if (mounted) setState(() {});
    await _initCamera(); // _userStopped still true → no auto stream here
    _touchCamera();
    return cameraReadyCheck;
  }

  bool _authProbeDone = false; // one 401 probe per link lifetime
  bool _authFailed = false; // receiver no longer knows our token
  /// Announced in every hello (cross-end version hint). Resolved async at
  /// startup — an early hello may go out without it; the next announce carries it.
  String? _appVersion;

  void _connectSocket() {
    final s = _server;
    if (s == null) return;
    _authProbeDone = false;
    _authFailed = false;
    final socket = CameraSocket(
      'ws://${s.host}:${s.port}/ws/camera?deviceId=${s.deviceId}&token=${s.token}',
      appVersion: _appVersion,
    );
    _socket = socket;
    socket.states.listen((st) {
      globalLink.value = st; // share with settings list
      if (mounted) setState(() => _link = st);
      if (st == LensLinkState.connected) {
        _reconnectStreak = 0;
        _authProbeDone = false;
        _authFailed = false;
        UploadQueue.instance.kick(); // network is back — flush queued shots
        // The stream survived the outage as DESIRED state; the new uplink has
        // no meta yet. Re-announce so the PC-side canvas gets size + rotation
        // immediately (resume_preview alone doesn't carry them).
        if (_streaming && cameraReadyCheck) _announceStream();
      } else if (st == LensLinkState.disconnected) {
        _reconnectStreak++;
        _maybeProbeAuth();
        // Auto-select when the current receiver drops and autoSelect is on.
        if (widget.store.autoSelect) _autoSelectAvailable();
      }
    });
    socket.onPreviewState = (active) => _onHostPreviewState(active);
    socket.onCameraControl = (type, reqId) => _onHostCameraControl(type, reqId);
    _cmdSub = socket.commands.listen(_onRemoteShutter);
    _encoder.onFrame = (jpeg) {
      _fpsWindowFrames++;
      _socket?.pushFrame(jpeg);
    };
    _encoder.start();
    _fpsTimer?.cancel();
    _fpsTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() {
        _currentFps = _fpsWindowFrames;
        _fpsWindowFrames = 0;
      });
      debugPrint(
        '[lens-mate] pipe: cam=$_camFrames encoded=$_currentFps busyDrop=$_busyDrops nulls=$_snapNulls gap=$_gapDrops engine=${_encoder.engineLabel} busy=${_encoder.busy} streaming=$_streaming link=${_link.name} err=${_encoder.lastError}',
      );
    });
    // follow the receiver's live preview config (fps/resolution/quality)
    _refreshPreviewParams(s);
  }

  /// After several failed reconnects, check ONCE whether the receiver still
  /// accepts our token — devices.json resets (reinstall/profile switch)
  /// otherwise leave the app retrying forever with no way out but re-pairing.
  int _reconnectStreak = 0;
  Future<void> _maybeProbeAuth() async {
    if (_authProbeDone || _reconnectStreak < 5) return;
    _authProbeDone = true;
    final s = _server;
    if (s == null) return;
    try {
      await _api.status(s);
      // reachable + authed: the failures were plain network flakiness
    } on LensApiError catch (e) {
      if (e.code == 'AUTH_REQUIRED' && mounted) {
        setState(() => _authFailed = true);
      }
    } catch (_) {
      // network-level failure: keep the generic "not connected" state
    }
  }

  /// Auto-select an available paired receiver when autoSelect is on and the
  /// current one dropped (network switch, receiver restarted, …).
  bool _autoSelecting = false;
  Future<void> _autoSelectAvailable() async {
    if (_autoSelecting) return; // socket retries fire this repeatedly
    _autoSelecting = true;
    try {
      final current = widget.store.server;
      final servers = widget.store.servers();
      if (current == null || servers.length < 2) return;
      for (final s in servers) {
        if (s.id == current.id) continue;
        if (!mounted) return;
        if (await _api.reachable(s)) {
          if (!mounted) return;
          await widget.store.setActive(s.id);
          _socket?.close();
          _socket = null;
          _connectSocket(); // rebind to the new receiver
          if (mounted) setState(() {});
          _toast('已切换到可用连接: ${s.name}');
          return;
        }
      }
    } finally {
      _autoSelecting = false;
    }
  }

  Future<void> _refreshPreviewParams(PairedServer s) async {
    try {
      final st = await _api.status(s);
      final pv = st['preview'] as Map<String, dynamic>?;
      if (pv == null || !mounted) return;
      final mw = (pv['maxWidth'] as num?)?.toInt() ?? 854;
      final mh = (pv['maxHeight'] as num?)?.toInt() ?? 480;
      await widget.store.savePreviewParams({
        'maxShort': mw < mh ? mw : mh,
        'maxLong': mw < mh ? mh : mw,
        'fps': (pv['fps'] as num?)?.toInt() ?? 10,
        'quality': (pv['jpegQuality'] as num?)?.toInt() ?? 70,
      });
      if (mounted) setState(() {});
    } catch (_) {
      // keep whatever we already have
    }
  }

  /// 0.5s buzz — 0.2s pause — 0.5s buzz: the "someone over there is using MY
  /// camera" pattern. Best-effort: no vibrator / suppressed by the OS just
  /// skips silently.
  Future<void> _alertBuzz() async {
    try {
      if (await Vibration.hasVibrator() != true) return;
      await Vibration.vibrate(pattern: [0, 500, 200, 500]);
    } catch (_) {}
  }

  /// camera_idle arriving mid-shot must NOT dispose the controller under
  /// takePicture() (the in-flight photo would die): park the request and run
  /// it from the shoot's finally instead.
  bool _pendingHostIdle = false;

  void _onRemoteShutter(CaptureCommand cmd) {
    // The phone must speak up whenever someone else drives its camera — the
    // user-fired web-UI shutter and the model's phone_take_photo alike ride
    // this same command. Opt-out lives in Settings (拍照提醒).
    if (widget.store.remoteCaptureAlert) {
      final note = cmd.note?.trim();
      _toast(note == null || note.isEmpty ? '电脑端请求拍照并上传' : '电脑端请求拍照并上传: $note');
      unawaited(_alertBuzz());
    }
    if (_sending) {
      _socket?.reportCapture(cmd.captureId, 'declined', 'busy');
      return;
    }
    // A remote shutter is still a user action: it must wake the camera from
    // ANY down state — the idle auto-off, or released-under-a-covering-route
    // while the user sits on another tab — exactly like the on-screen shutter.
    if (!cameraReadyCheck) {
      // hold the busy slot through revive + focus-settle: a second capture in
      // that window gets a clean 'busy' decline instead of overtaking this
      // one's delayed shot
      setState(() => _sending = true);
      _reviveFromAutoClose().then((ok) async {
        try {
          if (!ok) {
            _socket?.reportCapture(cmd.captureId, 'failed', 'camera unavailable');
            return;
          }
          // A just-woken camera hasn't converged auto-focus yet — an instant
          // shot comes out blurry. Wait the user-configured settle time first
          // (0 = shoot immediately; Settings → 画面 → 唤醒后对焦等待).
          final delayMs = widget.store.wakeFocusDelayMs;
          if (delayMs > 0) await Future<void>.delayed(Duration(milliseconds: delayMs));
          await _shoot(captureId: cmd.captureId, note: cmd.note);
        } finally {
          if (mounted) setState(() => _sending = false);
          // a camera_idle that arrived while we were shooting runs now
          if (_pendingHostIdle) {
            _pendingHostIdle = false;
            unawaited(_onHostCameraControl('camera_idle', null));
          }
        }
      });
      return;
    }
    _shoot(captureId: cmd.captureId, note: cmd.note);
  }

  /// Host-initiated camera parking/waking (model tools phone_camera_pause /
  /// phone_camera_resume). The receipt echoes reqId so the host settles the
  /// right tool call. Resume carries the same authority as an explicit user
  /// tap: clear the idle flag AND restart the stream.
  Future<void> _onHostCameraControl(String type, String? reqId) async {
    if (type == 'camera_idle') {
      if (_sending) {
        // mid-shot: disposing the controller now would kill the in-flight
        // photo — acknowledge and park; the shoot's finally runs this for real
        _pendingHostIdle = true;
        _socket?.reportCameraState(reqId, 'idle');
        return;
      }
      if (cameraReadyCheck && !_autoClosed) {
        debugPrint('[lens-mate] host requested camera idle');
        // attribution: if the user had ALREADY stopped the preview themselves,
        // the neutral idle wording is more honest than "电脑端已关闭摄像头"
        await _autoCloseCamera(byHost: !_userStopped);
      }
      // a camera that was already parked (idle shutdown OR plain user-stopped
      // preview) reports idle — 'live' is only true while it's actually open
      _socket?.reportCameraState(reqId, cameraReadyCheck && !_autoClosed ? 'live' : 'idle');
      return;
    }
    if (type == 'camera_resume') {
      final wasAutoClosed = _autoClosed;
      try {
        if (!cameraReadyCheck || _autoClosed) {
          debugPrint('[lens-mate] host requested camera resume');
          _autoClosed = false;
          _closedByHost = false;
          _userStopped = false; // resume owns the same authority as 启动预览
          if (mounted) setState(() {});
          await _initCamera();
          _touchCamera();
          if (cameraReadyCheck && !_streaming && !_hostPaused) {
            await _startStream(); // clears _userStopped on success
          }
        }
        _socket?.reportCameraState(reqId, cameraReadyCheck ? 'live' : 'failed');
      } catch (_) {
        _socket?.reportCameraState(reqId, 'failed');
      } finally {
        // a failed resume (e.g. app backgrounded, Android refuses the camera)
        // must not leave the idle flags cleared while the camera is actually
        // down — roll back so the veil and the passive-init gates stay true
        if (!cameraReadyCheck && wasAutoClosed) {
          _autoClosed = true;
          if (mounted) setState(() {});
        }
      }
    }
  }

  /// Re-announce the SENSOR frame shape + rotation to the host (the hello
  /// handshake). Every "the PC needs to know our geometry" moment funnels
  /// here: stream start, orientation change, and ws reconnect.
  void _announceStream() {
    final camera = _camera;
    if (camera == null || !camera.value.isInitialized) return;
    final ps = camera.value.previewSize;
    _socket?.sendHello(
      ps?.width.round() ?? 1280,
      ps?.height.round() ?? 720,
      widget.store.previewParams['fps'] ?? 10,
      _streamRotation(),
    );
  }

  /// Make THIS phone the active preview/shutter device: tell the host to
  /// switch the PC preview to us (it pauses every other phone), and make sure
  /// our own preview stream is running.
  /// Shutter tap, including from the idle-shutdown black screen. The FIRST
  /// tap after an idle shutdown only wakes the camera (user asked for this:
  /// a blind shot right after revive is a surprise) — the second tap shoots
  /// with the live preview already up. From the normal ready state it shoots
  /// immediately as before.
  Future<void> _shutterTap() async {
    if (_sending) return;
    if (!cameraReadyCheck) {
      _toast(_autoClosed ? '已唤醒摄像头,再点一次拍摄' : '正在打开摄像头…');
      // revive failed → _initCamera already surfaced _cameraError
      if (!await _reviveFromAutoClose()) return;
      return; // this tap woke the camera; the next one shoots
    }
    await _shoot();
  }

  /// 启动预览 tap, including from the idle shutdown: revive the camera, then
  /// run the normal toggle (host-paused gets its usual toast; a successful
  /// start clears _userStopped).
  Future<void> _previewTap() async {
    if (!cameraReadyCheck) {
      _toast('正在打开摄像头…');
      if (!await _reviveFromAutoClose()) return;
    }
    await _toggleStream();
    _touchCamera();
  }

  /// 设为主机 tap, including from the idle shutdown.
  Future<void> _makeMainTap() async {
    if (!cameraReadyCheck) {
      _toast('正在打开摄像头…');
      if (!await _reviveFromAutoClose()) return;
    }
    await _makeMain();
  }

  Future<void> _makeMain() async {
    if (_socket == null) return;
    // claim_active is only delivered on a live socket — a dead link would
    // make the success toast below a lie
    if (_link != LensLinkState.connected) {
      _toast('未连接电脑');
      return;
    }
    _socket?.makeMain();
    // optimistic: the host will confirm by resuming us (and re-pausing if it
    // disagrees); this unblocks _startStream below
    if (mounted) setState(() => _hostPaused = false);
    if (cameraReadyCheck && !_streaming) await _startStream();
    _touchCamera(); // explicit user action on the camera — idle clock restarts
    _toast('已设为主机,电脑端预览已切换为本机');
  }

  Future<void> _toggleStream() async {
    if (_streaming) {
      _userStopped = true; // explicit user intent: preview stays OFF
      await _stopStream();
    } else {
      await _startStream(); // clears _userStopped on success
    }
  }

  Future<void> _startStream() async {
    if (_hostPaused) {
      // another device owns the PC preview; the way out is claiming it
      _toast('其他设备正在使用电脑端预览,点「设为主机」可切回本机');
      return;
    }
    final camera = _camera;
    if (camera == null || !camera.value.isInitialized) return;
    if (_streaming) return;
    _userStopped = false;
    setState(() => _streaming = true);
    try {
      await camera.startImageStream(_onCameraImage);
    } catch (e) {
      debugPrint('[lens-mate] startImageStream failed: $e');
      if (mounted) setState(() => _streaming = false);
      _toast('预览启动失败,请重试');
      return;
    }
    // announce the SENSOR frame shape + rotation so PC-side canvases can
    // draw it upright (rotation is a display-side concern now)
    _announceStream();
  }

  Future<void> _stopStream() async {
    final camera = _camera;
    if (camera == null || !_streaming) return;
    // flip the flag BEFORE awaiting: a second tap while stopImageStream is
    // in flight would otherwise double-stop and throw
    if (mounted) setState(() => _streaming = false);
    try {
      await camera.stopImageStream();
    } catch (e) {
      debugPrint('[lens-mate] stopImageStream failed: $e');
    }
  }

  /// Host asked this phone to pause (another device owns the preview) or resume
  /// (control switched back). Pausing keeps the connection + upload usable.
  Future<void> _onHostPreviewState(bool active) async {
    if (!active) {
      // NOTE: a host pause must NOT clear _userStopped — "user stopped, then
      // got parked, then got resumed" still ends OFF, honoring the last
      // explicit user intent. Only 启动预览/设为主机 clear the flag.
      await _stopStream();
      if (!mounted) return;
      // reconnect handshakes re-send pause — only surface it once
      if (_hostPaused) return;
      setState(() => _hostPaused = true);
      _longToast('其他设备正在使用电脑端预览;本机仍可正常上传图片');
    } else {
      if (mounted) setState(() => _hostPaused = false);
      // reconnect handshakes re-send resume — never override an explicit
      // user stop; only "设为主机" (which cleared the flag) resumes seamlessly
      if (cameraReadyCheck && !_userStopped) await _startStream();
    }
  }

  /// Clockwise degrees to upright the sensor-oriented buffer (0 = landscape).
  /// Reads the live window size (not MediaQuery, which lags a frame when
  /// called from didChangeMetrics).
  int _streamRotation() {
    final sensor = _camera?.description.sensorOrientation ?? 90;
    if (_physLandscape) {
      // Landscape has TWO flavors. Measured on-device: leaning the phone
      // LEFT (top toward the left, ax > 0) is the sensor's native upright
      // side for the usual 90° sensor (rotation 0); leaning RIGHT flips the
      // buffer upside down (180). Getting this backwards makes BOTH leans
      // render upside-down on the PC.
      final base = _physLeanLeft ? sensor + 270 : sensor + 90;
      return ((base % 360) + 360) % 360;
    }
    // physical (sensor) orientation, independent of system auto-rotate
    final b = ((sensor / 90) % 4 + 4) % 4;
    return b == 3 ? 270 : 90;
  }

  void _onCameraImage(CameraImage image) {
    _camFrames++;
    if (!_streaming) return;
    final p = widget.store.previewParams;
    // a 0 fps (mis)config must not raise IntegerDivisionByZero per frame
    final fps = (p['fps'] ?? 10) <= 0 ? 10 : (p['fps'] ?? 10);
    final minGap = 1000 ~/ fps;
    final now = DateTime.now();
    if (now.difference(_lastFramePushed).inMilliseconds < minGap) {
      _gapDrops++;
      return;
    }
    if (_jpegStreamMode) {
      // plugin-encoded JPEG straight off the stream: zero assembly, push it
      _lastFramePushed = now;
      _fpsWindowFrames++;
      _socket?.pushFrame(image.planes[0].bytes);
      return;
    }
    // single-flight: drop the frame while an encode is running
    if (_encoder.busy) {
      _busyDrops++;
      return;
    }
    final snap = copyYuv420(image);
    if (snap == null) {
      _snapNulls++;
      return;
    }
    _lastFramePushed = now;
    _encoder.encode(
      snap,
      p['maxShort'] ?? 480,
      p['maxLong'] ?? 854,
      p['quality'] ?? 70,
    );
  }

  Future<void> _shoot({String? captureId, String? note}) async {
    final camera = _camera;
    // NOTE: no link check here — a flaky/offline network is exactly when the
    // queue matters; the shot lands on disk and uploads when we reconnect.
    if (camera == null || !cameraReadyCheck) {
      // report so the PC-side shutter shows an error instead of silence
      if (captureId != null) _socket?.reportCapture(captureId, 'failed', 'camera unavailable');
      return;
    }
    if (_sending || DateTime.now().millisecondsSinceEpoch - _lastSendAt < 1200) {
      // throttled: tell the user (local) / the host (remote) instead of silence
      if (captureId != null) {
        _socket?.reportCapture(captureId, 'declined', 'throttled');
      } else {
        _toast('处理中,请稍候');
      }
      return;
    }
    // The _sending lock now only covers CAPTURE (takePicture → bake → crop):
    // the upload happens in the background queue, so the next shot is ready
    // as soon as this one is safely on disk.
    setState(() => _sending = true);
    _touchCamera(); // a capture — local or remote — is the idle-reset event
    try {
      final file = await camera.takePicture();
      var bytes = await File(file.path).readAsBytes();
      // the plugin's temp copy is no longer needed once we hold the bytes
      try {
        await File(file.path).delete();
      } catch (_) {}
      // WYSIWYG: bake the photo to what the viewfinder showed at shutter
      // time. takePicture pixels are always portrait-upright (CameraX bakes
      // the display rotation and this app is portrait-locked), so the extra
      // spin vs. the preview is (streamRotation - sensorOrientation) mod 360
      // — 0 when held upright, ±90 when leaned. Without this, photos sent to
      // the PC ignore the preview orientation entirely.
      final extra = ((_streamRotation() - camera.description.sensorOrientation) % 360 + 360) % 360;
      if (extra != 0) {
        bytes = await compute(_rotateJpeg, _RotateArgs(bytes, extra));
      }
      // pre-shrink oversized captures before the crop screen (decode cost
      // there is O(pixels)); the quality preset is applied on the FINAL bytes
      final maxBytes = widget.store.maxUploadBytes;
      if (bytes.length > maxBytes) {
        bytes = await compute(_fit, _FitArgs(bytes, maxBytes, 4096));
      }
      if (_cropBeforeSend) {
        if (!mounted) return;
        final cropped = await Navigator.of(context).push<Uint8List>(
          MaterialPageRoute(
            builder: (_) => CropScreen(
              bytes: bytes,
              defaultCropRatio: widget.store.defaultCropRatio,
              handleSize: widget.store.handleSize,
            ),
          ),
        );
        // cancel/back on the cropper discards the photo entirely — never send it
        if (cropped == null) {
          if (captureId != null) _socket?.reportCapture(captureId, 'declined', 'cancelled');
          _toast('已丢弃本次照片');
          return;
        }
        bytes = cropped;
      }
      bytes = await _applyUploadQuality(bytes);
      await UploadQueue.instance.enqueue(
        bytes: bytes,
        name: _shotName(),
        note: note,
        captureId: captureId,
      );
      // taken = shot captured and safely queued; the queue owns the rest
      if (captureId != null) _socket?.reportCapture(captureId, 'taken');
      final pending = UploadQueue.instance.pendingCount;
      _toast(pending > 1 ? '已加入上传队列,待传 $pending 张' : '已加入上传队列');
    } catch (e) {
      _toast('拍摄失败');
      if (captureId != null) _socket?.reportCapture(captureId, 'failed', e.toString());
    } finally {
      _lastSendAt = DateTime.now().millisecondsSinceEpoch;
      if (mounted) setState(() => _sending = false);
    }
  }

  /// Enforce the user's upload-quality preset on the FINAL upload bytes
  /// (after rotation and cropping). Runs on the UI isolate but delegates the
  /// heavy decode/encode to worker isolates via compute.
  Future<Uint8List> _applyUploadQuality(Uint8List bytes) async {
    final maxBytes = widget.store.maxUploadBytes;
    switch (widget.store.uploadQuality) {
      case LensStore.qualityMedium:
        return compute(_normalize, _NormArgs(bytes, maxBytes, 2560, 80));
      case LensStore.qualityLow:
        return compute(_normalize, _NormArgs(bytes, maxBytes, 1600, 65));
      default: // high: original bytes unless they exceed the receiver's ceiling
        return bytes.length > maxBytes ? compute(_fit, _FitArgs(bytes, maxBytes, 4096)) : bytes;
    }
  }

  String _shotName() {
    final t = DateTime.now();
    String two(int n) => n.toString().padLeft(2, '0');
    return 'shot_${t.year}${two(t.month)}${two(t.day)}_${two(t.hour)}${two(t.minute)}${two(t.second)}.jpg';
  }

  /// Pick one or more images from the gallery and queue them for upload.
  ///
  /// - Crop mode ON: a single continuous session — each image is cropped,
  ///   then queued, then the next one is loaded in-place (never bouncing
  ///   back to the viewfinder). The ✕ discards all remaining images.
  /// - Crop mode OFF: all images are queued as a batch.
  ///
  /// Queueing (not sending) keeps the UI responsive and gives every picture
  /// the queue's retry/backoff behaviour for free.
  Future<void> _pickFromGallery() async {
    final files = await ImagePicker().pickMultiImage(limit: 12);
    if (files.isEmpty || !mounted) return;
    final maxBytes = widget.store.maxUploadBytes;

    if (_cropBeforeSend) {
      // Read every picked image up front so the crop session can advance
      // without touching the gallery/IO layer between crops.
      final batchBytes = <Uint8List>[];
      final batchNames = <String>[];
      for (final f in files) {
        var bytes = await f.readAsBytes();
        if (bytes.length > maxBytes) bytes = await compute(_fit, _FitArgs(bytes, maxBytes, 4096));
        batchBytes.add(bytes);
        batchNames.add(_galleryName(f.name));
      }
      if (!mounted) return;
      await Navigator.of(context).push<int>(
        MaterialPageRoute(
          builder: (_) => CropScreen(
            bytes: batchBytes.first,
            batch: batchBytes,
            batchNames: batchNames,
            // silent: per-item toasts would fight the crop screen's overlay;
            // enqueueing is fast, so the overlay barely shows
            onBatchUpload: (b, name) async {
              final finalBytes = await _applyUploadQuality(b);
              await UploadQueue.instance.enqueue(bytes: finalBytes, name: name);
            },
            defaultCropRatio: widget.store.defaultCropRatio,
            handleSize: widget.store.handleSize,
          ),
        ),
      );
      if (!mounted) return;
      final pending = UploadQueue.instance.pendingCount;
      if (pending > 0) _toast(pending > 1 ? '已加入上传队列,待传 $pending 张' : '已加入上传队列');
      return;
    }

    // Crop OFF: queue the whole batch; the worker uploads serially in order.
    for (final f in files) {
      if (!mounted) return;
      var bytes = await f.readAsBytes();
      bytes = await _applyUploadQuality(bytes);
      await UploadQueue.instance.enqueue(bytes: bytes, name: _galleryName(f.name));
    }
    if (!mounted) return;
    final pending = UploadQueue.instance.pendingCount;
    _toast('已加入上传队列 $pending 张');
  }

  String _galleryName(String name) {
    final clean = name.replaceAll(RegExp(r'[^\w.\-]+'), '_');
    // strip the ORIGINAL extension before appending ours (no more
    // "IMG_001.png_12345.png"), but remember whether it was a PNG
    final isPng = clean.toLowerCase().endsWith('.png');
    var base = clean.isEmpty ? 'photo' : clean;
    base = base.replaceFirst(RegExp(r'\.[A-Za-z0-9]+$'), '');
    return '${base}_${DateTime.now().millisecondsSinceEpoch % 100000}.${isPng ? 'png' : 'jpg'}';
  }

  void _toast(String msg) => _showToast(msg, const Duration(milliseconds: 1500));

  void _longToast(String msg) => _showToast(msg, const Duration(milliseconds: 2000));

  OverlayEntry? _toastEntry;

  void _showToast(String msg, Duration duration) {
    if (!mounted) return;
    final overlay = Overlay.of(context);
    // replace any existing toast so rapid / repeated triggers never stack or
    // leave a banner stuck on screen (the "占用预览推流" bug).
    _toastEntry?.remove();
    final entry = OverlayEntry(builder: (_) => TopToast(msg));
    _toastEntry = entry;
    overlay.insert(entry);
    Future.delayed(duration, () {
      if (mounted && _toastEntry == entry) {
        entry.remove();
        _toastEntry = null;
      }
    });
  }

  bool get cameraReadyCheck => _cameraReady && (_camera?.value.isInitialized ?? false);

  void _openUploadQueue() {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => UploadQueueScreen(store: widget.store)),
    );
  }

  /// Floating badge over the viewfinder's top-right: pending upload count,
  /// red when something hard-failed, pulsing border while actively sending.
  /// Tap → queue management screen. Hidden when the queue is empty.
  /// Queued-upload badge as an absolutely-positioned overlay (offline empty
  /// state uses this form).
  Widget _queueBadge() {
    return Positioned(top: 12, right: 12, child: _queueBadgeContent());
  }

  /// Badge content without positioning — the viewfinder stacks it in the
  /// top-right column together with the flash toggle and the zoom pill.
  Widget _queueBadgeContent() {
    return ValueListenableBuilder<List<UploadItem>>(
        valueListenable: UploadQueue.instance.items,
        builder: (_, items, __) {
          if (items.isEmpty) return const SizedBox.shrink();
          final failed = items.where((i) => i.status == UploadStatus.failed).length;
          final uploading = items.any((i) => i.status == UploadStatus.uploading);
          return Material(
            color: Colors.transparent,
            child: InkWell(
              borderRadius: BorderRadius.circular(16),
              onTap: _openUploadQueue,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: failed > 0 ? const Color(0xE6B3261E) : Colors.black54,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(
                    color: uploading ? Colors.lightBlueAccent : Colors.white24,
                    width: 1,
                  ),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (uploading)
                      const SizedBox(
                        width: 12,
                        height: 12,
                        child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                      )
                    else
                      Icon(
                        failed > 0 ? Icons.error_outline : Icons.cloud_upload_outlined,
                        size: 14,
                        color: Colors.white,
                      ),
                    const SizedBox(width: 4),
                    Text(
                      '${items.length}',
                      style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.bold),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    routeObserver.unsubscribe(this);
    homeTab.removeListener(_onHomeTabChanged);
    _accelSub?.cancel();
    _cmdSub?.cancel();
    _fpsTimer?.cancel();
    _idleTimer?.cancel();
    _focusHideTimer?.cancel();
    // a toast mid-flight would otherwise linger on the next screen forever
    _toastEntry?.remove();
    _toastEntry = null;
    _socket?.close();
    _encoder.stop();
    _zoom.dispose();
    _camera?.dispose();
    _api.dispose();
    super.dispose();
  }

  // ── layout ─────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Column(
        children: [
          // thin status strip (outside the video, always readable)
          _topStrip(context),
          Expanded(
            child: Stack(
              fit: StackFit.expand,
              children: [
                _cameraError != null
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(_cameraError!, style: const TextStyle(color: Colors.white70), textAlign: TextAlign.center),
                              const SizedBox(height: 14),
                              Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  TextButton.icon(
                                    icon: const Icon(Icons.refresh, size: 18),
                                    label: const Text('重试'),
                                    onPressed: _initCamera,
                                  ),
                                  TextButton.icon(
                                    icon: const Icon(Icons.settings, size: 18),
                                    label: const Text('应用设置'),
                                    onPressed: openAppSettings,
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      )
                    : _previewOrEmpty(),
                // idle-shutdown notice: full black veil OVER the (dead) preview
                // area, UNDER the shutter chrome so the user can revive without
                // hunting for a hidden control.
                if (_autoClosed) _autoClosedOverlay(),
                // chrome lives here (not inside the camera stack) so the
                // shutter stays reachable in EVERY state — including the idle
                // shutdown, where reviving the camera is the whole point.
                if (_cameraError == null)
                  Align(
                    alignment: Alignment.bottomCenter,
                    child: _chromeBar(),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Status strip above the video: link dot, stream state, target, server name.
  Widget _topStrip(BuildContext context) {
    final linkColor = switch (_link) {
      LensLinkState.connected => Colors.green,
      LensLinkState.connecting => Colors.orange,
      LensLinkState.disconnected => Colors.red,
    };
    final s = _server;
    return SafeArea(
      bottom: false,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(12, 6, 12, 6),
        color: const Color(0xEE101418),
        child: Row(
          children: [
            Icon(Icons.circle, size: 9, color: linkColor),
            const SizedBox(width: 6),
            Text(s == null ? '未配对' : (s.name), style: const TextStyle(fontSize: 12, color: Colors.white)),
            const SizedBox(width: 10),
            // persistent push-state icon: streaming vs paused-by-host
            Icon(
              _hostPaused ? Icons.pause_circle_outline : Icons.videocam,
              size: 14,
              color: _hostPaused ? Colors.white38 : Colors.green,
            ),
            const SizedBox(width: 4),
            Text(
              _hostPaused ? '预览暂停' : (_streaming ? '预览中' : '预览关'),
              style: TextStyle(fontSize: 11, color: _hostPaused ? Colors.white54 : Colors.white70),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                _hostPaused
                    ? '本设备仍可上传图片'
                    : _streaming
                        ? '预览中 ${_currentFps}fps'
                        : '预览已停止',
                style: const TextStyle(fontSize: 11, color: Colors.white70),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Show the live camera frame only when actually linked; otherwise a
  /// friendly "not connected" empty state with the dimmed illustration.
  Widget _previewOrEmpty() {
    if (_link != LensLinkState.connected) {
      // the badge floats over the empty state too — offline shots are exactly
      // when "what's waiting to upload" matters most
      return Stack(children: [_disconnectedEmpty(), _queueBadge()]);
    }
    if (cameraReadyCheck && _camera != null) {
      return _previewArea(_camera!);
    }
    // connected but camera still initialising
    return Stack(
      children: [
        const BackgroundArt(widthFactor: 0.4),
        const Center(child: CircularProgressIndicator(color: Colors.white54)),
      ],
    );
  }

  Widget _disconnectedEmpty() {
    final connecting = _link == LensLinkState.connecting;
    // token rejected (receiver device table reset) → the only way out is
    // re-pairing; generic network advice would send the user in circles
    if (_authFailed && !connecting) {
      return Stack(
        children: [
          const BackgroundArt(widthFactor: 0.45),
          Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.qr_code_scanner, color: Colors.white54, size: 42),
                  const SizedBox(height: 12),
                  const Text('配对已失效', style: TextStyle(color: Colors.white, fontSize: 16)),
                  const SizedBox(height: 10),
                  const Text(
                    '电脑端已不再识别本机(可能重装或重置过)。\n请重新扫码配对。',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.white54, fontSize: 12, height: 1.6),
                  ),
                  const SizedBox(height: 14),
                  FilledButton.icon(
                    icon: const Icon(Icons.qr_code_scanner, size: 18),
                    label: const Text('重新配对'),
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute(
                        builder: (_) => PairScreen(
                          store: widget.store,
                          // deviceId is REUSED now, so server.id stays the
                          // same and this screen does NOT rebuild on key
                          // change — rebind the socket manually with the
                          // fresh token
                          onPaired: () {
                            if (!mounted) return;
                            _socket?.close();
                            _socket = null;
                            _connectSocket();
                            setState(() {});
                          },
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      );
    }
    return Stack(
      children: [
        const BackgroundArt(widthFactor: 0.45),
        Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(connecting ? Icons.sync : Icons.link_off, color: Colors.white54, size: 42),
                const SizedBox(height: 12),
                Text(
                  connecting ? '正在连接电脑…' : '未连接电脑',
                  style: const TextStyle(color: Colors.white, fontSize: 16),
                ),
                const SizedBox(height: 10),
                const Text(
                  '请确认手机与电脑在同一局域网;\n可在 设置 → 连接与配对 中切换连接,或重启电脑端 dsh。',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white54, fontSize: 12, height: 1.6),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  /// Size of the full-bleed gesture layer over the preview (set by its
  /// LayoutBuilder on every build) — tap-to-focus normalizes against THIS,
  /// not the whole screen (top strip + chrome bar would skew Y).
  Size _gestureLayerSize = Size.zero;

  Future<void> _onFocusTap(CameraController c, Offset local) async {
    if (!widget.store.focusEnabled) return;
    final size = _gestureLayerSize.width > 0 ? _gestureLayerSize : MediaQuery.of(context).size;
    final nx = (local.dx / size.width).clamp(0.0, 1.0);
    final ny = (local.dy / size.height).clamp(0.0, 1.0);
    try {
      if (_focusLocked) await c.setFocusMode(FocusMode.auto); // unlock before re-focus
      await c.setFocusPoint(Offset(nx, ny));
    } catch (_) {}
    if (mounted) {
      setState(() {
        _focusLocal = local;
        _focusLocked = false;
        _showFocus = true;
      });
      _scheduleFocusHide();
    }
  }

  Future<void> _onFocusLock(CameraController c) async {
    if (!widget.store.focusEnabled) return;
    try {
      await c.setFocusMode(FocusMode.locked);
    } catch (_) {}
    if (mounted) {
      setState(() {
        _focusLocked = true;
        _showFocus = true;
      });
      _scheduleFocusHide();
    }
  }

  void _scheduleFocusHide() {
    _focusHideTimer?.cancel();
    _focusHideTimer = Timer(const Duration(milliseconds: 900), () {
      if (mounted) setState(() => _showFocus = false);
    });
  }

  Widget _focusIndicator() {
    if (_focusLocal == null || !_showFocus) return const SizedBox.shrink();
    return Positioned(
      left: _focusLocal!.dx - 22,
      top: _focusLocal!.dy - 22,
      child: Container(
        width: 44,
        height: 44,
        decoration: BoxDecoration(
          border: Border.all(color: _focusLocked ? Colors.amber : Colors.white, width: 2),
          borderRadius: BorderRadius.circular(8),
        ),
        child: _focusLocked ? const Icon(Icons.lock, color: Colors.amber, size: 18) : null,
      ),
    );
  }

  Widget _focusLockBanner() {
    return Positioned(
      top: 12,
      left: 12,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(6)),
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.lock, color: Colors.amber, size: 13),
            SizedBox(width: 4),
            Text('对焦锁定', style: TextStyle(color: Colors.white, fontSize: 11)),
          ],
        ),
      ),
    );
  }

  // ── pinch zoom + flash ─────────────────────────────────────────────────────

  /// Re-read the device zoom range after every camera open and re-apply the
  /// remembered ratio. Devices without zoom control (getMin/MaxZoomLevel
  /// throws) leave _zoomMin null → gestures and the pill stay hidden.
  Future<void> _applyZoomAfterInit(CameraController c) async {
    try {
      final min = await c.getMinZoomLevel();
      final max = await c.getMaxZoomLevel();
      if (!mounted) return;
      final z = _zoom.value.clamp(min, max);
      await c.setZoomLevel(z);
      if (!mounted) return;
      setState(() {
        _zoomMin = min;
        _zoomMax = max;
        _zoom.value = z;
      });
    } catch (_) {
      if (mounted) setState(() => _zoomMin = null);
    }
  }

  /// (Re-)apply the flash mode after every camera open: torch must come back
  /// after a revive, and auto/off must track the user's pick across the
  /// release/init cycles (backgrounding, covering routes, idle shutdown).
  Future<void> _applyFlash(CameraController c) async {
    try {
      await c.setFlashMode(_flash);
    } catch (_) {}
  }

  Future<void> _cycleFlash() async {
    final next = switch (_flash) {
      FlashMode.off => FlashMode.auto,
      FlashMode.auto => FlashMode.torch,
      _ => FlashMode.off,
    };
    setState(() => _flash = next);
    _touchCamera(); // toggling the light is camera activity
    final c = _camera;
    if (c != null) await _applyFlash(c);
  }

  void _onScaleStart(ScaleStartDetails d) {
    _scaleStartZoom = _zoom.value;
  }

  void _onScaleUpdate(ScaleUpdateDetails d) {
    final min = _zoomMin;
    final max = _zoomMax;
    final start = _scaleStartZoom;
    if (min == null || max == null || start == null) return;
    // scale stays exactly 1.0 for a single-finger drag — only a real pinch
    // (two pointers) may drive the zoom
    if (d.scale == 1.0 || d.pointerCount < 2) return;
    final z = (start * d.scale).clamp(min, max);
    if ((z - _zoom.value).abs() < 0.01) return;
    _zoom.value = z; // pill listens; no whole-screen setState on every tick
    _camera?.setZoomLevel(z).catchError((_) {});
  }

  /// Top-right flash toggle: off → auto → torch. Torch lights up amber.
  Widget _flashButton() {
    final torch = _flash == FlashMode.torch;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: _cycleFlash,
        child: Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: Colors.black54,
            border: Border.all(color: torch ? Colors.amber : Colors.white24),
          ),
          child: Icon(
            switch (_flash) { FlashMode.torch => Icons.flash_on, FlashMode.auto => Icons.flash_auto, _ => Icons.flash_off },
            size: 18,
            color: torch ? Colors.amber : Colors.white,
          ),
        ),
      ),
    );
  }

  /// Zoom ratio pill — hidden while at 1.0x (nothing to report), appears on
  /// the first pinch and reports the true (possibly optical) magnification.
  Widget _zoomPill() {
    return ValueListenableBuilder<double>(
      valueListenable: _zoom,
      builder: (_, z, __) {
        if (_zoomMin == null || z <= 1.01) return const SizedBox.shrink();
        return Container(
          margin: const EdgeInsets.only(top: 8),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(12)),
          child: Text(
            '${z.toStringAsFixed(1)}x',
            style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.bold),
          ),
        );
      },
    );
  }

  Widget _previewArea(CameraController c) {
    final ps = c.value.previewSize;
    final w = (ps?.width ?? 360).toDouble();
    final hh = (ps?.height ?? 640).toDouble();
    final shortSide = w < hh ? w : hh;
    final longSide = w < hh ? hh : w;
    final aspect = shortSide / longSide; // preview always portrait (not rotated)
    final zoomAvailable = _zoomMin != null;

    return Stack(
      fit: StackFit.expand,
      children: [
        // black letterbox bars come from the scaffold background
        Center(
          child: AspectRatio(
            aspectRatio: aspect,
            child: CameraPreview(c),
          ),
        ),
        // one gesture layer for tap-to-focus / long-press-lock / pinch-zoom:
        // the arena sorts them out (tap wins a still single finger, scale wins
        // a two-finger pinch, long-press wins a held finger). The LayoutBuilder
        // captures the layer's own size for focus-point normalization.
        if (widget.store.focusEnabled || zoomAvailable)
          Positioned.fill(
            child: LayoutBuilder(
              builder: (_, constraints) {
                _gestureLayerSize = constraints.biggest;
                return GestureDetector(
                  behavior: HitTestBehavior.translucent,
                  onTapUp: widget.store.focusEnabled ? (d) => _onFocusTap(c, d.localPosition) : null,
                  onLongPress: widget.store.focusEnabled ? () => _onFocusLock(c) : null,
                  onScaleStart: zoomAvailable ? _onScaleStart : null,
                  onScaleUpdate: zoomAvailable ? _onScaleUpdate : null,
                );
              },
            ),
          ),
        _focusIndicator(),
        // the lock banner is PERSISTENT while locked (user request): the 900ms
        // hide timer only owns the tap-focus indicator, not this badge — it
        // disappears when the lock is released (refocus tap clears _focusLocked)
        if (_focusLocked) _focusLockBanner(),
        // top-right column: queue badge → flash toggle → zoom pill, stacked
        // in ONE Positioned so the three never overlap each other
        Positioned(
          top: 12,
          right: 12,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            mainAxisSize: MainAxisSize.min,
            children: [
              _queueBadgeContent(),
              const SizedBox(height: 8),
              _flashButton(),
              _zoomPill(),
            ],
          ),
        ),
      ],
    );
  }

  /// Black veil for the idle shutdown, per spec: 主屏黑屏 + 提示文字. The
  /// wording follows who parked the camera (idle timer vs host request).
  Widget _autoClosedOverlay() {
    final title = _closedByHost ? '电脑端已关闭摄像头' : '长时间无操作,已关闭摄像头';
    return Positioned.fill(
      child: ColoredBox(
        color: Colors.black,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.videocam_off_outlined, color: Colors.white38, size: 42),
              const SizedBox(height: 12),
              Text(title, style: const TextStyle(color: Colors.white, fontSize: 16)),
              const SizedBox(height: 10),
              const Text(
                '点拍摄键或「启动预览」立即重新打开',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white54, fontSize: 12, height: 1.6),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Shutter bar (相册/裁剪/快门/启动预览/设为主机). Rendered OUTSIDE the camera
  /// stack, at the bottom of the viewfinder in every non-error state, so the
  /// camera can always be (re)started from where the user already is.
  Widget _chromeBar() {
    final shutter = _physLandscape ? 54.0 : 78.0;
    return Container(
      padding: EdgeInsets.symmetric(
        vertical: _physLandscape ? 6 : 14,
        horizontal: _physLandscape ? 12 : 18,
      ),
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Colors.transparent, Colors.black87],
        ),
      ),
      child: Row(
        mainAxisSize: _physLandscape ? MainAxisSize.min : MainAxisSize.max,
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          _chromeButton(
            compact: _physLandscape,
            rotate: _physLandscape,
            icon: Icons.photo_library_outlined,
            label: '相册',
            onTap: _pickFromGallery,
          ),
          _chromeButton(
            compact: _physLandscape,
            rotate: _physLandscape,
            icon: _cropBeforeSend ? Icons.crop : Icons.crop_free,
            label: _cropBeforeSend ? '裁剪:开' : '裁剪:关',
            onTap: () => setState(() => _cropBeforeSend = !_cropBeforeSend),
          ),
          GestureDetector(
            onTap: !_sending ? _shutterTap : null,
            child: Container(
              width: shutter,
              height: shutter,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: Colors.white, width: _physLandscape ? 3 : 4),
              ),
              child: Padding(
                padding: EdgeInsets.all(_physLandscape ? 4 : 6),
                child: _sending
                    ? const CircularProgressIndicator(color: Colors.white)
                    : Container(
                        decoration: const BoxDecoration(
                          shape: BoxShape.circle,
                          color: Colors.white,
                        ),
                      ),
              ),
            ),
          ),
          _chromeButton(
            compact: _physLandscape,
            rotate: _physLandscape,
            icon: _streaming ? Icons.videocam : Icons.videocam_off_outlined,
            label: _streaming ? '停止预览' : '启动预览',
            onTap: _previewTap,
          ),
          _chromeButton(
            compact: _physLandscape,
            rotate: _physLandscape,
            icon: Icons.cast_connected,
            label: '设为主机',
            onTap: _socket != null ? _makeMainTap : null,
          ),
        ],
      ),
    );
  }

  Widget _chromeButton({required IconData icon, required String label, VoidCallback? onTap, bool compact = false, bool rotate = false}) {
    final content = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton(
          onPressed: onTap,
          visualDensity: compact ? VisualDensity.compact : null,
          icon: Icon(icon, color: Colors.white, size: compact ? 20 : 26),
        ),
        Text(label, style: TextStyle(fontSize: compact ? 10 : 11, color: Colors.white70)),
      ],
    );
    return Opacity(
      opacity: onTap == null ? 0.45 : 1,
      child: rotate ? RotatedBox(quarterTurns: _physLeanLeft ? 1 : 3, child: content) : content,
    );
  }
}

Uint8List _fit(_FitArgs args) => fitJpegBytes(args.bytes, args.maxBytes, args.maxDim);

class _FitArgs {
  final Uint8List bytes;
  final int maxBytes;
  final int maxDim;
  _FitArgs(this.bytes, this.maxBytes, this.maxDim);
}

Uint8List _normalize(_NormArgs args) =>
    normalizeJpegBytes(args.bytes, args.maxBytes, args.maxDim, args.startQuality);

class _NormArgs {
  final Uint8List bytes;
  final int maxBytes;
  final int maxDim;
  final int startQuality;
  const _NormArgs(this.bytes, this.maxBytes, this.maxDim, this.startQuality);
}

/// Bake a photo to the orientation the viewfinder showed. [clockwise] is the
/// extra clockwise spin (see _streamRotation); 0 returns the bytes untouched
/// so the common upright case pays no re-encode.
Uint8List _rotateJpeg(_RotateArgs args) {
  final decoded = img.decodeImage(args.bytes);
  if (decoded == null) return args.bytes;
  var baked = img.bakeOrientation(decoded);
  if (args.clockwise != 0) {
    baked = img.copyRotate(baked, angle: args.clockwise);
  }
  return Uint8List.fromList(img.encodeJpg(baked, quality: 92));
}

class _RotateArgs {
  final Uint8List bytes;
  final int clockwise;
  const _RotateArgs(this.bytes, this.clockwise);
}

/// Small translucent confirmation banner at the top of the screen; auto-hides
/// after ~1.5s. Never covers the shutter chrome like a bottom SnackBar did.
class TopToast extends StatefulWidget {
  final String text;
  const TopToast(this.text, {super.key});
  @override
  State<TopToast> createState() => _TopToastState();
}

class _TopToastState extends State<TopToast> {
  double _opacity = 0;
  @override
  void initState() {
    super.initState();
    // fade in; the entry is removed by the caller after a delay
    WidgetsBinding.instance.addPostFrameCallback((_) => setState(() => _opacity = 1));
  }

  @override
  Widget build(BuildContext context) {
    return Positioned(
      top: MediaQuery.of(context).padding.top + 12,
      left: 0,
      right: 0,
      child: IgnorePointer(
        child: Center(
          child: AnimatedOpacity(
            opacity: _opacity,
            duration: const Duration(milliseconds: 220),
            child: Material(
              color: Colors.black54,
              borderRadius: BorderRadius.circular(20),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                child: Text(
                  widget.text,
                  style: const TextStyle(color: Colors.white, fontSize: 13),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
