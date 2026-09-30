import 'package:flutter/foundation.dart';

import 'camera_socket.dart';

/// Live connection state, shared so the settings list (which has no socket of
/// its own) can show whether the active device is really connected rather than
/// blindly marking it "active".
final ValueNotifier<LensLinkState> globalLink = ValueNotifier<LensLinkState>(LensLinkState.disconnected);

/// Result of the latest update check (startup or manual): a newer release is
/// available. Drives the amber "有更新!" badge on Settings → 检查更新, which
/// must flip live while the settings screen is open (the startup check lands
/// seconds after the UI is already built).
final ValueNotifier<bool> globalUpdateAvailable = ValueNotifier<bool>(false);
