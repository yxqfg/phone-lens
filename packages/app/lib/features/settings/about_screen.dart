import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../ui/background_art.dart';

/// About & Help page: lens-mate info, a short onboarding flow, and connection
/// troubleshooting. Content is scrollable; the illustration sits at the very
/// bottom-right, dimmed, so it never fights the text.
class AboutScreen extends StatefulWidget {
  const AboutScreen({super.key});

  @override
  State<AboutScreen> createState() => _AboutScreenState();
}

class _AboutScreenState extends State<AboutScreen> {
  // read from the built package (pubspec version) so this page never drifts
  // from the real release again — it used to carry a stale hardcoded literal
  String _version = '';

  @override
  void initState() {
    super.initState();
    PackageInfo.fromPlatform().then((info) {
      if (mounted) setState(() => _version = info.version);
    }).catchError((_) {});
  }

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
            const _Step('3. 拍照', '电脑端点「拍照并注入」,或手机 App 按快门;照片按电脑端设置的拍摄模式进入输入框或文件夹。'),
            const _Step('4. 发送', '在 dsh 输入框补充文字,点发送,图片即随消息进入会话。'),
            _section('常用设置'),
            const _Step('拍摄模式', '电脑端小窗可选「自动注入对话 / 注入并存文件夹 / 仅存文件夹」;手机端发送成功的提示会随之变化。'),
            const _Step('多设备', '多个手机可同时配对;电脑端小窗可选看某台,双击设备名可重命名;未选中的手机会暂停预览但仍可上传。'),
            const _Step('设为主机', '取景页点「设为主机」自动开启本机预览,并把电脑端预览切换到本机,其他设备随即暂停。'),
            const _Step('上传队列', '断网或电脑端未启动时,拍摄与相册发送的照片自动进入上传队列(取景页右上角角标);连接恢复后自动续传,失败可重试。'),
            const _Step('上传画质', '设置 → 拍摄与上传:高(原图直传)/中(默认,体积约原图 1/3)/低(省流量)。'),
            const _Step('空闲关相机', '长时间无拍摄自动关闭摄像头降温省电(默认 5 分钟);点拍摄键或「启动预览」立即恢复。'),
            const _Step('对焦', '设置 → 画面 → 「取景对焦」:开启后点击对焦、长按锁定对焦。'),
            const _Step('裁剪', '设置 → 裁剪:默认框选范围、手柄大小可调;裁剪页点 ✕ 丢弃、点「完成」输出。'),
            const _Step('批量上传', '相册多选直接批量发送;开启裁剪后逐张裁切并自动上传,中途点 ✕ 丢弃剩余全部。'),
            const _Step('发送历史', '设置 → 发送历史:保留方式(仅记录/图片留档/不留痕迹)与定期自动清除可配;不影响配对记忆。'),
            const _Step('自动切换', '设置 → 配对与设备 → 「自动选择可用连接」:当前电脑不可达时自动切到可用的已配对电脑(默认关)。'),
            const _Step('检查更新', '设置 → 检查更新;APP 启动时也会每日自动检查一次,有新版时在设置页提示。'),
            _section('连接与异常处理'),
            const _Step('配对失败', '确认手机与电脑在同一局域网;重新扫码(配对码15分钟有效,过期可点「刷新」)。'),
            const _Step('预览无画面', '检查手机取景页「启动预览」是否打开、电脑端接收服务(默认端口 8791)是否在运行;多设备时点「设为主机」或到电脑端选中本机。'),
            const _Step('连不上 / 频繁断开', '确认防火墙放行了接收服务端口(默认 8791,仅私有网段);手机与电脑用同一Wi-Fi或USB网络共享;网络切换后回到 App 会自动重连,也可上滑杀掉 App 后重开。'),
            const _Step('找不到配对入口', '设置 → 配对与设备 → 扫码新增配对。'),
            const _Step('本机提示“预览暂停”', '另一台手机正在使用电脑端预览;本机仍可上传图片,点「设为主机」即切回本机。'),
            const _Step('换网络后连不上', '开启「自动选择可用连接」,或在设置里点选另一台已配对电脑,选择「设为活动连接」。'),
            const _Step('安装/更新 APP', '电脑端悬浮窗里的 APP 二维码可扫码直接下载最新安装包;或到 Gitee/GitHub 发行版页下载。'),
            const SizedBox(height: 8),
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 6, 20, 6),
              child: Text('联系', style: TextStyle(color: Colors.white54, fontSize: 14)),
            ),
            const _Contact('Bilibili', '云下千风过'),
            const _Contact('GitHub', 'github.com/yxqfg/phone-lens'),
            const _Contact('插件市场', 'awesome-dsh-plugin/awesome-dsh-plugin'),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
              child: Text(
                _version.isEmpty ? 'PhoneLens 直连取景' : 'v$_version · PhoneLens 直连取景',
                style: const TextStyle(color: Colors.white38, fontSize: 12),
              ),
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
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 108, child: Text(label, style: const TextStyle(color: Colors.white54, fontSize: 14))),
          Expanded(
            child: GestureDetector(
              // tap-to-copy: no url_launcher dependency, still makes the
              // handles usable instead of dead text
              onTap: () {
                Clipboard.setData(ClipboardData(text: value));
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('已复制'), duration: Duration(milliseconds: 1200)),
                );
              },
              child: Text(value, style: const TextStyle(color: Colors.white, fontSize: 14, height: 1.4)),
            ),
          ),
        ],
      ),
    );
  }
}
