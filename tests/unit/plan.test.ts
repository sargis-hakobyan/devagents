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
