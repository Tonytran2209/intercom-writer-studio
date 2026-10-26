import "dotenv/config"
import pg from "pg"
import { readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { databasePool, identifier } from "./postgres.ts"

// This tool never changes the source. Stop writes in the source app first.
if (!process.env.SOURCE_DATABASE_URL) throw new Error("Set SOURCE_DATABASE_URL privately; never paste credentials into chat.")
const source = new pg.Client({ connectionString: process.env.SOURCE_DATABASE_URL, connectionTimeoutMillis: 10000 })
const destination = databasePool()
const target = await destination.connect()
const includeLegacy = process.argv.includes("--include-legacy")
const apply = process.argv.includes("--apply")
const folder = fileURLToPath(new URL("../supabase/migrations/", import.meta.url))
const names = new Set<string>()
for (const file of (await readdir(folder)).filter(file => file.endsWith(".sql"))) {
  for (const match of (await readFile(folder + file, "utf8")).matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/gi)) names.add(match[1])
}
const tables = [...names].filter(name => includeLegacy || name.startsWith("eb_v2_") || name.startsWith("intercom_writer_agent_library_"))
const paths = new Set<string>()
function collectPaths(value: unknown) {
  if (!value || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    if (["storagePath", "storage_path", "upload_storage_path"].includes(key) && typeof child === "string" && child) paths.add(child)
    else collectPaths(child)
  }
}
try {
  await source.connect()
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
  const available: string[] = []
  for (const table of tables) {
    const exists = await source.query("SELECT to_regclass($1) AS relation", [`public.${table}`])
    if (!exists.rows[0].relation) { console.log(`Source missing optional table: ${table}`); continue }
    const origin = await source.query(`SELECT count(*) AS count FROM ${identifier(table)}`)
    const existing = await target.query(`SELECT count(*) AS count FROM ${identifier(table)}`)
    console.log(`${table}: source=${origin.rows[0].count}, destination=${existing.rows[0].count}`)
    if (apply && Number(existing.rows[0].count)) throw new Error(`Destination ${table} is not empty; refusing to overwrite existing data.`)
    available.push(table)
  }
  if (!apply) console.log("Dry run only. Use --apply after verifying table ownership. Shared legacy tables are excluded unless --include-legacy is explicit.")
  else {
    await target.query("BEGIN")
    // Defer FK checks while copying cross-linked revisions; restore original
    // constraint definitions before commit, so orphan rows still abort import.
    const foreignKeys = await target.query(`SELECT t.relname AS table_name, c.conname, c.condeferrable, c.condeferred
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE c.contype='f' AND n.nspname='public' AND t.relname=ANY($1::text[])`, [available])
    for (const fk of foreignKeys.rows) await target.query(`ALTER TABLE ${identifier(fk.table_name)} ALTER CONSTRAINT ${identifier(fk.conname)} DEFERRABLE INITIALLY DEFERRED`)
    const triggers = await target.query(`SELECT t.relname AS table_name, g.tgname FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid
      WHERE NOT g.tgisinternal AND g.tgenabled='O' AND t.relname=ANY($1::text[])`, [available])
    for (const trigger of triggers.rows) await target.query(`ALTER TABLE ${identifier(trigger.table_name)} DISABLE TRIGGER ${identifier(trigger.tgname)}`)
    for (const table of available) {
      const columns = await source.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table])
      const keys = columns.rows.map(row => row.column_name as string)
      let copied = 0
      for (let offset = 0; ; offset += 250) {
        const batch = await source.query(`SELECT * FROM ${identifier(table)} ORDER BY ctid LIMIT 250 OFFSET $1`, [offset])
        if (!batch.rows.length) break
        for (const row of batch.rows) {
          collectPaths(row)
          const values = columns.rows.map(column => ["json", "jsonb"].includes(column.data_type) && row[column.column_name] !== null ? JSON.stringify(row[column.column_name]) : row[column.column_name])
          await target.query(`INSERT INTO ${identifier(table)} (${keys.map(identifier).join(",")}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(",")})`, values)
          copied++
        }
      }
      const count = await target.query(`SELECT count(*) AS count FROM ${identifier(table)}`)
      if (Number(count.rows[0].count) !== copied) throw new Error(`Row count mismatch: ${table}`)
      console.log(`Copied and verified ${table}: ${copied}`)
    }
    if (paths.size) {
      const url = process.env.SUPABASE_URL
      const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!url || !key) throw new Error("File references found. Supply source SUPABASE_URL and server secret to copy files before committing.")
      const storage = createClient(url, key, { auth: { persistSession: false } }).storage.from("writer-documents")
      for (const storagePath of paths) {
        const { data, error } = await storage.download(storagePath)
        if (error || !data) throw new Error(`Unable to copy referenced file: ${storagePath}`)
        await target.query("INSERT INTO intercom_writer_document_binaries(path,content_type,data) VALUES($1,$2,$3)", [storagePath, data.type || "application/octet-stream", Buffer.from(await data.arrayBuffer())])
      }
      console.log(`Copied ${paths.size} referenced files`)
    }
    await target.query("SET CONSTRAINTS ALL IMMEDIATE")
    for (const fk of foreignKeys.rows) await target.query(`ALTER TABLE ${identifier(fk.table_name)} ALTER CONSTRAINT ${identifier(fk.conname)} ${fk.condeferrable ? `DEFERRABLE INITIALLY ${fk.condeferred ? "DEFERRED" : "IMMEDIATE"}` : "NOT DEFERRABLE"}`)
    for (const trigger of triggers.rows) await target.query(`ALTER TABLE ${identifier(trigger.table_name)} ENABLE TRIGGER ${identifier(trigger.tgname)}`)
    await target.query("COMMIT")
    console.log("Import committed. Source data remains unchanged. Verify workflows before reopening production writes.")
  }
  await source.query("COMMIT")
} catch (error) {
  await target.query("ROLLBACK")
  await source.query("ROLLBACK").catch(() => undefined)
  throw error
} finally { await source.end(); target.release(); await destination.end() }
