import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { CodingEngine, EnginePhase, Validator, ValidationResult } from '../domain/engine.js';
import type { AgentDefinition, AppConfig, Task, WorkItem } from '../domain/schemas.js';
import { AppError } from '../domain/errors.js';
import { PolicyEngine } from '../domain/policy.js';
import { scopeAgent } from '../domain/ownership.js';
import type { TaskService } from './service.js';
import { ImplementationOutput, ReviewOutput } from './outputs.js';
import { readyWave, AgentSlots } from './dag-scheduler.js';
import { WorkspaceManager, git } from '../workspace/git.js';
import { changes, commitOwned, commitChanges } from '../workspace/changes.js';
import { integrationSnapshot, integrateItem, assertIntegrationConfig } from '../workspace/integration.js';
import { assertValidationCommand } from '../engines/codex/validator.js';

type Workspace = NonNullable<Task['workspace']>;
type Item = z.infer<typeof WorkItem>;
type Context = { cwd: string; workItemId: string };
type Hooks = {
  service: TaskService; engine: CodingEngine; validator: Validator; task: Task; agents: AgentDefinition[]; signal: AbortSignal;
  active(): Task;
  move(state: Task['state'], reason: string, patch?: Partial<Pick<Task, 'outcome'>>): Task;
  provider(agent: AgentDefinition): AppConfig['providers'][number];
  invoke(phase: EnginePhase, agent: AgentDefinition, prompt: string, schema: z.ZodType, signal: AbortSignal, context: Context): Promise<unknown>;
  onRepair(): number;
};

export async function runDag(h: Hooks): Promise<void> {
  const { service, task, agents, signal } = h;
  const plan = task.plan!; const workspace = task.workspace!; const project = service.store.project(task.projectId);
  if (!plan.integration) throw new AppError('invalid_plan', 'Multi-item execution requires integration instructions');
  const record = (kind: string, data: unknown) => service.store.record(task.id, kind, data);
  const state = (itemId: string, state: string, data: Record<string, unknown> = {}) => record('work-item', { itemId, state, ...data });
  const developers = new Map(plan.items.map(item => {
    const agent = agents.find(a => a.enabled && a.delegation.canReceiveTasks && a.id === item.assignedAgent);
    if (!agent || !item.ownedPaths) throw new AppError('missing_agent', `No scoped developer for ${item.id}`);
    if (item.branch !== `${workspace.branch}-${item.id}`) throw new AppError('branch_mismatch', `Work item ${item.id} must use branch ${workspace.branch}-${item.id}`);
    if (!item.validation.length) throw new AppError('missing_validation', `Work item ${item.id} needs validation`);
    item.validation.forEach(assertValidationCommand);
    return [item.id, scopeAgent(agent, item.ownedPaths)];
  }));
  const integrationAgent = agents.find(a => a.id === plan.integration!.assignedAgent && a.enabled && a.delegation.canReceiveTasks);
  if (!integrationAgent) throw new AppError('missing_agent', 'Integration agent is unavailable');
  const integrator = scopeAgent(integrationAgent, [...new Set(plan.items.flatMap(item => item.ownedPaths!))]);
  plan.integration.validation.forEach(assertValidationCommand);
  const implementers = new Set([...developers.values()].map(a => a.id)); implementers.add(integrator.id);
  const reviewer = agents.find(a => a.enabled && a.delegation.canReceiveTasks && a.capabilities.includes('review') && !implementers.has(a.id));
  if (!reviewer) throw new AppError('missing_agent', 'Multi-item execution needs a reviewer independent of every implementer and integrator');
  const readOnlyReviewer = { ...reviewer, permissions: { ...reviewer.permissions, writePaths: [], allowCommands: false } };
  for (const agent of [...new Map([...developers.values(), integrator, reviewer].map(a => [a.id, a])).values()]) await h.engine.preflight(h.provider(agent));
  await assertIntegrationConfig(workspace.path);
  h.active(); h.move('running', 'Scheduling approved work items in isolated worktrees');
  for (const item of plan.items) state(item.id, 'pending', { agentId: item.assignedAgent, dependsOn: item.dependsOn, branch: item.branch, ownedPaths: item.ownedPaths });
  const slots = new AgentSlots(); let repairCycles = 0;
  const repair = () => { repairCycles++; h.onRepair(); };
  const invoke = (phase: EnginePhase, agent: AgentDefinition, prompt: string, schema: z.ZodType, workerSignal: AbortSignal, context: Context) =>
    slots.run(agent.id, agent.concurrency, workerSignal, () => h.invoke(phase, agent, prompt, schema, workerSignal, context));
  const validate = async (cwd: string, commands: Item['validation'], workerSignal: AbortSignal, itemId: string): Promise<ValidationResult[]> => {
    const evidence = [];
    for (const command of commands) {
      h.active(); if (workerSignal.aborted) throw new AppError('cancelled', 'Work item cancelled');
      const result = await h.validator.execute(cwd, command, workerSignal, service.config.validationTimeoutMs);
      evidence.push(result); record('validation', { workItemId: itemId, ...result });
    }
    return evidence;
  };
  const review = async (current: Awaited<ReturnType<typeof changes>>, evidence: ValidationResult[], cwd: string, itemId: string, criteria: unknown, workerSignal: AbortSignal) => {
    for (const file of current.files) await new PolicyEngine().file(reviewer, cwd, file, 'read');
    return await invoke('review', readOnlyReviewer,
      `Independently review this ${itemId === '@integration' ? 'combined change' : 'work item'} against its acceptance criteria. Do not modify files or execute commands. Findings must contain only actionable defects requiring repair. Positive observations belong in summary. Approve only with approved=true and findings=[].\nUser request: ${task.request}\nUser acceptance criteria: ${JSON.stringify(task.acceptanceCriteria)}\nScope and acceptance criteria: ${JSON.stringify(criteria)}\nDiff:\n${current.diff}\nActual validation:\n${JSON.stringify(evidence).slice(0, 50000)}`,
      ReviewOutput, workerSignal, { cwd, workItemId: itemId }) as z.infer<typeof ReviewOutput>;
  };
  const executeItem = async (item: Item, baseSha: string, workerSignal: AbortSignal) => {
    const developer = developers.get(item.id)!; let localRepairs = 0; let worker: Workspace | undefined;
    const check = () => { h.active(); if (workerSignal.aborted) throw new AppError('cancelled', 'Work item cancelled'); };
    try {
      check(); state(item.id, 'creating', { baseSha });
      record('worktree-intent', { owner: task.id, workItemId: item.id, branch: item.branch, baseSha });
      worker = await new WorkspaceManager(service.dataDir).createItem(project, task.id, item.id, baseSha);
      state(item.id, 'running', { workspace: worker });
      let feedback = '';
      for (;;) {
        check();
        await invoke('implementation', developer, `Implement only this work item. Dependency results are already present in this worktree. Do not commit or modify Git metadata.\nRequest: ${task.request}\nUser acceptance criteria: ${JSON.stringify(task.acceptanceCriteria)}\nWork item: ${JSON.stringify(item)}\n${feedback}`, ImplementationOutput, workerSignal, { cwd: worker.path, workItemId: item.id });
        const before = await changes(worker, developer);
        if (!before.files.length) throw new AppError('no_changes', `Work item ${item.id} produced no changes`);
        check(); state(item.id, 'validating');
        const evidence = await validate(worker.path, item.validation, workerSignal, item.id);
        const after = await changes(worker, developer);
        if (before.digest !== after.digest) throw new AppError('validation_mutated_files', 'Validation changed work item files');
        if (evidence.some(e => e.exitCode !== 0)) feedback = `Repair failed validation:\n${JSON.stringify(evidence).slice(0, 50000)}`;
        else {
          check(); state(item.id, 'reviewing');
          const assessment = await review(after, evidence, worker.path, item.id, item, workerSignal);
          if (assessment.approved && !assessment.findings.length) {
            check(); const checked = await changes(worker, developer);
            if (checked.digest !== after.digest) throw new AppError('review_mutated_files', 'Files changed during work item review');
            state(item.id, 'checkpointing', { files: checked.files });
            record('item-commit-intent', { workItemId: item.id, workspace: worker, digest: checked.digest });
            const commit = await commitOwned(worker, checked.files, `DevAgents work item ${item.id} (combined review pending)`);
            record('item-commit-created', { workItemId: item.id, commit });
            check(); state(item.id, 'reviewed', { commit, repairCycles: localRepairs });
            return { item, workspace: worker, commit };
          }
          feedback = `Repair independent review findings:\n${JSON.stringify(assessment)}`;
        }
        check();
        if (localRepairs >= service.config.maxRepairCycles) throw new AppError('repair_limit', `Work item ${item.id} exhausted its repair budget. ${feedback.slice(0, 2000)}`);
        localRepairs++; repair(); state(item.id, 'repairing', { repairCycles: localRepairs });
      }
    } catch (error) {
      state(item.id, workerSignal.aborted ? 'cancelled' : 'failed', { error: error instanceof Error ? error.message : String(error), repairCycles: localRepairs });
      throw error;
    }
  };
  const done = new Set<string>(); const started = new Set<string>(); let integrationRepairs = 0;
  try {
    while (done.size < plan.items.length) {
      h.active();
      const nodes = readyWave(plan.items.map(item => ({ ...item, agentId: developers.get(item.id)!.id, agentConcurrency: developers.get(item.id)!.concurrency })), done, service.config.concurrency);
      const baseSha = await integrationSnapshot(workspace, integrator);
      record('dependency-checkpoint', { baseSha, completed: [...done] });
      const abort = new AbortController(); const cancel = () => abort.abort(); signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) abort.abort();
      let failure: unknown;
      const results = await Promise.allSettled(nodes.map(node => {
        started.add(node.id);
        return executeItem(plan.items.find(i => i.id === node.id)!, baseSha, abort.signal).catch(error => { failure ??= error; abort.abort(); throw error; });
      }));
      signal.removeEventListener('abort', cancel);
      if (failure) throw failure;
      h.active();
      for (const result of results) {
        if (result.status !== 'fulfilled') throw result.reason;
        const completed = result.value;
        state(completed.item.id, 'integrating');
        record('integration-intent', { workItemId: completed.item.id, commit: completed.commit });
        const conflicts = await integrateItem(workspace, completed.workspace, completed.commit, integrator);
        if (conflicts.length) {
          record('integration-conflict', { workItemId: completed.item.id, files: conflicts, agentId: integrator.id });
          let resolved = false;
          while (!resolved) {
            h.active();
            if (integrationRepairs >= service.config.maxRepairCycles) throw new AppError('integration_conflict', 'Integration conflict exhausted the repair budget; inspect preserved worktrees and evidence.');
            integrationRepairs++; repair();
            for (const file of conflicts) await new PolicyEngine().file(integrator, workspace.path, file, 'write');
            await invoke('implementation', integrator, `Resolve this explicit integration conflict. Preserve all work-item requirements. Edit project files only; do not use Git or commit. Remove conflict markers.\nUser request: ${task.request}\nPlan: ${JSON.stringify(plan)}\nConflicting files: ${JSON.stringify(conflicts)}`, ImplementationOutput, signal, { cwd: workspace.path, workItemId: '@integration' });
            await changes(workspace, integrator);
            resolved = true;
            for (const file of conflicts) {
              const path = await new PolicyEngine().file(integrator, workspace.path, file, 'write');
              const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
              if (/^(<{7} |={7}$|>{7} )/m.test(text)) resolved = false;
            }
            if (resolved) {
              await assertIntegrationConfig(workspace.path);
              await git(workspace.path, ['add', '--', ...conflicts]);
              record('integration-resolved', { workItemId: completed.item.id, files: conflicts, repairCycles: integrationRepairs });
            }
          }
        }
        await changes(workspace, integrator);
        done.add(completed.item.id); state(completed.item.id, 'completed', { commit: completed.commit });
      }
    }
    const commands = [...new Map([...plan.items.flatMap(i => i.validation), ...plan.integration.validation].map(c => [JSON.stringify(c), c])).values()];
    for (;;) {
      h.active(); h.move('validating', 'Validating combined work-item results');
      const before = await changes(workspace, integrator);
      if (!before.files.length) throw new AppError('no_changes', 'Combined task has no changes');
      const evidence = await validate(workspace.path, commands, signal, '@integration');
      const after = await changes(workspace, integrator);
      if (before.digest !== after.digest) throw new AppError('validation_mutated_files', 'Combined validation changed project files');
      let feedback = '';
      if (evidence.some(e => e.exitCode !== 0)) feedback = `Combined validation failed:\n${JSON.stringify(evidence).slice(0, 50000)}`;
      else {
        h.active(); h.move('reviewing', 'Independent combined review');
        const assessment = await review(after, evidence, workspace.path, '@integration', plan, signal);
        if (assessment.approved && !assessment.findings.length) {
          h.active(); const checked = await changes(workspace, integrator);
          if (checked.digest !== after.digest) throw new AppError('review_mutated_files', 'Files changed during combined review');
          h.active(); h.move('committing', 'Finalizing reviewed combined local commit');
          record('commit-intent', { branch: workspace.branch, digest: checked.digest, files: checked.files });
          const commit = await commitChanges(project, workspace, checked.files);
          record('commit-created', { commit, branch: workspace.branch });
          h.move('completed', 'DAG execution, combined validation and review passed; local commit created', { outcome: { commit, files: checked.files, summary: plan.summary, repairCycles } });
          return;
        }
        feedback = `Combined review requested repairs:\n${JSON.stringify(assessment)}`;
      }
      h.active();
      if (integrationRepairs >= service.config.maxRepairCycles) throw new AppError('repair_limit', `Combined integration repair budget exhausted. ${feedback.slice(0, 2000)}`);
      integrationRepairs++; repair(); h.move('repairing', 'Bounded integration repair requested', { outcome: { repairCycles } });
      h.move('running', 'Integration agent repairing combined result');
      await invoke('implementation', integrator, `Repair the combined result within the plan's owned paths. Do not commit or modify Git metadata.\nRequest: ${task.request}\nPlan: ${JSON.stringify(plan)}\n${feedback}`, ImplementationOutput, signal, { cwd: workspace.path, workItemId: '@integration' });
    }
  } catch (error) {
    for (const item of plan.items) if (!done.has(item.id) && !started.has(item.id)) state(item.id, signal.aborted ? 'cancelled' : 'blocked', { reason: 'Task stopped before dependencies completed' });
    throw error;
  }
}
