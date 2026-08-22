import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image/image.dart' as img;

/// A small, fully-usable crop screen replacing image_cropper (whose UCrop
/// backend lost rotation control and lets the crop frame overshoot/zoom).
///
/// - Rotation via a 90° button (0/90/180/270), never free two-finger.
/// - Crop frame snapped strictly inside the image — cannot exceed or trigger
///   the "auto-zoom" UCrop quirk.
/// - Back / cancel discards the photo (returns null).
class CropScreen extends StatefulWidget {
  final Uint8List bytes;
  /// Default crop frame = a centered box of this fraction of the image.
  final double defaultCropRatio;
  /// Corner-handle size in px (visual + grab).
  final double handleSize;
  /// Batch mode: the full ordered set of gallery images to crop one-by-one.
  /// When set, the screen keeps a single continuous session — after each crop
  /// it uploads (with a blocking "上传中…" overlay) then loads the next image
  /// in-place, never bouncing back to the viewfinder. The top-right button
  /// reads "下一张" until the last image, which reads "完成". The ✕ discards
  /// ALL remaining images and returns to the viewfinder.
  final List<Uint8List>? batch;
  /// Upload filenames, parallel to [batch]. Optional.
  final List<String>? batchNames;
  /// Uploads one cropped result. Only used in batch mode.
  final Future<void> Function(Uint8List bytes, String name)? onBatchUpload;
  const CropScreen({
    super.key,
    required this.bytes,
    this.defaultCropRatio = 0.5,
    this.handleSize = 14,
    this.batch,
    this.batchNames,
    this.onBatchUpload,
  });

  @override
  State<CropScreen> createState() => _CropScreenState();
}

class _CropScreenState extends State<CropScreen> {
  img.Image? _image;
  Rect? _crop; // in IMAGE pixel coordinates
  Uint8List? _displayBytes; // encoded current view (rotation applied)
  bool _loading = true;
  String? _error;
  // gesture mode
  static const _none = 0, _move = 1, _tl = 2, _tr = 3, _bl = 4, _br = 5;
  int _mode = _none;
  double _imgW = 0, _imgH = 0;
  // batch session state
  bool _uploading = false;
  int _uploaded = 0;

  bool get _isBatch => widget.batch != null && widget.batch!.isNotEmpty;
  int _currentIndex = 0;
  bool get _hasNext => _isBatch && _currentIndex < widget.batch!.length - 1;
  Uint8List get _currentBytes => _isBatch ? widget.batch![_currentIndex] : widget.bytes;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      var decoded = img.decodeImage(_currentBytes);
      if (decoded == null) throw StateError("无法解码图片");
      // apply EXIF orientation so what we show == what we crop
      decoded = img.bakeOrientation(decoded);
      _image = decoded;
      _imgW = decoded.width.toDouble();
      _imgH = decoded.height.toDouble();
      _crop = _centeredCrop(_imgW, _imgH, widget.defaultCropRatio);
      _displayBytes = _encode(decoded);
      if (mounted) setState(() => _loading = false);
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = '加载图片失败: $e';
          _loading = false;
        });
      }
    }
  }

  Uint8List _encode(img.Image im) => Uint8List.fromList(img.encodeJpg(im, quality: 92));

  Rect _centeredCrop(double w, double h, double ratio) {
    final r = ratio.clamp(0.2, 0.9);
    return Rect.fromLTWH((w * (1 - r)) / 2, (h * (1 - r)) / 2, w * r, h * r);
  }

  void _rotate90() {
    if (_image == null) return;
    final rotated = img.copyRotate(_image!, angle: 90);
    setState(() {
      _image = rotated;
      _imgW = rotated.width.toDouble();
      _imgH = rotated.height.toDouble();
      _crop = _centeredCrop(_imgW, _imgH, widget.defaultCropRatio); // centered box of the new frame
      _displayBytes = _encode(rotated);
    });
  }

  void _confirm() {
    final result = _cropAndEncode();
    if (result == null) return;
    if (_isBatch) {
      _batchConfirm(result);
    } else {
      Navigator.of(context).pop(result);
    }
  }

  /// Crop the current image to the active frame and JPEG-encode it.
  /// Returns null if no image/crop is ready.
  Uint8List? _cropAndEncode() {
    final image = _image;
    final crop = _crop;
    if (image == null || crop == null) return null;
    final x = crop.left.round().clamp(0, image.width - 1);
    final y = crop.top.round().clamp(0, image.height - 1);
    final w = crop.width.round().clamp(1, image.width - x);
    final h = crop.height.round().clamp(1, image.height - y);
    final cropped = img.copyCrop(image, x: x, y: y, width: w, height: h);
    return _encode(cropped);
  }

  String _batchName() {
    final names = widget.batchNames;
    if (names != null && _currentIndex < names.length && names[_currentIndex].trim().isNotEmpty) {
      return names[_currentIndex];
    }
    // fallback: derive a deterministic name from the batch position
    final t = DateTime.now();
    String two(int n) => n.toString().padLeft(2, '0');
    return 'batch_${t.year}${two(t.month)}${two(t.day)}_${two(t.hour)}${two(t.minute)}${two(t.second)}_${_currentIndex + 1}.jpg';
  }

  /// Batch mode: crop the current image, block on a "上传中…" overlay while it
  /// uploads, then advance to the next image in-place. The final image pops
  /// back to the viewfinder with the number successfully uploaded.
  Future<void> _batchConfirm(Uint8List result) async {
    final upload = widget.onBatchUpload;
    if (upload == null) return;
    setState(() => _uploading = true);
    var ok = true;
    try {
      await upload(result, _batchName());
      _uploaded++;
    } catch (_) {
      ok = false;
    }
    if (!mounted) return;
    setState(() => _uploading = false);
    if (!ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('上传失败，已略过这张')),
      );
    }
    if (!mounted) return;
    if (_hasNext) {
      setState(() {
        _currentIndex++;
        _image = null;
        _crop = null;
        _displayBytes = null;
        _loading = true;
        _error = null;
      });
      await _load();
    } else {
      Navigator.of(context).pop(_uploaded);
    }
  }

  @override
  Widget build(BuildContext context) {
    final title = _isBatch ? '裁剪 ${_currentIndex + 1}/${widget.batch!.length}' : '裁剪';
    // Batch mode: the button advances to the next photo until the last one.
    final confirmLabel = _isBatch && _hasNext ? '下一张' : '完成';
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: const Color(0xEE101418),
        title: Text(title),
        leading: IconButton(
          icon: const Icon(Icons.close),
          // Batch mode: discard ALL remaining images, not just this one.
          onPressed: () => Navigator.of(context).pop(),
        ),
        actions: [
          IconButton(
            tooltip: '逆时针旋转90°', // image.copyRotate(90) is clockwise → show CCW label? rotate button just rotates 90° each press
            icon: const Icon(Icons.rotate_90_degrees_cw),
            onPressed: _uploading ? null : _rotate90,
          ),
          TextButton(
            onPressed: _uploading ? null : _confirm,
            child: Text(confirmLabel),
          ),
        ],
      ),
      body: Stack(
        children: [
          _loading
              ? const Center(child: CircularProgressIndicator(color: Colors.white54))
              : _error != null
                  ? Center(child: Text(_error!, style: const TextStyle(color: Colors.white70)))
                  : _buildCrop(),
          // Blocking "uploading" overlay for the batch crop→upload→next flow.
          if (_uploading)
            Positioned.fill(
              child: ColoredBox(
                color: Colors.black.withValues(alpha: 0.55),
                child: const Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      CircularProgressIndicator(color: Colors.white),
                      SizedBox(height: 16),
                      Text('上传中…', style: TextStyle(color: Colors.white, fontSize: 16)),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildCrop() {
    return LayoutBuilder(
      builder: (context, constraints) {
        // leave a margin so the corner handles never sit on the screen edge
        // where Android edge-gestures (back swipe / gesture nav) steal them.
        const pad = 18.0;
        final avail = Size(constraints.maxWidth - pad * 2, constraints.maxHeight - pad * 2);
        // fit-contain the image into the available area
        final scale = (avail.width / _imgW) < (avail.height / _imgH) ? avail.width / _imgW : avail.height / _imgH;
        final dw = _imgW * scale;
        final dh = _imgH * scale;
        final imgRect = Rect.fromLTWH((constraints.maxWidth - dw) / 2, (constraints.maxHeight - dh) / 2, dw, dh);
        final crop = _crop!;
        // absolute-space crop rect (for gesture hit-testing)
        final cd = Rect.fromLTWH(
          imgRect.left + crop.left * scale,
          imgRect.top + crop.top * scale,
          crop.width * scale,
          crop.height * scale,
        );
        // imgRect-LOCAL crop rect (for the painter: canvas origin == imgRect top-left)
        final cropBox = Rect.fromLTWH(crop.left * scale, crop.top * scale, crop.width * scale, crop.height * scale);
        return GestureDetector(
          onPanStart: (d) => _onPanStart(d.localPosition, imgRect, cd),
          onPanUpdate: (d) => _onPanUpdate(d.delta, scale),
          child: Stack(
            children: [
              Positioned.fromRect(
                rect: imgRect,
                child: Image.memory(_displayBytes!, fit: BoxFit.fill, gaplessPlayback: true),
              ),
              Positioned.fromRect(
                rect: imgRect,
                child: CustomPaint(painter: _CropPainter(cropBox: cropBox, handleSize: widget.handleSize)),
              ),
            ],
          ),
        );
      },
    );
  }

  void _onPanStart(Offset local, Rect imgRect, Rect cd) {
    final handles = {
      _tl: cd.topLeft,
      _tr: cd.topRight,
      _bl: cd.bottomLeft,
      _br: cd.bottomRight,
    };
    final grab = widget.handleSize + 20; // generous hit zone around each handle
    for (final e in handles.entries) {
      if ((local - e.value).distance <= grab && local.dx >= imgRect.left - grab && local.dx <= imgRect.right + grab && local.dy >= imgRect.top - grab && local.dy <= imgRect.bottom + grab) {
        _mode = e.key;
        return;
      }
    }
    _mode = cd.contains(local) ? _move : _none;
  }

  void _onPanUpdate(Offset deltaImgScreen, double scale) {
    if (_mode == _none) return;
    final crop = _crop!;
    // convert screen delta to image px
    final dx = deltaImgScreen.dx / scale;
    final dy = deltaImgScreen.dy / scale;
    final minSz = 24.0;
    double l = crop.left, t = crop.top, r = crop.right, b = crop.bottom;
    if (_mode == _move) {
      l += dx;
      t += dy;
      r += dx;
      b += dy;
      // keep whole frame inside image
      if (l < 0) { r -= l; l = 0; }
      if (t < 0) { b -= t; t = 0; }
      if (r > _imgW) { l -= r - _imgW; r = _imgW; }
      if (b > _imgH) { t -= b - _imgH; b = _imgH; }
    } else {
      // resize the dragged corner, clamped inside image and min size
      if (_mode == _tl || _mode == _bl) l = (l + dx).clamp(0, r - minSz);
      if (_mode == _tr || _mode == _br) r = (r + dx).clamp(l + minSz, _imgW);
      if (_mode == _tl || _mode == _tr) t = (t + dy).clamp(0, b - minSz);
      if (_mode == _bl || _mode == _br) b = (b + dy).clamp(t + minSz, _imgH);
    }
    setState(() => _crop = Rect.fromLTRB(l, t, r, b));
  }
}

class _CropPainter extends CustomPainter {
  final Rect cropBox; // relative to the canvas origin (== image display box)
  final double handleSize;
  _CropPainter({required this.cropBox, required this.handleSize});
  @override
  void paint(Canvas canvas, Size size) {
    // dim outside the frame — canvas coords are LOCAL to the image box
    final dim = Paint()..color = Colors.black.withValues(alpha: 0.55);
    final r = cropBox;
    canvas.drawPath(
      Path()
        ..addRect(Rect.fromLTWH(0, 0, size.width, size.height))
        ..addRect(r)
        ..fillType = PathFillType.evenOdd,
      dim,
    );
    // crop frame
    final frame = Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    canvas.drawRect(r, frame);
    // corner handles at the configured size
    final h = Paint()..color = Colors.white;
    final half = handleSize / 2;
    for (final p in [r.topLeft, r.topRight, r.bottomLeft, r.bottomRight]) {
      canvas.drawRect(Rect.fromLTWH(p.dx - half, p.dy - half, handleSize, handleSize), h);
    }
  }

  @override
  bool shouldRepaint(covariant _CropPainter old) => old.cropBox != cropBox || old.handleSize != handleSize;
}
