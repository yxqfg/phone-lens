import 'package:flutter/material.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:uuid/uuid.dart';

import '../../core/api.dart';
import '../../ui/background_art.dart';

/// Scan the pairing QR (lensmate://pair?v=1&host=..&port=..&code=..), or fall
/// back to manual host:port:code entry. On success the receiver is stored
/// (active) and [onPaired] fires; pushed instances pop themselves.
class PairScreen extends StatefulWidget {
  final LensStore store;
  final VoidCallback? onPaired;
  const PairScreen({super.key, required this.store, this.onPaired});

  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  final _api = LensApi();
  final _manual = TextEditingController();
  bool _busy = false;
  String? _error;
  bool _showManual = false;
  Key _scannerKey = UniqueKey();
  /// Payload whose pairing already FAILED: never auto-retry it — the scanner
  /// re-detects the same QR several times a second and the receiver
  /// rate-limits failed attempts (10/min), so retries just burn the budget.
  String? _failedPayload;

  @override
  void dispose() {
    _api.dispose();
    _manual.dispose();
    super.dispose();
  }

  Future<String> _deviceName() async {
    final stored = widget.store.deviceName;
    if (stored.isNotEmpty && stored != 'phone') return stored;
    try {
      final info = await DeviceInfoPlugin().androidInfo;
      final model = info.model.trim();
      if (model.isNotEmpty) {
        await widget.store.setDeviceName(model);
        return model;
      }
    } catch (_) {}
    return 'Android ${DateTime.now().millisecondsSinceEpoch % 1000}';
  }

  Future<void> _pair({required String host, required int port, required String code, String? payload}) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      // REUSE the persisted device identity: re-pairing the same PC must
      // refresh the token on the SAME host-side record, not spawn a new one
      var deviceId = widget.store.deviceId;
      if (deviceId.isEmpty) {
        deviceId = const Uuid().v4();
        await widget.store.setDeviceId(deviceId);
      }
      final deviceName = await _deviceName();
      final result = await _api.pair(
        host: host,
        port: port,
        code: code,
        deviceId: deviceId,
        deviceName: deviceName,
        deviceModel: deviceName, // host may uniquify duplicate names
      );
      // adopt the receiver's preview budgets + upload limits
      final pv = result.preview;
      await widget.store.savePreviewParams({
        'maxShort': pv.maxHeight < pv.maxWidth ? pv.maxHeight : pv.maxWidth,
        'maxLong': pv.maxHeight < pv.maxWidth ? pv.maxWidth : pv.maxHeight,
        'fps': pv.fps,
        'quality': pv.jpegQuality,
      });
      await widget.store.saveLimits(result.maxUploadBytes);
      await widget.store.addServer(result.server);
      widget.onPaired?.call();
      if (!mounted) return;
      if (Navigator.of(context).canPop()) Navigator.of(context).pop();
    } catch (e) {
      _failedPayload = payload;
      if (mounted) setState(() => _error = _pairErrorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Human-readable pairing failures — raw exceptions (SocketException,
  /// FormatException) and raw host error codes must not reach the user.
  String _pairErrorText(Object e) {
    if (e is LensApiError) {
      switch (e.code) {
        case 'PAIR_CODE_INVALID':
          return '配对码错误。若多次失败,请在电脑端刷新二维码后再扫。';
        case 'PAIR_CODE_EXPIRED':
          return '配对码已过期,请在电脑端刷新二维码后重新扫码。';
        case 'RATE_LIMITED':
          return '尝试过于频繁,请等待一分钟后重试。';
        case 'PAIR_FAILED':
          return e.message; // already human-readable (non-pairing service)
        default:
          return '配对失败(${e.code})';
      }
    }
    final msg = e.toString();
    if (msg.contains('SocketException') || msg.contains('TimeoutException') || msg.contains('timed out')) {
      return '连接失败:请确认手机与电脑在同一网络,地址端口无误。';
    }
    return '配对失败: $msg';
  }

  void _onScan(String raw) {
    final uri = Uri.tryParse(raw);
    if (uri == null || !raw.startsWith('lensmate://pair')) return;
    // protocol version gate: a future host format must fail loudly, not
    // parse into wrong fields
    final v = int.tryParse(uri.queryParameters['v'] ?? '1') ?? 1;
    if (v > 1) {
      if (mounted && _error != '电脑端 PhoneLens 版本过新,请更新手机 App 后再配对。') {
        setState(() => _error = '电脑端 PhoneLens 版本过新,请更新手机 App 后再配对。');
      }
      return;
    }
    if (raw == _failedPayload) return; // already tried and failed — no auto-retry
    final host = uri.queryParameters['host'];
    final port = int.tryParse(uri.queryParameters['port'] ?? '');
    final code = uri.queryParameters['code'];
    if (host == null || port == null || code == null) return;
    _pair(host: host, port: port, code: code, payload: raw);
  }

  void _onManual() {
    final text = _manual.text.trim();
    // accept "host:port:code" or "host:code" (default port)
    final parts = text.split(':');
    if (parts.length == 3) {
      final port = int.tryParse(parts[1]);
      if (port == null) {
        setState(() => _error = '端口格式错误:应为数字(如 8791)');
        return;
      }
      _pair(host: parts[0], port: port, code: parts[2]);
    } else if (parts.length == 2) {
      _pair(host: parts[0], port: 8791, code: parts[1]);
    } else {
      setState(() => _error = '格式:主机:端口:配对码 或 主机:配对码(默认端口 8791)');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('PhoneLens 配对')),
      body: Stack(
        children: [
          const BackgroundArt(widthFactor: 0.42),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  '扫描电脑端 dsh 悬浮窗或终端里展示的配对二维码',
                  style: Theme.of(context).textTheme.bodyMedium,
                  textAlign: TextAlign.center,
                ),
            const SizedBox(height: 12),
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(16),
                child: Stack(
                  children: [
                    MobileScanner(
                      key: _scannerKey,
                      onDetect: (capture) {
                        final raw = capture.barcodes.firstOrNull?.rawValue;
                        if (raw != null) _onScan(raw);
                      },
                      errorBuilder: (context, error, child) => _ScannerError(
                        error: error,
                        onRetry: () => setState(() => _scannerKey = UniqueKey()),
                      ),
                    ),
                    if (_busy)
                      Container(
                        color: Colors.black54,
                        child: const Center(child: CircularProgressIndicator()),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
              ),
            TextButton(
              onPressed: () => setState(() => _showManual = !_showManual),
              child: Text(_showManual ? '收起手动输入' : '手动输入配对码'),
            ),
            if (_showManual) ...[
              TextField(
                controller: _manual,
                decoration: const InputDecoration(
                  labelText: '主机:端口:配对码',
                  hintText: '192.168.1.20:8791:12345678',
                  border: OutlineInputBorder(),
                ),
                onSubmitted: (_) => _onManual(),
              ),
              const SizedBox(height: 8),
              FilledButton(onPressed: _busy ? null : _onManual, child: const Text('配对')),
            ],
          ],
        ),
      ),
    ],
  ),
);
  }
}

extension<T> on List<T> {
  T? get firstOrNull => isEmpty ? null : first;
}

/// Actionable scanner error surface: readable cause + retry, replacing the
/// bare exclamation placeholder.
class _ScannerError extends StatelessWidget {
  final Object error;
  final VoidCallback onRetry;
  const _ScannerError({required this.error, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final msg = error.toString();
    String hint;
    if (msg.contains('permissionDenied') || msg.contains('PermissionDenied')) {
      hint = '相机权限被拒绝。请在系统设置中允许 PhoneLens 使用相机。';
    } else if (msg.contains('Unspecified') || msg.contains('camera') || msg.contains('Camera')) {
      hint = '相机启动失败,可能被其他应用占用。';
    } else {
      hint = '扫码相机初始化失败。';
    }
    return InkWell(
      onTap: onRetry,
      child: ColoredBox(
        color: Colors.black,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.no_photography, size: 48, color: Colors.white70),
              const SizedBox(height: 12),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 24),
                child: Text(hint, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white70)),
              ),
              const SizedBox(height: 8),
              FilledButton.tonal(onPressed: onRetry, child: const Text('点击重试')),
              const SizedBox(height: 8),
              TextButton(
                onPressed: () => openAppSettings(),
                child: const Text('打开应用设置', style: TextStyle(fontSize: 12)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
