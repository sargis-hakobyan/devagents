import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Id } from '../../src/domain/schemas.js';
import { checkExistingMounts, hostFolders, orphanMount, projectMount } from '../../src/cli/project-mount.js';
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
  assert.throws(() => checkExistingMounts({}, 'TestProject', '/fixture'), /Project ID must contain only lowercase letters/);
  assert.throws(() => checkExistingMounts({ services: { devagents: { volumes: [{ target: '/projects/testproject', source: '/original' }] } } }, 'testproject', '/replacement'), /already has a different mount/);
  assert.throws(() => checkExistingMounts({ services: { devagents: { volumes: [{ target: '/projects/existing', source: '/fixture' }] } } }, 'testproject', '/fixture'), /already registered as project "existing"\. Use it, or archive it first: \.\/devagents project archive --name 'existing'/);
});

test('a folder held only by archived projects can be mounted again under a new ID, keeping the old mount for its history', () => {
  const effective = { services: { devagents: { volumes: [{ target: '/data', source: 'devagents-data' }, { target: '/projects/old-name', source: '/fixture' }] } } };
  assert.doesNotThrow(() => checkExistingMounts(effective, 'new-name', '/fixture', { archived: ['/projects/old-name'] }));
  assert.throws(() => checkExistingMounts(effective, 'new-name', '/fixture', { archived: ['/projects/something-else'], names: { '/projects/old-name': "Old one's" } }), /already registered as project "Old one's"\. Use it, or archive it first: \.\/devagents project archive --name 'Old one'"'"'s'/);
  const previous = projectMount('', 'old-name', '/fixture');
  assert.throws(() => projectMount(previous, 'new-name', '/fixture'), /already registered as project "old-name"/);
  const both = projectMount(previous, 'new-name', '/fixture', { archived: ['/projects/old-name'] });
  assert.match(both, /target: \/projects\/old-name/); assert.match(both, /target: \/projects\/new-name/);
  assert.throws(() => projectMount(both, '3f9c2a71-0b1d-4e5f-8a6b-7c8d9e0f1a2b', '/fixture', { archived: ['/projects/old-name'] }), /already registered as project "new-name"/);
});

test('an interrupted setup is finished under the ID it already mounted', () => {
  const id = '3f9c2a71-0b1d-4e5f-8a6b-7c8d9e0f1a2b';
  const mounts = projectMount(projectMount('', id, '/unfinished'), 'registered', '/registered');
  const info = { names: { '/projects/registered': 'Registered' } };
  assert.equal(orphanMount(mounts, '/unfinished', info), id);
  assert.equal(orphanMount(mounts, '/registered', info), undefined, 'a registered folder is not an unfinished setup');
  assert.equal(orphanMount(mounts, '/never-mounted', info), undefined);
  assert.equal(orphanMount('', '/unfinished', info), undefined);
  assert.doesNotThrow(() => projectMount(mounts, id, '/unfinished', info));
});

test('the folder on the computer is read for each project mount and nothing else', () => {
  const effective = { services: { devagents: { volumes: [
    { type: 'volume', source: 'devagents-data', target: '/data' },
    { type: 'bind', source: '/Users/someone/work/monorepo', target: '/projects/test-project', bind: { create_host_path: false } },
    { type: 'bind', source: '/Users/someone/elsewhere', target: '/custom/mount' },
    { type: 'bind', source: 'relative', target: '/projects/odd' },
  ] }, other: { volumes: [{ type: 'bind', source: '/x', target: '/projects/not-ours' }] } } };
  assert.deepEqual(hostFolders(effective), { '/projects/test-project': '/Users/someone/work/monorepo' });
  assert.deepEqual(hostFolders({}), {}); assert.deepEqual(hostFolders(null), {});
});
