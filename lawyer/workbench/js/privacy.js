/* =========================================================================
   privacy.js — 桌面端「隐私政策」入口（2026-11-09）
   背景：鸿蒙端有隐私政策入口，桌面端此前只有「授权与服务说明」，没有隐私政策。
   本模块提供：① 设置页卡片；② 授权/激活面板底部链接；③ 弹层展示完整政策。
   政策文本与官网 lawyer-privacy.html 同源，仅将「适用应用」改为同时覆盖桌面端与鸿蒙端。
   ========================================================================= */
(function () {
  var POLICY_HTML =
    "<div class='pp-meta' style='font-size:12px;color:#8ea3c2;line-height:1.9;margin-bottom:10px'>" +
    "适用产品：深鲸律师端（桌面端 · Windows / macOS / Linux）<br>" +
    "运营主体：温州深鲸智能科技有限公司<br>" +
    "版本：v1.0　｜　生效日期：2026-11-09<br>" +
    "联系邮箱：service@deepwhale.org" +
    "</div>" +

    "<h3>一、我们如何处理您的信息</h3>" +
    "<p><b>1.1 仅保存在您设备本地、不上传的信息</b></p>" +
    "<p>工作台业务数据：案件、客户、合同、财务记录、日程、文书、证据材料（图片/音视频）、授权签批记录、涉外业务条目等，全部保存在设备本地；</p>" +
    "<p>个性化配置：头像（您自行选择后复制到本应用数据目录）、壁纸、主题与氛围色设置；</p>" +
    "<p>本地导出的 .swj 数据包由您自行保管，我们无法获取。</p>" +
    "<p>上述信息我们无法获取。您卸载应用即全部删除，也可随时在“系统设置”中一键清除。</p>" +
    "<p>本地运行日志：为便于排查故障，应用会在本机记录技术性运行日志（如启动、AI 请求的耗时与返回状态、授权校验结果、错误类型）。该日志不包含任何业务内容（不记录案件、客户、合同、文书、证据的具体信息），不包含完整 API Key（密钥仅保留前 6 位与末 4 位），不包含完整机器码（仅保留末 4 位）。日志最多保留 30 天或 1000 条，超出自动淘汰，全部仅保存在您的设备本地，我们无法主动获取。您可随时在“系统设置 → 运行日志”中查看、导出、清空或关闭该功能；关闭后立即停止记录并清除已存日志。是否将日志提供给我们完全由您决定，不提供不影响我们按既定流程为您排查。</p>" +
    "<p><b>1.2 实名核验（注册）所需信息 —— 会上传至我们的运营后台</b></p>" +
    "<p>为核验执业身份，您在建档时填写的【姓名、执业证号/实习证号、所属律所、身份类型（执业律师/实习律师）、实习律师的授权律师姓名与证号】以及【设备机器码】会上传至我们的运营后台，用于执业信息核验、授权开通与全程留档备查；</p>" +
    "<p>核验由我们的人工审核人员通过公开的执业信息公示渠道完成，审核人、审核时间与核验结论一并留档；</p>" +
    "<p>我们不会将上述信息用于核验与授权以外的目的，不用于用户画像、自动化决策或广告。</p>" +
    "<p><b>1.3 激活与授权所需信息 —— 会上传至我们的运营后台</b></p>" +
    "<p>手机号：激活时用于接收短信验证码；验证通过后，手机号与设备机器码一并登记至运营后台，用于授权发放、机器绑定与授权台账留档；</p>" +
    "<p>设备机器码：基于设备标识经单向散列（SHA-256）截取生成的字母数字串，用于授权码与设备的绑定校验。机器码不包含您的姓名、联系方式或其他设备内容。</p>" +
    "<p><b>1.4 公益免费资格申请（仅在您主动提交时）</b></p>" +
    "<p>如您申请公益律师免费使用，您填写的姓名、执业证号、执业机构、证明人签署单位、手机号以及您选择上传的证明文件，将保存在设备本地，并上报至我们的运营后台用于资格审核；您也可以选择“复制申请单”后自行通过邮件发送给我们。</p>" +
    "<p><b>1.5 意见反馈（仅在您主动提交时）</b></p>" +
    "<p>您主动提交反馈时收集：反馈类型、问题描述、您的称呼、邮箱、手机号、设备机器码。反馈内容保存在设备本地，并上报至我们的运营后台，用于我们回复您及（若您反馈的问题被采纳）为您增加试用时长。</p>" +
    "<p><b>1.6 AI 功能的网络传输</b></p>" +
    "<p>仅当您主动使用需要模型的功能（案情摘要、合同审查、文书起草、涉外类 AI 初筛等；首页「今日办案简报」不接 Key 时由本机整理、不联网）时，本应用会通过 HTTPS 将您指定发送的相关内容（如所选案件的案件信息、合同要点、文书起草参数）发送至【您自行配置的 DeepSeek 开放平台接口】（api.deepseek.com 或您自定义的服务地址），请求以您自己的 API Key 发起。</p>" +
    "<p>我们不通过自有服务器中转或存储您的 AI 请求与生成内容。DeepSeek 开放平台对所接收信息的处理，适用其自身的隐私政策与合规要求（所用生成式人工智能服务已按国家有关规定完成备案）。若您未配置 API Key，AI 功能不会发起任何网络请求，仅返回本地模板文本。</p>" +
    "<p><b>1.7 网络不可用或服务尚未开通时</b></p>" +
    "<p>本应用的业务数据功能完全离线可用，不依赖我们的服务器。当设备无网络、或我们尚未为您开通核验与授权服务时：实名核验、短信验证码与授权领取不可用；其余本地功能照常使用，不会因联网状态受任何影响。AI 功能是否可用，取决于您是否配置了自己的 API Key（见 1.6）。</p>" +

    "<h3>二、我们如何使用您的信息</h3>" +
    "<p>上述信息仅用于：执业身份核验与建档、授权激活与机器绑定、授权台账留档、公益免费资格审核、反馈回复与试用时长奖励、AI 功能生成结果。</p>" +
    "<p>我们不会将您的信息用于用户画像、自动化决策或广告。</p>" +

    "<h3>三、系统能力使用说明</h3>" +
    "<p>网络访问：用于连接运营后台（实名核验、短信验证码、授权领取）与您自行配置的 AI 服务接口；</p>" +
    "<p>打印：仅当您主动使用「一键打印」功能时，用于调用系统打印服务打印您在工作台中生成的文书；不使用该功能则不会调用；</p>" +
    "<p>本应用为桌面客户端，不读取位置、相机、麦克风、通讯录、通话记录等系统权限。头像、证据材料、证明文件、CSV 导入文件均通过系统文件选择器选取，我们仅处理您明确选择的文件。</p>" +

    "<h3>四、第三方与 SDK</h3>" +
    "<p>本应用不含任何第三方统计、广告、推送 SDK。涉及的第三方服务仅有：</p>" +
    "<p>DeepSeek 开放平台（AI 生成，由您自行配置并使用自己的 API Key，见 1.6）；短信服务通道（验证码下发，见 1.3）。</p>" +

    "<h3>五、数据的存储与安全</h3>" +
    "<p>本地存储：业务数据保存在设备本地的应用数据目录；</p>" +
    "<p>服务端存储：实名核验信息、激活手机号、设备机器码、公益免费申请与反馈内容保存在我们的运营后台，用于核验、授权与留档备查；</p>" +
    "<p>加密：数据包导出（.swj）采用您设置的口令经 PBKDF2 派生密钥后进行 AES-256-GCM 加密；授权码采用 Ed25519 数字签名校验；</p>" +
    "<p>传输：本应用与我们服务器之间的通信、以及 AI 请求，均通过 HTTPS 加密传输；</p>" +
    "<p>访问控制：运营后台的工单与台账仅限授权审核人员凭令牌访问。</p>" +
    "<p>请注意：任何信息系统的安全防护都存在客观上限，我们持续采取合理的技术与管理措施保护您的信息，但无法承诺不发生任何安全事件。</p>" +

    "<h3>六、数据的共享、转让与公开披露</h3>" +
    "<p>除第一条所述的 AI 服务商（由您自行配置）与短信通道外，我们不会与任何第三方共享、转让或公开披露您的信息；法律法规另有规定的除外。</p>" +
    "<p>我们不会将您的业务数据（案件、客户、文书、证据等）上传或提供给任何第三方。</p>" +

    "<h3>七、您的权利</h3>" +
    "<p>完全的控制权：您的业务数据在本机，您可随时查看、修改、删除；</p>" +
    "<p>导出：可随时在“系统设置 → 数据管理”将全部数据导出为口令加密的 .swj 数据包，并导入到您的其他设备上的本应用；</p>" +
    "<p>清除：可在“系统设置”中一键清除全部本地数据；卸载即删除；</p>" +
    "<p>查询、更正与删除服务端留存信息：如需查询、更正或删除您在运营后台的实名核验记录、激活登记与授权记录，或撤回授权，请通过 service@deepwhale.org 联系我们，我们将在核实您的身份后处理；</p>" +
    "<p>停止上报：卸载本应用后不再有任何信息上报；如需删除已上报的记录，请通过 service@deepwhale.org 联系我们。</p>" +

    "<h3>八、未成年人保护</h3>" +
    "<p>本应用是面向执业律师、实习律师等法律专业人士的工作工具，不面向未成年人提供服务。</p>" +

    "<h3>九、政策的更新</h3>" +
    "<p>我们可能适时修订本政策。重大变更将通过应用内公告或应用市场更新说明提示；请您定期查阅。</p>" +

    "<h3>十、联系我们</h3>" +
    "<p>运营主体：温州深鲸智能科技有限公司<br>联系邮箱：service@deepwhale.org</p>" +
    "<p>如您对本政策或个人信息处理有任何疑问、意见或投诉，请通过上述邮箱联系我们，我们将在 15 个工作日内回复。</p>" +

    "<h3>特别提示</h3>" +
    "<p>本应用部分功能由人工智能模型生成，生成内容仅供办案参考，不构成法律意见，也不能替代律师的专业判断；您应对采纳的文书与结论进行人工复核。</p>" +
    "<p>未配置 API Key 时，相关功能返回的是本地模板文本而非模型输出，界面会如实标注。</p>" +
    "<p>本政策自 2026-11-09 起生效。本政策仅适用于桌面端（Windows / macOS / Linux）；鸿蒙端适用其单独发布的隐私政策。</p>";

  function open() {
    var old = document.getElementById("pp-modal");
    if (old) old.remove();
    var m = document.createElement("div");
    m.id = "pp-modal";
    m.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.62);" +
      "display:flex;align-items:center;justify-content:center;padding:24px";
    m.innerHTML =
      "<div style='width:min(860px,94vw);max-height:86vh;display:flex;flex-direction:column;" +
      "background:#12151c;border:1px solid rgba(255,255,255,.14);border-radius:14px;" +
      "box-shadow:0 24px 60px rgba(0,0,0,.55)'>" +
      "<div style='display:flex;align-items:center;justify-content:space-between;padding:16px 20px;" +
      "border-bottom:1px solid rgba(255,255,255,.1)'>" +
      "<strong style='font-size:16px;color:#eef2f8'>隐私政策 · 深鲸律师端（桌面端）</strong>" +
      "<button id='pp-close' class='btn btn-ghost btn-sm'>关闭</button>" +
      "</div>" +
      "<div style='padding:18px 22px;overflow:auto;color:#cfe6ea;font-size:13px;line-height:1.95'>" +
      "<style>#pp-body h3{color:#7aa8ff;font-size:14px;margin:18px 0 8px}#pp-body p{margin:6px 0;color:#cfe6ea}</style>" +
      "<div id='pp-body'>" + POLICY_HTML + "</div>" +
      "</div></div>";
    document.body.appendChild(m);
    m.querySelector("#pp-close").addEventListener("click", function () { m.remove(); });
    m.addEventListener("click", function (e) { if (e.target === m) m.remove(); });
  }

  /** 系统设置页的卡片（加法式，不改动原有卡片） */
  function card() {
    return "<div class='set-card glow' style='--acc:#7aa8ff'>" +
      "<div class='set-head'><span class='set-ico'>🛡️</span><strong>隐私政策</strong></div>" +
      "<div class='set-body'>" +
      "<div class='tl-meta' style='line-height:1.8;margin-bottom:8px'>" +
      "业务数据只在本地；实名核验与授权记录在我们后台；AI 请求由你的设备直连你配置的接口。" +
      "</div>" +
      "<button class='btn btn-ghost btn-sm' data-privacy>查看隐私政策</button>" +
      "</div></div>";
  }

  /** 首次启动隐私政策同意（对齐鸿蒙端 PrivacyConsent：不同意不进入使用） */
  function initConsent() {
    var KEY = "legal-mode.privacyAccepted";
    try { if (localStorage.getItem(KEY)) return; } catch (e) { return; }
    var m = document.createElement("div");
    m.id = "pp-consent";
    m.style.cssText = "position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.7);" +
      "display:flex;align-items:center;justify-content:center;padding:24px";
    m.innerHTML =
      "<div style='width:min(680px,92vw);background:#12151c;border:1px solid rgba(255,255,255,.14);" +
      "border-radius:14px;padding:22px 24px;color:#cfe6ea'>" +
      "<strong style='font-size:16px;color:#eef2f8'>隐私政策</strong>" +
      "<div style='font-size:13px;line-height:1.95;margin:12px 0 6px'>" +
      "在开始使用前，请阅读并同意《隐私政策》。要点：<br>" +
      "· 案件、客户、合同、文书、证据等业务数据<b>只保存在本机</b>，我们无法获取；<br>" +
      "· 实名核验（姓名、执业证号、所属律所）与激活手机号会上传至我们的运营后台，仅用于核验与授权；<br>" +
      "· AI 功能在您主动使用时，由本机把相关内容直连您自行配置的 AI 接口，<b>不经过我们的服务器</b>；<br>" +
      "· 不用于用户画像、自动化决策或广告。" +
      "</div>" +
      "<div style='display:flex;gap:10px;flex-wrap:wrap;margin-top:14px'>" +
      "<button class='btn btn-primary' id='ppc-ok'>同意并继续</button>" +
      "<button class='btn btn-ghost' id='ppc-read'>查看完整政策</button>" +
      "<button class='btn btn-ghost' id='ppc-no'>暂不同意</button>" +
      "</div>" +
      "<div id='ppc-tip' style='font-size:12px;color:#e0a83f;margin-top:10px'></div>" +
      "</div>";
    document.body.appendChild(m);
    m.querySelector("#ppc-read").addEventListener("click", open);
    m.querySelector("#ppc-ok").addEventListener("click", function () {
      try { localStorage.setItem(KEY, "1"); } catch (e) {}
      m.remove();
    });
    m.querySelector("#ppc-no").addEventListener("click", function () {
      m.querySelector("#ppc-tip").textContent = "未同意隐私政策时，请不要使用本应用；可随时重新打开查看。";
    });
  }

  window.PrivacyPolicy = { open: open, card: card, initConsent: initConsent };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initConsent);
  } else {
    setTimeout(initConsent, 0);
  }
})();
