import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// One paired receiver (one PC). Each record carries its own device identity
/// + token issued by that receiver; exactly one record is active at a time.
class PairedServer {
  /// Unique record id (the deviceId issued at pairing time).
  final String id;
  /// User-editable display name (defaults to "host:port").
  String name;
  String host;
  int port;
  String deviceId;
  String deviceName;
  String deviceModel;
  String token;
  String get baseUrl => 'http://$host:$port';

  PairedServer({
    required this.id,
    required this.name,
    required this.host,
    required this.port,
    required this.deviceId,
    required this.deviceName,
    required this.deviceModel,
    required this.token,
  });

  Map<String, String> get authHeaders => {
        'X-LM-Device': deviceId,
        'X-LM-Token': token,
      };

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'host': host,
        'port': port,
        'deviceId': deviceId,
        'deviceName': deviceName,
        'deviceModel': deviceModel,
        'token': token,
      };

  static PairedServer? fromJson(Map<String, dynamic>? json) {
    if (json == null) return null;
    final host = json['host'];
    final token = json['token'];
    if (host is! String || token is! String) return null;
    final port = (json['port'] as num?)?.toInt() ?? 8791;
    final deviceId = json['deviceId'] as String? ?? '';
    return PairedServer(
      id: json['id'] as String? ?? deviceId,
      name: json['name'] as String? ?? '$host:$port',
      host: host,
      port: port,
      deviceId: deviceId,
      deviceName: json['deviceName'] as String? ?? 'phone',
      deviceModel: json['deviceModel'] as String? ?? '',
      token: token,
    );
  }
}

class PairResult {
  final PairedServer server;
  final PreviewParams preview;
  final int maxUploadBytes;
  PairResult(this.server, this.preview, this.maxUploadBytes);
}

class PreviewParams {
  final int maxWidth;
  final int maxHeight;
  final int fps;
  final int jpegQuality;
  PreviewParams(this.maxWidth, this.maxHeight, this.fps, this.jpegQuality);
}

class UploadReceipt {
  final bool ok;
  final String? attachmentId;
  final String? deliveredSessionId;
  final String? reason;
  final String errorCode;
  UploadReceipt({
    required this.ok,
    this.attachmentId,
    this.deliveredSessionId,
    this.reason,
    this.errorCode = '',
  });
}

class LensApi {
  final http.Client _http = http.Client();

  /// Pair with a receiver using the one-shot code from the QR payload.
  Future<PairResult> pair({
    required String host,
    required int port,
    required String code,
    required String deviceId,
    required String deviceName,
    required String deviceModel,
  }) async {
    final resp = await _http
        .post(
          Uri.parse('http://$host:$port/pair'),
          headers: {'content-type': 'application/json'},
          body: jsonEncode({
            'code': code,
            'device': {'id': deviceId, 'name': deviceName, 'model': deviceModel},
          }),
        )
        .timeout(const Duration(seconds: 8));
    // Decode AFTER the status check — wrong-port services answer with HTML
    // error pages, and a raw FormatException must not leak to the UI.
    Map<String, dynamic> body;
    try {
      body = jsonDecode(resp.body) as Map<String, dynamic>;
    } catch (_) {
      throw LensApiError('PAIR_FAILED', 'HTTP ${resp.statusCode}: 该地址不是有效的配对服务');
    }
    if (resp.statusCode != 200) {
      final err = body['error'] as Map<String, dynamic>?;
      throw LensApiError(err?['code'] as String? ?? 'PAIR_FAILED', err?['message'] as String? ?? 'pairing failed');
    }
    final info = (body['serverInfo'] as Map<String, dynamic>?) ?? const {};
    final preview = (info['preview'] as Map<String, dynamic>?) ?? const {};
    final limits = (info['limits'] as Map<String, dynamic>?) ?? const {};
    return PairResult(
      PairedServer(
        id: deviceId,
        name: '$host:$port',
        host: host,
        port: port,
        deviceId: deviceId,
        deviceName: deviceName,
        deviceModel: deviceModel,
        token: body['token'] as String,
      ),
      PreviewParams(
        (preview['maxWidth'] as num?)?.toInt() ?? 854,
        (preview['maxHeight'] as num?)?.toInt() ?? 480,
        (preview['fps'] as num?)?.toInt() ?? 10,
        (preview['jpegQuality'] as num?)?.toInt() ?? 70,
      ),
      (limits['maxUploadBytes'] as num?)?.toInt() ?? 10 * 1024 * 1024,
    );
  }

  /// Upload one image; returns the receiver's receipt.
  Future<UploadReceipt> upload(
    PairedServer server, {
    required Uint8List bytes,
    required String mediaType,
    required String name,
    String? note,
    String? captureId,
    /// Idempotency key: the receiver replays the original receipt for a
    /// repeated [uploadId], so queue retries never double-store.
    String? uploadId,
    http.Client? client,
  }) async {
    final uri = Uri.parse('${server.baseUrl}/upload').replace(queryParameters: {
      'name': name,
      if (note?.isNotEmpty == true) 'note': note!,
      if (captureId != null) 'captureId': captureId,
      if (uploadId != null) 'uploadId': uploadId,
    });
    final resp = await (client ?? _http)
        .post(
          uri,
          headers: {'content-type': mediaType, ...server.authHeaders},
          body: bytes,
        )
        .timeout(const Duration(seconds: 30));
    Map<String, dynamic> body;
    try {
      body = jsonDecode(resp.body) as Map<String, dynamic>;
    } catch (_) {
      // non-JSON error page (reverse proxy 502 HTML, …) — surface the status
      return UploadReceipt(ok: false, errorCode: 'HTTP_${resp.statusCode}');
    }
    if (resp.statusCode != 200) {
      final err = body['error'] as Map<String, dynamic>?;
      return UploadReceipt(ok: false, reason: err?['message'] as String?, errorCode: err?['code'] as String? ?? 'UPLOAD_FAILED');
    }
    final delivered = body['delivered'] as Map<String, dynamic>?;
    return UploadReceipt(
      ok: true,
      attachmentId: body['attachmentId'] as String?,
      deliveredSessionId: delivered?['sessionId'] as String?,
      reason: body['deliverReason'] as String?,
      errorCode: '',
    );
  }

  Future<Map<String, dynamic>> status(PairedServer server) async {
    final resp = await _http
        .get(Uri.parse('${server.baseUrl}/status'), headers: server.authHeaders)
        .timeout(const Duration(seconds: 5));
    if (resp.statusCode != 200) {
      final body = jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>;
      final err = body['error'] as Map<String, dynamic>?;
      throw LensApiError(err?['code'] as String? ?? 'STATUS_FAILED', err?['message'] as String? ?? 'status failed');
    }
    return jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>;
  }

  /// Reachability probe: true only when the receiver answers an AUTHED
  /// request — a stored token that the receiver no longer recognizes
  /// (devices.json reset) must not read as "available" for auto-switch.
  Future<bool> reachable(PairedServer server) async {
    try {
      final resp = await _http
          .get(Uri.parse('${server.baseUrl}/status'), headers: server.authHeaders)
          .timeout(const Duration(seconds: 3));
      return resp.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  void dispose() => _http.close();
}

class LensApiError implements Exception {
  final String code;
  final String message;
  LensApiError(this.code, this.message);
  @override
  String toString() => '[$code] $message';
}

/// Device-local persistence: multiple paired receivers (one active),
/// chosen target session, send history.
class LensStore {
  static const _kServers = 'lens.servers';
  static const _kActive = 'lens.activeServer';
  static const _kLegacyServer = 'lens.server';
  static const _kHistory = 'lens.history';
  static const _kPreview = 'lens.preview';
  static const _kPreviewParams = 'lens.previewParams';
  static const _kHistoryMode = 'lens.historyMode';
  static const _kCropRatio = 'lens.cropRatio';
  static const _kHandleSize = 'lens.handleSize';
  static const _kFocusEnabled = 'lens.focusEnabled';
  static const _kAutoSelect = 'lens.autoSelect';
  static const _kDeviceId = 'lens.deviceId';
  static const _kDeviceName = 'lens.deviceName';
  static const _kLimits = 'lens.limits';
  static const _kUploadQuality = 'lens.uploadQuality';

  // Upload quality presets (Settings → 上传). "high" keeps the original
  // camera bytes; medium/low always re-encode to a bounded width.
  static const qualityHigh = 'high';
  static const qualityMedium = 'medium';
  static const qualityLow = 'low';

  /// Fresh installs default to medium (volume ≈ 1/3 of the original at
  /// near-lossless quality). An EXPLICIT choice — including high — is
  /// honoured forever once written to prefs.
  String get uploadQuality {
    final v = _prefs.getString(_kUploadQuality);
    if (v != null && (v == qualityHigh || v == qualityMedium || v == qualityLow)) return v;
    return qualityMedium;
  }

  Future<void> setUploadQuality(String v) => _prefs.setString(_kUploadQuality, v);

  /// Last automatic update-check epoch ms (24h throttle for the startup check;
  /// manual checks from Settings bypass it).
  static const _kLastUpdateCheck = 'lens.lastUpdateCheckAt';
  int get lastUpdateCheckAt => _prefs.getInt(_kLastUpdateCheck) ?? 0;
  Future<void> setLastUpdateCheckAt(int v) => _prefs.setInt(_kLastUpdateCheck, v);

  /// Stable device identity: REUSED across pairings so re-pairing the same
  /// PC refreshes the token on the SAME host-side device record instead of
  /// accumulating a new one per scan.
  String get deviceId => _prefs.getString(_kDeviceId) ?? '';
  Future<void> setDeviceId(String v) => _prefs.setString(_kDeviceId, v);

  String get deviceName => _prefs.getString(_kDeviceName) ?? 'phone';
  Future<void> setDeviceName(String v) => _prefs.setString(_kDeviceName, v);

  /// Upload limit last advertised by the active receiver (serverInfo).
  int get maxUploadBytes => _limits()?['maxUploadBytes'] ?? 10 * 1024 * 1024;

  Map<String, int>? _limits() {
    final raw = decode(_prefs.getString(_kLimits));
    if (raw == null) return null;
    return {
      if (raw['maxUploadBytes'] != null) 'maxUploadBytes': (raw['maxUploadBytes'] as num).toInt(),
    };
  }

  Future<void> saveLimits(int maxUploadBytes) => _prefs.setString(_kLimits, jsonEncode({
        'maxUploadBytes': maxUploadBytes,
      }));

  /// Tap-to-focus + long-press lock on the viewfinder. Off by default (pure
  /// mode: no focus interaction, plain auto-focus).
  bool get focusEnabled => _prefs.getBool(_kFocusEnabled) ?? false;
  Future<void> setFocusEnabled(bool v) => _prefs.setBool(_kFocusEnabled, v);

  /// Auto-select an available paired receiver when the current one becomes
  /// unreachable. Off by default; the user opts in from Settings.
  bool get autoSelect => _prefs.getBool(_kAutoSelect) ?? false;
  Future<void> setAutoSelect(bool v) => _prefs.setBool(_kAutoSelect, v);

  /// Default crop frame = a box of this fraction of the image, centered
  /// (0.5 → the middle half). Configurable from Settings.
  double get defaultCropRatio => (_prefs.getDouble(_kCropRatio) ?? 0.5).clamp(0.2, 0.9);
  Future<void> setDefaultCropRatio(double v) => _prefs.setDouble(_kCropRatio, v.clamp(0.2, 0.9));

  /// Crop-frame corner-handle size in px (visual + grab radius).
  double get handleSize => (_prefs.getDouble(_kHandleSize) ?? 14).clamp(10, 22);
  Future<void> setHandleSize(double v) => _prefs.setDouble(_kHandleSize, v.clamp(10, 22));

  // ── camera idle auto-off (heat management) ────────────────────────────────
  // Minutes without a capture before the viewfinder shuts the camera (and the
  // preview stream) down. 0 = never; the viewfinder re-opens on the next
  // shutter / 启动预览 tap.
  static const _kCameraIdleMin = 'lens.cameraIdleTimeoutMin';
  int get cameraIdleTimeoutMin => _prefs.getInt(_kCameraIdleMin) ?? 5;
  Future<void> setCameraIdleTimeoutMin(int v) => _prefs.setInt(_kCameraIdleMin, v);

  // ── update availability (startup check result → Settings amber badge) ────
  static const _kUpdateAvailable = 'lens.updateAvailable';
  bool get updateAvailable => _prefs.getBool(_kUpdateAvailable) ?? false;
  Future<void> setUpdateAvailable(bool v) => _prefs.setBool(_kUpdateAvailable, v);

  // ── history auto-clean ────────────────────────────────────────────────────
  // Periodic wipe of send history (records + archived images). Pairing and
  // connection memories are NEVER touched — only the lens.history blob.
  static const _kHistoryAutoClean = 'lens.historyAutoClean';
  static const _kHistoryLastCleanAt = 'lens.historyLastCleanAt';
  static const historyCleanOff = 'off';
  static const historyCleanStartup = 'startup';
  static const historyCleanDaily = 'daily';
  static const historyCleanWeekly = 'weekly';
  static const historyCleanMonthly = 'monthly';
  String get historyAutoClean => _prefs.getString(_kHistoryAutoClean) ?? historyCleanOff;

  /// Persist the mode; periodic modes start counting from NOW so the first
  /// wipe lands one full period later (not instantly).
  Future<void> setHistoryAutoClean(String v) async {
    await _prefs.setString(_kHistoryAutoClean, v);
    if (v != historyCleanOff) {
      await _prefs.setInt(_kHistoryLastCleanAt, DateTime.now().millisecondsSinceEpoch);
    }
  }

  int get historyLastCleanAt => _prefs.getInt(_kHistoryLastCleanAt) ?? 0;
  Future<void> setHistoryLastCleanAt(int v) => _prefs.setInt(_kHistoryLastCleanAt, v);

  /// Run at app start: wipe send history when the selected period is due.
  Future<void> maybeAutoCleanHistory() async {
    final mode = historyAutoClean;
    if (mode == historyCleanOff) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    var due = mode == historyCleanStartup;
    if (!due) {
      const day = 24 * 60 * 60 * 1000;
      final interval = switch (mode) {
        historyCleanDaily => day,
        historyCleanWeekly => 7 * day,
        historyCleanMonthly => 30 * day,
        _ => 0,
      };
      due = interval > 0 && now - historyLastCleanAt >= interval;
    }
    if (!due) return;
    await clearHistory();
    await setHistoryLastCleanAt(now);
  }

  final SharedPreferences _prefs;
  LensStore(this._prefs) {
    _migrateLegacy();
    // the chroma-swap toggle was removed with the color-correction feature;
    // clear the stale key so prefs don't carry dead state forever
    _prefs.remove('lens.chromaSwap');
  }

  // ── paired receivers ────────────────────────────────────────────────────

  List<PairedServer> servers() {
    final raw = _prefs.getString(_kServers);
    if (raw == null || raw.isEmpty) return [];
    try {
      final list = jsonDecode(raw) as List;
      return list
          .map((e) => PairedServer.fromJson(Map<String, dynamic>.from(e as Map)))
          .whereType<PairedServer>()
          .toList();
    } catch (_) {
      return [];
    }
  }

  PairedServer? get server {
    final active = _prefs.getString(_kActive);
    final all = servers();
    return all.firstWhereOrNull((s) => s.id == active) ?? (all.isNotEmpty ? all.first : null);
  }

  /// Register a freshly paired receiver and make it active. Records for the
  /// same host:port are replaced — re-pairing must not pile up dead-token
  /// duplicates of the same PC.
  Future<void> addServer(PairedServer s) async {
    final all = servers()
      ..removeWhere((x) => x.id == s.id || (x.host == s.host && x.port == s.port));
    all.add(s);
    await _prefs.setString(_kServers, jsonEncode(all.map((e) => e.toJson()).toList()));
    await _prefs.setString(_kActive, s.id);
  }

  Future<void> removeServer(String id) async {
    final all = servers()..removeWhere((s) => s.id == id);
    await _prefs.setString(_kServers, jsonEncode(all.map((e) => e.toJson()).toList()));
    if (_prefs.getString(_kActive) == id) {
      await _prefs.setString(_kActive, all.isNotEmpty ? all.first.id : '');
    }
  }

  Future<void> renameServer(String id, String name) async {
    final all = servers();
    for (final s in all) {
      if (s.id == id) s.name = name;
    }
    await _prefs.setString(_kServers, jsonEncode(all.map((e) => e.toJson()).toList()));
  }

  Future<void> setActive(String id) => _prefs.setString(_kActive, id);

  /// Legacy single-server key → list + active pointer.
  void _migrateLegacy() {
    if (_prefs.containsKey(_kServers)) return;
    final legacy = PairedServer.fromJson(decode(_prefs.getString(_kLegacyServer)));
    if (legacy == null) return;
    _prefs.setString(_kServers, jsonEncode([legacy.toJson()]));
    _prefs.setString(_kActive, legacy.id);
    _prefs.remove(_kLegacyServer);
  }

  // ── preview overrides / history ─────────────────────────────────────────

  Map<String, dynamic>? get previewOverrides => decode(_prefs.getString(_kPreview));
  Future<void> setPreviewOverride(String key, int value) async {
    final map = decode(_prefs.getString(_kPreview)) ?? <String, dynamic>{};
    map[key] = value;
    await _prefs.setString(_kPreview, jsonEncode(map));
  }

  // Preview parameters last advertised by the active receiver (serverInfo).
  // Fallbacks mirror the host's own defaults (config.ts) so a missing field
  // degrades to the same values the receiver would have sent.
  Map<String, int> get previewParams {
    final raw = decode(_prefs.getString(_kPreviewParams));
    return {
      'maxShort': (raw?['maxShort'] as num?)?.toInt() ?? 480,
      'maxLong': (raw?['maxLong'] as num?)?.toInt() ?? 854,
      'fps': (raw?['fps'] as num?)?.toInt() ?? 10,
      'quality': (raw?['quality'] as num?)?.toInt() ?? 70,
    };
  }

  Future<void> savePreviewParams(Map<String, int> p) =>
      _prefs.setString(_kPreviewParams, jsonEncode(p));

  // ── history ─────────────────────────────────────────────────────────────

  static const historyUploadOnly = 'uploadOnly';
  static const historyKeepImage = 'keepImage';
  static const historyNoTrace = 'noTrace';

  String get historyMode =>
      _prefs.getString(_kHistoryMode) ?? historyUploadOnly;
  Future<void> setHistoryMode(String mode) => _prefs.setString(_kHistoryMode, mode);

  List<Map<String, dynamic>> get history {
    final raw = decode(_prefs.getString(_kHistory));
    return (raw?['items'] as List?)?.map((e) => Map<String, dynamic>.from(e as Map)).toList() ?? [];
  }

  /// Stable per-entry key: entries written before ids existed fall back to a
  /// content fingerprint.
  static String historyKey(Map<String, dynamic> item) =>
      item['id'] as String? ?? '${item['at']}|${item['name']}|${item['bytes']}';

  Future<void> addHistory(Map<String, dynamic> item) async {
    // unique id so multi-select stays correct while remote captures insert
    // new rows concurrently (indices would drift)
    item['id'] ??= '${DateTime.now().microsecondsSinceEpoch}';
    final items = history..insert(0, item);
    if (items.length > 200) items.removeRange(200, items.length);
    await _prefs.setString(_kHistory, jsonEncode({'items': items}));
  }

  /// Delete the entries matching [keys] (see [historyKey]); removes their
  /// archived image files too.
  Future<void> removeHistory(Set<String> keys) async {
    final items = history;
    final kept = <Map<String, dynamic>>[];
    for (var i = 0; i < items.length; i++) {
      final it = items[i];
      if (keys.contains(historyKey(it))) {
        final p = it['imagePath'] as String?;
        if (p != null) {
          final f = File(p);
          if (await f.exists()) await f.delete();
        }
      } else {
        kept.add(it);
      }
    }
    await _prefs.setString(_kHistory, jsonEncode({'items': kept}));
  }

  /// Delete every entry (and its archived images).
  Future<void> clearHistory() async {
    final items = history;
    for (final it in items) {
      final p = it['imagePath'] as String?;
      if (p != null) {
        final f = File(p);
        if (await f.exists()) await f.delete();
      }
    }
    await _prefs.setString(_kHistory, jsonEncode({'items': []}));
  }

  static Map<String, dynamic>? decode(String? s) {
    if (s == null || s.isEmpty) return null;
    try {
      return Map<String, dynamic>.from(jsonDecode(s) as Map);
    } catch (_) {
      return null;
    }
  }
}

extension _FirstWhereOrNull<T> on Iterable<T> {
  T? firstWhereOrNull(bool Function(T) test) {
    for (final e in this) {
      if (test(e)) return e;
    }
    return null;
  }
}
