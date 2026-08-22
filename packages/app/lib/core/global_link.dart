import 'package:flutter/foundation.dart';

import 'camera_socket.dart';

/// Live connection state, shared so the settings list (which has no socket of
/// its own) can show whether the active device is really connected rather than
/// blindly marking it "active".
final ValueNotifier<LensLinkState> globalLink = ValueNotifier<LensLinkState>(LensLinkState.disconnected);
