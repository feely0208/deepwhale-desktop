/* Legal-mode deep link: entering the legal-mode agent preset opens the DeepWhale
   Lawyer desktop app. The shell itself stays the untouched DSH UI — the previous
   in-page workbench overlay was removed because it collided with the shell chrome
   (its z-index is trapped inside the layout's `z-index: 20` overlay layer) and the
   desktop app is the product surface. A backup of that implementation lives in
   ~/交接文件夹/ui-legal-mode-WorkbenchOverlay-overlay实现备份.tsx.

   This file covers sessions that enter legal mode. The settings surfaces choose
   the preset for sessions that do not exist yet, so they create no session to
   observe; `index.ts` watches that path. */
import { useEffect, useRef } from 'react';
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
        const legal = ids.filter((id) => byId[id]?.projectionValues?.agentPreset === 'legal-mode');
        return legal.length > 0 ? legal.join(',') : '-';
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
/** Renders nothing: the plugin only drives the desktop deep link. */
export function WorkbenchOverlay({ useSessions }) {
    const legalKey = useSessions(legalSessionsKey);
    useLawyerAppLaunch(legalKey);
    return null;
}
//# sourceMappingURL=WorkbenchOverlay.js.map