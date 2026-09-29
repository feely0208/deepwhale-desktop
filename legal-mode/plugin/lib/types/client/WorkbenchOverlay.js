/* Legal-mode deep link: entering the legal-mode agent preset opens the DeepWhale
   Lawyer desktop app. The shell itself stays the untouched DSH UI — the previous
   in-page workbench overlay was removed because it collided with the shell chrome
   (its z-index is trapped inside the layout's `z-index: 20` overlay layer) and the
   desktop app is the product surface. A backup of that implementation lives in
   ~/交接文件夹/ui-legal-mode-WorkbenchOverlay-overlay实现备份.tsx.

   This file covers sessions that enter legal mode and the deployment default
   following the preset a session actually started with. The settings surfaces
   choose the preset for sessions that do not exist yet, so they create no
   session to observe; `index.ts` watches that path. */
import { useEffect, useRef } from 'react';
import { isLegalPreset } from './legal-preset.js';
import { openLawyerApp } from './lawyer-app.js';
/**
 * Snapshot key listing every legal-mode session: `loading` before the store is
 * ready, `-` when none exist, otherwise a comma-joined id list.
 *
 * Tracking the whole set (not just the current session) means a session created
 * with the legal-mode preset fires the deep link wherever it appears — including
 * the new-session screen, where no session is current yet.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function legalSessionsKey(s) {
    try {
        if (s?.phase !== 'ready')
            return 'loading';
        const byId = s?.byId;
        if (!byId || typeof byId !== 'object')
            return '-';
        const ids = Array.isArray(s?.ids) ? s.ids : Object.keys(byId);
        const legal = ids.filter((id) => isLegalPreset(byId[id]?.projectionValues?.agentPreset));
        return legal.length > 0 ? legal.join(',') : '-';
    }
    catch {
        return 'loading';
    }
}
/**
 * `loading` before the store is ready, `-` while no session is current or its
 * preset has not landed, otherwise `<session id>\0<preset id>\0<blank|used>`.
 *
 * One string rather than an object: the selector runs on every snapshot, and
 * its identity decides whether React re-renders.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function currentSessionPresetKey(s) {
    try {
        if (s?.phase !== 'ready')
            return 'loading';
        const id = s?.current;
        if (!id)
            return '-';
        const summary = s?.byId?.[id];
        const preset = summary?.projectionValues?.agentPreset;
        if (typeof preset !== 'string' || preset === '')
            return '-';
        return `${id}\u0000${preset}\u0000${summary?.blank === true ? 'blank' : 'used'}`;
    }
    catch {
        return 'loading';
    }
}
/**
 * Open the DeepWhale Lawyer desktop app once per entry into legal mode.
 *
 * Contract: the deep link fires only on the transition into legal mode. Staying
 * in legal mode never re-fires, and leaving legal mode (standard, minimal, or
 * any other preset) re-arms the trigger without opening anything — so switching
 * away is silent, and switching back opens the app again.
 */
function useLawyerAppLaunch(key) {
    // 打开壳时已存在的法律模式会话 = 基线，不算"进入"，不弹（用户要求：打开不自动弹）。
    const baseRef = useRef(null);
    useEffect(() => {
        if (key === 'loading')
            return;
        const current = new Set(key === '-' ? [] : key.split(','));
        const base = baseRef.current;
        baseRef.current = current;
        if (base === null)
            return;
        for (const id of current) {
            if (base.has(id))
                continue;
            openLawyerApp();
            return;
        }
    }, [key]);
}
/**
 * Hand the preset of a newly started session to the deployment default.
 *
 * The hero chip picks the preset for the NEXT session and gives it to that
 * session; it never writes the deployment default, so the Agent-preset
 * settings row kept showing the previous choice while the session ran on the
 * new one (2026-09-29 user report: 首页选「法律模式」后，设置里仍是 Standard).
 * Only a session that appears blank counts: opening a session with history
 * shows the preset that session was composed under, which is nobody's choice now.
 * @param key - {@link currentSessionPresetKey} output.
 * @param onSyncPreset - writes the deployment default for one preset id.
 */
function usePresetDefaultSync(key, onSyncPreset) {
    const seenRef = useRef(null);
    useEffect(() => {
        if (key === 'loading' || key === '-')
            return;
        const [id, preset, blank] = key.split('\u0000');
        if (seenRef.current === null) {
            // The first session seen belongs to the page that was already open: baseline only.
            seenRef.current = new Set([id]);
            return;
        }
        if (seenRef.current.has(id))
            return;
        seenRef.current.add(id);
        if (blank === 'blank')
            onSyncPreset(preset);
    }, [key, onSyncPreset]);
}
/**
 * Build the overlay rendered into `shell.overlay`.
 *
 * A factory rather than the component itself because the callback it needs
 * (`onSyncPreset`) reads the plugin context, and components never see ctx.
 * @param onSyncPreset - writes the deployment default for one preset id.
 * @returns the overlay component.
 */
export function createWorkbenchOverlay(onSyncPreset) {
    return function WorkbenchOverlay({ useSessions }) {
        useLawyerAppLaunch(useSessions(legalSessionsKey));
        usePresetDefaultSync(useSessions(currentSessionPresetKey), onSyncPreset);
        return null;
    };
}
//# sourceMappingURL=WorkbenchOverlay.js.map