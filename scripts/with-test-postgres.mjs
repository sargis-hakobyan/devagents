// Run fixtures against one public schema using the same row policies as the service.
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { readFile } from 'node:fs/promises';

const name = 'devagents-tests-' + randomUUID();
const password = randomBytes(32).toString('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', env: { ...process.env, POSTGRES_PASSWORD: password } }).trim();
let started = false;
try {
  docker('run', '-d', '--rm', '--tmpfs', '/var/lib/postgresql/data:size=2g', '--name', name, '-e', 'POSTGRES_PASSWORD', '-p', '127.0.0.1::5432', 'postgres:17-alpine', '-c', 'max_connections=200');
  started = true;
  const port = docker('port', name, '5432/tcp').split(':').at(-1);
  const env = { ...process.env, PGHOST: '127.0.0.1', PGPORT: port, PGUSER: 'postgres', PGDATABASE: 'postgres', PGPASSWORD: password, DEVAGENTS_TEST_DATABASE: '1' };
  delete env.DEVAGENTS_POSTGRES_HOST;
  delete env.DEVAGENTS_POSTGRES_PASSWORD_FILE;
  delete env.DEVAGENTS_POSTGRES_DATABASE;
  delete env.DEVAGENTS_POSTGRES_USER;
  for (let i = 0;; i++) {
    const client = new pg.Client({ host: env.PGHOST, port: Number(port), database: env.PGDATABASE, user: env.PGUSER, password });
    try { await client.connect(); await client.end(); break; }
    catch (e) { await client.end(); if (i === 100) throw e; await delay(150); }
  }
  const admin = new pg.Client({ host: env.PGHOST, port: Number(port), database: env.PGDATABASE, user: 'postgres', password });
  await admin.connect();
  try {
    await admin.query('BEGIN');
    await admin.query(await readFile(new URL('../infra/postgres/migrations/0001_shared_public/migration.sql', import.meta.url), 'utf8'));
    const fixturePassword = randomBytes(32).toString('hex');
    env.PGPASSWORD = fixturePassword;
    await admin.query("CREATE ROLE devagents_fixture LOGIN PASSWORD '" + fixturePassword + "' IN ROLE devagents_runtime,devagents_accounts");
    await admin.query('GRANT UPDATE ON schema_versions, password_accounts TO devagents_fixture');
    await admin.query('COMMIT');
  } finally { await admin.end(); }
  env.PGUSER = 'devagents_fixture';
  delete env.DEVAGENTS_WORKSPACE_ID;
  const [command, ...args] = process.argv.slice(2);
  const child = spawn(command, args, { env, stdio: 'inherit' });
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => child.kill(signal));
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} finally { if (started) docker('rm', '-f', '-v', name); }
