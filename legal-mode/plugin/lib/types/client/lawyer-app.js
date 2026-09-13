/** URL scheme handled by the DeepWhale Lawyer desktop app. */
const LAWYER_APP_URL = 'deepwhale-law://start';
/**
 * Open the DeepWhale Lawyer desktop app through its registered URL scheme.
 *
 * Every caller reports a transition the user made, and the app owns what the
 * navigation then does; a context that does not know the scheme refuses it
 * rather than failing loudly, so a refusal needs no report here.
 */
export function openLawyerApp() {
    try {
        window.open(LAWYER_APP_URL, '_blank');
    }
    catch {
        // Unregistered scheme in a sandboxed context: nothing else to do.
    }
}
//# sourceMappingURL=lawyer-app.js.map