#!/usr/bin/env node
// Runs every *.test.js in this directory and aggregates the results.
// Each suite is a standalone script that prints "N passed, M failed" and
// exits non-zero on failure, so they can also be run individually:
//   node test/worker.test.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const suites = fs.readdirSync(dir)
  .filter(f => f.endsWith('.test.js'))
  .sort();

if (suites.length === 0) {
  console.error('No test suites found.');
  process.exit(1);
}

let totalPass = 0;
let totalFail = 0;
const failed = [];

for (const suite of suites) {
  const res = spawnSync(process.execPath, [path.join(dir, suite)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const out = (res.stdout || '') + (res.stderr || '');

  const m = out.match(/(\d+) passed, (\d+) failed/);
  const pass = m ? Number(m[1]) : 0;
  const fail = m ? Number(m[2]) : 0;
  totalPass += pass;
  totalFail += fail;

  const ok = res.status === 0 && fail === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${suite}  (${pass} passed, ${fail} failed)`);

  if (!ok) {
    failed.push(suite);
    // Surface only the failing lines plus any crash output — full logs on
    // every run would bury the signal.
    for (const line of out.split('\n')) {
      if (/FAIL|Error|error:|throw|at /.test(line)) console.log('      ' + line.trim());
    }
  }
}

console.log('-'.repeat(52));
console.log(`${totalPass} passed, ${totalFail} failed, ${suites.length} suites`);
if (failed.length) {
  console.log('Failing suites: ' + failed.join(', '));
  process.exit(1);
}
