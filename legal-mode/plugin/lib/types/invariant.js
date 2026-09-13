/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-legal-mode`.
 * @module @deepseek-ai/dsh-client-ui-legal-mode/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-legal-mode';
/** Cordis companion plugin name. */
export const name = 'client-ui-legal-mode-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: legal-mode presentation is audited by the client
 * apply() in src/client, while this surface plugin carries no host behavior.
 */
const install = () => { };
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//# sourceMappingURL=invariant.js.map