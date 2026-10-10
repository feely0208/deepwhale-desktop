/**
 * 深鲸桌面 · 视频/音频内嵌预览（2026-10-10）
 *
 * 为什么需要：用户点我们给的 mp4，侧栏显示「该格式文件暂时无法预览」——
 * 那句话出自 DSH 自带预览插件（只认 text/css/html/pdf）。
 *
 * ⚠️ 这一版是**照着 DSH 源码逐行对齐**写的（上一版靠文档猜，两处都猜错了）：
 *   · 注册表：DSH 里是 provide("documentPreviews", previews) → 消费方 ctx.documentPreviews ✓
 *   · 后缀：normalizeSuffix = 去点小写（传 'mp4'，不是 '.mp4'）✓
 *   · 正文槽位：slots.inject("sidebar.right.tab.document", ...)  ← **没有 ":id" 后缀** ✗上一版加了
 *   · 一个插件只注册**一个**正文，由内容自己判断类型（上一版注册了两个正文 ✗）
 */

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'ogv'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'];
const ALL_EXT = VIDEO_EXT.concat(AUDIO_EXT);

function apply(ctx) {
  const react = require('react');
  const h = react.createElement;

  // ① 注册元数据（接走这些后缀）
  const dp = ctx.documentPreviews;
  if (!dp || typeof dp.register !== 'function') {
    console.warn('[video-preview] 拿不到 ctx.documentPreviews —— 检查 inject 声明是否包含 documentpreview 包');
    return;
  }
  dp.register({
    id: '@deepwhale-cn/media-preview',
    extensions: ALL_EXT,
    binaryExtensions: ALL_EXT,   // 都是二进制：不提供"按纯文本打开"的选项
    priority: 'extension',       // 优先于 builtin 档
    title: '视频/音频',
  });

  // ② 正文：整个 slot 只挂一个组件，按地址后缀决定用 video 还是 audio
  const Body = (props) => {
    const addr = String((props && props.resourceAddress) || '');
    const isVideo = VIDEO_EXT.some((e) => addr.toLowerCase().endsWith('.' + e));
    const content = props && props.content;

    const url = react.useMemo(() => {
      if (!content) return null;
      try {
        const blob = content instanceof Blob
          ? content
          : new Blob([content], { type: isVideo ? 'video/mp4' : 'audio/mpeg' });
        return URL.createObjectURL(blob);
      } catch (e) { return null; }
    }, [content, isVideo]);

    // 卸载时释放，别让大文件一直占内存
    react.useEffect(() => {
      if (!url) return undefined;
      return () => URL.revokeObjectURL(url);
    }, [url]);

    if (!url) {
      return h('div', { style: { padding: 16, opacity: .7, fontSize: 13 } },
        content ? '正在准备播放…' : '正在读取文件…');
    }
    return h('div', {
      style: { display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', padding: 12, boxSizing: 'border-box' },
    }, isVideo
      ? h('video', { src: url, controls: true, playsInline: true,
          style: { maxWidth: '100%', maxHeight: '100%', borderRadius: 8, background: '#000' } })
      : h('audio', { src: url, controls: true, style: { width: '100%' } }));
  };

  ctx.slots.inject('sidebar.right.tab.document', () => Body);
  console.log('[video-preview] 已注册：' + ALL_EXT.join('/'));
}

const plugin = { name: '@deepwhale-cn/dsh-shell-video-preview', apply };
module.exports = plugin;
module.exports.default = plugin;
