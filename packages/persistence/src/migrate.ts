import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { persistenceError } from "./errors.js";
import { PgQueryable } from "./pool.js";

/** The bookkeeping table recording which files this database has applied. */
export const MIGRATIONS_TABLE = "uae_schema_migrations";

/**
 * Apply the SQL migrations in `sql/` in filename order.
 *
 * Migrations are idempotent (`IF NOT EXISTS` / `ON CONFLICT`), so running them
 * on every start is safe and removes a class of "works on my machine" schema
 * drift. Ordering is by filename, hence the `001_`/`002_` prefixes.
 *
 * Idempotence alone is not enough, though. Re-executing every file on every boot
 * re-runs `CREATE INDEX` and `ALTER TABLE` statements that are only *written* to
 * be safe, and it means a file whose statements are destructive-by-mistake would
 * run on every start of every process. So applied filenames are recorded in
 * {@link MIGRATIONS_TABLE} and an already-applied file is skipped.
 *
 * The record is written in the **same transaction** as the migration body. A
 * crash between the two would otherwise leave a file marked applied that was
 * never applied — a phantom migration that silently skips real schema.
 *
 * The return value is the full ordered list of known migration files (the
 * database's schema version), not the subset applied by this call, so callers
 * can compare two databases or two runs without special-casing an empty result.
 */
export async function runMigrations(db: PgQueryable): Promise<string[]> {
  const dir = fileURLToPath(new URL("../sql/", import.meta.url));
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  } catch (error) {
    throw persistenceError("readMigrations", error);
  }

  try {
    await db.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
         filename   text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const applied = await db.query<{ filename: string }>(
      `SELECT filename FROM ${MIGRATIONS_TABLE}`,
    );
    const done = new Set(applied.rows.map((row) => row.filename));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(fileURLToPath(new URL(`../sql/${file}`, import.meta.url)), "utf8");
      await db.transaction("READ COMMITTED", async (tx) => {
        await tx.query(sql);
        await tx.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
          [file],
        );
      });
    }
  } catch (error) {
    throw persistenceError("runMigrations", error);
  }
  return files;
}
