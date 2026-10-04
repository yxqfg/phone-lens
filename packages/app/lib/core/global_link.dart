import 'package:flutter/foundation.dart';

import 'camera_socket.dart';

/// Live connection state, shared so the settings list (which has no socket of
/// its own) can show whether the active device is really connected rather than
/// blindly marking it "active".
final ValueNotifier<LensLinkState> globalLink = ValueNotifier<LensLinkState>(LensLinkState.disconnected);

/// Index of the currently visible HomeScreen tab (0 取景 / 1 历史 / 2 设置).
/// IndexedStack keeps every tab alive but fires NO route or lifecycle events
/// on tab switches — the viewfinder reads this to tell "reopening the camera
/// now is visible work" from "the user is on another tab and it would only
/// stutter whatever transition is running" (the settings-subpage pop jank).
final ValueNotifier<int> homeTab = ValueNotifier<int>(0);

/// Result of the latest update check (startup or manual): a newer release is
/// available. Drives the amber "有更新!" badge on Settings → 检查更新, which
/// must flip live while the settings screen is open (the startup check lands
/// seconds after the UI is already built).
final ValueNotifier<bool> globalUpdateAvailable = ValueNotifier<bool>(false);
