// 多设备/重连时序回归（修复轮 A 组）：
// - 快照归属校验 + per-session seq 命名空间（A2/A3，recheck-3 §4.4 用例）
// - leaveSession 退订帧（A4）
// - work_hello 重连清卡 + sinceSeq 增量重订阅（A1/A19）
// - merge 只 append、ingest 尾部排序一次后的 fold 顺序（A5，recheck-4 P2b）
// - work_devices 帧解析与三态判定（A18，lane-08 §5）
// - approval_state interactionIds 对账（A11）
//
// 不起 socket：WorkStore.feedFrameForTest 直接走 _onFrame 分发，
// sendSinkForTest 捕获 store 本该发出的帧。
import 'package:flutter_test/flutter_test.dart';

import 'package:lens_mate/features/work/work_store.dart';

void main() {
  final work = WorkStore.instance;

  tearDown(() {
    work.sendSinkForTest = null;
    work.detach();
  });

  Map<String, dynamic> userEvent(int seq, String text, String rpcId) => {
        'type': 'user/message',
        'seq': seq,
        'time': 1700000000000 + seq,
        'data': {
          'content': [
            {'type': 'text', 'text': text}
          ],
          'source': {'kind': 'user', 'rpcId': rpcId},
          'role': 'user',
          'id': rpcId,
        },
      };

  Map<String, dynamic> assistantEvent(int seq, String text) => {
        'type': 'assistant/message',
        'seq': seq,
        'time': 1700000000000 + seq,
        'data': {
          'message': {
            'role': 'assistant',
            'content': [
              {'type': 'text', 'text': text}
            ],
          },
        },
      };

  test('X snapshot first, Y snapshot after with overlapping seqs — Y bubbles survive, stale X snapshot rejected', () {
    work.sendSinkForTest = (_) {}; // frames the store mints are not under test here
    // 1) X 的全量快照先到（seq 0..2，Y 的 seq 空间与之结构性重叠——recheck-3）
    work.subscribe('X');
    work.feedFrameForTest({
      'type': 'session_snapshot',
      'sessionId': 'X',
      'hasMore': false,
      'events': [userEvent(0, 'x-0', 'rx0'), assistantEvent(1, 'x-a1'), userEvent(2, 'x-2', 'rx2')],
    });
    expect(work.items.value.any((r) => r.text == 'x-0'), isTrue);
    expect(work.items.value.any((r) => r.text == 'x-a1'), isTrue);

    // 2) 秒切 Y：Y 的首屏快照（seq 0..5 与 X 重叠）必须整段落地
    work.subscribe('Y');
    expect(work.items.value, isEmpty);
    work.feedFrameForTest({
      'type': 'session_snapshot',
      'sessionId': 'Y',
      'hasMore': false,
      'events': [
        userEvent(0, 'y-0', 'ry0'),
        assistantEvent(1, 'y-a1'),
        userEvent(2, 'y-2', 'ry2'),
        assistantEvent(3, 'y-a3'),
        userEvent(4, 'y-4', 'ry4'),
        assistantEvent(5, 'y-a5'),
      ],
    });
    for (final t in ['y-0', 'y-a1', 'y-2', 'y-a3', 'y-4', 'y-a5']) {
      expect(work.items.value.any((r) => r.text == t), isTrue, reason: 'Y 的 seq 0..5 不得被 X 的同名 seq 吞掉: $t');
    }
    expect(work.items.value.any((r) => r.text == 'x-0'), isFalse);

    // 3) X 的迟到快照（切走之后才到）被归属校验整帧拒收
    work.feedFrameForTest({
      'type': 'session_snapshot',
      'sessionId': 'X',
      'hasMore': false,
      'events': [assistantEvent(9, 'x-stale')],
    });
    expect(work.items.value.any((r) => r.text == 'x-stale'), isFalse, reason: '迟到快照不得灌进 Y 的时间线');

    // 4) Y 的 tail 增量（session_event，seq 6）不被去重误吞
    work.feedFrameForTest({'type': 'session_event', 'sessionId': 'Y', 'event': assistantEvent(6, 'y-live6')});
    expect(work.items.value.any((r) => r.text == 'y-live6'), isTrue, reason: 'Y 的后续 durable 事件不得被跨会话 seq 污染丢弃');
  });

  test('leaveSession clears the local subscription AND sends the unsubscribe frame (empty sessionId)', () {
    final sent = <Map<String, dynamic>>[];
    work.sendSinkForTest = sent.add;
    work.subscribe('S1');
    sent.clear();
    work.leaveSession();
    expect(work.subscribedId.value, isNull);
    expect(sent, isNotEmpty);
    final frame = sent.last;
    expect(frame['type'], 'session_subscribe');
    expect(frame['sessionId'], '', reason: 'host 把空串归一为 null = 退订（bridge.ts:1001）');
  });

  test('work_hello drops stale cards and resubscribes carrying sinceSeq', () {
    final sent = <Map<String, dynamic>>[];
    work.sendSinkForTest = sent.add;
    work.subscribe('S1');
    work.feedFrameForTest({
      'type': 'session_snapshot',
      'sessionId': 'S1',
      'hasMore': false,
      'events': [userEvent(0, 's-0', 'rs0'), assistantEvent(3, 's-a3')],
    });
    // 断线前手里有一张卡 + 一条 kind-only 镜像
    work.feedFrameForTest({'type': 'approval_request', 'sessionId': 'S1', 'id': 'i1', 'kind': 'approval', 'reason': '需要批准'});
    work.feedFrameForTest({'type': 'approval_state', 'sessionId': 'S1', 'pending': [
      {'id': 'i2', 'toolName': 'bash'}
    ]});
    expect(work.pendingRequests.value.length, 1);
    expect(work.approvals.value.length, 1);

    // 重连握手：卡先清（先清后收，恢复源 = host subscribe-replay），重订阅带 sinceSeq
    sent.clear();
    work.feedFrameForTest({'type': 'work_hello'});
    expect(work.pendingRequests.value, isEmpty, reason: 'work_hello 必须清 pendingRequests（可能已被桌面 settle）');
    expect(work.approvals.value, isEmpty);
    final sub = sent.where((f) => f['type'] == 'session_subscribe').toList();
    expect(sub.length, 1);
    expect(sub.first['sessionId'], 'S1');
    expect(sub.first['sinceSeq'], 3, reason: '重连增量订阅：快照只回 seq>sinceSeq 的部分');
  });

  test('merge only appends; ingest sorts once — snapshot folds in seq order', () {
    work.subscribe('S');
    work.feedFrameForTest({
      'type': 'session_snapshot',
      'sessionId': 'S',
      'hasMore': false,
      'events': [assistantEvent(3, 'c'), assistantEvent(1, 'a'), assistantEvent(2, 'b')],
    });
    final texts = [for (final r in work.items.value) if (r.kind == 'assistant') r.text];
    expect(texts, ['a', 'b', 'c'], reason: '乱序快照必须在一次 sort 后按 seq 折叠');
    // live 增量路径同样有序：seq 4 落尾
    work.feedFrameForTest({'type': 'session_event', 'sessionId': 'S', 'event': assistantEvent(4, 'd')});
    final texts2 = [for (final r in work.items.value) if (r.kind == 'assistant') r.text];
    expect(texts2, ['a', 'b', 'c', 'd']);
  });

  test('work_devices frame parses into rows; tiers are per-viewer (self session > same project > other > offline)', () {
    work.feedFrameForTest({'type': 'session_list', 'sessions': [
      {'sessionId': 'S1', 'title': '一号', 'updatedAt': 2, 'cwd': 'C:/code/proj'},
      {'sessionId': 'S2', 'title': '二号', 'updatedAt': 1, 'cwd': 'C:/code/proj'},
    ]});
    work.subscribe('S1');
    work.feedFrameForTest({'type': 'work_devices', 'devices': [
      {'deviceId': 'self', 'name': '本机', 'sessionId': 'S1', 'cwd': 'C:/code/proj', 'online': true},
      {'deviceId': 'd2', 'name': '魅族', 'sessionId': 'S2', 'cwd': 'C:/code/proj', 'online': true},
      {'deviceId': 'd3', 'name': 'ZTE', 'sessionId': null, 'cwd': null, 'online': true},
      {'deviceId': 'd4', 'name': '备用机', 'sessionId': 'S1', 'cwd': 'C:/code/proj', 'online': false},
    ]});
    expect(work.devices.value.length, 4);
    final rows = work.devices.value;
    expect(work.deviceTier(rows[0]), 0, reason: '同会话在线 = 一级');
    expect(work.deviceTier(rows[1]), 1, reason: '同 cwd basename 的另一会话 = 次级');
    expect(work.deviceTier(rows[2]), 2, reason: '未订阅 = 无强调');
    expect(work.deviceTier(rows[3]), 3, reason: '冻结/离线不算在线，即使订阅着本会话');
  });

  test('approval_state interactionIds reconciles pending cards; frames without the field leave them alone', () {
    work.subscribe('S1');
    work.feedFrameForTest({'type': 'approval_request', 'sessionId': 'S1', 'id': 'i1', 'kind': 'approval'});
    work.feedFrameForTest({'type': 'approval_request', 'sessionId': 'S1', 'id': 'i2', 'kind': 'approval'});
    expect(work.pendingRequests.value.length, 2);
    // 对账帧：host 还挂着 i1（i2 已在别端 settle 且 resolved 帧丢失）
    work.feedFrameForTest({'type': 'approval_state', 'sessionId': 'S1', 'pending': [], 'interactionIds': ['i1']});
    expect(work.pendingRequests.value.map((c) => c.id), ['i1']);
    // 旧 host 不带 interactionIds：不清卡
    work.feedFrameForTest({'type': 'approval_state', 'sessionId': 'S1', 'pending': []});
    expect(work.pendingRequests.value.map((c) => c.id), ['i1']);
  });
}
