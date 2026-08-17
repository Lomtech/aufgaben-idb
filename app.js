'use strict';
/* Aufgaben – komplett im Browser: IndexedDB, kein Server, keine Abhängigkeiten.
   Nicht per Doppelklick öffnen – file:// sperrt IndexedDB. Im Ordner starten:
     python3 -m http.server 5174     →     http://localhost:5174              */

/* --------------------------------------------------------------- Zustand --- */

const $ = s => document.querySelector(s);
const list = $('#list'), titleIn = $('#title'), qIn = $('#q'), toast = $('#toast');

const PRIO = ['ohne', 'mittel', 'hoch'];

let tasks = [];        // Spiegel der DB im Speicher – Rendern ohne await
let filter = 'open';
let query = '';
let editing = null;    // id, deren Titel gerade im Eingabefeld hängt
let openId = null;     // id, deren Detailbereich offen ist
let undo = null;       // zuletzt gelöschte Aufgaben
let toastTimer = 0;

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

const DB_NAME = 'aufgaben', STORE = 'tasks';
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); }
    catch (e) { return reject(e); }                  // file://, Privatmodus …
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Von einem anderen Tab blockiert'));
  });
}

/* Eine Transaktion, ein Promise. fn bekommt den ObjectStore. */
function tx(fn, mode = 'readwrite') {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

const readAll = () => tx(s => s.getAll(), 'readonly');

/* Schreiben ist lokal und schnell – beim Tippen trotzdem entprellt. */
const timers = new Map();
function store(t, delay = 0) {
  t.updated = Date.now();
  clearTimeout(timers.get(t.id));
  const run = () => tx(s => s.put(t)).catch(e => notify('Nicht gespeichert: ' + e));
  if (delay) timers.set(t.id, setTimeout(run, delay));
  else run();
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

/* --------------------------------------------------------------- Rendern --- */

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

  const offen = tasks.reduce((n, t) => n + (t.done ? 0 : 1), 0);
  $('#count').textContent = !tasks.length ? '' : offen ? `${offen} offen` : 'alles erledigt';

  const empty = $('#empty');
  empty.hidden = view.length > 0;
  empty.textContent = !tasks.length ? 'Noch nichts da – oben eintippen und Enter.' : 'Nichts gefunden.';
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

/* -------------------------------------------------------------- Aktionen --- */

function patch(id, changes) {
  const t = byId(id);
  if (!t) return;
  Object.assign(t, changes);
  store(t);
  render();
}

$('#new').addEventListener('submit', e => {
  e.preventDefault();
  const title = titleIn.value.trim();
  if (!title) return;
  titleIn.value = '';

  const t = { id: crypto.randomUUID(), title, note: '', done: false, prio: 0, due: '', created: Date.now(), updated: Date.now() };
  tasks.push(t);
  store(t);

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
  store(t, 300);
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

  if (k === 'note') { const t = byId(li.dataset.id); if (t) store(t); return; }
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
  tx(s => s.delete(id)).catch(e => notify('Nicht gelöscht: ' + e));
  offerUndo('Gelöscht', [gone]);
}

$('#purge').addEventListener('click', () => {
  const done = tasks.filter(t => t.done);
  if (!done.length) return notify('Nichts zu löschen');
  tasks = tasks.filter(t => !t.done);
  render();
  tx(s => done.forEach(t => s.delete(t.id))).catch(e => notify('Nicht gelöscht: ' + e));
  offerUndo(`${done.length} gelöscht`, done);
});

/* ---------------------------------------------------------------- Filter --- */

function setFilter(f) {
  filter = f;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.f === f));
}

document.querySelectorAll('.tabs button').forEach(b =>
  b.addEventListener('click', () => { setFilter(b.dataset.f); render(); }));

qIn.addEventListener('input', () => { query = qIn.value; render(); });

/* ------------------------------------------------------------ Toast/Undo --- */

function notify(text, canUndo = false) {
  toast.querySelector('span').textContent = text;
  $('#undo').hidden = !canUndo;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; undo = null; }, 7000);
}

function offerUndo(text, items) { undo = items; notify(text, true); }

$('#undo').addEventListener('click', () => {
  if (!undo) return;
  const back = undo;
  undo = null;
  toast.hidden = true;
  tasks.push(...back);
  render();
  tx(s => back.forEach(t => s.put(t))).catch(e => notify('Nicht wiederhergestellt: ' + e));
});

/* --------------------------------------------------------- Sichern/Laden --- */

const clean = t => ({
  id: typeof t.id === 'string' && t.id ? t.id : crypto.randomUUID(),
  title: String(t.title).slice(0, 500),
  note: typeof t.note === 'string' ? t.note : '',
  done: !!t.done,
  prio: [0, 1, 2].includes(t.prio) ? t.prio : 0,
  due: /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : '',
  created: Number(t.created) || Date.now(),
  updated: Date.now(),
});

$('#export').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(tasks, null, 2)], { type: 'application/json' }));
  a.download = `aufgaben-${todayISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#import').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error('kein Aufgaben-Export');
    const rows = data.filter(t => t && typeof t.title === 'string').map(clean);
    if (!rows.length) throw new Error('keine Aufgaben enthalten');
    await tx(s => rows.forEach(t => s.put(t)));
    tasks = await readAll();
    render();
    notify(`${rows.length} übernommen`);
  } catch (err) {
    notify('Import fehlgeschlagen: ' + err.message);
  }
});

/* -------------------------------------------------------------- Tastatur --- */

addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

  if (e.key === 'Escape') {
    if (editing !== null) { editing = null; render(); }
    else if (typing && e.target.value !== '') { e.target.value = ''; e.target.dispatchEvent(new Event('input')); }
    else if (typing) e.target.blur();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === '/')                     { e.preventDefault(); qIn.focus(); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); titleIn.focus(); }
});

/* ----------------------------------------------------------------- Start --- */

function fail(err) {
  const p = document.createElement('p');
  p.className = 'fail';
  p.innerHTML = location.protocol === 'file:'
    ? 'IndexedDB ist gesperrt, wenn die Seite direkt als Datei geöffnet wird. Im Ordner <code>python3 -m http.server 5174</code> starten und <code>http://localhost:5174</code> aufrufen.'
    : 'Datenbank nicht verfügbar: ' + esc(err && err.message || String(err));
  $('main').prepend(p);
  titleIn.disabled = true;
}

openDB().then(async handle => {
  db = handle;
  tasks = (await readAll()).map(t => ({ note: '', due: '', prio: 0, ...t }));
  render();
  navigator.storage?.persist?.()?.catch(() => {});   // Browser soll die Daten nicht wegräumen
}).catch(fail);
