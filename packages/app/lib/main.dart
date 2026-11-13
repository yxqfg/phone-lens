import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'core/api.dart';
import 'core/global_link.dart';
import 'core/routes.dart';
import 'core/update_check.dart';
import 'core/upload_queue.dart';
import 'features/camera/viewfinder_screen.dart';
import 'features/history/history_screen.dart';
import 'features/pair/pair_screen.dart';
import 'features/settings/settings_screen.dart';
import 'features/work/work_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // keep the app UI always portrait (it doesn't follow the system auto-rotate);
  // the PC orientation is driven by the phone's SENSOR, not this lock.
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);
  final prefs = await SharedPreferences.getInstance();
  final store = LensStore(prefs);
  // restore the on-disk upload queue and resume any shots a previous session
  // left behind — before the first frame, so the badge is correct immediately
  await UploadQueue.instance.init(store);
  // periodic send-history wipe selected by the user (startup / daily / …)
  await store.maybeAutoCleanHistory();
  runApp(LensApp(store: store));
}

class LensApp extends StatelessWidget {
  final LensStore store;
  const LensApp({super.key, required this.store});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'PhoneLens',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF3B7CB5), brightness: Brightness.dark),
        useMaterial3: true,
      ),
      home: HomeScreen(store: store),
      navigatorObservers: [routeObserver],
    );
  }
}

class HomeScreen extends StatefulWidget {
  final LensStore store;
  const HomeScreen({super.key, required this.store});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _tab = 0;
  bool _updateDialogShown = false;

  /// Startup update check: EVERY launch (user request — no daily throttle).
  /// Silent on failure; a newer release pops the dialog AND lights the amber
  /// "有更新!" badge next to Settings → 检查更新 — unless the user tapped
  /// 今日忽略 earlier TODAY (the badge still lights; only the dialog stays
  /// quiet until tomorrow).
  Future<void> _maybeAutoCheckUpdate() async {
    final info = await checkForUpdate();
    if (!mounted) return;
    final newer = info?.isNewer ?? false;
    await widget.store.setUpdateAvailable(newer);
    globalUpdateAvailable.value = newer;
    if (info == null || !info.isNewer || !mounted || _updateDialogShown) return;
    if (widget.store.updateSnoozedToday) return; // 今日忽略 in effect
    _updateDialogShown = true;
    await showUpdateDialog(context, info, onSnoozeToday: widget.store.snoozeUpdateForToday);
    _updateDialogShown = false;
  }

  void _refresh() => setState(() {});

  @override
  void initState() {
    super.initState();
    _maybeAutoCheckUpdate();
    // Programmatic tab switches (e.g. the work composer arming a capture then
    // flipping to/from the viewfinder) drive homeTab directly — mirror it into
    // _tab so IndexedStack actually follows. Assignment from the nav bar sets
    // homeTab first, so this listener also fires there (idempotent).
    homeTab.addListener(_onHomeTab);
  }

  @override
  void dispose() {
    homeTab.removeListener(_onHomeTab);
    super.dispose();
  }

  void _onHomeTab() {
    final i = homeTab.value;
    if (i != _tab && mounted) setState(() => _tab = i);
  }

  @override
  Widget build(BuildContext context) {
    // No paired receiver → pairing flow (also covers "removed them all").
    final server = widget.store.server;
    if (server == null) {
      return PairScreen(store: widget.store, onPaired: _refresh);
    }
    final pages = [
      // keyed by active server id so switching receivers rebuilds the socket
      ViewfinderScreen(store: widget.store, key: ValueKey('view-${server.id}')),
      HistoryScreen(store: widget.store),
      SettingsScreen(store: widget.store, onChanged: _refresh),
    ];
    final destinations = [
      const NavigationDestination(icon: Icon(Icons.photo_camera), label: '取景'),
      const NavigationDestination(icon: Icon(Icons.history), label: '历史'),
      const NavigationDestination(icon: Icon(Icons.settings), label: '设置'),
    ];
    // 「工作(Beta)」mounts ONLY while the settings switch is on — in slot 1,
    // right of 取景 (user spec). The viewfinder's camera gating compares
    // homeTab against workTabIndex (never a hard-coded slot), so it follows
    // this order automatically. Toggling the switch rebuilds this screen via
    // the settings onChanged callback; when removed, IndexedStack drops its
    // State and the work socket tears down with it.
    final workBeta = widget.store.workBetaEnabled;
    workTabIndex = workBeta ? 1 : -1;
    if (workBeta) {
      pages.insert(1, WorkScreen(store: widget.store, key: const ValueKey('work')));
      destinations.insert(1, const NavigationDestination(icon: Icon(Icons.workspaces_outline), label: '工作'));
    }
    // Clamp AND write the clamped value back into homeTab: every consumer of
    // homeTab (viewfinder camera gating, work bounce-back) must see the same
    // slot the IndexedStack shows, or the global tab drifts until the next
    // nav-bar tap. The mirror listener no-ops on this write (i == _tab
    // already). Only the viewfinder listener also fires: it can't setState
    // synchronously (its init path awaits first), and any armed work-capture
    // it clears is always already null on these clamp paths (tab switches and
    // the shoot handoff consume it before they can leave us here).
    if (_tab >= pages.length) {
      _tab = pages.length - 1;
      homeTab.value = _tab;
    }
    // a bounce-back racing a beta-off rebuild can hand us -1 (workTabIndex
    // when the switch just flipped): IndexedStack would blank the whole body
    if (_tab < 0) {
      _tab = 0;
      homeTab.value = _tab;
    }
    return Scaffold(
      body: IndexedStack(index: _tab, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) {
          // publish ONLY through homeTab: the mirror listener sets _tab (one
          // setState per tap instead of two), and tab-aware listeners
          // (viewfinder camera gating) still see the new tab before this
          // frame's rebuild because listeners run synchronously.
          homeTab.value = i;
        },
        destinations: destinations,
      ),
    );
  }
}
