import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { persistenceError } from "./errors.js";
import { PgQueryable } from "./pool.js";

/**
 * Apply the SQL migrations in `sql/` in filename order.
 *
 * Migrations are idempotent (`IF NOT EXISTS` / `ON CONFLICT`), so running them
 * on every start is safe and removes a class of "works on my machine"
 * schema drift. Ordering is by filename, hence the `001_`/`002_` prefixes.
 */
export async function runMigrations(db: PgQueryable): Promise<string[]> {
  const dir = fileURLToPath(new URL("../sql/", import.meta.url));
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  } catch (error) {
    throw persistenceError("readMigrations", error);
  }
  const applied: string[] = [];
  for (const file of files) {
    const sql = await readFile(fileURLToPath(new URL(`../sql/${file}`, import.meta.url)), "utf8");
    try {
      await db.query(sql);
      applied.push(file);
    } catch (error) {
      throw persistenceError(`migrate:${file}`, error);
    }
  }
  return applied;
}
