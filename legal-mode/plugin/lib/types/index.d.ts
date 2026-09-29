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
import type { Context } from '@deepseek-ai/cordis';
/** Services required by the node half. */
export declare const inject: string[];
/**
 * Register the on-demand lawyer-app command.
 * @param ctx - the host plugin context.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map