import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart' show Uint8List, compute;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/api.dart';
import '../../core/camera_socket.dart' show LensLinkState;
import '../../core/global_link.dart';
import '../../core/jpeg.dart' show fitJpegBytes;
import '../../core/open_with.dart';
import '../../core/upload_queue.dart' show UploadQueue;
import 'work_store.dart';

/// Compute-arg wrapper: compress a picked/captured image into the work
/// channel's prompt budget (base64 rides inside a JSON WS frame, so keep the
/// payload ~≤1.2MB / 1600px before the 1.33× base64 inflation).
class _WorkImgArgs {
  const _WorkImgArgs(this.bytes);
  final Uint8List bytes;
}

Uint8List _fitWorkImage(_WorkImgArgs a) => fitJpegBytes(a.bytes, 1200 * 1024, 1600);

/// 气泡里所有 GptMarkdown 的公共出口。两处(助手气泡/流式行)共用同一套
/// 参数与避险配置。
///
/// 避险一: gpt_markdown 1.4.1 的任务列表复选框默认用 material_ui 的
/// Checkbox,而它被塞进 Text.rich 的 WidgetSpan——Text 的 LookupBoundary
/// 挡住了向上找 Material 的路径,构建期必抛 "No Material widget found":
/// debug 下变成 100000×100000 的红块(ErrorWidget)并把所在行撑爆出黄黑
/// 斜纹(2026-11-13 真机实测)。用 checkboxBuilder/radioOptionBuilder 整体
/// 换成下面的纯自绘勾选框,彻底绕开 material 组件。
/// 避险二: 外面再包一层透明 Material,兜住其他潜在的 material 依赖组件。
const Color _workAccent = Color(0xFF7FB8E6);

final GptMarkdownStyleSheet _workMarkdownStyleSheet = GptMarkdownStyleSheet(
  heading: const HeadingStyle(
    textStyle: TextStyle(
      color: Colors.white,
      fontWeight: FontWeight.w600,
    ),
    dividerColor: Colors.white24,
    dividerThickness: 1.0,
  ),
  table: const TableStyle(
    borderColor: Colors.white24,
    borderWidth: 1.0,
    borderRadius: Radius.circular(6),
    cellPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 6),
    headerBackground: Color(0xFF2C313A),
    headerTextStyle: TextStyle(
      fontWeight: FontWeight.w600,
      color: Colors.white,
    ),
    rowStripeColor: Color(0x0FFFFFFF),
  ),
  codeBlock: const CodeBlockStyle(
    backgroundColor: Color(0xFF1E2228),
    borderColor: Colors.white12,
    textColor: Color(0xFFD4D4D4),
  ),
  // 行内代码:三色必须显式全给——样式表里 inlineCode 是整对象替换,留空的
  // 字段会由库按 material_ui 的浅色 fallback 补(黑字/黑底),叠在暗色气泡上
  // 就是黑底黑字(2026-11-13 真机)。配色与 codeBlock 同款保持视觉统一。
  inlineCode: const InlineCodeStyle(
    color: Color(0xFFD4D4D4),
    backgroundColor: Color(0xFF1E2228),
    borderColor: Colors.white12,
  ),
  blockQuote: const BlockQuoteStyle(
    barColor: _workAccent,
    backgroundColor: Color(0x147FB8E6),
  ),
  hr: const HrStyle(
    color: Colors.white24,
  ),
  latex: const LatexStyle(
    scrollBlockHorizontally: true,
  ),
);

Widget _workMarkdown(String text) {
  return Material(
    type: MaterialType.transparency,
    child: GptMarkdown(
      text,
      useDollarSignsForLatex: true, // $...$/$$...$$ 默认关,模型最常用这套语法
      styleSheet: _workMarkdownStyleSheet,
      inlineLatexBuilder: (details) => details.asWidgetSpan(
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          clipBehavior: Clip.hardEdge,
          child: details.defaultWidget(),
        ),
      ),
      checkboxBuilder: _workCheckboxRow,
      radioOptionBuilder: _workRadioRow,
      style: const TextStyle(fontSize: 15, height: 1.45, color: Colors.white),
    ),
  );
}

/// Golden 测试用:与气泡内完全相同的渲染配置(_workMarkdown 的测试出口)。
Widget workMarkdownForTest(String text) => _workMarkdown(text);

Widget _workCheckboxRow(BuildContext context, bool checked, Widget content, CheckboxStyle style) {
  return Row(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.baseline,
    textBaseline: TextBaseline.alphabetic,
    children: [
      Text.rich(
        WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 5),
            child: Container(
              width: 16,
              height: 16,
              decoration: BoxDecoration(
                color: checked ? _workAccent.withValues(alpha: 0.30) : null,
                border: Border.all(color: checked ? _workAccent : Colors.white38, width: 1.6),
                borderRadius: BorderRadius.circular(3),
              ),
              child: checked ? const Icon(Icons.check, size: 13, color: _workAccent) : null,
            ),
          ),
        ),
      ),
      Flexible(child: content),
    ],
  );
}

Widget _workRadioRow(BuildContext context, bool selected, Widget content, CheckboxStyle style) {
  return Row(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.baseline,
    textBaseline: TextBaseline.alphabetic,
    children: [
      Text.rich(
        WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 5),
            child: Container(
              width: 16,
              height: 16,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: selected ? _workAccent : Colors.white38, width: 1.6),
              ),
              child: selected
                  ? Padding(padding: const EdgeInsets.all(3), child: Container(decoration: const BoxDecoration(shape: BoxShape.circle, color: _workAccent)))
                  : null,
            ),
          ),
        ),
      ),
      Flexible(child: content),
    ],
  );
}

String _sniffMediaType(Uint8List b) =>
    b.length > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF ? 'image/jpeg' : 'image/png';

/// Suggestion panel mode: `/` command directory or `@` mentions.
enum _SuggestKind { command, mention }

/// 「工作(Beta)」tab root. Hidden entirely until the settings switch is on;
/// shows the session list first, and dives into the mirrored conversation on
/// tap. Everything here talks to the host through [WorkStore].
class WorkScreen extends StatefulWidget {
  final LensStore store;
  const WorkScreen({super.key, required this.store});

  @override
  State<WorkScreen> createState() => _WorkScreenState();
}

class _WorkScreenState extends State<WorkScreen> with WidgetsBindingObserver {
  final WorkStore work = WorkStore.instance;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    work.attach(widget.store);
  }

  @override
  void didUpdateWidget(WorkScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 重新配对/切换接收端后 main._refresh 会带着同一个 State rebuild 本页
    // （const key），store.server 已换新 host/token——attach 幂等：配置没变
    // 时是 no-op，变了会拆掉旧 socket 朝新地址重连（与取景页 didUpdateWidget
    // 同一套防线；缺了它，换 IP 重配对后工作页会永远朝旧地址退避）。
    work.attach(widget.store);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    // Unmount means the work tab is GONE for real: beta switched off (the
    // settings path already detached — idempotent no-op here) or every pairing
    // was deleted (main swaps in PairScreen). Without this the singleton
    // socket keeps retrying a receiver that no longer exists — a ghost link
    // nobody owns.
    work.detach();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Android freezes Timers in the background: on return, retry the link NOW
    if (state == AppLifecycleState.resumed) work.kick();
  }

  @override
  Widget build(BuildContext context) {
    final scale = widget.store.workFontSizeScale;
    return MediaQuery(
      data: MediaQuery.of(context).copyWith(
        textScaler: TextScaler.linear(scale),
      ),
      child: ValueListenableBuilder<String?>(
        valueListenable: work.subscribedId,
        builder: (context, sid, _) {
          if (sid == null) return _SessionList(store: widget.store, work: work);
          return _ChatView(store: widget.store, work: work, sessionId: sid);
        },
      ),
    );
  }
}

// ── session list ──────────────────────────────────────────────────────────────

class _SessionList extends StatefulWidget {
  final LensStore store;
  final WorkStore work;
  const _SessionList({required this.store, required this.work});

  @override
  State<_SessionList> createState() => _SessionListState();
}

class _SessionListState extends State<_SessionList> {
  String _query = '';
  // in-flight "+" requests per group key: disables the button while minting
  // (a double-tap would pile blank sessions — dsh mints one per create call)
  final Set<String> _creatingGroups = {};
  // in-flight archive requests per session id (tile shows a mini spinner)
  final Set<String> _archivingSessions = {};

  WorkStore get work => widget.work;

  /// Group key = working-directory basename (the desktop's workspace notion);
  /// sessions without a cwd land in the trailing catch-all group. Basename
  /// logic lives on the store (cwdBaseName) so the devices sheet's
  /// "same project" tier reads the exact same grouping.
  String _groupKey(WorkSessionRow r) {
    final cwd = r.cwd;
    if (cwd == null || cwd.isEmpty) return '其他';
    return WorkStore.cwdBaseName(cwd) ?? '其他';
  }

  /// "+" at the trailing edge of a workspace-group header: mint a blank
  /// session in that directory and drop straight into it (subscribedId flip
  /// swaps the list for the chat view — no Navigator involved).
  Widget _groupPlusButton(String key, String cwd) {
    final busy = _creatingGroups.contains(key);
    return IconButton(
      onPressed: busy
          ? null
          : () async {
              setState(() => _creatingGroups.add(key));
              try {
                final sid = await work.createSession(cwd);
                if (!mounted) return;
                if (sid != null) {
                  work.subscribe(sid);
                } else {
                  // the list page renders sessionListError only when EMPTY —
                  // surface the failure here or it dies silently
                  ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                    content: Text(work.sessionListError.value ?? '新建会话失败'),
                    duration: const Duration(seconds: 3),
                  ));
                  work.sessionListError.value = null;
                }
              } finally {
                if (mounted) setState(() => _creatingGroups.remove(key));
              }
            },
      icon: busy
          ? const SizedBox(width: 11, height: 11, child: CircularProgressIndicator(strokeWidth: 1.6, color: Colors.white38))
          : const Icon(Icons.add, size: 14, color: Colors.white38),
      visualDensity: VisualDensity.compact,
      constraints: const BoxConstraints(minWidth: 30, minHeight: 24),
      padding: const EdgeInsets.only(left: 6),
      tooltip: '在此工作区新建对话',
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF15181D),
      appBar: AppBar(
        backgroundColor: const Color(0xFF15181D),
        title: const Text('工作'),
        actions: [
          ValueListenableBuilder<LensLinkState>(
            valueListenable: globalWorkLink,
            builder: (context, st, _) => Padding(
              padding: const EdgeInsets.only(right: 14),
              child: Center(child: linkChip(st)),
            ),
          ),
        ],
      ),
      body: ValueListenableBuilder<List<WorkSessionRow>>(
        valueListenable: work.sessions,
        builder: (context, rows, _) {
          final q = _query.toLowerCase();
          final filtered = q.isEmpty
              ? rows
              : rows.where((r) {
                  final t = (r.title ?? '').toLowerCase();
                  final c = (r.cwd ?? '').toLowerCase();
                  return t.contains(q) || c.contains(q);
                }).toList();
          // fold into cwd groups (group order = newest member first)
          final groups = <String, List<WorkSessionRow>>{};
          final order = <String>[];
          for (final r in filtered) {
            final key = _groupKey(r);
            if (!groups.containsKey(key)) {
              groups[key] = [];
              order.add(key);
            }
            groups[key]!.add(r);
          }
          order.sort((a, b) => groups[b]!.first.updatedAt.compareTo(groups[a]!.first.updatedAt));
          final children = <Widget>[];
          for (final key in order) {
            final members = groups[key]!;
            final hasCwd = key != '其他' && (members.first.cwd?.isNotEmpty ?? false);
            children.add(Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
              child: Row(
                children: [
                  const Icon(Icons.folder_outlined, size: 13, color: Colors.white30),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(key == '其他' ? '其他会话' : key, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Colors.white30)),
                  ),
                  Text('${members.length}', style: const TextStyle(fontSize: 11, color: Colors.white24)),
                  if (hasCwd)
                    _groupPlusButton(key, members.first.cwd!),
                ],
              ),
            ));
            for (final r in members) {
              children.add(_sessionTile(r, showCwd: key == '其他'));
            }
          }
          return RefreshIndicator(
            onRefresh: () => work.refreshSessions(),
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.only(bottom: 12),
              children: [
                // 4003 = the PC side's beta switch is off: a generic "未连接"
                // chip tells the user nothing actionable, so surface the real
                // cause (phone on / PC off) instead
                ValueListenableBuilder<bool>(
                  valueListenable: work.hostRefused,
                  builder: (context, refused, _) => refused
                      ? Padding(
                          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                            decoration: BoxDecoration(color: const Color(0x26E57373), borderRadius: BorderRadius.circular(12)),
                            child: Row(
                              children: [
                                const Icon(Icons.power_settings_new, size: 16, color: Color(0xFFE57373)),
                                const SizedBox(width: 8),
                                const Expanded(
                                  child: Text(
                                    '电脑端未开启「工作(Beta)」——请在电脑端 dsh 设置里打开',
                                    style: TextStyle(fontSize: 12, color: Colors.white70),
                                  ),
                                ),
                                TextButton(
                                  onPressed: () => work.kick(),
                                  style: TextButton.styleFrom(minimumSize: const Size(44, 30), padding: const EdgeInsets.symmetric(horizontal: 8)),
                                  child: const Text('重试', style: TextStyle(fontSize: 12, color: Colors.white70)),
                                ),
                              ],
                            ),
                          ),
                        )
                      : const SizedBox.shrink(),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
                  child: TextField(
                    onChanged: (v) => setState(() => _query = v.trim()),
                    style: const TextStyle(fontSize: 14),
                    decoration: InputDecoration(
                      hintText: '搜索会话或工作目录…',
                      prefixIcon: const Icon(Icons.search, size: 20, color: Colors.white38),
                      isDense: true,
                      filled: true,
                      fillColor: const Color(0xFF1E2228),
                      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
                    ),
                  ),
                ),
                if (children.isEmpty)
                  ValueListenableBuilder<bool>(
                    valueListenable: work.loadingSessions,
                    builder: (context, loading, _) => ValueListenableBuilder<String?>(
                      valueListenable: work.sessionListError,
                      builder: (context, err, _) {
                        if (loading && rows.isEmpty) {
                          return const Padding(
                            padding: EdgeInsets.only(top: 80),
                            child: WorkLoadingIndicator(label: '正在载入工作区列表…'),
                          );
                        }
                        if (err != null && rows.isEmpty) {
                          return Padding(
                            padding: const EdgeInsets.only(top: 60, left: 24, right: 24),
                            child: Center(
                              child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const Icon(Icons.cloud_off, size: 40, color: Colors.white38),
                                  const SizedBox(height: 12),
                                  Text(err, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white54, fontSize: 13)),
                                  const SizedBox(height: 16),
                                  OutlinedButton.icon(
                                    icon: const Icon(Icons.refresh, size: 16),
                                    label: const Text('重试'),
                                    onPressed: () => work.refreshSessions(),
                                  ),
                                ],
                              ),
                            ),
                          );
                        }
                        return Padding(
                          padding: const EdgeInsets.only(top: 80),
                          child: Center(child: Text(rows.isEmpty ? '暂无会话' : '无匹配会话', style: const TextStyle(color: Colors.white38))),
                        );
                      },
                    ),
                  )
                else
                  ...children,
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _sessionTile(WorkSessionRow r, {bool showCwd = false}) {
    final title = (r.title != null && r.title!.isNotEmpty) ? r.title! : (r.blank ? '(新会话)' : '(未命名会话)');
    final when = DateTime.fromMillisecondsSinceEpoch(r.updatedAt);
    final whenText = '${when.month}/${when.day} ${when.hour.toString().padLeft(2, '0')}:${when.minute.toString().padLeft(2, '0')}';
    final sub = showCwd && (r.cwd?.isNotEmpty ?? false) ? '$whenText · ${r.cwd}' : whenText;
    final archiving = _archivingSessions.contains(r.sessionId);
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
      title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 15)),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 3),
        child: Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Colors.white38)),
      ),
      trailing: r.running
          ? const SizedBox(width: 10, height: 10, child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF4CAF50)))
          : archiving
              ? const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.6, color: Colors.white30))
              : IconButton(
                  onPressed: () => _archiveSession(r),
                  icon: const Icon(Icons.archive_outlined, size: 16, color: Colors.white30),
                  visualDensity: VisualDensity.compact,
                  constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                  tooltip: '归档会话',
                ),
      onTap: () => work.subscribe(r.sessionId),
    );
  }

  /// Desktop context-menu parity: archive the session (running sessions are
  /// rejected by the host — the reason shows in a SnackBar). Archiving the
  /// session currently open → fall back to the list.
  Future<void> _archiveSession(WorkSessionRow r) async {
    setState(() => _archivingSessions.add(r.sessionId));
    try {
      final err = await work.archiveSession(r.sessionId);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(err ?? '会话已归档'),
        duration: const Duration(seconds: 2),
      ));
      if (err == null && work.subscribedId.value == r.sessionId) {
        work.leaveSession(); // archived the open chat → back to list (+ host unsubscribe)
      }
    } finally {
      if (mounted) setState(() => _archivingSessions.remove(r.sessionId));
    }
  }
}

Widget linkChip(LensLinkState st) {
  final (label, color) = switch (st) {
    LensLinkState.connected => ('已连接', const Color(0xFF4CAF50)),
    LensLinkState.connecting => ('连接中', Colors.orange),
    LensLinkState.disconnected => ('未连接', Colors.white24),
  };
  return Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
    decoration: BoxDecoration(color: color.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(20)),
    child: Text(label, style: TextStyle(fontSize: 12, color: color)),
  );
}

/// 通用加载指示器: 转圈; 超过 5s 时自动追加"当前网络较差，加载缓慢"
class WorkLoadingIndicator extends StatefulWidget {
  final String label;
  const WorkLoadingIndicator({super.key, this.label = '加载中…'});

  @override
  State<WorkLoadingIndicator> createState() => _WorkLoadingIndicatorState();
}

class _WorkLoadingIndicatorState extends State<WorkLoadingIndicator> {
  bool _slow = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer(const Duration(seconds: 5), () {
      if (mounted) setState(() => _slow = true);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 36),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(
              width: 32,
              height: 32,
              child: CircularProgressIndicator(strokeWidth: 2.5),
            ),
            const SizedBox(height: 14),
            Text(widget.label, style: const TextStyle(fontSize: 14, color: Colors.white70)),
            if (_slow) ...[
              const SizedBox(height: 8),
              const Text('当前网络较差，加载缓慢', style: TextStyle(fontSize: 12, color: Color(0xFFFFB74D))),
            ],
          ],
        ),
      ),
    );
  }
}

// ── chat view ─────────────────────────────────────────────────────────────────

class _ChatView extends StatefulWidget {
  final LensStore store;
  final WorkStore work;
  final String sessionId;
  const _ChatView({required this.store, required this.work, required this.sessionId});

  @override
  State<_ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<_ChatView> {
  final _controller = TextEditingController();
  final _scroll = ScrollController();
  final _focus = FocusNode();

  // ── composer attachments (images riding the next send) ──────────────────
  final List<WorkSendAttachment> _attachments = [];
  static const int _maxAttachments = 4;

  // ── suggestion panel state (/ command directory, @ mentions) ────────────
  _SuggestKind? _suggestKind;
  String _suggestQuery = '';
  int _triggerStart = 0;
  bool _suggestLoading = false;
  List<WorkCommandInfo>? _commandList;
  WorkMentionResult? _mentions;
  Timer? _mentionDebounce;
  int _mentionSeq = 0;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onTextChanged);
  }

  @override
  void dispose() {
    _controller.removeListener(_onTextChanged);
    _controller.dispose();
    _scroll.dispose();
    _focus.dispose();
    _mentionDebounce?.cancel();
    // a capture armed for THIS chat is void once we leave it (the viewfinder
    // banner disappears with the handshake)
    pendingWorkCapture.value = null;
    super.dispose();
  }

  void _leaveSession() {
    // leaves ALSO tell the host (empty session_subscribe normalizes to null
    // there): without the frame the host keeps us subscribed to the old chat
    // forever and the devices sheet's "who is watching" tiers rot (lane-08 §7)
    widget.work.leaveSession();
  }

  // ── suggestion triggers ──────────────────────────────────────────────────

  static bool _isWs(int c) => c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D;

  /// Detect a `/` or `@` token under the caret and raise the matching panel.
  /// Mirrors the desktop composer's trigger rules: `/` only at the very start
  /// of the draft, `@` anywhere but only as a standalone token start (an @
  /// glued to letters, like an email, can never begin a whitespace-bounded
  /// token so it naturally never triggers).
  void _onTextChanged() {
    final value = _controller.value;
    final text = value.text;
    final sel = value.selection;
    if (!sel.isValid || !sel.isCollapsed || sel.baseOffset > text.length) {
      _hideSuggest();
      return;
    }
    final pos = sel.baseOffset;
    var start = pos;
    while (start > 0 && !_isWs(text.codeUnitAt(start - 1))) {
      start--;
    }
    final token = text.substring(start, pos);
    if (token.startsWith('/') && start == 0) {
      _showSuggest(_SuggestKind.command, token.substring(1), start);
    } else if (token.startsWith('@')) {
      var q = token.substring(1);
      if (q.startsWith('"')) q = q.substring(1); // @"path with spaces
      _showSuggest(_SuggestKind.mention, q, start);
    } else {
      _hideSuggest();
    }
  }

  void _showSuggest(_SuggestKind kind, String query, int triggerStart) {
    final changed = _suggestKind != kind || _suggestQuery != query;
    _suggestKind = kind;
    _suggestQuery = query;
    _triggerStart = triggerStart;
    if (!changed) return;
    if (mounted) setState(() {});
    if (kind == _SuggestKind.command) {
      _loadCommandList();
    } else {
      _runMentionQuery(query);
    }
  }

  void _hideSuggest() {
    if (_suggestKind == null) return;
    _suggestKind = null;
    _suggestQuery = '';
    _mentionDebounce?.cancel();
    if (mounted) setState(() {});
  }

  Future<void> _loadCommandList() async {
    if (_commandList != null) return; // WorkStore's cache handles freshness
    final list = await widget.work.loadCommands();
    if (mounted && _suggestKind == _SuggestKind.command) {
      setState(() => _commandList = list);
    }
  }

  void _runMentionQuery(String query) {
    _mentionDebounce?.cancel();
    final seq = ++_mentionSeq;
    _suggestLoading = true;
    if (mounted) setState(() {});
    _mentionDebounce = Timer(const Duration(milliseconds: 200), () async {
      final res = await widget.work.mentionQuery(query);
      if (seq != _mentionSeq || !mounted) return; // stale reply — drop
      _suggestLoading = false;
      _mentions = res;
      if (_suggestKind == _SuggestKind.mention) setState(() {});
    });
  }

  /// Replace the triggering token with the picked suggestion, keeping the
  /// caret right after the insertion (a trailing space for terminal picks;
  /// directory mentions stay "open" so typing continues to drill down).
  void _replaceTrigger(String insert, {required bool trailingSpace}) {
    final text = _controller.text;
    final sel = _controller.selection;
    var pos = sel.isValid && sel.isCollapsed ? sel.baseOffset : text.length;
    if (pos > text.length) pos = text.length;
    var start = _triggerStart;
    if (start < 0) start = 0;
    if (start > pos) start = pos;
    final patched = text.replaceRange(start, pos, trailingSpace ? '$insert ' : insert);
    final cursor = start + insert.length + (trailingSpace ? 1 : 0);
    _controller.value = _controller.value.copyWith(
      text: patched,
      selection: TextSelection.collapsed(offset: cursor),
    );
  }

  void _applyCommandPick(WorkCommandInfo cmd) {
    _replaceTrigger('/${cmd.name}', trailingSpace: true);
    _hideSuggest();
    _focus.requestFocus();
  }

  void _applyFilePick(WorkMentionFile f) {
    final quoted = f.path.contains(RegExp(r'\s'));
    final insert = f.isDirectory
        ? (quoted ? '@"${f.path}/"' : '@${f.path}/')
        : (quoted ? '@"${f.path}"' : '@${f.path}');
    _replaceTrigger(insert, trailingSpace: !f.isDirectory);
    if (f.isDirectory) {
      _onTextChanged(); // panel stays up with the drilled query
    } else {
      _hideSuggest();
      _focus.requestFocus();
    }
  }

  void _applySessionPick(WorkMentionSession s) {
    _replaceTrigger(s.mention, trailingSpace: true);
    _hideSuggest();
    _focus.requestFocus();
  }

  // ── attachments ───────────────────────────────────────────────────────────

  Future<void> _pickAttachmentSource() async {
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFF1E2228),
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (sheetCtx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 8),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined, color: Color(0xFFFFB74D)),
              title: const Text('从相册选图'),
              subtitle: const Text('最多 $_maxAttachments 张,自动压缩', style: TextStyle(fontSize: 11, color: Colors.white38)),
              onTap: () {
                Navigator.pop(sheetCtx);
                _pickFromGallery();
              },
            ),
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined, color: Color(0xFFFFB74D)),
              title: const Text('取景拍一张'),
              subtitle: const Text('切到取景页拍摄,拍完自动回来', style: TextStyle(fontSize: 11, color: Colors.white38)),
              onTap: () {
                Navigator.pop(sheetCtx);
                _armViewfinderCapture();
              },
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  Future<void> _pickFromGallery() async {
    final remaining = _maxAttachments - _attachments.length;
    if (remaining <= 0) {
      _toast('最多 $_maxAttachments 张');
      return;
    }
    final files = await ImagePicker().pickMultiImage(limit: remaining);
    if (files.isEmpty) return;
    for (final f in files) {
      if (!mounted) return;
      var bytes = await f.readAsBytes();
      bytes = await compute(_fitWorkImage, _WorkImgArgs(bytes));
      if (!mounted) return;
      setState(() => _attachments.add(WorkSendAttachment(bytes: bytes, name: f.name, mediaType: _sniffMediaType(bytes))));
    }
  }

  /// 「取景拍一张」联动: arm the one-shot handshake, flip to the viewfinder
  /// (its banner shows where the next local shutter goes); the shot lands
  /// back here as a compressed draft attachment and the tab bounces back.
  void _armViewfinderCapture() {
    if (_maxAttachments - _attachments.length <= 0) {
      _toast('最多 $_maxAttachments 张');
      return;
    }
    pendingWorkCapture.value = (bytes, name) {
      _handleWorkCapture(bytes, name);
    };
    homeTab.value = 0; // over to the viewfinder
  }

  Future<void> _handleWorkCapture(Uint8List bytes, String name) async {
    final fitted = await compute(_fitWorkImage, _WorkImgArgs(bytes));
    if (!mounted) {
      // the chat died during compression (user left the session / beta off):
      // the shutter already consumed the armed callback, so returning here
      // would lose the photo entirely — fall back to the upload queue
      try {
        await UploadQueue.instance.enqueue(bytes: fitted, name: name);
      } catch (_) {}
      return;
    }
    setState(() => _attachments.add(WorkSendAttachment(bytes: fitted, name: name, mediaType: _sniffMediaType(fitted))));
    HapticFeedback.selectionClick();
    homeTab.value = workTabIndex; // bounce back to this tab
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg), duration: const Duration(seconds: 2)));
  }

  // ── send ──────────────────────────────────────────────────────────────────

  Future<void> _send() async {
    final text = _controller.text.trim();
    final hasImages = _attachments.isNotEmpty;
    if (text.isEmpty && !hasImages) return;
    if (text.startsWith('/') && hasImages) {
      _toast('命令消息不能附带图片');
      return;
    }
    final images = List<WorkSendAttachment>.from(_attachments);
    _controller.clear();
    _attachments.clear();
    _hideSuggest();
    setState(() {});
    // on failure the optimistic row keeps text+images and offers 重发 —
    // restoring the draft as well would duplicate it
    final err = await widget.work.send(text, images: images);
    if (err != null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err), duration: const Duration(seconds: 2)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _leaveSession();
      },
      child: Scaffold(
        backgroundColor: const Color(0xFF15181D),
        appBar: AppBar(
          backgroundColor: const Color(0xFF15181D),
          leading: IconButton(icon: const Icon(Icons.arrow_back), onPressed: _leaveSession),
          title: _Title(work: widget.work),
          actions: [
            // 在线设备（多设备轻方案，lane-08 §4.2a）：数字 = 在线台数（含本机）
            ValueListenableBuilder<List<WorkDeviceRow>>(
              valueListenable: widget.work.devices,
              builder: (context, rows, _) {
                final onlineCount = rows.where((d) => d.online).length;
                return IconButton(
                  tooltip: '在线设备',
                  icon: Badge(
                    isLabelVisible: onlineCount > 0,
                    label: Text('$onlineCount'),
                    child: const Icon(Icons.smartphone),
                  ),
                  onPressed: () => showDevicesSheet(context, widget.work),
                );
              },
            ),
            IconButton(
              tooltip: '模型',
              icon: const Icon(Icons.tune),
              onPressed: () => showModelSheet(context, widget.work),
            ),
            IconButton(
              tooltip: '文件',
              icon: const Icon(Icons.folder_open),
              onPressed: () => showFileSheet(context, widget.work, widget.store),
            ),
          ],
        ),
        body: SafeArea(
          child: Column(
            children: [
              Expanded(
                child: ValueListenableBuilder<List<WorkItem>>(
                  valueListenable: widget.work.items,
                  builder: (context, items, _) => ValueListenableBuilder<String>(
                    valueListenable: widget.work.streamingText,
                    builder: (context, streaming, _) {
                      final total = items.length + (streaming.isNotEmpty ? 1 : 0);
                      if (total == 0) {
                        return ValueListenableBuilder<bool>(
                          valueListenable: widget.work.loadingSnapshot,
                          builder: (context, loading, _) => ValueListenableBuilder<String?>(
                            valueListenable: widget.work.snapshotError,
                            builder: (context, err, _) {
                              if (loading) {
                                return const WorkLoadingIndicator(label: '正在载入工作区对话…');
                              }
                              if (err != null) {
                                return Center(
                                  child: Padding(
                                    padding: const EdgeInsets.symmetric(horizontal: 24),
                                    child: Column(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        const Icon(Icons.cloud_off, size: 40, color: Colors.white38),
                                        const SizedBox(height: 12),
                                        Text(err, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white54, fontSize: 13)),
                                        const SizedBox(height: 16),
                                        Row(
                                          mainAxisSize: MainAxisSize.min,
                                          children: [
                                            OutlinedButton.icon(
                                              icon: const Icon(Icons.refresh, size: 16),
                                              label: const Text('重新加载'),
                                              onPressed: () => widget.work.subscribe(widget.sessionId),
                                            ),
                                            const SizedBox(width: 12),
                                            TextButton(
                                              onPressed: _leaveSession,
                                              child: const Text('返回列表'),
                                            ),
                                          ],
                                        ),
                                      ],
                                    ),
                                  ),
                                );
                              }
                              return const Center(child: Text('暂无对话消息，在下方输入开始', style: TextStyle(color: Colors.white24, fontSize: 13)));
                            },
                          ),
                        );
                      }
                      return NotificationListener<ScrollNotification>(
                        onNotification: (n) {
                          // reversed list: "top" (older history) is maxExtent
                          if (n is ScrollEndNotification && _scroll.hasClients && _scroll.position.maxScrollExtent - _scroll.position.pixels < 80) {
                            widget.work.loadOlder();
                          }
                          return false;
                        },
                        child: ListView.builder(
                          reverse: true, // newest at offset 0 — keyboard adds ZERO drift
                          controller: _scroll,
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                          // one extra slot at the OLDEST end when no older history
                          // remains (snapshot end, or the 2000-row cap tripped —
                          // loadOlder flips hasMoreHistory there)
                          itemCount: total + (items.isNotEmpty && !widget.work.hasMoreHistory ? 1 : 0),
                          itemBuilder: (context, i) {
                            final flipped = total - 1 - i;
                            if (flipped < 0) {
                              return const Padding(
                                padding: EdgeInsets.symmetric(vertical: 10),
                                child: Center(child: Text('已到最早记录', style: TextStyle(fontSize: 11, color: Colors.white24))),
                              );
                            }
                            if (flipped >= items.length) return _StreamingRow(text: streaming);
                            return _ItemRow(item: items[flipped], work: widget.work);
                          },
                        ),
                      );
                    },
                  ),
                ),
              ),
              _InlineStatusStrip(work: widget.work),
              // ⚠卡区绝不能挂 Flexible:它默认 flex:1,会和气泡列表的 Expanded
              // 平分剩余空间——卡是空/矮的(旧黄条只有一行)时,timeline 的一半
              // 份额没人用,composer 底下就多出一条"神秘空白"(真机实测,答题
              // 输出完毕黄条撤掉的窗口期精确复现)。固定 dp 上限+内部滚动:
              // 键盘弹出时 220+composer 仍小于任何机型的剩余高度,不溢出。
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 220),
                child: _ApprovalBar(work: widget.work),
              ),
              if (_suggestKind != null)
                Flexible(
                  fit: FlexFit.loose,
                  child: _SuggestPanel(
                    kind: _suggestKind!,
                    query: _suggestQuery,
                    commands: _commandList,
                    mentions: _mentions,
                    loading: _suggestLoading,
                    onCommand: _applyCommandPick,
                    onFile: _applyFilePick,
                    onSession: _applySessionPick,
                  ),
                ),
              if (_attachments.isNotEmpty)
                _AttachmentBar(
                  attachments: _attachments,
                  onRemove: (i) => setState(() => _attachments.removeAt(i)),
                ),
              _Composer(work: widget.work, controller: _controller, focus: _focus, onSend: _send, attachments: _attachments, onAttach: _pickAttachmentSource),
            ],
          ),
        ),
      ),
    );
  }
}

class _Title extends StatelessWidget {
  final WorkStore work;
  const _Title({required this.work});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<List<WorkSessionRow>>(
      valueListenable: work.sessions,
      builder: (context, rows, _) {
        final sid = work.subscribedId.value ?? '';
        WorkSessionRow? row;
        for (final r in rows) {
          if (r.sessionId == sid) {
            row = r;
            break;
          }
        }
        final title = (row?.title?.isNotEmpty ?? false) ? row!.title! : '未命名会话';
        return Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16));
      },
    );
  }
}

// ── rows ──────────────────────────────────────────────────────────────────────

class _ItemRow extends StatelessWidget {
  final WorkItem item;
  final WorkStore work;
  const _ItemRow({required this.item, required this.work});

  @override
  Widget build(BuildContext context) {
    switch (item.kind) {
      case 'user':
        return _UserBubble(item: item, work: work);
      case 'assistant':
        return _AssistantBubble(item: item, work: work);
      case 'tool':
        return _ToolRow(item: item);
      case 'command':
        return _CommandBubble(item: item, work: work);
      case 'turnGroup':
        final g = item.group;
        if (g != null) return _TurnGroupRow(group: g, work: work);
    }
    return const SizedBox.shrink();
  }
}

/// 投递四态脚标: sending=时钟 · sent(排队)=一勾 · delivered=双勾 · failed=红标重试。
class _UserBubble extends StatelessWidget {
  final WorkItem item;
  final WorkStore work;
  const _UserBubble({required this.item, required this.work});

  @override
  Widget build(BuildContext context) {
    final queued = item.sendState == 'sent'; // accepted by the host, not yet read
    final failed = item.sendState == 'failed';
    return Align(
      alignment: Alignment.centerRight,
      child: Opacity(
        opacity: queued ? 0.55 : 1.0, // 排队中的消息变淡,被读取后恢复
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 3),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
          decoration: BoxDecoration(
            color: failed ? const Color(0xFF5A2A2A) : const Color(0xFF2C4A66),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (item.images.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    alignment: WrapAlignment.end,
                    children: [for (final img in item.images) _BubbleImage(image: img)],
                  ),
                ),
              if (item.text.isNotEmpty)
                Text(item.text, style: const TextStyle(fontSize: 15, height: 1.35)),
              const SizedBox(height: 3),
              failed
                  ? Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        InkWell(
                          onTap: () => work.retry(item),
                          child: const Text('失败 · 重发', style: TextStyle(fontSize: 11, color: Color(0xFFFF8A80))),
                        ),
                        const SizedBox(width: 10),
                        InkWell(
                          // 放弃：丢弃失败的乐观行并释放其钉住的图片字节
                          // （每张 ≤1.2MB，此前只有切走会话/detach 才释放）
                          onTap: () => work.abandonSend(item),
                          child: const Text('放弃', style: TextStyle(fontSize: 11, color: Colors.white38)),
                        ),
                      ],
                    )
                  : Icon(
                      item.sendState == 'sending'
                          ? Icons.schedule // 时钟:还在路上
                          : item.sendState == 'delivered'
                              ? Icons.done_all // 双勾:已纳入对话
                              : Icons.done, // 一勾:电脑已收到
                      size: 13,
                      color: Colors.white38,
                    ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One image inside a user bubble. Optimistic rows (sent from this phone)
/// render the real thumbnail, tappable fullscreen; rows rebuilt from durable
/// events only carry the attachment name — a placeholder card, the bytes are
/// deliberately NOT re-fetched just to render history (bandwidth).
class _BubbleImage extends StatelessWidget {
  final WorkImage image;
  const _BubbleImage({required this.image});

  @override
  Widget build(BuildContext context) {
    final bytes = image.bytes;
    if (bytes != null) {
      return GestureDetector(
        onTap: () => showDialog<void>(
          context: context,
          builder: (dCtx) => Dialog(
            backgroundColor: Colors.black87,
            insetPadding: const EdgeInsets.all(12),
            child: InteractiveViewer(maxScale: 6, child: Center(child: Image.memory(bytes))),
          ),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: Image.memory(bytes, width: 96, height: 96, fit: BoxFit.cover, gaplessPlayback: true),
        ),
      );
    }
    return Container(
      width: 96,
      height: 52,
      decoration: BoxDecoration(
        color: const Color(0xFF22364A),
        borderRadius: BorderRadius.circular(8),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Row(
        children: [
          const Icon(Icons.image_outlined, size: 18, color: Colors.white38),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              image.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 10, color: Colors.white54),
            ),
          ),
        ],
      ),
    );
  }
}

/// Slash-command card: `/name args` + execution outcome. Running rows show a
/// spinner; success/error text comes back on the send ack (the host's
/// command/run|command/done journal events settle snapshot rebuilds).
class _CommandBubble extends StatelessWidget {
  final WorkItem item;
  final WorkStore work;
  const _CommandBubble({required this.item, required this.work});

  @override
  Widget build(BuildContext context) {
    final running = item.sendState == 'sending';
    final failedSend = item.sendState == 'failed';
    final err = item.commandKind == 'error' || failedSend;
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 3),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
        decoration: BoxDecoration(
          color: err ? const Color(0xFF5A2A2A) : const Color(0xFF3A3A52),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: const Color(0x33FFB74D), width: 0.8),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.terminal, size: 14, color: Color(0xFFFFB74D)),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    '/${item.commandName ?? item.text.replaceFirst('/', '')}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 14, fontFamily: 'monospace', color: Color(0xFFFFD48A)),
                  ),
                ),
              ],
            ),
            if ((item.commandArgs ?? '').isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  item.commandArgs!,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11, color: Colors.white54, fontFamily: 'monospace'),
                ),
              ),
            const SizedBox(height: 4),
            if (running)
              const Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox(width: 10, height: 10, child: CircularProgressIndicator(strokeWidth: 1.6, color: Colors.white38)),
                  SizedBox(width: 6),
                  Text('执行中…', style: TextStyle(fontSize: 11, color: Colors.white38)),
                ],
              )
            else if (err)
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  InkWell(
                    onTap: failedSend ? () => work.retry(item) : null,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.error_outline, size: 12, color: Color(0xFFFF8A80)),
                        const SizedBox(width: 4),
                        Flexible(
                          child: Text(
                            failedSend ? '失败 · 重发' : (item.commandText ?? '执行失败'),
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 11, color: Color(0xFFFF8A80)),
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (failedSend) ...[
                    const SizedBox(width: 10),
                    InkWell(
                      onTap: () => work.abandonSend(item),
                      child: const Text('放弃', style: TextStyle(fontSize: 11, color: Colors.white38)),
                    ),
                  ],
                ],
              )
            else
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.check_circle_outline, size: 12, color: Color(0xFF81C784)),
                  const SizedBox(width: 4),
                  Flexible(
                    child: Text(
                      (item.commandText != null && item.commandText!.isNotEmpty) ? item.commandText! : '已执行',
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11, color: Colors.white54),
                    ),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

class _AssistantBubble extends StatefulWidget {
  final WorkItem item;
  final WorkStore work;
  const _AssistantBubble({required this.item, required this.work});

  @override
  State<_AssistantBubble> createState() => _AssistantBubbleState();
}

class _AssistantBubbleState extends State<_AssistantBubble> {
  bool _forking = false;

  /// 气泡尾部动作行（对标桌面 MessageIconActions）：复制原文 + 分叉。
  /// fork 只在 durable 行（seq>0）显示——live/无主行没有可靠的分叉切点。
  Widget _actionsRow() {
    final durable = (widget.item.seq ?? -1) > 0;
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          IconButton(
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: widget.item.text));
              if (mounted) {
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已复制原文'), duration: Duration(seconds: 1)));
              }
            },
            icon: const Icon(Icons.copy_outlined, size: 14, color: Colors.white24),
            visualDensity: VisualDensity.compact,
            constraints: const BoxConstraints(minWidth: 28, minHeight: 24),
            padding: EdgeInsets.zero,
            tooltip: '复制原文',
          ),
          if (durable)
            IconButton(
              onPressed: _forking
                  ? null
                  : () async {
                      final sid = widget.work.subscribedId.value;
                      if (sid == null || _forking) return;
                      setState(() => _forking = true);
                      try {
                        String? sourceTitle;
                        for (final s in widget.work.sessions.value) {
                          if (s.sessionId == sid) {
                            sourceTitle = s.title;
                            break;
                          }
                        }
                        final (child, err) = await widget.work.forkSession(sid, atSeq: widget.item.seq, sourceTitle: sourceTitle);
                        if (!mounted) return;
                        if (child != null) {
                          widget.work.subscribe(child); // 直跳分叉出的新会话
                        } else {
                          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err ?? '无法分叉会话，请重试'), duration: const Duration(seconds: 3)));
                        }
                      } finally {
                        if (mounted) setState(() => _forking = false);
                      }
                    },
              icon: _forking
                  ? const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.6, color: Colors.white24))
                  : const Icon(Icons.call_split, size: 14, color: Colors.white24),
              visualDensity: VisualDensity.compact,
              constraints: const BoxConstraints(minWidth: 28, minHeight: 24),
              padding: EdgeInsets.zero,
              tooltip: '以此回复为终点分叉新会话',
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 3),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.90),
        decoration: BoxDecoration(color: const Color(0xFF23272E), borderRadius: BorderRadius.circular(14)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SelectionArea(
              child: _workMarkdown(widget.item.text),
            ),
            if (widget.item.interrupted)
              const Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text('已中断', style: TextStyle(fontSize: 11, color: Colors.orange)),
              ),
            if (widget.item.usage != null)
              Padding(padding: const EdgeInsets.only(top: 4), child: Text('token ${widget.item.usage}', style: const TextStyle(fontSize: 11, color: Colors.white24))),
            _actionsRow(),
          ],
        ),
      ),
    );
  }
}

/// 工具调用折叠行: 状态图标 + 可读名 + 参数摘要;点开看完整参数与结果。
class _ToolRow extends StatefulWidget {
  final WorkItem item;
  const _ToolRow({required this.item});

  @override
  State<_ToolRow> createState() => _ToolRowState();
}

class _ToolRowState extends State<_ToolRow> {
  bool _open = false;

  IconData get _icon {
    final n = widget.item.toolName ?? '';
    if (n.contains('edit') || n.contains('write')) return Icons.edit_note;
    if (n.contains('read')) return Icons.read_more;
    if (n.contains('search') || n.contains('grep') || n.contains('find')) return Icons.search;
    if (n.contains('bash') || n.contains('exec') || n.contains('command')) return Icons.terminal;
    return Icons.build_circle_outlined;
  }

  String get _stateLabel {
    if (widget.item.toolOk == null) return '运行中';
    return widget.item.toolOk! ? '完成' : '出错';
  }

  /// 一行摘要:从 args JSON 里挑最有信息量的值(path/file/command/query 优先),
  /// 兜底首行——完整 JSON 点开可见。
  String get _oneLineSummary {
    final raw = widget.item.argsText;
    if (raw == null || raw.isEmpty) return '';
    try {
      final m = const JsonDecoder().convert(raw);
      if (m is Map) {
        for (final k in ['path', 'file', 'file_path', 'command', 'cmd', 'query', 'pattern', 'url']) {
          final v = m[k];
          if (v is String && v.isNotEmpty) return v;
        }
        final vals = m.values.whereType<String>().where((s) => s.isNotEmpty).toList();
        if (vals.isNotEmpty) return vals.first;
      }
    } catch (_) {}
    return raw.split('\n').first;
  }

  @override
  Widget build(BuildContext context) {
    final running = widget.item.toolOk == null;
    final ok = widget.item.toolOk == true;
    final color = running ? const Color(0xFFB0BEC5) : ok ? const Color(0xFF81C784) : const Color(0xFFE57373);
    final args = widget.item.argsText;
    final oneLine = _oneLineSummary;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 1),
      decoration: BoxDecoration(color: const Color(0xFF1B1F25), borderRadius: BorderRadius.circular(10)),
      child: Column(
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => setState(() => _open = !_open),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
              child: Row(
                children: [
                  if (running)
                    const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF90A4AE)))
                  else
                    Icon(ok ? Icons.check_circle : Icons.error_outline, size: 15, color: color),
                  const SizedBox(width: 8),
                  Icon(_icon, size: 14, color: Colors.white54),
                  const SizedBox(width: 6),
                  Text(widget.item.toolName ?? '', style: TextStyle(fontSize: 13, color: color, fontFamily: 'monospace')),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(oneLine, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Colors.white38, fontFamily: 'monospace')),
                  ),
                  Text(_stateLabel, style: TextStyle(fontSize: 11, color: color)),
                ],
              ),
            ),
          ),
          if (_open)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (args != null && args.isNotEmpty) ...[
                    const Text('参数', style: TextStyle(fontSize: 11, color: Colors.white38)),
                    SelectableText(args, style: const TextStyle(fontSize: 12, color: Colors.white70, fontFamily: 'monospace', height: 1.35)),
                  ],
                  if (widget.item.resultText != null && widget.item.resultText!.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    const Text('结果', style: TextStyle(fontSize: 11, color: Colors.white38)),
                    SelectableText(widget.item.resultText!, style: TextStyle(fontSize: 12, color: ok ? Colors.white70 : const Color(0xFFFF8A80), fontFamily: 'monospace', height: 1.35)),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// 一整个回合的过程折叠行(桌面端同款):「已完成,用时 X ˅」。默认旧回合折叠、
/// 最新完成的回合展开(直到下一条输入把它们挤成旧回合);点击切换 store 层的
/// 展开 override。展开后:中间叙述 + 工具明细行 + 已编辑文件卡片。
class _TurnGroupRow extends StatelessWidget {
  final WorkTurnGroup group;
  final WorkStore work;
  const _TurnGroupRow({required this.group, required this.work});

  /// 折叠行主文案(桌面 TurnProcessNodeView 语义):完成/截断带耗时,中止/
  /// 失败不带。
  String get _headline {
    switch (group.endReason) {
      case 'aborted':
      case 'interrupted':
        return '已停止';
      case 'error':
        return '处理失败';
      case 'forked':
        return '已分叉';
    }
    return '已完成，用时 ${_formatDuration(_elapsedMs)}';
  }

  int get _elapsedMs {
    final s = group.startTime;
    final e = group.endTime;
    if (s == null || e == null) return 0;
    return (e - s < 1000 ? 1000 : e - s); // 桌面端同款:下限 1 秒
  }

  static String _formatDuration(int ms) {
    final total = (ms / 1000).round();
    if (total < 60) return '$total 秒';
    final m = total ~/ 60;
    final s = total % 60;
    if (m < 60) return s == 0 ? '$m 分钟' : '$m 分 $s 秒';
    final h = m ~/ 60;
    return '$h 小时 ${m % 60} 分';
  }

  /// 分类摘要(桌面 processTitle 语义:前 3 类,"X并Y"或逗号+"…等")。
  String? get _categorySummary {
    final counts = group.categoryCounts;
    if (counts.isEmpty) return null;
    final order = counts.keys.toList()..sort((a, b) => counts[b]!.compareTo(counts[a]!));
    final parts = [for (final k in order.take(3)) '$k ${counts[k]}次'];
    return parts.join('、') + (order.length > 3 ? '…等' : '');
  }

  @override
  Widget build(BuildContext context) {
    final reason = group.endReason;
    final failed = reason == 'error' || reason == 'max-tokens';
    final stopped = reason == 'aborted' || reason == 'interrupted';
    final stateColor = failed ? const Color(0xFFE57373) : stopped ? const Color(0xFFB0BEC5) : const Color(0xFF81C784);
    final stateIcon = failed
        ? Icons.error_outline
        : stopped
            ? Icons.stop_circle_outlined
            : Icons.check_circle;
    final expanded = work.isGroupExpanded(group);
    final summary = _categorySummary;
    final latest = work.latestClosedGroupKey() == group.key || group.open;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 2),
      decoration: BoxDecoration(
        color: const Color(0xFF1B1F25),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: latest ? Colors.white24 : Colors.white10),
      ),
      child: Column(
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => work.setTurnExpanded(group.key, !expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Row(
                children: [
                  Icon(stateIcon, size: 15, color: stateColor),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(_headline, style: const TextStyle(fontSize: 13, color: Colors.white70)),
                        if (summary != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 1),
                            child: Text(summary, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, color: Colors.white30)),
                          ),
                      ],
                    ),
                  ),
                  if (group.fileEdits.isNotEmpty)
                    Container(
                      margin: const EdgeInsets.only(left: 6),
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(color: const Color(0x1F7FB8E6), borderRadius: BorderRadius.circular(8)),
                      child: Text(
                        '改 ${group.fileEdits.length} 文件',
                        style: const TextStyle(fontSize: 10, color: Color(0xFFA5CCEE)),
                      ),
                    ),
                  const SizedBox(width: 4),
                  AnimatedRotation(
                    turns: expanded ? 0.5 : 0,
                    duration: const Duration(milliseconds: 150),
                    child: const Icon(Icons.keyboard_arrow_down, size: 18, color: Colors.white38),
                  ),
                ],
              ),
            ),
          ),
          if (expanded) ...[
            if (group.fileEdits.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 0, 8, 4),
                child: _FileEditsCard(group: group, work: work),
              ),
            for (final n in group.notes)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 2, 12, 2),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    n.text,
                    maxLines: 6,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, height: 1.4, color: Colors.white38),
                  ),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
              child: Column(
                children: [for (final t in group.toolRows) _ToolRow(item: t)],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// 「已编辑 N 个文件 +X -Y」卡片(桌面 ChangedFiles 同款语义):头卡 + 文件行
/// (默认前 4 行)+「全部 N 个文件」二级展开。行数来自宿主 workspace-changes
/// 摘要(git numstat 口径,与桌面一致);摘要未就绪时只显示文件数。
class _FileEditsCard extends StatefulWidget {
  final WorkTurnGroup group;
  final WorkStore work;
  const _FileEditsCard({required this.group, required this.work});

  @override
  State<_FileEditsCard> createState() => _FileEditsCardState();
}

class _FileEditsCardState extends State<_FileEditsCard> {
  bool _allOpen = false;
  bool _kickedFetch = false;
  static const _collapsedRows = 4;

  Map<String, dynamic>? get _summary {
    final seq = widget.group.changesSeq;
    if (seq == null) return null;
    return widget.work.changesSummary(widget.work.subscribedId.value ?? '', seq);
  }

  @override
  Widget build(BuildContext context) {
    final seq = widget.group.changesSeq;
    // 摘要未取:build 后异步拉一次(不阻塞构建,落库后 _publishItems 触发重绘)
    if (seq != null && _summary == null && !_kickedFetch) {
      _kickedFetch = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) widget.work.ensureChangesSummary(widget.work.subscribedId.value ?? '', seq);
      });
    }
    final files = widget.group.fileEdits;
    final sm = _summary;
    int? totalAdded;
    int? totalDeleted;
    final byPath = <String, Map<String, dynamic>>{};
    if (sm != null) {
      final a = sm['added'];
      final d = sm['deleted'];
      if (a is num) totalAdded = a.toInt();
      if (d is num) totalDeleted = d.toInt();
      final fs = sm['files'];
      if (fs is List) {
        for (final f in fs) {
          if (f is Map<String, dynamic>) {
            final p = f['path']?.toString() ?? f['display']?.toString() ?? '';
            if (p.isNotEmpty) byPath[p] = f;
          }
        }
      }
    }
    final shown = _allOpen ? files : files.take(_collapsedRows);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF20252D),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.white10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.edit_note, size: 14, color: Color(0xFFA5CCEE)),
              const SizedBox(width: 6),
              Text('已编辑 ${files.length} 个文件', style: const TextStyle(fontSize: 12, color: Colors.white70)),
              const SizedBox(width: 8),
              if (totalAdded != null || totalDeleted != null) ...[
                Text('+${totalAdded ?? 0}', style: const TextStyle(fontSize: 11, color: Color(0xFF81C784), fontFamily: 'monospace')),
                const SizedBox(width: 6),
                Text('-${totalDeleted ?? 0}', style: const TextStyle(fontSize: 11, color: Color(0xFFE57373), fontFamily: 'monospace')),
              ],
            ],
          ),
          const SizedBox(height: 4),
          for (final f in shown)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(
                children: [
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      f.display,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 12, color: Colors.white60, fontFamily: 'monospace'),
                    ),
                  ),
                  _fileDelta(byPath[f.path]),
                ],
              ),
            ),
          if (files.length > _collapsedRows)
            InkWell(
              onTap: () => setState(() => _allOpen = !_allOpen),
              child: Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      _allOpen ? '收起' : '全部 ${files.length} 个文件',
                      style: const TextStyle(fontSize: 11, color: Color(0xFFA5CCEE)),
                    ),
                    Icon(_allOpen ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down, size: 14, color: const Color(0xFFA5CCEE)),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _fileDelta(Map<String, dynamic>? f) {
    if (f == null) return const SizedBox.shrink();
    final a = f['added'];
    final d = f['deleted'];
    if (a is! num && d is! num) return const SizedBox.shrink();
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('+${a is num ? a.toInt() : 0}', style: const TextStyle(fontSize: 11, color: Color(0xFF81C784), fontFamily: 'monospace')),
        const SizedBox(width: 4),
        Text('-${d is num ? d.toInt() : 0}', style: const TextStyle(fontSize: 11, color: Color(0xFFE57373), fontFamily: 'monospace')),
      ],
    );
  }
}

class _StreamingRow extends StatelessWidget {
  final String text;
  const _StreamingRow({required this.text});

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 3),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.90),
        decoration: BoxDecoration(color: const Color(0xFF23272E), borderRadius: BorderRadius.circular(14)),        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SelectionArea(
              child: _workMarkdown(text),
            ),
            const SizedBox(height: 2),
            const _Cursor(),
          ],
        ),
      ),
    );
  }
}

class _Cursor extends StatefulWidget {
  const _Cursor();

  @override
  State<_Cursor> createState() => _CursorState();
}

class _CursorState extends State<_Cursor> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 600))..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween(begin: 0.1, end: 1.0).animate(_c),
      child: Container(width: 7, height: 16, margin: const EdgeInsets.only(left: 2), color: const Color(0xFF7CB0D8)),
    );
  }
}

// ── approval bar (Beta phase 1: read-only visibility) ────────────────────────

class _ApprovalBar extends StatelessWidget {
  final WorkStore work;
  const _ApprovalBar({required this.work});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<List<WorkInteraction>>(
      valueListenable: work.pendingRequests,
      builder: (context, cards, _) {
        // interactive cards with real payloads first; the old kind-only
        // mirror is the fallback for hosts without the phase-2 answerer
        if (cards.isNotEmpty) {
          // 结构性防溢出:外层 Flexible(loose) 给了有界高度,这里整体滚动,
          // 卡再多/键盘再高也只会滚,绝不撑爆 Column。
          return SingleChildScrollView(
            child: Column(
              children: [for (final card in cards) _InteractionCard(card: card, work: work)],
            ),
          );
        }
        return ValueListenableBuilder<List<WorkApproval>>(
          valueListenable: work.approvals,
          builder: (context, pending, _) {
            if (pending.isEmpty) return const SizedBox.shrink();
            final first = pending.first;
            return Container(
              width: double.infinity,
              margin: const EdgeInsets.fromLTRB(10, 6, 10, 0),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              decoration: BoxDecoration(
                color: const Color(0xFF4A3A1E),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: const Color(0xFF8A6D3B)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.shield_outlined, size: 16, color: Color(0xFFFFD54F)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '等待确认: ${first.toolName ?? first.reason ?? "工具调用"} (请在电脑上处理)',
                      style: const TextStyle(fontSize: 13, color: Color(0xFFFFD54F)),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (pending.length > 1) Text('+${pending.length - 1}', style: const TextStyle(fontSize: 12, color: Color(0xFFFFD54F))),
                ],
              ),
            );
          },
        );
      },
    );
  }
}

/// 可操作的审批/提问卡（桌面 dsh-client-ui-approval 同款语义）：黄色警示条 +
/// 标题 + 主体。审批卡=「拒绝 / 允许一次」两个按钮；提问卡=每个问题的选项列表
/// （单选/多选）+ 可选自定义输入 + 提交。先答先生效：另一端答了本卡被
/// approval_resolved 撤掉；本端发送后按钮置灰等 resolved。
class _InteractionCard extends StatefulWidget {
  final WorkInteraction card;
  final WorkStore work;
  const _InteractionCard({required this.card, required this.work});

  @override
  State<_InteractionCard> createState() => _InteractionCardState();
}

class _InteractionCardState extends State<_InteractionCard> {
  /// per-question selection (question kind only)
  final Map<String, Set<String>> _selected = {};
  final Map<String, TextEditingController> _custom = {};
  bool _sending = false;
  String? _error;

  @override
  void dispose() {
    for (final c in _custom.values) {
      c.dispose();
    }
    super.dispose();
  }

  Set<String> _selOf(WorkQuestion q) => _selected.putIfAbsent(q.id, () => <String>{});

  Future<void> _sendApproval(bool allow) async {
    if (_sending || widget.card.answered) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    final err = await widget.work.answerApproval(widget.card, allow);
    if (mounted) {
      setState(() {
        _sending = false;
        _error = err;
      });
    }
  }

  Future<void> _sendAnswers() async {
    if (_sending || widget.card.answered) return;
    final answers = <Map<String, dynamic>>[];
    for (final q in widget.card.questions) {
      final custom = _custom[q.id]?.text.trim() ?? '';
      final sel = _selOf(q).toList();
      if (sel.isEmpty && custom.isEmpty) {
        setState(() => _error = '「${q.header ?? q.question}」还没有选择');
        return;
      }
      answers.add({
        'id': q.id,
        'selected': sel,
        if (custom.isNotEmpty) 'custom': custom,
      });
    }
    setState(() {
      _sending = true;
      _error = null;
    });
    final err = await widget.work.answerQuestion(widget.card, answers);
    if (mounted) {
      setState(() {
        _sending = false;
        _error = err;
      });
    }
  }

  String get _title {
    final c = widget.card;
    if (c.kind == 'question') return c.displayReason ?? '模型请求你的输入';
    return c.displayReason ?? c.reason ?? '工具 ${c.toolName ?? ""} 请求越权执行';
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.card;
    final answered = c.answered;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(10, 6, 10, 0),
      decoration: BoxDecoration(
        color: const Color(0xFF332B18),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: answered ? const Color(0xFF5A5140) : const Color(0xFF8A6D3B)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 警示 strip（桌面 pendingInteraction 卡同款）
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 9, 12, 0),
            child: Row(
              children: [
                Icon(answered ? Icons.hourglass_bottom : Icons.shield_outlined, size: 15, color: const Color(0xFFFFD54F)),
                const SizedBox(width: 7),
                Text(
                  answered ? '已在本机处理，等待电脑确认…' : (c.kind == 'question' ? '模型提问' : '等待审批'),
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFFFFD54F)),
                ),
                const Spacer(),
                if (c.toolName != null)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(color: const Color(0x29FFD54F), borderRadius: BorderRadius.circular(8)),
                    child: Text(c.toolName!, style: const TextStyle(fontSize: 11, color: Color(0xFFFFD54F), fontFamily: 'monospace')),
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 5, 12, 0),
            child: Text(_title, style: const TextStyle(fontSize: 13, color: Colors.white70)),
          ),
          if (c.kind == 'approval') ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
              child: Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: answered || _sending ? null : () => _sendApproval(false),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: const Color(0xFFE57373),
                        side: const BorderSide(color: Color(0xFF8A5A5A)),
                        minimumSize: const Size(0, 38),
                      ),
                      child: Text(answered ? '已发送' : '拒绝', style: const TextStyle(fontSize: 13)),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton(
                      onPressed: answered || _sending ? null : () => _sendApproval(true),
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFF4E7FA8),
                        minimumSize: const Size(0, 38),
                      ),
                      child: _sending
                          ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white70))
                          : const Text('允许一次', style: TextStyle(fontSize: 13)),
                    ),
                  ),
                ],
              ),
            ),
          ] else ...[
            // 高度兜底在 _ApprovalBar 外层(Flexible+滚动):这里不再自行设限
            // ——按屏高/viewInsets 算约束在 Scaffold body 内都拿不到真值。
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [for (final q in c.questions) _questionBlock(q, answered)],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: answered || _sending ? null : _sendAnswers,
                  style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xFF4E7FA8),
                    minimumSize: const Size(0, 38),
                  ),
                  child: _sending
                      ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white70))
                      : Text(answered ? '已提交' : '提交回答', style: const TextStyle(fontSize: 13)),
                ),
              ),
            ),
          ],
          if (_error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
              child: Text(_error!, style: const TextStyle(fontSize: 12, color: Color(0xFFE57373))),
            ),
        ],
      ),
    );
  }

  Widget _questionBlock(WorkQuestion q, bool answered) {
    final sel = _selOf(q);
    final title = q.header != null && q.header!.isNotEmpty ? '${q.header}：${q.question}' : q.question;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontSize: 12.5, color: Colors.white70)),
          if (q.detail != null && q.detail!.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(q.detail!, style: const TextStyle(fontSize: 11.5, color: Colors.white38)),
            ),
          for (final opt in q.options)
            InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: answered
                  ? null
                  : () => setState(() {
                        if (q.multiSelect) {
                          sel.contains(opt.label) ? sel.remove(opt.label) : sel.add(opt.label);
                        } else {
                          sel
                            ..clear()
                            ..add(opt.label);
                        }
                      }),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 5),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      q.multiSelect
                          ? (sel.contains(opt.label) ? Icons.check_box : Icons.check_box_outline_blank)
                          : (sel.contains(opt.label) ? Icons.radio_button_checked : Icons.radio_button_unchecked),
                      size: 16,
                      color: sel.contains(opt.label) ? const Color(0xFFA5CCEE) : Colors.white38,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(opt.label, style: TextStyle(fontSize: 12.5, color: sel.contains(opt.label) ? const Color(0xFFA5CCEE) : Colors.white70)),
                          if (opt.description != null && opt.description!.isNotEmpty)
                            Text(opt.description!, style: const TextStyle(fontSize: 11, color: Colors.white38)),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          // 自定义输入（无选项时的自由回答，或有选项时的补充说明）
          if (q.options.isEmpty || _custom.containsKey(q.id))
            Padding(
              padding: const EdgeInsets.only(top: 4, bottom: 2),
              child: TextField(
                controller: _custom.putIfAbsent(q.id, () => TextEditingController()),
                enabled: !answered,
                maxLines: 2,
                style: const TextStyle(fontSize: 12.5),
                decoration: InputDecoration(
                  hintText: q.options.isEmpty ? '输入你的回答…' : '补充说明（可选）',
                  isDense: true,
                  filled: true,
                  fillColor: const Color(0xFF242A32),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
                ),
              ),
            )
          else if (q.options.isNotEmpty)
            TextButton(
              onPressed: answered
                  ? null
                  : () => setState(() {
                        // 展开自定义输入框
                        _custom.putIfAbsent(q.id, () => TextEditingController());
                      }),
              style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 0), minimumSize: const Size(0, 28)),
              child: const Text('+ 自定义回答', style: TextStyle(fontSize: 11.5, color: Colors.white38)),
            ),
        ],
      ),
    );
  }
}

// ── inline status strips ─────────────────────────────────────────────────────

/// Inline banners between the timeline and the composer: the in-chat
/// "connection lost" strip (the link chip lives on the session list only, so
/// a dead link mid-chat used to read as a frozen model with a live stop
/// button) and the previous turn's end reason when it was not a clean
/// completion (error / max-tokens / interrupted — previously invisible).
class _InlineStatusStrip extends StatelessWidget {
  final WorkStore work;
  const _InlineStatusStrip({required this.work});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: work.linkDown,
      builder: (context, down, _) => ValueListenableBuilder<String?>(
        valueListenable: work.archivedBanner,
        builder: (context, archived, _) => ValueListenableBuilder<String?>(
          valueListenable: work.lastTurnEnd,
          builder: (context, reason, _) {
            final rows = <Widget>[];
            if (down) {
              rows.add(const Padding(
                padding: EdgeInsets.symmetric(vertical: 5, horizontal: 14),
                child: Row(
                  children: [
                    Icon(Icons.wifi_off, size: 13, color: Color(0xFFE57373)),
                    SizedBox(width: 6),
                    Expanded(child: Text('与电脑的连接已断开，正在等待恢复…', style: TextStyle(fontSize: 11, color: Color(0xFFE57373)))),
                  ],
                ),
              ));
            }
            if (archived != null) {
              rows.add(Padding(
                padding: const EdgeInsets.symmetric(vertical: 5, horizontal: 14),
                child: Row(
                  children: [
                    const Icon(Icons.archive_outlined, size: 13, color: Color(0xFFFFB74D)),
                    const SizedBox(width: 6),
                    Expanded(child: Text(archived, style: const TextStyle(fontSize: 11, color: Color(0xFFFFB74D)))),
                    TextButton(
                      onPressed: work.leaveSession,
                      style: TextButton.styleFrom(minimumSize: const Size(0, 26), padding: const EdgeInsets.symmetric(horizontal: 8)),
                      child: const Text('返回列表', style: TextStyle(fontSize: 11, color: Colors.white38)),
                    ),
                  ],
                ),
              ));
            }
            const badReasons = {'error', 'max-tokens', 'interrupted', 'aborted'};
            if (reason != null && badReasons.contains(reason)) {
              rows.add(Padding(
                padding: const EdgeInsets.symmetric(vertical: 5, horizontal: 14),
                child: Row(
                  children: [
                    const Icon(Icons.info_outline, size: 13, color: Color(0xFFFFB74D)),
                    const SizedBox(width: 6),
                    Expanded(child: Text(_turnEndLabel(reason), style: const TextStyle(fontSize: 11, color: Color(0xFFFFB74D)))),
                  ],
                ),
              ));
            }
            if (rows.isEmpty) return const SizedBox.shrink();
            return Column(mainAxisSize: MainAxisSize.min, children: rows);
          },
        ),
      ),
    );
  }
}

String _turnEndLabel(String reason) {
  switch (reason) {
    case 'error':
      return '上一回合异常结束（模型/网络错误）';
    case 'max-tokens':
      return '上一回合因长度上限被截断';
    case 'interrupted':
      return '上一回合已被中断';
    case 'aborted':
      return '上一回合已中止';
    default:
      return '回合结束：$reason';
  }
}

// ── composer ──────────────────────────────────────────────────────────────────

class _Composer extends StatelessWidget {
  final WorkStore work;
  final TextEditingController controller;
  final FocusNode focus;
  final VoidCallback onSend;
  final List<WorkSendAttachment> attachments;
  final VoidCallback onAttach;

  const _Composer({required this.work, required this.controller, required this.focus, required this.onSend, required this.attachments, required this.onAttach});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: work.agentRunning,
      builder: (context, running, _) => ValueListenableBuilder<String>(
        valueListenable: work.streamingText,
        builder: (context, streaming, _) {
          final busy = running || streaming.isNotEmpty;
          return Container(
            padding: EdgeInsets.fromLTRB(10, 6, 10, 6 + MediaQuery.of(context).padding.bottom * 0),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                // attachment source picker: 相册 or the linked viewfinder shot
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: IconButton(
                    icon: Icon(
                      attachments.isEmpty ? Icons.image_outlined : Icons.image,
                      size: 24,
                      color: attachments.isEmpty ? Colors.white38 : const Color(0xFFFFB74D),
                    ),
                    tooltip: '添加图片',
                    onPressed: onAttach,
                  ),
                ),
                const SizedBox(width: 2),
                Expanded(
                  child: TextField(
                    controller: controller,
                    focusNode: focus,
                    minLines: 1,
                    maxLines: 5,
                    style: const TextStyle(fontSize: 15),
                    textInputAction: TextInputAction.newline,
                    decoration: InputDecoration(
                      hintText: busy ? '模型运行中——发送将排队' : '输入消息… (/ 命令 · @ 引用)',
                      hintStyle: const TextStyle(fontSize: 13, color: Colors.white24),
                      filled: true,
                      fillColor: const Color(0xFF1E2228),
                      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(22), borderSide: BorderSide.none),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                // 发送/停止共用同一主按钮,只换图标:位置固定防误触,不用确认框。
                // 有草稿(文字或图片)时它永远是发送(运行中也只是入队)——点发送的
                // 位置永远不能变成停止(Happy 的 InputBar 铁律)。
                ValueListenableBuilder<TextEditingValue>(
                  valueListenable: controller,
                  builder: (context, tv, _) {
                    final hasDraft = tv.text.trim().isNotEmpty || attachments.isNotEmpty;
                    if (hasDraft || !busy) {
                      return _MainButton(
                        icon: Icons.arrow_upward,
                        onTap: hasDraft ? onSend : null,
                      );
                    }
                    return _MainButton(
                      icon: Icons.stop,
                      color: const Color(0xFFE57373),
                      onTap: () async {
                        // a dead link cannot reach the host: without this the
                        // stop spins 15s into a generic "停止失败"
                        if (work.linkDown.value) {
                          if (context.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('连接已断开，等待恢复…'), duration: Duration(seconds: 2)));
                          }
                          return;
                        }
                        HapticFeedback.mediumImpact();
                        final err = await work.cancel();
                        if (err != null && context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err), duration: const Duration(seconds: 2)));
                        }
                      },
                    );
                  },
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// Composer-suggestion panel: `/` shows the host command directory (zh/en
/// alias aware, locally filtered), `@` shows cwd file/dir candidates plus
/// referenced sessions. Sits directly above the input, mirrors the desktop
/// combobox semantics (focus never leaves the field).
class _SuggestPanel extends StatelessWidget {
  final _SuggestKind kind;
  final String query;
  final List<WorkCommandInfo>? commands;
  final WorkMentionResult? mentions;
  final bool loading;
  final ValueChanged<WorkCommandInfo> onCommand;
  final ValueChanged<WorkMentionFile> onFile;
  final ValueChanged<WorkMentionSession> onSession;

  const _SuggestPanel({
    required this.kind,
    required this.query,
    required this.commands,
    required this.mentions,
    required this.loading,
    required this.onCommand,
    required this.onFile,
    required this.onSession,
  });

  Widget _hint(String text) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(
          children: [
            if (loading) ...[
              const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.6, color: Colors.white24)),
              const SizedBox(width: 8),
            ],
            Text(text, style: const TextStyle(fontSize: 12, color: Colors.white30)),
          ],
        ),
      );

  Widget _groupLabel(String text) => Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 2),
        child: Text(text, style: const TextStyle(fontSize: 10, color: Colors.white24, letterSpacing: 1.2)),
      );

  @override
  Widget build(BuildContext context) {
    final children = <Widget>[];
    if (kind == _SuggestKind.command) {
      children.add(_groupLabel('命令'));
      final q = query.toLowerCase();
      final hits = (commands ?? const <WorkCommandInfo>[])
          .where((c) => q.isEmpty
              ? true
              : c.name.toLowerCase().contains(q) ||
                  c.aliases.any((a) => a.toLowerCase().contains(q)) ||
                  (c.description?.toLowerCase().contains(q) ?? false))
          .toList();
      if (commands == null && loading) {
        children.add(_hint('正在获取命令列表…'));
      } else if (hits.isEmpty) {
        children.add(_hint('无匹配命令'));
      } else {
        for (final c in hits) {
          final zh = c.aliases.where((a) => RegExp(r'[\u4e00-\u9fa5]').hasMatch(a)).toList();
          children.add(ListTile(
            dense: true,
            visualDensity: VisualDensity.compact,
            leading: const Icon(Icons.terminal, size: 18, color: Color(0xFFFFB74D)),
            title: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Flexible(child: Text('/${c.name}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, fontFamily: 'monospace'))),
                if (zh.isNotEmpty) ...[
                  const SizedBox(width: 6),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                    decoration: BoxDecoration(color: const Color(0x22FFB74D), borderRadius: BorderRadius.circular(4)),
                    child: Text('/${zh.first}', style: const TextStyle(fontSize: 10, color: Color(0xFFFFD48A))),
                  ),
                ],
              ],
            ),
            subtitle: (c.description?.isNotEmpty ?? false) ? Text(c.description!, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, color: Colors.white38)) : null,
            onTap: () => onCommand(c),
          ));
        }
      }
    } else {
      final m = mentions;
      if (loading && m == null) {
        children.add(_hint('搜索中…'));
      } else if (m == null || (m.files.isEmpty && m.sessions.isEmpty)) {
        children.add(_hint('无匹配'));
      } else {
        if (m.sessions.isNotEmpty) {
          children.add(_groupLabel('会话'));
          for (final s in m.sessions) {
            children.add(ListTile(
              dense: true,
              visualDensity: VisualDensity.compact,
              leading: const Icon(Icons.forum_outlined, size: 18, color: Color(0xFF64B5F6)),
              title: Text(s.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
              onTap: () => onSession(s),
            ));
          }
        }
        if (m.files.isNotEmpty) {
          children.add(_groupLabel('文件'));
          for (final f in m.files) {
            children.add(ListTile(
              dense: true,
              visualDensity: VisualDensity.compact,
              leading: Icon(
                f.isDirectory ? Icons.folder_outlined : Icons.insert_drive_file_outlined,
                size: 18,
                color: f.isDirectory ? const Color(0xFFFFB74D) : Colors.white38,
              ),
              title: Text(
                f.isDirectory ? '${f.path}/' : f.path,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12.5, fontFamily: 'monospace'),
              ),
              trailing: f.isDirectory ? const Icon(Icons.chevron_right, size: 16, color: Colors.white24) : null,
              onTap: () => onFile(f),
            ));
          }
        }
      }
    }
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 0, 10, 4),
      constraints: const BoxConstraints(maxHeight: 244),
      decoration: BoxDecoration(
        color: const Color(0xFF1E2228),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0x14FFFFFF)),
      ),
      child: ListView(shrinkWrap: true, padding: const EdgeInsets.symmetric(vertical: 4), children: children),
    );
  }
}

/// Draft image chips above the composer: thumbnail + per-item remove.
class _AttachmentBar extends StatelessWidget {
  final List<WorkSendAttachment> attachments;
  final ValueChanged<int> onRemove;
  const _AttachmentBar({required this.attachments, required this.onRemove});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 78,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(10, 4, 10, 4),
        itemCount: attachments.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (context, i) {
          final a = attachments[i];
          return Stack(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.memory(a.bytes, width: 70, height: 70, fit: BoxFit.cover, gaplessPlayback: true),
              ),
              Positioned(
                right: -2,
                top: -2,
                child: GestureDetector(
                  onTap: () => onRemove(i),
                  child: Container(
                    width: 20,
                    height: 20,
                    decoration: const BoxDecoration(color: Colors.black87, shape: BoxShape.circle),
                    child: const Icon(Icons.close, size: 14, color: Colors.white70),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _MainButton extends StatelessWidget {
  final IconData icon;
  final VoidCallback? onTap;
  final Color? color;
  const _MainButton({required this.icon, this.onTap, this.color});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: onTap == null ? Colors.white10 : (color ?? const Color(0xFF3B7CB5)),
      borderRadius: BorderRadius.circular(22),
      child: InkWell(
        borderRadius: BorderRadius.circular(22),
        onTap: onTap,
        child: SizedBox(width: 44, height: 44, child: Icon(icon, size: 22, color: onTap == null ? Colors.white24 : Colors.white)),
      ),
    );
  }
}

// ── model picker sheet ────────────────────────────────────────────────────────

Future<void> showModelSheet(BuildContext context, WorkStore work) async {
  await work.loadCatalog();
  if (!context.mounted) return;
  await showModalBottomSheet(
    context: context,
    backgroundColor: const Color(0xFF1E2228),
    isScrollControlled: true,
    builder: (context) => _ModelSheet(work: work),
  );
}

class _ModelSheet extends StatefulWidget {
  final WorkStore work;
  const _ModelSheet({required this.work});

  @override
  State<_ModelSheet> createState() => _ModelSheetState();
}

class _ModelSheetState extends State<_ModelSheet> {
  bool _switching = false;
  String? _error;
  WorkModelInfo? _effortsFor;

  @override
  void initState() {
    super.initState();
    // 会话中途换模型不影响运行中的 turn(下次生效),所以 running 时不禁用入口
    if (widget.work.currentModel.value == null) {
      final def = widget.work.catalog.value?.defaultSelection;
      if (def != null) widget.work.currentModel.value = def;
    }
  }

  Future<void> _pick(String provider, WorkModelInfo m) async {
    if (m.efforts.length > 1) {
      setState(() => _effortsFor = m);
      return;
    }
    await _apply(provider, m, m.defaultEffort);
  }

  Future<void> _apply(String provider, WorkModelInfo m, String? effort) async {
    setState(() {
      _switching = true;
      _error = null;
    });
    final err = await widget.work.selectModel(provider, m.id, effort);
    if (!mounted) return;
    setState(() {
      _switching = false;
      _error = err;
    });
    if (err == null) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final catalog = widget.work.catalog.value;
    final current = widget.work.currentModel.value;
    final efforts = _effortsFor;
    return SafeArea(
      child: Container(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.72),
        padding: const EdgeInsets.all(16),
        child: _switching
            ? const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()))
            : ListView(
                shrinkWrap: true,
                children: [
                  Row(
                    children: [
                      if (efforts != null)
                        IconButton(icon: const Icon(Icons.arrow_back), onPressed: () => setState(() => _effortsFor = null))
                      else
                        const Icon(Icons.tune, size: 18, color: Colors.white38),
                      const SizedBox(width: 6),
                      Text(efforts != null ? '${efforts.name} · 推理档位' : '模型', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                    ],
                  ),
                  if (_error != null) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(_error!, style: const TextStyle(color: Color(0xFFE57373), fontSize: 13))),
                  if (catalog == null)
                    const Padding(padding: EdgeInsets.all(20), child: Center(child: Text('模型目录不可用', style: TextStyle(color: Colors.white38))))
                  else if (efforts != null)
                    ...efforts.efforts.map((e) => ListTile(
                          contentPadding: EdgeInsets.zero,
                          title: Text(e.name ?? e.id, style: const TextStyle(fontSize: 14)),
                          subtitle: e.description == null ? null : Text(e.description!, style: const TextStyle(fontSize: 11, color: Colors.white38)),
                          trailing: e.id == efforts.defaultEffort ? const Text('(默认)', style: TextStyle(fontSize: 11, color: Colors.white24)) : null,
                          onTap: () => _apply(_effortsGroup!.id, efforts, e.id),
                        ))
                  else
                    ...catalog.groups.map((g) => Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Padding(
                              padding: const EdgeInsets.only(top: 12, bottom: 4),
                              child: Text(g.name, style: const TextStyle(fontSize: 12, color: Colors.white38)),
                            ),
                            ...g.models.map((m) {
                              final isCurrent = current?['provider'] == g.id && current?['model'] == m.id;
                              return ListTile(
                                contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                                dense: true,
                                title: Text(m.name, style: const TextStyle(fontSize: 14)),
                                subtitle: m.description == null ? null : Text(m.description!, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, color: Colors.white30)),
                                trailing: isCurrent ? const Icon(Icons.check, size: 18, color: Color(0xFF4CAF50)) : null,
                                onTap: () => _pick(g.id, m),
                              );
                            }),
                          ],
                        )),
                  if (catalog != null && catalog.failures.isNotEmpty) ...[
                    const SizedBox(height: 10),
                    ...catalog.failures.map((f) => Padding(
                          padding: const EdgeInsets.symmetric(vertical: 2),
                          child: Text(f, style: const TextStyle(fontSize: 11, color: Colors.white24)),
                        )),
                  ],
                ],
              ),
      ),
    );
  }

  WorkModelGroup? get _effortsGroup {
    final m = _effortsFor;
    if (m == null) return null;
    for (final g in widget.work.catalog.value?.groups ?? <WorkModelGroup>[]) {
      if (g.models.contains(m)) return g;
    }
    return null;
  }
}

// ── file browser sheet ────────────────────────────────────────────────────────

Future<void> showFileSheet(BuildContext context, WorkStore work, LensStore store) async {
  await showModalBottomSheet(
    context: context,
    backgroundColor: const Color(0xFF1E2228),
    isScrollControlled: true,
    builder: (context) => _FileSheet(work: work, store: store),
  );
}

class _FileSheet extends StatefulWidget {
  final WorkStore work;
  final LensStore store;
  const _FileSheet({required this.work, required this.store});

  @override
  State<_FileSheet> createState() => _FileSheetState();
}

class _FileSheetState extends State<_FileSheet> {
  final List<String> _stack = <String>['.'];
  List<WorkFileEntry>? _entries;
  String? _error;
  bool _loading = true;

  final Set<String> _downloadingPaths = {};
  final Map<String, GlobalKey<_DownloadActionButtonState>> _btnKeys = {};

  // 文件查看状态
  String? _viewingName;
  String? _viewingLocalPath;
  bool _viewingAsTxt = false;
  String? _viewingTxt;
  bool _viewingLoading = false;

  @override
  void initState() {
    super.initState();
    globalWorkDownloadsVersion.addListener(_onDownloadsChanged);
    _load();
  }

  @override
  void dispose() {
    globalWorkDownloadsVersion.removeListener(_onDownloadsChanged);
    super.dispose();
  }

  void _onDownloadsChanged() {
    if (mounted) setState(() {});
  }

  String get _cwd => _stack.last;
  String get _wsName => widget.work.currentWorkspaceName();

  static bool _isImageFile(String name) {
    final ext = name.split('.').last.toLowerCase();
    return {'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'}.contains(ext);
  }

  static bool _isTxtFile(String name) {
    final ext = name.split('.').last.toLowerCase();
    return ext == 'txt';
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final entries = await widget.work.listFiles(_cwd);
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (entries == null) {
        _error = '目录读取失败 (先进入会话以确定工作目录)';
        _entries = null;
      } else {
        _entries = entries;
      }
    });
  }

  Future<void> _startDownload(String remotePath, String fileName) async {
    if (_downloadingPaths.contains(remotePath)) return;
    setState(() {
      _downloadingPaths.add(remotePath);
    });
    final localPath = await widget.work.downloadFile(
      remotePath,
      workspaceName: _wsName,
      store: widget.store,
    );
    if (!mounted) return;
    setState(() {
      _downloadingPaths.remove(remotePath);
    });
    if (localPath == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('文件下载失败，请检查连接'), duration: Duration(seconds: 2)),
      );
    }
  }

  Future<void> _openLocalFile(String name, String localPath) async {
    setState(() {
      _viewingName = name;
      _viewingLocalPath = localPath;
      _viewingAsTxt = _isTxtFile(name);
      _viewingTxt = null;
      _viewingLoading = false;
    });
    if (_isTxtFile(name)) {
      _loadTxtContent(localPath);
    }
  }

  Future<void> _loadTxtContent(String localPath) async {
    setState(() => _viewingLoading = true);
    String txt = '';
    try {
      final file = File(localPath);
      final bytes = await file.readAsBytes();
      try {
        txt = utf8.decode(bytes);
      } catch (_) {
        txt = String.fromCharCodes(bytes);
      }
    } catch (e) {
      txt = '读取文件失败: $e';
    }
    if (!mounted) return;
    setState(() {
      _viewingLoading = false;
      _viewingTxt = txt;
    });
  }

  void _closeViewer() {
    setState(() {
      _viewingName = null;
      _viewingLocalPath = null;
      _viewingTxt = null;
      _viewingAsTxt = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.76,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 6),
              child: Row(
                children: [
                  const Icon(Icons.folder_open, size: 18, color: Colors.white38),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _viewingName != null ? '查看 · $_viewingName' : (_cwd == '.' ? '工作目录 ($_wsName)' : _cwd),
                      style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (_viewingName == null && _stack.length > 1)
                    IconButton(
                      icon: const Icon(Icons.arrow_upward, size: 18),
                      onPressed: () {
                        setState(() => _stack.removeLast());
                        _load();
                      },
                    ),
                  if (_viewingName == null)
                    IconButton(icon: const Icon(Icons.refresh, size: 18), onPressed: _load),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: _viewingName != null ? _buildFileViewer() : _buildFileList(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildFileList() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(child: Text(_error!, style: const TextStyle(color: Colors.white38, fontSize: 13)));
    }
    final entries = _entries ?? [];
    if (entries.isEmpty) {
      return const Center(child: Text('目录为空', style: TextStyle(color: Colors.white38, fontSize: 13)));
    }
    return ListView.builder(
      itemCount: entries.length,
      itemBuilder: (context, i) {
        final e = entries[i];
        final isDir = e.type == 'directory';
        final remotePath = _cwd == '.' ? e.name : '$_cwd/${e.name}';
        final isDownloaded = !isDir && widget.store.isWorkFileDownloaded(_wsName, remotePath);
        final isDownloading = _downloadingPaths.contains(remotePath);
        final btnKey = _btnKeys.putIfAbsent(remotePath, () => GlobalKey<_DownloadActionButtonState>());

        return ListTile(
          dense: true,
          leading: Icon(
            isDir
                ? Icons.folder
                : _isImageFile(e.name)
                    ? Icons.image_outlined
                    : Icons.insert_drive_file_outlined,
            size: 18,
            color: isDir
                ? const Color(0xFF90A4AE)
                : _isImageFile(e.name)
                    ? const Color(0xFF81D4FA)
                    : Colors.white38,
          ),
          title: Text(e.name, style: const TextStyle(fontSize: 13, fontFamily: 'monospace')),
          subtitle: e.size != null
              ? Text(_fmtSize(e.size!), style: const TextStyle(fontSize: 11, color: Colors.white24))
              : null,
          trailing: isDir
              ? const Icon(Icons.chevron_right, size: 16, color: Colors.white24)
              : _DownloadActionButton(
                  key: btnKey,
                  isDownloaded: isDownloaded,
                  isDownloading: isDownloading,
                  onDownload: () => _startDownload(remotePath, e.name),
                ),
          onTap: () {
            if (isDir) {
              setState(() {
                _stack.add(_cwd == '.' ? e.name : '$_cwd/${e.name}');
              });
              _load();
            } else {
              if (isDownloaded) {
                final localPath = widget.store.getDownloadedLocalPath(_wsName, remotePath);
                if (localPath != null) {
                  _openLocalFile(e.name, localPath);
                } else {
                  btnKey.currentState?.flash();
                }
              } else {
                // 未下载点文件: 金光闪两下 (0.4s-0.4s灭-0.4s) 提示用户
                btnKey.currentState?.flash();
              }
            }
          },
        );
      },
    );
  }

  Widget _buildFileViewer() {
    final name = _viewingName ?? '';
    final localPath = _viewingLocalPath ?? '';
    final isImg = _isImageFile(name);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              InkWell(
                onTap: _closeViewer,
                child: const Padding(
                  padding: EdgeInsets.symmetric(vertical: 4, horizontal: 2),
                  child: Text('← 返回列表', style: TextStyle(fontSize: 13, color: Color(0xFF7CB0D8))),
                ),
              ),
              const Spacer(),
              Text(_fmtSize(File(localPath).lengthSync()), style: const TextStyle(fontSize: 11, color: Colors.white38)),
            ],
          ),
          const SizedBox(height: 8),
          Expanded(
            child: isImg
                ? Center(
                    child: InteractiveViewer(
                      child: Image.file(
                        File(localPath),
                        fit: BoxFit.contain,
                        errorBuilder: (_, __, ___) => const Center(
                          child: Text('图片加载失败', style: TextStyle(color: Colors.white38)),
                        ),
                      ),
                    ),
                  )
                : (_viewingAsTxt
                    ? (_viewingLoading
                        ? const Center(child: CircularProgressIndicator())
                        : SingleChildScrollView(
                            child: SelectableText(
                              _viewingTxt ?? '',
                              style: const TextStyle(fontSize: 12, fontFamily: 'monospace', height: 1.45),
                            ),
                          ))
                    : Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              name,
                              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                              textAlign: TextAlign.center,
                            ),
                            const SizedBox(height: 8),
                            const Text(
                              '该文件非纯文本/图片格式',
                              style: TextStyle(fontSize: 12, color: Colors.white38),
                            ),
                            const SizedBox(height: 24),
                            // 两个竖排按钮
                            SizedBox(
                              width: 180,
                              child: ElevatedButton.icon(
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: const Color(0xFF2C4A66),
                                  foregroundColor: Colors.white,
                                  padding: const EdgeInsets.symmetric(vertical: 12),
                                ),
                                icon: const Icon(Icons.text_snippet_outlined, size: 18),
                                label: const Text('以txt打开'),
                                onPressed: () {
                                  setState(() => _viewingAsTxt = true);
                                  _loadTxtContent(localPath);
                                },
                              ),
                            ),
                            const SizedBox(height: 12),
                            SizedBox(
                              width: 180,
                              child: ElevatedButton.icon(
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: const Color(0xFF3B5E3F),
                                  foregroundColor: Colors.white,
                                  padding: const EdgeInsets.symmetric(vertical: 12),
                                ),
                                icon: const Icon(Icons.open_in_new, size: 18),
                                label: const Text('用其他应用打开'),
                                onPressed: () async {
                                  final err = await openWithChooser(localPath);
                                  if (err != null && mounted) {
                                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
                                  }
                                },
                              ),
                            ),
                          ],
                        ),
                      )),
          ),
        ],
      ),
    );
  }

  String _fmtSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
  }
}

/// 下载按钮: 支持金光闪烁两次 (0.4s亮 - 0.4s灭 - 0.4s亮)
class _DownloadActionButton extends StatefulWidget {
  final bool isDownloaded;
  final bool isDownloading;
  final VoidCallback onDownload;

  const _DownloadActionButton({
    super.key,
    required this.isDownloaded,
    required this.isDownloading,
    required this.onDownload,
  });

  @override
  State<_DownloadActionButton> createState() => _DownloadActionButtonState();
}

class _DownloadActionButtonState extends State<_DownloadActionButton> {
  bool _flashing = false;

  void flash() {
    if (_flashing || widget.isDownloaded || widget.isDownloading) return;
    setState(() => _flashing = true);
    Timer(const Duration(milliseconds: 400), () {
      if (!mounted) return;
      setState(() => _flashing = false);
      Timer(const Duration(milliseconds: 400), () {
        if (!mounted) return;
        setState(() => _flashing = true);
        Timer(const Duration(milliseconds: 400), () {
          if (!mounted) return;
          setState(() => _flashing = false);
        });
      });
    });
  }

  @override
  Widget build(BuildContext context) {
    if (widget.isDownloading) {
      return const SizedBox(
        width: 22,
        height: 22,
        child: Padding(
          padding: EdgeInsets.all(2),
          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.blueAccent),
        ),
      );
    }

    if (widget.isDownloaded) {
      return const Padding(
        padding: EdgeInsets.all(4),
        child: Icon(Icons.check_circle, size: 20, color: Color(0xFF66BB6A)),
      );
    }

    return AnimatedContainer(
      duration: const Duration(milliseconds: 200),
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: _flashing ? const Color(0xFFFFD700).withValues(alpha: 0.35) : Colors.transparent,
        shape: BoxShape.circle,
        boxShadow: _flashing
            ? [
                BoxShadow(
                  color: const Color(0xFFFFD700).withValues(alpha: 0.7),
                  blurRadius: 12,
                  spreadRadius: 3,
                )
              ]
            : null,
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: widget.onDownload,
        child: Icon(
          Icons.file_download_outlined,
          size: 20,
          color: _flashing ? const Color(0xFFFFD700) : Colors.white54,
        ),
      ),
    );
  }
}

// ── devices sheet（多设备在线卡片，lane-08 §4.2b/§5）─────────────────────────

Future<void> showDevicesSheet(BuildContext context, WorkStore work) async {
  await showModalBottomSheet(
    context: context,
    backgroundColor: const Color(0xFF1E2228),
    isScrollControlled: true,
    builder: (context) => _DeviceSheet(work: work),
  );
}

/// 谁连着电脑、各自在看哪个会话。三档强调在 App 端按订阅者视角算
/// （WorkStore.deviceTier）：本会话一级绿 / 同项目次级橙 / 其余无强调 /
/// 离线置灰。空态 = 没有其他在线设备：「只有本机在线」。
class _DeviceSheet extends StatelessWidget {
  final WorkStore work;
  const _DeviceSheet({required this.work});

  String _sessionLabel(String? sid) {
    if (sid == null || sid.isEmpty) return '会话列表';
    for (final s in work.sessions.value) {
      if (s.sessionId == sid) {
        return (s.title?.isNotEmpty ?? false) ? s.title! : '(未命名会话)';
      }
    }
    return '会话 ${sid.length > 8 ? sid.substring(0, 8) : sid}';
  }

  Widget _hint(String text) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
        child: Center(child: Text(text, style: const TextStyle(fontSize: 13, color: Colors.white30))),
      );

  Widget _deviceRow(WorkDeviceRow d) {
    final tier = work.deviceTier(d);
    final isSelf = d.deviceId == work.selfDeviceId;
    final (badge, badgeColor) = switch (tier) {
      0 => ('正在本会话', const Color(0xFF4CAF50)),
      1 => ('同项目', const Color(0xFFFFB74D)),
      3 => ('离线', Colors.white24),
      _ => ('', Colors.white24),
    };
    final titleColor = tier == 3 ? Colors.white24 : Colors.white70;
    return ListTile(
      dense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16),
      leading: Icon(
        Icons.smartphone,
        size: 20,
        color: tier == 0 ? const Color(0xFF4CAF50) : tier == 3 ? Colors.white24 : Colors.white38,
      ),
      title: Row(
        children: [
          Flexible(
            child: Text(
              isSelf ? '${d.name}（本机）' : d.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 14, color: titleColor),
            ),
          ),
          if (badge.isNotEmpty) ...[
            const SizedBox(width: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
              decoration: BoxDecoration(color: badgeColor.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(8)),
              child: Text(badge, style: TextStyle(fontSize: 10, color: badgeColor)),
            ),
          ],
        ],
      ),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 2),
        child: Text(
          tier == 3 ? '离线' : '正在看：${_sessionLabel(d.sessionId)}',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(fontSize: 11, color: tier == 3 ? Colors.white24 : Colors.white38),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ValueListenableBuilder<List<WorkDeviceRow>>(
        valueListenable: work.devices,
        builder: (context, rows, _) {
          final self = work.selfDeviceId;
          final othersOnline = rows.where((d) => d.deviceId != self && d.online).length;
          // 分段排序：本会话 → 同项目 → 其他 → 离线（tier 升序）
          final sorted = [...rows]..sort((a, b) => work.deviceTier(a).compareTo(work.deviceTier(b)));
          return Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
                child: Row(
                  children: [
                    const Icon(Icons.smartphone, size: 15, color: Colors.white38),
                    const SizedBox(width: 7),
                    Text('在线设备 · ${rows.where((d) => d.online).length} 台在线', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: Colors.white70)),
                  ],
                ),
              ),
              if (work.linkDown.value)
                _hint('连接已断开')
              else if (rows.isEmpty || othersOnline == 0)
                _hint('只有本机在线')
              else
                ...sorted.map(_deviceRow),
              const SizedBox(height: 8),
            ],
          );
        },
      ),
    );
  }
}
