import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/persistence/store.js';
import { TaskService } from '../src/orchestration/service.js';
import { Config } from '../src/domain/schemas.js';

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'devagents-test-'));
  const project = join(root, 'project');
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  execFileSync('git', ['-C', project, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', project, 'config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(project, 'README.md'), '# Fixture\n');
  execFileSync('git', ['-C', project, 'add', '.']);
  execFileSync('git', ['-C', project, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Initial fixture']);
  const dataDir = join(root, 'data');
  const store = new Store(join(dataDir, 'test.db'), ['fixture-secret-value']);
  const service = new TaskService(store, Config.parse({ schemaVersion: 1 }), dataDir);
  await service.registerProject({ id: 'fixture', path: project });
  return { root, project, dataDir, store, service, cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}
export const validPlan = () => ({
  summary: 'Implement a greeting', risks: [], items: [{
    id: 'greeting', title: 'Greeting', description: 'Add a greeting', acceptanceCriteria: ['Greeting works'],
    dependsOn: [] as string[], requiredCapabilities: ['implementation'], projectId: 'fixture', branch: 'codex/greeting', validation: [{ executable: 'node', args: ['--test'] }],
  }],
});
