import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow, type WorkflowOptions } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { terminalStates } from '../domain/lifecycle.js';
import { redact, redactValues } from '../telemetry/redact.js';
import type { TaskService } from './service.js';

export const TASK_WORKFLOW_ID = 'devagents-task-v1';
const identity = z.object({ taskId: z.string() });
type Hooks = { prepare(id: string): Promise<void>; plan(id: string): Promise<void>; environment?(id: string): Promise<void>; execute(id: string): Promise<void> };
const errorMessage = (error: unknown): string => error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : String(error);

/** Mastra owns control flow and durable waits; domain storage owns approvals and Git evidence.
 * Snapshot payloads contain references only; failures contain bounded, redacted error excerpts.
 * Prompts, diffs and provider settings stay in the existing domain/evidence layer.
 * Active side effects are deliberately not replayable after a process interruption.
 */
export class TaskWorkflows {
  private readonly storage: LibSQLStore;
  private readonly workflow;
  private readonly options: WorkflowOptions;
  constructor(private readonly service: TaskService, hooks: Hooks) {
    this.storage = new LibSQLStore({ id: 'devagents-workflows', url: pathToFileURL(join(service.dataDir, 'workflows.db')).href });
    this.options = {
      autoRestartActiveRuns: false,
      pruneSnapshot: ({ snapshot }) => redactValues(JSON.parse(JSON.stringify(snapshot, (_key, value: unknown) =>
        value instanceof Error ? { name: value.name, message: value.message } : value)), service.store.secrets) as typeof snapshot,
    };
    const operation = (name: string, work: (id: string) => Promise<void>) => createStep({
      id: name, inputSchema: identity, outputSchema: identity, retries: 0,
      execute: async ({ inputData }) => {
        await this.checked(inputData.taskId, name, () => work(inputData.taskId));
        return inputData;
      },
    });
    const gate = (name: 'mode' | 'approval') => createStep({
      id: name, inputSchema: identity, outputSchema: identity, retries: 0,
      resumeSchema: z.object({ version: z.number().int() }),
      suspendSchema: z.object({ taskId: z.string(), version: z.number().int() }),
      execute: async ({ inputData, suspend }) => {
        const task = service.store.task(inputData.taskId);
        if (terminalStates.includes(task.state)) throw new Error('Task already finished');
        // Resume data never grants permission. Only the version-checked domain mutation does.
        if (task.state === (name === 'mode' ? 'awaiting_mode' : 'awaiting_plan_approval')) {
          return suspend({ taskId: task.id, version: task.version });
        }
        if (name === 'mode' ? !task.mode : task.state !== 'ready' || !task.plan) throw new Error('Task has no approved execution configuration');
        return inputData;
      },
    });
    this.workflow = createWorkflow({
      id: TASK_WORKFLOW_ID, inputSchema: identity, outputSchema: identity,
      retryConfig: { attempts: 0, delay: 0 }, options: this.options,
    }).then(gate('mode'))
      .then(operation('prepare-worktree', hooks.prepare))
      .then(operation('plan', hooks.plan))
      .then(gate('approval'))
      .then(operation('prepare-environment', hooks.environment ?? (async () => {})))
      .then(operation('execute-plan', hooks.execute)).commit();
    // Disable framework logging: task events use the application's redacted evidence channel.
    new Mastra({ workflows: { task: this.workflow }, storage: this.storage, logger: false });
  }

  private async checked<T>(id: string, step: string, work: () => Promise<T>): Promise<T> {
    this.service.store.record(id, 'workflow-step', { workflow: TASK_WORKFLOW_ID, step, state: 'running' });
    try {
      const result = await work();
      this.service.store.record(id, 'workflow-step', { workflow: TASK_WORKFLOW_ID, step, state: 'completed' });
      return result;
    } catch (error) {
      // Framework error snapshots must not bypass the normal redaction path.
      const message = String(redact(errorMessage(error), this.service.store.secrets)).slice(0, 8000);
      this.service.store.record(id, 'workflow-step', { workflow: TASK_WORKFLOW_ID, step, state: 'failed', error: message });
      throw new Error(message);
    }
  }

  async state(id: string) { return this.workflow.getWorkflowRunById(id, { withNestedWorkflows: false }); }

  async run(id: string): Promise<void> {
    const task = this.service.store.task(id);
    const previous = await this.state(id);
    if (terminalStates.includes(task.state)) {
      if (previous && !['success', 'failed', 'canceled'].includes(previous.status)) await (await this.workflow.createRun({ runId: id })).cancel();
      // A hard process death can leave child loop/wave snapshots running. They contain
      // references, not replayable closures; reconcile them under the service's single-owner lock.
      const workflows = await this.storage.getStore('workflows');
      for (const event of this.service.store.evidence(id)) {
        if (event.kind !== 'workflow-child') continue;
        const child = event.data as { workflow: string; workflowRunId: string };
        if (!['devagents-cycle-v1', 'devagents-wave-v1'].includes(child.workflow)) continue;
        const key = { workflowName: child.workflow, runId: child.workflowRunId };
        const status = await workflows?.loadWorkflowRunStatus(key);
        if (status && !['success', 'failed', 'canceled'].includes(status)) {
          await workflows?.updateWorkflowState({ ...key, opts: { status: 'canceled' } });
          this.service.store.record(id, 'workflow-reconciled', { ...child, status: 'canceled', taskState: task.state });
        }
      }
      return;
    }
    if (previous && previous.status !== 'suspended') {
      // Never restart a possibly executed command/commit from a stale framework snapshot.
      throw new AppError('workflow_interrupted', 'Workflow interrupted or already finished; inspect preserved worktrees and evidence before submitting a new task');
    }
    const run = await this.workflow.createRun({ runId: id });
    let result;
    if (previous) {
      const step = Object.entries(previous.steps ?? {}).find(([, value]) => !Array.isArray(value) && value.status === 'suspended')?.[0];
      if (step !== 'mode' && step !== 'approval') throw new AppError('workflow_checkpoint', 'No resumable approval checkpoint');
      if (task.state === (step === 'mode' ? 'awaiting_mode' : 'awaiting_plan_approval')) return;
      result = await run.resume({ step, resumeData: { version: task.version } });
    } else {
      this.service.store.record(id, 'workflow-started', { workflow: TASK_WORKFLOW_ID, workflowRunId: id });
      result = await run.start({ inputData: { taskId: id } });
    }
    this.service.store.record(id, 'workflow-status', { workflow: TASK_WORKFLOW_ID, workflowRunId: id, status: result.status });
    if (result.status === 'failed') throw new Error(errorMessage(result.error));
    if (!['success', 'suspended'].includes(result.status)) throw new AppError('workflow_stopped', `Workflow stopped: ${result.status}`);
  }

  /** Bounded domain repair decisions, executed by Mastra's loop primitive. */
  async repeat(id: string, scope: string, attempt: () => Promise<boolean>): Promise<void> {
    const shape = identity.extend({ iteration: z.number().int(), done: z.boolean() });
    const step = createStep({
      id: 'attempt', inputSchema: shape, outputSchema: shape, retries: 0,
      execute: async ({ inputData }) => ({ ...inputData, iteration: inputData.iteration + 1,
        done: await this.checked(id, `${scope}:${inputData.iteration}`, attempt) }),
    });
    const workflow = createWorkflow({ id: 'devagents-cycle-v1', inputSchema: shape, outputSchema: shape,
      retryConfig: { attempts: 0, delay: 0 }, options: this.options,
    }).dountil(step, async ({ inputData }) => inputData.done).commit();
    new Mastra({ workflows: { cycle: workflow }, storage: this.storage, logger: false });
    const run = await workflow.createRun({ runId: randomUUID() });
    this.service.store.record(id, 'workflow-child', { scope, workflow: workflow.id, workflowRunId: run.runId });
    const result = await run.start({ inputData: { taskId: id, iteration: 0, done: false } });
    if (result.status !== 'success') throw new Error(result.status === 'failed' ? errorMessage(result.error) : `Execution cycle stopped: ${result.status}`);
  }

  /** Mastra dispatches a bounded wave. Drain every sibling before propagating a failure. */
  async parallel<T>(id: string, count: number, work: (index: number) => Promise<T>): Promise<T[]> {
    const shape = identity.extend({ index: z.number().int() });
    const results: T[] = []; let failure: unknown;
    const step = createStep({ id: 'worker', inputSchema: shape, outputSchema: shape, retries: 0,
      execute: async ({ inputData }) => {
        // Catch here so a failed foreach branch cannot release the task slot while siblings write.
        try { results[inputData.index] = await work(inputData.index); } catch (error) { failure ??= error; }
        return inputData;
      },
    });
    const workflow = createWorkflow({ id: 'devagents-wave-v1', inputSchema: z.array(shape), outputSchema: z.array(shape),
      retryConfig: { attempts: 0, delay: 0 }, options: this.options,
    }).foreach(step, { concurrency: count }).then(createStep({
      id: 'join', inputSchema: z.array(shape), outputSchema: z.array(shape), retries: 0,
      execute: async ({ inputData }) => this.checked(id, 'join-workers', async () => {
        if (failure) throw failure;
        return inputData;
      }),
    })).commit();
    new Mastra({ workflows: { wave: workflow }, storage: this.storage, logger: false });
    const run = await workflow.createRun({ runId: randomUUID() });
    this.service.store.record(id, 'workflow-child', { scope: 'workers', workflow: workflow.id, workflowRunId: run.runId });
    const result = await run.start({ inputData: Array.from({ length: count }, (_, index) => ({ taskId: id, index })) });
    if (result.status !== 'success') throw new Error(result.status === 'failed' ? errorMessage(result.error) : `Worker wave stopped: ${result.status}`);
    return results;
  }

  async close(): Promise<void> { await this.storage.close(); }
}
