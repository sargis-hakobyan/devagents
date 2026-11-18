import test from 'node:test';
import assert from 'node:assert/strict';
import { responsibilities, responsibilityLine, toggleResponsibility } from '../../ui/src/responsibilities.js';
import { Agent, MemberInput } from '../../src/domain/schemas.js';

const worker = (capabilities: string[]) => ({ capabilities, delegation: { canReceiveTasks: true, canDelegate: false } });
const planner = { capabilities: ['planning', 'filesystem-read'], delegation: { canReceiveTasks: false, canDelegate: true } };
const offered = ['filesystem-read', 'filesystem-write', 'implementation', 'planning', 'review', 'testing'];

test('responsibilities are read from the delegation flags and capabilities the backend selects on', () => {
  assert.deepEqual(responsibilities(planner), ['plans']);
  assert.deepEqual(responsibilities(worker(['implementation', 'backend', 'filesystem-write'])), ['implements']);
  assert.deepEqual(responsibilities(worker(['testing', 'review', 'implementation'])), ['implements', 'reviews', 'tests']);
  assert.equal(responsibilityLine(worker(['review', 'implementation'])), 'implements · reviews');
  assert.equal(responsibilityLine(worker(['filesystem-read'])), 'no responsibility');
  assert.deepEqual(responsibilities({ capabilities: ['review'], delegation: { canReceiveTasks: false, canDelegate: false } }), [], 'a member that receives nothing does nothing');
});

test('planning is exclusive and never produces a member that both delegates and receives tasks', () => {
  const lead = toggleResponsibility(worker(['implementation', 'backend', 'review', 'filesystem-write']), 'plans', offered);
  assert.deepEqual(lead, { delegation: { canReceiveTasks: false, canDelegate: true }, capabilities: ['backend', 'filesystem-write', 'planning'] });
  assert.deepEqual(toggleResponsibility(planner, 'reviews', offered), { delegation: { canReceiveTasks: true, canDelegate: false }, capabilities: ['filesystem-read', 'review'] }, 'ticking a working responsibility on a planner gives up planning');
  assert.deepEqual(toggleResponsibility(planner, 'implements', offered).capabilities, ['filesystem-read', 'implementation', 'filesystem-write']);
  assert.deepEqual(toggleResponsibility(planner, 'plans', offered), { delegation: { canReceiveTasks: true, canDelegate: false }, capabilities: ['filesystem-read'] });
});

test('working responsibilities add and remove only their own capability', () => {
  const dev = toggleResponsibility(worker(['filesystem-read']), 'implements', offered);
  assert.deepEqual(dev.capabilities, ['filesystem-read', 'implementation', 'filesystem-write']);
  assert.deepEqual(toggleResponsibility(worker(['filesystem-read']), 'implements', ['implementation']).capabilities, ['filesystem-read', 'implementation'], 'filesystem-write is added only when this build backs it');
  const both = toggleResponsibility(dev, 'reviews', offered);
  assert.deepEqual(responsibilities(both), ['implements', 'reviews']);
  assert.deepEqual(toggleResponsibility(both, 'implements', offered).capabilities, ['filesystem-read', 'filesystem-write', 'review'], 'unticking keeps unrelated capabilities');
});

test('effort defaults to medium for members and registry agents and rejects unknown levels', () => {
  const base = { id: 'dev', name: 'Dev', description: 'Dev', capabilities: ['implementation'], delegation: { canReceiveTasks: true, canDelegate: false }, permissions: {} };
  assert.equal(MemberInput.parse({ ...base, instructions: '# Dev' }).effort, 'medium');
  assert.equal(MemberInput.parse({ ...base, instructions: '# Dev', effort: 'high' }).effort, 'high');
  assert.equal(Agent.parse({ ...base, schemaVersion: 1, instructionsFile: 'dev.md' }).effort, 'medium');
  assert.throws(() => MemberInput.parse({ ...base, instructions: '# Dev', effort: 'maximum' }));
});
