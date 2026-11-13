import 'package:flutter/services.dart';
import 'package:mime/mime.dart';
import 'package:open_filex/open_filex.dart';

const MethodChannel _channel = MethodChannel('lensmate/openwith');

/// Extensions (or bare file names) that are plain text but that the mime
/// package either doesn't know or maps to something misleading (`.ts` is an
/// MPEG transport stream there; in a work directory it means TypeScript).
/// Typed as text/plain so the chooser offers editors and readers — Android
/// intent filters match `text/*` / `text/plain` far more often than
/// `application/json` and friends.
const Set<String> _plainTextNames = <String>{
  // docs / config
  'md', 'markdown', 'txt', 'log', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'properties', 'xml', 'gradle', 'lock', 'gitignore', 'gitattributes', 'editorconfig', 'npmrc',
  // code
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'dart', 'py', 'rs', 'go', 'kt', 'kts', 'swift', 'java', 'c', 'h', 'cc',
  'cpp', 'hpp', 'cs', 'rb', 'php', 'lua', 'sql', 'vue', 'svelte', 'css', 'scss', 'sass', 'less',
  // scripts
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  // extensionless
  'makefile', 'dockerfile', 'license', 'readme',
};

/// MIME type handed to the chooser for [path]; `*/*` when nothing is known
/// (the chooser then lists every app that can view a file at all).
String openWithMime(String path) {
  final name = path.split(RegExp(r'[\\/]')).last.toLowerCase();
  final dot = name.lastIndexOf('.');
  final key = dot >= 0 ? name.substring(dot + 1) : name;
  if (_plainTextNames.contains(key)) return 'text/plain';
  return lookupMimeType(name) ?? '*/*';
}

/// 「用其他应用打开」: always shows the system app chooser. Returns null on
/// success, otherwise a message ready for a SnackBar.
///
/// Deliberately NOT OpenFilex.open: it sends `*/*` for any extension outside
/// its small built-in table and fires a bare startActivity, leaving the
/// "list or default app" decision to the ROM. Flyme auto-registers default
/// apps and silently routes such files to one of them (seen: a novel reader,
/// a CAD viewer) — the user never gets a list. An accurate MIME plus
/// Intent.createChooser bypasses default-app resolution on every ROM.
Future<String?> openWithChooser(String localPath) async {
  final mime = openWithMime(localPath);
  try {
    await _channel.invokeMethod<bool>('open', <String, String>{'path': localPath, 'mime': mime});
    return null;
  } on PlatformException catch (e) {
    return switch (e.code) {
      'NO_FILE' => '文件不存在，请重新下载',
      'NO_APP' => '没有可以打开此文件的应用',
      _ => '打开失败: ${e.message ?? e.code}',
    };
  } on MissingPluginException {
    // No native side (non-Android build): fall back to the plugin.
    final res = await OpenFilex.open(localPath, type: mime);
    return res.type == ResultType.done ? null : '打开失败: ${res.message}';
  } catch (e) {
    return '调用外部应用出错: $e';
  }
}
