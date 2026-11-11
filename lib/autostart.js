'use strict';
// Start-at-login for Windows (a hidden launcher in the Startup folder), macOS (launchd) and Linux (systemd user service).
// Every platform keeps its settings in that one file, so there is nothing else to clean up.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const NAME = 'agent-memory-desk';
const SERVER = path.join(__dirname, '..', 'server.js');

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const vbs = (s) => String(s).replace(/"/g, '""');
const sd = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

function args({ port, trash }) {
  return [SERVER, '--port', String(port), ...(trash ? ['--trash', trash] : [])];
}

// Where the entry lives and what it contains, per platform. `run` lists the commands that load or unload it.
function plan(opts, platform = process.platform, home = os.homedir()) {
  const node = opts.node || process.execPath;
  const a = args(opts);
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const file = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', NAME + '.vbs');
    const line = [node, ...a].map((x) => '""' + vbs(x) + '""').join(' ');
    return {
      file,
      content: "' Starts Agent Memory Desk at sign-in with no console window. Remove with: agent-memory-desk uninstall\r\n" +
        'CreateObject("WScript.Shell").Run "' + line + '", 0, False\r\n',
      load: [], unload: [],
    };
  }
  if (platform === 'darwin') {
    const file = path.join(home, 'Library', 'LaunchAgents', 'com.' + NAME + '.plist');
    const log = path.join(home, 'Library', 'Logs', NAME + '.log');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>', '  <string>com.' + NAME + '</string>',
      '  <key>ProgramArguments</key>', '  <array>',
      ...[node, ...a].map((x) => '    <string>' + xml(x) + '</string>'),
      '  </array>',
      '  <key>WorkingDirectory</key>', '  <string>' + xml(path.dirname(SERVER)) + '</string>',
      '  <key>RunAtLoad</key>', '  <true/>',
      '  <key>KeepAlive</key>', '  <dict><key>SuccessfulExit</key><false/></dict>',
      '  <key>StandardOutPath</key>', '  <string>' + xml(log) + '</string>',
      '  <key>StandardErrorPath</key>', '  <string>' + xml(log) + '</string>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
    return {
      file, content, log,
      load: [['launchctl', ['bootout', 'gui/' + uid, file], true], ['launchctl', ['bootstrap', 'gui/' + uid, file]]],
      unload: [['launchctl', ['bootout', 'gui/' + uid, file], true]],
    };
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const file = path.join(config, 'systemd', 'user', NAME + '.service');
  const content = [
    '[Unit]',
    'Description=Agent Memory Desk on http://localhost:' + opts.port,
    '',
    '[Service]',
    'WorkingDirectory=' + path.dirname(SERVER),
    'ExecStart=' + [node, ...a].map(sd).join(' '),
    'Restart=on-failure',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
  return {
    file, content,
    load: [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', '--now', NAME + '.service']]],
    unload: [['systemctl', ['--user', 'disable', '--now', NAME + '.service'], true], ['systemctl', ['--user', 'daemon-reload'], true]],
  };
}

function run(steps) {
  for (const [cmd, argv, mayFail] of steps) {
    const r = spawnSync(cmd, argv, { stdio: 'inherit' });
    if ((r.error || r.status !== 0) && !mayFail) throw new Error(cmd + ' ' + argv.join(' ') + ' failed');
  }
}

// Windows has no service manager step, so the server is started by hand right after installing.
function startDetached(opts) {
  spawn(opts.node || process.execPath, args(opts), { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(SERVER) }).unref();
}

function install(opts) {
  const p = plan(opts);
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  if (p.log) fs.mkdirSync(path.dirname(p.log), { recursive: true });
  fs.writeFileSync(p.file, p.content, 'utf8');
  run(p.load);
  if (process.platform === 'win32') startDetached(opts);
  return p;
}

function uninstall(opts) {
  const p = plan(opts);
  if (!fs.existsSync(p.file)) return null;
  run(p.unload);
  fs.unlinkSync(p.file);
  return p;
}

// Reads the port and trash folder back out of the installed entry.
function installed() {
  const p = plan({ port: 0 });
  if (!fs.existsSync(p.file)) return null;
  const text = fs.readFileSync(p.file, 'utf8');
  const port = (text.match(/--port\D+(\d+)/) || [])[1];
  return { file: p.file, port: port ? Number(port) : null };
}

module.exports = { plan, install, uninstall, installed, NAME };
