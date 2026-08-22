import 'package:flutter/material.dart';

/// Global route observer: lets screens react when a route covers them
/// (release exclusive resources like the camera) or uncovers them
/// (reacquire). Mounted on the MaterialApp in main.dart.
final RouteObserver<PageRoute<dynamic>> routeObserver = RouteObserver<PageRoute<dynamic>>();
