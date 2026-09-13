import { openLawyerApp } from './lawyer-app.js';
import { WorkbenchOverlay } from './WorkbenchOverlay.js';
import { dictionaries } from './locales.js';
/** Locale namespace owned by this plugin (overlay chrome copy). */
const NS = 'legalmode';
/** Settings namespace holding the deployment's chosen default agent preset. */
const PRESET_SETTINGS_NS = 'agent-presets';
/** Preset whose sessions the DeepWhale Lawyer desktop app is the surface for. */
const LEGAL_PRESET_ID = 'legal-mode';
/** Services required by the legal-mode overlay plugin. */
export const inject = ['slots', 'locale', 'remote', 'remote.agentPresets'];
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
        return answer.value.presets.find((preset) => preset.isDefault)?.id === LEGAL_PRESET_ID;
    }
    catch {
        // The transport rejected rather than answering; the caller keeps the fact
        // it already held instead of inventing a transition.
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
    }, WorkbenchOverlay)), 'ui-legal-mode: overlay registration');
    watchDefaultPreset(ctx);
}
//# sourceMappingURL=index.js.map