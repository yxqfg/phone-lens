import 'package:flutter/foundation.dart';

import 'camera_socket.dart';

/// Live connection state, shared so the settings list (which has no socket of
/// its own) can show whether the active device is really connected rather than
/// blindly marking it "active".
final ValueNotifier<LensLinkState> globalLink = ValueNotifier<LensLinkState>(LensLinkState.disconnected);

/// Index of the currently visible HomeScreen tab (0 取景；启用工作后
/// 1 工作 / 2 历史 / 3 设置，未启用则 1 历史 / 2 设置). main.dart keeps _tab
/// in sync with this notifier, so ANY code can switch tabs by assigning it.
/// IndexedStack keeps every tab alive but fires NO route or lifecycle events
/// on tab switches — the viewfinder reads this to tell "reopening the camera
/// now is visible work" from "the user is on another tab and it would only
/// stutter whatever transition is running" (the settings-subpage pop jank).
final ValueNotifier<int> homeTab = ValueNotifier<int>(0);

/// Slot of the 「工作」 tab in the current navigation bar; -1 while the beta
/// switch is off. main.dart assigns this on every rebuild; the viewfinder's
/// camera gating compares homeTab against IT (never a hard-coded index) so
/// the work tab may live in any slot without renumbering anyone.
int workTabIndex = -1;

/// One-shot handoff armed by the work composer before flipping to the
/// viewfinder ("拍一张发工作对话"): the viewfinder's shoot path consumes it,
/// routing the captured JPEG (already past the quality tier) into the work
/// chat instead of the upload queue, then the callback flips back. Cleared
/// on use, by the banner's 取消, or when the work screen disposes.
final ValueNotifier<void Function(Uint8List bytes, String name)?> pendingWorkCapture =
    ValueNotifier<void Function(Uint8List bytes, String name)?>(null);

/// 「工作(Beta)」channel state, mirrors globalLink's semantics for the work
/// websocket (settings page + work screen read it; WorkSocket writes it).
final ValueNotifier<LensLinkState> globalWorkLink = ValueNotifier<LensLinkState>(LensLinkState.disconnected);

/// Result of the latest update check (startup or manual): a newer release is
/// available. Drives the amber "有更新!" badge on Settings → 检查更新, which
/// must flip live while the settings screen is open (the startup check lands
/// seconds after the UI is already built).
final ValueNotifier<bool> globalUpdateAvailable = ValueNotifier<bool>(false);
