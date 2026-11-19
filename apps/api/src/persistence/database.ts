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
    version: 10,
    sql: `CREATE TABLE customer_conversations(id uuid PRIMARY KEY,customer_id text NOT NULL REFERENCES customers(id),idempotency_key text NOT NULL,input_hash text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,idempotency_key));`,
  },
  {
    version: 9,
    sql: `CREATE TABLE agent_queries(id uuid PRIMARY KEY,owner_key text NOT NULL,idempotency_key text NOT NULL,original_message text NOT NULL,status text NOT NULL,events jsonb NOT NULL DEFAULT '[]',result jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,UNIQUE(owner_key,idempotency_key));`,
  },
  {
    version: 13,
    sql: `CREATE TABLE reports(id uuid PRIMARY KEY,customer_id text NOT NULL REFERENCES customers(id),created_at timestamptz NOT NULL,created_by text NOT NULL,UNIQUE(customer_id,id)); CREATE TABLE report_revisions(id uuid PRIMARY KEY,customer_id text NOT NULL,report_id uuid NOT NULL,number integer NOT NULL,result jsonb NOT NULL,UNIQUE(customer_id,id),UNIQUE(customer_id,report_id,number),FOREIGN KEY(customer_id,report_id) REFERENCES reports(customer_id,id)); CREATE INDEX reports_customer ON reports(customer_id,created_at DESC,id);`,
  },
  {
    version: 5,
    sql: `CREATE TABLE vulnerability_jobs(id uuid PRIMARY KEY,customer_id text NOT NULL REFERENCES customers(id),idempotency_key text NOT NULL,status text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,idempotency_key),UNIQUE(customer_id,id)); CREATE INDEX vulnerability_jobs_customer ON vulnerability_jobs(customer_id,created_at DESC,id);`,
  },
  {
    version: 4,
    sql: `
    CREATE TABLE software_objects(id uuid PRIMARY KEY, customer_id text NOT NULL REFERENCES customers(id), name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(customer_id,id));
    CREATE TABLE software_versions(id uuid PRIMARY KEY,customer_id text NOT NULL,software_id uuid NOT NULL,version text,import_id uuid NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,id), UNIQUE(customer_id,import_id),FOREIGN KEY(customer_id,software_id) REFERENCES software_objects(customer_id,id),FOREIGN KEY(customer_id,import_id) REFERENCES import_materials(customer_id,id));
    CREATE INDEX software_versions_object ON software_versions(customer_id,software_id,created_at DESC);
  `,
  },
  {
    version: 3,
    sql: `CREATE TABLE windows_identities(customer_id text NOT NULL, source_ref text NOT NULL,asset_id uuid NOT NULL,PRIMARY KEY(customer_id,source_ref),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id));
CREATE TABLE windows_snapshots(id uuid PRIMARY KEY,customer_id text NOT NULL,asset_id uuid NOT NULL,import_id uuid NOT NULL,snapshot jsonb NOT NULL,UNIQUE(customer_id,id),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id),FOREIGN KEY(customer_id,import_id) REFERENCES import_materials(customer_id,id));`,
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
