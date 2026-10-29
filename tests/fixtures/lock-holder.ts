import { lockService } from '../../src/persistence/service-lock.js';
lockService(process.argv[2]!); process.send?.('locked'); setInterval(() => {}, 1000);
