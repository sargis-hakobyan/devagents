import type { AgentDefinition, AppConfig } from './schemas.js';

export type EnginePhase = 'planning' | 'implementation' | 'review';
export type EngineProgress = { kind: 'started' | 'message' | 'command' | 'file-change' | 'usage'; text?: string; data?: unknown };
export type EngineRequest = {
  runId: string; workItemId?: string; phase: EnginePhase; cwd: string; prompt: string;
  agent: AgentDefinition; provider: AppConfig['providers'][number];
  schema: Record<string, unknown>; signal: AbortSignal; timeoutMs: number;
};
export type EngineResult = { output: unknown; usage?: unknown };
export interface CodingEngine {
  readonly id: string;
  preflight(provider: AppConfig['providers'][number]): Promise<void>;
  execute(request: EngineRequest, progress: (event: EngineProgress) => void): Promise<EngineResult>;
}
export type ValidationResult = { executable: string; args: string[]; exitCode: number; output: string };
export interface Validator {
  execute(cwd: string, command: { executable: string; args: string[] }, signal: AbortSignal, timeoutMs: number): Promise<ValidationResult>;
}
