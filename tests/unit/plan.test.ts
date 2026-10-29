import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../../src/domain/plan.js';
import { loadRegistry, builtinDirectory } from '../../src/agents/registry.js';
import { Config } from '../../src/domain/schemas.js';
import { validPlan } from '../helpers.js';

test('DAG rejects cycles, missing dependencies, cross-project work and unavailable capabilities', async () => {
  const agents = await loadRegistry([builtinDirectory], Config.parse({ schemaVersion: 1 }));
  assert.equal(validatePlan(validPlan(), 'fixture', agents).items.length, 1);
  const cycle = validPlan(); cycle.items[0]!.dependsOn = ['greeting'];
  assert.throws(() => validatePlan(cycle, 'fixture', agents), /cycle/);
  const missing = validPlan(); missing.items[0]!.dependsOn = ['missing'];
  assert.throws(() => validatePlan(missing, 'fixture', agents), /Unknown dependency/);
  assert.throws(() => validatePlan(validPlan(), 'other-project', agents), /another project/);
  const capability = validPlan(); capability.items[0]!.requiredCapabilities = ['asset-design'];
  assert.throws(() => validatePlan(capability, 'fixture', agents), /No available agent/);
});

test('plans are rejected before approval when they could not execute: commands, reviewers and platform write grants', async () => {
  const agents = await loadRegistry([builtinDirectory], Config.parse({ schemaVersion: 1 }));
  const inline = validPlan(); inline.items[0]!.validation = [{ executable: 'node', args: ['-e', 'process.exit(1)'] }];
  assert.throws(() => validatePlan(inline, 'fixture', agents), /Validation supports/);
  const none = validPlan(); none.items[0]!.validation = [];
  assert.throws(() => validatePlan(none, 'fixture', agents), /at least one validation command/);
  const exact = { ...validPlan(), items: [{ ...validPlan().items[0]!, ownedPaths: ['project:/greeting.cjs'] }] };
  assert.equal(validatePlan(exact, 'fixture', agents, { platform: 'darwin' }).items.length, 1);
  assert.throws(() => validatePlan(exact, 'fixture', agents, { platform: 'linux' }), /Exact-file writes cannot be safely executed/);
  const subtree = { ...validPlan(), items: [{ ...validPlan().items[0]!, ownedPaths: ['project:/src/**'] }] };
  assert.equal(validatePlan(subtree, 'fixture', agents, { platform: 'linux' }).items.length, 1);
  // A role that reviews its own work is not independent; without the builtin reviewer the plan cannot run.
  const selfReviewing = agents.map(a => a.id === 'code-reviewer' ? { ...a, enabled: false } : a.id === 'backend-developer' ? { ...a, capabilities: [...a.capabilities, 'review'] } : a);
  assert.throws(() => validatePlan(validPlan(), 'fixture', selfReviewing), /independent of every implementer/);
  const multi = { summary: 'Two modules', risks: [], integration: { assignedAgent: 'general-developer', validation: [{ executable: 'npm', args: ['test'] }] }, items: ['a', 'b'].map(id => ({ ...validPlan().items[0]!, id, branch: `codex/greeting-${id}`, assignedAgent: 'backend-developer', ownedPaths: [`project:/${id}/**`] })) };
  assert.equal(validatePlan(multi, 'fixture', agents, { platform: 'linux' }).items.length, 2);
  const badIntegration = { ...multi, integration: { assignedAgent: 'general-developer', validation: [{ executable: 'npm', args: ['run', 'deploy'] }] } };
  assert.throws(() => validatePlan(badIntegration, 'fixture', agents), /Validation supports/);
});
