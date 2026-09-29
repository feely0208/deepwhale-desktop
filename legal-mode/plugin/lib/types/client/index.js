import { isLegalPreset } from './legal-preset.js';
import { openLawyerApp } from './lawyer-app.js';
import { createWorkbenchOverlay } from './WorkbenchOverlay.js';
import { dictionaries } from './locales.js';
/** Locale namespace owned by this plugin (overlay chrome copy). */
const NS = 'legalmode';
/** Settings namespace holding the deployment's chosen default agent preset. */
const PRESET_SETTINGS_NS = 'agent-presets';
/** Services required by the legal-mode overlay plugin. */
export const inject = ['slots', 'locale', 'remote', 'remote.agentPresets', 'remote.settings'];
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
        if (!answer.ok)
            return null;
        return isLegalPreset(answer.value.presets.find((preset) => preset.isDefault)?.id);
    }
    catch {
        // The transport rejected rather than answering; the caller keeps the fact
        // it already held instead of inventing a transition.
        return null;
    }
}
/**
 * Make the deployment default follow the preset a session actually started with.
 *
 * The hero chip stages its pick for the NEXT session and hands it to that
 * session; it writes no deployment default, so the Agent-preset settings row
 * went on showing the previous choice while the session ran on the new one
 * (2026-09-29 user report: 首页选「法律模式」后，设置里仍是 Standard). This is
 * the same `agent-presets.default` field the settings row writes, which is what
 * the host resolves for the session after this one.
 * @param ctx - client root context.
 * @param id - preset id the started session carries.
 * @returns once the write settled; a refused write stays silent because a
 * read-only settings document is a deployment choice, not this overlay failing.
 */
async function syncDefaultPreset(ctx, id) {
    try {
        const roster = await ctx.remote.agentPresets.list();
        if (!roster.ok)
            return;
        const { presets } = roster.value;
        // An id the roster does not carry is not a preset anyone can pick again.
        if (!presets.some((preset) => preset.id === id))
            return;
        // Already the default: writing again only churns the settings document.
        if (presets.find((preset) => preset.isDefault)?.id === id)
            return;
        await ctx.remote.settings.update(PRESET_SETTINGS_NS, { default: id }, undefined);
    }
    catch {
        // The wire rejected the write; the session keeps running under the preset
        // it already carries, which is the behavior the user asked for.
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
    // null until a read lands: the first answer is the baseline, never a switch.
    let legal = null;
    // Reads can settle out of order; only the newest issued one owns the state.
    let issued = 0;
    const refresh = () => {
        const mine = ++issued;
        void readLegalDefault(ctx).then((now) => {
            if (now === null || mine !== issued)
                return;
            const before = legal;
            legal = now;
            if (now && before === false)
                openLawyerApp();
        });
    };
    ctx.effect(() => {
        refresh();
        const off = ctx.remote.$on('settings/document-updated', (namespace) => {
            if (namespace !== PRESET_SETTINGS_NS)
                return;
            refresh();
        });
        return () => {
            try {
                off?.();
            }
            catch {
                // Disposal after the connection dropped: the listener is already gone.
            }
        };
    }, 'ui-legal-mode: default-preset watcher');
}
/**
 * Register the native workbench overlay and its locale dictionary, and drive
 * the Lawyer deep link from both routes into legal mode.
 * @param ctx - Client root context.
 */
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, dictionaries), 'ui-legal-mode: dictionary');
    ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'legal-workbench',
        order: 100,
        locale: NS,
    }, createWorkbenchOverlay((id) => void syncDefaultPreset(ctx, id)))), 'ui-legal-mode: overlay registration');
    watchDefaultPreset(ctx);
}
//# sourceMappingURL=index.js.map