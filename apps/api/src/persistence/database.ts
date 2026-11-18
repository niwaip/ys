import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
export interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface Database extends Queryable {
  transaction<T>(work: (session: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export const DATABASE = Symbol("DATABASE");
// Numbered migrations are applied atomically; new features append migrations here.
const migrations = [
  {
    version: 4,
    sql: `
    CREATE TABLE software_objects(id uuid PRIMARY KEY, customer_id text NOT NULL REFERENCES customers(id), name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(customer_id,id));
    CREATE TABLE software_versions(id uuid PRIMARY KEY,customer_id text NOT NULL,software_id uuid NOT NULL,version text,import_id uuid NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,id), UNIQUE(customer_id,import_id),FOREIGN KEY(customer_id,software_id) REFERENCES software_objects(customer_id,id),FOREIGN KEY(customer_id,import_id) REFERENCES import_materials(customer_id,id));
    CREATE INDEX software_versions_object ON software_versions(customer_id,software_id,created_at DESC);
  `,
  },
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
  {
    version: 2,
    sql: `
    CREATE TABLE import_materials (
      id uuid PRIMARY KEY, customer_id text NOT NULL REFERENCES customers(id),
      format text NOT NULL, file_name text NOT NULL, content text NOT NULL,
      content_hash text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(),
      result jsonb NOT NULL, UNIQUE(customer_id, format, content_hash), UNIQUE(customer_id,id)
    );
    ALTER TABLE assets ADD COLUMN import_id uuid;
    ALTER TABLE assets ADD COLUMN collected_at timestamptz;
    ALTER TABLE assets ADD CONSTRAINT assets_import_customer FOREIGN KEY(customer_id,import_id) REFERENCES import_materials(customer_id,id);
    CREATE UNIQUE INDEX assets_import_identity ON assets(customer_id,source,kind,source_ref) WHERE import_id IS NOT NULL;
  `,
  },
  {
    version: 8,
    sql: `
    CREATE TABLE lifecycle_assessments (
      id uuid PRIMARY KEY, customer_id text NOT NULL REFERENCES customers(id),
      batch_id uuid NOT NULL, evaluated_at timestamptz NOT NULL DEFAULT now(), result jsonb NOT NULL,
      FOREIGN KEY(customer_id,batch_id) REFERENCES import_materials(customer_id,id)
    );
    CREATE INDEX lifecycle_assessment_customer ON lifecycle_assessments(customer_id,evaluated_at DESC,id);
  `,
  },
];
export async function openDatabase(url: string): Promise<Database> {
  let raw: Queryable & { close(): Promise<void> };
  if (url.startsWith("pglite://")) {
    const path = resolve(url.slice("pglite://".length));
    await mkdir(path, { recursive: true });
    const engine = new PGlite(path);
    raw = {
      query: (sql, params) => engine.query(sql, params),
      close: () => engine.close(),
    };
  } else if (/^postgres(ql)?:\/\//.test(url)) {
    const pool = new pg.Pool({ connectionString: url });
    // One connection keeps migrations/transactions pinned to the same session.
    const client = await pool.connect();
    raw = {
      query: (sql, params) => client.query(sql, params),
      close: async () => {
        client.release();
        await pool.end();
      },
    };
  } else throw new Error("DATABASE_URL 必须为 pglite:// 或 PostgreSQL URL");
  // Serialize every query and transaction on the shared session. A transaction
  // receives an unqueued session so no other request can interleave its queries.
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  }
  const database: Database = {
    query: (sql, params) => exclusive(() => raw.query(sql, params)),
    transaction: (work) =>
      exclusive(async () => {
        await raw.query("BEGIN");
        try {
          const result = await work(raw);
          await raw.query("COMMIT");
          return result;
        } catch (error) {
          await raw.query("ROLLBACK");
          throw error;
        }
      }),
    close: () => exclusive(() => raw.close()),
  };
  try {
    await database.query("BEGIN");
    await database.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)",
    );
    for (const migration of [...migrations].sort(
      (a, b) => a.version - b.version,
    )) {
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
