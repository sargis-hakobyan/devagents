import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';

const directory = await mkdtemp(join(tmpdir(), 'devagents-mastra-'));
const shape = z.object({ request: z.string() });
function create() {
  const approval = createStep({
    id: 'approval', inputSchema: shape, outputSchema: shape,
    resumeSchema: z.object({ approved: z.boolean() }),
    suspendSchema: z.object({ reason: z.string() }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData?.approved) return suspend({ reason: 'Explicit approval required' });
      return inputData;
    },
  });
  const workflow = createWorkflow({ id: 'spike', inputSchema: shape, outputSchema: shape }).then(approval).commit();
  const storage = new LibSQLStore({ id: 'spike-storage', url: `file:${join(directory, 'mastra.db')}` });
  const mastra = new Mastra({ workflows: { spike: workflow }, storage });
  return { mastra, storage };
}
try {
  const first = create();
  const run = await first.mastra.getWorkflow('spike').createRun();
  const paused = await run.start({ inputData: { request: 'Persist this approval' } });
  assert.equal(paused.status, 'suspended');
  await first.storage.close();
  const second = create();
  const restored = await second.mastra.getWorkflow('spike').createRun({ runId: run.runId });
  const resumed = await restored.resume({ step: 'approval', resumeData: { approved: true } });
  assert.equal(resumed.status, 'success');
  if (resumed.status === 'success') assert.deepEqual(resumed.result, { request: 'Persist this approval' });
  await second.storage.close();
  console.log('PASS: Mastra workflow suspension survives storage/runtime recreation and resumes.');
} finally { await rm(directory, { recursive: true, force: true }); }
