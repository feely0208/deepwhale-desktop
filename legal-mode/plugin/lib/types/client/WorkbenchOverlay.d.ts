import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
type Props = PropsRuntime<'shell.overlay'> & PropsLocale<'legalmode'>;
/**
 * Build the overlay rendered into `shell.overlay`.
 *
 * A factory rather than the component itself because the callback it needs
 * (`onSyncPreset`) reads the plugin context, and components never see ctx.
 * @param onSyncPreset - writes the deployment default for one preset id.
 * @returns the overlay component.
 */
export declare function createWorkbenchOverlay(onSyncPreset: (id: string) => void): (props: Props) => null;
export {};
//# sourceMappingURL=WorkbenchOverlay.d.ts.map