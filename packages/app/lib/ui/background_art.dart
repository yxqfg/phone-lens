import 'package:flutter/material.dart';

/// Shared dimmed illustration watermark (bottom-right, keep proportion).
/// Reused across About / pairing / viewfinder-empty states for a consistent
/// look.
///
/// [positioned] = true (default) renders as a Stack layer pinned bottom-right;
/// false renders inline (scrollable column), so e.g. a settings list shows it
/// only at the very bottom instead of as a fixed watermark.
class BackgroundArt extends StatelessWidget {
  final double widthFactor;
  final bool positioned;
  const BackgroundArt({super.key, this.widthFactor = 0.5, this.positioned = true});

  @override
  Widget build(BuildContext context) {
    final v = MediaQuery.of(context).size.width * widthFactor;
    // Decode at display size, not the 1279×1737 source (~9 MB texture for a
    // half-screen watermark): cacheWidth cuts GPU memory ~4x and keeps the
    // push/pop transitions on this screen smooth on low-end GPUs.
    final dpr = MediaQuery.of(context).devicePixelRatio;
    final cacheWidth = (v * dpr).round().clamp(1, 1279);
    // Dim the ART only — a 5x4 color matrix scales RGB down and leaves alpha
    // untouched, so transparent PNG regions stay transparent (BlendMode.multiply
    // with a black paint would fill transparent pixels with translucent black
    // and darken the whole canvas, which is the "screen goes dark" bug).
    final art = RepaintBoundary(
      // isolate the (static) watermark's repaint from the surrounding page —
      // without a boundary, every animation frame over this screen (page
      // transitions, list scrolls) re-composited the ColorFiltered image too
      child: ColorFiltered(
        colorFilter: const ColorFilter.matrix(<double>[
          0.55, 0, 0, 0, 0,
          0, 0.55, 0, 0, 0,
          0, 0, 0.55, 0, 0,
          0, 0, 0, 1, 0,
        ]),
        child: Image.asset(
          'assets/about_bg.webp',
          fit: BoxFit.contain,
          alignment: Alignment.bottomRight,
          cacheWidth: cacheWidth,
          errorBuilder: (_, __, ___) => const SizedBox.shrink(),
        ),
      ),
    );
    if (positioned) {
      // IgnorePointer: as a Stack layer the art must never swallow taps meant
      // for widgets underneath (settings tiles under the watermark).
      return Positioned(
        right: 0,
        bottom: 0,
        width: v,
        child: IgnorePointer(child: art),
      );
    }
    return Align(
      alignment: Alignment.bottomRight,
      child: SizedBox(width: v, child: art),
    );
  }
}
