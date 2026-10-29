import { Store } from '../../src/persistence/store.js';
const store = new Store(process.argv[2]!);
const task = store.createTask({ projectId: 'fixture', request: 'Survive a process crash' }, 'crash-test');
process.send?.({ id: task.id });
// The integration test kills this process without close(), exercising WAL durability.
setInterval(() => {}, 1000);
