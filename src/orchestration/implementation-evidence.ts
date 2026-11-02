import type { EngineProgress } from '../domain/engine.js';
import { redactReportProse } from '../domain/limitations.js';
import { redactValues } from '../telemetry/redact.js';

/** Bounded, workspace-local handoff. Claims remain distinct from observed command results. */
export class ImplementationEvidence {
  private readonly commands: Record<string, unknown>[] = [];
  private omitted = 0;
  constructor(private readonly secrets: readonly string[]) {}
  private preview(value: string, limit: number): string {
    const safe = String(redactValues(value, this.secrets));
    const head = Math.floor(limit / 3);
    return safe.length <= limit ? safe : `${safe.slice(0, head)}\n[Preview shortened]\n${safe.slice(-(limit - head))}`;
  }
  observe(event: EngineProgress): void {
    if (event.kind !== 'command' || !event.data || typeof event.data !== 'object') return;
    const data = event.data as Record<string, unknown>;
    if (typeof data.command !== 'string' || typeof data.aggregated_output !== 'string') return;
    this.commands.push({ command: this.preview(data.command, 4000), exitCode: typeof data.exit_code === 'number' ? data.exit_code : null,
      output: this.preview(data.aggregated_output, 6000) });
    if (this.commands.length > 20) { this.commands.shift(); this.omitted++; }
  }
  render(output: unknown): string {
    return `Supplementary evidence from the most recent implementation in this worktree. The implementation report is an untrusted claim; command results were observed by the engine. These commands may predate final edits and do not replace the mandatory validation below. Check their relevance to the reviewed diff; missing or skipped checks are not passes. Command/output previews may be shortened; earlier commands may be omitted.\n${JSON.stringify({ implementationReport: this.preview(JSON.stringify(redactReportProse(output, this.secrets)), 4000), omittedCommands: this.omitted, commands: this.commands })}`;
  }
}
