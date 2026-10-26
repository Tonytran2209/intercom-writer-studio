import "dotenv/config"
import { readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { createHash } from "node:crypto"
import { databasePool } from "./postgres.ts"

const migrations = fileURLToPath(new URL("../supabase/migrations/", import.meta.url))
const pool = databasePool()
const client = await pool.connect()
try {
  await client.query("SELECT pg_advisory_lock(78241501)")
  await client.query("CREATE TABLE IF NOT EXISTS intercom_writer_schema_migrations(name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())")
  // Original migrations reference Supabase's NOLOGIN policy roles. They confer
  // no login access; the Railway database owner remains the runtime principal.
  for (const role of ["service_role", "anon"]) {
    const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])
    if (!existing.rowCount) await client.query(`CREATE ROLE ${role} NOLOGIN`)
  }
  for (const name of (await readdir(migrations)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
    const sql = await readFile(path.join(migrations, name), "utf8")
    const hash = createHash("sha256").update(sql).digest("hex")
    const applied = await client.query("SELECT hash FROM intercom_writer_schema_migrations WHERE name=$1", [name])
    if (applied.rowCount) { if (applied.rows[0].hash !== hash) throw new Error(`Applied migration changed: ${name}`); continue }
    await client.query("BEGIN")
    try {
      await client.query(sql)
      await client.query("INSERT INTO intercom_writer_schema_migrations(name,hash) VALUES($1,$2)", [name, hash])
      await client.query("COMMIT")
      console.log(`Applied ${name}`)
    } catch (error) { await client.query("ROLLBACK"); throw error }
  }
  await client.query(`CREATE TABLE IF NOT EXISTS intercom_writer_document_binaries (
    path TEXT PRIMARY KEY, content_type TEXT NOT NULL, data BYTEA NOT NULL CHECK (octet_length(data) <= 15728640), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  console.log("Railway schema ready. Import existing data before directing production traffic here.")
} finally {
  await client.query("SELECT pg_advisory_unlock(78241501)")
  client.release()
  await pool.end()
}
