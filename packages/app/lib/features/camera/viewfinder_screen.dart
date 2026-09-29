import 'dart:async';
import 'dart:io';

import 'package:camera/camera.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:image/image.dart' as img;
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:sensors_plus/sensors_plus.dart';

import '../../core/api.dart';
import '../../core/camera_socket.dart';
import '../../core/jpeg.dart';
import '../../core/preview_encoder.dart';
import '../../core/routes.dart';
import '../../core/global_link.dart';
import '../../ui/background_art.dart';
import '../pair/pair_screen.dart';
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
  // focus interaction (opt-in; pure mode = no focus UI/gestures)
  Offset? _focusLocal;
  bool _focusLocked = false;
  bool _showFocus = false;
  Timer? _focusHideTimer;
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

  PairedServer? get _server => widget.store.server;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _initCamera();
    _connectSocket();
    _initOrientation();
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
          if (_streaming) {
            final camera = _camera;
            if (camera != null && camera.value.isInitialized) {
              final ps = camera.value.previewSize;
              _socket?.sendHello(
                ps?.width.round() ?? 1280,
                ps?.height.round() ?? 720,
                widget.store.previewParams['fps'] ?? 10,
                _streamRotation(),
              );
            }
          }
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
  void didPopNext() => _initCamera();

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Free the camera when backgrounded; reacquire on resume.
    if (state == AppLifecycleState.inactive) {
      _releaseCamera();
    } else if (state == AppLifecycleState.resumed) {
      _initCamera();
    }
  }

  @override
  void didChangeMetrics() {
    // Screen rotated: rebuild the local preview aspect AND re-announce the
    // rotation so the PC-side canvas flips along with the phone (the hello
    // handshake is the only channel that reports orientation).
    if (!mounted) return;
    setState(() {});
    final camera = _camera;
    if (_streaming && camera != null && camera.value.isInitialized) {
      final ps = camera.value.previewSize;
      _socket?.sendHello(
        ps?.width.round() ?? 1280,
        ps?.height.round() ?? 720,
        widget.store.previewParams['fps'] ?? 10,
        _streamRotation(),
      );
    }
  }

  bool _cameraInitBusy = false;
  bool _cameraInitPending = false;
  // Camera epoch: bumped by every release; an init whose epoch is superseded
  // must dispose its controller instead of assigning it (covers "release ran
  // while initialize() was in flight" — camera under a covering route).
  int _cameraGen = 0;
  Future<void>? _cameraDisposing;
  /// True when the stream delivers plugin-encoded JPEG frames directly
  /// (color-correct by construction — no hand-rolled YUV assembly).
  bool _jpegStreamMode = false;

  Future<void> _initCamera() async {
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
        }
        setState(() {
          _camera = controller;
          _cameraReady = true;
          _cameraError = null;
          _jpegStreamMode = jpeg;
        });
        debugPrint('[lens-mate] camera stream mode: yuv420(hand-assembled) — jpeg stream delivers no frames on this device');
        // preview streaming defaults ON — it's a framing aid, not a video
        // upload; users turn it off explicitly when they want to.
        // A host-paused phone must NOT resume by itself (multi-device rule).
        if (!_streaming && !_hostPaused) _toggleStream();
      } catch (e) {
        debugPrint('[lens-mate] camera init failed: $e');
        if (mounted) setState(() => _cameraError = '相机初始化失败,请检查相机权限未被占用后重试');
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

  bool _authProbeDone = false; // one 401 probe per link lifetime
  bool _authFailed = false; // receiver no longer knows our token

  void _connectSocket() {
    final s = _server;
    if (s == null) return;
    _authProbeDone = false;
    _authFailed = false;
    final socket = CameraSocket(
      'ws://${s.host}:${s.port}/ws/camera?deviceId=${s.deviceId}&token=${s.token}',
    );
    _socket = socket;
    socket.states.listen((st) {
      globalLink.value = st; // share with settings list
      if (mounted) setState(() => _link = st);
      if (st == LensLinkState.connected) {
        _reconnectStreak = 0;
        _authProbeDone = false;
        _authFailed = false;
      } else if (st == LensLinkState.disconnected) {
        _reconnectStreak++;
        _maybeProbeAuth();
        // Auto-select when the current receiver drops and autoSelect is on.
        if (widget.store.autoSelect) _autoSelectAvailable();
      }
    });
    socket.onPreviewState = (active) => _onHostPreviewState(active);
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

  void _onRemoteShutter(CaptureCommand cmd) {
    if (_sending) {
      _socket?.reportCapture(cmd.captureId, 'declined', 'busy');
      return;
    }
    _shoot(captureId: cmd.captureId, note: cmd.note);
  }

  /// Make THIS phone the active preview/shutter device: tell the host to
  /// switch the PC preview to us (it pauses every other phone), and make sure
  /// our own preview stream is running.
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
    _toast('已设为主机,电脑端预览已切换为本机');
  }

  Future<void> _toggleStream() async {
    if (_streaming) {
      await _stopStream();
    } else {
      await _startStream();
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
    final ps = camera.value.previewSize;
    _socket?.sendHello(
      ps?.width.round() ?? 1280,
      ps?.height.round() ?? 720,
      widget.store.previewParams['fps'] ?? 10,
      _streamRotation(),
    );
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
      await _stopStream();
      if (!mounted) return;
      // reconnect handshakes re-send pause — only surface it once
      if (_hostPaused) return;
      setState(() => _hostPaused = true);
      _longToast('其他设备正在使用电脑端预览;本机仍可正常上传图片');
    } else {
      if (mounted) setState(() => _hostPaused = false);
      if (cameraReadyCheck) await _startStream(); // resume seamlessly
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
    final snap = copyYuv420(image, swapChroma: widget.store.chromaSwap);
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
    final s = _server;
    // disconnected → meaningful warning, not "camera failed"
    if (_link != LensLinkState.connected) {
      _toast('未连接电脑');
      if (captureId != null) _socket?.reportCapture(captureId, 'failed', 'not connected');
      return;
    }
    if (camera == null || s == null || !cameraReadyCheck) {
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
    setState(() => _sending = true);
    try {
      final file = await camera.takePicture();
      var bytes = await File(file.path).readAsBytes();
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
      await _send(s, bytes: bytes, name: _shotName(), captureId: captureId, note: note);
    } catch (e) {
      _toast('拍摄失败');
      if (captureId != null) _socket?.reportCapture(captureId, 'failed', e.toString());
    } finally {
      _lastSendAt = DateTime.now().millisecondsSinceEpoch;
      if (mounted) setState(() => _sending = false);
    }
  }

  String _shotName() {
    final t = DateTime.now();
    String two(int n) => n.toString().padLeft(2, '0');
    return 'shot_${t.year}${two(t.month)}${two(t.day)}_${two(t.hour)}${two(t.minute)}${two(t.second)}.jpg';
  }

  /// Pick one or more images from the gallery and upload them.
  ///
  /// - Crop mode ON: a single continuous session — each image is cropped, then
  ///   uploaded behind a blocking overlay, then the next one is loaded
  ///   in-place (never bouncing back to the viewfinder). The ✕ discards all
  ///   remaining images.
  /// - Crop mode OFF: all images are sent directly as a batch.
  Future<void> _pickFromGallery() async {
    final s = _server;
    if (s == null) return;
    if (_link == LensLinkState.disconnected) {
      _toast('未连接电脑');
      return;
    }
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
      final uploaded = await Navigator.of(context).push<int>(
        MaterialPageRoute(
          builder: (_) => CropScreen(
            bytes: batchBytes.first,
            batch: batchBytes,
            batchNames: batchNames,
            // silent: per-item toasts would fight the crop screen's overlay;
            // the final pop returns the success count
            onBatchUpload: (b, name) => _send(s, bytes: b, name: name, captureId: null, note: null, silent: true),
            defaultCropRatio: widget.store.defaultCropRatio,
            handleSize: widget.store.handleSize,
          ),
        ),
      );
      if (uploaded != null && uploaded > 0) _toast('已批量上传 $uploaded 张');
      return;
    }

    // Crop OFF: plain batch upload. Serial, per-item failures counted (not
    // silently swelling the total); a RATE_LIMITED item waits out the
    // receiver's per-minute window once, then retries.
    var okCount = 0;
    for (final f in files) {
      if (!mounted) return;
      var bytes = await f.readAsBytes();
      if (bytes.length > maxBytes) bytes = await compute(_fit, _FitArgs(bytes, maxBytes, 4096));
      var receipt = await _sendOne(s, bytes: bytes, name: _galleryName(f.name), captureId: null, note: null);
      if (!receipt.ok && receipt.errorCode == 'RATE_LIMITED') {
        _longToast('达到电脑端每分钟上传上限,稍候自动续传…');
        await Future<void>.delayed(const Duration(seconds: 61));
        if (!mounted) return;
        receipt = await _sendOne(s, bytes: bytes, name: _galleryName(f.name), captureId: null, note: null);
      }
      if (receipt.ok) okCount++;
    }
    if (!mounted) return;
    if (okCount == files.length) {
      _toast('已批量上传 $okCount 张');
    } else {
      _longToast('已上传 $okCount/${files.length} 张,失败 ${files.length - okCount} 张(详见历史)');
    }
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

  /// Declare the format from magic bytes, not the file extension — the
  /// receiver validates the declared content-type against the actual byte
  /// header, so a PNG gallery shot declared as jpeg fails 415 every time.
  String _sniffMediaType(Uint8List bytes) {
    if (bytes.length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF) return 'image/jpeg';
    if (bytes.length >= 4 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47) {
      return 'image/png';
    }
    return 'image/jpeg'; // unknown formats: let the receiver's check reject them
  }

  /// Core upload + history bookkeeping; NEVER throws (network-level errors
  /// become a failed receipt so history rows and capture receipts still land).
  Future<UploadReceipt> _sendOne(PairedServer s,
      {required Uint8List bytes, required String name, String? captureId, String? note}) async {
    UploadReceipt receipt;
    try {
      receipt = await _api.upload(
        s,
        bytes: bytes,
        mediaType: _sniffMediaType(bytes),
        name: name,
        note: note,
        captureId: captureId,
      );
    } catch (e) {
      debugPrint('[lens-mate] upload error: $e');
      receipt = UploadReceipt(ok: false, errorCode: 'NETWORK_ERROR');
    }
    // history per user mode: noTrace skips the record entirely
    final mode = widget.store.historyMode;
    if (mode != LensStore.historyNoTrace) {
      String? imagePath;
      if (mode == LensStore.historyKeepImage) {
        try {
          final dir = await getApplicationDocumentsDirectory();
          final file = File('${dir.path}/history/${DateTime.now().millisecondsSinceEpoch}_$name');
          await file.create(recursive: true);
          await file.writeAsBytes(bytes);
          imagePath = file.path;
        } catch (_) {
          imagePath = null; // archive failure must not lose the history row
        }
      }
      await widget.store.addHistory({
        'at': DateTime.now().toIso8601String(),
        'name': name,
        'bytes': bytes.length,
        'ok': receipt.ok,
        'attachmentId': receipt.attachmentId,
        'reason': receipt.reason,
        'errorCode': receipt.errorCode,
        'captureId': captureId,
        'server': s.name,
        'imagePath': imagePath,
      });
    }
    // report the TRUTH: a failed upload is 'failed', never 'taken'
    if (captureId != null) {
      _socket?.reportCapture(captureId, receipt.ok ? 'taken' : 'failed', receipt.ok ? null : receipt.errorCode);
    }
    return receipt;
  }

  Future<void> _send(PairedServer s,
      {required Uint8List bytes, required String name, String? captureId, String? note, bool silent = false}) async {
    final receipt = await _sendOne(s, bytes: bytes, name: name, captureId: captureId, note: note);
    if (!mounted || silent) return;
    // The toast must match the receiver's actual capture mode (v0.3.7):
    // composer-only / composer+folder / folder-only say different things.
    _toast(_sendToastText(receipt));
  }

  String _sendToastText(UploadReceipt r) {
    if (!r.ok) return '发送失败(${_uploadErrorText(r.errorCode)})';
    switch (r.reason) {
      case 'saved-to-folder':
        return '已保存到电脑文件夹';
      case 'saved-and-staged':
        return '已放入电脑输入框,并存到电脑文件夹';
      default: // 'staged-in-composer' / unknown → the classic promise
        return '已放入电脑输入框';
    }
  }

  String _uploadErrorText(String code) {
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

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    routeObserver.unsubscribe(this);
    _accelSub?.cancel();
    _cmdSub?.cancel();
    _fpsTimer?.cancel();
    _focusHideTimer?.cancel();
    // a toast mid-flight would otherwise linger on the next screen forever
    _toastEntry?.remove();
    _toastEntry = null;
    _socket?.close();
    _encoder.stop();
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
            child: _cameraError != null
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
      return _disconnectedEmpty();
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
                  '请确认手机与电脑在同一局域网;\n可在 设置 → 配对与设备 中切换连接,或长按电源重启电脑端 dsh。',
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

  Future<void> _onFocusTap(CameraController c, Offset local) async {
    if (!widget.store.focusEnabled) return;
    final size = MediaQuery.of(context).size;
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

  /// Full-ratio preview (contain — never cropped, WYSIWYG). The preview frame
  /// stays PORTRAIT regardless of how the phone is held (it doesn't rotate with
  /// the device); only the shutter bar flips 90° to the side the phone is held
  /// toward, so the controls are natural when griped sideways. The PC rotation
  /// is driven by the sensor, so it's independent of system auto-rotate.
  Widget _previewArea(CameraController c) {
    final ps = c.value.previewSize;
    final w = (ps?.width ?? 360).toDouble();
    final hh = (ps?.height ?? 640).toDouble();
    final shortSide = w < hh ? w : hh;
    final longSide = w < hh ? hh : w;
    final aspect = shortSide / longSide; // preview always portrait (not rotated)
    final shutter = _physLandscape ? 54.0 : 78.0;

    final chrome = Container(
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
            onTap: cameraReadyCheck && !_sending ? () => _shoot() : null,
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
            onTap: cameraReadyCheck ? _toggleStream : null,
          ),
          _chromeButton(
            compact: _physLandscape,
            rotate: _physLandscape,
            icon: Icons.cast_connected,
            label: '设为主机',
            onTap: _socket != null && cameraReadyCheck ? _makeMain : null,
          ),
        ],
      ),
    );

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
        if (widget.store.focusEnabled)
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.translucent,
              onTapUp: (d) => _onFocusTap(c, d.localPosition),
              onLongPress: () => _onFocusLock(c),
            ),
          ),
        _focusIndicator(),
        if (_focusLocked && _showFocus) _focusLockBanner(),
        // shutter chrome stays on the bottom; when held sideways only the
        // individual controls rotate 90° (labels stay readable toward the grip)
        Align(
          alignment: Alignment.bottomCenter,
          child: chrome,
        ),
      ],
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
