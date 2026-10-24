const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const workspace = path.join(root, '.work', 'legacy-measurement');
const source = path.join(os.homedir(), 'Library', 'Application Support', 'start-everything', 'data');
const executable = path.resolve(root, '..', 'start-everything', 'dist', 'mac-arm64', 'START EVERYTHING.app', 'Contents', 'MacOS', 'START EVERYTHING');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function processTree(pid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,command='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
    if (!match) throw new Error(`Invalid ps row: ${line}`);
    return { pid: +match[1], ppid: +match[2], rssKiB: +match[3], cpuPercent: +match[4], command: match[5] };
  });
  const related = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (related.has(row.ppid) && !related.has(row.pid)) { related.add(row.pid); changed = true; }
  }
  return rows.filter(row => related.has(row.pid));
}

async function evaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Legacy renderer evaluation timed out')); }, 10000);
    let nextId = 2;
    const evaluateReady = () => socket.send(JSON.stringify({ id: nextId++, method: 'Runtime.evaluate', params: { expression: `document.readyState === 'complete' && typeof window.electronAPI !== 'undefined' ? ${expression} : null`, awaitPromise: true, returnByValue: true } }));
    const poll = setInterval(() => { if (socket.readyState === WebSocket.OPEN) evaluateReady(); }, 25);
    socket.addEventListener('close', () => clearInterval(poll));
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
      evaluateReady();
    });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Legacy debugger connection failed')); });
    socket.addEventListener('message', event => {
      const result = JSON.parse(event.data);
      if (result.method === 'Page.loadEventFired') { evaluateReady(); return; }
      if (!result.id || result.id === 1) return;
      if (result.error?.message === 'Execution context was destroyed.') return;
      if (!result.error && !result.result.exceptionDetails && result.result.result.value === null) return;
      clearTimeout(timer);
      socket.close();
      if (result.error || result.result.exceptionDetails) return reject(new Error(JSON.stringify(result)));
      resolve(result.result.result.value);
    });
  });
}

(async () => {
  fs.mkdirSync(workspace, { recursive: true });
  const measurements = [];
  for (let index = 0; index < 3; index++) {
    const directory = path.join(workspace, `run-${index}`);
    const data = path.join(directory, 'data');
    fs.mkdirSync(data, { recursive: true });
    for (const name of ['projects.json', 'schedules.json', 'settings.json', 'schedule-logs.json']) fs.copyFileSync(path.join(source, name), path.join(data, name));
    const schedules = JSON.parse(fs.readFileSync(path.join(data, 'schedules.json'), 'utf8'));
    for (const schedule of schedules) schedule.enabled = false;
    fs.writeFileSync(path.join(data, 'schedules.json'), JSON.stringify(schedules));
    const settings = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
    settings.globalShortcut = '';
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(settings));
    const activePort = path.join(directory, 'DevToolsActivePort');
    if (fs.existsSync(activePort)) fs.unlinkSync(activePort);
    const output = fs.openSync(path.join(directory, 'process.log'), 'w');
    const env = { ...process.env, NODE_ENV: 'production' };
    delete env.ELECTRON_RUN_AS_NODE;
    const begin = performance.now();
    const child = spawn(executable, [`--user-data-dir=${directory}`, '--remote-debugging-port=0'], { cwd: root, env, stdio: ['ignore', output, output] });
    try {
      const deadline = performance.now() + 30000;
      let target;
      while (!target) {
        if (child.exitCode !== null) throw new Error(`Legacy app exited ${child.exitCode}`);
        if (performance.now() > deadline) throw new Error('Legacy startup timed out');
        if (fs.existsSync(activePort)) {
          const port = fs.readFileSync(activePort, 'utf8').split('\n')[0];
          const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
          target = targets.find(item => item.type === 'page' && item.url.includes('index.html'));
        }
        if (!target) await wait(25);
      }
      const ready = await evaluate(target, '(async()=>{const result=await window.electronAPI.getProjects();return {count:result.data.length,domReady:document.readyState,loadMs:performance.now()};})()');
      const launchToReadyMs = performance.now() - begin;
      if (ready.count !== 35) throw new Error(`Legacy data count ${ready.count}`);
      await wait(2000);
      const processes = processTree(child.pid);
      measurements.push({ launchToReadyMs, projects: ready.count, rendererReadyMs: ready.loadMs, totalRssKiB: processes.reduce((sum, row) => sum + row.rssKiB, 0), processes });
    } finally {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(5000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      fs.closeSync(output);
    }
    await wait(500);
  }
  fs.writeFileSync(path.join(workspace, 'report.json'), JSON.stringify({ measurements }, null, 2));
  console.log(JSON.stringify({ measurements }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
