import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexValidator } from '../dist/engines/codex/validator.js';

const root = await mkdtemp(join(tmpdir(), 'devagents-proc-'));
const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: { PRIVATE_SENTINEL: 'outer-process-private-canary' }, stdio: 'ignore' });
try {
  const project = join(root, 'project'); await mkdir(project);
  const outside = join(root, 'private-canary'); await writeFile(outside, 'outer-process-private-canary');
  const code = `
    const fs=require('node:fs'),assert=require('node:assert/strict');
    assert.ok(process.memoryUsage().heapUsed>0);
    for(const pid of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){
      let env;try{env=fs.readFileSync('/proc/'+pid+'/environ','utf8')}catch{continue}
      assert.ok(!env.includes('outer-process-private-canary'));
    }
    assert.throws(()=>fs.readFileSync('/proc/1/root'+${JSON.stringify(outside)}));
    const child=require('node:child_process').fork('./worker.cjs');
    child.on('message',value=>{assert.ok(value>0);console.log('worker completed')});
    child.on('exit',code=>{assert.equal(code,0)});
  `;
  await writeFile(join(project, 'worker.cjs'), 'process.send(process.memoryUsage().heapUsed);process.disconnect();');
  const validator = new CodexValidator(join(root, 'data'));
  const result = await validator.execute(project, { executable: 'node', args: ['-e', code] }, new AbortController().signal, 15000, false);
  assert.equal(result.exitCode, 0, result.output); assert.match(result.output, /worker completed/);
  console.log('PASS: memoryUsage and worker completion work; private procfs hides outer process environment and root.');
} finally { sentinel.kill(); await rm(root, { recursive: true, force: true }); }
