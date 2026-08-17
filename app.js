'use strict';
/* Aufgaben & Text – komplett im Browser: IndexedDB, kein Server, keine Abhängigkeiten.
   Nicht per Doppelklick öffnen – file:// sperrt IndexedDB. Im Ordner starten:
     python3 -m http.server 5174     →     http://localhost:5174

   Speicher: IndexedDB "aufgaben" mit den Stores tasks, docs, images (Screenshots als Blob).
   Nur zwei Kleinigkeiten liegen in localStorage: aktiver Reiter, zuletzt offenes Dokument. */

/* --------------------------------------------------------------- Grundlage --- */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const list = $('#list'), titleIn = $('#title'), qIn = $('#q'), toast = $('#toast');
const editor = $('#doc'), docTitle = $('#doctitle'), docList = $('#doclist'), docQ = $('#docq');

const PRIO = ['ohne', 'mittel', 'hoch'];

let tab = 'tasks';
let tasks = [], docs = [];
let filter = 'open', query = '', docQuery = '';
let editing = null;    // id, deren Titel gerade im Eingabefeld hängt
let openId = null;     // id, deren Detailbereich offen ist
let curDoc = null;     // offenes Dokument
let dirty = false;     // ungesicherte Änderung im Editor
let undo = null;       // { run } für "Rückgängig"
let toastTimer = 0;
const imgUrls = new Map();   // Bild-id -> objectURL (nur fürs offene Dokument)

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const byId = id => tasks.find(t => t.id === id);
const dueKey = t => t.due || '9999-99-99';

/* erledigt nach unten, dann Priorität, dann Fälligkeit, dann neueste zuerst */
const order = (a, b) =>
  (a.done - b.done) ||
  (b.prio - a.prio) ||
  (dueKey(a) < dueKey(b) ? -1 : dueKey(a) > dueKey(b) ? 1 : 0) ||
  (b.created - a.created);

/* ------------------------------------------------------------- IndexedDB --- */

const DB_NAME = 'aufgaben';
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 2); }
    catch (e) { return reject(e); }                  // file://, Privatmodus …
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const name of ['tasks', 'docs', 'images'])
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Von einem anderen Tab blockiert'));
  });
}

/* Eine Transaktion, ein Promise. fn bekommt den ObjectStore. */
function tx(store, fn, mode = 'readwrite') {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

const all = store => tx(store, s => s.getAll(), 'readonly');

/* Schreiben ist lokal und schnell – beim Tippen trotzdem entprellt. */
const timers = new Map();
function later(key, ms, fn) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(fn, ms));
}

function saveTask(t, delay = 0) {
  t.updated = Date.now();
  const run = () => tx('tasks', s => s.put(t)).catch(e => notify('Nicht gespeichert: ' + e));
  if (delay) later(t.id, delay, run);
  else { clearTimeout(timers.get(t.id)); run(); }
}

/* ----------------------------------------------------------------- Datum --- */

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const dayDiff = iso => Math.round((Date.parse(iso + 'T00:00') - Date.parse(todayISO() + 'T00:00')) / 864e5);

function fmtDue(iso) {
  const d = dayDiff(iso);
  if (d === 0) return 'heute';
  if (d === 1) return 'morgen';
  if (d === -1) return 'gestern';
  const [y, m, day] = iso.split('-');
  return `${day}.${m}.` + (y === String(new Date().getFullYear()) ? '' : y.slice(2));
}
const fmtStamp = ms => new Date(ms).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });

/* =========================================================== AUFGABEN ====== */

function row(t) {
  const open = t.id === openId;
  const cls = `p${t.prio}${t.done ? ' done' : ''}${open ? ' open' : ''}`;
  const badge = t.due
    ? `<span class="due-badge ${dayDiff(t.due) < 0 && !t.done ? 'over' : dayDiff(t.due) === 0 ? 'today' : ''}">${fmtDue(t.due)}</span>`
    : '';

  return `<li data-id="${t.id}" class="${cls}">
    <div class="main">
      <input type="checkbox" class="check" data-k="check" ${t.done ? 'checked' : ''} aria-label="Erledigt">
      ${editing === t.id
        ? `<input class="edit" data-k="edit" value="${esc(t.title)}" maxlength="500">`
        : `<span class="t" data-k="t" tabindex="0" role="button">${esc(t.title)}</span>`}
      ${badge}
      <button type="button" class="prio" data-k="prio" title="Priorität: ${PRIO[t.prio]}" aria-label="Priorität: ${PRIO[t.prio]}"></button>
      <button type="button" class="more" data-k="more" title="Details" aria-expanded="${open}" aria-label="Details">▾</button>
      <button type="button" class="del" data-k="del" title="Löschen" aria-label="Löschen">×</button>
    </div>
    ${open ? `<div class="detail">
      <textarea class="note" data-k="note" placeholder="Notiz …">${esc(t.note)}</textarea>
      <label>Fällig <input type="date" class="due" data-k="due" value="${t.due}"></label>
      <span class="stamp">angelegt ${fmtStamp(t.created)}</span>
    </div>` : ''}
  </li>`;
}

function render() {
  const q = query.trim().toLowerCase();
  const view = tasks
    .filter(t => filter === 'all' || (filter === 'done') === t.done)
    .filter(t => !q || t.title.toLowerCase().includes(q) || t.note.toLowerCase().includes(q))
    .sort(order);

  const focus = grabFocus();
  list.innerHTML = view.map(row).join('');
  putFocus(focus);

  const empty = $('#empty');
  empty.hidden = view.length > 0;
  empty.textContent = !tasks.length ? 'Noch nichts da – oben eintippen und Enter.' : 'Nichts gefunden.';
  updateCount();
}

function updateCount() {
  const el = $('#count');
  if (tab === 'text') {
    el.textContent = docs.length ? `${docs.length} Dokument${docs.length > 1 ? 'e' : ''}` : '';
    return;
  }
  const offen = tasks.reduce((n, t) => n + (t.done ? 0 : 1), 0);
  el.textContent = !tasks.length ? '' : offen ? `${offen} offen` : 'alles erledigt';
}

/* Cursor überlebt das Neuzeichnen der Liste. */
function grabFocus() {
  const el = document.activeElement;
  const li = el && el.closest && el.closest('#list li');
  if (!li || !el.dataset.k) return null;
  let pos = null;
  try { pos = el.selectionStart; } catch { /* Datumsfelder kennen keine Auswahl */ }
  return { id: li.dataset.id, k: el.dataset.k, pos };
}

function putFocus(f) {
  if (!f) return;
  const el = list.querySelector(`li[data-id="${f.id}"] [data-k="${f.k}"]`);
  if (!el) return;
  el.focus();
  if (f.pos != null) { try { el.setSelectionRange(f.pos, f.pos); } catch { /* egal */ } }
}

function patch(id, changes) {
  const t = byId(id);
  if (!t) return;
  Object.assign(t, changes);
  saveTask(t);
  render();
}

$('#new').addEventListener('submit', e => {
  e.preventDefault();
  const title = titleIn.value.trim();
  if (!title) return;
  titleIn.value = '';

  const t = { id: crypto.randomUUID(), title, note: '', done: false, prio: 0, due: '', created: Date.now(), updated: Date.now() };
  tasks.push(t);
  saveTask(t);

  if (filter === 'done') setFilter('open');                       // sonst sofort unsichtbar
  if (query && !title.toLowerCase().includes(query.trim().toLowerCase())) { query = ''; qIn.value = ''; }
  render();
});

/* Enter im Titelfeld sendet ab – nicht auf das implizite Submit des Browsers bauen. */
titleIn.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#new').requestSubmit(); }
});

list.addEventListener('click', e => {
  const li = e.target.closest('li');
  if (!li) return;
  const id = li.dataset.id, k = e.target.dataset.k;

  if (k === 't')         { editing = id; render(); }
  else if (k === 'prio') patch(id, { prio: (byId(id).prio + 1) % 3 });
  else if (k === 'more') { openId = openId === id ? null : id; render(); }
  else if (k === 'del')  remove(id);
});

list.addEventListener('change', e => {
  const li = e.target.closest('li');
  if (!li) return;
  if (e.target.dataset.k === 'check') patch(li.dataset.id, { done: e.target.checked });
  if (e.target.dataset.k === 'due')   patch(li.dataset.id, { due: e.target.value });
});

list.addEventListener('input', e => {
  if (e.target.dataset.k !== 'note') return;
  const t = byId(e.target.closest('li').dataset.id);
  if (!t) return;
  t.note = e.target.value;
  saveTask(t, 300);
});

list.addEventListener('keydown', e => {
  const k = e.target.dataset.k;
  if (k === 't' && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    editing = e.target.closest('li').dataset.id;
    render();
  }
  if (k !== 'edit') return;
  if (e.key === 'Enter')  e.target.blur();
  if (e.key === 'Escape') { editing = null; render(); }
});

list.addEventListener('focusout', e => {
  const k = e.target.dataset.k;
  const li = e.target.closest('li');
  if (!li) return;

  if (k === 'note') { const t = byId(li.dataset.id); if (t) saveTask(t); return; }
  if (k !== 'edit' || editing === null) return;                   // per Esc schon verworfen

  const t = byId(li.dataset.id), title = e.target.value.trim();
  editing = null;
  if (t && title && title !== t.title) patch(t.id, { title });
  else render();
});

function remove(id) {
  const i = tasks.findIndex(t => t.id === id);
  if (i < 0) return;
  const [gone] = tasks.splice(i, 1);
  if (editing === id) editing = null;
  if (openId === id) openId = null;
  render();
  tx('tasks', s => s.delete(id)).catch(e => notify('Nicht gelöscht: ' + e));
  offerUndo('Gelöscht', () => {
    tasks.push(gone);
    tx('tasks', s => s.put(gone)).catch(e => notify('Nicht wiederhergestellt: ' + e));
    render();
  });
}

$('#purge').addEventListener('click', () => {
  const done = tasks.filter(t => t.done);
  if (!done.length) return notify('Nichts zu löschen');
  tasks = tasks.filter(t => !t.done);
  render();
  tx('tasks', s => done.forEach(t => s.delete(t.id))).catch(e => notify('Nicht gelöscht: ' + e));
  offerUndo(`${done.length} gelöscht`, () => {
    tasks.push(...done);
    tx('tasks', s => done.forEach(t => s.put(t))).catch(e => notify('Nicht wiederhergestellt: ' + e));
    render();
  });
});

function setFilter(f) {
  filter = f;
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.f === f));
}

$$('.tabs button').forEach(b =>
  b.addEventListener('click', () => { setFilter(b.dataset.f); render(); }));

qIn.addEventListener('input', () => { query = qIn.value; render(); });

/* =============================================================== TEXT ====== */

const textOf = html => html.replace(/<[^>]*>/g, ' ');

function renderDocs() {
  const q = docQuery.trim().toLowerCase();
  const view = docs
    .filter(d => !q || d.title.toLowerCase().includes(q) || textOf(d.html).toLowerCase().includes(q))
    .sort((a, b) => b.updated - a.updated);

  docList.innerHTML = view.map(d => `<li data-id="${d.id}" class="${curDoc && d.id === curDoc.id ? 'on' : ''}">
      <span class="dbox">
        <span class="dt">${esc(d.title || 'Ohne Titel')}</span>
        <span class="dd">${fmtStamp(d.updated)}</span>
      </span>
      <button type="button" class="ddel" title="Dokument löschen" aria-label="Dokument löschen">×</button>
    </li>`).join('');

  $('#editor').hidden = !curDoc;
  $('#nodocs').hidden = !!curDoc;
  updateCount();
}

/* --- Bilder: liegen als Blob im Store, im Dokument steht nur data-img ------ */

async function bindImages() {
  for (const el of editor.querySelectorAll('img[data-img]')) {
    const id = el.dataset.img;
    let url = imgUrls.get(id);
    if (!url) {
      const rec = await tx('images', s => s.get(id), 'readonly').catch(() => null);
      if (!rec) { el.alt = '[Bild fehlt]'; continue; }
      url = URL.createObjectURL(rec.blob);
      imgUrls.set(id, url);
    }
    el.src = url;
  }
}

function releaseImages() {
  imgUrls.forEach(u => URL.revokeObjectURL(u));
  imgUrls.clear();
}

async function insertImage(file) {
  if (!curDoc) return;
  const id = crypto.randomUUID();
  const sel = getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;

  await tx('images', s => s.put({ id, blob: file })).catch(e => notify('Bild nicht gespeichert: ' + e));

  const url = URL.createObjectURL(file);
  imgUrls.set(id, url);
  editor.focus();
  if (range) { sel.removeAllRanges(); sel.addRange(range); }       // Cursor überlebt das await
  exec('insertHTML', `<img data-img="${id}" src="${url}" alt=""><p><br></p>`);
  touch();
}

/* --- Dokument öffnen, anlegen, löschen ------------------------------------ */

async function openDoc(id) {
  if (curDoc && curDoc.id === id) return;
  flushDoc();
  releaseImages();
  curDoc = docs.find(d => d.id === id) || null;
  if (!curDoc) { renderDocs(); return; }

  docTitle.value = curDoc.title;
  editor.innerHTML = curDoc.html || '';
  await bindImages();
  dirty = false;
  markEmpty(); countWords(); setSaved('gespeichert');
  renderDocs();
  try { localStorage.setItem('lastDoc', id); } catch { /* egal */ }
}

function newDoc() {
  flushDoc();
  releaseImages();
  const d = { id: crypto.randomUUID(), title: '', html: '', created: Date.now(), updated: Date.now() };
  docs.push(d);
  curDoc = d;
  dirty = false;
  tx('docs', s => s.put(d)).catch(e => notify('Nicht angelegt: ' + e));
  docTitle.value = '';
  editor.innerHTML = '';
  markEmpty(); countWords(); setSaved('neu');
  renderDocs();
  docTitle.focus();
}

function delDoc(id) {
  const i = docs.findIndex(d => d.id === id);
  if (i < 0) return;
  const [gone] = docs.splice(i, 1);
  tx('docs', s => s.delete(id)).catch(e => notify('Nicht gelöscht: ' + e));

  if (curDoc && curDoc.id === id) {
    releaseImages();
    curDoc = null;
    const next = [...docs].sort((a, b) => b.updated - a.updated)[0];
    if (next) openDoc(next.id); else { docTitle.value = ''; editor.innerHTML = ''; renderDocs(); }
  } else renderDocs();

  offerUndo('Dokument gelöscht', () => {
    docs.push(gone);
    tx('docs', s => s.put(gone)).catch(e => notify('Nicht wiederhergestellt: ' + e));
    curDoc = null;
    openDoc(gone.id);
  });
}

/* Bilder, die in keinem Dokument mehr vorkommen, beim Start wegräumen. */
async function sweepImages() {
  const used = new Set();
  for (const d of docs)
    for (const m of d.html.match(/data-img="[^"]+"/g) || []) used.add(m.slice(10, -1));
  const keys = await tx('images', s => s.getAllKeys(), 'readonly').catch(() => []);
  const drop = (keys || []).filter(k => !used.has(k));
  if (drop.length) await tx('images', s => drop.forEach(k => s.delete(k))).catch(() => {});
}

/* --- Speichern ------------------------------------------------------------ */

function docHTML() {
  const copy = editor.cloneNode(true);
  copy.querySelectorAll('img[data-img]').forEach(i => i.removeAttribute('src'));
  return copy.innerHTML;
}

const setSaved = text => { $('#saved').textContent = text; };

function touch() {
  if (!curDoc) return;
  dirty = true;
  setSaved('…');
  later('doc', 400, saveDoc);
  later('words', 300, () => { markEmpty(); countWords(); });
}

function saveDoc() {
  if (!curDoc || !dirty) return;
  const d = curDoc;
  d.title = docTitle.value;
  d.html = docHTML();
  d.updated = Date.now();
  dirty = false;
  tx('docs', s => s.put(d))
    .then(() => { setSaved('gespeichert'); renderDocs(); })
    .catch(e => { dirty = true; notify('Nicht gespeichert: ' + e); });
}

function flushDoc() { clearTimeout(timers.get('doc')); saveDoc(); }

function markEmpty() {
  const leer = !editor.textContent.trim() && !editor.querySelector('img,hr');
  editor.dataset.empty = leer ? '1' : '0';
}

function countWords() {
  const woerter = (editor.innerText || '').trim().split(/\s+/).filter(Boolean).length;
  const bilder = editor.querySelectorAll('img').length;
  $('#words').textContent = `${woerter} ${woerter === 1 ? 'Wort' : 'Wörter'}`
    + (bilder ? ` · ${bilder} Bild${bilder > 1 ? 'er' : ''}` : '');
}

/* --- Formatierung --------------------------------------------------------- */

const exec = (cmd, val = null) => document.execCommand(cmd, false, val);
const blockOf = n => (n && (n.nodeType === 3 ? n.parentElement : n));

function command(cmd) {
  editor.focus();
  switch (cmd) {
    case 'h1': case 'h2': case 'h3': exec('formatBlock', `<${cmd}>`); break;
    case 'p':     exec('formatBlock', '<p>'); break;
    case 'pre':   exec('formatBlock', '<pre>'); break;
    case 'quote': exec('formatBlock', '<blockquote>'); break;
    case 'bold':  exec('bold'); break;
    case 'italic':exec('italic'); break;
    case 'ul':    exec('insertUnorderedList'); break;
    case 'ol':    exec('insertOrderedList'); break;
    case 'hr':    exec('insertHorizontalRule'); break;
    case 'code': {
      const sel = getSelection();
      const text = sel && sel.toString();
      if (text) exec('insertHTML', `<code>${esc(text)}</code>`);
      break;
    }
  }
  touch(); syncToolbar();
}

function syncToolbar() {
  if (tab !== 'text') return;
  const sel = getSelection();
  if (!sel || !sel.anchorNode || !editor.contains(sel.anchorNode)) return;

  const val = c => { try { return (document.queryCommandValue(c) || '').toLowerCase(); } catch { return ''; } };
  const on  = c => { try { return document.queryCommandState(c); } catch { return false; } };
  const block = val('formatBlock');

  $$('#toolbar button').forEach(b => {
    const c = b.dataset.cmd;
    let aktiv = false;
    if (c === 'bold' || c === 'italic') aktiv = on(c);
    else if (c === 'ul')    aktiv = on('insertUnorderedList');
    else if (c === 'ol')    aktiv = on('insertOrderedList');
    else if (c === 'quote') aktiv = block === 'blockquote';
    else if (c === 'p')     aktiv = block === 'p' || block === 'div';
    else if (c === 'h1' || c === 'h2' || c === 'h3' || c === 'pre') aktiv = block === c;
    b.classList.toggle('on', aktiv);
  });
}

/* --- Fremdes HTML entschärfen (Einfügen aus anderen Programmen, Import) ---- */

const OK = { H1:1,H2:1,H3:1,H4:1,P:1,BR:1,UL:1,OL:1,LI:1,STRONG:1,B:1,EM:1,I:1,U:1,
             CODE:1,PRE:1,BLOCKQUOTE:1,A:1,HR:1,IMG:1,DIV:1,SPAN:1 };

function sanitize(html) {
  const box = new DOMParser().parseFromString(String(html), 'text/html').body;   // inert: lädt nichts, führt nichts aus
  for (const el of [...box.querySelectorAll('*')]) {
    if (el.tagName === 'IMG' && !el.hasAttribute('data-img')) { el.remove(); continue; }
    if (!OK[el.tagName]) { el.replaceWith(...el.childNodes); continue; }
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      const behalten =
        (el.tagName === 'A'   && n === 'href' && /^(https?:|mailto:)/i.test(a.value)) ||
        (el.tagName === 'IMG' && (n === 'data-img' || n === 'alt'));
      if (!behalten) el.removeAttribute(a.name);
    }
  }
  return box.innerHTML;
}

/* --- Editor-Ereignisse ---------------------------------------------------- */

editor.addEventListener('input', touch);
editor.addEventListener('blur', flushDoc);
docTitle.addEventListener('input', touch);

editor.addEventListener('paste', async e => {
  const dt = e.clipboardData;
  if (!dt) return;

  const bilder = [...dt.files].filter(f => f.type.startsWith('image/'));
  if (bilder.length) {                                   // Screenshot aus der Zwischenablage
    e.preventDefault();
    for (const f of bilder) await insertImage(f);
    return;
  }
  const html = dt.getData('text/html');
  if (html) { e.preventDefault(); exec('insertHTML', sanitize(html)); touch(); }
  // reiner Text: Standardverhalten des Browsers genügt
});

editor.addEventListener('dragover', e => {
  if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
});

editor.addEventListener('drop', async e => {
  const bilder = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
  if (!bilder.length) return;
  e.preventDefault();
  const pos = document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY);
  if (pos) { const s = getSelection(); s.removeAllRanges(); s.addRange(pos); }
  for (const f of bilder) await insertImage(f);
});

/* Steht der Cursor am Ende dieses Blocks? */
function atEnd(block) {
  const sel = getSelection();
  if (!sel.isCollapsed || !sel.anchorNode) return false;
  const r = document.createRange();
  r.selectNodeContents(block);
  r.setStart(sel.anchorNode, sel.anchorOffset);
  return r.toString().trim() === '';
}

editor.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key >= '0' && e.key <= '3') {
    e.preventDefault();
    command(e.key === '0' ? 'p' : 'h' + e.key);
    return;
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    const block = blockOf(getSelection().anchorNode)?.closest('h1,h2,h3,pre');
    if (block && block.tagName === 'PRE') {          // im Code-Block: Zeilenumbruch statt neuem Block
      e.preventDefault();
      exec('insertText', '\n');
      touch();
      return;
    }
    if (block && atEnd(block)) {                     // nach einer Überschrift: normaler Absatz
      e.preventDefault();
      exec('insertParagraph');
      exec('formatBlock', '<p>');
      touch(); syncToolbar();
      return;
    }
  }
  if (e.key === 'Tab') {                                 // in Listen ein-/ausrücken
    const li = blockOf(getSelection().anchorNode)?.closest('li');
    if (li) { e.preventDefault(); exec(e.shiftKey ? 'outdent' : 'indent'); touch(); }
  }
});

document.addEventListener('selectionchange', () => later('tb', 40, syncToolbar));

$('#toolbar').addEventListener('mousedown', e => {
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();                                    // Auswahl im Editor nicht verlieren
  command(b.dataset.cmd);
});

$('#newdoc').addEventListener('click', newDoc);
docQ.addEventListener('input', () => { docQuery = docQ.value; renderDocs(); });

docList.addEventListener('click', e => {
  const li = e.target.closest('li');
  if (!li) return;
  if (e.target.classList.contains('ddel')) delDoc(li.dataset.id);
  else openDoc(li.dataset.id);
});

/* ============================================================== REITER ===== */

function setTab(name) {
  if (name !== 'text') flushDoc();
  tab = name;
  document.body.dataset.tab = name;
  $$('.maintabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $('#v-tasks').hidden = name !== 'tasks';
  $('#v-text').hidden  = name !== 'text';
  $('#keys-tasks').hidden = name !== 'tasks';
  $('#keys-text').hidden  = name !== 'text';
  updateCount();
  try { localStorage.setItem('tab', name); } catch { /* egal */ }
  if (name === 'text' && curDoc) { markEmpty(); countWords(); }
}

$$('.maintabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

/* ------------------------------------------------------------ Toast/Undo --- */

function notify(text, canUndo = false) {
  toast.querySelector('span').textContent = text;
  $('#undo').hidden = !canUndo;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; undo = null; }, 7000);
}

function offerUndo(text, run) { undo = run; notify(text, true); }

$('#undo').addEventListener('click', () => {
  const run = undo;
  undo = null;
  toast.hidden = true;
  if (run) run();
});

/* --------------------------------------------------------- Sichern/Laden --- */

const pl = (n, ein, viele) => `${n} ${n === 1 ? ein : viele}`;

const toDataURL = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

function download(text, name, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const cleanTask = t => ({
  id: typeof t.id === 'string' && t.id ? t.id : crypto.randomUUID(),
  title: String(t.title).slice(0, 500),
  note: typeof t.note === 'string' ? t.note : '',
  done: !!t.done,
  prio: [0, 1, 2].includes(t.prio) ? t.prio : 0,
  due: /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : '',
  created: Number(t.created) || Date.now(),
  updated: Date.now(),
});

const cleanDoc = d => ({
  id: typeof d.id === 'string' && d.id ? d.id : crypto.randomUUID(),
  title: String(d.title ?? '').slice(0, 200),
  html: sanitize(d.html ?? ''),
  created: Number(d.created) || Date.now(),
  updated: Number(d.updated) || Date.now(),
});

$('#export').addEventListener('click', async () => {
  flushDoc();
  const bilder = [];
  for (const i of (await all('images')) || [])
    bilder.push({ id: i.id, data: await toDataURL(i.blob) });
  download(JSON.stringify({ app: 'aufgaben', version: 2, tasks, docs, images: bilder }, null, 1),
           `sicherung-${todayISO()}.json`);
  notify(`${pl(tasks.length, 'Aufgabe', 'Aufgaben')}, ${pl(docs.length, 'Dokument', 'Dokumente')}, ${pl(bilder.length, 'Bild', 'Bilder')} gesichert`);
});

$('#import').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const alt = Array.isArray(data);                       // altes Format: nur Aufgaben
    const tRows = (alt ? data : data.tasks || []).filter(t => t && typeof t.title === 'string').map(cleanTask);
    const dRows = (alt ? [] : data.docs || []).filter(d => d && typeof d === 'object').map(cleanDoc);
    const iRows = (alt ? [] : data.images || []).filter(i => i && typeof i.data === 'string');
    if (!tRows.length && !dRows.length) throw new Error('nichts Brauchbares enthalten');

    if (tRows.length) await tx('tasks', s => tRows.forEach(t => s.put(t)));
    if (dRows.length) await tx('docs',  s => dRows.forEach(d => s.put(d)));
    for (const im of iRows) {
      const blob = await (await fetch(im.data)).blob();
      await tx('images', s => s.put({ id: im.id, blob }));
    }

    tasks = await all('tasks');
    docs = await all('docs');
    curDoc = null;
    releaseImages();
    render(); renderDocs();
    const neuestes = [...docs].sort((a, b) => b.updated - a.updated)[0];
    if (neuestes) await openDoc(neuestes.id);
    notify(`${pl(tRows.length, 'Aufgabe', 'Aufgaben')}, ${pl(dRows.length, 'Dokument', 'Dokumente')}, ${pl(iRows.length, 'Bild', 'Bilder')} übernommen`);
  } catch (err) {
    notify('Import fehlgeschlagen: ' + err.message);
  }
});

/* Einzelnes Dokument als eigenständige HTML-Datei – Bilder eingebettet. */
$('#exportdoc').addEventListener('click', async () => {
  if (!curDoc) return notify('Kein Dokument offen');
  flushDoc();
  const body = new DOMParser().parseFromString(curDoc.html, 'text/html').body;
  for (const el of [...body.querySelectorAll('img[data-img]')]) {
    const rec = await tx('images', s => s.get(el.dataset.img), 'readonly').catch(() => null);
    if (rec) el.setAttribute('src', await toDataURL(rec.blob)); else el.remove();
    el.removeAttribute('data-img');
  }
  const titel = curDoc.title || 'Dokument';
  const css = `body{max-width:52rem;margin:3rem auto;padding:0 1.2rem;color:#14161b;background:#fff;
font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
h1{font-size:27px;letter-spacing:-.02em;margin:1.3em 0 .45em}h2{font-size:21px;margin:1.5em 0 .4em}
h3{font-size:17px;margin:1.4em 0 .35em}h1:first-child{margin-top:0}
code{background:#f5f6f8;border:1px solid #e7e9ee;border-radius:5px;padding:1px 5px;font-size:.88em}
pre{background:#f5f6f8;border:1px solid #e7e9ee;border-radius:9px;padding:11px 13px;overflow-x:auto;white-space:pre-wrap}
pre code{border:0;padding:0;background:none}
blockquote{margin:0 0 .9em;padding-left:14px;border-left:3px solid #e7e9ee;color:#767d8a}
img{display:block;max-width:100%;height:auto;margin:.7em 0;border:1px solid #e7e9ee;border-radius:9px}
hr{border:0;border-top:1px solid #e7e9ee;margin:1.7em 0}a{color:#2f6bff}`;
  download(`<!doctype html>\n<html lang="de">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${esc(titel)}</title>\n<style>${css}</style>\n</head>\n<body>\n<h1>${esc(titel)}</h1>\n${body.innerHTML}\n</body>\n</html>`,
    `${titel.replace(/[^\wäöüÄÖÜß .-]+/g, '_').trim() || 'dokument'}.html`, 'text/html');
});

/* -------------------------------------------------------------- Tastatur --- */

addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;

  if (e.key === 'Escape') {
    if (e.target.isContentEditable) { e.target.blur(); return; }
    if (editing !== null) { editing = null; render(); }
    else if (typing && e.target.value !== '') { e.target.value = ''; e.target.dispatchEvent(new Event('input')); }
    else if (typing) e.target.blur();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || tab !== 'tasks') return;

  if (e.key === '/')                       { e.preventDefault(); qIn.focus(); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); titleIn.focus(); }
});

addEventListener('beforeunload', flushDoc);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushDoc(); });

/* ----------------------------------------------------------------- Start --- */

function fail(err) {
  const p = document.createElement('p');
  p.className = 'fail';
  p.innerHTML = location.protocol === 'file:'
    ? 'IndexedDB ist gesperrt, wenn die Seite direkt als Datei geöffnet wird. Im Ordner <code>python3 -m http.server 5174</code> starten und <code>http://localhost:5174</code> aufrufen.'
    : 'Datenbank nicht verfügbar: ' + esc(err && err.message || String(err));
  $('main').prepend(p);
  titleIn.disabled = true;
  editor.contentEditable = 'false';
}

openDB().then(async handle => {
  db = handle;
  tasks = (await all('tasks')).map(t => ({ note: '', due: '', prio: 0, ...t }));
  docs  = (await all('docs')).map(d => ({ title: '', html: '', ...d }));

  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* egal */ }

  render();
  renderDocs();

  let letztes = null;
  try { letztes = localStorage.getItem('lastDoc'); } catch { /* egal */ }
  const start = docs.find(d => d.id === letztes) || [...docs].sort((a, b) => b.updated - a.updated)[0];
  if (start) await openDoc(start.id);

  let reiter = 'tasks';
  try { reiter = localStorage.getItem('tab') || 'tasks'; } catch { /* egal */ }
  setTab(reiter === 'text' ? 'text' : 'tasks');

  sweepImages();
  navigator.storage?.persist?.()?.catch(() => {});   // Browser soll die Daten nicht wegräumen
}).catch(fail);
