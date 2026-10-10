/**
 * 深鲸桌面 · 视频内嵌预览（2026-10-10）
 *
 * 为什么需要它：
 *   用户点了我们给的 mp4，侧栏预览显示「该格式文件暂时无法预览」——
 *   那句话出自 DSH 自带的预览插件（只认 text/css/html/pdf）。
 *   用户原话：「体验感太不好了…能不能在 56 中修复这个问题吗」
 *
 * 做法（**官方扩展点**，不改 DSH 的包）：
 *   ctx.documentPreviews.register({ id, extensions, binaryExtensions, priority, title })
 *   + 把正文注册到 keyed slot `sidebar.right.tab.document`。
 *   priority 用 'extension'（默认档，优先于 builtin）→ 直接接走这些后缀。
 *   文档见 dsh-client-ui-sidebar-documentpreview/README.zh.md「注册了什么」一节。
 *
 * 覆盖：mp4 / mov / m4v / webm（音频同理，顺手一起支持）
 */

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'ogv'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'];

function apply(ctx) {
  const react = require('react');
  const h = react.createElement;

  const register = (id, exts, isVideo, title) => {
    const api = ctx.documentPreviews;
    if (!api || typeof api.register !== 'function') {
      console.warn('[video-preview] 这个 DSH 版本没有 documentPreviews 扩展点，插件不生效');
      return;
    }
    api.register({
      id,
      extensions: exts,
      binaryExtensions: exts,      // 都是二进制，不提供"纯文本"选项
      priority: 'extension',       // 优先于 builtin 档
      title,
    });

    // 正文：把它塞进 keyed slot，键就是上面注册的 id
    const Body = (props) => {
      const { content, resourceAddress } = props || {};
      // DSH 会把文件字节交给我们（content 可能是 Uint8Array / ArrayBuffer / Blob）
      const url = react.useMemo(() => {
        if (!content) return null;
        try {
          const blob = content instanceof Blob ? content : new Blob([content], isVideo ? { type: 'video/mp4' } : { type: 'audio/mpeg' });
          return URL.createObjectURL(blob);
        } catch (e) { return null; }
      }, [content]);

      // 退出时释放 objectURL（否则大文件会一直占着内存）
      react.useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

      if (!url) return h('div', { style: { padding: 16, opacity: .7 } }, '正在读取文件…');
      return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 12 } },
        isVideo
          ? h('video', { src: url, controls: true, playsInline: true, style: { maxWidth: '100%', maxHeight: '100%', borderRadius: 8 } })
          : h('audio', { src: url, controls: true, style: { width: '100%' } }));
    };

    ctx.slots.inject(`sidebar.right.tab.document:${id}`, () => Body);
  };

  // 让 ctx 准备好再注册（slot 与 documentPreviews 都由依赖插件提供）
  ctx.effect(() => {
    register('@deepwhale-cn/video-preview', VIDEO_EXT, true, '视频预览');
    register('@deepwhale-cn/audio-preview', AUDIO_EXT, false, '音频预览');
  });
}

const plugin = { name: '@deepwhale-cn/dsh-shell-video-preview', apply };
module.exports = plugin;
module.exports.default = plugin;
