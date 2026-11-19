# Self-service DevAgents deployment proposal

Allow users to register, open their private dashboard and submit tasks without an operator provisioning a runner. Each user can run up to two top-level tasks concurrently. The service has no fixed account-count limit. Available compute and provider quotas determine how many eligible tasks can start immediately. Five users and ten tasks are the first load test.

**Selected worker for the initial hosted deployment (2026-11-19).** SQS delivers eligible task stages directly to standard on-demand AWS Lambda. This lets the team pay for execution as tasks arrive.

## From registration to execution

Today the shared gateway routes each account to a separately provisioned workspace runtime. A missing runtime prevents the dashboard from loading workspace data. The following changes are proposed. [Current shared workspace setup](SETUP.md#two-private-workspaces-on-one-server)

1. **Register and sign in.** A shared API creates an identity and an owner-bound workspace record. The dashboard reads projects, tasks and status from PostgreSQL with owner-scoped authorization. An idle user can view the dashboard with zero execution workers assigned.
2. **Run.** Persist each request in PostgreSQL. A scheduler chooses eligible owners fairly, reserves one of the owner's two slots, and records an outgoing dispatch in the same transaction. Relay the dispatch to SQS. When capacity is busy, show the task as queued and keep the dashboard available.
3. **Execute a stage.** The Lambda handler validates the owner, dispatch generation and stage against PostgreSQL. It claims the stage once, opens its isolated Git worktree and runs the agent or validation step under the existing sandbox and credential rules. Persist the worktree on durable owner-scoped storage so a fresh invocation can reopen it.
4. **Continue or pause.** Each invocation has a 15-minute maximum. Split long workflows at safe boundaries with time to drain subprocesses, persist the worktree and commit the checkpoint and next dispatch before timeout. A continuation uses the same top-level task slot. At a human approval wait, release the slot and end the invocation. A version-checked approval re-enters admission. Reconcile uncertain effects after timeouts before replaying a stage. [Lambda timeouts](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html)

## When to revisit the worker

If an indivisible build or test cannot finish within one invocation, evaluate a long-running ECS worker for that stage. If Lambda cannot enforce the existing sandbox or credential isolation, qualify an isolated container worker before opening execution to multiple owners. Lambda Managed Instances is a future option for sustained demand and stages that fit its SQS invocation limit. The shared dashboard, scheduler and ownership model apply to each option.

## First acceptance run and next steps

- Register six accounts through the same public flow, including the sixth while ten tasks from the first five are active. Verify the sixth immediately sees its own dashboard, can submit tasks and obtains execution capacity as the pool grows or slots free up.
- Submit a third task for a busy owner. Verify it waits while another eligible owner makes progress. Exercise duplicate SQS delivery, cancellation, approval and a worker restart. Verify a single continuation, correct evidence, preserved worktrees and isolation of every owner's data and credentials.
- Measure click-to-first-agent-action for warm and cold workers, queue wait per owner, task duration, memory, disk I/O and provider throttling. Test a checkpoint across two fresh invocations and inject a timeout to verify recovery. If cold starts dominate, measure initialization before considering paid warm capacity. If build contention dominates, add worker capacity. If provider throttling dominates, pace calls or raise the affected quota.
- Qualify the alternative worker using the same representative repository and acceptance tests. If an uninterrupted build exceeds the Lambda invocation limit, run that stage on ECS. A worker change should preserve registration, dashboards, task ownership and approvals.

This is a proposed deployment. Self-service registration and the Lambda execution path require implementation. Sandbox compatibility, durable Git recovery and end-to-end timing still require verification.
