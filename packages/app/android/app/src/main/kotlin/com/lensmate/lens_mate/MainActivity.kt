package com.lensmate.lens_mate

import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream

/**
 * LensMate native JPEG encoder.
 *
 * `lensmate/jpeg.encode` turns a YUV_420_888 frame (already compacted to
 * dense Y / U / V planes on the Dart side) into a JPEG using Android's
 * system libjpeg via YuvImage — ~10-20ms per 720p frame, vs 100ms+ for the
 * pure-Dart fallback. Output stays sensor-oriented; the receiver rotates it
 * (the phone reports the rotation via the stream handshake).
 */
class MainActivity : FlutterActivity() {
    private val channelName = "lensmate/jpeg"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val handler = Handler(Looper.getMainLooper())
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName).setMethodCallHandler { call, result ->
            when (call.method) {
                "ping" -> result.success(true)
                "encode" -> {
                    val args = call.arguments as? Map<*, *>
                    val w = (args?.get("w") as? Number)?.toInt() ?: 0
                    val h = (args?.get("h") as? Number)?.toInt() ?: 0
                    val quality = (args?.get("quality") as? Number)?.toInt() ?: 60
                    val target = (args?.get("target") as? Number)?.toInt() ?: 0
                    val y = (args?.get("y") as? ByteArray)
                    val u = (args?.get("u") as? ByteArray)
                    val v = (args?.get("v") as? ByteArray)
                    if (w <= 0 || h <= 0 || y == null || u == null || v == null) {
                        result.error("BAD_FRAME", "invalid yuv planes", null)
                        return@setMethodCallHandler
                    }
                    handler.post {
                        try {
                            val out = encodeJpeg(w, h, quality, target, y, u, v)
                            result.success(out)
                        } catch (e: Exception) {
                            result.error("ENCODE_FAILED", e.message, null)
                        }
                    }
                }
                else -> result.notImplemented()
            }
        }
    }

    /**
     * YUV→NV21→JPEG with integer downscaling: the raw sensor frame is far
     * too large for a framing preview (1080p JPEGs at q70 run 300-500KB and
     * wreck the stream), so [target] bounds the LONG edge — a scale factor
     * of 2-4 lands a 1080p stream at a crisp ~540×360 preview frame.
     */
    private fun encodeJpeg(w: Int, h: Int, quality: Int, target: Int, y: ByteArray, u: ByteArray, v: ByteArray): ByteArray {
        val uvW = (w + 1) shr 1
        val uvH = (h + 1) shr 1
        val scale = if (target > 0) maxOf(1, (maxOf(w, h) + target - 1) / target) else 1
        val dw = w / scale
        val dh = h / scale
        val duvW = (dw + 1) shr 1
        val duvH = (dh + 1) shr 1
        // NV21 layout: full Y plane, then interleaved V U (2 bytes per chroma sample).
        val nv21 = ByteArray(dw * dh + duvW * duvH * 2)
        var p = 0
        for (row in 0 until dh) {
            val sy = row * scale
            val yBase = sy * w
            for (col in 0 until dw) {
                nv21[p++] = y[yBase + col * scale]
            }
        }
        for (row in 0 until duvH) {
            val sy = row * scale
            val uvBase = sy * uvW
            for (col in 0 until duvW) {
                val i = uvBase + col * scale
                nv21[p++] = v[i]
                nv21[p++] = u[i]
            }
        }
        val image = YuvImage(nv21, ImageFormat.NV21, dw, dh, null)
        val out = ByteArrayOutputStream()
        image.compressToJpeg(Rect(0, 0, dw, dh), quality, out)
        return out.toByteArray()
    }
}
