import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import type { ClientConfig } from 'pg';

const localWorkspace = '00000000-0000-4000-8000-000000000000';

export function workspaceOptions(workspaceId: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(workspaceId)) throw Error('Expected a workspace UUID');
  return '-c search_path=public -c devagents.workspace_id=' + workspaceId;
}

export function postgresConfig(workspaceId: string): ClientConfig {
  const env = process.env;
  const user = env.DEVAGENTS_POSTGRES_USER ?? env.PGUSER;
  const passwordFile = env.DEVAGENTS_POSTGRES_PASSWORD_FILE;
  const password = passwordFile ? readFileSync(passwordFile, 'utf8').trimEnd() : undefined;
  if (passwordFile && !password) throw Error('The PostgreSQL password file is empty');
  return {
    host: env.DEVAGENTS_POSTGRES_HOST ?? env.PGHOST ?? 'localhost',
    database: env.DEVAGENTS_POSTGRES_DATABASE ?? env.PGDATABASE ?? 'devagents',
    ...(user ? { user } : {}),
    ...(password ? { password } : {}),
    options: workspaceOptions(workspaceId),
    connectionTimeoutMillis: 5000, statement_timeout: 30000,
  };
}

export function workspaceConnection(path: string) {
  const env = process.env;
  if (env.NODE_TEST_CONTEXT && env.DEVAGENTS_TEST_DATABASE !== '1') throw Error('Run database tests with scripts/with-test-postgres.mjs');
  const fixtureId = env.DEVAGENTS_TEST_DATABASE === '1'
    ? createHash('sha256').update(resolve(path)).digest('hex').slice(0, 32).replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5')
    : undefined;
  const workspaceId = env.DEVAGENTS_WORKSPACE_ID ?? fixtureId ?? localWorkspace;
  return { config: postgresConfig(workspaceId), workspaceId };
}

type Row = Record<string, unknown>;

/** A pinned asynchronous connection for migrations and the session-level service lock. */
export class PgSession {
  private constructor(private readonly client: pg.Client, readonly workspaceId: string) {}

  static async open(path: string, guardService = false): Promise<PgSession> {
    const { config, workspaceId } = workspaceConnection(path);
    const client = new pg.Client({ ...config, application_name: (guardService ? 'devagents-lock:' : 'devagents:') + workspaceId });
    client.on('error', () => { if (guardService) process.kill(process.pid, 'SIGKILL'); });
    const db = new PgSession(client, workspaceId);
    try {
      await client.connect();
      const role = await db.prepare(`SELECT rolsuper OR rolbypassrls AS privileged,
        to_regclass('public.devagents_migrations') IS NOT NULL AS installed FROM pg_roles WHERE rolname=current_user`).get();
      if (!role?.installed) throw Error('Apply infra/postgres/install.sql to the DevAgents database before startup');
      if (role.privileged) throw Error('Use a PostgreSQL service login subject to row security');
      return db;
    } catch (error) { await client.end(); throw error; }
  }

  async exec(sql: string) { await this.client.query(sql); }
  prepare(sql: string) {
    const query = (...values: unknown[]) => this.client.query<Row>(sql, values);
    return {
      all: async (...values: unknown[]) => (await query(...values)).rows,
      get: async (...values: unknown[]) => (await query(...values)).rows[0],
      run: async (...values: unknown[]) => ({ changes: (await query(...values)).rowCount ?? 0 }),
    };
  }
  async begin() {
    await this.exec('BEGIN');
    await this.exec('SELECT pg_advisory_xact_lock(hashtextextended(workspace_context()::text, 0))');
  }
  close() { return this.client.end(); }
}
