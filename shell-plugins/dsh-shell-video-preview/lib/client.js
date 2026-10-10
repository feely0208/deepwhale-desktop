/**
 * 深鲸桌面 · 视频/音频内嵌预览 —— 客户端半边（2026-10-10 重写）
 *
 * ── 为什么需要 ───────────────────────────────────────────────────────
 * 用户点聊天里给的 mp4，侧栏显示「该格式文件暂时无法预览」。
 * 那句话出自 DSH 自带的预览插件 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`：
 * 它的 `unsupportedFile` 只在「没有任何预览器认领这个后缀，且该后缀又在
 * `UNVIEWABLE_BINARY_EXTENSIONS` 里」时出现。视频正是这种情况。
 *
 * ── 这一版为什么能成（逐条对着 DSH 源码，不再靠文档猜）──────────────
 * 上一版有 5 处硬伤，每一处都足以让预览出不来：
 *
 *  1. 宿主半边 + cordis.patch.yml 缺失 → 包根本不是「活动的 loader 行」，
 *     `dsh-client-modules` 不会扫描它，客户端半边**从来没被下发过**
 *     （所以连报错都没有，表现就是"改了没反应"）。
 *  2. package.json 缺 `exports["./client"]`
 *     → `dsh-client-modules/lib/index.js:718` 直接抛
 *       `declares dsh.client but exports no "./client" bundle`。
 *  3. package.json 缺 `dsh.client.platform`
 *     → `parseDshClient` 抛 `dsh.client.platform must be a string`。
 *  4. 本文件不是 `window.__ModuleLoader__.load({ id, factory })` 包体
 *     → 浏览器里 `module is not defined`（bundle 是原样拼接执行的）。
 *  5. 正文挂错：`sidebar.right.tab.document` 是**按 key 分发**的槽位，
 *     官方自己的写法是
 *       `ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, key: <定义 id> }, Body))`
 *     而上一版直接 `inject(SLOT, () => Body)`（没有 key，也没走 register）
 *     → 槽位按 `entryKey = 选中预览器的 id` 找不到对应正文 → 走了 fallback。
 *
 *  另外两处「即使挂上也放不出来」的错误假设，这一版也已按官方图片/PDF 预览对齐：
 *  6. 定义缺 `loading: "bytes-complete"` → 框架根本不会去读文件，
 *     `props.content` 永远是 undefined。
 *  7. `props.content` **不是原始字节**，而是 `{ kind: "bytes", data }`
 *     （见官方 ImageBody：`content.kind === "bytes" ? content.data : void 0`）。
 *
 * 读整份文件的上限由宿主的 `workspaceFiles.maxFileBytes`（默认 32 MB）决定，
 * 与官方图片/PDF 预览完全一致；超过时会走框架自己的「内容超过上限」提示。
 */

window.__ModuleLoader__.load({
  id: '@deepwhale-cn/dsh-shell-video-preview',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');

    /** 预览器与槽位正文共用的实现 id；槽位按它分发，两处必须一致。 */
    const BODY_ID = '@deepwhale-cn/dsh-shell-video-preview/media';
    /** 槽位名（与官方预览器一致）。 */
    const SLOT = 'sidebar.right.tab.document';

    const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'ogv'];
    const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'];
    const ALL_EXT = VIDEO_EXT.concat(AUDIO_EXT);

    /** 后缀 → 播放用的 MIME。Blob 的 type 直接决定浏览器能否解码。 */
    const MEDIA_TYPE = {
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      m4v: 'video/x-m4v',
      webm: 'video/webm',
      ogv: 'video/ogg',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      ogg: 'audio/ogg',
      flac: 'audio/flac',
    };

    /**
     * 从资源地址取小写后缀（不带点）。
     * @param address - 槽位给的 `resourceAddress`（`dsh-resource://file/…`，路径是百分号编码的）。
     * @returns 后缀；取不到时返回空串。
     */
    function suffixOf(address) {
      let path = String(address || '');
      try {
        path = decodeURIComponent(path);
      } catch (_error) {
        // 地址里出现不完整转义时保住原串即可，不影响末尾后缀判断。
      }
      path = path.split(/[?#]/u)[0].toLowerCase();
      const cut = path.lastIndexOf('.');
      return cut === -1 ? '' : path.slice(cut + 1);
    }

    /**
     * 预览正文：视频用 `<video>`，音频用 `<audio>`，字节来自 `content.data`。
     * @param props - 槽位组合后的属性；用到 `content`、`resourceAddress`。
     * @returns 播放器，或读取中的提示行。
     */
    function MediaBody(props) {
      const suffix = suffixOf(props && props.resourceAddress);
      const isVideo = VIDEO_EXT.indexOf(suffix) !== -1;
      const mediaType = MEDIA_TYPE[suffix] || (isVideo ? 'video/mp4' : 'audio/mpeg');
      const content = props && props.content;
      const data = content !== undefined && content !== null && content.kind === 'bytes' ? content.data : undefined;

      const url = react.useMemo(() => {
        if (data === undefined) return null;
        try {
          return URL.createObjectURL(new Blob([data], { type: mediaType }));
        } catch (_error) {
          return null;
        }
      }, [data, mediaType]);

      // 卸载时释放，别让整份文件一直占着内存。
      react.useEffect(() => {
        if (url === null) return undefined;
        return () => URL.revokeObjectURL(url);
      }, [url]);

      if (url === null) {
        return react.createElement(
          'div',
          { style: { padding: 16, opacity: 0.7, fontSize: 13 } },
          data === undefined ? '正在读取文件…' : '正在准备播放…',
        );
      }

      return react.createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: 12,
            boxSizing: 'border-box',
          },
        },
        isVideo
          ? react.createElement('video', {
              src: url,
              controls: true,
              playsInline: true,
              style: { maxWidth: '100%', maxHeight: '100%', borderRadius: 8, background: '#000' },
            })
          : react.createElement('audio', {
              src: url,
              controls: true,
              style: { width: '100%' },
            }),
      );
    }

    /** 需要注入的客户端服务：预览注册表 + 槽位注册表。 */
    const inject = ['documentPreviews', 'slots'];

    /**
     * 客户端入口：注册预览器元数据，并把正文挂到**带 key** 的文档正文槽位。
     * @param ctx - 客户端上下文，携带 documentPreviews 与 slots。
     */
    function apply(ctx) {
      const previews = ctx.documentPreviews;
      if (previews === undefined || typeof previews.register !== 'function') {
        console.warn('[video-preview] 拿不到 ctx.documentPreviews —— 检查 dsh.client.inject 是否包含 documentpreview 包');
        return;
      }

      ctx.effect(
        () =>
          previews.register({
            id: BODY_ID,
            extensions: ALL_EXT,
            // 都是二进制：不提供"按纯文本打开"，并要求框架整份读入（同官方图片/PDF）。
            binaryExtensions: ALL_EXT,
            // 排序只看 builtin / 非 builtin 两档；视频音频没有内置预览器抢，
            // 用非 builtin 档即可稳定胜出。
            priority: 'extension',
            title: () => '视频/音频',
            loading: 'bytes-complete',
            wrap: false,
          }),
        'video-preview: metadata',
      );

      ctx.effect(
        () =>
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register(
              {
                name: SLOT,
                // ⚠️ 关键：槽位按选中预览器的 id 分发正文，key 必须等于上面的 BODY_ID。
                key: BODY_ID,
              },
              MediaBody,
            ),
          ),
        'video-preview: body',
      );
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
