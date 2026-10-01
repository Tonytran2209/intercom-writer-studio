import type { ActionDataSource, DocumentFile, FileCategory } from '../types';
import { isShellMode } from './appMode';

interface ImportResponse {
  target: 'writer:files';
  record: ActionDataSource | DocumentFile;
}

export async function importSourceThroughRailway(
  source: Partial<ActionDataSource> & Pick<ActionDataSource, 'sourceType'>,
  category: FileCategory,
  railwayUrl: string,
): Promise<ImportResponse> {
  if (isShellMode) throw new Error('External imports are unavailable in shell mode.');
  // Keep imports on the current deployed backend for the same reason as file
  // uploads; old Railway URLs must never reintroduce an obsolete auth flow.
  const baseUrl = (typeof window !== 'undefined' ? window.location.origin : railwayUrl).trim().replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/api/import/source`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...source, category }),
  });
  const payload = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) throw new Error(payload.error || `Railway import error ${response.status}`);
  return payload as ImportResponse;
}
