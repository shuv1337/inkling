// Applies db/schema.sql, then any db/migrations/NNN_*.sql not yet recorded.
// Idempotent. Run with `npm run db:migrate`.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Put it in .env.local.");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Drop `--` comments, then split on semicolons. Statements have no `--` inside strings. */
function statements(file) {
  return readFileSync(file, "utf8")
    .replace(/--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  const schema = statements(join(root, "db", "schema.sql"));
  for (const s of schema) await sql.unsafe(s);

  await sql.unsafe(
    `create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )`
  );

  const dir = join(root, "db", "migrations");
  const files = readdirSync(dir)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  const applied = new Set((await sql`select version from schema_migrations`).map((row) => row.version));
  let ran = 0;
  for (const name of files) {
    const version = name.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    const steps = statements(join(dir, name));
    await sql.begin(async (tx) => {
      for (const step of steps) await tx.unsafe(step);
      await tx`insert into schema_migrations (version) values (${version})`;
    });
    ran++;
    console.log(`Applied ${version}`);
  }

  const tables = await sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`;
  console.log(`Applied ${schema.length} schema statements and ${ran} new migration(s). Tables: ${tables.map((t) => t.table_name).join(", ")}`);
} finally {
  await sql.end({ timeout: 5 });
}
