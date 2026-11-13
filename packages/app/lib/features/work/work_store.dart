import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:uuid/uuid.dart';

import '../../core/api.dart';
import '../../core/work_socket.dart';

/// One renderable row of the mirrored conversation.
class WorkItem {
  WorkItem({
    required this.key,
    required this.kind,
    this.text = '',
    this.toolName,
    this.argsText,
    this.resultText,
    this.toolOk,
    this.seq,
    this.sendState,
    this.requestId,
    this.interrupted = false,
    this.usage,
    this.contextLabel,
    this.images = const [],
    this.commandName,
    this.commandArgs,
    this.commandId,
    this.commandKind,
    this.commandText,
    this.turn,
    this.toolPath,
    this.group,
  });

  final String key;
  /// user | assistant | tool | context | command
  final String kind;
  String text;
  String? toolName;
  String? argsText;
  String? resultText;
  /// tool rows only: null while running, true/false after the result lands.
  bool? toolOk;
  /// durable seq this row came from (-1 for local/live echoes).
  int? seq;
  /// user rows only: sending → sent → failed (optimistic rows only).
  String? sendState;
  /// user rows only: the prompt idempotency key we minted.
  String? requestId;
  /// user/command rows: the session this row was sent to. Pending rows live
  /// across re-entries of the SAME session (a failed message must not vanish
  /// just because the user backed out and came back); rows of other sessions
  /// are dropped on subscribe so they never leak across chats.
  String? sessionKey;
  bool interrupted;
  /// assistant rows only: token usage summary, when the event carried one.
  String? usage;
  /// context rows only: human label of the injected message's source kind.
  String? contextLabel;
  /// user rows: images that rode the message. Optimistic rows carry the real
  /// bytes (sent from this phone); rows rebuilt from durable events carry
  /// name-only placeholders — never re-fetched just to render history.
  List<WorkImage> images;
  /// command rows (/xxx): parsed pieces + execution outcome.
  String? commandName;
  String? commandArgs;
  String? commandId;
  /// success | error, null while executing.
  String? commandKind;
  String? commandText;
  /// dsh turn number this row belongs to (-1 for live rows without one);
  /// null = outside any turn (compact commands, orphan errors).
  int? turn;
  /// mutation tool rows only: target file path parsed from the call arguments
  /// (drives the "edited N files" card).
  String? toolPath;
  /// turnGroup rows only: the turn's folded content.
  WorkTurnGroup? group;
}

/// File touched by a mutation tool call inside one turn (write/edit/
/// apply_patch/str_replace_editor). Line counts arrive later via the host's
/// workspace-changes summary; -1 while unknown.
class WorkFileEdit {
  WorkFileEdit({required this.path, required this.display});
  final String path;
  final String display;
  int added = -1;
  int deleted = -1;
}

/// One agent turn's process content, folded behind a summary line
/// (desktop parity): tool rows + intermediate narration live inside, the
/// final answer bubble stays exposed in the main list. Present in items as
/// a WorkItem with kind 'turnGroup' — the wrapper row's [group] carries the
/// content. Rebuilt from scratch on every _refold; expand overrides and the
/// changes summary live on the store so they survive rebuilds.
class WorkTurnGroup {
  WorkTurnGroup({required this.key, required this.startSeq, this.turn, this.startTime});
  /// Stable across refolds: `t<turn>` or `t<startSeq>` when the turn number
  /// is unavailable — expand overrides key off this.
  final String key;
  final int startSeq;
  final int? turn;
  /// Unix ms from turn/start (turn/end − start = elapsed).
  final int? startTime;
  int? endTime;
  /// completed | aborted | interrupted | error | max-tokens | forked | …
  String? endReason;
  bool get open => endReason == null;
  /// Call-order tool rows (the expandable detail lines).
  final List<WorkItem> toolRows = [];
  /// Intermediate assistant narration; on turn/end the LAST non-empty one is
  /// promoted out as the exposed final answer.
  final List<WorkItem> notes = [];
  /// seq of the newest workspace/changes event inside this turn (the phone
  /// pulls the host's line-count summary against it).
  int? changesSeq;
  /// Derived from successful mutation calls, deduped per file (last wins).
  final List<WorkFileEdit> fileEdits = [];
  /// Category counts for the collapsed summary line (中文标签 → count).
  final Map<String, int> categoryCounts = {};
}

/// Image attached to a user message row.
class WorkImage {
  WorkImage({required this.name, this.bytes});
  final String name;
  final Uint8List? bytes;
}

/// Outgoing image attachment (pre-compressed on the phone, base64 on the wire).
class WorkSendAttachment {
  const WorkSendAttachment({required this.bytes, required this.name, this.mediaType = 'image/jpeg'});
  final Uint8List bytes;
  final String name;
  final String mediaType;
}

/// Slash-command descriptor for the composer popup.
class WorkCommandInfo {
  WorkCommandInfo({required this.name, this.description, this.aliases = const [], this.attachments = false, this.hint});
  final String name;
  final String? description;
  final List<String> aliases;
  final bool attachments;
  final String? hint;
}

/// @-mention candidate: a file/dir under the session cwd, or a session.
class WorkMentionFile {
  WorkMentionFile({required this.path, required this.kind});
  final String path;
  final String kind; // 'file' | 'directory'
  bool get isDirectory => kind == 'directory';
}

class WorkMentionSession {
  WorkMentionSession({required this.label, this.title, required this.mention});
  final String label;
  final String? title;
  /// Canonical @[label](dsh-session:…) text to insert.
  final String mention;
}

class WorkMentionResult {
  WorkMentionResult({required this.files, required this.sessions});
  final List<WorkMentionFile> files;
  final List<WorkMentionSession> sessions;
}

class WorkSessionRow {
  WorkSessionRow({required this.sessionId, this.title, this.updatedAt = 0, this.running = false, this.blank = false, this.cwd});
  String sessionId;
  String? title;
  int updatedAt;
  bool running;
  bool blank;
  /// Working directory (host-side grouping key).
  String? cwd;
}

/// One row of the host's `work_devices` presence broadcast (lane-08 §3.1):
/// which paired device is connected, which session it is currently watching,
/// and whether its heartbeat is fresh (host: online = ws OPEN && lastSeenAt
/// younger than PRESENCE_FRESH_MS=25s). The three-tier emphasis is computed
/// on THIS side per-viewer — the broadcast frame has no reference point.
class WorkDeviceRow {
  WorkDeviceRow({required this.deviceId, required this.name, this.sessionId, this.cwd, this.online = false});
  final String deviceId;
  final String name;
  /// Session this device is subscribed to; null = sitting on the list page.
  final String? sessionId;
  /// cwd of that session (host cwdCache); null = unknown.
  final String? cwd;
  final bool online;
}

/// An in-flight request: its completer plus the wall-clock deadline the
/// timeout was armed with. The completer itself NEVER completes on timeout
/// (`future.timeout` returns null instead), so reaping by isCompleted alone
/// leaked one entry per lost ack (lane-03 issue-3) — _newReqId also drops
/// entries past their deadline.
class _PendingAck {
  _PendingAck(this.completer, this.deadline);
  final Completer<Map<String, dynamic>?> completer;
  final DateTime deadline;
}

class WorkApproval {
  WorkApproval({required this.id, this.toolName, this.reason});
  final String id;
  final String? toolName;
  final String? reason;
}

/// One interactive card (approval / question) pushed by the host's waterfall
/// answerer. Whichever end (phone/desktop) answers first wins; the loser's
/// card is torn down by approval_resolved.
class WorkInteraction {
  WorkInteraction({
    required this.id,
    required this.kind,
    this.toolName,
    this.callId,
    this.reason,
    this.displayReason,
    this.questions = const [],
  });
  final String id;
  /// 'approval' | 'question'
  final String kind;
  final String? toolName;
  /// Links to the already-streamed tool row (desktop parity: never a second
  /// copy of the arguments — the timeline owns them).
  final String? callId;
  final String? reason;
  final String? displayReason;
  final List<WorkQuestion> questions;

  /// Local state: this phone already sent an answer (button stays visible but
  /// disabled until approval_resolved arrives).
  bool answered = false;
}

/// One prompt inside a question card.
class WorkQuestion {
  WorkQuestion({required this.id, required this.question, this.detail, this.header, this.multiSelect = false, this.options = const []});
  final String id;
  final String question;
  final String? detail;
  final String? header;
  final bool multiSelect;
  final List<WorkQuestionOption> options;
}

class WorkQuestionOption {
  WorkQuestionOption({required this.label, this.description});
  final String label;
  final String? description;
}

class WorkModelInfo {
  WorkModelInfo({required this.id, required this.name, this.description, this.efforts = const [], this.defaultEffort});
  final String id;
  final String name;
  final String? description;
  final List<WorkEffortInfo> efforts;
  final String? defaultEffort;
}

class WorkEffortInfo {
  WorkEffortInfo({required this.id, required this.name, this.description});
  final String id;
  final String? name;
  final String? description;
}

class WorkModelGroup {
  WorkModelGroup({required this.id, required this.name, required this.models});
  final String id;
  final String name;
  final List<WorkModelInfo> models;
}

class WorkModelCatalog {
  WorkModelCatalog({required this.groups, this.defaultSelection, this.failures = const []});
  final List<WorkModelGroup> groups;
  final Map<String, String>? defaultSelection; // {provider, model, reasoningEffort?}
  final List<String> failures;

  WorkModelInfo? find(String provider, String model) {
    for (final g in groups) {
      if (g.id != provider) continue;
      for (final m in g.models) {
        if (m.id == model) return m;
      }
    }
    return null;
  }
}

class WorkFileEntry {
  WorkFileEntry({required this.name, required this.type, this.size});
  final String name;
  final String type; // file | directory | other
  final int? size;
}

/// 「工作(Beta)」client state: owns the work websocket, folds durable events +
/// live stream frames into renderable rows, and relays phone→host requests.
///
/// Everything is request-driven (the host never speaks for the user), and the
/// whole store is inert until [attach] — no socket, no subscriptions, nothing.
class WorkStore {
  WorkStore._();
  static final instance = WorkStore._();

  WorkSocket? _socket;
  LensStore? _store;
  Timer? _kickDebounce;

  final ValueNotifier<List<WorkSessionRow>> sessions = ValueNotifier([]);
  final ValueNotifier<bool> loadingSessions = ValueNotifier(false);
  final ValueNotifier<String?> sessionListError = ValueNotifier(null);
  Timer? _sessionListTimer;

  final ValueNotifier<String?> subscribedId = ValueNotifier(null);
  final ValueNotifier<bool> loadingSnapshot = ValueNotifier(false);
  final ValueNotifier<String?> snapshotError = ValueNotifier(null);
  Timer? _snapshotTimer;

  final ValueNotifier<List<WorkItem>> items = ValueNotifier([]);
  /// Live streaming buffer for the in-flight assistant reply (the phone's own
  /// conflate: chunks land here and the UI reads the latest value per frame).
  final ValueNotifier<String> streamingText = ValueNotifier('');
  final ValueNotifier<bool> agentRunning = ValueNotifier(false);
  /// Reason of the last observed turn/end (completed / interrupted / error /
  /// max-tokens / aborted …), surfaced as a status chip under the timeline.
  final ValueNotifier<String?> lastTurnEnd = ValueNotifier(null);
  final ValueNotifier<List<WorkApproval>> approvals = ValueNotifier([]);
  /// Interactive cards (approval/question) with real payloads — the old
  /// kind-only [approvals] mirror stays as the fallback for old hosts.
  final ValueNotifier<List<WorkInteraction>> pendingRequests = ValueNotifier([]);
  /// Devices currently connected to the host (work_devices broadcast, lane-08
  /// §3.1) — data source for the in-chat devices sheet. Cleared on detach.
  final ValueNotifier<List<WorkDeviceRow>> devices = ValueNotifier([]);
  final ValueNotifier<WorkModelCatalog?> catalog = ValueNotifier(null);
  final ValueNotifier<Map<String, String>?> currentModel = ValueNotifier(null);
  final ValueNotifier<bool> loadingOlder = ValueNotifier(false);
  bool hasMoreHistory = false;

  /// seq → already folded (durable merge key), NAMESPACED PER SESSION: dsh
  /// counts seq per session from 0 (recheck-3), so a flat Set would let one
  /// session's numbers silently swallow another session's events. Echoes
  /// (seq=-1) bypass this.
  final Map<String, Set<int>> _seenSeqs = {};
  /// Durable events not yet folded into rows (refold happens per frame tick).
  final List<Map<String, dynamic>> _pendingEvents = [];
  /// Live echoes (seq=-1), folded AFTER every durable event so an echo can
  /// never fold ahead of its durable twin and reorder the timeline.
  final List<Map<String, dynamic>> _pendingEchoes = [];
  /// reqId → in-flight request (completer + timeout deadline) for
  /// request/response messages (files, model catalog…).
  final Map<String, _PendingAck> _pendingAcks = {};
  /// reqIds whose caller wants the WHOLE ack frame (`ok`/`reason`/data
  /// merged) instead of the legacy bare-payload shape — without this the
  /// ok/reason envelope is lost and success reads as failure.
  final Set<String> _statusAcks = {};
  /// Optimistic user rows awaiting their durable echo, by requestId.
  final Map<String, WorkItem> _pendingRows = {};
  /// Image bytes THIS phone attached to each send, keyed by requestId. When
  /// the durable user/message later rebuilds the row (the optimistic row was
  /// already adopted by the live echo), the real thumbnails are restored from
  /// here — the durable event carries only attachment names, no bytes.
  final Map<String, List<WorkImage>> _sentImageBytes = {};
  /// Per-turn expand overrides (group key → user's manual open/closed). Lives
  /// here, not on the group: groups are rebuilt on every refold. null entries
  /// never occur — absence means "follow the default rule".
  final Map<String, bool> _turnExpand = {};
  /// workspace-changes line-count summaries keyed by `<sessionId>:<seq>` —
  /// seq is per-session (recheck-3), so a bare-seq key leaked one session's
  /// "edited N files" summary into another (lane-06 issue-1).
  final Map<String, Map<String, dynamic>> _changesCache = {};
  final Set<int> _changesInflight = {};
  /// Coalescing buffer for stream chunks (see _ingestStreamFrame) — chunks
  /// land here and a 50ms timer flushes them into streamingText once.
  final StringBuffer _streamBuf = StringBuffer();
  Timer? _streamFlushTimer;
  /// True while the work WS is down mid-session: the chat view shows an
  /// inline banner (the top-bar link chip lives on the session list only) and
  /// the composer's stop button explains itself — nothing can reach the host.
  final ValueNotifier<bool> linkDown = ValueNotifier(false);
  /// Mirrors WorkSocket.hostRefused (the live socket swaps on re-attach, so
  /// the UI can't hold the socket's notifier directly): 4003 = the PC side's
  /// beta switch is off, which deserves its own hint, not a generic "未连接".
  final ValueNotifier<bool> hostRefused = ValueNotifier(false);
  /// Non-null = the session being viewed was archived on the desktop while
  /// the phone sat in it: persistent banner in the chat view, sends are
  /// rejected by the host with the same reason.
  final ValueNotifier<String?> archivedBanner = ValueNotifier(null);

  String? _host;
  int _port = 0;

  bool get isEnabled => _store?.workBetaEnabled ?? false;

  /// This phone's pairing id (the work_devices rows use it as "me").
  String get selfDeviceId => _deviceId;

  // Test seams (both null in production): [feedFrameForTest] drives the
  // store's normal frame dispatch without a socket; [sendSinkForTest]
  // captures what the store would send instead of touching WorkSocket.
  void feedFrameForTest(Map<String, dynamic> frame) => _onFrame(frame);
  void Function(Map<String, dynamic> frame)? sendSinkForTest;

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /// (Re)bind to the active receiver. Safe to call repeatedly; no-ops when the
  /// beta switch is off or nothing is paired.
  void attach(LensStore store) {
    _store = store;
    if (!store.workBetaEnabled) {
      detach();
      return;
    }
    final s = store.server;
    if (s == null) return;
    if (_socket != null && _host == s.host && _port == s.port && s.deviceId == _deviceId && s.token == _token) return;
    detach();
    _host = s.host;
    _port = s.port;
    _deviceId = s.deviceId;
    _token = s.token;
    loadingSessions.value = sessions.value.isEmpty;
    sessionListError.value = null;
    _socket = WorkSocket(host: s.host, port: s.port, deviceId: s.deviceId, token: s.token, onFrame: _onFrame)
      ..onDisconnected = _onLinkDown;
    _socket!.hostRefused.addListener(_syncHostRefused);
    _socket!.connect();
  }

  String _deviceId = '';
  String _token = '';

  void detach() {
    _sessionListTimer?.cancel();
    _snapshotTimer?.cancel();
    _streamFlushTimer?.cancel();
    _streamFlushTimer = null;
    _streamBuf.clear();
    _kickDebounce?.cancel();
    _kickDebounce = null;
    linkDown.value = false;
    hostRefused.value = false;
    loadingSessions.value = false;
    sessionListError.value = null;
    loadingSnapshot.value = false;
    snapshotError.value = null;
    _socket?.hostRefused.removeListener(_syncHostRefused);
    _socket?.dispose();
    _socket = null;
    subscribedId.value = null;
    sessions.value = [];
    items.value = [];
    streamingText.value = '';
    agentRunning.value = false;
    approvals.value = [];
    pendingRequests.value = [];
    archivedBanner.value = null;
    lastTurnEnd.value = null;
    hasMoreHistory = false;
    loadingOlder.value = false;
    catalog.value = null;
    currentModel.value = null;
    devices.value = [];
    _seenSeqs.clear();
    _pendingEvents.clear();
    _pendingEchoes.clear();
    _pendingRows.clear();
    _sentImageBytes.clear();
    _pendingAcks.clear();
    _statusAcks.clear();
    _changesCache.clear();
    _changesInflight.clear();
    _commandsCache = null;
    _tailClearPending = false;
  }

  /// The beta switch flipped: on → bind (live, no restart), off → unbind.
  void onBetaSwitchChanged(LensStore store) {
    if (store.workBetaEnabled) {
      attach(store);
    } else {
      detach();
    }
  }

  /// Foreground kick: retry a dead link immediately (Android timers freeze in
  /// the background — the same treatment the camera socket gets).
  void kick() {
    if (!isEnabled) return;
    // 配置可能在后台被重新配对改掉（attach 平时只挂在页面回调上）：回前台时
    // 顺手对齐一次。attach 幂等，配置没变是 no-op。
    final st = _store;
    if (st != null) attach(st);
    _socket?.kick();
    final sid = subscribedId.value;
    if (sid != null && _socket?.isConnected == true) {
      // re-subscribe of a session we still hold rows for: carry sinceSeq so
      // the host can skip the already-folded prefix (contract 3)
      final since = _maxSeenSeq();
      _send({'type': 'session_subscribe', 'reqId': _newReqId(), 'sessionId': sid, if (since != null && since > 0) 'sinceSeq': since});
    }
  }

  /// Leave the session back to the list: clear the local subscription AND
  /// tell the host (empty sessionId normalizes to null host-side
  /// bridge.ts:1001, so no dedicated unsubscribe type is needed). Without the
  /// frame the host keeps routing the old session's frames to us and reads us
  /// as "watching it" forever — the devices sheet's three tiers would be
  /// wrong for the most common gesture there is (lane-08 §7 / recheck-2).
  /// Safe with no socket: _send is a no-op then (detach never routes here).
  void leaveSession() {
    subscribedId.value = null;
    _send({'type': 'session_subscribe', 'reqId': _newReqId(), 'sessionId': ''});
  }

  // ── wire ──────────────────────────────────────────────────────────────────

  String _newReqId() {
    // reap finished AND timed-out requests: the completer never completes on
    // timeout, so isCompleted alone leaked one map entry per lost ack
    final now = DateTime.now();
    _pendingAcks.removeWhere((_, p) => p.completer.isCompleted || now.isAfter(p.deadline));
    // status acks ride the same lifecycle: a reqId with no live request is dead
    _statusAcks.removeWhere((r) => !_pendingAcks.containsKey(r));
    return const Uuid().v4();
  }

  void _send(Map<String, dynamic> frame) {
    final sink = sendSinkForTest;
    if (sink != null) {
      sink(frame);
      return;
    }
    _socket?.send(frame);
  }

  Future<Map<String, dynamic>?> _request(Map<String, dynamic> frame, {Duration timeout = const Duration(seconds: 12), bool statusFrame = false}) {
    final reqId = frame['reqId'] as String? ?? _newReqId();
    frame['reqId'] = reqId;
    if (statusFrame) _statusAcks.add(reqId);
    final c = Completer<Map<String, dynamic>?>();
    _pendingAcks[reqId] = _PendingAck(c, DateTime.now().add(timeout));
    _send(frame);
    return c.future.timeout(timeout, onTimeout: () => null);
  }

  void _onFrame(Map<String, dynamic> frame) {
    switch (frame['type'] as String?) {
      case 'work_hello':
        // fresh link: refresh the world, then re-subscribe if we had a session
        linkDown.value = false;
        // Cards we held may have been settled while the link was down (the
        // resolved broadcast missed us) — drop them BEFORE the re-subscribe;
        // the host's subscribe-replay rebuilds still-live ones (id-idempotent).
        pendingRequests.value = [];
        approvals.value = [];
        _request({'type': 'session_list_req'});
        final sid = subscribedId.value;
        if (sid != null) {
          // reconnect, not a fresh entry: items/_seenSeqs survived, so ask the
          // host to skip the already-folded prefix (contract 3 sinceSeq)
          final since = _maxSeenSeq();
          _send({'type': 'session_subscribe', 'reqId': _newReqId(), 'sessionId': sid, if (since != null && since > 0) 'sinceSeq': since});
        }
        break;
      case 'session_list':
        _sessionListTimer?.cancel();
        loadingSessions.value = false;
        sessionListError.value = null;
        _ingestSessionList(frame['sessions'] as List<dynamic>? ?? []);
        break;
      case 'session_snapshot':
        _ingestSnapshot(frame);
        break;
      case 'session_event':
        final ev = frame['event'] as Map<String, dynamic>?;
        final sid = frame['sessionId'] as String?;
        if (ev != null && sid == subscribedId.value) _ingestEvent(ev);
        break;
      case 'stream_frame':
        if (frame['sessionId'] == subscribedId.value) _ingestStreamFrame(frame['frame'] as Map<String, dynamic>?);
        break;
      case 'session_state':
        if (frame['sessionId'] != subscribedId.value) break;
        final running = frame['running'] == true;
        agentRunning.value = running;
        final status = frame['status'] as String?;
        if (!running && status != null && status.isNotEmpty) lastTurnEnd.value = status;
        if (!running) _refreshTail();
        break;
      case 'approval_state':
        if (frame['sessionId'] != subscribedId.value) break;
        approvals.value = ((frame['pending'] as List<dynamic>? ?? []))
            .whereType<Map<String, dynamic>>()
            .map((p) => WorkApproval(id: p['id']?.toString() ?? '', toolName: p['toolName']?.toString(), reason: p['reason']?.toString()))
            .toList();
        // contract 4 reconciliation: when the frame carries the host's live
        // interaction ids, drop our settled cards the resolved broadcast
        // failed to reach us for. Old hosts omit the field — leave the cards.
        if (frame['interactionIds'] is List) {
          final live = (frame['interactionIds'] as List).map((e) => e.toString()).toSet();
          pendingRequests.value = pendingRequests.value.where((c) => live.contains(c.id)).toList();
        }
        break;
      case 'approval_request':
        if (frame['sessionId'] != subscribedId.value) break;
        _ingestInteractionRequest(frame);
        break;
      case 'approval_resolved':
        if (frame['sessionId'] != subscribedId.value) break;
        _ingestInteractionResolved(frame['id']?.toString() ?? '');
        break;
      case 'session_archived':
        if (frame['sessionId'] != subscribedId.value) break;
        archivedBanner.value = '该会话已在电脑端归档，无法继续对话';
        break;
      case 'session_unarchived':
        // contract 2: the archive was lifted while we sat in the session —
        // clear the banner (it only ever covered THIS session's view)
        if (frame['sessionId'] != subscribedId.value) break;
        archivedBanner.value = null;
        break;
      case 'work_devices':
        // presence broadcast (lane-08 §3.1): no subscription routing, every
        // connection gets it; tiering happens per-viewer in deviceTier()
        devices.value = ((frame['devices'] as List<dynamic>? ?? []))
            .whereType<Map<String, dynamic>>()
            .map((d) => WorkDeviceRow(
                  deviceId: d['deviceId']?.toString() ?? '',
                  // lane-08 names the field `name`; the shared contract wrote
                  // `deviceName` — accept either so both host spellings feed
                  // the UI until they converge
                  name: (d['name'] ?? d['deviceName'])?.toString() ?? '未知设备',
                  sessionId: d['sessionId']?.toString(),
                  cwd: d['cwd']?.toString(),
                  online: d['online'] == true,
                ))
            .toList();
        break;
      case 'work_ack':
        _ingestAck(frame);
        break;
      case 'model_changed':
        // another client (phone or the desktop itself) switched this session's
        // model — mirror it; our own switch also round-trips through here and
        // converges on the same authoritative value
        if (frame['sessionId'] == subscribedId.value) {
          currentModel.value = {
            'provider': frame['provider']?.toString() ?? '',
            'model': frame['model']?.toString() ?? '',
            if (frame['reasoningEffort'] != null) 'reasoningEffort': frame['reasoningEffort'].toString(),
          };
        }
        break;
      case 'commands_changed':
        _commandsCache = null;
        break;
      default:
        break;
    }
  }

  void _ingestAck(Map<String, dynamic> frame) {
    final reqId = frame['reqId'] as String?;
    final ok = frame['ok'] == true;
    final data = frame['data'] as Map<String, dynamic>?;
    final reason = frame['reason'] as String?;
    if (reqId == null) return;
    final pending = _pendingAcks.remove(reqId);
    final c = pending?.completer;
    if (c != null && !c.isCompleted) {
      if (_statusAcks.remove(reqId)) {
        // full-frame shape: data merged flat + ok/reason on top — callers
        // doing statusFrame:true check res['ok'] / res['reason'] directly
        c.complete(<String, dynamic>{
          ...?data,
          'ok': ok,
          if (reason != null) 'reason': reason,
        });
      } else {
        c.complete(ok ? (data ?? {}) : null);
      }
    }
    // optimistic row bookkeeping rides the send ack: the host echoes the
    // IDEMPOTENT requestId inside data — the transport reqId above is a fresh
    // UUID per request and can never match _pendingRows' keys (keyed by
    // requestId). Matching by reqId here meant this whole block never ran:
    // command rows never settled off the ack and later duplicated the
    // journal's command/run row after a snapshot rebuild.
    final rid = data?['requestId']?.toString() ?? '';
    final row = rid.isNotEmpty ? _pendingRows[rid] : null;
    if (row != null) {
      if (ok) {
        row.sendState = 'sent';
        // A slash command's ack IS its terminal state: the host executed it
        // synchronously and no durable user-message echo will follow.
        final cmd = data?['command'];
        if (row.kind == 'command' && cmd is Map<String, dynamic>) {
          row.commandId = cmd['commandId']?.toString();
          row.commandKind = cmd['kind']?.toString();
          row.commandText = cmd['text']?.toString();
          row.sendState = 'delivered';
        }
      } else {
        row.sendState = 'failed';
        if (row.kind == 'command' && reason != null && reason.isNotEmpty) row.commandText = reason;
      }
      _publishItems();
    }
  }

  // ── session list ──────────────────────────────────────────────────────────

  void _ingestSessionList(List<dynamic> rows) {
    final sid = subscribedId.value;
    final wasListed = sid != null && sessions.value.any((r) => r.sessionId == sid);
    sessions.value = rows
        .whereType<Map<String, dynamic>>()
        .map((r) => WorkSessionRow(
              sessionId: r['sessionId']?.toString() ?? '',
              title: r['title']?.toString(),
              updatedAt: (r['updatedAt'] as num?)?.toInt() ?? 0,
              running: r['running'] == true,
              blank: r['blank'] == true,
              cwd: r['cwd']?.toString(),
            ))
        .where((r) => r.sessionId.isNotEmpty)
        .toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    // Desktop archives emit no session_archived frame (lane-02 gap D): the
    // session we are viewing vanishing from the list it was in a moment ago
    // is the only signal the phone gets. Raise the same banner the archived
    // frame would; unarchiving clears it via session_unarchived (contract 2).
    // An empty list (host hiccup) is never treated as "archived everything".
    if (wasListed && rows.isNotEmpty && !sessions.value.any((r) => r.sessionId == sid)) {
      archivedBanner.value = '该会话已在电脑端归档，无法继续对话';
    }
  }

  Future<void> refreshSessions() async {
    loadingSessions.value = true;
    sessionListError.value = null;
    _sessionListTimer?.cancel();
    _sessionListTimer = Timer(const Duration(seconds: 12), () {
      if (loadingSessions.value && sessions.value.isEmpty) {
        loadingSessions.value = false;
        sessionListError.value = '获取会话列表超时，请检查电脑端连接';
      }
    });
    final res = await _request({'type': 'session_list_req'});
    _sessionListTimer?.cancel();
    if (res == null && sessions.value.isEmpty) {
      loadingSessions.value = false;
      sessionListError.value = '获取会话列表失败，请检查连接';
    }
  }

  /// Workspace-group "+" button: mint a blank session under [cwd] (the group's
  /// representative path, so the session lands in the same grouping bucket).
  /// Returns the new sessionId, or null on failure/timeout ([error] carries
  /// the reason — an old host silently ignores the unknown request type).
  Future<String?> createSession(String cwd, {Duration timeout = const Duration(seconds: 15)}) async {
    // statusFrame:true → res carries {ok, reason?, ...data} (sessionId flat)
    final res = await _request({'type': 'session_create', 'cwd': cwd}, timeout: timeout, statusFrame: true);
    if (res == null || res['ok'] != true) {
      sessionListError.value = res?['reason']?.toString() ?? '新建会话超时，电脑端可能需要升级插件';
      return null;
    }
    final sessionId = res['sessionId']?.toString();
    if (sessionId == null || sessionId.isEmpty) {
      sessionListError.value = '宿主未返回会话 id';
      return null;
    }
    // NO await refreshSessions() here: the host acks only after its own list
    // push chain runs (which can take seconds on metadata enrichment), and
    // the agent/created → scheduleSessionListRefresh route already updates
    // the list — the "+" must flip into the new chat instantly.
    return sessionId;
  }

  /// Fork the session at [atSeq] (inclusive — desktop turn-tail parity).
  /// [sourceTitle] drives the desktop-style "标题 (1)" child rename. Returns
  /// (childSessionId | null, errorReason | null).
  Future<(String?, String?)> forkSession(String sessionId, {int? atSeq, String? sourceTitle}) async {
    final res = await _request({
      'type': 'session_fork',
      'sessionId': sessionId,
      if (atSeq != null) 'atSeq': atSeq,
      if (sourceTitle != null && sourceTitle.trim().isNotEmpty) 'title': sourceTitle.trim(),
    }, timeout: const Duration(seconds: 30), statusFrame: true);
    if (res == null || res['ok'] != true) {
      return (null, res?['reason']?.toString() ?? '分叉超时，电脑端可能需要升级插件');
    }
    final childId = res['sessionId']?.toString();
    if (childId == null || childId.isEmpty) {
      return (null, '宿主未返回分叉会话 id');
    }
    await refreshSessions(); // the child row must exist before we jump in
    return (childId, null);
  }

  /// Archive (or unarchive) a session. Returns null on success, else the
  /// host's rejection reason (e.g. running session without stopActivity).
  Future<String?> archiveSession(String sessionId, {bool unarchive = false}) async {
    final res = await _request({
      'type': 'session_archive',
      'sessionId': sessionId,
      if (unarchive) 'unarchive': true,
    }, timeout: const Duration(seconds: 15), statusFrame: true);
    if (res == null || res['ok'] != true) {
      return res?['reason']?.toString() ?? '归档超时，电脑端可能需要升级插件';
    }
    return null;
  }

  // ── interactive cards (approval / question) ────────────────────────────────

  void _ingestInteractionRequest(Map<String, dynamic> frame) {
    final id = frame['id']?.toString() ?? '';
    if (id.isEmpty) return;
    final kind = frame['kind']?.toString() == 'question' ? 'question' : 'approval';
    final questions = ((frame['questions'] as List<dynamic>? ?? []))
        .whereType<Map<String, dynamic>>()
        .map((q) => WorkQuestion(
              id: q['id']?.toString() ?? '',
              question: q['question']?.toString() ?? '',
              detail: q['detail']?.toString(),
              header: q['header']?.toString(),
              multiSelect: q['multiSelect'] == true,
              options: ((q['options'] as List<dynamic>? ?? []))
                  .whereType<Map<String, dynamic>>()
                  .map((o) => WorkQuestionOption(label: o['label']?.toString() ?? '', description: o['description']?.toString()))
                  .where((o) => o.label.isNotEmpty)
                  .toList(),
            ))
        .where((q) => q.id.isNotEmpty && q.question.isNotEmpty)
        .toList();
    final list = pendingRequests.value.where((r) => r.id != id).toList()
      ..add(WorkInteraction(
        id: id,
        kind: kind,
        toolName: frame['toolName']?.toString(),
        callId: frame['callId']?.toString(),
        reason: frame['reason']?.toString(),
        displayReason: frame['displayReason']?.toString(),
        questions: questions,
      ));
    pendingRequests.value = list;
  }

  /// Either end settled it — tear the card down (AGENTS.md #22 parity with
  /// the desktop: a card tapped twice must never double-fire).
  void _ingestInteractionResolved(String id) {
    if (id.isEmpty) return;
    final list = pendingRequests.value.where((r) => r.id != id).toList();
    if (list.length != pendingRequests.value.length) {
      pendingRequests.value = list;
    }
  }

  /// Allow/reject an approval card. Local-only optimistic: [WorkInteraction.answered]
  /// greys the buttons until the host broadcasts approval_resolved.
  Future<String?> answerApproval(WorkInteraction card, bool allow) async {
    final res = await _request({
      'type': 'approval_answer',
      'sessionId': subscribedId.value ?? '',
      'id': card.id,
      'outcome': allow ? 'allowed-once' : 'rejected',
    }, timeout: const Duration(seconds: 12), statusFrame: true);
    // res == null also covers ok:false (reason rides in the status frame but
    // the host has already settled the request either way)
    if (res == null || res['ok'] != true) {
      return res?['reason']?.toString() ?? '发送超时，请检查连接';
    }
    card.answered = true;
    pendingRequests.value = [...pendingRequests.value];
    return null;
  }

  /// Submit a question card: one entry per question (selected = option labels,
  /// custom = free text). Returns an error message or null on success.
  Future<String?> answerQuestion(WorkInteraction card, List<Map<String, dynamic>> answers) async {
    final res = await _request({
      'type': 'question_answer',
      'sessionId': subscribedId.value ?? '',
      'id': card.id,
      'answers': answers,
    }, timeout: const Duration(seconds: 12), statusFrame: true);
    if (res == null || res['ok'] != true) {
      return res?['reason']?.toString() ?? '发送超时，请检查连接';
    }
    card.answered = true;
    pendingRequests.value = [...pendingRequests.value];
    return null;
  }

  // ── subscription + folding ────────────────────────────────────────────────

  void subscribe(String sessionId) {
    if (subscribedId.value == sessionId && items.value.isNotEmpty) return;
    subscribedId.value = sessionId;
    items.value = [];
    _streamFlushTimer?.cancel();
    _streamFlushTimer = null;
    _streamBuf.clear();
    streamingText.value = '';
    agentRunning.value = false;
    lastTurnEnd.value = null;
    approvals.value = [];
    pendingRequests.value = [];
    archivedBanner.value = null;
    _seenSeqs.clear();
    _pendingEvents.clear();
    _pendingEchoes.clear();
    _pendingRows.clear();
    hasMoreHistory = false;
    loadingSnapshot.value = true;
    snapshotError.value = null;
    _snapshotTimer?.cancel();
    _snapshotTimer = Timer(const Duration(seconds: 12), () {
      if (loadingSnapshot.value && items.value.isEmpty) {
        loadingSnapshot.value = false;
        snapshotError.value = '加载会话超时，请检查电脑端连接';
      }
    });
    // pending rows of OTHER sessions die here; rows of THIS session survive
    // the re-entry (a failed/sending message must not vanish when the user
    // backs out and comes back). A durable echo with the same requestId later
    // adopts the row via _pendingRows.remove(rpcId) — no duplicates.
    _pendingRows.removeWhere((rid, row) {
      final stale = row.sessionKey != null && row.sessionKey != sessionId;
      // their cached image bytes are dead weight the moment their row dies
      if (stale) _sentImageBytes.remove(rid);
      return stale;
    });
    _send({'type': 'session_subscribe', 'reqId': _newReqId(), 'sessionId': sessionId});
  }

  /// Highest durable seq already folded for the CURRENT session (null = we
  /// hold nothing): rides session_subscribe so a reconnecting host can skip
  /// the replayed prefix (contract 3 sinceSeq). Fresh subscribes clear the
  /// set first and thus naturally send none.
  int? _maxSeenSeq() {
    final sid = subscribedId.value;
    if (sid == null) return null;
    final seen = _seenSeqs[sid];
    if (seen == null || seen.isEmpty) return null;
    var m = seen.first;
    for (final v in seen) {
      if (v > m) m = v;
    }
    return m;
  }

  void _ingestSnapshot(Map<String, dynamic> frame) {
    // Ownership guard (lane-03 issue 1 / contract 3): every snapshot frame —
    // first-shot AND history_page paged — carries the session it belongs to.
    // host pushSnapshot is async (readSession up to 60s): a stale frame sent
    // after the user switched sessions must NOT fold its events into the new
    // timeline, let alone poison the per-session seq set.
    final fsid = frame['sessionId'] as String?;
    if (fsid != subscribedId.value) {
      debugPrint('WorkStore: dropped stale snapshot (frame sessionId=$fsid, subscribed=${subscribedId.value})');
      return;
    }
    _snapshotTimer?.cancel();
    loadingSnapshot.value = false;
    snapshotError.value = null;
    final events = frame['events'] as List<dynamic>? ?? [];
    // merge: snapshots carry the newest window (tail); dedupe by seq, keep order
    for (final e in events) {
      if (e is Map<String, dynamic>) _mergeEvent(e);
    }
    _sortPendingEvents();
    hasMoreHistory = frame['hasMore'] == true;
    _refold();
  }

  /// Fold one durable-shaped event; live echoes (seq=-1) update in place.
  void _mergeEvent(Map<String, dynamic> ev) {
    final seq = (ev['seq'] as num?)?.toInt() ?? -1;
    if (seq >= 0) {
      // per-session namespace (recheck-3: dsh seq restarts at 0 per session);
      // '' is unreachable in production — every caller gates on subscribedId
      final seen = _seenSeqs.putIfAbsent(subscribedId.value ?? '', () => {});
      if (seen.contains(seq)) return;
      seen.add(seq);
      // merge only APPENDS — callers sort once after their batch, never per
      // event (a snapshot of N events used to pay N full-list sorts:
      // O(N²·log N), seconds of CPU on long sessions — recheck-4 P2b)
      _pendingEvents.add(ev);
    } else {
      // live echo (seq=-1): kept in its OWN list. Mixing it into _pendingEvents
      // let the -1 sort to the HEAD of the fold order, so the echo folded
      // before its durable twin, adopted the optimistic row and appended it at
      // rows[0] — the message bubble visually "vanished" (it sat at the very
      // oldest end of the reversed list while the viewport follows the tail).
      _pendingEchoes.add(ev);
    }
  }

  void _sortPendingEvents() {
    _pendingEvents.sort((a, b) => ((a['seq'] as num?) ?? 0).compareTo((b['seq'] as num?) ?? 0));
  }

  void _ingestEvent(Map<String, dynamic> ev) {
    _mergeEvent(ev);
    _sortPendingEvents();
    _refold();
  }

  void _ingestStreamFrame(Map<String, dynamic>? frame) {
    if (frame == null) return;
    switch (frame['type']) {
      case 'start':
        _streamFlushTimer?.cancel();
        _streamFlushTimer = null;
        _streamBuf.clear();
        streamingText.value = '';
        agentRunning.value = true;
        break;
      case 'chunk':
        // coalesce chunks behind a short timer: each chunk used to fire a
        // value change immediately (string concat + full-list rebuild + full
        // markdown reparse) — hundreds of times per second on fast streams
        _streamBuf.write(_extractChunkText(frame['chunk']));
        _streamFlushTimer ??= Timer(const Duration(milliseconds: 50), _flushStreamBuffer);
        break;
      case 'end':
        // flush synchronously first: the durable rows below replace the live
        // buffer, and dropping unflushed bytes would eat the reply's tail
        _streamFlushTimer?.cancel();
        _streamFlushTimer = null;
        if (_streamBuf.isNotEmpty) {
          streamingText.value = streamingText.value + _streamBuf.toString();
          _streamBuf.clear();
        }
        final outcome = frame['outcome'];
        if (outcome is Map<String, dynamic> && outcome['kind'] == 'abandoned') {
          // the stream died without a durable record — drop the live buffer
          streamingText.value = '';
        }
        // committed: the durable rows arrive via the tail refresh below; the
        // live buffer must yield to them the moment the merge lands (otherwise
        // the streaming row and the durable row would coexist forever)
        agentRunning.value = false;
        _refreshTail(clearStreaming: true);
        break;
    }
  }

  void _flushStreamBuffer() {
    _streamFlushTimer = null;
    if (_streamBuf.isEmpty) return;
    streamingText.value = streamingText.value + _streamBuf.toString();
    _streamBuf.clear();
  }

  /// WS died mid-session (link loss, not a user detach): raise the in-chat
  /// banner. Recovery is _onFrame's work_hello path (re-list + re-subscribe),
  /// which clears this again.
  void _onLinkDown() {
    linkDown.value = true;
  }

  void _syncHostRefused() {
    hostRefused.value = _socket?.hostRefused.value ?? false;
  }

  /// Pull the newest tail events after a stream end / turn end / cancel, so
  /// the durable records (assistant/message, tool results, turn/end reason)
  /// land without a full snapshot reload.
  /// Set when a stream end asked the pending tail refresh to also drop the
  /// live buffer — later _refreshTail() callers (agent status etc.) must NOT
  /// erase this flag, they only ever add to the pending refresh.
  bool _tailClearPending = false;

  void _refreshTail({bool clearStreaming = false}) {
    if (clearStreaming) _tailClearPending = true;
    // debounce bursts (turn end + agent status arrive together)
    _kickDebounce?.cancel();
    _kickDebounce = Timer(const Duration(milliseconds: 400), () async {
      final clear = _tailClearPending;
      _tailClearPending = false;
      final sid = subscribedId.value;
      if (sid == null || !(_socket?.isConnected ?? false)) {
        if (clear) streamingText.value = '';
        return;
      }
      final data = await _request({'type': 'history_page', 'sessionId': sid, 'maxMessages': 40});
      if (data == null) {
        // no tail available: still clear the live buffer so the composer's
        // stop state never sticks on a finished stream
        if (clear) streamingText.value = '';
        return;
      }
      _refold();
      if (clear) streamingText.value = '';
    });
  }

  /// Older-history paging cap: without it, holding "load older" grows items,
  /// _seenSeqs and every _refold pass without bound. 2000 rows is far past
  /// any sane reading session; paging just stops there.
  static const _maxRows = 2000;

  Future<void> loadOlder() async {
    final sid = subscribedId.value;
    if (sid == null || loadingOlder.value || !hasMoreHistory) return;
    if (items.value.length >= _maxRows) {
      // capped — stop paging; the UI's "已到最早记录" hint keys off this.
      // hasMoreHistory is a plain bool (no notifier): republish so the list
      // rebuilds and the hint actually shows up.
      hasMoreHistory = false;
      _publishItems();
      return;
    }
    // oldest of THIS session's seqs (per-session namespace, recheck-3): the
    // old global-min cursor was polluted by any other session's numbers
    final seen = _seenSeqs[sid];
    final oldest = (seen == null || seen.isEmpty) ? null : seen.reduce((a, b) => a < b ? a : b);
    loadingOlder.value = true;
    final data = await _request({'type': 'history_page', 'sessionId': sid, 'beforeSeq': oldest, 'maxMessages': 60});
    loadingOlder.value = false;
    if (data == null) return;
    _refold();
  }

  String _extractChunkText(dynamic chunk) {
    // StreamChunk shapes vary by content type; be permissive, render text only
    if (chunk is String) return chunk;
    if (chunk is Map) {
      final t = chunk['text'] ?? chunk['delta'];
      if (t is String) return t;
    }
    return '';
  }

  // ── folding (events → rows) ───────────────────────────────────────────────

  void _refold() {
    final rows = <WorkItem>[];
    final toolRows = <String, WorkItem>{}; // callId → row
    // user-message identity → folded row: the SAME message reaches us as a
    // live echo (seq=-1) AND as a durable event (seq>=0); without this map
    // each occurrence folds its own bubble (the duplicate-bubble bug).
    final userRows = <String, WorkItem>{};
    // commandId → folded /command row (run pairs with done across events)
    final commandRows = <String, WorkItem>{};
    // Desktop-parity turn folding: tool calls + intermediate narration fold
    // into a WorkTurnGroup behind a summary line; the final answer (last
    // non-empty note at turn/end) is promoted back out as an exposed bubble.
    WorkTurnGroup? current;
    final closedGroups = <WorkTurnGroup>[];
    int lastKey = 0;
    String nk() => 'k${lastKey++}';
    // identities/callIds folded from DURABLE events THIS pass — their echo
    // twins (seq=-1, re-evaluated on every refold) are pure re-fold cost once
    // the durable row owns the identity, and get pruned at the end of the pass.
    final durableUserIdentities = <String>{};
    final durableToolCallIds = <String>{};

    void closeGroup(WorkTurnGroup g, {String? reason, int? endTime}) {
      g.endReason = reason;
      g.endTime = endTime;
      _deriveFileEdits(g);
      _countCategories(g);
      // promote the final answer: the last non-empty note is the turn's
      // actual reply and must stay an exposed Markdown bubble
      WorkItem? answer;
      for (final n in g.notes.reversed) {
        if (n.text.isNotEmpty) {
          answer = n;
          break;
        }
      }
      if (answer != null) g.notes.remove(answer);
      rows.add(WorkItem(key: 'turnwrap-${g.key}', kind: 'turnGroup', group: g, seq: g.startSeq));
      if (answer != null) rows.add(answer);
      closedGroups.add(g);
    }

    // Durable events FIRST (seq order), echoes LAST: an echo that adopts its
    // optimistic row appends at the tail (newest), never at the head — the
    // bubble stays where the viewport can see it.
    for (final ev in [..._pendingEvents, ..._pendingEchoes]) {
      final type = ev['type']?.toString() ?? '';
      final data = ev['data'];
      final map = data is Map<String, dynamic> ? data : null;
      final seq = (ev['seq'] as num?)?.toInt() ?? -1;
      final evTime = (ev['time'] as num?)?.toInt();
      switch (type) {
        case 'user/message':
        case 'agent/inbox/inserted': {
          // live echoes carry {message:{…}}; durable events are flattened
          final msg = (map?['message'] as Map<String, dynamic>?) ?? map;
          final source = msg?['source'];
          final sourceKind = source is Map ? source['kind']?.toString() : null;
          // Prompt injections and synthetic context events are dropped completely
          // to keep mobile bandwidth low and the chat clean
          if (sourceKind != null && sourceKind != 'user') {
            break;
          }
          // real user message: fold ONCE per identity
          final identity = _userIdentity(msg);
          WorkItem? row = identity != null ? userRows[identity] : null;
          if (row == null) {
            final rpcId = _sourceRpcId(msg);
            final pending = rpcId != null ? _pendingRows.remove(rpcId) : null;
            if (pending != null) {
              row = pending..sendState = 'delivered';
              // adopt branch: the pending row's own bytes ARE the thumbnails —
              // free the cache entry or it pins until detach (lane-04 #4)
              if (rpcId != null) _sentImageBytes.remove(rpcId);
            } else {
              final parts = _messageParts(msg);
              if (parts.$1.isEmpty && parts.$2.isEmpty) break; // empty user part (retry marker) — skip
              row = WorkItem(key: nk(), kind: 'user', text: parts.$1.join('\n'), images: parts.$2, seq: seq, sendState: 'delivered');
              // this phone sent those images: restore the real thumbnails the
              // durable event's name-only attachments can never carry. remove()
              // (not read): the bytes live on in row.images now, and leaving
              // the entry behind would pin ~1.2MB per image until detach
              final sent = rpcId != null ? _sentImageBytes.remove(rpcId) : null;
              if (sent != null && row.images.length == sent.length) row.images = sent;
            }
            if (identity != null) userRows[identity] = row;
            if (identity != null && seq >= 0) durableUserIdentities.add(identity);
            rows.add(row);
          } else if (seq >= 0) {
            row.seq = seq; // later durable occurrence upgrades the echo row
            if (identity != null) durableUserIdentities.add(identity);
          }
          break;
        }
        case 'command/run': {
          // durable journal event written by the host's CommandRuntime when a
          // /command executes (the phone's own optimistic row settles via the
          // send ack instead — these rows only appear on snapshot rebuilds)
          final cid = map?['commandId']?.toString();
          final name = map?['name']?.toString() ?? '';
          if (name.isEmpty) break;
          if (cid != null && cid.isNotEmpty && commandRows.containsKey(cid)) break; // duplicate echo
          final row = WorkItem(
            key: cid != null && cid.isNotEmpty ? 'cmd-$cid' : nk(),
            kind: 'command',
            text: '/$name',
            commandName: name,
            commandId: cid,
            commandArgs: map?['args']?.toString(),
            seq: seq,
            sendState: 'delivered',
          );
          if (cid != null && cid.isNotEmpty) commandRows[cid] = row;
          rows.add(row);
          break;
        }
        case 'command/done': {
          final cid = map?['commandId']?.toString();
          final row = cid != null && cid.isNotEmpty ? commandRows[cid] : null;
          final text = map?['text']?.toString();
          if (row != null) {
            row.commandKind = map?['kind']?.toString();
            if (text != null && text.isNotEmpty) row.commandText = text;
          } else {
            // done without its run (paging window clipped it) — still show it
            rows.add(WorkItem(
              key: cid != null && cid.isNotEmpty ? 'cmd-$cid' : nk(),
              kind: 'command',
              text: '/${cid ?? '命令'}',
              commandId: cid,
              commandKind: map?['kind']?.toString(),
              commandText: text,
              seq: seq,
              sendState: 'delivered',
            ));
          }
          break;
        }
        case 'system/message':
        case 'developer/message':
          // System/developer prompt injections dropped
          break;
        case 'turn/start': {
          final turn = (map?['turn'] as num?)?.toInt();
          current = WorkTurnGroup(key: turn != null ? 't$turn' : 't$seq', startSeq: seq, turn: turn, startTime: evTime);
          break;
        }
        case 'assistant/message': {
          final msg = map?['message'] as Map<String, dynamic>?;
          final text = _messageText(msg);
          if (text.isNotEmpty) {
            final row = WorkItem(
              key: nk(),
              kind: 'assistant',
              text: text,
              seq: seq,
              interrupted: map?['interrupted'] == true,
              usage: _usageText(map?['usage']),
              turn: (map?['turn'] as num?)?.toInt(),
            );
            if (current != null) {
              current.notes.add(row); // promoted to the exposed answer at turn/end
            } else {
              rows.add(row);
            }
          }
          break;
        }
        case 'tool/call': {
          final callId = map?['callId']?.toString() ?? '';
          // Live echo (seq<0) whose durable twin already folded this pass
          // (tail refresh lands while _pendingEchoes still holds the
          // pre-execute copies): skip, or the call renders twice — folded
          // inside its group AND exposed after the answer. Mirrors the
          // commandRows.containsKey / userRows identity checks. Live echoes
          // still build exposed running-detail rows: no durable tool/call
          // exists yet while the turn is live, so the map has no twin to hit.
          if (seq < 0 && callId.isNotEmpty && toolRows.containsKey(callId)) break;
          final row = WorkItem(
            key: nk(),
            kind: 'tool',
            toolName: map?['name']?.toString() ?? 'tool',
            argsText: _prettyJson(map?['arguments']),
            seq: seq,
            turn: (map?['turn'] as num?)?.toInt() ?? (seq < 0 && current != null ? current.turn : null),
            toolPath: _mutationPath(map?['name']?.toString() ?? '', map?['arguments']),
          );
          toolRows[callId] = row;
          if (seq >= 0 && callId.isNotEmpty) durableToolCallIds.add(callId);
          if (current != null) {
            current.toolRows.add(row);
          } else {
            rows.add(row);
          }
          break;
        }
        case 'tool/result': {
          final msg = map?['message'];
          // the pairing id lives at data.callId on some hosts, but the real
          // dsh shape carries it inside the result message:
          // message.source.callId == message.toolCallId == the call's callId
          String? callId = map?['callId']?.toString();
          if (callId == null || callId.isEmpty) {
            callId = msg is Map ? (msg['source'] is Map ? msg['source']['callId']?.toString() : null) : null;
          }
          if (callId == null || callId.isEmpty) {
            callId = msg is Map ? msg['toolCallId']?.toString() : null;
          }
          final row = (callId != null && callId.isNotEmpty) ? toolRows[callId] : null;
          final mt = _messageText(msg);
          final resultText = mt.isNotEmpty ? mt : _prettyJson(msg);
          final failed = map?['error'] != null || (msg is Map && msg['isError'] == true);
          if (row != null) {
            row.toolOk = !failed;
            row.resultText = resultText;
          } else if (current != null) {
            // orphan result inside an active turn (its call fell outside the
            // paging window) — fold it like a call so the detail stays coherent
            current.toolRows.add(WorkItem(
              key: nk(),
              kind: 'tool',
              toolName: '(result)',
              resultText: resultText,
              toolOk: !failed,
              seq: seq,
              turn: (map?['turn'] as num?)?.toInt(),
            ));
          } else {
            rows.add(WorkItem(
              key: nk(),
              kind: 'tool',
              toolName: '(result)',
              resultText: resultText,
              toolOk: !failed,
              seq: seq,
            ));
          }
          break;
        }
        case 'workspace/changes': {
          // per-turn mutation announcement: just the seq (line counts come
          // from the host's summary service, fetched lazily by the card)
          if (current != null) current.changesSeq = seq;
          break;
        }
        case 'turn/end': {
          final reason = map?['reason'];
          final kind = reason is Map ? (reason['kind']?.toString() ?? reason.toString()) : reason?.toString();
          lastTurnEnd.value = kind;
          final g = current;
          current = null; // a duplicate turn/end lands with current==null: no-op
          if (g != null) {
            closeGroup(g, reason: kind, endTime: evTime);
          }
          break;
        }
        case 'agent/error': {
          final row = WorkItem(key: nk(), kind: 'tool', toolName: '错误', toolOk: false, resultText: map?['error']?.toString() ?? '模型调用出错', seq: seq);
          if (current != null) {
            current.notes.add(row..text = row.resultText ?? '');
          } else {
            rows.add(row);
          }
          break;
        }
        case 'session/title':
          final sid = subscribedId.value;
          if (sid != null && map?['title'] != null) {
            for (final s in sessions.value) {
              if (s.sessionId == sid) s.title = map!['title']?.toString();
            }
            sessions.value = [...sessions.value];
          }
          break;
        default:
          break; // compaction, sandbox, job/* … stay invisible for now
      }
    }

    // a still-open turn (live): its content stays exposed on the tail —
    // running detail lines are exactly what the user should watch; the next
    // tail refresh lands turn/end and folds everything into place
    final g = current;
    if (g != null) {
      for (final n in g.notes) {
        rows.add(n);
      }
      for (final t in g.toolRows) {
        rows.add(t);
      }
    }

    // still-unconfirmed optimistic rows stay at the bottom (queue semantics);
    // rows sent to a DIFFERENT session never leak into this one
    final currentSid = subscribedId.value;
    for (final row in _pendingRows.values) {
      if (row.sessionKey != null && currentSid != null && row.sessionKey != currentSid) continue;
      // a command row settled by its ack (delivered, carrying a commandId)
      // must not duplicate the journal row the same command produced on a
      // snapshot rebuild — the journal row folds into rows first, so the
      // ack-settled pending twin is skipped here
      if (row.kind == 'command' &&
          row.commandId != null &&
          row.commandId!.isNotEmpty &&
          rows.any((r) => r != row && r.kind == 'command' && r.commandId == row.commandId)) {
        continue;
      }
      rows.add(row);
    }
    // Echoes whose durable twin folded THIS pass would only re-evaluate on
    // every future refold (identity map hit → no-op) — pure fold cost that
    // grew linearly over a long session (lane-03 issue-4). The durable rows
    // own the timeline from here; prune the twins.
    if (durableUserIdentities.isNotEmpty || durableToolCallIds.isNotEmpty) {
      _pendingEchoes.removeWhere((e) {
        final type = e['type']?.toString() ?? '';
        if (type == 'user/message' || type == 'agent/inbox/inserted') {
          final d = e['data'];
          final map = d is Map<String, dynamic> ? d : null;
          final msg = map?['message'] ?? map;
          final id = _userIdentity(msg);
          return id != null && durableUserIdentities.contains(id);
        }
        if (type == 'tool/call') {
          final d = e['data'];
          final callId = d is Map<String, dynamic> ? (d['callId']?.toString() ?? '') : '';
          return callId.isNotEmpty && durableToolCallIds.contains(callId);
        }
        return false;
      });
    }
    // rows without seq (synthetic) keep their position; the list is already
    // seq-ordered because durable events fold first and echoes last
    items.value = rows;
  }

  /// Desktop activity() classification, mobile labels: drives the collapsed
  /// line's category summary ("已读取文件、执行了命令…") and the detail-line
  /// prefixes.
  static String _toolCategory(String name) {
    final n = name.toLowerCase();
    if (n == 'read' || n.startsWith('read_') || n.contains('_inspect')) return '读取';
    if (n.contains('grep') || n.contains('glob') || n.contains('search')) return '搜索';
    if (n == 'write') return '写入';
    if (n == 'edit' || n == 'apply_patch' || n.contains('str_replace') || n.contains('notebook')) return '编辑';
    if (n.contains('bash') || n.contains('pwsh') || n.contains('exec') || n.contains('terminal') || n.contains('command') || n.contains('shell') || n.contains('script')) return '命令';
    if (n.contains('web_search') || n.contains('webfetch') || n.contains('web_fetch')) return '网络';
    if (n.contains('subagent')) return '子代理';
    if (n.contains('todo') || n.contains('goal') || n.contains('plan')) return '计划';
    if (n.contains('ask') || n.contains('question') || n.contains('input')) return '提问';
    if (n.contains('image') || n.contains('screenshot') || n.contains('camera')) return '图像';
    return '工具';
  }

  /// Desktop mutationPath(): file touched by a mutation call, from the raw
  /// arguments JSON. Only these fill the "edited N files" card.
  static String? _mutationPath(String? name, dynamic arguments) {
    final n = (name ?? '').toLowerCase();
    final isMutation = n == 'write' || n == 'edit' || n == 'apply_patch' || n.contains('str_replace') || n == 'multiedit' || n == 'multi_edit';
    if (!isMutation) return null;
    if (arguments is Map) {
      for (final k in ['file_path', 'path', 'notebook_path']) {
        final v = arguments[k]?.toString();
        if (v != null && v.isNotEmpty) return v;
      }
    }
    return null;
  }

  void _deriveFileEdits(WorkTurnGroup g) {
    final byPath = <String, WorkFileEdit>{};
    for (final t in g.toolRows) {
      final p = t.toolPath;
      if (p == null || p.isEmpty) continue;
      if (t.toolOk != true) continue; // failed mutations are not "edits"
      final existing = byPath[p];
      if (existing != null) {
        // keep insertion order (first occurrence position) — desktop dedupes
        // the same way (one row per file, net change)
        continue;
      }
      final display = p.replaceAll('\\', '/').split('/').where((s) => s.isNotEmpty).lastOrNull ?? p;
      byPath[p] = WorkFileEdit(path: p, display: display);
    }
    g.fileEdits
      ..clear()
      ..addAll(byPath.values);
  }

  void _countCategories(WorkTurnGroup g) {
    g.categoryCounts.clear();
    for (final t in g.toolRows) {
      final c = _toolCategory(t.toolName ?? '');
      g.categoryCounts[c] = (g.categoryCounts[c] ?? 0) + 1;
    }
  }

  /// Default expand rule (desktop parity): open turns and the newest closed
  /// one are expanded; older closed turns collapse. A stored override wins
  /// until the user taps again.
  bool isTurnExpanded(WorkTurnGroup g, {required bool isLatestClosed}) {
    final override = _turnExpand[g.key];
    if (override != null) return override;
    if (g.open) return true;
    if (isLatestClosed) {
      // "until the next input" is naturally implemented by newest-closed:
      // the next send opens a new turn, demoting this one to collapsed
      final kind = g.endReason;
      return kind == 'aborted' || kind == 'interrupted' || kind == 'error' || kind == 'completed' || kind == 'max-tokens';
    }
    return false;
  }

  /// Convenience for the row widgets: which turnGroup wrapper is the newest
  /// CLOSED one in the current items list (drives the default expand rule).
  String? latestClosedGroupKey() {
    final list = items.value;
    for (var i = list.length - 1; i >= 0; i--) {
      final r = list[i];
      final g = r.group;
      if (r.kind == 'turnGroup' && g != null && !g.open) return g.key;
    }
    return null;
  }

  bool isGroupExpanded(WorkTurnGroup g) {
    return isTurnExpanded(g, isLatestClosed: latestClosedGroupKey() == g.key);
  }

  void setTurnExpanded(String groupKey, bool expanded) {
    _turnExpand[groupKey] = expanded;
    _publishItems();
  }

  /// Line-count summary for a turn's "edited N files" card, fetched from the
  /// host's workspace-changes service against the turn's workspace/changes
  /// seq. Returns the cached copy immediately when present. Cache key includes
  /// the session: seq is per-session, a bare-seq key served one session's
  /// summary inside another (lane-06 issue-1).
  Map<String, dynamic>? changesSummary(String sessionId, int changesSeq) => _changesCache['$sessionId:$changesSeq'];

  Future<void> ensureChangesSummary(String sessionId, int changesSeq) async {
    final key = '$sessionId:$changesSeq';
    if (_changesCache.containsKey(key) || _changesInflight.contains(changesSeq)) return;
    _changesInflight.add(changesSeq);
    try {
      final res = await _request({'type': 'changes_summary', 'sessionId': sessionId, 'seq': changesSeq}, timeout: const Duration(seconds: 8));
      if (res != null && res['ok'] == true && res['data'] is Map<String, dynamic>) {
        _changesCache[key] = res['data'] as Map<String, dynamic>;
        _publishItems();
      }
    } finally {
      _changesInflight.remove(changesSeq);
    }
  }

  /// Stable identity of a user message across its echo and durable shapes.
  String? _userIdentity(dynamic msg) {
    if (msg is! Map) return null;
    final src = msg['source'];
    if (src is Map && src['rpcId'] != null) return 'rpc:${src['rpcId']}';
    if (msg['id'] != null) return 'id:${msg['id']}';
    // Deformed message with neither rpcId nor id (lane-02 issue-11): fall
    // back to a text+image-count hash so the same echo — re-evaluated on
    // every refold — stops minting a fresh bubble each pass. Normal prompts
    // always carry source.rpcId (the host mints it), so this rarely fires.
    final parts = _messageParts(msg);
    final text = parts.$1.join('\n');
    if (text.isNotEmpty || parts.$2.isNotEmpty) return 'hash:${text.hashCode}:${parts.$2.length}';
    return null;
  }

  void _publishItems() {
    // force the notifier to fire after in-place row edits
    items.value = [...items.value];
  }

  String _messageText(dynamic msg) {
    if (msg is! Map) return msg?.toString() ?? '';
    final content = msg['content'];
    if (content is List) {
      return content
          .whereType<Map>()
          .map((c) => c['type'] == 'text' ? (c['text']?.toString() ?? '') : (c['type'] == 'image' ? '[图片]' : ''))
          .where((s) => s.isNotEmpty)
          .join('\n');
    }
    if (content is String) return content;
    return '';
  }

  /// Split a message's content blocks into (texts, images): text blocks feed
  /// the bubble text, image blocks — durable attachment refs carrying NO
  /// bytes on the wire — become name-only placeholder cards. Field shapes
  /// verified against the host's durable event JSON (image.attachment.name).
  (List<String>, List<WorkImage>) _messageParts(dynamic msg) {
    if (msg is! Map) return ([msg?.toString() ?? ''], const []);
    final content = msg['content'];
    if (content is List) {
      final texts = <String>[];
      final images = <WorkImage>[];
      for (final b in content) {
        if (b is! Map) continue;
        if (b['type'] == 'text') {
          final t = b['text']?.toString() ?? '';
          if (t.isNotEmpty) texts.add(t);
        } else if (b['type'] == 'image') {
          final att = b['attachment'];
          final name = att is Map ? att['name']?.toString() : null;
          images.add(WorkImage(name: name != null && name.isNotEmpty ? name : '图片'));
        }
      }
      return (texts, images);
    }
    if (content is String) return ([content], const []);
    return (const [], const []);
  }

  String? _sourceRpcId(dynamic msg) {
    if (msg is Map) {
      final src = msg['source'];
      if (src is Map && src['rpcId'] != null) return src['rpcId'].toString();
    }
    return null;
  }

  String? _usageText(dynamic usage) {
    if (usage is! Map) return null;
    final parts = <String>[];
    if (usage['inputTokens'] != null) parts.add('入 ${(usage['inputTokens'] as num).toInt()}');
    if (usage['outputTokens'] != null) parts.add('出 ${(usage['outputTokens'] as num).toInt()}');
    return parts.isEmpty ? null : parts.join(' · ');
  }

  String? _prettyJson(dynamic v) {
    if (v == null) return null;
    if (v is String && v.trim().isEmpty) return null;
    try {
      final decoded = v is String ? jsonDecode(v) : v;
      final enc = JsonEncoder.withIndent('  ');
      final s = enc.convert(decoded);
      return s.length > 2000 ? '${s.substring(0, 2000)}…' : s;
    } catch (_) {
      return v.toString();
    }
  }

  // ── actions ───────────────────────────────────────────────────────────────

  /// Send a user message. Optimistic row first; the ack and the durable echo
  /// settle it. The SAME requestId rides every retry — the host dedupes by it.
  /// A leading-`/` text is folded as a command row; the host decides whether
  /// it dispatches through CommandRuntime (ack carries the execution result)
  /// or fails as unknown. Images ride as base64 image parts of the prompt.
  Future<String?> send(String text, {String mode = 'queue', String? requestId, List<WorkSendAttachment> images = const []}) async {
    final sid = subscribedId.value;
    if (sid == null || !(_socket?.isConnected ?? false)) return '未连接接收端';
    final rid = requestId ?? const Uuid().v4();
    final trimmed = text.trim();
    final isCommand = trimmed.startsWith('/');
    final row = WorkItem(
      key: 'pending-$rid',
      kind: isCommand ? 'command' : 'user',
      text: text,
      sendState: 'sending',
      requestId: rid,
      images: [for (final a in images) WorkImage(name: a.name, bytes: a.bytes)],
    );
    if (isCommand) {
      final token = trimmed.split(RegExp(r'\s+')).first;
      row.commandName = token.length > 1 ? token.substring(1) : '';
    }
    _pendingRows[rid] = row;
    row.sessionKey = sid;
    if (row.images.isNotEmpty) _sentImageBytes[rid] = row.images;
    _publishItems();
    final frame = <String, dynamic>{'type': 'work_send', 'sessionId': sid, 'requestId': rid, 'text': text, 'mode': mode};
    if (images.isNotEmpty) {
      frame['images'] = [
        for (final a in images) {'mediaType': a.mediaType, 'data': base64Encode(a.bytes), 'name': a.name}
      ];
    }
    // commands execute synchronously on the host (compact can take a while);
    // image prompts pay the host's attachment admission (decode+normalize+
    // durable store per image) — both need a bigger envelope than plain text
    final data = await _request(
      frame,
      timeout: isCommand
          ? const Duration(seconds: 95)
          : (images.isNotEmpty ? const Duration(seconds: 60) : const Duration(seconds: 20)),
      statusFrame: true, // surface the host's rejection reason (e.g. archived session)
    );
    if (data == null || data['ok'] != true) {
      final r = _pendingRows[rid];
      if (r != null) r.sendState = 'failed';
      _publishItems();
      return data?['reason']?.toString() ?? '发送失败';
    }
    return null;
  }

  /// Retry a failed send with the ORIGINAL requestId (the host dedupes by it,
  /// so a prompt it already accepted can never execute twice). Commands have
  /// NO host-side idempotency (execute mints its own commandId) — a manual
  /// retry may run the command again; the UI only retries on user tap.
  Future<void> retry(WorkItem row) async {
    final rid = row.requestId;
    if (rid == null) return;
    final sid = subscribedId.value;
    // defensive: the failed row belongs to the session it was sent to
    // (row.sessionKey); if the user somehow re-entered a different one since,
    // resending would fire at the wrong chat (lane-03 issue-7)
    if (sid == null || (row.sessionKey != null && row.sessionKey != sid)) {
      // mirror send(): a stale row must land on failed, or the UI loses its
      // only resend affordance (which renders in the failed state) and the
      // row spins as "sending" forever
      row.sendState = 'failed';
      _publishItems();
      return;
    }
    row.sendState = 'sending';
    _publishItems();
    final frame = <String, dynamic>{'type': 'work_send', 'sessionId': sid, 'requestId': rid, 'text': row.text, 'mode': 'queue'};
    final retryImages = [for (final img in row.images) if (img.bytes != null) WorkSendAttachment(bytes: img.bytes!, name: img.name)];
    if (retryImages.isNotEmpty) {
      frame['images'] = [
        for (final a in retryImages) {'mediaType': a.mediaType, 'data': base64Encode(a.bytes), 'name': a.name}
      ];
    }
    final data = await _request(frame, timeout: row.kind == 'command' ? const Duration(seconds: 95) : const Duration(seconds: 20), statusFrame: true);
    if (data == null || data['ok'] != true) {
      row.sendState = 'failed';
      _publishItems();
    }
  }

  /// User tapped 「放弃」 on a failed send: drop the optimistic row and the
  /// image bytes pinned for it (≤1.2MB per image until now — the only exit
  /// while staying in the session; leaving the session used to be the sole
  /// release path, lane-04 #3).
  void abandonSend(WorkItem row) {
    final rid = row.requestId;
    if (rid != null) {
      _pendingRows.remove(rid);
      _sentImageBytes.remove(rid);
    }
    items.value = [...items.value]..remove(row);
  }

  Future<String?> cancel() async {
    final sid = subscribedId.value;
    if (sid == null) return '未进入会话';
    final data = await _request({'type': 'work_cancel', 'sessionId': sid}, timeout: const Duration(seconds: 15));
    if (data == null) return '停止失败';
    return null;
  }

  Future<String?> selectModel(String provider, String model, String? effort) async {
    final sid = subscribedId.value;
    if (sid == null) return '未进入会话';
    final frame = {'type': 'work_select_model', 'sessionId': sid, 'provider': provider, 'model': model};
    if (effort != null) frame['reasoningEffort'] = effort;
    final data = await _request(frame, timeout: const Duration(seconds: 15));
    if (data == null) return '切换失败';
    final selected = data['selected'];
    if (selected is Map) {
      currentModel.value = {
        'provider': selected['provider']?.toString() ?? provider,
        'model': selected['model']?.toString() ?? model,
        if (selected['reasoningEffort'] != null) 'reasoningEffort': selected['reasoningEffort'].toString(),
      };
    }
    if (data['catalog'] is Map) _ingestCatalog(data['catalog'] as Map);
    return null;
  }

  Future<void> loadCatalog() async {
    final data = await _request({'type': 'model_catalog_req'}, timeout: const Duration(seconds: 12));
    if (data != null) _ingestCatalog(data);
  }

  // ── slash commands & @-mentions (composer support) ────────────────────────

  List<WorkCommandInfo>? _commandsCache;
  DateTime _commandsFetchedAt = DateTime.fromMillisecondsSinceEpoch(0);

  /// Host command directory for the popup (60s cache; the host pushes
  /// commands_changed to invalidate). Stale results beat none.
  Future<List<WorkCommandInfo>?> loadCommands({bool force = false}) async {
    if (!force && _commandsCache != null && DateTime.now().difference(_commandsFetchedAt) < const Duration(seconds: 60)) {
      return _commandsCache;
    }
    final sid = subscribedId.value ?? '';
    final data = await _request({'type': 'commands_list', 'sessionId': sid}, timeout: const Duration(seconds: 8));
    if (data == null) return _commandsCache;
    final list = data['commands'];
    if (list is List) {
      _commandsCache = list
          .whereType<Map>()
          .map((c) => WorkCommandInfo(
                name: c['name']?.toString() ?? '',
                description: c['description']?.toString(),
                aliases: (c['aliases'] as List?)?.map((a) => a.toString()).toList() ?? const [],
                attachments: c['attachments'] == true,
                hint: c['hint']?.toString(),
              ))
          .where((c) => c.name.isNotEmpty)
          .toList();
      _commandsFetchedAt = DateTime.now();
    }
    return _commandsCache;
  }

  /// @-mention candidates for the current composer query (files under the
  /// session cwd + referenced sessions, merged host-side).
  Future<WorkMentionResult?> mentionQuery(String query) async {
    final sid = subscribedId.value;
    if (sid == null) return null;
    final data = await _request({'type': 'mention_query', 'sessionId': sid, 'query': query}, timeout: const Duration(seconds: 9));
    if (data == null) return null;
    return WorkMentionResult(
      files: (data['files'] as List? ?? [])
          .whereType<Map>()
          .map((f) => WorkMentionFile(path: f['path']?.toString() ?? '', kind: f['kind'] == 'directory' ? 'directory' : 'file'))
          .where((f) => f.path.isNotEmpty)
          .toList(),
      sessions: (data['sessions'] as List? ?? [])
          .whereType<Map>()
          .map((s) => WorkMentionSession(label: s['label']?.toString() ?? '', title: s['title']?.toString(), mention: s['mention']?.toString() ?? ''))
          .where((s) => s.mention.isNotEmpty)
          .toList(),
    );
  }

  void _ingestCatalog(Map data) {
    final groups = <WorkModelGroup>[];
    for (final g in (data['groups'] as List? ?? [])) {
      if (g is! Map) continue;
      final models = <WorkModelInfo>[];
      for (final m in (g['models'] as List? ?? [])) {
        if (m is! Map) continue;
        final efforts = <WorkEffortInfo>[];
        final r = m['reasoning'];
        if (r is Map) {
          for (final e in (r['efforts'] as List? ?? [])) {
            if (e is Map) efforts.add(WorkEffortInfo(id: e['id']?.toString() ?? '', name: e['name']?.toString(), description: e['description']?.toString()));
          }
        }
        models.add(WorkModelInfo(
          id: m['id']?.toString() ?? '',
          name: m['name']?.toString() ?? m['id']?.toString() ?? '',
          description: m['description']?.toString(),
          efforts: efforts,
          defaultEffort: r is Map ? r['defaultEffort']?.toString() : null,
        ));
      }
      groups.add(WorkModelGroup(id: g['id']?.toString() ?? '', name: g['name']?.toString() ?? '', models: models));
    }
    final failures = ((data['failures'] as List? ?? [])).map((f) => f is Map ? '${f['name'] ?? f['id']}: ${f['message'] ?? ''}' : f.toString()).toList();
    catalog.value = WorkModelCatalog(groups: groups, defaultSelection: data['default'] is Map ? (data['default'] as Map).cast<String, String>() : null, failures: failures);
  }

  Future<List<WorkFileEntry>?> listFiles(String path) async {
    final sid = subscribedId.value;
    if (sid == null) return null;
    final data = await _request({'type': 'file_list', 'sessionId': sid, 'path': path});
    if (data == null) return null;
    return ((data['entries'] as List? ?? []))
        .whereType<Map>()
        .map((e) => WorkFileEntry(name: e['name']?.toString() ?? '', type: e['type']?.toString() ?? 'file', size: (e['size'] as num?)?.toInt()))
        .toList();
  }

  String currentWorkspaceName() {
    final sid = subscribedId.value;
    if (sid == null) return '默认工作区';
    for (final s in sessions.value) {
      if (s.sessionId == sid && s.cwd != null && s.cwd!.isNotEmpty) {
        return cwdBaseName(s.cwd!) ?? s.cwd!;
      }
    }
    return sid.length > 8 ? sid.substring(0, 8) : sid;
  }

  /// Basename of a cwd — the desktop's workspace notion, same notion as the
  /// session list's grouping key (work_screen _groupKey).
  static String? cwdBaseName(String cwd) {
    final parts = cwd.replaceAll('\\', '/').split('/').where((p) => p.isNotEmpty).toList();
    return parts.isNotEmpty ? parts.last : null;
  }

  /// cwd of the session being viewed (from the sessions list; same lookup as
  /// _Title). null = unknown / not subscribed.
  String? currentSessionCwd() {
    final sid = subscribedId.value;
    if (sid == null) return null;
    for (final r in sessions.value) {
      if (r.sessionId == sid) {
        final cwd = r.cwd;
        return (cwd == null || cwd.isEmpty) ? null : cwd;
      }
    }
    return null;
  }

  /// Per-viewer three-tier emphasis for the devices sheet (lane-08 §5):
  /// 0 = watching THIS session, 1 = same project (cwd basename) another
  /// session, 2 = other session / list page, 3 = offline. A null cwd on
  /// either side never counts as "same project".
  int deviceTier(WorkDeviceRow row) {
    if (!row.online) return 3;
    final mySid = subscribedId.value;
    final theirSid = row.sessionId;
    if (theirSid != null && theirSid == mySid) return 0;
    final myCwd = currentSessionCwd();
    final theirCwd = row.cwd;
    if (theirSid != null && myCwd != null && theirCwd != null) {
      final mine = cwdBaseName(myCwd);
      final theirs = cwdBaseName(theirCwd);
      if (mine != null && mine == theirs) return 1;
    }
    return 2;
  }

  /// 完整下载工作区中的某个文件到手机沙盒,并记录到已下载历史。
  ///
  /// The remotePath's directory structure rides into the local layout
  /// (`work_downloads/<ws>/src/README.md`), so two same-named files in
  /// different subfolders no longer overwrite each other (recheck-5: the old
  /// flat layout shared one localPath, silently swapping contents and making
  /// one delete kill both records). Escape segments ('', '.', '..') are
  /// dropped; every segment gets the same illegal-char replacement as the
  /// workspace/file names. Old records (flat localPath) keep working — they
  /// store absolute paths, no migration.
  Future<String?> downloadFile(String remotePath, {required String workspaceName, required LensStore store}) async {
    final sid = subscribedId.value;
    if (sid == null) return null;
    IOSink? sink;
    File? targetFile;
    bool recorded = false;
    try {
      final docsDir = await getApplicationDocumentsDirectory();
      final safeWorkspace = workspaceName.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
      final segments = remotePath.replaceAll('\\', '/').split('/').where((s) => s.isNotEmpty && s != '.' && s != '..').toList();
      final safeFileName = _sanitizeDownloadSegment(segments.isEmpty ? 'file' : segments.last);
      Directory dir = Directory('${docsDir.path}/work_downloads/$safeWorkspace');
      for (final seg in (segments.length > 1 ? segments.sublist(0, segments.length - 1) : const <String>[])) {
        dir = Directory('${dir.path}/${_sanitizeDownloadSegment(seg)}');
      }
      if (!dir.existsSync()) {
        await dir.create(recursive: true);
      }
      targetFile = File('${dir.path}/$safeFileName');
      if (targetFile.existsSync()) {
        try {
          targetFile.deleteSync();
        } catch (_) {}
      }

      sink = targetFile.openWrite();
      int offset = 0;
      int totalBytes = 0;
      bool done = false;

      while (!done) {
        final res = await _request({
          'type': 'file_read',
          'sessionId': sid,
          'path': remotePath,
          'offsetBytes': offset,
          'lengthBytes': 256 * 1024,
        }, timeout: const Duration(seconds: 30));

        if (res == null || res['dataBase64'] == null) {
          throw Exception('读取中断');
        }

        final b64 = res['dataBase64']?.toString() ?? '';
        final bytes = base64Decode(b64);
        if (bytes.isNotEmpty) {
          sink.add(bytes);
          totalBytes += bytes.length;
        }
        final bytesRead = (res['bytesRead'] as num?)?.toInt() ?? bytes.length;
        offset += bytesRead;

        if (res['eof'] == true || bytes.isEmpty || bytesRead == 0) {
          done = true;
        }
      }
      await sink.flush();
      await sink.close();
      sink = null;

      final item = WorkDownloadItem(
        id: const Uuid().v4(),
        workspace: workspaceName,
        remotePath: remotePath,
        localPath: targetFile.path,
        fileName: safeFileName,
        size: totalBytes,
        downloadedAt: DateTime.now().millisecondsSinceEpoch,
      );
      await store.addWorkDownload(item);
      recorded = true;
      return targetFile.path;
    } catch (_) {
      return null;
    } finally {
      // close an interrupted sink BEFORE deleting, or Windows may hold the
      // file open; then remove the half-file — the download history only
      // knows recorded files, so an unrecorded partial would be an orphan
      // that even "清空全部" can never reach
      try {
        await sink?.flush();
        await sink?.close();
      } catch (_) {}
      if (!recorded && targetFile != null && targetFile.existsSync()) {
        try {
          targetFile.deleteSync();
        } catch (_) {}
      }
    }
  }

  /// One path segment of a download target: illegal chars replaced, and a
  /// hard length cap with a short hash tail so a pathological 300-char name
  /// can't blow past Android's 255-byte NAME_MAX.
  static String _sanitizeDownloadSegment(String raw) {
    var s = raw.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_').trim();
    if (s.isEmpty) s = '_';
    const maxLen = 96;
    if (s.length <= maxLen) return s;
    final hash = s.hashCode.toUnsigned(32).toRadixString(16).padLeft(8, '0');
    return '${s.substring(0, maxLen)}~$hash';
  }
}
