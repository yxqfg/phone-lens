import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:image/image.dart' as img;

/// A small, fully-usable crop screen replacing image_cropper (whose UCrop
/// backend lost rotation control and lets the crop frame overshoot/zoom).
///
/// - Rotation via a 90° button (0/90/180/270), never free two-finger.
/// - Crop frame snapped strictly inside the image — cannot exceed or trigger
///   the "auto-zoom" UCrop quirk.
/// - Annotation strokes: freehand 画笔 (opaque marker) and 马赛克 (pixelate
///   blocks), drawn on the full image before the crop — whatever the crop
///   frame excludes is naturally discarded at export.
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

enum _DrawMode { crop, pen, mosaic }

/// One freehand stroke in IMAGE pixel coordinates. Points arrive quantized
/// ([_BakeStroke] doubles) so the exporter in a background isolate never sees
/// dart:ui types.
class _Stroke {
  _Stroke({required this.mosaic, required this.points, required this.width});
  final bool mosaic;
  final List<Offset> points;
  /// Pen: line thickness in image px. Mosaic: block size in image px (the
  /// painted band is ~2.2 blocks wide so one pass covers what it crosses).
  final double width;

  _BakeStroke toBake() => _BakeStroke(
        mosaic: mosaic,
        xs: [for (final p in points) p.dx],
        ys: [for (final p in points) p.dy],
        width: width,
      );
}

/// Plain-data stroke for the background isolate (no dart:ui dependencies).
class _BakeStroke {
  _BakeStroke({required this.mosaic, required this.xs, required this.ys, required this.width});
  final bool mosaic;
  final List<double> xs;
  final List<double> ys;
  final double width;
}

class _BakeArgs {
  _BakeArgs({required this.image, required this.strokes});
  final img.Image image;
  final List<_BakeStroke> strokes;
}

/// Round-capped coverage outline of a thick polyline — union of rounded
/// segments. Used ONLY for mosaic (a blocky aesthetic hides the joints); the
/// pen paints a smooth stroked centerline instead (see _polylinePath).
Path _strokeOutline(List<Offset> pts, double width) {
  final path = Path();
  if (pts.isEmpty) return path;
  final r = width / 2;
  if (pts.length == 1) {
    path.addOval(Rect.fromCircle(center: pts.first, radius: r));
    return path;
  }
  for (var i = 0; i < pts.length - 1; i++) {
    final rect = Rect.fromPoints(pts[i], pts[i + 1]);
    path.addRRect(RRect.fromRectAndRadius(rect.inflate(r), Radius.circular(r)));
  }
  return path;
}

/// Centerline of a polyline — painted with a round-cap/round-join stroke, so
/// the pen reads as one smooth continuous marker line (the old per-segment
/// rounded-rect union looked like chained boxes at every joint).
Path _polylinePath(List<Offset> pts) {
  final path = Path();
  if (pts.isEmpty) return path;
  path.moveTo(pts.first.dx, pts.first.dy);
  for (var i = 1; i < pts.length; i++) {
    path.lineTo(pts[i].dx, pts[i].dy);
  }
  return path;
}

/// Background-isolate bake: draw every stroke into the decoded image with the
/// `image` package, so the exported JPEG matches what the preview showed.
img.Image _bakeStrokes(_BakeArgs args) {
  final image = args.image;
  for (final s in args.strokes) {
    if (s.mosaic) {
      _bakeMosaic(image, s);
    } else {
      _bakePen(image, s);
    }
  }
  return image;
}

const int _penR = 0xE5, _penG = 0x48, _penB = 0x4D; // #E5484D, matches preview

void _bakePen(img.Image image, _BakeStroke s) {
  final color = image.getColor(_penR, _penG, _penB);
  final thickness = s.width.round().clamp(1, 512);
  final radius = (s.width / 2).round();
  // a filled circle at EVERY point + line segments between: the circles mask
  // the square joints drawLine would otherwise leave at each turn, matching
  // the round-cap preview
  for (var i = 0; i < s.xs.length; i++) {
    final x = s.xs[i].round();
    final y = s.ys[i].round();
    img.fillCircle(image, x: x, y: y, radius: radius, color: color);
    if (i > 0) {
      img.drawLine(
        image,
        x1: s.xs[i - 1].round(),
        y1: s.ys[i - 1].round(),
        x2: x,
        y2: y,
        color: color,
        thickness: thickness,
      );
    }
  }
}

void _bakeMosaic(img.Image image, _BakeStroke s) {
  final cell = s.width.round().clamp(4, 512);
  // walk the polyline, averaging the grid cell under every sample point
  final seen = <String>{};
  void touch(double fx, double fy) {
    final gx = (fx.round() ~/ cell) * cell;
    final gy = (fy.round() ~/ cell) * cell;
    final key = '$gx:$gy';
    if (!seen.add(key)) return;
    _fillMosaicBlock(image, gx, gy, cell);
  }

  for (var i = 0; i < s.xs.length - 1; i++) {
    final x0 = s.xs[i], y0 = s.ys[i], x1 = s.xs[i + 1], y1 = s.ys[i + 1];
    final len = math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
    final steps = (len / (cell / 2)).ceil().clamp(1, 8192);
    for (var k = 0; k <= steps; k++) {
      final t = k / steps;
      touch(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    }
  }
  if (s.xs.length == 1) touch(s.xs.first, s.ys.first);
}

void _fillMosaicBlock(img.Image image, int gx, int gy, int cell) {
  final xStart = gx.clamp(0, image.width);
  final yStart = gy.clamp(0, image.height);
  final xEnd = (gx + cell).clamp(0, image.width);
  final yEnd = (gy + cell).clamp(0, image.height);
  if (xEnd <= xStart || yEnd <= yStart) return;
  int r = 0, g = 0, b = 0, n = 0;
  for (var y = yStart; y < yEnd; y += 2) {
    for (var x = xStart; x < xEnd; x += 2) {
      final p = image.getPixel(x, y);
      r += p.r.toInt();
      g += p.g.toInt();
      b += p.b.toInt();
      n++;
    }
  }
  if (n == 0) return;
  final avg = image.getColor(r ~/ n, g ~/ n, b ~/ n);
  for (var y = yStart; y < yEnd; y++) {
    for (var x = xStart; x < xEnd; x++) {
      image.setPixel(x, y, avg);
    }
  }
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
  // ── strokes ──────────────────────────────────────────────────────────────
  _DrawMode _drawMode = _DrawMode.crop;
  final List<_Stroke> _strokes = [];
  int _penSizeIdx = 1; // 0=细 1=中 2=粗
  int _mosaicIdx = 1; // 0=轻 1=中 2=重
  static const _penFracs = [0.012, 0.03, 0.06]; // of image width
  static const _mosaicFracs = [0.02, 0.04, 0.08]; // block size, of image width
  ui.Image? _pixelated; // pixelated WHOLE image, for the mosaic preview layer
  bool _pixelating = false;
  /// Generation counter: every discard/rotate/load bumps it; a build whose
  /// captured gen is stale disposes its result instead of installing it (the
  /// old code let a slow older-tier build overwrite a newer one, or attach a
  /// layer built from the pre-rotation image).
  int _pixelGen = 0;

  double get _penWidth => (_imgW * _penFracs[_penSizeIdx]).clamp(8.0, 512.0);
  double get _mosaicCell => (_imgW * _mosaicFracs[_mosaicIdx]).clamp(8.0, 512.0);

  bool get _isBatch => widget.batch != null && widget.batch!.isNotEmpty;
  int _currentIndex = 0;
  bool get _hasNext => _isBatch && _currentIndex < widget.batch!.length - 1;
  Uint8List get _currentBytes => _isBatch ? widget.batch![_currentIndex] : widget.bytes;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _pixelated?.dispose();
    super.dispose();
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
      _strokes.clear();
      _drawMode = _DrawMode.crop; // fresh image: back to crop mode (batch flow)
      _discardPixelated();
      if (mounted) setState(() => _loading = false);
      // entering mosaic mode later builds it lazily; nothing eager here
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
      // stroke coordinates are image-space; rotation remaps every point, so
      // the honest (and simplest) behaviour is to start clean
      _strokes.clear();
      _discardPixelated();
    });
  }

  void _setDrawMode(_DrawMode m) {
    setState(() => _drawMode = m);
    if (m == _DrawMode.mosaic) _ensurePixelated();
  }

  void _setPenSize(int i) => setState(() => _penSizeIdx = i);

  void _setMosaic(int i) {
    setState(() {
      _mosaicIdx = i;
      _discardPixelated();
    });
    _ensurePixelated();
  }

  void _discardPixelated() {
    _pixelGen++;
    _pixelated?.dispose();
    _pixelated = null;
    _pixelating = false;
  }

  /// Build (once) the nearest-neighbour downsampled whole image the mosaic
  /// preview paints through clip paths. Generation-guarded against concurrent
  /// tier switches / rotations / batch loads.
  Future<void> _ensurePixelated() async {
    final src = _image;
    if (src == null || _pixelated != null || _pixelating) return;
    _pixelating = true;
    final gen = _pixelGen;
    try {
      final cell = _mosaicCell;
      final small = img.copyResize(
        src,
        width: (src.width / cell).round().clamp(1, src.width),
        height: (src.height / cell).round().clamp(1, src.height),
        interpolation: img.Interpolation.nearest,
      );
      final bytes = Uint8List.fromList(img.encodeJpg(small, quality: 80));
      final codec = await ui.instantiateImageCodec(bytes);
      final frame = await codec.getNextFrame();
      codec.dispose();
      if (!mounted) {
        frame.image.dispose();
        return;
      }
      if (gen != _pixelGen) {
        // superseded by a tier switch / rotation / next image — drop it
        frame.image.dispose();
        return;
      }
      final old = _pixelated;
      setState(() => _pixelated = frame.image);
      old?.dispose();
    } catch (_) {
      // mosaic preview falls back to a flat placeholder; export still works
    } finally {
      if (gen == _pixelGen) _pixelating = false;
    }
  }

  bool _confirming = false; // guards the (async) confirm against double taps

  Future<void> _confirm() async {
    if (_confirming || _uploading) return;
    _confirming = true;
    try {
      final result = await _cropAndEncode();
      if (result == null) return;
      if (_isBatch) {
        await _batchConfirm(result);
      } else {
        if (mounted) Navigator.of(context).pop(result);
      }
    } finally {
      _confirming = false;
    }
  }

  /// Bake the strokes into the image (background isolate), crop to the active
  /// frame and JPEG-encode. Returns null if no image/crop is ready.
  Future<Uint8List?> _cropAndEncode() async {
    final image = _image;
    final crop = _crop;
    if (image == null || crop == null) return null;
    // strokes live in image space and are baked BEFORE cropping — parts
    // outside the frame are naturally discarded by copyCrop
    var work = image;
    if (_strokes.isNotEmpty) {
      work = await compute(
        _bakeStrokes,
        _BakeArgs(image: image, strokes: [for (final s in _strokes) s.toBake()]),
      );
    }
    final x = crop.left.round().clamp(0, work.width - 1);
    final y = crop.top.round().clamp(0, work.height - 1);
    final w = crop.width.round().clamp(1, work.width - x);
    final h = crop.height.round().clamp(1, work.height - y);
    final cropped = img.copyCrop(work, x: x, y: y, width: w, height: h);
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
          // Batch mode: discards ALL remaining images (already-uploaded ones
          // stay), so it asks; single mode just drops this one photo.
          onPressed: () async {
            if (_isBatch && _hasNext) {
              final remaining = widget.batch!.length - _currentIndex;
              final ok = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: const Text('丢弃剩余照片?'),
                  content: Text('将丢弃剩余 $remaining 张(含当前);已上传的不受影响。'),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('继续裁剪')),
                    FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('丢弃')),
                  ],
                ),
              );
              if (ok != true) return;
            }
            if (context.mounted) Navigator.of(context).pop();
          },
        ),
        actions: [
          IconButton(
            tooltip: '顺时针旋转90°', // image.copyRotate(90) rotates clockwise
            icon: const Icon(Icons.rotate_90_degrees_cw),
            onPressed: _uploading ? null : _rotate90,
          ),
          TextButton(
            onPressed: _uploading ? null : () => _confirm(),
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
          // bottom: draw-mode bar (crop / pen / mosaic + undo) with the stroke
          // size rows only while a drawing mode is active
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: SafeArea(
              top: false,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (_drawMode != _DrawMode.crop) _strokeSettings(),
                  _modeBar(),
                ],
              ),
            ),
          ),
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

  Widget _modeBar() {
    Widget modeBtn(_DrawMode m, IconData icon, String label) {
      final active = _drawMode == m;
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: _uploading ? null : () => _setDrawMode(m),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: active ? const Color(0xFF2A5D8F) : Colors.transparent,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(icon, size: 18, color: active ? Colors.white : Colors.white70),
                const SizedBox(width: 4),
                Text(label, style: TextStyle(fontSize: 12, color: active ? Colors.white : Colors.white70)),
              ],
            ),
          ),
        ),
      );
    }

    return Center(
      child: Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
        decoration: BoxDecoration(
          color: const Color(0xEE101418),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: Colors.white12),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            modeBtn(_DrawMode.crop, Icons.crop, '裁剪'),
            modeBtn(_DrawMode.pen, Icons.edit, '画笔'),
            modeBtn(_DrawMode.mosaic, Icons.blur_on, '马赛克'),
            const SizedBox(width: 6),
            IconButton(
              tooltip: '撤销一笔',
              // undo also retires the pixelated layer lazily? No — the layer
              // covers the WHOLE image, it stays valid regardless of strokes.
              onPressed: _strokes.isEmpty ? null : () => setState(() => _strokes.removeLast()),
              icon: const Icon(Icons.undo, size: 20, color: Colors.white70),
            ),
          ],
        ),
      ),
    );
  }

  Widget _strokeSettings() {
    final penActive = _drawMode == _DrawMode.pen;
    return Center(
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: const Color(0xEE101418),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: Colors.white12),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(penActive ? '笔画大小' : '模糊度', style: const TextStyle(fontSize: 11, color: Colors.white70)),
            const SizedBox(width: 10),
            for (var i = 0; i < 3; i++)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: InkWell(
                  borderRadius: BorderRadius.circular(16),
                  onTap: _uploading ? null : () => penActive ? _setPenSize(i) : _setMosaic(i),
                  child: Container(
                    width: 34,
                    height: 34,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: (penActive ? _penSizeIdx : _mosaicIdx) == i ? const Color(0xFF2A5D8F) : Colors.white10,
                    ),
                    child: penActive
                        ? Icon(
                            // same brush glyph, growing with the size tier
                            Icons.brush,
                            size: 13.0 + i * 4.0,
                            color: Colors.white,
                          )
                        : Container(
                            // dot size previews the block coarseness
                            width: 8.0 + i * 5,
                            height: 8.0 + i * 5,
                            decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white70),
                          ),
                  ),
                ),
              ),
          ],
        ),
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
        // display-space strokes for the painter (canvas origin == imgRect TL):
        // pen = smooth stroked centerline (+ a dot when it's a single tap),
        // mosaic = coverage outline to clip the pixelated layer through
        final displayStrokes = [
          for (final s in _strokes)
            if (s.mosaic)
              _DisplayStroke(
                mosaic: true,
                outline: _strokeOutline(
                  [for (final p in s.points) Offset(p.dx * scale, p.dy * scale)],
                  s.width * 2.2 * scale,
                ),
              )
            else
              _DisplayStroke(
                mosaic: false,
                centerline: s.points.length > 1 ? _polylinePath([for (final p in s.points) Offset(p.dx * scale, p.dy * scale)]) : null,
                dot: s.points.length == 1 ? Offset(s.points.first.dx * scale, s.points.first.dy * scale) : null,
                lineWidth: s.width * scale,
              ),
        ];
        final drawing = _drawMode != _DrawMode.crop;
        return GestureDetector(
          onPanStart: (d) => drawing ? _beginStroke(d.localPosition, imgRect, scale) : _onPanStart(d.localPosition, imgRect, cd),
          onPanUpdate: (d) => drawing ? _extendStroke(d.localPosition, imgRect, scale) : _onPanUpdate(d.delta, scale),
          onPanEnd: (_) => _lastPanDrawing = false,
          child: Stack(
            children: [
              Positioned.fromRect(
                rect: imgRect,
                child: Image.memory(_displayBytes!, fit: BoxFit.fill, gaplessPlayback: true),
              ),
              Positioned.fromRect(
                rect: imgRect,
                child: CustomPaint(
                  painter: _CropPainter(
                    cropBox: cropBox,
                    handleSize: widget.handleSize,
                    strokes: displayStrokes,
                    pixelated: _pixelated,
                    drawHandles: !drawing,
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  bool _lastPanDrawing = false;

  void _beginStroke(Offset local, Rect imgRect, double scale) {
    if (_image == null) return;
    final px = ((local.dx - imgRect.left) / scale).clamp(0.0, _imgW);
    final py = ((local.dy - imgRect.top) / scale).clamp(0.0, _imgH);
    final mosaic = _drawMode == _DrawMode.mosaic;
    if (mosaic) _ensurePixelated();
    _lastPanDrawing = true;
    setState(() {
      _strokes.add(_Stroke(
        mosaic: mosaic,
        points: [Offset(px, py)],
        width: mosaic ? _mosaicCell : _penWidth,
      ));
    });
  }

  void _extendStroke(Offset local, Rect imgRect, double scale) {
    if (!_lastPanDrawing || _strokes.isEmpty) return;
    final px = ((local.dx - imgRect.left) / scale).clamp(0.0, _imgW);
    final py = ((local.dy - imgRect.top) / scale).clamp(0.0, _imgH);
    final s = _strokes.last;
    final last = s.points.last;
    if ((Offset(px, py) - last).distance < 2) return; // dedupe micro-jitter
    setState(() => s.points.add(Offset(px, py)));
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

/// Stroke already converted to display space (canvas origin == image TL).
class _DisplayStroke {
  _DisplayStroke({required this.mosaic, this.outline, this.centerline, this.dot, this.lineWidth = 0});
  final bool mosaic;
  /// Mosaic only: coverage outline the pixelated layer is clipped through.
  final Path? outline;
  /// Pen only: polyline centerline, painted with a round-cap stroke.
  final Path? centerline;
  /// Pen only: single-tap stroke = one dot at this position.
  final Offset? dot;
  /// Pen only: stroke width in display px.
  final double lineWidth;
}

class _CropPainter extends CustomPainter {
  final Rect cropBox; // relative to the canvas origin (== image display box)
  final double handleSize;
  final List<_DisplayStroke> strokes;
  final ui.Image? pixelated;
  final bool drawHandles;
  _CropPainter({
    required this.cropBox,
    required this.handleSize,
    this.strokes = const [],
    this.pixelated,
    this.drawHandles = true,
  });
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
    // strokes paint OVER the dim veil so marks stay readable outside the frame
    for (final s in strokes) {
      if (s.mosaic) {
        final outline = s.outline;
        if (outline == null) continue;
        final px = pixelated;
        canvas.save();
        canvas.clipPath(outline);
        if (px != null) {
          // stretch the pixelated whole image over the display box — the clip
          // reveals the blocky version of exactly what's underneath
          canvas.drawImageRect(
            px,
            Rect.fromLTWH(0, 0, px.width.toDouble(), px.height.toDouble()),
            Rect.fromLTWH(0, 0, size.width, size.height),
            Paint(),
          );
        } else {
          // pixelated layer still decoding: neutral placeholder
          canvas.drawPath(outline, Paint()..color = Colors.white24);
        }
        canvas.restore();
      } else {
        // pen: ONE smooth round-cap/round-join stroke along the centerline
        // (per-segment rounded rects used to read as chained boxes)
        final paint = Paint()
          ..color = const Color(0xFFE5484D)
          ..style = PaintingStyle.stroke
          ..strokeCap = StrokeCap.round
          ..strokeJoin = StrokeJoin.round
          ..strokeWidth = s.lineWidth;
        final cl = s.centerline;
        if (cl != null) canvas.drawPath(cl, paint);
        final d = s.dot;
        if (d != null) {
          canvas.drawCircle(d, s.lineWidth / 2, Paint()..color = const Color(0xFFE5484D));
        }
      }
    }
    // crop frame
    final frame = Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    canvas.drawRect(r, frame);
    // corner handles at the configured size
    if (!drawHandles) return;
    final h = Paint()..color = Colors.white;
    final half = handleSize / 2;
    for (final p in [r.topLeft, r.topRight, r.bottomLeft, r.bottomRight]) {
      canvas.drawRect(Rect.fromLTWH(p.dx - half, p.dy - half, handleSize, handleSize), h);
    }
  }

  @override
  bool shouldRepaint(covariant _CropPainter old) =>
      old.cropBox != cropBox ||
      old.handleSize != handleSize ||
      !identical(old.strokes, strokes) ||
      !identical(old.pixelated, pixelated) ||
      old.drawHandles != drawHandles;
}
