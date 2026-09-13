import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { type LegalModeKey } from './locales.js';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        legalmode: LegalModeKey;
    }
}
/** Services required by the legal-mode overlay plugin. */
export declare const inject: string[];
/**
 * Register the native workbench overlay and its locale dictionary, and drive
 * the Lawyer deep link from both routes into legal mode.
 * @param ctx - Client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map