import type { ActionDataSource, DocumentFile, FileCategory } from '../types';
import { isShellMode } from './appMode';

interface UploadResponse {
  target: 'writer:files';
  record: DocumentFile | ActionDataSource;
}

export async function uploadDocumentToRailway(
  file: File,
  category: FileCategory,
  railwayUrl: string,
): Promise<UploadResponse> {
  if (isShellMode) throw new Error('Document upload is unavailable in shell mode.');
  const baseUrl = railwayUrl.trim().replace(/\/$/, '');
  if (!baseUrl) throw new Error('Chưa cấu hình Railway URL.');

  const body = new FormData();
  body.append('file', file);
  body.append('category', category);

  const response = await fetch(`${baseUrl}/api/upload/document`, { method: 'POST', body });
  const payload = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) throw new Error(payload.error || `Railway upload error ${response.status}`);
  return payload as UploadResponse;
}
