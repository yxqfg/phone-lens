# ML Kit (mobile_scanner) instantiates its component registrars via
# reflection; R8 stripping them breaks scanner init in release builds
# ("Invalid component registrar" -> MobileScanner error widget).
# Documented requirement of mobile_scanner for minified Android builds.
-keep class com.google.mlkit.** { *; }
-dontwarn com.google.mlkit.**
-keep class com.google.android.gms.internal.mlkit_vision_common.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_internal.** { *; }
-dontwarn com.google.android.gms.**
