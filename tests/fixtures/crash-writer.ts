import { Store } from '../../src/persistence/store.js';
const store = await Store.open(process.argv[2]!);
const task = await store.createTask({ projectId: 'fixture', request: 'Survive a process crash' }, 'crash-test');
process.send?.({ id: task.id });
// The integration test kills this process without close(), exercising WAL durability.
setInterval(() => {}, 1000);
