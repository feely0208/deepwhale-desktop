window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-legal-mode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/legal-preset.ts
		/**
		* Preset ids the DeepWhale Lawyer desktop app is the surface for.
		*
		* Two ids name the same deployment preset. `legal-mode` was the id while the
		* shell shipped the preset as a `$DSH_HOME/.agent-presets/<id>/` directory,
		* where the directory name was the id; `legal` is the id the shell's bundle
		* patch declares now (<home>/plugins/dsh-legal-preset/cordis.patch.yml) and
		* therefore the id every session started since carries in
		* `projectionValues.agentPreset`. Sessions started under the older layout keep
		* the older id in their log, so both spellings stay legal here.
		*
		* 2026-09-29 实测：只认 `legal-mode` 时，壳 1.0.22 上两条拉起路径**都不触发**
		* （会话投影是 `legal`），表现为"选了法律模式，律师端纹丝不动"。
		*/
		const LEGAL_PRESET_IDS = ["legal", "legal-mode"];
		/**
		* Whether a preset id names the legal-mode preset.
		* @param id - agent-preset id taken from a session projection or a roster entry.
		* @returns true when the id is one of {@link LEGAL_PRESET_IDS}.
		*/
		function isLegalPreset(id) {
			// 2026-10-03 修：会话投影里的 agentPreset 是 **{"ver","seq","val"} 对象**
			// （DSH 升级后从裸字符串改成了这个结构），而这里原来只认字符串 →
			// isLegalPreset 永远 false → "会话 watcher"从不触发。
			// 症状：新会话选法律模式能拉起律师端（走预设 watcher），
			//       但在 agent 预设选择器里把已有会话切到法律模式 —— 纹丝不动。
			// 实测（本机会话投影）：standard 50 个 / legal-mode 1 个 / cordis 1 个，
			// 即真实值是 "legal-mode"，本就在 LEGAL_PRESET_IDS 里，缺的只是解包。
			const presetId = id && typeof id === "object" ? id.val : id;
			return typeof presetId === "string" && LEGAL_PRESET_IDS.some((known) => known === presetId);
		}
		//#endregion
		//#region src/client/lawyer-app.ts
		/** URL scheme handled by the DeepWhale Lawyer desktop app. */
		const LAWYER_APP_URL = "deepwhale-law://start";
		/**
		* Shortest gap between two deep-link opens, in milliseconds.
		*
		* Two watchers observe the same user action: the session one sees the session
		* that entered legal mode, and the preset one sees the deployment default
		* follow it (the desktop sync writes that default). Both would open the app
		* within a few milliseconds of each other, and on a machine where no app
		* claims the scheme the shell reports one dialog per open — so the second open
		* of the same switch is dropped here. A person switching legal mode off and
		* back on inside this window is the only cost.
		*/
		const LAUNCH_COOLDOWN_MS = 2e3;
		/** Time of the last open that reached the browser, in `Date.now()` terms. */
		let lastLaunchAt = 0;
		/**
		* Open the DeepWhale Lawyer desktop app through its registered URL scheme.
		*
		* Every caller reports a transition the user made, and the app owns what the
		* navigation then does; a context that does not know the scheme refuses it
		* rather than failing loudly, so a refusal needs no report here.
		*/
		function openLawyerApp() {
			const now = Date.now();
			if (now - lastLaunchAt < LAUNCH_COOLDOWN_MS) return;
			lastLaunchAt = now;
			try {
				window.open(LAWYER_APP_URL, "_blank");
			} catch {}
		}
		//#endregion
		//#region src/client/WorkbenchOverlay.tsx
		/**
		* Snapshot key listing every legal-mode session: `loading` before the store is
		* ready, `-` when none exist, otherwise a comma-joined id list.
		*
		* Tracking the whole set (not just the current session) means a session created
		* with the legal-mode preset fires the deep link wherever it appears — including
		* the new-session screen, where no session is current yet.
		*/
		function legalSessionsKey(s) {
			try {
				if (s?.phase !== "ready") return "loading";
				const byId = s?.byId;
				if (!byId || typeof byId !== "object") return "-";
				const legal = (Array.isArray(s?.ids) ? s.ids : Object.keys(byId)).filter((id) => isLegalPreset(byId[id]?.projectionValues?.agentPreset));
				return legal.length > 0 ? legal.join(",") : "-";
			} catch {
				return "loading";
			}
		}
		/**
		* Open the DeepWhale Lawyer desktop app once per entry into legal mode.
		*
		* Contract: the deep link fires only on the transition into legal mode. Staying
		* in legal mode never re-fires, and leaving legal mode (standard, minimal, or
		* any other preset) re-arms the trigger without opening anything — so switching
		* away is silent, and switching back opens the app again.
		*/
		function useLawyerAppLaunch(key) {
			const baseRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (key === "loading") return;
				const current = new Set(key === "-" ? [] : key.split(","));
				const base = baseRef.current;
				baseRef.current = current;
				if (base === null) return;
				for (const id of current) {
					if (base.has(id)) continue;
					openLawyerApp();
					return;
				}
			}, [key]);
		}
		/** Renders nothing: the plugin only drives the desktop deep link. */
		function WorkbenchOverlay({ useSessions }) {
			useLawyerAppLaunch(useSessions(legalSessionsKey));
			return null;
		}
		/** Dictionaries registered under the plugin's locale namespace. */
		const dictionaries = {
			zh: { "brand.legalMode": "法律模式" },
			en: { "brand.legalMode": "Legal Mode" }
		};
		//#endregion
		//#region src/client/index.ts
		/** Locale namespace owned by this plugin (overlay chrome copy). */
		const NS = "legalmode";
		/** Settings namespace holding the deployment's chosen default agent preset. */
		const PRESET_SETTINGS_NS = "agent-presets";
		/** Services required by the legal-mode overlay plugin. */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.agentPresets"
		];
		/**
		* Read the deployment's default preset id.
		*
		* The roster resolves the default the way a session start does — settings
		* first, then the deployment default — so the answer is the preset a new
		* session would run, not merely the field a settings surface last wrote.
		* @param ctx - client root context.
		* @returns the default preset id, or null when the host refused the read.
		*/
		async function readDefaultPreset(ctx) {
			try {
				const answer = await ctx.remote.agentPresets.list();
				if (!answer.ok) return null;
				return answer.value.presets.find((preset) => preset.isDefault)?.id ?? "";
			} catch {
				return null;
			}
		}
		/**
		* Open the Lawyer app whenever the default preset switches into legal mode.
		*
		* The settings surfaces choose the preset for sessions that do not exist yet, so
		* they start no session for the overlay's session watcher to observe; this
		* watcher covers those. It fires on the switch into legal mode only: the default
		* as found at load is the baseline, so a shell that opens already on legal mode
		* stays silent, and leaving legal mode re-arms it, so every later switch opens
		* the app again.
		*
		* This reads the default; it never writes it. Legal mode is a per-session choice
		* here (user decision, 2026-09-29: 不要默认法律模式，需要再手动选择), and a
		* session that already ran a turn cannot switch at all (DSH locks the preset) —
		* that route is the `/lawyer` command in the node half.
		* @param ctx - client root context.
		*/
		function watchDefaultPreset(ctx) {
			let current = null;
			let issued = 0;
			const refresh = () => {
				const mine = ++issued;
				readDefaultPreset(ctx).then((now) => {
					if (now === null || mine !== issued) return;
					const before = current;
					current = now;
					if (before === null) return;
					if (!isLegalPreset(now) || isLegalPreset(before)) return;
					openLawyerApp();
				});
			};
			ctx.effect(() => {
				refresh();
				const off = ctx.remote.$on("settings/document-updated", (namespace) => {
					if (namespace !== PRESET_SETTINGS_NS) return;
					refresh();
				});
				return () => {
					try {
						off?.();
					} catch {}
				};
			}, "ui-legal-mode: default-preset watcher");
		}
		/**
		* Register the native workbench overlay and its locale dictionary, and drive
		* the Lawyer deep link from both routes into legal mode.
		* @param ctx - Client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, dictionaries), "ui-legal-mode: dictionary");
			ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "legal-workbench",
				order: 100,
				locale: NS
			}, WorkbenchOverlay)), "ui-legal-mode: overlay registration");
			watchDefaultPreset(ctx);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map