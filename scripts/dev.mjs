import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const python = process.platform === 'win32' ? 'studio/.venv/Scripts/python.exe' : 'studio/.venv/bin/python';
if (!existsSync(python)) { console.error('请先运行 npm run setup 安装工作台依赖。'); process.exit(1); }
const children = [
  spawn(python, ['-m', 'studio.server', '--reload'], { stdio: 'inherit' }),
  spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', 'studio/web', 'run', 'dev'], { stdio: 'inherit', detached: process.platform !== 'win32' }),
];
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const [i, child] of children.entries()) {
    try { if (i === 1 && process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* Already stopped. */ }
  }
  process.exitCode = code;
}
children.forEach(child => { child.on('error', err => { console.error(err.message); stop(1); }); child.on('exit', code => stop(code || 0)); });
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
