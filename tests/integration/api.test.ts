import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApi } from '../../src/api/server.js';
import { fixture } from '../helpers.js';

test('API is authenticated, rejects browser origins, validates input and supports durable events', async () => {
  const f = await fixture(); const server = createApi(f.service, 'test-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/projects`)).status, 401);
    assert.equal((await fetch(`${url}/projects`, { headers: { authorization: 'Bearer test-token', origin: 'https://attacker.invalid' } })).status, 403);
    const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json', 'idempotency-key': 'api-test' };
    assert.equal((await fetch(`${url}/tasks`, { method: 'POST', headers, body: '{}' })).status, 400);
    const response = await fetch(`${url}/tasks`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'fixture', request: 'Write a greeting' }) });
    assert.equal(response.status, 201);
    const task = await response.json() as { id: string; state: string };
    assert.equal(task.state, 'awaiting_mode');
    const events = await fetch(`${url}/tasks/${task.id}/events`, { headers });
    assert.equal((await events.json() as unknown[]).length, 1);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup();
  }
});
