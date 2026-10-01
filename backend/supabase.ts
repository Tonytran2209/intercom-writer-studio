import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * New Supabase key naming (supabase-js v2.x + @supabase/server):
 *   SUPABASE_URL            — project URL
 *   SUPABASE_SECRET_KEY     — replaces SERVICE_ROLE_KEY (full DB access, server-only)
 *   SUPABASE_PUBLISHABLE_KEY — replaces ANON_KEY (safe to expose to clients)
 *   SUPABASE_JWKS_URL       — for JWT verification via @supabase/server
 */

const TABLE = 'kv_store';
const DOCUMENT_BUCKET = 'writer-documents';

// Singleton — created once when Railway boots, reused for all requests
let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;

  if (!url) throw new Error('Missing SUPABASE_URL in Railway environment variables.');
  if (!key) throw new Error('Missing SUPABASE_SECRET_KEY, SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_ANON_KEY in Railway environment variables.');

  _client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return _client;
}

// ── KV operations ────────────────────────────────────────────────────────────

export async function kvGet<T = any>(key: string): Promise<T | null> {
  const { data, error } = await getClient()
    .from(TABLE)
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (error) throw new Error(`kvGet(${key}): ${error.message}`);
  return (data?.value as T) ?? null;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const { error } = await getClient()
    .from(TABLE)
    .upsert({ key, value }, { onConflict: 'key' });

  if (error) throw new Error(`kvSet(${key}): ${error.message}`);
}

export async function kvDelete(key: string): Promise<void> {
  const { error } = await getClient().from(TABLE).delete().eq('key', key);
  if (error) throw new Error(`kvDelete(${key}): ${error.message}`);
}

export async function kvGetByPrefix(prefix: string): Promise<{ key: string; value: any }[]> {
  const { data, error } = await getClient()
    .from(TABLE)
    .select('key, value')
    .like('key', `${prefix}%`);

  if (error) throw new Error(`kvGetByPrefix(${prefix}): ${error.message}`);
  return data ?? [];
}

export async function checkConnection(): Promise<boolean> {
  try {
    const { error } = await getClient().from(TABLE).select('key').limit(1);
    return !error;
  } catch {
    return false;
  }
}

export async function uploadDocumentBinary(
  storagePath: string,
  data: Buffer,
  contentType: string,
): Promise<void> {
  const client = getClient();
  let { error } = await client.storage
    .from(DOCUMENT_BUCKET)
    .upload(storagePath, data, { contentType, upsert: false });

  if (error && /bucket.*not found/i.test(error.message)) {
    const { error: createError } = await client.storage.createBucket(DOCUMENT_BUCKET, {
      public: false,
      fileSizeLimit: 15 * 1024 * 1024,
    });
    if (createError && !/already exists/i.test(createError.message)) {
      throw new Error(`Không thể tạo Supabase Storage bucket: ${createError.message}`);
    }
    ({ error } = await client.storage
      .from(DOCUMENT_BUCKET)
      .upload(storagePath, data, { contentType, upsert: false }));
  }

  if (error) throw new Error(`Không thể lưu file gốc vào Supabase Storage: ${error.message}`);
}

export async function downloadDocumentBinary(storagePath: string): Promise<Blob> {
  const { data, error } = await getClient().storage.from(DOCUMENT_BUCKET).download(storagePath);
  if (error || !data) {
    throw new Error(`Không thể tải file gốc từ Supabase Storage: ${error?.message ?? 'không có dữ liệu'}`);
  }
  return data;
}

export async function deleteDocumentBinaries(storagePaths: string[]): Promise<void> {
  if (!storagePaths.length) return;
  const { error } = await getClient().storage.from(DOCUMENT_BUCKET).remove(storagePaths);
  if (error) throw new Error(`Không thể xóa file gốc khỏi Supabase Storage: ${error.message}`);
}

export async function runReadOnlySelect(query: string): Promise<unknown[]> {
  const normalized = query.trim().replace(/;$/, '');
  const match = normalized.match(
    /^select\s+(.+?)\s+from\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+limit\s+(\d+))?$/i,
  );
  if (!match) {
    throw new Error('Supabase Query chỉ hỗ trợ: SELECT cột FROM tên_bảng LIMIT số_lượng.');
  }

  const columns = match[1].trim();
  if (columns !== '*' && !columns.split(',').every(value => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value.trim()))) {
    throw new Error('Danh sách cột Supabase không hợp lệ.');
  }
  const limit = Math.min(Math.max(Number(match[3] ?? 100), 1), 1000);
  const { data, error } = await getClient()
    .from(match[2])
    .select(columns)
    .limit(limit);
  if (error) throw new Error(`Supabase SELECT: ${error.message}`);
  return data ?? [];
}

export async function tableAvailable(table: string): Promise<boolean> {
  const { error } = await getClient().from(table).select('*').limit(1);
  return !error;
}

export async function tableSelect<T = any>(table: string, configure?: (query: any) => any): Promise<T[]> {
  let query: any = getClient().from(table).select('*');
  if (configure) query = configure(query);
  const { data, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as T[];
}

export async function tableInsert<T = any>(table: string, row: Record<string, unknown>): Promise<T> {
  const { data, error } = await getClient().from(table).insert(row).select('*').single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data as T;
}

export async function tableUpsert(table: string, row: Record<string, unknown>, onConflict: string): Promise<void> {
  const { error } = await getClient().from(table).upsert(row, { onConflict });
  if (error) throw new Error(`${table}: ${error.message}`);
}

export async function tableUpdate<T = any>(table: string, id: string, updates: Record<string, unknown>): Promise<T> {
  const { data, error } = await getClient().from(table).update(updates).eq('id', id).select('*').single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data as T;
}

export async function tableDeleteWhere(table: string, column: string, value: string): Promise<void> {
  const { error } = await getClient().from(table).delete().eq(column, value);
  if (error) throw new Error(`${table}: ${error.message}`);
}
