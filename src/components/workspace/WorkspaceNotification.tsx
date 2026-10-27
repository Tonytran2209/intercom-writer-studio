import { useSyncExternalStore } from 'react';

export type WorkspaceNoticeKind = 'success' | 'error' | 'warning';
export type WorkspaceNotice = { id: number; message: string; kind: WorkspaceNoticeKind };
// Module-owned session history survives workspace remounts and StrictMode effects.
let notices: WorkspaceNotice[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => notices;

export function notifyWorkspace(message: string, kind: WorkspaceNoticeKind = 'warning') {
  if (!message.trim()) return;
  const notice = { id: ++nextId, message, kind };
  notices = [...notices, notice];
  listeners.forEach(listener => listener());
  window.dispatchEvent(new CustomEvent('writer:workspace-notice', { detail: notice }));
}

export function useWorkspaceNotices() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// Kept for the existing shell mount; presentation belongs to Notification center.
export default function WorkspaceNotificationHost() {
  return null;
}
