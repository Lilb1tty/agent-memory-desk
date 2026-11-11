#!/usr/bin/env node
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const autostart = require('../lib/autostart');

const HELP = `Agent Memory Desk: one page for the memory and instruction files of your coding agents.

Usage: agent-memory-desk <command> [options]

Commands
  start       Run the desk in this terminal (Ctrl+C to stop)
  install     Start the desk at login, and start it now
  uninstall   Stop starting at login, and stop the running desk
  stop        Stop the running desk
  status      Show whether it is installed and running
  open        Open the desk in your browser

Options
  --port <n>       Port to use (default 7717)
  --trash <dir>    Folder for trashed memories (default: trash/ in the app folder)
  --dry-run        install/uninstall: print what would change, change nothing
`;

function parse(argv) {
  const out = { command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help', port: Number(process.env.PORT) || 7717, trash: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--trash') {
      // PowerShell and cmd do not expand ~, so do it here.
      const t = argv[++i] || '';
      out.trash = path.resolve(/^~([\\/]|$)/.test(t) ? path.join(require('os').homedir(), t.slice(1)) : t);
    }
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') out.command = 'help';
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) fail('--port needs a number from 1 to 65535');
  return out;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const url = (port) => 'http://localhost:' + port;

async function running(port) {
  try {
    const res = await fetch(url(port) + '/api/trash', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Any program answering on the port, not just this desk.
function portBusy(port) {
  return new Promise((resolve) => {
    const s = require('net').connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function stop(port) {
  try {
    await fetch(url(port) + '/api/shutdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Memory-Desk': 'cli' },
      body: '{}',
      signal: AbortSignal.timeout(1500),
    });
  } catch { /* not running */ }
  for (let i = 0; i < 20 && (await running(port)); i++) await new Promise((r) => setTimeout(r, 100));
  return !(await running(port));
}

function openBrowser(port) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url(port)]]
    : process.platform === 'darwin' ? ['open', [url(port)]] : ['xdg-open', [url(port)]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

async function main() {
  const o = parse(process.argv.slice(2));
  const known = autostart.installed();
  // Commands that talk to a running desk default to the installed port.
  const portGiven = process.argv.includes('--port');
  const port = portGiven ? o.port : (known && known.port) || o.port;

  switch (o.command) {
    case 'start': {
      const { createServer } = require('../server.js');
      createServer({ port: o.port, trash: o.trash || undefined, onShutdown: () => process.exit(0) })
        .on('error', (err) => fail(err.code === 'EADDRINUSE' ? 'Port ' + o.port + ' is already in use. Try --port.' : err.message))
        .listen(o.port, '127.0.0.1', () => console.log('Agent Memory Desk: ' + url(o.port) + '  (Ctrl+C to stop)'));
      return;
    }
    case 'install': {
      const p = autostart.plan({ port: o.port, trash: o.trash });
      if (o.dryRun) {
        console.log('Would write ' + p.file + ':\n\n' + p.content);
        for (const [cmd, args] of p.load) console.log('Would run: ' + cmd + ' ' + args.join(' '));
        return;
      }
      // Check the port before touching the running desk, so a failed install leaves it running.
      const ours = known && known.port === o.port && (await running(o.port));
      if (!ours && (await portBusy(o.port))) fail('Port ' + o.port + ' is already in use. Stop that program or pick another with --port.');
      if (known) await stop(known.port || o.port);
      autostart.install({ port: o.port, trash: o.trash });
      for (let i = 0; i < 30 && !(await running(o.port)); i++) await new Promise((r) => setTimeout(r, 100));
      console.log('Installed: ' + p.file);
      console.log((await running(o.port)) ? 'Running on ' + url(o.port) : 'Installed, but the desk did not answer yet. Check with: agent-memory-desk status');
      return;
    }
    case 'uninstall': {
      if (!known) return console.log('Not installed.');
      if (o.dryRun) return console.log('Would stop the desk on ' + url(port) + ' and delete ' + known.file);
      autostart.uninstall({ port });
      await stop(port);
      console.log('Removed ' + known.file + ' and stopped the desk.');
      return;
    }
    case 'stop':
      console.log((await stop(port)) ? 'Stopped (or was not running) on ' + url(port) : 'Could not stop the desk on ' + url(port));
      return;
    case 'status': {
      const up = await running(port);
      console.log('Start at login: ' + (known ? 'yes (' + known.file + ')' : 'no'));
      console.log('Running:        ' + (up ? 'yes, ' + url(port) : 'no (checked ' + url(port) + ')'));
      return;
    }
    case 'open':
      if (!(await running(port))) fail('The desk is not running on ' + url(port) + '. Start it with: agent-memory-desk start');
      openBrowser(port);
      return;
    case 'help':
      console.log(HELP);
      return;
    default:
      fail('Unknown command: ' + o.command + '\n\n' + HELP);
  }
}

main().catch((err) => fail(err.message));
