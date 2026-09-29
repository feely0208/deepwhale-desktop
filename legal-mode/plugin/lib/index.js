import { execFile } from "node:child_process";
//#region lib/types/index.js
/**
* Legal-mode client plugin, node half.
*
* The browser half (exports["./client"], src/client/) drives the deep link from
* the presets a session runs under. This half owns the one route the browser
* cannot provide: a `/lawyer` command that opens the DeepWhale Lawyer desktop
* app on demand, in any session.
*
* Why a command rather than the preset alone (2026-09-29, user request): DSH
* locks a session's agent preset once it has run a turn — the history was
* produced under that composition, so `agent-presets.select` refuses the swap
* (`PresetLockedError`). A lawyer who wants the workbench halfway through a
* conversation therefore cannot get it by changing presets, and the app is a
* separate desktop program anyway: opening it needs no preset at all.
*/
/** URL scheme handled by the DeepWhale Lawyer desktop app. */
const LAWYER_APP_URL = "deepwhale-law://start";
/** Services required by the node half. */
const inject = ["commands"];
/**
* Hand the scheme to whatever the OS uses to open URLs.
*
* The app registers the scheme itself (macOS when it lands in Applications,
* Windows and Linux on its first launch), so a failure here means the app is
* missing or was never opened once — the message below says exactly that.
* @returns the command result the dispatching surface shows the user.
*/
function openLawyerApp() {
	const [file, args] = process.platform === "win32" ? ["cmd", [
		"/c",
		"start",
		"",
		LAWYER_APP_URL
	]] : process.platform === "darwin" ? ["open", [LAWYER_APP_URL]] : ["xdg-open", [LAWYER_APP_URL]];
	return new Promise((resolve) => {
		execFile(file, args, {
			timeout: 1e4,
			windowsHide: true
		}, (error) => {
			if (!error) {
				resolve({
					kind: "success",
					text: "已打开深鲸·律师端。"
				});
				return;
			}
			resolve({
				kind: "error",
				text: [
					"没能打开深鲸·律师端。请确认：",
					"① 已安装深鲸·律师端；",
					"② 至少打开过它一次（Windows / Linux 上 deepwhale-law 链接协议是首次运行时才登记的）；",
					"③ 它没有被移走。"
				].join("\n")
			});
		});
	});
}
/**
* Register the on-demand lawyer-app command.
* @param ctx - the host plugin context.
*/
function apply(ctx) {
	ctx.commands.register({
		name: "lawyer",
		description: "打开深鲸·律师端（律师工作台）",
		handler: () => openLawyerApp()
	});
}
//#endregion
export { apply, inject };
