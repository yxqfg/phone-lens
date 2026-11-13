import 'package:flutter_test/flutter_test.dart';
import 'package:lens_mate/core/open_with.dart';

// 「用其他应用打开」的 MIME 推断：魅族 Flyme 上 `*/*` 会被系统默认应用
// 静默劫持（不弹应用列表），所以代码/配置文件必须落到 text/plain。
void main() {
  group('openWithMime', () {
    test('code and config files are text/plain', () {
      const paths = [
        '/a/b/readme.md',
        r'C:\w\src\index.ts',
        '/x/main.dart',
        '/x/app.py',
        '/x/package.json',
        '/x/config.yaml',
        '/x/.gitignore',
        '/x/Makefile',
        '/x/types.d.ts',
        '/x/UPPER.MD',
      ];
      for (final p in paths) {
        expect(openWithMime(p), 'text/plain', reason: p);
      }
    });

    test('.ts means TypeScript, not the mime package\'s MPEG transport stream', () {
      expect(openWithMime('/x/a.ts'), 'text/plain');
    });

    test('known document and media types keep their real MIME', () {
      expect(openWithMime('/x/doc.pdf'), 'application/pdf');
      expect(openWithMime('/x/pic.PNG'), 'image/png');
      expect(openWithMime('/x/page.html'), 'text/html');
    });

    test('unknown names fall back to */*', () {
      expect(openWithMime('/x/blob.zzzunknown'), '*/*');
      expect(openWithMime('/x/noext'), '*/*');
    });
  });
}
