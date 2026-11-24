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
    version: 25,
    sql: `CREATE TABLE finding_analyses(id uuid PRIMARY KEY,customer_id text NOT NULL,assessment_id uuid NOT NULL,finding_id uuid NOT NULL,idempotency_key text NOT NULL,actor_key text NOT NULL,status text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,assessment_id,idempotency_key),FOREIGN KEY(customer_id,assessment_id) REFERENCES vulnerability_jobs(customer_id,id)); CREATE INDEX finding_analyses_scope ON finding_analyses(customer_id,assessment_id,finding_id,created_at DESC,id);`,
  },
  {
    version: 24,
    sql: `ALTER TABLE assets ADD COLUMN deleted_at timestamptz; ALTER TABLE assets ADD COLUMN deleted_by text; ALTER TABLE assets ADD COLUMN hardware_type text NOT NULL DEFAULT 'unknown' CHECK(hardware_type IN ('unknown','server','network')); CREATE TABLE asset_audit(id uuid PRIMARY KEY,customer_id text NOT NULL,asset_id uuid NOT NULL,action text NOT NULL,actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id));`,
  },
  {
    version: 14,
    sql: `CREATE TABLE report_narrations(id uuid PRIMARY KEY,customer_id text NOT NULL,report_id uuid NOT NULL,base_revision_id uuid NOT NULL,idempotency_key text NOT NULL,actor_key text NOT NULL,status text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,report_id,idempotency_key),FOREIGN KEY(customer_id,report_id) REFERENCES reports(customer_id,id),FOREIGN KEY(customer_id,base_revision_id) REFERENCES report_revisions(customer_id,id));CREATE INDEX report_narration_scope ON report_narrations(customer_id,report_id,created_at DESC,id);`,
  },
  {
    version: 11,
    sql: `CREATE TABLE software_current(customer_id text NOT NULL,software_id uuid NOT NULL,version_id uuid NOT NULL,assessment_id uuid,selected_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(customer_id,software_id),FOREIGN KEY(customer_id,software_id) REFERENCES software_objects(customer_id,id),FOREIGN KEY(customer_id,version_id) REFERENCES software_versions(customer_id,id),FOREIGN KEY(customer_id,assessment_id) REFERENCES vulnerability_jobs(customer_id,id));`,
  },
  {
    version: 10,
    sql: `CREATE TABLE customer_conversations(id uuid PRIMARY KEY,customer_id text NOT NULL REFERENCES customers(id),idempotency_key text NOT NULL,input_hash text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,idempotency_key));`,
  },
  {
    version: 15,
    sql: `ALTER TABLE report_revisions ADD CONSTRAINT report_revision_scope UNIQUE(customer_id,report_id,id); CREATE TABLE report_audit(sequence bigserial PRIMARY KEY,id uuid UNIQUE NOT NULL,customer_id text NOT NULL,report_id uuid NOT NULL,revision_id uuid NOT NULL,action text NOT NULL,actor jsonb NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(customer_id,report_id,revision_id) REFERENCES report_revisions(customer_id,report_id,id)); CREATE TABLE report_deliveries(id uuid PRIMARY KEY,customer_id text NOT NULL,report_id uuid NOT NULL,revision_id uuid NOT NULL,html text NOT NULL,result jsonb NOT NULL,UNIQUE(customer_id,revision_id),FOREIGN KEY(customer_id,report_id,revision_id) REFERENCES report_revisions(customer_id,report_id,id));`,
  },
  {
    version: 6,
    sql: `CREATE TABLE container_images(id uuid PRIMARY KEY,customer_id text NOT NULL REFERENCES customers(id),name text NOT NULL,source text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,id));CREATE TABLE container_versions(id uuid PRIMARY KEY,customer_id text NOT NULL,container_id uuid NOT NULL,import_id uuid NOT NULL,version text,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,id),UNIQUE(customer_id,import_id),FOREIGN KEY(customer_id,container_id) REFERENCES container_images(customer_id,id),FOREIGN KEY(customer_id,import_id) REFERENCES import_materials(customer_id,id));CREATE INDEX container_versions_image ON container_versions(customer_id,container_id,created_at DESC);`,
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
  {
    version: 16,
    sql: `CREATE TABLE netbox_assets(customer_id text NOT NULL,asset_id uuid PRIMARY KEY,instance text NOT NULL,object_type text NOT NULL CHECK(object_type IN ('device','virtual-machine')),external_id integer NOT NULL,tenant_id integer NOT NULL,synced_at timestamptz NOT NULL,active boolean NOT NULL DEFAULT true,UNIQUE(instance,object_type,external_id),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id));`,
  },
  {
    version: 17,
    sql: `CREATE TABLE netbox_operations(id uuid PRIMARY KEY,customer_id text NOT NULL REFERENCES customers(id),idempotency_key text NOT NULL,input_hash text NOT NULL,status text NOT NULL,input jsonb NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,idempotency_key));`,
  },
  {
    version: 18,
    sql: `CREATE TABLE collection_snapshots(id uuid PRIMARY KEY,customer_id text NOT NULL,asset_id uuid NOT NULL,entry text NOT NULL,file_name text NOT NULL,content text NOT NULL,content_hash text NOT NULL,note text,normalized jsonb NOT NULL,target jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,id),UNIQUE(customer_id,entry,content_hash),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id));CREATE INDEX collection_asset ON collection_snapshots(customer_id,asset_id,created_at DESC,id);`,
  },
  {
    version: 19,
    sql: `CREATE TABLE collection_jobs(id uuid PRIMARY KEY,customer_id text NOT NULL,asset_id uuid NOT NULL,idempotency_key text NOT NULL,input_hash text NOT NULL,status text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,id),UNIQUE(customer_id,idempotency_key),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id));CREATE INDEX collection_jobs_customer ON collection_jobs(customer_id,created_at DESC,id);`,
  },
  {
    version: 20,
    sql: `CREATE TABLE asset_version_links(id uuid PRIMARY KEY,customer_id text NOT NULL,asset_id uuid NOT NULL,snapshot_id uuid NOT NULL,input_hash text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,id),UNIQUE(customer_id,input_hash),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id),FOREIGN KEY(customer_id,snapshot_id) REFERENCES collection_snapshots(customer_id,id));`,
  },
  {
    version: 21,
    sql: `ALTER TABLE collection_snapshots ADD COLUMN summary jsonb;`,
  },
  {
    version: 22,
    sql: `CREATE TABLE access_credentials(id uuid PRIMARY KEY,customer_id text NOT NULL REFERENCES customers(id),name text NOT NULL,sealed jsonb NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,id));CREATE TABLE asset_connections(id uuid PRIMARY KEY,customer_id text NOT NULL,asset_id uuid NOT NULL,credential_id uuid NOT NULL,name text NOT NULL,host text NOT NULL,port integer NOT NULL,username text NOT NULL,host_key text NOT NULL,allow_docker boolean NOT NULL DEFAULT false,active boolean NOT NULL DEFAULT true,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,id),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id),FOREIGN KEY(customer_id,credential_id) REFERENCES access_credentials(customer_id,id));`,
  },
  {
    version: 23,
    sql: `CREATE TABLE asset_baselines(sequence bigserial PRIMARY KEY,id uuid UNIQUE NOT NULL,customer_id text NOT NULL,asset_id uuid NOT NULL,snapshot_id uuid NOT NULL,actor text NOT NULL,idempotency_key text NOT NULL,input_hash text NOT NULL,status text NOT NULL,plan jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,idempotency_key),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id),FOREIGN KEY(customer_id,snapshot_id) REFERENCES collection_snapshots(customer_id,id));CREATE INDEX asset_baselines_current ON asset_baselines(customer_id,asset_id,sequence DESC);`,
  },
  {
    version: 26,
    sql: `CREATE TABLE lifecycle_risk_config(customer_id text PRIMARY KEY REFERENCES customers(id), config jsonb NOT NULL); CREATE TABLE lifecycle_risk_views(id uuid PRIMARY KEY,customer_id text NOT NULL REFERENCES customers(id),result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,id)); CREATE INDEX lifecycle_risk_views_latest ON lifecycle_risk_views(customer_id,created_at DESC,id); CREATE TABLE lifecycle_risk_treatments(customer_id text NOT NULL,asset_id uuid NOT NULL,risk_type text NOT NULL,details jsonb NOT NULL,PRIMARY KEY(customer_id,asset_id,risk_type),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id));`,
  },
  {
    version: 27,
    sql: `CREATE TABLE container_sources(id uuid PRIMARY KEY,customer_id text NOT NULL REFERENCES customers(id),asset_id uuid,container_id uuid NOT NULL,version_id uuid NOT NULL,input_hash text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,id),UNIQUE(customer_id,input_hash),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id),FOREIGN KEY(customer_id,container_id) REFERENCES container_images(customer_id,id),FOREIGN KEY(customer_id,version_id) REFERENCES container_versions(customer_id,id)); CREATE INDEX container_sources_asset ON container_sources(customer_id,asset_id,created_at DESC); CREATE TABLE container_source_artifacts(customer_id text NOT NULL,source_id uuid NOT NULL,content text NOT NULL,content_hash text NOT NULL,PRIMARY KEY(customer_id,source_id),FOREIGN KEY(customer_id,source_id) REFERENCES container_sources(customer_id,id)); CREATE TABLE container_generation_jobs(id uuid PRIMARY KEY,customer_id text NOT NULL,asset_id uuid NOT NULL,idempotency_key text NOT NULL,input_hash text NOT NULL,status text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,idempotency_key),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id));`,
  },
  {
    version: 28,
    sql: `CREATE TABLE dashboard_scopes(id uuid PRIMARY KEY,customer_id text NOT NULL REFERENCES customers(id),content_gzip text NOT NULL,content_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()); CREATE INDEX dashboard_scopes_customer ON dashboard_scopes(customer_id,created_at DESC);`,
  },
  {
    version: 29,
    sql: `CREATE FUNCTION ys_dashboard_assessment(job jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
      SELECT jsonb_build_object(
        'id',job->'id','status',job->'status','target',job->'target',
        'input',jsonb_build_object('contentHash',job#>'{input,contentHash}'),
        'createdAt',job->'createdAt','error',job->'error',
        'toolVersion',job#>'{execution,toolVersion}',
        'execution',jsonb_build_object('toolVersion',job#>'{execution,toolVersion}'),
        'result',CASE WHEN jsonb_typeof(job->'result')='object' THEN jsonb_build_object(
          'coverage',job#>'{result,coverage}','database',job#>'{result,database}',
          'findings',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id',f->'id','vulnerabilityId',f->'vulnerabilityId','severity',f->'severity',
            'applicability',f->'applicability','packageName',f->'packageName',
            'installedVersion',f->'installedVersion','fixedVersion',f->'fixedVersion'
          )),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(job#>'{result,findings}','[]'::jsonb)) f)
        ) ELSE NULL END
      )
      $$;
      ALTER TABLE vulnerability_jobs ADD COLUMN target_object_id text GENERATED ALWAYS AS (COALESCE(details#>>'{target,softwareId}',details#>>'{target,containerId}',details#>>'{target,assetId}')) STORED;
      ALTER TABLE vulnerability_jobs ADD COLUMN target_input_id text GENERATED ALWAYS AS (COALESCE(details#>>'{target,versionId}',details#>>'{target,snapshotId}')) STORED;
      ALTER TABLE vulnerability_jobs ADD COLUMN dashboard_details jsonb GENERATED ALWAYS AS (ys_dashboard_assessment(details)) STORED;
      CREATE INDEX vulnerability_jobs_dashboard_target ON vulnerability_jobs(customer_id,target_object_id,target_input_id,created_at DESC,id);`,
  },
  {
    version: 31,
    sql: `ALTER TABLE collection_snapshots ADD COLUMN review_required boolean NOT NULL DEFAULT false;`,
  },
  {
    version: 30,
    sql: `CREATE TABLE collection_role_templates(customer_id text NOT NULL REFERENCES customers(id),role_id integer NOT NULL,category text NOT NULL,PRIMARY KEY(customer_id,role_id));
  CREATE TABLE collection_rejections(customer_id text NOT NULL,snapshot_id uuid NOT NULL,asset_id uuid NOT NULL,actor text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(customer_id,snapshot_id),FOREIGN KEY(customer_id,snapshot_id) REFERENCES collection_snapshots(customer_id,id),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id));`,
  },
  {
    version: 33,
    sql: `CREATE TABLE lifecycle_asset_history(id uuid PRIMARY KEY,customer_id text NOT NULL,asset_id uuid NOT NULL,actor text NOT NULL,before_data jsonb NOT NULL,after_data jsonb NOT NULL,source text NOT NULL,status text NOT NULL DEFAULT 'confirmed',created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id));CREATE INDEX lifecycle_history_asset ON lifecycle_asset_history(customer_id,asset_id,created_at DESC);`,
  },
  {
    version: 32,
    sql: `CREATE TABLE collection_configurations(customer_id text NOT NULL,asset_id uuid NOT NULL,details jsonb NOT NULL,PRIMARY KEY(customer_id,asset_id),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id));CREATE TABLE collection_configuration_runs(id uuid PRIMARY KEY,customer_id text NOT NULL,asset_id uuid NOT NULL,idempotency_key text NOT NULL,input_hash text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,asset_id,idempotency_key),FOREIGN KEY(customer_id,asset_id) REFERENCES assets(customer_id,id));`,
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
