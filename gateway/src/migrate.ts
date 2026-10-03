// Applies the SQL files in migrations/ in filename order, once each, recording
// what ran in schema_migrations. Safe to run on every deploy.
//
//   npm run migrate              apply anything outstanding
//   npm run migrate -- --status  list applied and pending, change nothing
//   npm run migrate -- --baseline  mark everything as applied without running
//                                it, for a database that already has the schema
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { pool } from "./db.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

async function applied(client: PoolClient): Promise<Set<string>> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await client.query<{ filename: string }>(`SELECT filename FROM schema_migrations`);
  return new Set(rows.map((r) => r.filename));
}

async function main(): Promise<void> {
  const status = process.argv.includes("--status");
  const baseline = process.argv.includes("--baseline");
  const client = await pool.connect();
  try {
    const done = await applied(client);
    const files = await migrationFiles();
    const pending = files.filter((f) => !done.has(f));

    if (status) {
      for (const f of files) console.log(`${done.has(f) ? "applied" : "pending"}  ${f}`);
      return;
    }
    if (!pending.length) {
      console.log("database is up to date");
      return;
    }
    if (baseline) {
      for (const f of pending) {
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [f]);
        console.log(`marked as applied: ${f}`);
      }
      return;
    }

    for (const file of pending) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      // Each migration is one transaction: either it lands or nothing does.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
        await client.query("COMMIT");
        console.log(`applied ${file}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
