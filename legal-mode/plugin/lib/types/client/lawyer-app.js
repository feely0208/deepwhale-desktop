/** URL scheme handled by the DeepWhale Lawyer desktop app. */
const LAWYER_APP_URL = 'deepwhale-law://start';
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
const LAUNCH_COOLDOWN_MS = 2000;
/** Time of the last open that reached the browser, in `Date.now()` terms. */
let lastLaunchAt = 0;
/**
 * Open the DeepWhale Lawyer desktop app through its registered URL scheme.
 *
 * Every caller reports a transition the user made, and the app owns what the
 * navigation then does; a context that does not know the scheme refuses it
 * rather than failing loudly, so a refusal needs no report here.
 */
export function openLawyerApp() {
    const now = Date.now();
    if (now - lastLaunchAt < LAUNCH_COOLDOWN_MS)
        return;
    lastLaunchAt = now;
    try {
        window.open(LAWYER_APP_URL, '_blank');
    }
    catch {
        // Unregistered scheme in a sandboxed context: nothing else to do.
    }
}
//# sourceMappingURL=lawyer-app.js.map