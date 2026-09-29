import { isLegalPreset } from './legal-preset.js';
import { openLawyerApp } from './lawyer-app.js';
import { WorkbenchOverlay } from './WorkbenchOverlay.js';
import { dictionaries } from './locales.js';
/** Locale namespace owned by this plugin (overlay chrome copy). */
const NS = 'legalmode';
/** Settings namespace holding the deployment's chosen default agent preset. */
const PRESET_SETTINGS_NS = 'agent-presets';
/** Services required by the legal-mode overlay plugin. */
export const inject = ['slots', 'locale', 'remote', 'remote.agentPresets'];
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
        if (!answer.ok)
            return null;
        return answer.value.presets.find((preset) => preset.isDefault)?.id ?? '';
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
    // null until a read lands: the first answer is the baseline, never a switch.
    let current = null;
    // Reads can settle out of order; only the newest issued one owns the state.
    let issued = 0;
    const refresh = () => {
        const mine = ++issued;
        void readDefaultPreset(ctx).then((now) => {
            if (now === null || mine !== issued)
                return;
            const before = current;
            current = now;
            // The first answer is the baseline: a shell that opens on legal mode stays silent.
            if (before === null)
                return;
            if (!isLegalPreset(now) || isLegalPreset(before))
                return;
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