import { useSyncExternalStore } from 'react';

export type WorkspaceNoticeKind = 'success' | 'error' | 'warning';
export type WorkspaceNotice = { id: number; message: string; kind: WorkspaceNoticeKind };
// Module-owned session history survives workspace remounts and StrictMode effects.
let notices: WorkspaceNotice[] = [];
let nextId = 0;
type NotificationContent = {
  id: string; text: string; kind?: string; error?: boolean;
  details: Array<{ id: string; title: string; context: string; body?: string }>;
};
let dismissed: ReadonlySet<string> = new Set();
export function notificationFingerprint(notice: Omit<NotificationContent, 'id'>) {
  return JSON.stringify([notice.text, notice.kind, notice.error,
    notice.details.map(detail => JSON.stringify([detail.id, detail.title, detail.context, detail.body])).sort()]);
}
export function isNotificationDismissed(id: string, fingerprint: string) {
  return dismissed.has(JSON.stringify([id, fingerprint]));
}
export function dismissWorkspaceNotifications(items: NotificationContent[]) {
  if (!items.length) return;
  dismissed = new Set([...dismissed, ...items.map(item => JSON.stringify([item.id, notificationFingerprint(item)]))]);
  listeners.forEach(listener => listener());
}
const dismissedSnapshot = () => dismissed;
export function useDismissedWorkspaceNotifications() {
  return useSyncExternalStore(subscribe, dismissedSnapshot, dismissedSnapshot);
}
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
