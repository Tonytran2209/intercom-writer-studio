# Move Intercom Writer Studio to Railway PostgreSQL

## Prepared code

`DATABASE_PROVIDER=postgres` selects the pooled PostgreSQL adapter. With no explicit switch, existing Supabase persistence continues. `DATABASE_URL` alone does not trigger cutover. API routes stay unchanged; database RPCs for approval/moves execute the original PostgreSQL functions. The adapter uses parameterized values and validated identifiers.

Original documents (up to 15 MiB) use `intercom_writer_document_binaries` in Railway PostgreSQL. This removes the Supabase Storage dependency after file import; account for database/backup size. Consider dedicated object storage later if document volume grows.

## Configure privately

In Railway's app service, keep `DATABASE_URL=${{Postgres.DATABASE_URL}}`. Leave `DATABASE_PROVIDER=supabase` until import and verification finish. Keep source credentials for migration only.

For local migration, use a private ignored `.env` in `backend/` with:

```dotenv
DATABASE_URL=<Railway DATABASE_PUBLIC_URL for local access>
SOURCE_DATABASE_URL=<source Supabase direct/pooler PostgreSQL connection string>
SUPABASE_URL=<source project URL, for file downloads>
SUPABASE_SECRET_KEY=<source server key, for file downloads>
```

Use the actual private `DATABASE_URL` within Railway. Never commit `.env`, publish connection strings, or put them in frontend variables. Source DB connectivity and Storage access must work; the quota restriction may still prevent file downloads.

## Prepare schema (explicit operator command)

```sh
cd backend
npm run db:migrate
```

This runs existing migrations in order with a hash ledger and advisory lock, preserves functions/RLS, and creates NOLOGIN compatibility roles referenced by those migrations. Run as the Railway database owner against a fresh dedicated database. It also creates the file table. It is deliberately not an automatic app startup migration.

## Import and verify

Pause all source-app writes before taking the import snapshot. Default import copies only `eb_v2_*` and this app's namespaced Agent Library. Legacy tables and KV can be shared by other apps: inventory ownership before adding `--include-legacy`.

```sh
npm run db:import
npm run db:import -- --apply
```

To include legacy Writer Studio tables **only if their contents belong to this app**:

```sh
npm run db:import -- --include-legacy
npm run db:import -- --include-legacy --apply
```

The first command is read-only inventory. `--apply` refuses nonempty target tables, copies rows preserving IDs/timestamps, defers and then validates FKs, copies referenced files, checks row counts and commits atomically. Source remains read-only. Missing referenced files abort the target transaction. Existing target content is not overwritten. Import is intended for one cutover into an empty target; after a successful import, do not rerun `--apply` on that target.

## Cutover

1. Check import counts, file count and workflows on an isolated app deployment pointing at this database.
2. Set production `DATABASE_PROVIDER=postgres` and redeploy when ready. Source writes must remain paused through cutover.
3. Verify `/health/dependencies`, `/api/eb-v2/health`, workspace, Discovery, generation, Refine/Accept, channel approvals/moves and upload/download. Run Agent Library sync again if its source tables were absent.
4. Keep source data as rollback evidence. After writes resume in Railway, switching back requires reconciling those new writes; do not silently switch persistence providers.
5. Remove source Supabase credentials from the Railway app once verified. Back up Railway PostgreSQL before deleting any source data.

No migration/import/deployment is performed merely by installing this code.
