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
			return typeof id === "string" && LEGAL_PRESET_IDS.some((known) => known === id);
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
		* `loading` before the store is ready, otherwise one
		* `<id>\1<preset id>\1<blank|used>` entry per session, joined by `\2`.
		*
		* Every session rides along, not just the current one: the hero chip hands its
		* pick to the blank session it applies to, which the session list carries but
		* does not necessarily address as current. One string rather than an object:
		* the selector runs on every snapshot, and its identity decides whether React
		* re-renders.
		*/
		function sessionsPresetKey(s) {
			try {
				if (s?.phase !== "ready") return "loading";
				const byId = s?.byId ?? {};
				return (Array.isArray(s?.ids) ? s.ids : Object.keys(byId)).map((id) => {
					const summary = byId[id];
					const preset = summary?.projectionValues?.agentPreset;
					return [
						id,
						typeof preset === "string" ? preset : "",
						summary?.blank === true ? "blank" : "used"
					].join("");
				}).join("");
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
		/**
		* Hand the preset of a session this page started to the deployment default.
		*
		* The hero chip picks the preset for the NEXT session and gives it to that
		* session, and it writes no deployment default — so the Agent-preset settings
		* section went on showing the previous choice while the session ran on the new
		* one (2026-09-29 user report: 首页选「法律模式」后，设置里仍是 Standard). This
		* writes the same `agent-presets.default` field the settings section writes,
		* which is what the host resolves for the session after this one.
		*
		* Triggers on a session whose preset appears or changes while it is still
		* blank: sessions already open when this page loaded are baseline, and a
		* session with history carries the preset it was composed under, which is
		* nobody's choice now.
		* @param key - {@link sessionsPresetKey} output.
		* @param onSyncPreset - writes the deployment default for one preset id.
		*/
		function usePresetDefaultSync(key, onSyncPreset) {
			const seenRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (key === "loading") return;
				const entries = (key === "" ? [] : key.split("")).map((entry) => {
					const [id, preset, blank] = entry.split("");
					return {
						id,
						preset,
						blank
					};
				});
				const current = new Map(entries.map((entry) => [entry.id, entry.preset]));
				const previous = seenRef.current;
				seenRef.current = current;
				if (previous === null) return;
				for (const entry of entries) {
					if (entry.preset === "" || entry.blank !== "blank") continue;
					if (previous.get(entry.id) === entry.preset) continue;
					onSyncPreset(entry.preset);
					return;
				}
			}, [key, onSyncPreset]);
		}
		/**
		* Build the overlay rendered into `shell.overlay`.
		*
		* A factory rather than the component itself because the callback it needs
		* (`onSyncPreset`) reads the plugin context, and components never see ctx.
		* @param onSyncPreset - writes the deployment default for one preset id.
		* @returns the overlay component.
		*/
		function createWorkbenchOverlay(onSyncPreset) {
			return function WorkbenchOverlay({ useSessions }) {
				useLawyerAppLaunch(useSessions(legalSessionsKey));
				usePresetDefaultSync(useSessions(sessionsPresetKey), onSyncPreset);
				return null;
			};
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
		/**
		* Settings namespace and field holding the deployment's chosen default preset,
		* newest first.
		*
		* The runtime that ships with the shell keeps it in `agent-preset-registry`
		* under `selectedDefault` — that is what its own Agent-presets surface writes
		* (2026-09-29 实测抓到 settings/update 帧：
		* `{"ns":"agent-preset-registry","patch":{"selectedDefault":"standard"}}`).
		* The older `agent-presets` / `default` pair is what the profile-era document
		* used and what a user-supplied older DSH still reads; writing the pair the
		* running host does not know is refused with
		* `No configurable plugin entry "<ns>"`, which is why both are tried.
		*/
		const PRESET_DEFAULT_TARGETS = [{
			ns: "agent-preset-registry",
			field: "selectedDefault"
		}, {
			ns: "agent-presets",
			field: "default"
		}];
		/** Services required by the legal-mode overlay plugin. */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.agentPresets",
			"remote.settings"
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
		* Default preset this plugin wrote last, so the watcher below does not read its
		* own sync back as a person switching the default. Cleared by the first read
		* that observes it.
		*/
		let selfWrittenDefault = null;
		/**
		* Make the deployment default follow the preset a session actually started with.
		*
		* The hero chip stages its pick for the NEXT session and hands it to that
		* session; it writes no deployment default, so the Agent-presets surface went
		* on showing the previous choice while the session ran on the new one
		* (2026-09-29 user report: 首页选「法律模式」后，设置里仍是 Standard). This
		* writes the same field that surface writes, which is what the host resolves
		* for the session after this one.
		* @param ctx - client root context.
		* @param id - preset id the current session carries.
		* @returns once a write settled or every candidate namespace refused; a refused
		* write stays silent because a read-only settings document is a deployment
		* choice, not this overlay failing.
		*/
		async function syncDefaultPreset(ctx, id) {
			try {
				const roster = await ctx.remote.agentPresets.list();
				if (!roster.ok) return;
				const { presets } = roster.value;
				if (!presets.some((preset) => preset.id === id)) return;
				if (presets.find((preset) => preset.isDefault)?.id === id) return;
				for (const target of PRESET_DEFAULT_TARGETS) {
					selfWrittenDefault = id;
					if ((await ctx.remote.settings.update(target.ns, { [target.field]: id }, void 0)).ok) return;
					selfWrittenDefault = null;
				}
			} catch {
				selfWrittenDefault = null;
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
					if (selfWrittenDefault === now) {
						selfWrittenDefault = null;
						return;
					}
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
			}, createWorkbenchOverlay((id) => void syncDefaultPreset(ctx, id)))), "ui-legal-mode: overlay registration");
			watchDefaultPreset(ctx);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map