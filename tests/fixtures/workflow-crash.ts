import { join } from 'node:path';
import { Store } from '../../src/persistence/store.js';
import { TaskService } from '../../src/orchestration/service.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { Config } from '../../src/domain/schemas.js';
import { FakeEngine, FixtureValidator } from './fake-engine.js';

const [dataDir, id] = process.argv.slice(2) as [string, string];
const store = new Store(join(dataDir, 'test.db'));
const service = new TaskService(store, Config.parse({ schemaVersion: 1, devagentsRules: true }), dataDir);
const engine = new FakeEngine({ waitForCancel: true });
const execute = engine.execute.bind(engine);
engine.execute = async request => {
  if (request.phase === 'implementation') process.send?.({ running: true });
  return execute(request);
};
const runner = new TaskRunner(service, engine, new FixtureValidator()); service.attachRunner(runner);
runner.enqueue(id);
await runner.idle();
await runner.stop(); store.close();
