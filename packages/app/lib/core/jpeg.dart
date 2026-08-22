import 'package:camera/camera.dart';
import 'package:flutter/foundation.dart';
import 'package:image/image.dart' as img;

/// YUV420 (Android CameraImage) → JPEG bytes.
///
/// Camera planes carry row padding (`bytesPerRow` may exceed the logical
/// width) and are recycled after the stream callback returns, so
/// [copyYuv420] compact-copies every plane synchronously to dense buffers.
/// Encoding then happens off the UI isolate (or via the native channel).
class YuvSnapshot {
  final int width;
  final int height;
  final int uvWidth;
  final int uvHeight;
  final Uint8List y;
  final Uint8List u;
  final Uint8List v;
  YuvSnapshot(this.width, this.height, this.uvWidth, this.uvHeight, this.y, this.u, this.v);
}

/// One-shot plane census: real layout facts (lengths, strides, sampled
/// byte means) logged once per process so any remaining chroma question is
/// answered with measurements instead of guesses. The even/odd means of an
/// interleaved chroma plane identify NV12 vs NV21 ordering when compared
/// against a known reference frame.
bool _censusLogged = false;
void _logPlaneCensus(CameraImage image) {
  if (_censusLogged) return;
  _censusLogged = true;
  try {
    final b = StringBuffer();
    b.write('[lens-mate] plane census ${image.width}x${image.height} fmt=${image.format.group.name}:');
    for (var i = 0; i < image.planes.length; i++) {
      final p = image.planes[i];
      final bytes = p.bytes;
      var sum = 0;
      var sumEven = 0;
      var sumOdd = 0;
      var nEven = 0;
      var nOdd = 0;
      for (var j = 0; j < bytes.length; j++) {
        final v = bytes[j];
        sum += v;
        if (j.isEven) {
          sumEven += v;
          nEven++;
        } else {
          sumOdd += v;
          nOdd++;
        }
      }
      final n = bytes.isEmpty ? 1 : bytes.length;
      b.write(' p$i[len=${bytes.length} row=${p.bytesPerRow} pix=${p.bytesPerPixel} mean=${(sum / n).toStringAsFixed(1)} even=${nEven == 0 ? '-' : (sumEven / nEven).toStringAsFixed(1)} odd=${nOdd == 0 ? '-' : (sumOdd / nOdd).toStringAsFixed(1)}]');
    }
    debugPrint(b.toString());
  } catch (_) {}
}

/// Synchronous compact copy of the three YUV planes (call inside the stream
/// callback; row padding stripped).
///
/// Plane sizes are DERIVED from image.width/height (Y = full res, U/V =
/// halved): this device's plugin reports plane.width/height that disagree
/// with the actual stream (640×360 reported for a 1280×720 plane), which
/// once produced a 230400-byte Y plane against a 921600 w×h claim and blew
/// up every encode path.
///
/// Chroma: planar devices (bytesPerPixel==1) expose pure U and V planes.
/// Semi-planar devices interleave chroma in ONE buffer (plane[1]); this
/// device delivers it in NV21 order — V first (yellow decoded greenish
/// until we swapped). U/V both come from plane[1]; plane[2] is not trusted.
YuvSnapshot? copyYuv420(CameraImage image, {bool swapChroma = false}) {
  try {
    _logPlaneCensus(image);
    Uint8List compactStride(Plane p, int w, int h, int offset) {
      final src = p.bytes;
      final stride = p.bytesPerRow;
      final ps = (p.bytesPerPixel ?? 1) < 1 ? 1 : (p.bytesPerPixel ?? 1);
      final len = src.length;
      final out = Uint8List(w * h);
      var o = 0;
      for (var row = 0; row < h; row++) {
        final base = row * stride + offset;
        for (var c = 0; c < w; c++) {
          final idx = base + c * ps;
          out[o++] = idx < len ? src[idx] : 0;
        }
      }
      return out;
    }

    final w = image.width;
    final h = image.height;
    final uvW = (w + 1) >> 1;
    final uvH = (h + 1) >> 1;
    // MEASURED on this device (plane census): p1/p2 are two views over one
    // interleaved chroma block (460799B, pix=2) with OPPOSITE starting
    // offsets — p1.even-mean == p2.odd-mean (129.0) and vice versa (131.1).
    // So each plane's OWN offset-0 walk by pixelStride yields one pure
    // component: plane[1] → U, plane[2] → V. Reading both components out of
    // a single plane (the guess before the census) mixed them.
    var uPlane = compactStride(image.planes[1], uvW, uvH, 0);
    var vPlane = compactStride(image.planes[2], uvW, uvH, 0);
    if (swapChroma) {
      // manual color correction for devices whose layout differs; applies to
      // both the native and the Dart encode paths (swap happens at the source)
      final t = uPlane;
      uPlane = vPlane;
      vPlane = t;
    }
    return YuvSnapshot(
      w,
      h,
      uvW,
      uvH,
      compactStride(image.planes[0], w, h, 0),
      uPlane,
      vPlane,
    );
  } catch (e) {
    // never silent: a null snapshot reads as "0 fps" on both ends
    debugPrint('[lens-mate] copyYuv420 failed: $e');
    return null;
  }
}

/// Encode one snapshot (BT.601 limited-range YUV→RGB) to a JPEG no larger
/// than the [maxShort]×[maxLong] box (never upscaled). Output keeps the
/// SENSOR orientation — the receiver rotates it using the rotation reported
/// in the stream handshake, keeping this encoder simple and fast.
///
/// Pure-Dart fallback path (native channel is preferred).
Uint8List encodeSnapshotJpeg(
  YuvSnapshot snap,
  int maxShort,
  int maxLong,
  int quality,
) {
  final w = snap.width;
  final h = snap.height;
  final uvW = snap.uvWidth;
  final uvH = snap.uvHeight;
  final scale = _min3(maxShort / w, maxLong / h, 1.0);
  final dw = (w * scale).round();
  final dh = (h * scale).round();
  final rgb = img.Image(width: dw, height: dh);

  for (var dy = 0; dy < dh; dy++) {
    final fy = (dy / scale).floor();
    final fy1 = fy + 1 < h ? fy + 1 : fy;
    for (var dx = 0; dx < dw; dx++) {
      final fx = (dx / scale).floor();
      final fx1 = fx + 1 < w ? fx + 1 : fx;

      // 2×2 luma average (cheap AA on downscale)
      final y00 = snap.y[fy * w + fx];
      final y01 = snap.y[fy * w + fx1];
      final y10 = snap.y[fy1 * w + fx];
      final y11 = snap.y[fy1 * w + fx1];
      final yy = ((y00 + y01 + y10 + y11) >> 2) - 16;

      final cx = (fx >> 1) < uvW ? (fx >> 1) : uvW - 1;
      final cy = (fy >> 1) < uvH ? (fy >> 1) : uvH - 1;
      final uu = snap.u[cy * uvW + cx] - 128;
      final vv = snap.v[cy * uvW + cx] - 128;

      rgb.setPixelRgba(
        dx,
        dy,
        _clamp255((298 * yy + 409 * vv + 128) >> 8),
        _clamp255((298 * yy - 100 * uu - 208 * vv + 128) >> 8),
        _clamp255((298 * yy + 516 * uu + 128) >> 8),
        255,
      );
    }
  }
  return Uint8List.fromList(img.encodeJpg(rgb, quality: quality));
}

/// Shrink + re-encode captured stills that exceed the upload ceiling.
Uint8List fitJpegBytes(Uint8List bytes, int maxBytes, int maxDimension) {
  final decoded = img.decodeImage(bytes);
  if (decoded == null) return bytes;
  var image = decoded;
  var quality = 88;
  var out = bytes;
  for (var round = 0; round < 6 && out.length > maxBytes; round++) {
    final targetWidth = image.width > maxDimension ? maxDimension : (image.width * 0.8).round();
    image = img.copyResize(image, width: targetWidth);
    out = Uint8List.fromList(img.encodeJpg(image, quality: quality));
    quality = (quality - 10).clamp(40, 88);
  }
  return out;
}

double _min3(double a, double b, double c) {
  var m = a < b ? a : b;
  return m < c ? m : c;
}

int _clamp255(int v) => v < 0 ? 0 : (v > 255 ? 255 : v);
