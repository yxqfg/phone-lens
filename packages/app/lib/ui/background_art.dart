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
    // Dim the ART only — a 5x4 color matrix scales RGB down and leaves alpha
    // untouched, so transparent PNG regions stay transparent (BlendMode.multiply
    // with a black paint would fill transparent pixels with translucent black
    // and darken the whole canvas, which is the "screen goes dark" bug).
    final art = ColorFiltered(
      colorFilter: const ColorFilter.matrix(<double>[
        0.55, 0, 0, 0, 0,
        0, 0.55, 0, 0, 0,
        0, 0, 0.55, 0, 0,
        0, 0, 0, 1, 0,
      ]),
      child: Image.asset(
        'assets/about_bg.png',
        fit: BoxFit.contain,
        alignment: Alignment.bottomRight,
        errorBuilder: (_, __, ___) => const SizedBox.shrink(),
      ),
    );
    if (positioned) {
      return Positioned(right: 0, bottom: 0, width: v, child: art);
    }
    return Align(
      alignment: Alignment.bottomRight,
      child: SizedBox(width: v, child: art),
    );
  }
}
