import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'core/api.dart';
import 'core/routes.dart';
import 'features/camera/viewfinder_screen.dart';
import 'features/history/history_screen.dart';
import 'features/pair/pair_screen.dart';
import 'features/settings/settings_screen.dart';

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

  void _refresh() => setState(() {});

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
    return Scaffold(
      body: IndexedStack(index: _tab, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.photo_camera), label: '取景'),
          NavigationDestination(icon: Icon(Icons.history), label: '历史'),
          NavigationDestination(icon: Icon(Icons.settings), label: '设置'),
        ],
      ),
    );
  }
}
