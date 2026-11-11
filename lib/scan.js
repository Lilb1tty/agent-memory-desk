'use strict';
// Finds every memory and instruction file the supported coding agents read, grouped into places:
// one "Global" place for the files that apply everywhere, and one place per project folder.
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_READ = 2 * 1024 * 1024;
const CLAUDE_INDEX = 'MEMORY.md';
const MEMORY_FILE = /^(?!\.)[A-Za-z0-9._-]+\.md$/;

function homes(env = process.env) {
  const home = env.AGENT_MEMORY_HOME || os.homedir();
  return {
    home,
    claude: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    codex: env.CODEX_HOME || path.join(home, '.codex'),
    kimi: path.join(home, '.kimi-code'),
    dsh: env.DSH_HOME || path.join(home, '.dsh'),
    opencode: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode'),
    opencodeData: path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode'),
    agents: path.join(home, '.agents'),
  };
}

// What each harness reads. `create` marks the one global file offered for creation when it is missing.
const HARNESSES = [
  {
    id: 'claude',
    label: 'Claude Code',
    home: (h) => h.claude,
    global: (h) => [{ file: path.join(h.claude, 'CLAUDE.md'), create: true, note: 'Claude Code loads this file in every session, in every project.' }],
    project: ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'],
  },
  {
    id: 'codex',
    label: 'Codex',
    home: (h) => h.codex,
    global: (h) => [
      { file: path.join(h.codex, 'AGENTS.md'), create: true, note: 'Codex loads this file in every session, in every project.' },
      { file: path.join(h.codex, 'AGENTS.override.md'), note: 'Codex reads this instead of AGENTS.md when it exists.' },
      ...['MEMORY.md', 'memory_summary.md', 'raw_memories.md'].map((f) => ({
        file: path.join(h.codex, 'memories', f),
        group: 'memory',
        note: 'Written by Codex memories. Codex may rewrite this file when it next consolidates what it learned.',
      })),
    ],
    project: ['AGENTS.md', 'AGENTS.override.md'],
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    home: (h) => h.kimi,
    global: (h) => [
      { file: path.join(h.kimi, 'AGENTS.md'), create: true, note: 'Kimi Code loads this file in every session, in every project.' },
      { file: path.join(h.agents, 'AGENTS.md'), note: 'Shared agent instructions in ~/.agents, loaded by Kimi Code in every project.' },
    ],
    project: ['AGENTS.md', '.kimi-code/AGENTS.md'],
  },
  {
    id: 'dsh',
    label: 'DeepSeek dsh',
    home: (h) => h.dsh,
    global: (h) => [{ file: path.join(h.dsh, 'AGENTS.md'), create: true, note: 'dsh loads this file in every session, in every project.' }],
    project: ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    home: (h) => h.opencode,
    global: (h) => [{ file: path.join(h.opencode, 'AGENTS.md'), create: true, note: 'OpenCode loads this file in every session, in every project.' }],
    project: ['AGENTS.md'],
  },
];
const LABEL = Object.fromEntries(HARNESSES.map((x) => [x.id, x.label]));

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
// Windows and macOS folders are case-insensitive, so the same project can be recorded in different cases.
const keyOf = (p) => {
  const k = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'linux' ? k : k.toLowerCase();
};

// ---- Where each harness records the projects it has been used in ----

// Claude Code folder names are a lossy encoding of the path; session logs hold the real one.
function claudeCwd(dir) {
  try {
    const log = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
    if (!log) return null;
    const fd = fs.openSync(path.join(dir, log), 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse('"' + m[1] + '"') : null;
  } catch {
    return null;
  }
}

function claudeProjects(h) {
  const root = path.join(h.claude, 'projects');
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none */ }
  return names.map((name) => ({ folder: name, cwd: claudeCwd(path.join(root, name)), memDir: path.join(root, name, 'memory') }));
}

function codexProjects(h) {
  let text = '';
  try { text = fs.readFileSync(path.join(h.codex, 'config.toml'), 'utf8'); } catch { return []; }
  const out = [];
  for (const m of text.matchAll(/^\[projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\]/gm)) {
    try { out.push(m[1] !== undefined ? JSON.parse('"' + m[1] + '"') : m[2]); } catch { /* skip */ }
  }
  return out;
}

function kimiProjects(h) {
  const data = readJson(path.join(h.kimi, 'workspaces.json'));
  return Object.values((data && data.workspaces) || {}).map((w) => w && w.root).filter(Boolean);
}

function dshProjects(h) {
  const data = readJson(path.join(h.dsh, 'storages', 'workspace.json'));
  return Object.values((data && data.tables && data.tables.workspaces) || {}).map((w) => w && w.path).filter(Boolean);
}

function opencodeProjects(h) {
  const dir = path.join(h.opencodeData, 'storage', 'project');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => readJson(path.join(dir, f))).map((p) => p && p.worktree).filter((p) => p && p !== '/');
}

// ---- Files ----

function fileInfo(abs, extra) {
  let stat = null;
  try { stat = fs.statSync(abs); if (!stat.isFile()) return null; } catch { /* missing */ }
  return {
    id: b64(abs),
    path: abs,
    exists: !!stat,
    size: stat ? stat.size : 0,
    mtime: stat ? stat.mtimeMs : 0,
    group: 'instructions',
    deletable: false,
    ...extra,
  };
}

function scan(env = process.env) {
  const h = homes(env);
  const found = HARNESSES.filter((x) => isDir(x.home(h))).map((x) => x.id);
  const readers = (name) => {
    const all = HARNESSES.filter((x) => x.project.includes(name)).map((x) => x.id);
    const here = all.filter((id) => found.includes(id));
    return here.length ? here : all;
  };

  // Global place.
  const global = { id: 'global', kind: 'global', name: 'Global', path: 'Every project', files: [] };
  for (const x of HARNESSES) {
    if (!found.includes(x.id)) continue;
    for (const spec of x.global(h)) {
      const info = fileInfo(spec.file, {
        name: path.relative(h.home, spec.file).split(path.sep).join('/'),
        group: spec.group || 'instructions',
        harnesses: [x.id],
        note: spec.note,
      });
      if (info && (info.exists || spec.create)) global.files.push(info);
    }
  }
  const rules = path.join(h.claude, 'rules');
  for (const f of listMd(rules)) {
    global.files.push(fileInfo(path.join(rules, f), {
      name: '.claude/rules/' + f,
      group: 'rules',
      harnesses: ['claude'],
      deletable: true,
      note: 'A Claude Code rule, loaded in every project.',
    }));
  }

  // Project places, merged across harnesses by folder.
  const places = new Map();
  const place = (dir) => {
    const key = keyOf(dir);
    if (!places.has(key)) {
      places.set(key, { id: 'p-' + b64(key), kind: 'project', name: path.basename(dir) || dir, path: dir, seenBy: [], files: [] });
    }
    return places.get(key);
  };
  // Proper-case sources first: Codex stores lower-cased paths on Windows.
  const sources = [
    ['claude', claudeProjects(h).filter((c) => c.cwd).map((c) => c.cwd)],
    ['kimi', kimiProjects(h)],
    ['dsh', dshProjects(h)],
    ['opencode', opencodeProjects(h)],
    ['codex', codexProjects(h)],
  ];
  for (const [id, dirs] of sources) {
    for (const dir of dirs) {
      const p = place(dir);
      if (!p.seenBy.includes(id)) p.seenBy.push(id);
    }
  }

  // A project in the home folder would otherwise list the global files a second time.
  const globalKeys = new Set(global.files.map((f) => keyOf(f.path)));
  for (const p of places.values()) {
    if (!isDir(p.path)) { p.missing = true; continue; }
    const names = [...new Set(HARNESSES.flatMap((x) => x.project))];
    for (const name of names) {
      const abs = path.join(p.path, ...name.split('/'));
      if (globalKeys.has(keyOf(abs))) continue;
      const info = fileInfo(abs, {
        name,
        harnesses: readers(name),
        note: 'Read by ' + readers(name).map((id) => LABEL[id]).join(', ') + ' in every session in this project.',
      });
      if (info && info.exists) p.files.push(info);
    }
  }

  // Claude Code's own memory folders.
  for (const c of claudeProjects(h)) {
    const p = c.cwd ? place(c.cwd) : (places.get('claude:' + c.folder) || places.set('claude:' + c.folder,
      { id: 'c-' + b64(c.folder), kind: 'project', name: c.folder, path: c.folder, seenBy: ['claude'], files: [] }).get('claude:' + c.folder));
    p.claudeMemory = { dir: c.memDir, folder: c.folder };
    for (const f of listMd(c.memDir)) {
      const index = f === CLAUDE_INDEX;
      p.files.push(fileInfo(path.join(c.memDir, f), {
        name: f,
        group: 'memory',
        harnesses: ['claude'],
        index,
        deletable: !index,
        note: index
          ? 'Claude Code loads this index at the start of every session in this project. One line per memory.'
          : 'A Claude Code memory for this project.',
      }));
    }
  }

  const list = [global, ...[...places.values()].sort((a, b) => count(b) - count(a) || a.name.localeCompare(b.name))];
  for (const p of list) {
    p.count = count(p);
    p.counts = Object.fromEntries(found.map((id) => [id, p.files.filter((f) => f.exists && !f.index && f.harnesses.includes(id)).length]));
    p.homes = Object.fromEntries(HARNESSES.map((x) => [x.id, x.home(h)]));
  }
  return { home: h.home, found: found.map((id) => ({ id, label: LABEL[id] })), places: list };
}

function count(p) {
  return p.files.filter((f) => f.exists && !f.index).length;
}

function listMd(dir) {
  try { return fs.readdirSync(dir).filter((f) => MEMORY_FILE.test(f)).sort(); } catch { return []; }
}

function readFile(info) {
  if (!info.exists) return '';
  if (info.size > MAX_READ) return null;
  return fs.readFileSync(info.path, 'utf8');
}

module.exports = { scan, readFile, homes, HARNESSES, LABEL, CLAUDE_INDEX, MEMORY_FILE, MAX_READ };
