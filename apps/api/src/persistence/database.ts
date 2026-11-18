import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
export interface Database {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}
export const DATABASE = Symbol("DATABASE");
// Numbered migrations are applied atomically; new features append migrations here.
const migrations = [
  {
    version: 1,
    sql: `
  CREATE TABLE customers (id text PRIMARY KEY, name text NOT NULL);
  CREATE TABLE assets (
    id uuid PRIMARY KEY, customer_id text NOT NULL REFERENCES customers(id),
    name text NOT NULL, kind text NOT NULL CHECK (kind = 'host'),
    source text NOT NULL, source_ref text, attributes jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(customer_id, id)
  );
  CREATE INDEX assets_customer_created ON assets(customer_id, created_at DESC, id);
`,
  },
];
export async function openDatabase(url: string): Promise<Database> {
  let database: Database;
  if (url.startsWith("pglite://")) {
    const path = resolve(url.slice("pglite://".length));
    await mkdir(path, { recursive: true });
    const engine = new PGlite(path);
    database = {
      query: (sql, params) => engine.query(sql, params),
      close: () => engine.close(),
    };
  } else if (/^postgres(ql)?:\/\//.test(url)) {
    const pool = new pg.Pool({ connectionString: url });
    // One connection keeps migrations/transactions pinned to the same session.
    const client = await pool.connect();
    database = {
      query: (sql, params) => client.query(sql, params),
      close: async () => {
        client.release();
        await pool.end();
      },
    };
  } else throw new Error("DATABASE_URL 必须为 pglite:// 或 PostgreSQL URL");
  try {
    await database.query("BEGIN");
    await database.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)",
    );
    for (const migration of migrations) {
      const existing = await database.query(
        "SELECT version FROM schema_migrations WHERE version=$1",
        [migration.version],
      );
      if (!existing.rows.length) {
        // PostgreSQL protocol accepts one multi-statement command without parameters.
        for (const statement of migration.sql
          .split(";")
          .filter((s) => s.trim()))
          await database.query(statement);
        await database.query(
          "INSERT INTO schema_migrations(version) VALUES ($1)",
          [migration.version],
        );
      }
    }
    await database.query("COMMIT");
    return database;
  } catch (error) {
    await database.query("ROLLBACK").catch(() => {});
    await database.close();
    throw error;
  }
}
