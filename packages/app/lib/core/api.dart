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

class SessionTarget {
  final String sessionId;
  final String title;
  final bool active;
  SessionTarget(this.sessionId, this.title, this.active);
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
    final body = jsonDecode(resp.body) as Map<String, dynamic>;
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
        (preview['fps'] as num?)?.toInt() ?? 6,
        (preview['jpegQuality'] as num?)?.toInt() ?? 60,
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
    String? target,
    http.Client? client,
  }) async {
    final uri = Uri.parse('${server.baseUrl}/upload').replace(queryParameters: {
      'name': name,
      if (note?.isNotEmpty == true) 'note': note!,
      if (captureId != null) 'captureId': captureId,
      if (target?.isNotEmpty == true) 'target': target!,
    });
    final resp = await (client ?? _http)
        .post(
          uri,
          headers: {'content-type': mediaType, ...server.authHeaders},
          body: bytes,
        )
        .timeout(const Duration(seconds: 30));
    final body = jsonDecode(resp.body) as Map<String, dynamic>;
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

  Future<List<SessionTarget>> targets(PairedServer server) async {
    final resp = await _http
        .get(Uri.parse('${server.baseUrl}/targets'), headers: server.authHeaders)
        .timeout(const Duration(seconds: 5));
    if (resp.statusCode != 200) return const [];
    final body = jsonDecode(resp.body) as Map<String, dynamic>;
    final list = (body['targets'] as List?) ?? const [];
    return list
        .map((t) => SessionTarget(
              (t as Map<String, dynamic>)['sessionId'] as String,
              ((t)['title'] as String?) ?? '',
              ((t)['active'] as bool?) ?? false,
            ))
        .toList();
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

  /// Cheap reachability probe: true when the receiver answers /info.
  Future<bool> reachable(PairedServer server) async {
    try {
      final resp = await _http
          .get(Uri.parse('${server.baseUrl}/info'))
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
  static const _kTarget = 'lens.targetSession';
  static const _kHistory = 'lens.history';
  static const _kPreview = 'lens.preview';
  static const _kPreviewParams = 'lens.previewParams';
  static const _kHistoryMode = 'lens.historyMode';
  static const _kChromaSwap = 'lens.chromaSwap';
  static const _kCropRatio = 'lens.cropRatio';
  static const _kHandleSize = 'lens.handleSize';
  static const _kFocusEnabled = 'lens.focusEnabled';
  static const _kAutoSelect = 'lens.autoSelect';

  /// Tap-to-focus + long-press lock on the viewfinder. Off by default (pure
  /// mode: no focus interaction, plain auto-focus).
  bool get focusEnabled => _prefs.getBool(_kFocusEnabled) ?? false;
  Future<void> setFocusEnabled(bool v) => _prefs.setBool(_kFocusEnabled, v);

  /// Auto-select an available paired receiver when the current one becomes
  /// unreachable. Off by default; the user opts in from Settings.
  bool get autoSelect => _prefs.getBool(_kAutoSelect) ?? false;
  Future<void> setAutoSelect(bool v) => _prefs.setBool(_kAutoSelect, v);

  /// Manual chroma correction: swaps U/V when a device's plane layout makes
  /// preview colors flip (red↔blue). Persisted per-phone; changes apply to
  /// the very next preview frame.
  bool get chromaSwap => _prefs.getBool(_kChromaSwap) ?? false;
  Future<void> setChromaSwap(bool v) => _prefs.setBool(_kChromaSwap, v);

  /// Default crop frame = a box of this fraction of the image, centered
  /// (0.5 → the middle half). Configurable from Settings.
  double get defaultCropRatio => (_prefs.getDouble(_kCropRatio) ?? 0.5).clamp(0.2, 0.9);
  Future<void> setDefaultCropRatio(double v) => _prefs.setDouble(_kCropRatio, v.clamp(0.2, 0.9));

  /// Crop-frame corner-handle size in px (visual + grab radius).
  double get handleSize => (_prefs.getDouble(_kHandleSize) ?? 14).clamp(10, 22);
  Future<void> setHandleSize(double v) => _prefs.setDouble(_kHandleSize, v.clamp(10, 22));

  final SharedPreferences _prefs;
  LensStore(this._prefs) {
    _migrateLegacy();
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

  /// Register a freshly paired receiver and make it active.
  Future<void> addServer(PairedServer s) async {
    final all = servers()..removeWhere((x) => x.id == s.id);
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

  // ── target session ──────────────────────────────────────────────────────

  String? get targetSession {
    final v = _prefs.getString(_kTarget);
    return (v == null || v.isEmpty) ? null : v;
  }

  Future<void> setTargetSession(String? id) =>
      (id == null || id.isEmpty) ? _prefs.remove(_kTarget) : _prefs.setString(_kTarget, id);

  // ── preview overrides / history ─────────────────────────────────────────

  Map<String, dynamic>? get previewOverrides => decode(_prefs.getString(_kPreview));
  Future<void> setPreviewOverride(String key, int value) async {
    final map = decode(_prefs.getString(_kPreview)) ?? <String, dynamic>{};
    map[key] = value;
    await _prefs.setString(_kPreview, jsonEncode(map));
  }

  // Preview parameters last advertised by the active receiver (serverInfo).
  Map<String, int> get previewParams {
    final raw = decode(_prefs.getString(_kPreviewParams));
    return {
      'maxShort': (raw?['maxShort'] as num?)?.toInt() ?? 360,
      'maxLong': (raw?['maxLong'] as num?)?.toInt() ?? 640,
      'fps': (raw?['fps'] as num?)?.toInt() ?? 6,
      'quality': (raw?['quality'] as num?)?.toInt() ?? 62,
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

  Future<void> addHistory(Map<String, dynamic> item) async {
    final items = history..insert(0, item);
    if (items.length > 200) items.removeRange(200, items.length);
    await _prefs.setString(_kHistory, jsonEncode({'items': items}));
  }

  /// Delete the entries at [indices]; removes their archived image files too.
  Future<void> removeHistory(Set<int> indices) async {
    final items = history;
    final kept = <Map<String, dynamic>>[];
    for (var i = 0; i < items.length; i++) {
      final it = items[i];
      if (indices.contains(i)) {
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
