/**
 * start.js  —  MailBlast dev launcher
 * Starts BOTH the frontend HTTP server (port 3000) and the local API (port 3001)
 * in a single terminal with colour-coded output.
 * Run: node start.js
 */
'use strict';

const { spawn } = require('child_process');
const path      = require('path');

const ROOT = __dirname;

const services = [
  {
    name:  'FRONTEND',
    color: '\x1b[36m',  // cyan
    cmd:   'node',
    args:  [path.join(ROOT, 'scripts', 'serve-frontend.js')],
    cwd:   ROOT,
  },
  {
    name:  'API     ',
    color: '\x1b[35m',  // magenta
    cmd:   'node',
    args:  [path.join(ROOT, 'lambda', 'local-server.js')],
    cwd:   ROOT,
  },
];

const reset = '\x1b[0m';

console.log('\x1b[32m');
console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║               MailBlast Dev Mode                        ║');
console.log('╠══════════════════════════════════════════════════════════╣');
console.log('║  Frontend   →  http://localhost:3000                    ║');
console.log('║  API        →  http://localhost:3001                    ║');
console.log('║                                                          ║');
console.log('║  Settings → API Endpoint: http://localhost:3001         ║');
console.log('║  Press Ctrl+C to stop both servers                      ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log('\x1b[0m');

const procs = services.map(svc => {
  const proc = spawn(svc.cmd, svc.args, { cwd: svc.cwd });
  const prefix = `${svc.color}[${svc.name}]${reset} `;

  proc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => console.log(prefix + l)));
  proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => console.error(prefix + l)));
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`${prefix}exited with code ${code}`);
  });
  return proc;
});

process.on('SIGINT',  () => { procs.forEach(p => p.kill()); process.exit(0); });
process.on('SIGTERM', () => { procs.forEach(p => p.kill()); process.exit(0); });
