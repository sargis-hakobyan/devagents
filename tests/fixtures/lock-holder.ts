import { lockService } from '../../src/persistence/service-lock.js';
await lockService(process.argv[2]!); process.send?.('locked'); setInterval(() => {}, 1000);
