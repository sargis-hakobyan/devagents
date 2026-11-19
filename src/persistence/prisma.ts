import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { workspaceConnection } from './pg-session.js';

/** Every connection in this repository pool uses the same trusted workspace and row-security settings. */
export function prismaFor(path: string) {
  const { config, workspaceId } = workspaceConnection(path);
  const adapter = new PrismaPg({ ...config, max: 4, allowExitOnIdle: true });
  const client = new PrismaClient({ adapter, errorFormat: 'minimal', transactionOptions: { maxWait: 30_000, timeout: 30_000 } }).$extends({
    query: {
      async $allOperations({ args, query }) {
        try { return await query(args); }
        catch (error) {
          // Prisma diagnostics can render the entire input, including a password hash or private task content.
          if (error instanceof Error && error.name.startsWith('PrismaClient')) {
            const code = 'code' in error && typeof error.code === 'string' ? error.code : 'invalid_database_request';
            throw Object.assign(new Error(`PostgreSQL operation failed (${code})`), { code });
          }
          throw error;
        }
      },
    },
  });
  return { client, workspaceId };
}

type ApplicationClient = ReturnType<typeof prismaFor>['client'];
type Models = Parameters<Parameters<ApplicationClient['$transaction']>[0]>[0];

export class WorkspacePersistence {
  private readonly transactions = new AsyncLocalStorage<Models>();
  private readonly client: ApplicationClient;
  readonly workspaceId: string;

  constructor(path: string) {
    const connection = prismaFor(path);
    this.client = connection.client;
    this.workspaceId = connection.workspaceId;
  }

  get models(): Models { return this.transactions.getStore() ?? this.client; }

  async write<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactions.getStore()) return work();
    return this.client.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(workspace_context()::text, 0))`;
      return this.transactions.run(tx, work);
    });
  }

  /** Parameterized PostgreSQL for queue fencing and reporting queries that need database operations. */
  prepare(sql: string) {
    const rows = (...values: unknown[]) => this.models.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...values);
    return {
      all: rows,
      get: async (...values: unknown[]) => (await rows(...values))[0],
      run: async (...values: unknown[]) => ({ changes: await this.models.$executeRawUnsafe(sql, ...values) }),
    };
  }
  close() { return this.client.$disconnect(); }
}
