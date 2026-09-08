/* =========================================================================
   feedback.js — 反馈意见 / Bug 提交 + 采纳后奖励试用时长（闭环）
   -------------------------------------------------------------------------
   - 顶栏「反馈」按钮 → 弹窗（类型/描述/手机号）→ 提交。
   - 提交：存本地 legal-mode.feedback + 走桥 __feedbackSubmit 发给运营后台。
   - 采纳：运营后台「确认采纳」→ __feedbackApprove(反馈id, 奖励天数) → 用户端轮询到 → License.extendTrial()
   ========================================================================= */
(function () {
  var KEY = "legal-mode.feedback";
  var _lastSubmitAt = 0;

  function readAll() { try { var v = localStorage.getItem("legal-mode.feedbackList") || "[]"; return JSON.parse(v); } catch (e) { return []; } }
  function writeAll(a) { try { localStorage.setItem("legal-mode.feedbackList", JSON.stringify(a)); } catch (e) {} }

  // 弹窗：反馈意见/Bug
  function openFeedback() {
    var m = document.createElement("div");
    m.className = "modal-overlay show";
    m.innerHTML =
      "<div class='modal glow' style='width:600px'>" +
      "<div class='card-head'><h3> 反馈意见 / Bug 反馈</h3></div>" +
      "<div class='intl-note' style='margin-bottom:10px'>你的反馈对我们很重要。若为有效 Bug 建议，经我们确认后，<b>将为你增加试用时长</b>。</div>" +
      '<div class="form-group"><label>反馈类型 *</label><select id="fbType"><option value="bug">Bug 问题（功能异常/崩溃）</option><option value="advice">改进建议</option><option value="intent">使用疑问</option></select></div>' +
      '<div class="form-group"><label>问题描述 *</label><textarea id="fbDesc" rows="4" placeholder="请描述你遇到的问题 / 建议（越具体越便于定位）"></textarea></div>' +
      '<div class="form-row"><div class="form-group"><label>您的称呼</label><input id="fbName" placeholder="姓名/称呼"></div>' +
      '<div class="form-group"><label>邮箱（便于我们直接回复您）</label><input id="fbEmail" placeholder="如 xx@qq.com"></div></div>' +
      '<div class="form-group"><label>联系方式（手机号，用于采纳后兑奖）</label><input id="fbPhone" placeholder="手机号"></div>' +
      "<div class='modal-actions'><button class='btn btn-ghost' data-close>取消</button>" +
      "<button class='btn btn-primary' data-submit>提交反馈</button></div>" +
      '<div id="fbMsg" style="margin-top:10px;font-size:12px;color:#7ddb8a"></div>' +
      "</div>";
    document.body.appendChild(m);
    var msg = function (t, ok) { var e = m.querySelector("#fbMsg"); if (e) { e.textContent = t; } };
    m.querySelector("[data-close]").addEventListener("click", function () { m.remove(); });
    m.addEventListener("click", function (e) { if (e.target === m) m.remove(); });
    m.querySelector("[data-submit]").addEventListener("click", function () {
      var type = m.querySelector("#fbType").value;
      var desc = m.querySelector("#fbDesc").value.trim();
      var name = m.querySelector("#fbName").value.trim();
      var email = m.querySelector("#fbEmail").value.trim();
      var phone = m.querySelector("#fbPhone").value.trim();
      if (!desc) { msg("请描述问题/建议", "err"); return; }
      var now = Date.now();
      if (now - _lastSubmitAt < 30000) { msg("请勿频繁提交（30秒一次）", "err"); return; }
      _lastSubmitAt = now;
      var rec = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), type: type, desc: desc, name: name, email: email, phone: phone, status: "pending", machine: (window.License && window.License.realMachine) ? window.License.realMachine() : "", at: now };
      // 存本地
      var list = readAll(); list.unshift(rec); writeAll(list);
      // 走桥发给运营后台（会触发发邮件到 service@deepwhale.org）
      if (window.__feedbackSubmit && typeof window.__feedbackSubmit === "function") {
        window.__feedbackSubmit(rec).then(function (r) {
          if (r && r.ok) {
            msg((r.emailed ? "反馈已发送到官方邮箱，感谢反馈！确认有效 Bug 后将为你增加试用时长。" : "反馈已提交（邮件发送：" + ((r.mailMsg) || "暂未成功") + "），确认有效后将为你增加试用时长。"), "ok");
          } else { msg("提交失败：" + ((r && r.msg) || ""), "err"); }
        }).catch(function () { msg("已保存本机，等待运营确认。"); });
      } else {
        msg("已提交，等待运营确认。", "ok");
      }
    });
  }

  // 轮询：反馈是否被运营采纳（status=approved 且有奖励天数）→ 延长试用
  function startPoll() {
    if (!window.__feedbackListApproved) return;
    var polled = false;
    if (polled) return;
    polled = true;
    setInterval(function () {
      window.__feedbackListApproved().then(function (list) {
        if (!Array.isArray(list)) return;
        // 对本机 machine 的反馈，取已确认且未领取的 → 延长
        var mch = (window.License && window.License.realMachine) ? window.License.realMachine() : "";
        var local = readAll();
        list.forEach(function (fb) {
          if (fb && fb.approvedDays && local.some(function (l) { return l.id === fb.id && !l.rewarded; })) {
            if (window.License && window.License.extendTrial) {
              window.License.extendTrial(fb.approvedDays);
              local.forEach(function (l) { if (l.id === fb.id) l.rewarded = true; });
              writeAll(local);
              if (window.Workbench && window.Workbench.toast) window.Workbench.toast("感谢反馈，已为你增加 " + fb.approvedDays + " 天试用", "success");
            }
          }
        });
      }).catch(function () {});
    }, 8000);
  }

  window.Feedback = { open: openFeedback, startPoll: startPoll, readAll: readAll };
})();
