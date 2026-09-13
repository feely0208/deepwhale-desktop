/**
 * Legal-mode client plugin, node half. Pure browser-surface plugin: the empty
 * apply exists so the package appears in the Loader roster and cordis.yml; the
 * browser half ships via exports["./client"] through the package.json
 * dsh.client declaration. Behavior (detect legal-mode preset, pop the lawyer
 * workbench) is entirely in src/client/index.ts.
 */
/** Host plugin body — no host-side behavior for this surface plugin. */
export declare function apply(): void;
//# sourceMappingURL=index.d.ts.map