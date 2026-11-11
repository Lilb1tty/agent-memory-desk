'use strict';
const $ = (s) => document.querySelector(s);
const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
const TYPES = ['user', 'feedback', 'project', 'reference'];
const NEW_FILE = '---\nname: \ndescription: \nmetadata:\n  type: feedback\n---\n\n';
const GROUPS = { instructions: 'Instructions', rules: 'Rules', memory: 'Memories' };

// current: the open place with its files. file: the open file, null for a new memory, undefined when nothing is open.
// parts: the open file split into header block and text; null when it has no header block.
// harness: the agent picked in the tabs; the list shows only the files it reads.
// editing: false while a file is only being read; the Edit button turns it on.
let places = [], found = [], labels = {}, harness = '', current = null, file, parts = null, mode = 'fields', saved = '', editing = false;
const visible = () => current.files.filter((f) => f.harnesses.includes(harness));
const go = (h, id) => { if (location.hash.slice(1) !== h + '/' + id) history.replaceState(null, '', '#' + h + '/' + id); };

async function api(method, url, data) {
  const res = await fetch(url, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || res.statusText);
  return out;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---- Memory file format: a header block between --- lines, then the text. ----
function split(content) {
  const m = content.match(/^(---\n)([\s\S]*?)(\n---[ \t]*\n*)([\s\S]*)$/);
  return m ? { head: m[1], fm: m[2], sep: m[3], body: m[4] } : null;
}
function fmGet(fm, key) {
  const m = fm.match(new RegExp('^[ \\t]*' + key + ':[ \\t]*(.*)$', 'm'));
  if (!m) return '';
  const v = m[1].trim();
  if (v[0] === '"') { try { return JSON.parse(v); } catch { return v.replace(/^"|"$/g, ''); } }
  if (v.length > 1 && v[0] === "'" && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}
// Only the one line changes, so header keys this page does not know about survive a save.
function fmSet(fm, key, value) {
  const plain = /^[A-Za-z0-9][^:#"'\n]*$/.test(value) && value === value.trim();
  const text = plain || !value ? value : JSON.stringify(value);
  const line = new RegExp('^([ \\t]*' + key + ':)[ \\t]*.*$', 'm');
  if (line.test(fm)) return fm.replace(line, (_, k) => k + ' ' + text);
  if (key !== 'type') return key + ': ' + text + '\n' + fm;
  return /^metadata:[ \t]*$/m.test(fm)
    ? fm.replace(/^metadata:[ \t]*$/m, (k) => k + '\n  type: ' + text)
    : fm + '\nmetadata:\n  type: ' + text;
}
function meta(content) {
  const p = split((content || '').replace(/\r\n/g, '\n'));
  return p ? { name: fmGet(p.fm, 'name'), description: fmGet(p.fm, 'description'), type: fmGet(p.fm, 'type') } : {};
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const tone = (type) => (TYPES.includes(type) ? type : 'other');
const isMemory = (f) => f && f.group === 'memory' && f.harnesses.includes('claude') && !f.index;
const indexFile = () => current.files.find((f) => f.index);
const inIndex = (f) => { const i = indexFile(); return !!i && i.content.includes('](' + f.name + ')'); };

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function ago(ms) {
  const hours = (ms - Date.now()) / 36e5;
  if (Math.abs(hours) < 1) return 'just now';
  if (Math.abs(hours) < 24) return relative.format(Math.round(hours), 'hour');
  if (Math.abs(hours) < 24 * 30) return relative.format(Math.round(hours / 24), 'day');
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---- The open file ----
function compose() {
  if (mode === 'raw') return $('#raw').value;
  const want = {
    name: $('#fName').value.trim(),
    description: $('#fDesc').value.replace(/\s*\n\s*/g, ' ').trim(),
  };
  const picked = $('#types input:checked');
  if (picked) want.type = picked.value;
  let fm = parts.fm;
  for (const key in want) if (want[key] !== fmGet(parts.fm, key)) fm = fmSet(fm, key, want[key]);
  return parts.head + fm + parts.sep + $('#fBody').value;
}
const dirty = () => file !== undefined && compose() !== saved;
const leave = () => !dirty() || confirm('Discard unsaved changes?');

function fit(t) {
  if (t.offsetParent === null) return;
  // Collapsing to 'auto' shrinks the page for a moment and the browser clamps the scroll; put it back.
  const scroller = $('#scroll'), top = scroller.scrollTop;
  t.style.height = 'auto';
  t.style.height = t.scrollHeight + 'px';
  scroller.scrollTop = top;
}

function fillFields() {
  $('#fName').value = fmGet(parts.fm, 'name');
  $('#fDesc').value = fmGet(parts.fm, 'description');
  $('#fBody').value = parts.body;
  const type = fmGet(parts.fm, 'type');
  for (const r of document.querySelectorAll('#types input')) r.checked = r.value === type;
}

function setMode(next) {
  mode = next;
  const memory = file === null || isMemory(file);
  $('#fields').hidden = mode !== 'fields';
  $('#types').hidden = mode !== 'fields';
  $('#readers').hidden = mode === 'fields';
  $('#rawWrap').hidden = mode !== 'raw';
  $('#rawToggle').hidden = !memory;
  $('#rawToggle').textContent = mode === 'raw' ? 'Back to fields' : 'Edit raw file';
  $('#rawTitle').textContent = file ? file.name : 'Raw file';
  $('#rawNote').textContent = file ? file.note || '' : 'The whole file, header block included.';
}

// Everything that depends on what is typed: tone, caption, warnings, links, button states.
function refresh() {
  const content = compose();
  const now = file === null || isMemory(file) ? meta(content) : {};
  $('#scroll').dataset.type = tone(now.type);

  const caption = $('#caption');
  caption.replaceChildren();
  if (file) {
    caption.append(el('span', { textContent: file.path, title: file.path }));
    caption.append(el('span', { textContent: file.exists ? 'Edited ' + ago(file.mtime) : 'Not created yet. Saving creates it.' }));
  } else {
    caption.append(el('span', { textContent: slug(now.name || '') ? 'Saves as ' + slug(now.name) + '.md' : 'The name becomes the file name' }));
  }
  const readers = $('#readers');
  readers.replaceChildren(...(file ? file.harnesses : []).map((h) => el('span', { className: 'reader', textContent: labels[h] || h })));

  $('#orphan').hidden = !isMemory(file) || !file.exists || inIndex(file);

  const links = $('#links');
  const names = file === null || isMemory(file) ? [...new Set([...content.matchAll(/\[\[([^\]\n]+)\]\]/g)].map((m) => m[1].trim()))] : [];
  links.hidden = !names.length;
  links.replaceChildren();
  if (names.length) links.append('Links to');
  for (const name of names) {
    const target = current.files.find((f) => isMemory(f) && (f.meta.name === name || f.name === name + '.md'));
    if (target) {
      const b = el('button', { type: 'button', className: 'link', textContent: name });
      b.onclick = () => { if (leave()) show(target); };
      links.append(b);
    } else {
      links.append(el('span', { className: 'link link-missing', textContent: name + ', not written yet' }));
    }
  }

  const changed = content !== saved;
  const locked = !!(file && file.tooLarge);
  $('#state').textContent = locked ? 'Too large to edit here' : changed ? 'Unsaved changes' : '';
  $('#edit').hidden = editing || locked;
  $('#save').hidden = $('#revert').hidden = !editing;
  $('#save').disabled = !changed;
  $('#del').hidden = !file || !file.deletable;
  if (!editing) $('#rawToggle').hidden = true;
  $('#revealFile').hidden = !file;
  for (const id of ['#fDesc', '#fBody', '#raw']) fit($(id));
}

// Put a file on the page. f: a file of the open place, or null for a new memory.
function show(f) {
  file = f;
  const content = (f ? (f.tooLarge ? '(This file is larger than 2 MB. Open it in an editor.)' : f.content) : NEW_FILE).replace(/\r\n/g, '\n');
  parts = f === null || isMemory(f) ? split(content) : null;
  $('#none').hidden = true;
  $('#sheet').hidden = false;
  $('#raw').value = content;
  if (parts) fillFields();
  setMode(parts ? 'fields' : 'raw');
  saved = compose();
  // A new memory or a file that does not exist yet has nothing to read, so it opens ready to type.
  setEditing(f === null || !f.exists);
  renderList();
  $('#scroll').scrollTop = 0;
  if (f === null) $('#fName').focus();
}

function setEditing(on) {
  editing = on && !(file && file.tooLarge);
  for (const id of ['#fName', '#fDesc', '#fBody', '#raw']) $(id).readOnly = !editing;
  for (const r of document.querySelectorAll('#types input')) r.disabled = !editing;
  $('#sheet').classList.toggle('reading', !editing);
  if (editing) setMode(mode); // brings back the raw/fields toggle where it applies
  refresh();
}

function clearPage() {
  file = undefined;
  saved = '';
  $('#sheet').hidden = true;
  $('#none').hidden = false;
  $('#none').textContent = current.files.length
    ? 'Pick a file to read it.'
    : 'No agent has a memory or instruction file for this project yet.';
}

// ---- Lists ----
const total = (h) => places.reduce((n, p) => n + (p.counts[h] || 0), 0);
// Places the harness has files in, or (with the box ticked) has been used in.
function placesOf(h) {
  const showEmpty = $('#showEmpty').checked;
  return places.filter((p) => p.kind === 'global' || p.counts[h] ||
    (showEmpty && p.seenBy.includes(h)) || (current && current.id === p.id));
}

function renderPlaces() {
  const tabs = $('#harnesses');
  tabs.replaceChildren();
  for (const h of found) {
    const b = el('button', { type: 'button', className: 'harness', role: 'tab' },
      el('span', { textContent: h.label }), el('span', { textContent: total(h.id) }));
    b.setAttribute('aria-selected', String(h.id === harness));
    b.onclick = () => { if (h.id !== harness && leave()) pick(h.id).catch((err) => toast(err.message)); };
    tabs.append(b);
  }
  const list = $('#places');
  list.replaceChildren();
  for (const p of placesOf(harness)) {
    const where = p.kind === 'global' ? p.homes[harness] : p.path;
    const b = el('button', { type: 'button', className: 'proj', title: where },
      el('span', { className: 'pname', textContent: p.name }),
      el('span', { className: 'pcount', textContent: p.counts[harness] || 0 }),
      el('span', { className: 'ppath', textContent: where }));
    if (current && current.id === p.id) b.setAttribute('aria-current', 'true');
    b.onclick = () => { if (leave()) open(p.id).catch((err) => toast(err.message)); };
    list.append(el('li', { className: p.kind === 'global' ? 'global' : '' }, b));
  }
}

// Switch agent: stay on the same project when that agent has files there, else go to Global.
async function pick(h, placeId, fileId) {
  harness = h;
  const keep = placeId || (current && placesOf(h).some((p) => p.id === current.id && p.counts[h]) ? current.id : 'global');
  current = null;
  await open(keep, fileId);
}

function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const rows = $('#rows');
  rows.replaceChildren();
  const mine = visible();
  const shown = mine.filter((f) => !q || (f.name + '\n' + (f.content || '')).toLowerCase().includes(q));
  let group = '';
  for (const f of shown) {
    if (f.group !== group) {
      group = f.group;
      rows.append(el('p', { className: 'group', textContent: GROUPS[group] || group }));
    }
    const memory = isMemory(f);
    const others = f.harnesses.filter((h) => h !== harness).map((h) => labels[h] || h);
    const status = !f.exists
      ? el('span', { className: 'rwarn', textContent: 'Not created yet' })
      : memory && !inIndex(f)
      ? el('span', { className: 'rwarn', textContent: 'Not in the index' })
      : memory
      ? el('span', { className: 'rtype', textContent: f.meta.type || 'no type' })
      : el('span', { className: 'rtype', textContent: others.length ? 'Shared with ' + others.join(', ') : '' });
    const row = el('button', { type: 'button', className: 'row' + (f.exists ? '' : ' ghost') },
      el('span', { className: 'rname', textContent: memory ? f.meta.name || f.name : f.name }),
      el('span', { className: 'rdesc', textContent: memory ? f.meta.description || '' : f.note || '' }),
      el('span', { className: 'rmeta' }, status, el('span', { textContent: f.exists ? ago(f.mtime) : '' })));
    row.dataset.type = memory ? tone(f.meta.type) : 'other';
    if (f === file) row.setAttribute('aria-current', 'true');
    row.onclick = () => { if (leave()) show(f); };
    rows.append(row);
  }
  if (!shown.length) {
    rows.append(el('p', { className: 'note', textContent: mine.length
      ? 'No file matches. Clear the filter to see all ' + mine.length + '.'
      : (labels[harness] || harness) + ' has no memory or instruction file here yet.' }));
  }

  const idx = indexFile();
  if (idx) {
    const names = new Set(current.files.map((f) => f.name));
    const gone = [...idx.content.matchAll(/\]\(([^)\s]+\.md)\)/g)].map((m) => m[1]).filter((f) => !names.has(f));
    if (gone.length) {
      rows.append(el('p', { className: 'note', textContent:
        'The index lists ' + (gone.length === 1 ? 'a file that no longer exists: ' : 'files that no longer exist: ') +
        gone.join(', ') + '. Open MEMORY.md to remove ' + (gone.length === 1 ? 'that line.' : 'those lines.') }));
    }
  }
}

async function load() {
  const out = await api('GET', '/api/places');
  places = out.places;
  found = out.found;
  labels = Object.fromEntries(found.map((h) => [h.id, h.label]));
  if (!found.some((h) => h.id === harness)) harness = found[0] ? found[0].id : '';
  renderPlaces();
}

// Open a place and put one file on the page straight away.
async function open(id, fileId) {
  current = await api('GET', '/api/places/' + encodeURIComponent(id));
  const order = { instructions: 0, rules: 1, memory: 2 };
  current.files.sort((a, b) => order[a.group] - order[b.group] || (b.index ? 1 : 0) - (a.index ? 1 : 0) || (b.mtime - a.mtime));
  for (const f of current.files) f.meta = isMemory(f) ? meta(f.content) : {};
  go(harness, id);
  // The folder the memory files sit in: Claude Code keeps project memories in its own home folder.
  const memoryDir = harness === 'claude' && current.claudeMemory ? current.claudeMemory.dir : null;
  const where = current.kind === 'global' ? current.homes[harness] : memoryDir || current.path;
  $('#title').textContent = current.kind === 'global' ? 'Global' : current.name;
  $('#path').textContent = !memoryDir && current.missing ? where + ' (folder not found)' : where;
  $('#path').title = current.kind === 'global' ? '' : 'Project: ' + current.path;
  $('#openFolder').hidden = !memoryDir && !!current.missing;
  $('#newMemory').hidden = harness !== 'claude' || !current.claudeMemory;
  $('#search').value = '';
  renderPlaces();
  const mine = visible();
  const first = mine.find((f) => f.id === fileId) || mine.find((f) => f.exists && !f.index) || mine[0];
  if (first) show(first);
  else { clearPage(); renderList(); }
}

// ---- Actions ----
$('#sheet').onsubmit = async (e) => {
  e.preventDefault();
  const content = compose();
  try {
    let id;
    if (file === null) {
      const name = slug(meta(content).name || '');
      if (!name) { $('#fName').focus(); return toast('Name the memory first. The name becomes the file name.'); }
      id = (await api('POST', '/api/places/' + encodeURIComponent(current.id) + '/memories', { file: name + '.md', content })).id;
    } else {
      await api('PUT', '/api/files/' + encodeURIComponent(file.id), { content });
      id = file.id;
    }
    saved = content;
    toast('Saved');
    await load();
    await open(current.id, id);
  } catch (err) {
    toast(err.message === 'file already exists' ? 'A memory with that name already exists. Pick another name.' : err.message);
  }
};

$('#del').onclick = async () => {
  const extra = isMemory(file) ? ' and remove its line from the index' : '';
  if (!confirm('Move ' + file.name + ' to the trash folder' + extra + '?')) return;
  try {
    await api('DELETE', '/api/files/' + encodeURIComponent(file.id));
    file = undefined;
    toast('Moved to the trash. Open Trash to restore it.');
    await load();
    await open(current.id);
    await loadTrash();
  } catch (err) {
    toast(err.message);
  }
};

$('#addIndex').onclick = async () => {
  const idx = indexFile();
  const m = meta(saved);
  const line = '- [' + (m.name || file.name.replace(/\.md$/, '')) + '](' + file.name + ')' + (m.description ? ' — ' + m.description : '');
  try {
    if (idx) {
      const content = idx.content + (idx.content && !idx.content.endsWith('\n') ? '\n' : '') + line + '\n';
      await api('PUT', '/api/files/' + encodeURIComponent(idx.id), { content });
      idx.content = content;
    }
    toast('Added to index');
    refresh();
    renderList();
  } catch (err) {
    toast(err.message);
  }
};

$('#rawToggle').onclick = () => {
  if (mode === 'fields') {
    $('#raw').value = compose();
    setMode('raw');
  } else {
    const p = split($('#raw').value);
    if (!p) return toast('This file has no header block, so it stays in raw view.');
    parts = p;
    fillFields();
    setMode('fields');
  }
  refresh();
};

$('#revert').onclick = () => {
  if (file === null) { if (leave()) open(current.id).catch((err) => toast(err.message)); return; }
  if (leave()) show(file);
};
$('#edit').onclick = () => {
  setEditing(true);
  (mode === 'raw' ? $('#raw') : $('#fBody')).focus({ preventScroll: true });
};
$('#newMemory').onclick = () => { if (leave()) show(null); };
$('#search').oninput = renderList;
$('#showEmpty').onchange = renderPlaces;
$('#fName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#fDesc').focus(); } });
$('#fDesc').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#fBody').focus(); } });
$('#sheet').addEventListener('input', refresh);
window.addEventListener('resize', () => { if (file !== undefined) refresh(); });
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && file !== undefined) { e.preventDefault(); if (editing && dirty()) $('#sheet').requestSubmit(); }
});
window.addEventListener('beforeunload', (e) => { if (dirty()) e.preventDefault(); });
$('#openFolder').onclick = () =>
  api('POST', '/api/places/' + encodeURIComponent(current.id) + '/reveal', { harness }).catch((err) => toast(err.message));
$('#revealFile').onclick = () =>
  api('POST', '/api/files/' + encodeURIComponent(file.id) + '/reveal', {}).catch((err) => toast(err.message));
const fromHash = () => {
  const [h, id] = location.hash.slice(1).split('/');
  return { h: found.some((x) => x.id === h) ? h : harness, id: places.some((p) => p.id === id) ? id : 'global' };
};
window.addEventListener('hashchange', () => {
  const { h, id } = fromHash();
  if ((h !== harness || !current || current.id !== id) && leave()) pick(h, id).catch((err) => toast(err.message));
});

// ---- Trash ----
let trash = [], trashPick = null;
async function loadTrash() {
  const out = await api('GET', '/api/trash');
  trash = out.items;
  $('#trashDir').textContent = out.dir;
  $('#trashCount').textContent = trash.length || '';
  if (!trash.some((t) => t.id === (trashPick && trashPick.id))) trashPick = trash[0] || null;
}
function renderTrash() {
  const list = $('#trashList');
  list.replaceChildren();
  for (const t of trash) {
    const row = el('button', { type: 'button', className: 'row' },
      el('span', { className: 'rname', textContent: t.name }),
      el('span', { className: 'rdesc', textContent: t.place + (t.harnesses.length ? ' · ' + t.harnesses.map((h) => labels[h] || h).join(', ') : '') }),
      el('span', { className: 'rmeta' }, el('span', { textContent: 'Trashed ' + ago(t.trashedAt) })));
    row.dataset.type = 'other';
    if (t === trashPick) row.setAttribute('aria-current', 'true');
    row.onclick = () => { trashPick = t; renderTrash(); };
    list.append(row);
  }
  if (!trash.length) list.append(el('p', { className: 'note', textContent: 'The trash is empty.' }));
  $('#trashPreview').hidden = !trashPick;
  $('#emptyTrash').disabled = !trash.length;
  if (trashPick) {
    $('#trashMeta').textContent = trashPick.original ? 'From ' + trashPick.original : 'No record of where this file came from, so it cannot be restored.';
    $('#trashText').textContent = trashPick.content;
    $('#restoreOne').disabled = !trashPick.original;
  }
}
// After a restore the open place may have a new file; reload it unless you are typing.
async function afterTrashChange() {
  await loadTrash();
  renderTrash();
  await load();
  if (current && !dirty()) await open(current.id, file && file.id);
}
$('#trashBtn').onclick = async () => {
  try { await loadTrash(); renderTrash(); $('#trash').showModal(); } catch (err) { toast(err.message); }
};
$('#closeTrash').onclick = () => $('#trash').close();
$('#restoreOne').onclick = async () => {
  try {
    const out = await api('POST', '/api/trash/' + encodeURIComponent(trashPick.id) + '/restore', {});
    toast('Restored to ' + out.restored);
    await afterTrashChange();
  } catch (err) { toast(err.message); }
};
$('#dropOne').onclick = async () => {
  if (!confirm('Delete ' + trashPick.name + ' for good? This cannot be undone.')) return;
  try { await api('DELETE', '/api/trash/' + encodeURIComponent(trashPick.id)); toast('Deleted for good'); await afterTrashChange(); } catch (err) { toast(err.message); }
};
$('#emptyTrash').onclick = async () => {
  if (!confirm('Delete all ' + trash.length + ' files in the trash for good? This cannot be undone.')) return;
  try { await api('DELETE', '/api/trash'); toast('Trash emptied'); await afterTrashChange(); } catch (err) { toast(err.message); }
};

// ---- Start ----
for (const t of TYPES) {
  const input = el('input', { type: 'radio', name: 'type', value: t });
  const pill = el('label', { className: 'type' }, input, t);
  pill.dataset.type = t;
  $('#types').append(pill);
}

loadTrash().catch(() => {});
load().then(() => {
  if (!harness) { $('#title').textContent = 'No supported agent found'; return; }
  const { h, id } = fromHash();
  return pick(h, id);
}).catch((err) => toast(err.message));
document.fonts && document.fonts.ready.then(() => { if (file !== undefined) refresh(); });
