import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Id } from '../../src/domain/schemas.js';
import { checkExistingMounts, projectMount } from '../../src/cli/project-mount.js';
const exec = promisify(execFile);
const normalize = (name: string) => exec('sh', ['scripts/project-id.sh', name], { env: { ...process.env, LC_ALL: 'en_US.UTF-8' } });

test('launcher names normalize to backend-valid IDs before mounting, independently of locale', async () => {
  for (const [name, expected] of [['TestProject', 'testproject'], [' Test Project  ', 'test-project'], ['ADOPS-Monorepo', 'adops-monorepo'], ['project-123', 'project-123']]) {
    const id = (await normalize(name!)).stdout.trim();
    assert.equal(id, expected); assert.equal(Id.parse(id), expected);
    assert.doesNotThrow(() => checkExistingMounts({ services: { devagents: { volumes: [] } } }, id, '/fixture'));
    assert.match(projectMount('', id, '/fixture'), new RegExp(`/projects/${expected}`));
  }
  for (const name of ['', '123-project', '-project', 'café', 'project/path', 'a'.repeat(65), 'hello\nworld']) await assert.rejects(normalize(name), /project name|project ID/);
});

test('mount failures distinguish invalid IDs from conflicting existing mounts', () => {
  assert.throws(() => checkExistingMounts({}, 'TestProject', '/fixture'), /Project ID must start with a lowercase letter/);
  assert.throws(() => checkExistingMounts({ services: { devagents: { volumes: [{ target: '/projects/testproject', source: '/original' }] } } }, 'testproject', '/replacement'), /already has a different mount/);
  assert.throws(() => checkExistingMounts({ services: { devagents: { volumes: [{ target: '/projects/existing', source: '/fixture' }] } } }, 'testproject', '/fixture'), /already mounted under another project ID/);
});
