import pg from "pg"

// Preserve PostgREST's timestamp JSON representation in existing API responses.
pg.types.setTypeParser(1184, value => new Date(value).toISOString())
pg.types.setTypeParser(1114, value => new Date(`${value}Z`).toISOString())
let pool: pg.Pool | undefined
export function databasePool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL")
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, statement_timeout: 30_000 })
    pool.on("error", error => console.error("PostgreSQL pool error:", error.message))
  }
  return pool
}
export function identifier(value: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error("Invalid database identifier")
  return `"${value}"`
}
const param = (value: unknown) => value && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Date) ? JSON.stringify(value) : value

// The small supported query surface is shared by existing persistence callers.
export class PostgresQuery implements PromiseLike<any> {
  private action = "select"
  private columns = "*"
  private row: Record<string, unknown> = {}
  private filters: Array<{ column: string; op: string; value: unknown }> = []
  private orders: string[] = []
  private count?: number
  private conflict?: string
  private cardinality = "many"
  constructor(private table: string) { identifier(table) }
  select(columns = "*") { this.columns = columns; return this }
  insert(row: Record<string, unknown>) { this.action = "insert"; this.row = row; return this }
  upsert(row: Record<string, unknown>, options: { onConflict: string }) { this.action = "upsert"; this.row = row; this.conflict = options.onConflict; return this }
  update(row: Record<string, unknown>) { this.action = "update"; this.row = row; return this }
  delete() { this.action = "delete"; return this }
  eq(column: string, value: unknown) { this.filters.push({ column, op: "=", value }); return this }
  neq(column: string, value: unknown) { this.filters.push({ column, op: "<>", value }); return this }
  like(column: string, value: unknown) { this.filters.push({ column, op: "LIKE", value }); return this }
  in(column: string, value: unknown[]) { this.filters.push({ column, op: "IN", value }); return this }
  order(column: string, options: { ascending?: boolean } = {}) { this.orders.push(`${identifier(column)} ${options.ascending === false ? "DESC" : "ASC"}`); return this }
  limit(count: number) { if (!Number.isInteger(count) || count < 0) throw new Error("Invalid query limit"); this.count = count; return this }
  single() { this.cardinality = "one"; return this }
  maybeSingle() { this.cardinality = "optional"; return this }
  compile() {
    const values: unknown[] = []
    const arrayColumns = new Set(["keywords", "topics", "services", "internal_link_anchors", "key_claims"])
    const bind = (value: unknown, column?: string) => {
      values.push(column === "value" && this.table === "kv_store" && value !== null ? JSON.stringify(value) : column && arrayColumns.has(column) ? value : param(value))
      return `$${values.length}`
    }
    const columns = this.columns === "*" ? "*" : this.columns.split(",").map(column => identifier(column.trim())).join(",")
    const table = identifier(this.table)
    let sql: string
    if (this.action === "insert" || this.action === "upsert") {
      const entries = Object.entries(this.row).filter(([, value]) => value !== undefined)
      if (!entries.length) sql = `INSERT INTO ${table} DEFAULT VALUES`
      else sql = `INSERT INTO ${table} (${entries.map(([key]) => identifier(key)).join(",")}) VALUES (${entries.map(([key, value]) => bind(value, key)).join(",")})`
      if (this.action === "upsert") {
        const keys = this.conflict!.split(",").map(key => key.trim())
        const updates = entries.filter(([key]) => !keys.includes(key)).map(([key]) => `${identifier(key)} = EXCLUDED.${identifier(key)}`)
        sql += ` ON CONFLICT (${keys.map(identifier).join(",")}) DO ${updates.length ? `UPDATE SET ${updates.join(",")}` : "NOTHING"}`
      }
    } else if (this.action === "update") {
      const entries = Object.entries(this.row).filter(([, value]) => value !== undefined)
      if (!entries.length) throw new Error("Empty update")
      sql = `UPDATE ${table} SET ${entries.map(([key, value]) => `${identifier(key)} = ${bind(value, key)}`).join(",")}`
    } else sql = this.action === "delete" ? `DELETE FROM ${table}` : `SELECT ${columns} FROM ${table}`
    if (this.filters.length) sql += " WHERE " + this.filters.map(({ column, op, value }) => {
      const name = identifier(column)
      if (op === "IN") { const list = value as unknown[]; return list.length ? `${name} IN (${list.map(item => bind(item)).join(",")})` : "FALSE" }
      return `${name} ${op} ${bind(value)}`
    }).join(" AND ")
    if (this.action === "select") {
      if (this.orders.length) sql += ` ORDER BY ${this.orders.join(",")}`
      if (this.count !== undefined) sql += ` LIMIT ${bind(this.count)}`
    } else sql += ` RETURNING ${columns}`
    return { text: sql, values }
  }
  async execute() {
    try {
      const result = await databasePool().query(this.compile())
      if (this.cardinality === "one" && result.rows.length !== 1) throw new Error("Expected exactly one database row")
      if (this.cardinality === "optional" && result.rows.length > 1) throw new Error("Expected at most one database row")
      return { data: this.cardinality === "many" ? result.rows : result.rows[0] ?? null, error: null }
    } catch (error) { return { data: null, error: error as Error } }
  }
  then<TResult1 = any, TResult2 = never>(fulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null, rejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> { return this.execute().then(fulfilled, rejected) }
}

export const postgresClient = {
  from: (table: string) => new PostgresQuery(table),
  async rpc(name: string, args: Record<string, unknown>) {
    try {
      if (!["eb_v2_save_review", "eb_v2_move_package"].includes(name)) throw new Error("Unsupported database function")
      const keys = Object.keys(args)
      await databasePool().query(`SELECT ${identifier(name)}(${keys.map((key, index) => `${identifier(key)} => $${index + 1}`).join(",")})`, keys.map(key => param(args[key])))
      return { error: null }
    } catch (error) { return { error: error as Error & { code?: string } } }
  },
}

export async function putBinary(storagePath: string, data: Buffer, contentType: string) {
  if (data.length > 15 * 1024 * 1024) throw new Error("File exceeds 15 MiB")
  await databasePool().query("INSERT INTO intercom_writer_document_binaries(path, content_type, data) VALUES ($1,$2,$3)", [storagePath, contentType, data])
}
export async function getBinary(storagePath: string) {
  const { rows } = await databasePool().query("SELECT data, content_type FROM intercom_writer_document_binaries WHERE path=$1", [storagePath])
  if (!rows[0]) throw new Error("Document binary not found in Railway PostgreSQL; check the file migration.")
  return new Blob([new Uint8Array(rows[0].data)], { type: rows[0].content_type })
}
export async function removeBinaries(paths: string[]) {
  await databasePool().query("DELETE FROM intercom_writer_document_binaries WHERE path = ANY($1::text[])", [paths])
}
