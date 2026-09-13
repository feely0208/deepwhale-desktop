window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-legal-mode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/lawyer-app.ts
		/** URL scheme handled by the DeepWhale Lawyer desktop app. */
		const LAWYER_APP_URL = "deepwhale-law://start";
		/**
		* Open the DeepWhale Lawyer desktop app through its registered URL scheme.
		*
		* Every caller reports a transition the user made, and the app owns what the
		* navigation then does; a context that does not know the scheme refuses it
		* rather than failing loudly, so a refusal needs no report here.
		*/
		function openLawyerApp() {
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
				const legal = (Array.isArray(s?.ids) ? s.ids : Object.keys(byId)).filter((id) => byId[id]?.projectionValues?.agentPreset === "legal-mode");
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
		/** Preset whose sessions the DeepWhale Lawyer desktop app is the surface for. */
		const LEGAL_PRESET_ID = "legal-mode";
		/** Services required by the legal-mode overlay plugin. */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.agentPresets"
		];
		/**
		* Read whether the deployment's default preset is legal mode.
		*
		* The roster resolves the default the way a session start does — settings
		* first, then the deployment default — so the answer is the preset a new
		* session would run, not merely the field a settings surface last wrote.
		* @param ctx - client root context.
		* @returns the answer, or null when the host refused the read.
		*/
		async function readLegalDefault(ctx) {
			try {
				const answer = await ctx.remote.agentPresets.list();
				if (!answer.ok) return null;
				return answer.value.presets.find((preset) => preset.isDefault)?.id === LEGAL_PRESET_ID;
			} catch {
				return null;
			}
		}
		/**
		* Open the Lawyer app whenever the default preset switches into legal mode.
		*
		* The settings surfaces — the General row and the preset cards — choose the
		* preset for sessions that do not exist yet, so they start no session for the
		* overlay's session watcher to observe; this watcher covers those. It fires on
		* the switch into legal mode only: the default as found at load is the
		* baseline, so a shell that opens already on legal mode stays silent, and
		* leaving legal mode re-arms it, so every later switch opens the app again.
		* @param ctx - client root context.
		*/
		function watchDefaultPreset(ctx) {
			let legal = null;
			let issued = 0;
			const refresh = () => {
				const mine = ++issued;
				readLegalDefault(ctx).then((now) => {
					if (now === null || mine !== issued) return;
					const before = legal;
					legal = now;
					if (now && before === false) openLawyerApp();
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