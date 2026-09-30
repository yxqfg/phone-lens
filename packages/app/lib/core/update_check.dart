import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

/// One update-check result from the public release feeds.
class UpdateInfo {
  final String currentVersion;
  final String latestVersion;
  final String changelog;
  final String downloadUrl;
  const UpdateInfo({
    required this.currentVersion,
    required this.latestVersion,
    required this.changelog,
    required this.downloadUrl,
  });

  bool get isNewer => compareVersions(latestVersion, currentVersion) > 0;
}

/// Gitee first (CN-reachable, the default APK source), GitHub as fallback.
/// Both feeds share the GitHub-shaped JSON (tag_name / body / assets).
const _releaseFeeds = [
  'https://gitee.com/api/v5/repos/qianfengbingtang/phone-lens/releases/latest',
  'https://api.github.com/repos/yxqfg/phone-lens/releases/latest',
];

/// Only https on the expected release hosts. The APK link comes from the feed
/// response (attacker-influenceable data), so it is re-validated before the
/// app ever navigates to it — never localhost/loopback/private, never a
/// different scheme or domain.
const _trustedReleaseHosts = {'gitee.com', 'github.com'};

bool isTrustedReleaseUrl(String raw) {
  final Uri uri;
  try {
    uri = Uri.parse(raw);
  } catch (_) {
    return false;
  }
  return uri.scheme == 'https' && _trustedReleaseHosts.contains(uri.host);
}

/// Segment-wise x.y.z comparison ("v" prefix tolerated, missing parts = 0).
int compareVersions(String a, String b) {
  List<int> parse(String v) => v
      .trim()
      .replaceFirst(RegExp(r'^v'), '')
      .split('.')
      .map((e) => int.tryParse(e) ?? 0)
      .toList();
  final pa = parse(a);
  final pb = parse(b);
  for (var i = 0; i < 3; i++) {
    final av = i < pa.length ? pa[i] : 0;
    final bv = i < pb.length ? pb[i] : 0;
    if (av != bv) return av.compareTo(bv);
  }
  return 0;
}

/// Query the release feeds for the newest public APK.
///
/// Returns null when both feeds are unreachable or carry no trusted APK
/// asset — automatic checks must fail silently (no toast, no dialog).
Future<UpdateInfo?> checkForUpdate({http.Client? client}) async {
  final own = client ?? http.Client();
  // current version must never fail the whole check: on the off chance the
  // plugin throws, degrade to 0.0.0 (worst case: an update prompt shows up)
  var current = '0.0.0';
  try {
    current = (await PackageInfo.fromPlatform()).version;
  } catch (_) {}
  try {
    for (final feed in _releaseFeeds) {
      try {
        final resp = await own
            .get(Uri.parse(feed), headers: {'accept': 'application/json'})
            .timeout(const Duration(seconds: 6));
        if (resp.statusCode != 200) continue;
        final data = jsonDecode(resp.body);
        if (data is! Map<String, dynamic>) continue;
        final tag = data['tag_name'];
        if (tag is! String || tag.isEmpty) continue;

        String? apkUrl;
        final assets = data['assets'];
        if (assets is List) {
          for (final a in assets) {
            if (a is! Map) continue;
            if (a['name'] != 'app-release.apk') continue;
            final u = a['browser_download_url'];
            if (u is String && isTrustedReleaseUrl(u)) apkUrl = u;
          }
        }
        if (apkUrl == null) continue; // no trusted APK asset → try next feed

        return UpdateInfo(
          currentVersion: current,
          latestVersion: tag.replaceFirst(RegExp(r'^v'), '').trim(),
          changelog: (data['body'] is String ? data['body'] as String : '').trim(),
          downloadUrl: apkUrl,
        );
      } on TimeoutException {
        continue;
      } catch (_) {
        continue; // malformed feed → try the fallback
      }
    }
    return null;
  } finally {
    if (client == null) own.close();
  }
}

/// Open the APK download in the system browser (external application so the
/// user's download flow — the same one as the QR code — takes over). The URL
/// is validated again at the moment of use, not just when it was parsed.
Future<bool> openDownloadUrl(String url) {
  if (!isTrustedReleaseUrl(url)) return Future.value(false);
  return launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
}

/// Shared "new version available" dialog (startup prompt + Settings entry).
/// 需要外部 context 之外不持有任何状态，弹完即走。
Future<void> showUpdateDialog(BuildContext context, UpdateInfo info) {
  return showDialog<void>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text('发现新版本 v${info.latestVersion}'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('当前版本 v${info.currentVersion}，建议更新到最新版。',
              style: const TextStyle(fontSize: 13)),
          if (info.changelog.isNotEmpty) ...[
            const SizedBox(height: 10),
            Flexible(
              child: SingleChildScrollView(
                child: Text(
                  info.changelog,
                  style: const TextStyle(fontSize: 13, color: Colors.white70, height: 1.5),
                ),
              ),
            ),
          ],
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('稍后再说')),
        FilledButton.icon(
          icon: const Icon(Icons.download, size: 18),
          label: const Text('去下载'),
          onPressed: () async {
            Navigator.pop(ctx);
            await openDownloadUrl(info.downloadUrl);
          },
        ),
      ],
    ),
  );
}
