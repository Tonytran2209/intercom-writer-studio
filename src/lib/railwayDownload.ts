function resolveBaseUrl(railwayUrl: string): string {
  const saved = typeof window !== 'undefined' ? localStorage.getItem('writer:railwayUrl') : null;
  const sameOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const value = railwayUrl.trim() || saved?.trim() || sameOrigin;
  if (!value) throw new Error('Chưa cấu hình Railway URL.');
  return value.replace(/\/$/, '');
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (!encoded) return fallback;
  try { return decodeURIComponent(encoded); } catch { return fallback; }
}

export async function downloadDocumentFromRailway(
  id: string,
  fallbackName: string,
  railwayUrl: string,
): Promise<void> {
  if (isShellMode) throw new Error('Downloads are unavailable in shell mode.');
  const response = await fetch(
    `${resolveBaseUrl(railwayUrl)}/api/documents/${encodeURIComponent(id)}/download`,
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || `Railway download error ${response.status}`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filenameFromDisposition(response.headers.get('Content-Disposition'), fallbackName);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}
import { isShellMode } from './appMode';
