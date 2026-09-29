/**
 * Preset ids the DeepWhale Lawyer desktop app is the surface for.
 *
 * Two ids name the same deployment preset. `legal-mode` was the id while the
 * shell shipped the preset as a `$DSH_HOME/.agent-presets/<id>/` directory,
 * where the directory name was the id; `legal` is the id the shell's bundle
 * patch declares now (<home>/plugins/dsh-legal-preset/cordis.patch.yml) and
 * therefore the id every session started since carries in
 * `projectionValues.agentPreset`. Sessions started under the older layout keep
 * the older id in their log, so both spellings stay legal here.
 *
 * 2026-09-29 实测：只认 `legal-mode` 时，壳 1.0.22 上两条拉起路径**都不触发**
 * （会话投影是 `legal`），表现为"选了法律模式，律师端纹丝不动"。
 */
export const LEGAL_PRESET_IDS = ['legal', 'legal-mode'];
/**
 * Whether a preset id names the legal-mode preset.
 * @param id - agent-preset id taken from a session projection or a roster entry.
 * @returns true when the id is one of {@link LEGAL_PRESET_IDS}.
 */
export function isLegalPreset(id) {
    return typeof id === 'string' && LEGAL_PRESET_IDS.some((known) => known === id);
}
//# sourceMappingURL=legal-preset.js.map