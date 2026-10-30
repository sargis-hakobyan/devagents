import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const menu = resolve('scripts/select-option.sh');
test('plain terminal fallback accepts numbered input and does not emit cursor controls', async () => {
  const child = spawn('bash', [menu, 'Choose', 'Browser', 'Terminal', 'Later'], { env: { ...process.env, TERM: 'dumb' }, stdio: 'pipe' });
  let output = ''; let error = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
  child.stdin.end('wrong\n2\n');
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0); assert.equal(output, '2\n'); assert.match(error, /displayed numbers/); assert.doesNotMatch(error, /\x1b/);
});
