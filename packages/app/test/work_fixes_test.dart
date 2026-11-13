import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:lens_mate/features/work/work_screen.dart' show workMarkdownForTest;

void main() {
  testWidgets('LaTeX formulas wrap in horizontal scroll view and scroll cleanly', (tester) async {
    final errors = <FlutterErrorDetails>[];
    FlutterError.onError = (details) => errors.add(details);

    const longInline = r'行内长公式: $A + B + C + D + E + F + G + H + I + J + K + L + M + N + O + P + Q + R + S + T + U + V + W + X + Y + Z = 100$ 结束';
    const longBlock = r'''
块级长公式:
$$
\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi} + \sum_{k=1}^{\infty} \frac{x^k}{k!} + \frac{a+b+c+d+e+f+g+h+i+j+k+l+m+n}{1+2+3+4+5+6+7+8+9+10}
$$
''';

    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(useMaterial3: true),
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 280, // 限制在窄屏幕宽度
              child: SingleChildScrollView(
                child: Column(
                  children: [
                    workMarkdownForTest(longInline),
                    workMarkdownForTest(longBlock),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(errors, isEmpty, reason: '长公式渲染不得触发任何异常');

    // 查找所有横向滚动容器
    final horizontalScrolls = find.byWidgetPredicate(
      (widget) => widget is SingleChildScrollView && widget.scrollDirection == Axis.horizontal,
    );
    expect(horizontalScrolls, findsAtLeastNWidgets(2), reason: '长行内公式和长块级公式均应具备水平滚动视图');

    // 验证手势拖拽滚动不抛错
    await tester.drag(horizontalScrolls.first, const Offset(-50, 0));
    await tester.pumpAndSettle();
    expect(errors, isEmpty);
  });

  testWidgets('Dark theme headings and tables render cleanly without light fallbacks', (tester) async {
    final errors = <FlutterErrorDetails>[];
    FlutterError.onError = (details) => errors.add(details);

    const markdownText = '''
# 一级大标题
## 二级中标题
### 三级小标题

> 这是一段引用文本

| 列一（标题） | 列二（数据） | 列三（备注） |
| :--- | :---: | ---: |
| 属性 A | 12345 | 正常 |
| 属性 B | 67890 | 警告 |

```dart
void main() {
  print("暗黑代码块");
}
```
''';

    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(useMaterial3: true),
        home: Scaffold(
          backgroundColor: const Color(0xFF15181D),
          body: SingleChildScrollView(
            child: SizedBox(
              width: 320,
              child: workMarkdownForTest(markdownText),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(errors, isEmpty, reason: '深色表格、代码块与标题不得触发任何异常');
  });
}
