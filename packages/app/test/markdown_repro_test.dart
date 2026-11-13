import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:lens_mate/features/work/work_screen.dart' show workMarkdownForTest;

void main() {
  testWidgets('full test message renders with zero errors', (tester) async {
    tester.view.physicalSize = const Size(960, 3600);
    tester.view.devicePixelRatio = 2.0;
    addTearDown(tester.view.reset);
    final errors = <FlutterErrorDetails>[];
    FlutterError.onError = (details) => errors.add(details);
    final key = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(useMaterial3: true),
        home: Scaffold(
          backgroundColor: const Color(0xFF15181D),
          body: RepaintBoundary(
            key: key,
            child: SingleChildScrollView(
              child: Container(
                padding: const EdgeInsets.all(12),
                width: 480,
                child: workMarkdownForTest(_msg),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle(const Duration(seconds: 2));
    await expectLater(find.byKey(key), matchesGoldenFile('goldens/markdown_fixed.png'));
    debugPrint('errors captured: ${errors.length}');
    for (final e in errors.take(5)) {
      debugPrint('ERR: ${e.exception}');
    }
    expect(errors, isEmpty, reason: 'task-list 之类的内容不得再触发任何渲染异常');
  });
}

const String _msg = '''
好，下面是几组示例，覆盖常用语法。你可以对照看看哪些渲染正常、哪些没有渲染：

**1. 行内公式**：质能方程 \$E = mc^2\$，欧拉恒等式 \$e^{i\\pi} + 1 = 0\$。

**2. 块级公式**：

\$\$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
\$\$

**3. 多行对齐公式**：

\$\$
\\begin{aligned}
(a+b)^2 &= a^2 + 2ab + b^2 \\\\
(a-b)^2 &= a^2 - 2ab + b^2
\\end{aligned}
\$\$

**4. 矩阵与分式**：

\$\$
A = \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}, \\qquad
\\det(A) = -2, \\qquad
\\frac{\\partial u}{\\partial t} = \\alpha \\nabla^2 u
\$\$

**5. 文字排版**：**粗体**、*斜体*、~~删除线~~、`行内代码`、[链接](https://obsidian.md)、> 引用文字

**6. 列表与嵌套**：
1. 第一项
   - 子项 A
   - 子项 B
2. 第二项

- [ ] 未完成待办
- [x] 已完成待办

**7. 表格**：

| 语法 | 效果 | 备注 |
|:---|:---:|---:|
| `**b**` | **粗体** | 行内 |
| `\$x^2\$` | 上标 | 数学 |
| `==x==` | ==高亮== | 扩展语法 |

**8. 代码块**：

```python
def fib(n: int) -> int:
    return n if n < 2 else fib(n - 1) + fib(n - 2)
```

**9. 其他**：

水平分割线：

---

脚注引用[^1]。

[^1]: 这是一条脚注。
''';
