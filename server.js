#!/usr/bin/env node
'use strict';
// Agent Memory Desk: a local-only web page for the memory and instruction files of your coding agents.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { scan, readFile, homes, CLAUDE_INDEX, MEMORY_FILE, MAX_READ } = require('./lib/scan');

// The page and its two assets are the only static files; anything else is a 404.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
// No inline script or style anywhere, so the page can forbid both.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Opens a folder in the system file manager; with a file, selects it where the platform allows.
function reveal(target) {
  const { spawn } = require('child_process');
  let isFile = false;
  try { isFile = fs.statSync(target).isFile(); } catch {
    target = path.dirname(target);
    if (!fs.existsSync(target)) throw fail(404, 'folder not found');
  }
  const [cmd, args] =
    process.platform === 'win32' ? ['explorer.exe', [isFile ? '/select,' + target : target]]
    : process.platform === 'darwin' ? ['open', isFile ? ['-R', target] : [target]]
    : ['xdg-open', [isFile ? path.dirname(target) : target]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  return { opened: target };
}

function front(content, key) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = m && m[1].match(new RegExp('^\\s*' + key + ':\\s*(.*)$', 'm'));
  return line ? line[1].trim().replace(/^(["'])(.*)\1$/, '$2') : '';
}

const fail = (status, message) => Object.assign(new Error(message), { status });

function body(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(fail(413, 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(fail(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function createServer({ port = 7717, env = process.env, trash, onShutdown } = {}) {
  // One trash folder for every agent and project, inside the app folder by default so it is easy to find.
  const trashDir = path.resolve(trash || env.AGENT_MEMORY_TRASH || path.join(__dirname, 'trash'));

  // Every write is checked against a fresh scan, so the page can only touch files this server would list.
  function findFile(id) {
    for (const p of scan(env).places) {
      const f = p.files.find((x) => x.id === id);
      if (f) return { place: p, file: f };
    }
    throw fail(404, 'unknown file');
  }
  function findPlace(id) {
    const p = scan(env).places.find((x) => x.id === id);
    if (!p) throw fail(404, 'unknown place');
    return p;
  }

  function addIndexLine(memDir, file, content) {
    const indexPath = path.join(memDir, CLAUDE_INDEX);
    const index = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
    if (index.includes('](' + file + ')')) return;
    const title = front(content, 'name') || file.replace(/\.md$/, '');
    const hook = front(content, 'description');
    const line = '- [' + title + '](' + file + ')' + (hook ? ' — ' + hook : '');
    fs.writeFileSync(indexPath, index + (index && !index.endsWith('\n') ? '\n' : '') + line + '\n', 'utf8');
  }

  // Trash items are the .md copies under trashDir; ids are their paths relative to it.
  function trashItems() {
    const out = [];
    let folders = [];
    try { folders = fs.readdirSync(trashDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
    for (const folder of folders) {
      for (const f of fs.readdirSync(path.join(trashDir, folder))) {
        if (f.endsWith('.md')) out.push(trashItem(Buffer.from(folder + '/' + f, 'utf8').toString('base64url')));
      }
    }
    return out.sort((a, b) => b.trashedAt - a.trashedAt);
  }
  function trashItem(id) {
    const rel = Buffer.from(id, 'base64url').toString('utf8');
    const parts = rel.split('/');
    if (parts.length !== 2 || parts.some((p) => !p || p.startsWith('.') || /[\\/:]/.test(p)) || !parts[1].endsWith('.md')) throw fail(404, 'unknown trash item');
    const kept = path.join(trashDir, parts[0], parts[1]);
    if (!fs.existsSync(kept)) throw fail(404, 'unknown trash item');
    let note = {};
    try { note = JSON.parse(fs.readFileSync(kept + '.json', 'utf8')); } catch { /* no note */ }
    const stamp = Number(parts[1].split('-')[0]);
    const name = parts[1].replace(/^\d+-/, '');
    // Files trashed without a note (older versions) sit in a folder named after the Claude Code project.
    if (!note.original) {
      const memDir = path.join(homes(env).claude, 'projects', parts[0], 'memory');
      if (fs.existsSync(path.dirname(memDir))) note = { original: path.join(memDir, name), harnesses: ['claude'], indexIn: memDir };
    }
    return {
      id,
      kept,
      name,
      original: note.original || null,
      place: note.place || parts[0],
      harnesses: note.harnesses || [],
      indexIn: note.indexIn || null,
      trashedAt: note.trashedAt || stamp || fs.statSync(kept).mtimeMs,
      content: fs.readFileSync(kept, 'utf8'),
    };
  }
  function dropTrash(item) {
    fs.unlinkSync(item.kept);
    try { fs.unlinkSync(item.kept + '.json'); } catch { /* no note */ }
  }

  async function route(req) {
    // Only this machine's own page may talk to the server (blocks DNS rebinding and cross-site writes).
    const hosts = ['127.0.0.1:' + port, 'localhost:' + port];
    if (!hosts.includes(req.headers.host)) throw fail(403, 'bad host');
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && !hosts.includes(origin.replace(/^http:\/\//, ''))) throw fail(403, 'bad origin');
      if (req.method !== 'DELETE' && !/^application\/json/.test(req.headers['content-type'] || '')) throw fail(415, 'JSON only');
    }

    const pathname = new URL(req.url, 'http://x').pathname;
    if (req.method === 'GET' && STATIC[pathname]) {
      const [name, type] = STATIC[pathname];
      return { asset: fs.readFileSync(path.join(__dirname, 'public', name)), type };
    }
    const seg = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (seg[0] !== 'api') throw fail(404, 'not found');

    // GET /api/places
    if (seg[1] === 'places' && seg.length === 2 && req.method === 'GET') {
      const out = scan(env);
      for (const p of out.places) delete p.files;
      return out;
    }

    // GET /api/places/:id  (with file contents)
    if (seg[1] === 'places' && seg.length === 3 && req.method === 'GET') {
      const p = findPlace(seg[2]);
      for (const f of p.files) {
        f.content = readFile(f);
        if (f.content === null) f.tooLarge = true;
      }
      return p;
    }

    // POST /api/places/:id/memories  {file, content}: a new Claude Code memory.
    if (seg[1] === 'places' && seg[3] === 'memories' && seg.length === 4 && req.method === 'POST') {
      const p = findPlace(seg[2]);
      if (!p.claudeMemory) throw fail(400, 'this place has no Claude Code memory folder');
      const data = await body(req, MAX_READ);
      if (typeof data.content !== 'string' || !MEMORY_FILE.test(data.file || '') || data.file === CLAUDE_INDEX) {
        throw fail(400, 'bad memory');
      }
      const target = path.join(p.claudeMemory.dir, data.file);
      if (fs.existsSync(target)) throw fail(409, 'file already exists');
      fs.mkdirSync(p.claudeMemory.dir, { recursive: true });
      fs.writeFileSync(target, data.content, 'utf8');
      addIndexLine(p.claudeMemory.dir, data.file, data.content);
      return { id: Buffer.from(target, 'utf8').toString('base64url') };
    }

    // POST /api/files/:id/reveal: show the file in the file manager.
    if (seg[1] === 'files' && seg[3] === 'reveal' && seg.length === 4 && req.method === 'POST') {
      return reveal(findFile(seg[2]).file.path);
    }

    // POST /api/places/:id/reveal  {harness}: open the project folder, or the harness's home folder for Global.
    if (seg[1] === 'places' && seg[3] === 'reveal' && seg.length === 4 && req.method === 'POST') {
      const p = findPlace(seg[2]);
      const data = await body(req, 1024);
      // Claude Code keeps project memories outside the project, under its own home folder.
      if (p.kind !== 'global') return reveal(data.harness === 'claude' && p.claudeMemory ? p.claudeMemory.dir : p.path);
      const home = p.homes[data.harness];
      if (!home) throw fail(400, 'unknown harness');
      return reveal(home);
    }

    // PUT /api/files/:id  {content}
    if (seg[1] === 'files' && seg.length === 3 && req.method === 'PUT') {
      const { file } = findFile(seg[2]);
      if (file.size > MAX_READ) throw fail(400, 'file too large to edit here');
      const data = await body(req, MAX_READ);
      if (typeof data.content !== 'string') throw fail(400, 'content required');
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.path, data.content, 'utf8');
      return { saved: true };
    }

    // DELETE /api/files/:id: moves a memory to the trash folder and drops its index line.
    if (seg[1] === 'files' && seg.length === 3 && req.method === 'DELETE') {
      const { place, file } = findFile(seg[2]);
      if (!file.deletable || !file.exists) throw fail(400, 'this file cannot be moved to the trash here');
      const bin = path.join(trashDir, place.claudeMemory && file.group === 'memory' ? place.claudeMemory.folder : 'global');
      fs.mkdirSync(bin, { recursive: true });
      const kept = path.join(bin, Date.now() + '-' + path.basename(file.path));
      fs.copyFileSync(file.path, kept);
      // A note beside the copy says where it came from, so the trash can put it back.
      fs.writeFileSync(kept + '.json', JSON.stringify({
        original: file.path,
        place: place.kind === 'global' ? 'Global' : place.name,
        harnesses: file.harnesses,
        indexIn: file.group === 'memory' && place.claudeMemory ? place.claudeMemory.dir : null,
        trashedAt: Date.now(),
      }, null, 2), 'utf8');
      fs.unlinkSync(file.path);
      if (file.group === 'memory' && place.claudeMemory) {
        const indexPath = path.join(place.claudeMemory.dir, CLAUDE_INDEX);
        const name = path.basename(file.path);
        if (fs.existsSync(indexPath)) {
          const lines = fs.readFileSync(indexPath, 'utf8').split('\n');
          fs.writeFileSync(indexPath, lines.filter((l) => !l.includes('](' + name + ')')).join('\n'), 'utf8');
        }
      }
      return { trashed: kept };
    }

    // POST /api/shutdown: used by `agent-memory-desk stop`. Browsers cannot send this header from another
    // site without a preflight this server never answers, so only local programs can stop it.
    if (seg[1] === 'shutdown' && seg.length === 2 && req.method === 'POST') {
      if (req.headers['x-agent-memory-desk'] !== 'cli' || !onShutdown) throw fail(403, 'not allowed');
      setTimeout(onShutdown, 50);
      return { stopping: true };
    }

    // ---- Trash ----
    if (seg[1] === 'trash' && seg.length === 2 && req.method === 'GET') return { dir: trashDir, items: trashItems() };
    if (seg[1] === 'trash' && seg.length === 2 && req.method === 'DELETE') {
      const items = trashItems();
      for (const item of items) dropTrash(item);
      return { deleted: items.length };
    }
    if (seg[1] === 'trash' && seg.length === 4 && seg[3] === 'restore' && req.method === 'POST') {
      const item = trashItem(seg[2]);
      if (!item.original || !path.isAbsolute(item.original) || !item.original.endsWith('.md')) {
        throw fail(400, 'this file has no record of where it came from');
      }
      if (fs.existsSync(item.original)) throw fail(409, 'a file already exists at ' + item.original);
      fs.mkdirSync(path.dirname(item.original), { recursive: true });
      fs.copyFileSync(item.kept, item.original);
      if (item.indexIn) addIndexLine(item.indexIn, path.basename(item.original), fs.readFileSync(item.kept, 'utf8'));
      dropTrash(item);
      return { restored: item.original };
    }
    if (seg[1] === 'trash' && seg.length === 3 && req.method === 'DELETE') {
      dropTrash(trashItem(seg[2]));
      return { deleted: 1 };
    }

    throw fail(404, 'not found');
  }

  return http.createServer((req, res) => {
    route(req)
      .then((out) => {
        const asset = !!out.asset;
        res.writeHead(200, {
          'Content-Type': asset ? out.type : 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...(asset ? { 'Content-Security-Policy': CSP } : {}),
        });
        res.end(asset ? out.asset : JSON.stringify(out));
      })
      .catch((err) => {
        res.writeHead(err.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.status ? err.message : 'server error: ' + err.message }));
      });
  });
}

module.exports = { createServer };

if (require.main === module) {
  const flag = (name) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : undefined; };
  const port = Number(flag('port') || process.env.PORT) || 7717;
  const trash = flag('trash');
  createServer({ port, trash, onShutdown: () => process.exit(0) }).listen(port, '127.0.0.1', () => {
    console.log('Agent Memory Desk: http://localhost:' + port + (trash ? '  (trash: ' + path.resolve(trash) + ')' : ''));
  });
}
