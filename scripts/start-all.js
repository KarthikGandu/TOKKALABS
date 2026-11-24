// One command: launches the three independent services as separate processes.
const { spawn } = require('child_process');
const path = require('path');

const services = ['alpaca', 'issuer', 'ap'];
const children = services.map((name) => {
  const c = spawn(process.execPath, [path.join(__dirname, '..', 'services', name, 'server.js')], { stdio: 'inherit' });
  c.on('exit', (code) => { if (code) { console.error(`[start] ${name} exited ${code}`); shutdown(1); } });
  return c;
});
function shutdown(code = 0) { children.forEach((c) => c.kill()); process.exit(code); }
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
