import 'package:flutter/material.dart';

import '../../ui/background_art.dart';

/// About & Help page: lens-mate info, a short onboarding flow, and connection
/// troubleshooting. Content is scrollable; the illustration sits at the very
/// bottom-right, dimmed, so it never fights the text.
class AboutScreen extends StatelessWidget {
  const AboutScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('关于和帮助'),
        backgroundColor: const Color(0xEE101418),
      ),
      body: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 18, 20, 0),
              child: Text(
                'PhoneLens',
                style: TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold),
              ),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 4, 20, 18),
              child: Text('手机拍照 → dsh 会话 · 实时取景', style: TextStyle(color: Colors.white70, fontSize: 12)),
            ),
            _section('快速上手'),
            const _Step('1. 电脑端', '启动 dsh 后,右下角出现 📷 悬浮窗;点击展开。'),
            const _Step('2. 配对', '手机 App 扫描悬浮窗里的二维码(或手动输入 主机:端口:配对码);设备名会自动用手机型号。'),
            const _Step('3. 拍照', '电脑端点「拍照并放入输入框」,或手机 App 按快门;照片进入 dsh 对话输入框。'),
            const _Step('4. 发送', '在 dsh 输入框补充文字,点发送,图片即随消息进入会话。'),
            _section('常用设置'),
            const _Step('多设备', '多个手机可同时配对;电脑端小窗可选看某台,双击设备名可重命名;未选中的手机会暂停推流但仍可上传。'),
            const _Step('设为主机', '取景页点「设为主机」自动开启本机推流,并把电脑端预览切换到本机,其他设备随即暂停。'),
            const _Step('对焦', '设置 → 画面 → 「取景对焦」:开启后点击对焦、长按锁定对焦。'),
            const _Step('裁剪', '设置 → 裁剪:默认框选范围、手柄大小可调;裁剪页点 ✕ 丢弃、点「完成」输出。'),
            const _Step('批量上传', '相册多选直接批量发送;开启裁剪后逐张裁切并自动上传,中途点 ✕ 丢弃剩余全部。'),
            const _Step('自动切换', '设置 → 配对与设备 → 「自动选择可用连接」:当前电脑不可达时自动切到可用的已配对电脑(默认关)。'),
            _section('连接与异常处理'),
            const _Step('配对失败', '确认手机与电脑在同一局域网;重新扫码(配对码15分钟有效,过期可点「刷新」)。'),
            const _Step('预览无画面', '检查手机「推流」是否开启、接收服务(8791)是否在运行;多设备时点「设为主机」或到电脑端选中本机。'),
            const _Step('颜色异常', '设置 → 画面 → 打开「颜色校正(红蓝互换)」。'),
            const _Step('连不上 / 频繁断开', '确认防火墙放行了 8791(仅私有网段);手机与电脑用同一Wi-Fi或USB网络共享。'),
            const _Step('找不到配对入口', '设置 → 配对与设备 → 扫码新增配对。'),
            const _Step('本机提示“暂停推流”', '另一台手机正占用电脑端预览;本机仍可上传图片,点「设为主机」即切回本机。'),
            const _Step('换网络后连不上', '开启「自动选择可用连接」,或在设置里点选另一台已配对电脑激活。'),
            const SizedBox(height: 8),
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 6, 20, 6),
              child: Text('联系', style: TextStyle(color: Colors.white54, fontSize: 14)),
            ),
            const _Contact('Bilibili', '云下千风过'),
            const _Contact('GitHub', '待定'),
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 16, 20, 8),
              child: Text('v0.2.0 · PhoneLens 直连取景', style: TextStyle(color: Colors.white38, fontSize: 12)),
            ),
            // illustration pinned at the very bottom-right of the scroll
            const Padding(
              padding: EdgeInsets.only(top: 12, bottom: 0),
              child: BackgroundArt(positioned: false, widthFactor: 0.5),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  Widget _section(String t) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 6),
        child: Text(
          t,
          style: const TextStyle(color: Color(0xFF3B7CB5), fontSize: 13, fontWeight: FontWeight.w600),
        ),
      );
}

class _Step extends StatelessWidget {
  final String title;
  final String body;
  const _Step(this.title, this.body);
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 108,
            child: Text(title, style: const TextStyle(color: Colors.white, fontSize: 13)),
          ),
          Expanded(
            child: Text(body, style: const TextStyle(color: Colors.white70, fontSize: 13, height: 1.4)),
          ),
        ],
      ),
    );
  }
}

class _Contact extends StatelessWidget {
  final String label;
  final String value;
  const _Contact(this.label, this.value);
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 3, 20, 3),
      child: Row(
        children: [
          SizedBox(width: 108, child: Text(label, style: const TextStyle(color: Colors.white54, fontSize: 14))),
          Text(value, style: const TextStyle(color: Colors.white, fontSize: 14)),
        ],
      ),
    );
  }
}
