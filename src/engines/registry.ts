import type { CodingEngine } from '../domain/engine.js';
import { AppError } from '../domain/errors.js';

/** Routing is by the member's frozen engine ID; no silent fallback between runtimes. */
export class EngineRegistry {
  private readonly engines = new Map<string, CodingEngine>();
  constructor(engines: readonly CodingEngine[]) {
    for (const engine of engines) {
      if (this.engines.has(engine.id)) throw new AppError('duplicate_engine', `Duplicate engine ${engine.id}`);
      this.engines.set(engine.id, engine);
    }
  }
  has(id: string): boolean { return this.engines.has(id); }
  get(id: string): CodingEngine {
    const engine = this.engines.get(id);
    if (!engine) throw new AppError('engine_unavailable', `Engine ${id} is not implemented`);
    return engine;
  }
  ids(): Set<string> { return new Set(this.engines.keys()); }
}
