// Applies a SQL migration file to a Postgres database.
// Usage: SLATE_DB_URL="postgres://…" node scripts/run-migration.mjs [path]
import { readFileSync } from "node:fs";
import pg from "pg";

const url = process.env.SLATE_DB_URL;
if (!url) {
  console.error("Set SLATE_DB_URL to the Supabase connection string.");
  process.exit(1);
}

const file = process.argv[2] ?? "supabase/migrations/0001_init.sql";
const sql = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false }, // Supabase requires TLS
});

try {
  await client.connect();
  await client.query(sql);
  const { rows } = await client.query(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
  );
  console.log(`Applied ${file}.`);
  console.log("Public tables:", rows.map((r) => r.table_name).join(", "));
} catch (err) {
  console.error("Migration failed:", err.message);
  process.exit(1);
} finally {
  await client.end();
}
