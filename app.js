'use strict';
/* Aufgaben & Text – komplett im Browser: IndexedDB, kein Server, keine Abhängigkeiten.
   Nicht per Doppelklick öffnen – file:// sperrt IndexedDB. Im Ordner starten:
     python3 -m http.server 5174     →     http://localhost:5174

   Speicher: IndexedDB "aufgaben" mit den Stores tasks, docs, images (Screenshots als Blob).
   Nur zwei Kleinigkeiten liegen in localStorage: aktiver Reiter, zuletzt offenes Dokument. */

/* --------------------------------------------------------------- Grundlage --- */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const titleIn = $('#title'), qIn = $('#q'), toast = $('#toast');
const editor = $('#doc'), docTitle = $('#doctitle');
const tree = $('#tree'), railQ = $('#railq');

const PRIO = ['ohne', 'mittel', 'hoch'];

let tab = 'tasks';
let tasks = [], docs = [];
let query = '', sort = 'manuell';
let projekte = [];          // { id, name, color }
let projFilter = '';        // Filter über dem Brett
let neuProj = '';           // Projekt für neue Aufgaben
let neueSpalte = 'open';    // Spalte für neue Aufgaben (über das ＋ einer Spalte gesetzt)
let ansicht = 'tabelle';    // 'tabelle' oder 'brett'
let breiten = {};           // gezogene Spaltenbreiten der Tabelle
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

/* Sortierungen innerhalb einer Spalte. "manuell" ist die selbst gezogene Reihenfolge. */
const nameCmp = (a, b) => a.title.localeCompare(b.title, 'de', { sensitivity: 'base', numeric: true });

const SORTEN = {
  manuell: (a, b) => (a.ord ?? a.created) - (b.ord ?? b.created),
  smart:   (a, b) => (b.prio - a.prio) ||
                     (dueKey(a) < dueKey(b) ? -1 : dueKey(a) > dueKey(b) ? 1 : 0) ||
                     (b.created - a.created),
  new:     (a, b) => b.created - a.created,
  old:     (a, b) => a.created - b.created,
  touched: (a, b) => (b.updated || b.created) - (a.updated || a.created),
  az:      nameCmp,
  za:      (a, b) => nameCmp(b, a),
};

const order = (a, b) => SORTEN[sort](a, b);

/* Spalten des Bretts */
const SPALTEN = [
  { id: 'open',  name: 'Offen' },
  { id: 'doing', name: 'In Arbeit' },
  { id: 'done',  name: 'Erledigt' },
];

/* ------------------------------------------------------------- IndexedDB --- */

const DB_NAME = 'aufgaben';
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 4); }
    catch (e) { return reject(e); }                  // file://, Privatmodus …
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const name of ['tasks', 'docs', 'images', 'diagrams', 'projects'])
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

/* Kurzer Zeitstempel für die Zeile: heute die Uhrzeit, sonst das Datum. */
function fmtWhen(ms) {
  const d = new Date(ms);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (iso === todayISO()) return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const gleichesJahr = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('de-DE', gleichesJahr
    ? { day: '2-digit', month: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: '2-digit' });
}
const fmtVoll = ms => new Date(ms).toLocaleString('de-DE',
  { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/* =========================================================== AUFGABEN ====== */
/* Brett mit drei Spalten. Oberaufgaben sind Karten, Unteraufgaben hängen als
   Häkchenliste in der Karte – sonst wächst das Brett unbrauchbar breit. */

const board = $('#board');
const kinderVon = id => tasks.filter(t => t.parent === id);
const istOben = t => !t.parent;

/* Kleine Auszeichnung im Text: `Code` wird monospace, Links werden anklickbar. */
function schmuck(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

const projekt = id => projekte.find(p => p.id === id);

function chip(t) {
  const p = projekt(t.projekt);
  return p ? `<span class="chip" style="--c:${p.color}">${esc(p.name)}</span>` : '';
}

function karte(t) {
  const auf = t.id === openId;
  const kinder = kinderVon(t.id);
  const fertig = kinder.filter(k => k.done).length;
  const badge = t.due
    ? `<span class="due-badge ${dayDiff(t.due) < 0 && !t.done ? 'over' : dayDiff(t.due) === 0 ? 'today' : ''}">${fmtDue(t.due)}</span>`
    : '';

  return `<article class="card p${t.prio}${auf ? ' open' : ''}" data-id="${t.id}">
    <div class="chead">
      ${chip(t)}
      <span class="when" title="angelegt ${fmtVoll(t.created)} · geändert ${fmtVoll(t.updated || t.created)}">${fmtWhen(sort === 'touched' ? (t.updated || t.created) : t.created)}</span>
      <button type="button" class="prio" data-k="prio" title="Priorität: ${PRIO[t.prio]}" aria-label="Priorität: ${PRIO[t.prio]}"></button>
      <button type="button" class="more" data-k="more" title="Details" aria-expanded="${auf}" aria-label="Details">▾</button>
      <button type="button" class="del" data-k="del" title="Löschen" aria-label="Löschen">×</button>
    </div>

    ${editing === t.id
      ? `<textarea class="edit" data-k="edit" maxlength="500">${esc(t.title)}</textarea>`
      : `<div class="ctitle" data-k="t" tabindex="0" role="button">${schmuck(t.title)}</div>`}

    ${t.note && !auf ? `<div class="cnote">${schmuck(t.note)}</div>` : ''}

    ${kinder.length || badge ? `<div class="cfoot">
      ${kinder.length ? `<span class="subprog${fertig === kinder.length ? ' voll' : ''}">${fertig}/${kinder.length}</span>` : ''}
      ${badge}
    </div>` : ''}

    ${kinder.length ? `<ul class="subs">${kinder.map(k => `
      <li data-id="${k.id}" class="${k.done ? 'done' : ''}">
        <input type="checkbox" class="check" data-k="subcheck" ${k.done ? 'checked' : ''} aria-label="Erledigt">
        <span class="st" data-k="t">${schmuck(k.title)}</span>
        <button type="button" class="del" data-k="del" title="Löschen" aria-label="Löschen">×</button>
      </li>`).join('')}</ul>` : ''}

    ${auf ? `<div class="detail">
      <textarea class="note" data-k="note" placeholder="Notiz …">${esc(t.note)}</textarea>
      <label>Fällig <input type="date" class="due" data-k="due" value="${t.due}"></label>
      <label>Projekt <select class="projsel" data-k="proj">
        <option value="">— ohne —</option>
        ${projekte.map(p => `<option value="${p.id}"${p.id === t.projekt ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
        <option value="+">＋ neues Projekt …</option>
      </select></label>
      <input class="subnew" data-k="subnew" placeholder="Unteraufgabe … (Enter)" maxlength="500">
    </div>` : ''}
  </article>`;
}

function sichtbar() {
  const q = query.trim().toLowerCase();
  return tasks.filter(istOben).filter(t => {
    if (projFilter && t.projekt !== projFilter) return false;
    if (!q) return true;
    if (t.title.toLowerCase().includes(q) || t.note.toLowerCase().includes(q)) return true;
    return kinderVon(t.id).some(k => k.title.toLowerCase().includes(q));   // Treffer im Kind zeigt die Karte
  });
}

function render() {
  if (ansicht === 'tabelle') return renderTabelle();
  renderBrett();
}

function renderBrett() {
  const focus = grabFocus();
  const alle = sichtbar();

  board.innerHTML = SPALTEN.map(sp => {
    const drin = alle.filter(t => statusVon(t) === sp.id).sort(order);
    return `<div class="col" data-col="${sp.id}">
      <div class="colhead"><span>${sp.name}</span><b>${drin.length || ''}</b>
        <button type="button" class="colplus" data-col="${sp.id}" title="Aufgabe in dieser Spalte" aria-label="Aufgabe hinzufügen">＋</button>
      </div>
      <div class="cards" data-col="${sp.id}">${drin.map(karte).join('')}</div>
    </div>`;
  }).join('');

  putFocus(focus);

  const empty = $('#empty');
  empty.hidden = alle.length > 0;
  empty.textContent = !tasks.length ? 'Noch nichts da – oben eintippen und Enter.' : 'Nichts gefunden.';
  updateCount();
  projekteFuellen();
}

const statusVon = t => t.status || (t.done ? 'done' : 'open');

/* ============================================================= TABELLE ===== */
/* Raster wie in einer Tabellenkalkulation: jede Zelle einzeln bearbeitbar,
   Pfeiltasten bewegen die aktive Zelle, Spaltenköpfe sortieren, Breiten
   lassen sich ziehen, Kopieren/Einfügen läuft über Tabulator-Text. */

const gitter = $('#grid'), gitterRahmen = $('#gridwrap');

const SP = [
  { k: 'title',   n: 'Aufgabe',  w: 360, typ: 'text' },
  { k: 'projekt', n: 'Projekt',  w: 140, typ: 'proj' },
  { k: 'status',  n: 'Status',   w: 108, typ: 'status' },
  { k: 'prio',    n: 'Prio',     w: 84,  typ: 'prio' },
  { k: 'due',     n: 'Fällig',   w: 116, typ: 'date' },
  { k: 'sub',     n: 'Unter',    w: 66,  typ: 'ro' },
  { k: 'note',    n: 'Notiz',    w: 260, typ: 'text' },
  { k: 'created', n: 'Angelegt', w: 122, typ: 'ro' },
];

const STATUS_NAME = { open: 'Offen', doing: 'In Arbeit', done: 'Erledigt' };

let tabSort = { k: 'ord', ab: false };
let aktiv = null;            // { id, k } – aktive Zelle
let bearbeitet = false;      // aktive Zelle im Bearbeitungsmodus
let markiert = new Set();    // markierte Zeilen (id)
let letzteZeile = null;      // für Umschalt-Klick

const SORTWERT = {
  ord:     t => t.ord ?? t.created,
  title:   t => t.title.toLowerCase(),
  projekt: t => (projekt(t.projekt)?.name || '￿').toLowerCase(),
  status:  t => ['open', 'doing', 'done'].indexOf(statusVon(t)),
  prio:    t => -t.prio,
  due:     t => t.due || '9999-99-99',
  sub:     t => kinderVon(t.id).length,
  note:    t => t.note.toLowerCase(),
  created: t => t.created,
};

function tabCmp(a, b) {
  const f = SORTWERT[tabSort.k] || SORTWERT.ord;
  const x = f(a), y = f(b);
  const c = x < y ? -1 : x > y ? 1 : 0;
  return tabSort.ab ? -c : c;
}

/* Anzeigewert einer Zelle */
function zellText(t, k) {
  switch (k) {
    case 'title':   return t.title;
    case 'projekt': return projekt(t.projekt)?.name || '';
    case 'status':  return STATUS_NAME[statusVon(t)];
    case 'prio':    return ['', 'Mittel', 'Hoch'][t.prio];
    case 'due':     return t.due ? fmtDue(t.due) : '';
    case 'sub':     { const k2 = kinderVon(t.id); return k2.length ? `${k2.filter(x => x.done).length}/${k2.length}` : ''; }
    case 'note':    return t.note;
    case 'created': return fmtWhen(t.created);
  }
  return '';
}

/* Rohwert fürs Kopieren – da will man das Datum, nicht „morgen“. */
function rohText(t, k) {
  if (k === 'due') return t.due || '';
  if (k === 'created') return new Date(t.created).toISOString().slice(0, 10);
  return zellText(t, k);
}

function zelle(t, sp) {
  const ist = aktiv && aktiv.id === t.id && aktiv.k === sp.k;
  const bearbeitbar = sp.typ !== 'ro';
  if (ist && bearbeitet && bearbeitbar) return `<td class="z aktiv" data-k="${sp.k}">${feld(t, sp)}</td>`;

  const inhalt = sp.k === 'projekt' && t.projekt
    ? `<span class="chip" style="--c:${projekt(t.projekt).color}">${esc(zellText(t, sp.k))}</span>`
    : sp.k === 'due' && t.due
      ? `<span class="due-badge ${dayDiff(t.due) < 0 && !t.done ? 'over' : dayDiff(t.due) === 0 ? 'today' : ''}">${esc(zellText(t, sp.k))}</span>`
      : sp.k === 'title' ? schmuck(t.title)
      : sp.k === 'status' ? `<span class="stat s-${statusVon(t)}">${esc(zellText(t, sp.k))}</span>`
      : sp.k === 'prio' && t.prio ? `<span class="pz p${t.prio}">${esc(zellText(t, sp.k))}</span>`
      : esc(zellText(t, sp.k));

  return `<td class="z${ist ? ' aktiv' : ''}${bearbeitbar ? '' : ' ro'}" data-k="${sp.k}">${inhalt}</td>`;
}

function feld(t, sp) {
  if (sp.typ === 'proj') return `<select class="zf" data-k="${sp.k}">
      <option value=""${!t.projekt ? ' selected' : ''}>—</option>
      ${projekte.map(p => `<option value="${p.id}"${p.id === t.projekt ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
      <option value="+">＋ neues …</option></select>`;
  if (sp.typ === 'status') return `<select class="zf" data-k="${sp.k}">
      ${Object.entries(STATUS_NAME).map(([v, n]) => `<option value="${v}"${statusVon(t) === v ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
  if (sp.typ === 'prio') return `<select class="zf" data-k="${sp.k}">
      ${['—', 'Mittel', 'Hoch'].map((n, i) => `<option value="${i}"${t.prio === i ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
  if (sp.typ === 'date') return `<input class="zf" type="date" data-k="${sp.k}" value="${t.due}">`;
  return `<input class="zf" data-k="${sp.k}" value="${esc(t[sp.k] || '')}" maxlength="500">`;
}

/* Elternaufgaben sortiert, Unteraufgaben direkt darunter eingerückt. */
function tabZeilen() {
  const eltern = sichtbar().sort(tabCmp);
  const raus = [];
  for (const t of eltern) {
    raus.push({ t, tief: 0 });
    for (const k of kinderVon(t.id).sort((a, b) => (a.ord ?? a.created) - (b.ord ?? b.created)))
      raus.push({ t: k, tief: 1 });
  }
  return raus;
}

function renderTabelle() {
  const zeilen = tabZeilen();
  const pfeil = k => tabSort.k === k ? (tabSort.ab ? ' ▾' : ' ▴') : '';

  gitter.innerHTML = `
    <colgroup><col style="width:38px">${SP.map(s => `<col style="width:${breiten[s.k] || s.w}px">`).join('')}</colgroup>
    <thead><tr>
      <th class="nr"></th>
      ${SP.map(s => `<th data-k="${s.k}" class="${tabSort.k === s.k ? 'sortiert' : ''}">${s.n}${pfeil(s.k)}<i class="griff" data-griff="${s.k}"></i></th>`).join('')}
    </tr></thead>
    <tbody>
      ${zeilen.map(({ t, tief }, i) => `<tr data-id="${t.id}" class="${markiert.has(t.id) ? 'markiert ' : ''}${statusVon(t) === 'done' ? 'erledigt ' : ''}${tief ? 'kind' : ''}">
        <td class="nr">${i + 1}</td>
        ${SP.map(s => zelle(t, s)).join('')}
      </tr>`).join('')}
      <tr class="neu"><td class="nr">＋</td><td colspan="${SP.length}">Neue Aufgabe … (hier tippen)</td></tr>
    </tbody>`;

  const leer = $('#empty');
  leer.hidden = zeilen.length > 0;
  leer.textContent = !tasks.length ? 'Noch nichts da – unten in der Tabelle tippen.' : 'Nichts gefunden.';
  updateCount();
  projekteFuellen();

  if (aktiv && bearbeitet) {
    const f = gitter.querySelector('.aktiv .zf');
    if (f) { f.focus(); if (f.select) try { f.select(); } catch { /* egal */ } }
  }
}

/* =============================================================== BAUM ====== */
/* Linke Leiste: Reiter → Eintrag → Überschrift → Unterüberschrift.
   Aufgeklappt wird immer nur der aktive Zweig, sonst wird es unübersichtlich. */

let railQuery = '';
const passt = s => !railQuery || String(s).toLowerCase().includes(railQuery);

function zeile(stufe, ziel, text, zahl = '', aktiv = false, extra = '') {
  return `<li class="tw l${stufe}${aktiv ? ' on' : ''}" data-go="${ziel}" role="treeitem">`
       + `<span class="tx">${esc(text || '—')}</span>`
       + (zahl !== '' && zahl !== 0 ? `<b>${zahl}</b>` : '') + extra + '</li>';
}
const plusKnopf = art => `<button type="button" class="tplus" data-act="${art}" title="Neu anlegen" aria-label="Neu anlegen">＋</button>`;
const wegKnopf  = ziel => `<button type="button" class="ddel" data-del="${ziel}" title="Löschen" aria-label="Löschen">×</button>`;

/* Überschriften eines Dokuments – beim offenen aus dem Editor, sonst aus dem HTML. */
function gliederung(d) {
  const quelle = curDoc && d.id === curDoc.id
    ? editor
    : new DOMParser().parseFromString(d.html || '', 'text/html').body;
  return [...quelle.querySelectorAll('h1,h2,h3')]
    .map((h, i) => ({ i, stufe: +h.tagName[1], text: h.textContent.trim() }));
}

function renderTree() {
  const teile = [];

  /* Aufgaben */
  const offen = tasks.filter(t => statusVon(t) !== 'done').length;
  teile.push(zeile(1, 'tab:tasks', 'Aufgaben', offen, tab === 'tasks'));
  if (tab === 'tasks') {
    const gruppen = [{ id: '', name: 'Ohne Projekt' }, ...projekte];
    for (const g of gruppen) {
      const drin = tasks.filter(t => istOben(t) && (t.projekt || '') === g.id);
      if (!drin.length) continue;
      const aktiv = projFilter === g.id && g.id !== '';
      teile.push(zeile(2, 'p:' + g.id, g.name, drin.filter(t => statusVon(t) !== 'done').length, aktiv));
      for (const t of drin.sort(order).filter(t => passt(t.title))) {
        teile.push(zeile(3, 't:' + t.id, t.title));
        for (const k of kinderVon(t.id).filter(k => passt(k.title)))
          teile.push(zeile(4, 't:' + k.id, k.title));
      }
    }
  }

  /* Text */
  teile.push(zeile(1, 'tab:text', 'Text', docs.length, tab === 'text', plusKnopf('newdoc')));
  if (tab === 'text') {
    for (const d of [...docs].sort((a, b) => b.updated - a.updated)) {
      const istOffen = !!(curDoc && d.id === curDoc.id);
      const kinder = istOffen ? gliederung(d) : [];
      if (!passt(d.title) && !kinder.some(h => passt(h.text))) continue;
      teile.push(zeile(2, 'doc:' + d.id, d.title || 'Ohne Titel', '', istOffen, wegKnopf('doc:' + d.id)));
      for (const h of kinder)
        if (passt(d.title) || passt(h.text)) teile.push(zeile(2 + h.stufe, 'h:' + h.i, h.text));
    }
  }

  /* Diagramme */
  teile.push(zeile(1, 'tab:dia', 'Diagramme', dias.length, tab === 'dia', plusKnopf('newdia')));
  if (tab === 'dia') {
    for (const d of [...dias].sort((a, b) => b.updated - a.updated)) {
      const istOffen = !!(curDia && d.id === curDia.id);
      const kinder = istOffen ? d.nodes : [];
      if (!passt(d.title) && !kinder.some(n => passt(n.text))) continue;
      teile.push(zeile(2, 'dia:' + d.id, d.title || 'Ohne Titel', '', istOffen, wegKnopf('dia:' + d.id)));
      for (const n of kinder)
        if (passt(d.title) || passt(n.text)) teile.push(zeile(3, 'n:' + n.id, n.text, '', n.id === auswahl));
    }
  }

  tree.innerHTML = teile.join('');
}

const updateCount = renderTree;

tree.addEventListener('click', e => {
  const neu = e.target.closest('[data-act]');
  if (neu) {
    if (neu.dataset.act === 'newdoc') { setTab('text'); newDoc(); }
    else { setTab('dia'); newDia(); }
    return;
  }
  const weg = e.target.closest('[data-del]');
  if (weg) {
    const [art, id] = trenne(weg.dataset.del);
    if (art === 'doc') delDoc(id); else delDia(id);
    return;
  }
  const li = e.target.closest('[data-go]');
  if (!li) return;
  const [art, id] = trenne(li.dataset.go);

  if (art === 'tab')      setTab(id);
  else if (art === 'p')   { projFilter = projFilter === id ? '' : id; render(); }
  else if (art === 't')   zeigeAufgabe(id);
  else if (art === 'doc') openDoc(id);
  else if (art === 'h')   springeZuUeberschrift(+id);
  else if (art === 'dia') openDia(id);
  else if (art === 'n')   { auswahl = id; renderDia(); zeigeKnoten(id); renderTree(); }
});

const trenne = s => { const k = s.indexOf(':'); return [s.slice(0, k), s.slice(k + 1)]; };

railQ.addEventListener('input', () => { railQuery = railQ.value.trim().toLowerCase(); renderTree(); });

function hervorheben(el) {
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('blink');
  setTimeout(() => el.classList.remove('blink'), 900);
}

function zeigeAufgabe(id) {
  setTab('tasks');
  const t = byId(id);
  if (!t) return;
  if (projFilter && (t.projekt || '') !== projFilter) projFilter = '';   // sonst unsichtbar
  if (t.parent) openId = t.parent;                                       // Unteraufgabe: Karte aufklappen
  render();
  hervorheben(board.querySelector(`[data-id="${id}"]`));
}

function springeZuUeberschrift(i) {
  setTab('text');
  const h = editor.querySelectorAll('h1,h2,h3')[i];
  if (!h) return;
  hervorheben(h);
  editor.focus();
  caretToEnd(h);
}

function zeigeKnoten(id) {
  const n = knoten(id);
  if (!n) return;
  canvas.scrollTo({ left: Math.max(0, n.x * zoom - 140), top: Math.max(0, n.y * zoom - 110), behavior: 'smooth' });
}

/* Cursor überlebt das Neuzeichnen der Liste. */
function grabFocus() {
  const el = document.activeElement;
  const karte = el && el.closest && el.closest('#board .card');
  if (!karte || !el.dataset.k) return null;
  let pos = null;
  try { pos = el.selectionStart; } catch { /* Datumsfelder kennen keine Auswahl */ }
  return { id: karte.dataset.id, k: el.dataset.k, pos };
}

function putFocus(f) {
  if (!f) return;
  const el = board.querySelector(`.card[data-id="${f.id}"] [data-k="${f.k}"]`);
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

function setStatus(t, st) {
  t.status = st;
  t.done = st === 'done';                       // mitführen, damit alte Sicherungen weiter passen
}

function neueAufgabe(title, { status = 'open', parent = null, proj = null } = {}) {
  const t = {
    id: crypto.randomUUID(), title, note: '', done: status === 'done', status, parent,
    projekt: parent ? (byId(parent)?.projekt || '') : (proj ?? neuProj),
    prio: 0, due: '', ord: Date.now(), created: Date.now(), updated: Date.now(),
  };
  tasks.push(t);
  saveTask(t);
  return t;
}

$('#new').addEventListener('submit', e => {
  e.preventDefault();
  const title = titleIn.value.trim();
  if (!title) return;
  titleIn.value = '';
  neueAufgabe(title, { status: neueSpalte });
  neueSpalte = 'open';
  titleIn.placeholder = 'Neue Aufgabe …';
  if (query && !title.toLowerCase().includes(query.trim().toLowerCase())) { query = ''; qIn.value = ''; }
  render();
});

/* Enter im Titelfeld sendet ab – nicht auf das implizite Submit des Browsers bauen. */
titleIn.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#new').requestSubmit(); }
});

/* ------------------------------------------------------- Tabelle bedienen --- */

const zeilenIds = () => tabZeilen().map(z => z.t.id);

function setzeAktiv(id, k, edit = false) {
  aktiv = id ? { id, k } : null;
  bearbeitet = !!edit && SP.find(s => s.k === k)?.typ !== 'ro';
  renderTabelle();
  if (!bearbeitet) {
    const td = gitter.querySelector('tr[data-id="' + id + '"] td[data-k="' + k + '"]');
    td?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

/* Wert einer Zelle setzen – nimmt auch Text an (fürs Einfügen aus Excel). */
async function zelleSetzen(t, k, wert) {
  const s = String(wert ?? '').trim();
  if (k === 'title')   { if (s) t.title = s.slice(0, 500); }
  else if (k === 'note') t.note = s.slice(0, 2000);
  else if (k === 'due')  t.due = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  else if (k === 'prio') {
    const n = /^\d$/.test(s) ? +s : ['', 'mittel', 'hoch'].indexOf(s.toLowerCase());
    t.prio = [0, 1, 2].includes(n) ? n : 0;
  } else if (k === 'status') {
    const treffer = Object.entries(STATUS_NAME).find(([v, n]) => v === s || n.toLowerCase() === s.toLowerCase());
    setStatus(t, treffer ? treffer[0] : 'open');
  } else if (k === 'projekt') {
    if (!s) t.projekt = '';
    else if (projekt(s)) t.projekt = s;                      // id direkt
    else { const p = await projektAnlegen(s); if (p) t.projekt = p.id; }
    kinderVon(t.id).forEach(x => { x.projekt = t.projekt; saveTask(x); });
  }
  saveTask(t);
}

async function bearbeitenBeenden(uebernehmen = true) {
  const f = gitter.querySelector('.aktiv .zf');
  if (!f || !aktiv) { bearbeitet = false; return; }
  const t = byId(aktiv.id);
  bearbeitet = false;
  if (!t || !uebernehmen) return renderTabelle();

  if (aktiv.k === 'projekt' && f.value === '+') {
    const name = prompt('Name des neuen Projekts:');
    const p = name ? await projektAnlegen(name) : null;
    t.projekt = p ? p.id : t.projekt;
    kinderVon(t.id).forEach(x => { x.projekt = t.projekt; saveTask(x); });
    saveTask(t);
  } else {
    await zelleSetzen(t, aktiv.k, f.value);
  }
  renderTabelle();
}

gitter.addEventListener('mousedown', e => {
  const griff = e.target.closest('[data-griff]');
  if (griff) { breiteZiehen(e, griff.dataset.griff); e.preventDefault(); }
});

gitter.addEventListener('click', async e => {
  const kopf = e.target.closest('th[data-k]');
  if (kopf) {                                                // Spaltenkopf sortiert
    if (e.target.closest('[data-griff]')) return;
    tabSort = tabSort.k === kopf.dataset.k ? { k: kopf.dataset.k, ab: !tabSort.ab } : { k: kopf.dataset.k, ab: false };
    renderTabelle();
    return;
  }
  const neu = e.target.closest('tr.neu');
  if (neu) { titleIn.focus(); return; }

  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.dataset.id;

  if (e.target.closest('td.nr')) {                           // Zeilennummer markiert
    if (e.shiftKey && letzteZeile) {
      const ids = zeilenIds();
      const [a, b] = [ids.indexOf(letzteZeile), ids.indexOf(id)].sort((x, y) => x - y);
      ids.slice(a, b + 1).forEach(x => markiert.add(x));
    } else if (e.metaKey || e.ctrlKey) {
      markiert.has(id) ? markiert.delete(id) : markiert.add(id);
      letzteZeile = id;
    } else {
      markiert = new Set([id]);
      letzteZeile = id;
    }
    aktiv = null;
    renderTabelle();
    return;
  }

  const td = e.target.closest('td[data-k]');
  if (!td) return;
  if (bearbeitet && aktiv && (aktiv.id !== id || aktiv.k !== td.dataset.k)) await bearbeitenBeenden(true);
  markiert.clear();
  setzeAktiv(id, td.dataset.k, aktiv && aktiv.id === id && aktiv.k === td.dataset.k);
});

gitter.addEventListener('dblclick', e => {
  const td = e.target.closest('td[data-k]');
  const tr = e.target.closest('tr[data-id]');
  if (td && tr) setzeAktiv(tr.dataset.id, td.dataset.k, true);
});

gitter.addEventListener('change', e => {
  if (e.target.classList.contains('zf') && e.target.tagName === 'SELECT') bearbeitenBeenden(true);
});

/* Spaltenbreite ziehen */
function breiteZiehen(e, k) {
  const start = e.clientX;
  const th = gitter.querySelector(`th[data-k="${k}"]`);
  const anfang = th.getBoundingClientRect().width;
  const zieh = ev => {
    breiten[k] = Math.max(56, Math.round(anfang + ev.clientX - start));
    const col = gitter.querySelectorAll('col')[SP.findIndex(s => s.k === k) + 1];
    if (col) col.style.width = breiten[k] + 'px';
  };
  const fertig = () => {
    document.removeEventListener('mousemove', zieh);
    document.removeEventListener('mouseup', fertig);
    try { localStorage.setItem('spaltenbreiten', JSON.stringify(breiten)); } catch { /* egal */ }
  };
  document.addEventListener('mousemove', zieh);
  document.addEventListener('mouseup', fertig);
}

/* Tastatur wie im Tabellenblatt */
document.addEventListener('keydown', async e => {
  if (tab !== 'tasks' || ansicht !== 'tabelle') return;
  const imFeld = e.target.classList && e.target.classList.contains('zf');
  if (!imFeld && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;   // Suchfeld usw.

  if (imFeld) {
    if (e.key === 'Escape') { e.preventDefault(); await bearbeitenBeenden(false); }
    else if (e.key === 'Enter') { e.preventDefault(); await bearbeitenBeenden(true); bewege(0, 1); }
    else if (e.key === 'Tab')   { e.preventDefault(); await bearbeitenBeenden(true); bewege(e.shiftKey ? -1 : 1, 0); }
    return;
  }

  if (markiert.size && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    [...markiert].forEach(remove);
    markiert.clear();
    return;
  }
  if (!aktiv) return;

  const taste = e.key;
  if (taste === 'ArrowDown')  { e.preventDefault(); bewege(0, 1); }
  else if (taste === 'ArrowUp')    { e.preventDefault(); bewege(0, -1); }
  else if (taste === 'ArrowRight') { e.preventDefault(); bewege(1, 0); }
  else if (taste === 'ArrowLeft')  { e.preventDefault(); bewege(-1, 0); }
  else if (taste === 'Enter')      { e.preventDefault(); setzeAktiv(aktiv.id, aktiv.k, true); }
  else if (taste === 'Tab')        { e.preventDefault(); bewege(e.shiftKey ? -1 : 1, 0); }
  else if (taste === 'Escape')     { aktiv = null; renderTabelle(); }
  else if (taste === 'Delete' || taste === 'Backspace') {
    e.preventDefault();
    const t = byId(aktiv.id);
    if (t && aktiv.k !== 'title') { await zelleSetzen(t, aktiv.k, ''); renderTabelle(); }
  }
  else if ((e.metaKey || e.ctrlKey) && taste.toLowerCase() === 'c') kopieren(e);
  else if ((e.metaKey || e.ctrlKey) && taste.toLowerCase() === 'v') { /* paste-Ereignis übernimmt */ }
  else if (!e.metaKey && !e.ctrlKey && !e.altKey && taste.length === 1) {
    e.preventDefault();                                       // Tippen startet die Bearbeitung
    const t = byId(aktiv.id);
    const sp = SP.find(s => s.k === aktiv.k);
    if (!t || sp.typ === 'ro') return;
    if (sp.typ === 'text') { t[aktiv.k] = taste; saveTask(t); }
    setzeAktiv(aktiv.id, aktiv.k, true);
  }
});

function bewege(dx, dy) {
  if (!aktiv) return;
  const ids = zeilenIds();
  const zi = ids.indexOf(aktiv.id);
  const si = SP.findIndex(s => s.k === aktiv.k);
  const nz = Math.max(0, Math.min(ids.length - 1, zi + dy));
  const ns = Math.max(0, Math.min(SP.length - 1, si + dx));
  setzeAktiv(ids[nz], SP[ns].k);
}

/* Kopieren: markierte Zeilen, sonst die aktive Zelle – als Tabulator-Text */
function kopieren(e) {
  const zeilen = markiert.size
    ? tabZeilen().filter(z => markiert.has(z.t.id)).map(z => SP.map(s => rohText(z.t, s.k)).join('\t'))
    : aktiv ? [rohText(byId(aktiv.id), aktiv.k)] : [];
  if (!zeilen.length) return;
  const text = zeilen.join('\n');
  if (e && e.clipboardData) e.clipboardData.setData('text/plain', text);
  else navigator.clipboard?.writeText(text).catch(() => {});
  notify(`${pl(zeilen.length, 'Zeile', 'Zeilen')} kopiert`);
}

/* Einfügen: Tabulator-Text füllt ab der aktiven Zelle, neue Zeilen entstehen bei Bedarf */
document.addEventListener('paste', async e => {
  if (tab !== 'tasks' || ansicht !== 'tabelle' || !aktiv) return;
  if (e.target.classList && e.target.classList.contains('zf')) return;
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return;
  e.preventDefault();

  const raster = text.replace(/\r/g, '').split('\n').filter(z => z !== '').map(z => z.split('\t'));
  const ids = zeilenIds();
  let zi = ids.indexOf(aktiv.id);
  const si = SP.findIndex(s => s.k === aktiv.k);
  let neu = 0;

  for (const zeile of raster) {
    let t = ids[zi] ? byId(ids[zi]) : null;
    if (!t) { t = neueAufgabe(zeile[0]?.trim() || 'Ohne Titel'); ids.push(t.id); neu++; }
    for (let j = 0; j < zeile.length && si + j < SP.length; j++) {
      const sp = SP[si + j];
      if (sp.typ !== 'ro') await zelleSetzen(t, sp.k, zeile[j]);
    }
    zi++;
  }
  renderTabelle();
  notify(`${pl(raster.length, 'Zeile', 'Zeilen')} eingefügt${neu ? `, davon ${neu} neu` : ''}`);
});

document.addEventListener('copy', e => {
  if (tab !== 'tasks' || ansicht !== 'tabelle') return;
  if (e.target.classList && e.target.classList.contains('zf')) return;
  if (!aktiv && !markiert.size) return;
  e.preventDefault();
  kopieren(e);
});

/* Ansicht umschalten */
function setAnsicht(w) {
  ansicht = w === 'brett' ? 'brett' : 'tabelle';
  document.body.dataset.view = ansicht;
  $$('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === ansicht));
  try { localStorage.setItem('ansicht', ansicht); } catch { /* egal */ }
  render();
}
$$('[data-view]').forEach(b => b.addEventListener('click', () => setAnsicht(b.dataset.view)));

board.addEventListener('click', e => {
  const k = e.target.dataset.k;
  const sub = e.target.closest('.subs li');
  const karte = e.target.closest('.card');
  if (!karte) {
    const plus = e.target.closest('.colplus');
    if (plus) { titleIn.focus(); neueSpalte = plus.dataset.col; titleIn.placeholder = `Neue Aufgabe in „${SPALTEN.find(s => s.id === plus.dataset.col).name}" …`; }
    return;
  }
  const id = sub ? sub.dataset.id : karte.dataset.id;

  if (k === 't')         { editing = id; render(); }
  else if (k === 'prio') patch(id, { prio: (byId(id).prio + 1) % 3 });
  else if (k === 'more') { openId = openId === id ? null : id; render(); }
  else if (k === 'del')  remove(id);
});

board.addEventListener('change', e => {
  const k = e.target.dataset.k;
  const sub = e.target.closest('.subs li');
  const karte = e.target.closest('.card');
  if (!karte) return;
  const id = sub ? sub.dataset.id : karte.dataset.id;

  if (k === 'subcheck') { const t = byId(id); if (t) { setStatus(t, e.target.checked ? 'done' : 'open'); saveTask(t); render(); } }
  if (k === 'due')  patch(id, { due: e.target.value });
  if (k === 'proj') projektWaehlen(id, e.target.value);
});

board.addEventListener('input', e => {
  if (e.target.dataset.k !== 'note') return;
  const t = byId(e.target.closest('.card').dataset.id);
  if (!t) return;
  t.note = e.target.value;
  saveTask(t, 300);
});

board.addEventListener('keydown', e => {
  const k = e.target.dataset.k;
  if (k === 't' && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    const sub = e.target.closest('.subs li');
    editing = sub ? sub.dataset.id : e.target.closest('.card').dataset.id;
    render();
    return;
  }
  if (k === 'subnew' && e.key === 'Enter') {
    e.preventDefault();
    const titel = e.target.value.trim();
    if (!titel) return;
    neueAufgabe(titel, { parent: e.target.closest('.card').dataset.id });
    e.target.value = '';
    render();
    return;
  }
  if (k !== 'edit') return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.blur(); }
  if (e.key === 'Escape') { editing = null; render(); }
});

board.addEventListener('focusout', e => {
  const k = e.target.dataset.k;
  const karte = e.target.closest('.card');
  if (!karte) return;

  if (k === 'note') { const t = byId(karte.dataset.id); if (t) saveTask(t); return; }
  if (k !== 'edit' || editing === null) return;                   // per Esc schon verworfen

  const t = byId(editing), title = e.target.value.trim();
  editing = null;
  if (t && title && title !== t.title) patch(t.id, { title });
  else render();
});

/* Löschen nimmt Unteraufgaben mit – und bringt sie beim Rückgängig zurück. */
function remove(id) {
  const weg = tasks.filter(t => t.id === id || t.parent === id);
  if (!weg.length) return;
  tasks = tasks.filter(t => !weg.includes(t));
  if (editing === id) editing = null;
  if (openId === id) openId = null;
  render();
  tx('tasks', s => weg.forEach(t => s.delete(t.id))).catch(e => notify('Nicht gelöscht: ' + e));
  offerUndo(weg.length > 1 ? `Gelöscht (mit ${weg.length - 1} Unteraufgaben)` : 'Gelöscht', () => {
    tasks.push(...weg);
    tx('tasks', s => weg.forEach(t => s.put(t))).catch(e => notify('Nicht wiederhergestellt: ' + e));
    render();
  });
}

$('#purge').addEventListener('click', () => {
  const fertig = tasks.filter(t => statusVon(t) === 'done');
  if (!fertig.length) return notify('Nichts zu löschen');
  tasks = tasks.filter(t => !fertig.includes(t));
  render();
  tx('tasks', s => fertig.forEach(t => s.delete(t.id))).catch(e => notify('Nicht gelöscht: ' + e));
  offerUndo(`${fertig.length} gelöscht`, () => {
    tasks.push(...fertig);
    tx('tasks', s => fertig.forEach(t => s.put(t))).catch(e => notify('Nicht wiederhergestellt: ' + e));
    render();
  });
});

qIn.addEventListener('input', () => { query = qIn.value; render(); });

$('#sort').addEventListener('change', e => {
  sort = SORTEN[e.target.value] ? e.target.value : 'manuell';
  try { localStorage.setItem('sort', sort); } catch { /* egal */ }
  render();
});

/* --------------------------------------------------------------- Projekte --- */

const FARBEN = ['#2f6bff', '#e0533d', '#1f9d63', '#b26a00', '#8b5cf6', '#0d9488', '#d946a0', '#5b6472'];

async function projektAnlegen(name) {
  const sauber = String(name).trim().slice(0, 60);
  if (!sauber) return null;
  const da = projekte.find(p => p.name.toLowerCase() === sauber.toLowerCase());
  if (da) return da;
  const p = { id: crypto.randomUUID(), name: sauber, color: FARBEN[projekte.length % FARBEN.length] };
  projekte.push(p);
  await tx('projects', s => s.put(p)).catch(e => notify('Projekt nicht gespeichert: ' + e));
  return p;
}

async function projektWaehlen(id, wert) {
  let ziel = wert;
  if (wert === '+') {
    const name = prompt('Name des neuen Projekts:');
    const p = name ? await projektAnlegen(name) : null;
    ziel = p ? p.id : (byId(id)?.projekt || '');
  }
  const t = byId(id);
  if (!t) return;
  t.projekt = ziel;
  kinderVon(id).forEach(k => { k.projekt = ziel; saveTask(k); });     // Kinder erben
  saveTask(t);
  render();
}

/* Einmalig beim ersten Start: „Kunde – Titel" in ein echtes Projektfeld überführen.
   Nur Präfixe, die mindestens zweimal vorkommen – und mit Rückgängig. */
async function praefixeUebernehmen() {
  try {
    if (localStorage.getItem('praefixe')) return;
    localStorage.setItem('praefixe', '1');
  } catch { return; }
  if (projekte.length) return;

  const teile = t => t.title.match(/^(.{2,40}?)\s+[-–—]\s+(.+)$/);
  const zaehler = new Map();
  for (const t of tasks) {
    const m = teile(t);
    if (m) { const k = m[1].trim().toLowerCase(); zaehler.set(k, (zaehler.get(k) || 0) + 1); }
  }
  const gute = new Set([...zaehler].filter(([, n]) => n >= 2).map(([k]) => k));
  if (!gute.size) return;

  const vorher = tasks.map(t => ({ id: t.id, title: t.title, projekt: t.projekt }));
  let n = 0;
  for (const t of tasks) {
    const m = teile(t);
    if (!m || !gute.has(m[1].trim().toLowerCase())) continue;
    const p = await projektAnlegen(m[1].trim());
    if (!p) continue;
    t.projekt = p.id;
    t.title = m[2].trim();
    n++;
  }
  if (!n) return;
  await tx('tasks', s => tasks.forEach(t => s.put(t))).catch(() => {});
  offerUndo(`${n} Titel auf ${pl(projekte.length, 'Projekt', 'Projekte')} verteilt`, async () => {
    for (const v of vorher) { const t = byId(v.id); if (t) { t.title = v.title; t.projekt = v.projekt; } }
    projekte = [];
    await tx('projects', s => s.clear()).catch(() => {});
    await tx('tasks', s => tasks.forEach(t => s.put(t))).catch(() => {});
    render();
  });
}

function projekteFuellen() {
  const opt = (v, t, sel) => `<option value="${v}"${sel ? ' selected' : ''}>${esc(t)}</option>`;
  $('#newproj').innerHTML = opt('', '— Projekt —', !neuProj)
    + projekte.map(p => opt(p.id, p.name, p.id === neuProj)).join('') + opt('+', '＋ neues …');
  $('#projfilter').innerHTML = opt('', 'Alle Projekte', !projFilter)
    + projekte.map(p => opt(p.id, p.name, p.id === projFilter)).join('');
}

$('#newproj').addEventListener('change', async e => {
  if (e.target.value === '+') {
    const name = prompt('Name des neuen Projekts:');
    const p = name ? await projektAnlegen(name) : null;
    neuProj = p ? p.id : '';
  } else neuProj = e.target.value;
  try { localStorage.setItem('neuProj', neuProj); } catch { /* egal */ }
  projekteFuellen();
  titleIn.focus();
});

$('#projfilter').addEventListener('change', e => { projFilter = e.target.value; render(); });

/* ------------------------------------------------------- Karten verschieben --- */

let kandidat = null, zug = null;

board.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('button,input,textarea,select,a,.subs')) return;
  const karte = e.target.closest('.card');
  if (!karte) return;
  kandidat = { karte, id: karte.dataset.id, x: e.clientX, y: e.clientY };
});

document.addEventListener('pointermove', e => {
  if (kandidat && !zug && Math.abs(e.clientX - kandidat.x) + Math.abs(e.clientY - kandidat.y) > 5) starteZug(e);
  if (!zug) return;
  e.preventDefault();
  zug.el.style.transform = `translate(${e.clientX - zug.dx}px, ${e.clientY - zug.dy}px)`;
  platzSuchen(e.clientX, e.clientY);
});

document.addEventListener('pointerup', () => { if (zug) zugBeenden(); kandidat = null; });

function starteZug(e) {
  const { karte, id } = kandidat;
  const r = karte.getBoundingClientRect();
  const platz = document.createElement('div');
  platz.className = 'platz';
  platz.style.height = r.height + 'px';
  karte.after(platz);

  zug = { id, el: karte, platz, dx: e.clientX - r.left, dy: e.clientY - r.top };
  Object.assign(karte.style, {
    position: 'fixed', left: '0', top: '0', width: r.width + 'px',
    transform: `translate(${r.left}px, ${r.top}px)`, zIndex: '50', pointerEvents: 'none',
  });
  karte.classList.add('zieht');
  document.body.appendChild(karte);
}

function platzSuchen(x, y) {
  const spalte = [...board.querySelectorAll('.col')].find(c => {
    const r = c.getBoundingClientRect();
    return x >= r.left && x <= r.right;
  });
  if (!spalte) return;
  const kasten = spalte.querySelector('.cards');
  let vor = null;
  for (const k of kasten.querySelectorAll('.card')) {
    const r = k.getBoundingClientRect();
    if (y < r.top + r.height / 2) { vor = k; break; }
  }
  if (vor) kasten.insertBefore(zug.platz, vor); else kasten.appendChild(zug.platz);
}

function zugBeenden() {
  const kasten = zug.platz.closest('.cards');
  const neuStatus = kasten ? kasten.dataset.col : null;
  const index = [...kasten.children].filter(el => el.classList.contains('card') || el === zug.platz).indexOf(zug.platz);

  zug.el.remove();
  zug.platz.remove();
  const t = byId(zug.id);
  zug = null;
  if (!t || !neuStatus) return render();

  setStatus(t, neuStatus);
  const spalte = sichtbar().filter(x => statusVon(x) === neuStatus && x.id !== t.id).sort(order);
  spalte.splice(Math.max(0, index), 0, t);
  spalte.forEach((x, i) => { x.ord = (i + 1) * 1000; x.updated = Date.now(); });

  if (sort !== 'manuell') {                       // Ziehen heißt: ab jetzt eigene Reihenfolge
    sort = 'manuell';
    $('#sort').value = 'manuell';
    try { localStorage.setItem('sort', sort); } catch { /* egal */ }
  }
  tx('tasks', s => spalte.forEach(x => s.put(x))).catch(e => notify('Nicht gespeichert: ' + e));
  render();
}

/* =============================================================== TEXT ====== */

const textOf = html => html.replace(/<[^>]*>/g, ' ');

function renderDocs() {
  $('#editor').hidden = !curDoc;
  $('#nodocs').hidden = !!curDoc;
  renderTree();
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
  letzteStelle = null;                                  // Bereich aus dem alten Dokument wäre ungültig
  editor.innerHTML = curDoc.html || '';
  const geflickt = repair(editor);
  ensureTail();
  await bindImages();
  dirty = false;
  if (geflickt) { dirty = true; saveDoc(); notify(`${pl(geflickt, 'verschachtelter Block', 'verschachtelte Blöcke')} aufgelöst`); }
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
const istListe = t => t === 'UL' || t === 'OL';

/* Der Block, in dem der Cursor steht – immer als direktes Kind des Editors. */
function topBlock() {
  const sel = getSelection();
  let n = blockOf(sel && sel.anchorNode);
  if (!n || !editor.contains(n) || n === editor) return null;
  while (n.parentElement && n.parentElement !== editor) n = n.parentElement;
  return n.parentElement === editor ? n : null;
}

const caretToEnd = node => {
  const r = document.createRange();
  r.selectNodeContents(node);
  r.collapse(false);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
};

/* Ganz unten steht immer ein normaler Absatz – sonst sitzt man in einem
   Code-Block oder hinter einem Bild fest und kommt nicht mehr darunter. */
function ensureTail() {
  const last = editor.lastElementChild;
  if (!last || /^(PRE|BLOCKQUOTE|UL|OL|HR|IMG|FIGURE|TABLE)$/.test(last.tagName)) {
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    editor.appendChild(p);
  }
}

/* Aus einem Block heraus in einen neuen Absatz darunter. */
function leaveBlock(block) {
  const p = document.createElement('p');
  p.appendChild(document.createElement('br'));
  block.after(p);
  caretToEnd(p);
  touch(); syncToolbar();
}

/* Blockart setzen: eigener Austausch statt formatBlock – das verschachtelt
   sonst <pre> in <pre>. Nochmal derselbe Knopf schaltet zurück auf Absatz. */
function setBlock(tag) {
  const block = topBlock();
  if (!block) { exec('formatBlock', `<${tag}>`); ensureTail(); return; }

  if (istListe(block.tagName)) {                       // erst aus der Liste heraus
    exec(block.tagName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList');
    const jetzt = topBlock();
    if (jetzt && !istListe(jetzt.tagName) && jetzt.tagName.toLowerCase() !== tag) setBlock(tag);
    return;
  }

  const ist = block.tagName.toLowerCase();
  const ziel = (ist === tag && (tag === 'pre' || tag === 'blockquote')) ? 'p' : tag;
  if (ist === ziel) return;

  const neu = document.createElement(ziel);
  neu.innerHTML = ist === 'pre' ? block.innerHTML.replace(/\n/g, '<br>') : block.innerHTML;
  if (!neu.textContent.trim() && !neu.querySelector('img,br')) neu.appendChild(document.createElement('br'));
  block.replaceWith(neu);
  caretToEnd(neu);
  ensureTail();
}

function command(cmd) {
  editor.focus();
  switch (cmd) {
    case 'h1': case 'h2': case 'h3': case 'p': case 'pre': setBlock(cmd); break;
    case 'quote': setBlock('blockquote'); break;
    case 'bold':  exec('bold'); break;
    case 'italic':exec('italic'); break;
    case 'ul': case 'ol': {
      const block = topBlock();
      if (block && block.tagName === 'PRE') setBlock('p');       // erst zurück in einen Absatz
      exec(cmd === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
      ensureTail();
      break;
    }
    case 'hr': exec('insertHorizontalRule'); ensureTail(); break;
    case 'code': {
      const sel = getSelection();
      const text = sel && sel.toString();
      if (text) exec('insertHTML', `<code>${esc(text)}</code>`);
      break;
    }
  }
  touch(); syncToolbar();
}

/* Verschachtelten Murks aus älteren Dokumenten wieder geradeziehen. */
function repair(root) {
  let n = 0;
  for (const el of root.querySelectorAll('pre pre, blockquote blockquote, p p')) {
    el.replaceWith(...el.childNodes); n++;
  }
  for (const el of root.querySelectorAll('pre ul, pre ol, pre h1, pre h2, pre h3, pre blockquote')) {
    const pre = el.closest('pre');
    if (pre) { pre.after(el); n++; }
  }
  for (const el of root.querySelectorAll('p > ul, p > ol, p > pre')) {   // Blöcke gehören nicht in einen Absatz
    el.parentElement.after(el); n++;
  }
  for (const el of root.querySelectorAll('pre, blockquote, li')) {
    if (!el.textContent.trim() && !el.querySelector('img,hr')) { el.remove(); n++; }
  }
  for (const el of root.querySelectorAll('ul, ol')) if (!el.children.length) { el.remove(); n++; }
  return n;
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

editor.addEventListener('input', () => { ensureTail(); touch(); });
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

/* Endet der Block auf einer leeren Zeile? Dann ist das zweite Enter der Ausstieg. */
function letzterUmbruch(block) {
  const last = block.lastChild;
  if (last && last.nodeName === 'BR') return last;
  if (last && last.nodeType === 3 && /\n[ \t]*$/.test(last.nodeValue)) return last;
  return null;
}

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
    const block = topBlock();
    if (!block) return;
    const eingesperrt = block.tagName === 'PRE' || block.tagName === 'BLOCKQUOTE';

    if (eingesperrt && (e.metaKey || e.ctrlKey)) {   // ⌘Enter: immer raus
      e.preventDefault();
      leaveBlock(block);
      return;
    }
    if (eingesperrt && atEnd(block) && letzterUmbruch(block)) {
      e.preventDefault();                            // zweites Enter am Ende: raus
      let u;                                         // alle leeren Zeilen am Ende weg
      while ((u = letzterUmbruch(block))) {
        if (u.nodeType === 3) { u.nodeValue = u.nodeValue.replace(/\n[ \t]*$/, ''); break; }
        u.remove();
      }
      leaveBlock(block);
      return;
    }
    if (block.tagName === 'PRE') {                   // sonst: Zeilenumbruch im Block
      e.preventDefault();
      exec('insertText', '\n');
      touch();
      return;
    }
    if (/^H[123]$/.test(block.tagName) && atEnd(block)) {
      e.preventDefault();                            // nach einer Überschrift: normaler Absatz
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

/* Letzte Cursorstelle im Dokument merken – daran hängt das Einfügen von
   Diagrammen, nachdem man zwischendurch im Reiter Diagramme war. */
let letzteStelle = null;

document.addEventListener('selectionchange', () => {
  const s = getSelection();
  if (s && s.rangeCount && editor.contains(s.anchorNode)) letzteStelle = s.getRangeAt(0).cloneRange();
  later('tb', 40, syncToolbar);
});

$('#toolbar').addEventListener('mousedown', e => {
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();                                    // Auswahl im Editor nicht verlieren
  command(b.dataset.cmd);
});

/* Anlegen, Öffnen und Löschen laufen über den Baum in der linken Leiste. */

/* =========================================================== DIAGRAMME ===== */

const canvas = $('#canvas'), diaTitle = $('#diatitle');
const GRID = 10, BREITE = 1500, HOEHE = 950;

let dias = [], curDia = null, auswahl = null, verbindeVon = null, verbindeModus = false, zieht = null;
let zoom = 1;

const TINTE = { box:'#ffffff', round:'#f2f6ff', db:'#f7f3ff', ext:'#fafbfc' };
const knoten = id => curDia && curDia.nodes.find(n => n.id === id);

/* Beschriftung auf höchstens vier Zeilen umbrechen und daraus die Größe ableiten. */
function umbrechen(text, max = 24) {
  const worte = String(text || '').split(/\s+/).filter(Boolean);
  if (!worte.length) return [''];
  const zeilen = [];
  let z = '';
  for (const w of worte) {
    if (!z) z = w;
    else if ((z + ' ' + w).length <= max) z += ' ' + w;
    else { zeilen.push(z); z = w; }
  }
  zeilen.push(z);
  return zeilen.slice(0, 4);
}

function messen(n) {
  const zeilen = umbrechen(n.text);
  const breit = Math.max(...zeilen.map(z => z.length));
  n.w = Math.max(130, Math.min(290, Math.round(breit * 7.9 + 32)));
  n.h = Math.max(48, 26 + zeilen.length * 18) + (n.shape === 'db' ? 12 : 0);
  return zeilen;
}

/* Punkt auf dem Rand von n in Richtung (tx,ty) – dort setzt der Pfeil an. */
function randpunkt(n, tx, ty) {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const s = Math.min(dx ? (n.w / 2 + 4) / Math.abs(dx) : 1e9, dy ? (n.h / 2 + 4) / Math.abs(dy) : 1e9);
  return [cx + dx * s, cy + dy * s];
}

function form(n, aktiv) {
  const rand = aktiv ? '#2f6bff' : '#c3ccdb';
  const dick = aktiv ? 2 : 1.4;
  const füll = TINTE[n.shape] || '#fff';
  if (n.shape === 'db') {
    const r = 10;
    return `<path d="M0 ${r} a ${n.w / 2} ${r} 0 0 1 ${n.w} 0 v ${n.h - 2 * r} a ${n.w / 2} ${r} 0 0 1 ${-n.w} 0 z" fill="${füll}" stroke="${rand}" stroke-width="${dick}"/>`
         + `<path d="M0 ${r} a ${n.w / 2} ${r} 0 0 0 ${n.w} 0" fill="none" stroke="${rand}" stroke-width="1.1" opacity=".6"/>`;
  }
  const rx = n.shape === 'round' ? 15 : 4;
  const strich = n.shape === 'ext' ? ' stroke-dasharray="6 4"' : '';
  return `<rect width="${n.w}" height="${n.h}" rx="${rx}" fill="${füll}" stroke="${rand}" stroke-width="${dick}"${strich}/>`;
}

function inhalt(d, aktivId) {
  const teile = [];

  for (const e of d.edges) {
    const a = d.nodes.find(n => n.id === e.from), b = d.nodes.find(n => n.id === e.to);
    if (!a || !b) continue;
    const [x1, y1] = randpunkt(a, b.x + b.w / 2, b.y + b.h / 2);
    const [x2, y2] = randpunkt(b, a.x + a.w / 2, a.y + a.h / 2);
    const aktiv = e.id === aktivId;
    teile.push(`<line data-e="${e.id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${aktiv ? '#2f6bff' : '#8f97a6'}" stroke-width="${aktiv ? 2.2 : 1.6}" marker-end="url(#pfeil)"${e.dashed ? ' stroke-dasharray="5 4"' : ''}/>`);
    if (e.text) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, br = e.text.length * 6.6 + 12;
      teile.push(`<rect x="${mx - br / 2}" y="${my - 9.5}" width="${br}" height="19" rx="5" fill="#fff" stroke="#e7e9ee"/>`
               + `<text data-e="${e.id}" x="${mx}" y="${my + 4}" text-anchor="middle" font-size="11.5" fill="#767d8a">${esc(e.text)}</text>`);
    }
  }

  for (const n of d.nodes) {
    const zeilen = messen(n);
    const aktiv = n.id === aktivId || n.id === verbindeVon;
    const oben = n.h / 2 - (zeilen.length - 1) * 9 + 4 + (n.shape === 'db' ? 4 : 0);
    const text = zeilen.map((z, i) =>
      `<tspan x="${n.w / 2}" y="${oben + i * 18}">${esc(z)}</tspan>`).join('');
    teile.push(`<g data-n="${n.id}" transform="translate(${n.x},${n.y})" style="cursor:move">
      ${form(n, aktiv)}
      <text text-anchor="middle" font-size="13" fill="#14161b"
            font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif">${text}</text>
    </g>`);
  }
  return teile.join('');
}

const PFEIL = `<defs><marker id="pfeil" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"
  orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#8f97a6"/></marker></defs>`;

/* Ein eingebettetes SVG erbt nichts von der Seite – Schrift muss hinein. */
const SCHRIFT = 'font-family="system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"';

/* Fürs Einbetten: eng zugeschnitten, ohne Auswahl-Hervorhebung. */
function svgOf(d) {
  if (!d.nodes.length) return `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>`;
  d.nodes.forEach(messen);
  const rand = 16;
  const x0 = Math.min(...d.nodes.map(n => n.x)) - rand;
  const y0 = Math.min(...d.nodes.map(n => n.y)) - rand;
  const x1 = Math.max(...d.nodes.map(n => n.x + n.w)) + rand;
  const y1 = Math.max(...d.nodes.map(n => n.y + n.h)) + rand;
  const w = Math.round(x1 - x0), h = Math.round(y1 - y0);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x0} ${y0} ${w} ${h}" ${SCHRIFT}>`
       + `${PFEIL}<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#fff"/>${inhalt(d, null)}</svg>`;
}

function renderDia() {
  if (!curDia) { canvas.innerHTML = ''; return; }
  canvas.innerHTML = `<svg width="${Math.round(BREITE * zoom)}" height="${Math.round(HOEHE * zoom)}"`
                   + ` viewBox="0 0 ${BREITE} ${HOEHE}" ${SCHRIFT}>${PFEIL}${inhalt(curDia, auswahl)}</svg>`;
  $('#dia-connect').classList.toggle('on', verbindeModus);
  $('#diazoom').textContent = Math.round(zoom * 100) + ' %';
}

function renderDiaList() {
  $('#diaeditor').hidden = !curDia;
  $('#nodias').hidden = !!curDia;
  renderTree();
}

function saveDia(delay = 250) {
  if (!curDia) return;
  const d = curDia;
  d.title = diaTitle.value;
  d.updated = Date.now();
  $('#diasaved').textContent = '…';
  later('dia', delay, () => tx('diagrams', s => s.put(d))
    .then(() => { $('#diasaved').textContent = 'gespeichert'; renderDiaList(); })
    .catch(e => notify('Nicht gespeichert: ' + e)));
}
const flushDia = () => { clearTimeout(timers.get('dia')); if (curDia) saveDia(0); };

function openDia(id) {
  flushDia();
  curDia = dias.find(d => d.id === id) || null;
  auswahl = null; verbindeVon = null;
  if (curDia) diaTitle.value = curDia.title;
  renderDia(); renderDiaList();
  $('#diasaved').textContent = 'gespeichert';
  try { localStorage.setItem('lastDia', id); } catch { /* egal */ }
}

function newDia() {
  flushDia();
  const d = { id: crypto.randomUUID(), title: '', nodes: [], edges: [], created: Date.now(), updated: Date.now() };
  dias.push(d);
  curDia = d; auswahl = null; verbindeVon = null;
  diaTitle.value = '';
  tx('diagrams', s => s.put(d)).catch(e => notify('Nicht angelegt: ' + e));
  renderDia(); renderDiaList();
  diaTitle.focus();
}

function delDia(id) {
  const i = dias.findIndex(d => d.id === id);
  if (i < 0) return;
  const [weg] = dias.splice(i, 1);
  tx('diagrams', s => s.delete(id)).catch(e => notify('Nicht gelöscht: ' + e));
  if (curDia && curDia.id === id) {
    curDia = null;
    const naechstes = [...dias].sort((a, b) => b.updated - a.updated)[0];
    if (naechstes) openDia(naechstes.id); else { diaTitle.value = ''; renderDia(); renderDiaList(); }
  } else renderDiaList();
  offerUndo('Diagramm gelöscht', () => {
    dias.push(weg);
    tx('diagrams', s => s.put(weg)).catch(e => notify('Nicht wiederhergestellt: ' + e));
    curDia = null; openDia(weg.id);
  });
}

/* --- Bausteine ------------------------------------------------------------ */

function addNode(shape) {
  if (!curDia) return;
  const n = { id: crypto.randomUUID(), shape, text: SHAPE_NAME[shape], x: 60, y: 60, w: 140, h: 48 };
  // freien Platz suchen: spaltenweise von oben nach unten
  const belegt = (x, y) => curDia.nodes.some(m => Math.abs(m.x - x) < 170 && Math.abs(m.y - y) < 80);
  let x = 60, y = 60;
  while (belegt(x, y)) { y += 90; if (y > HOEHE - 140) { y = 60; x += 200; } }
  n.x = x; n.y = y;
  curDia.nodes.push(n);
  auswahl = n.id;
  renderDia(); saveDia();
  beschriften(n.id);
}

const SHAPE_NAME = { box: 'Kasten', round: 'Komponente', db: 'Datenbank', ext: 'Externes System' };

function verbinde(zielId) {
  if (!verbindeVon) { verbindeVon = zielId; renderDia(); return; }
  if (verbindeVon !== zielId &&
      !curDia.edges.some(e => e.from === verbindeVon && e.to === zielId)) {
    curDia.edges.push({ id: crypto.randomUUID(), from: verbindeVon, to: zielId, text: '', dashed: false });
    saveDia();
  }
  verbindeVon = zielId;                     // Kette weiterbauen: Ziel wird neue Quelle
  renderDia();
}

function loeschen() {
  if (!curDia || !auswahl) return;
  const vorher = curDia.nodes.length + curDia.edges.length;
  curDia.nodes = curDia.nodes.filter(n => n.id !== auswahl);
  curDia.edges = curDia.edges.filter(e => e.id !== auswahl && e.from !== auswahl && e.to !== auswahl);
  if (curDia.nodes.length + curDia.edges.length !== vorher) { auswahl = null; renderDia(); saveDia(); }
}

/* Beschriftung: kleines Eingabefeld direkt über dem Element. */
function beschriften(id) {
  const n = knoten(id), e = curDia.edges.find(x => x.id === id);
  if (!n && !e) return;
  const alt = canvas.querySelector('.dialabel');
  if (alt) alt.remove();

  const feld = document.createElement('input');
  feld.className = 'dialabel';
  feld.value = (n || e).text;
  feld.maxLength = 120;
  if (n) {                                            // Position folgt dem Zoom
    feld.style.left = (n.x * zoom) + 'px';
    feld.style.top = ((n.y + n.h / 2) * zoom - 15) + 'px';
    feld.style.width = Math.max(n.w * zoom, 150) + 'px';
  } else {
    const a = knoten(e.from), b = knoten(e.to);
    feld.style.left = (((a.x + b.x) / 2 + 20) * zoom) + 'px';
    feld.style.top = (((a.y + b.y) / 2 + 20) * zoom) + 'px';
    feld.style.width = '160px';
  }
  canvas.appendChild(feld);
  feld.focus(); feld.select();

  const fertig = speichern => {
    if (speichern) { (n || e).text = feld.value.trim(); saveDia(); }
    feld.remove();
    renderDia();
  };
  feld.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); fertig(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); fertig(false); }
  });
  feld.addEventListener('blur', () => fertig(true));
}

/* --- Maus ----------------------------------------------------------------- */

const punkt = e => {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left + canvas.scrollLeft) / zoom, y: (e.clientY - r.top + canvas.scrollTop) / zoom };
};

canvas.addEventListener('pointerdown', e => {
  if (!curDia || e.target.closest('.dialabel')) return;
  const g = e.target.closest('[data-n]'), l = e.target.closest('[data-e]');

  if (g) {
    const id = g.dataset.n;
    if (verbindeModus) { verbinde(id); return; }
    auswahl = id;
    const n = knoten(id), p = punkt(e);
    zieht = { id, dx: p.x - n.x, dy: p.y - n.y, bewegt: false };
    canvas.setPointerCapture(e.pointerId);
    renderDia();
  } else if (l) {
    auswahl = l.dataset.e; verbindeVon = null; renderDia();
  } else {
    auswahl = null; verbindeVon = null; renderDia();
  }
});

canvas.addEventListener('pointermove', e => {
  if (!zieht) return;
  const n = knoten(zieht.id);
  if (!n) return;
  const p = punkt(e);
  const x = Math.max(0, Math.min(BREITE - n.w, Math.round((p.x - zieht.dx) / GRID) * GRID));
  const y = Math.max(0, Math.min(HOEHE - n.h, Math.round((p.y - zieht.dy) / GRID) * GRID));
  if (x === n.x && y === n.y) return;
  n.x = x; n.y = y; zieht.bewegt = true;
  later('diaframe', 0, renderDia);
});

canvas.addEventListener('pointerup', () => {
  if (!zieht) return;
  if (zieht.bewegt) saveDia();
  zieht = null;
});

canvas.addEventListener('dblclick', e => {
  const g = e.target.closest('[data-n]'), l = e.target.closest('[data-e]');
  if (g) beschriften(g.dataset.n);
  else if (l) beschriften(l.dataset.e);
});

$$('[data-add]').forEach(b => b.addEventListener('click', () => addNode(b.dataset.add)));
$('#dia-del').addEventListener('click', loeschen);
$('#dia-connect').addEventListener('click', () => {
  verbindeModus = !verbindeModus;
  verbindeVon = null;
  renderDia();
});
$('#dia-dash').addEventListener('click', () => {
  const e = curDia && curDia.edges.find(x => x.id === auswahl);
  if (!e) return notify('Erst einen Pfeil anklicken');
  e.dashed = !e.dashed;
  renderDia(); saveDia();
});
diaTitle.addEventListener('input', () => saveDia(400));

/* Strg/⌘ + Rad (oder Zwei-Finger-Zoom) vergrößert die Zeichenfläche. */
canvas.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const vor = zoom;
  zoom = Math.max(0.3, Math.min(2.5, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  if (zoom === vor) return;
  const r = canvas.getBoundingClientRect();
  const zx = e.clientX - r.left, zy = e.clientY - r.top;      // Punkt unter dem Zeiger festhalten
  const px = (canvas.scrollLeft + zx) / vor, py = (canvas.scrollTop + zy) / vor;
  renderDia();
  canvas.scrollLeft = px * zoom - zx;
  canvas.scrollTop = py * zoom - zy;
}, { passive: false });

$('#diazoom').addEventListener('click', () => { zoom = 1; renderDia(); canvas.scrollTo({ left: 0, top: 0 }); });

/* --- Ins Dokument einbetten ----------------------------------------------- */

/* Steht der Cursor auf einer Einbettung dieses Diagramms? Nur dann wird
   überschrieben – eine Zeile weiter unten kommt bewusst ein zweites Bild. */
function einbettungAmCursor(sel) {
  const r = letzteStelle;
  if (!r || !editor.contains(r.startContainer)) return null;
  const passt = k => k && k.nodeType === 1 && k.matches && k.matches(sel);

  if (r.startContainer.nodeType === 1) {                    // Cursor direkt neben dem Bild
    const kinder = r.startContainer.childNodes;
    for (const i of [r.startOffset, r.startOffset - 1]) if (passt(kinder[i])) return kinder[i];
  }
  const el = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
  if (passt(el)) return el;

  const block = el && el.closest ? el.closest('#doc > *') : null;   // gleicher Absatz
  if (block) return passt(block) ? block : block.querySelector(sel);
  return null;
}

$('#dia-insert').addEventListener('click', async () => {
  if (!curDia || !curDia.nodes.length) return notify('Diagramm ist leer');
  if (!curDoc) return notify('Erst ein Dokument im Reiter Text anlegen');
  flushDia();

  const id = 'dia:' + curDia.id;
  const wahl = `img[data-img="${id}"]`;
  const blob = new Blob([svgOf(curDia)], { type: 'image/svg+xml' });
  await tx('images', s => s.put({ id, blob })).catch(e => notify('Nicht gespeichert: ' + e));

  if (imgUrls.has(id)) URL.revokeObjectURL(imgUrls.get(id));
  const url = URL.createObjectURL(blob);
  imgUrls.set(id, url);
  editor.querySelectorAll(wahl).forEach(el => { el.src = url; });   // alle Kopien aktuell halten

  const treffer = einbettungAmCursor(wahl);
  setTab('text');

  if (treffer) {
    notify('Diagramm an der Cursorstelle aktualisiert');
  } else {
    editor.focus();
    const s = getSelection();
    if (letzteStelle && editor.contains(letzteStelle.startContainer)) {
      s.removeAllRanges();
      s.addRange(letzteStelle);                              // dort einfügen, wo zuletzt geschrieben wurde
    } else {
      ensureTail();
      caretToEnd(editor.lastElementChild);
    }
    exec('insertHTML', `<img data-img="${id}" src="${url}" alt="${esc(curDia.title || 'Diagramm')}">`);
    ensureTail();
    notify('Diagramm an der Cursorstelle eingefügt');
  }
  touch(); flushDoc();
});

$('#exportsvg').addEventListener('click', () => {
  if (!curDia || !curDia.nodes.length) return notify('Diagramm ist leer');
  flushDia();
  download(svgOf(curDia), `${(curDia.title || 'diagramm').replace(/[^\wäöüÄÖÜß .-]+/g, '_').trim()}.svg`, 'image/svg+xml');
});

/* ============================================================== REITER ===== */

function setTab(name) {
  if (name !== 'text') flushDoc();
  if (name !== 'dia') flushDia();
  tab = name;
  document.body.dataset.tab = name;
  $$('.maintabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  for (const v of ['tasks', 'text', 'dia']) {
    $('#v-' + v).hidden = v !== name;
    $('#keys-' + v).hidden = v !== name;
    const leiste = $('#rail-' + v);
    if (leiste) leiste.hidden = v !== name;
  }
  updateCount();
  try { localStorage.setItem('tab', name); } catch { /* egal */ }
  if (name === 'text' && curDoc) { markEmpty(); countWords(); }
  if (name === 'dia') renderDia();
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
  status: ['open', 'doing', 'done'].includes(t.status) ? t.status : (t.done ? 'done' : 'open'),
  projekt: typeof t.projekt === 'string' ? t.projekt : '',
  parent: typeof t.parent === 'string' ? t.parent : null,
  ord: Number(t.ord) || Number(t.created) || Date.now(),
  prio: [0, 1, 2].includes(t.prio) ? t.prio : 0,
  due: /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : '',
  created: Number(t.created) || Date.now(),
  updated: Date.now(),
});

const cleanDia = g => ({
  id: typeof g.id === 'string' && g.id ? g.id : crypto.randomUUID(),
  title: String(g.title ?? '').slice(0, 200),
  nodes: g.nodes.filter(n => n && typeof n.id === 'string').map(n => ({
    id: n.id,
    shape: SHAPE_NAME[n.shape] ? n.shape : 'box',
    text: String(n.text ?? '').slice(0, 120),
    x: Number(n.x) || 0, y: Number(n.y) || 0,
    w: Number(n.w) || 140, h: Number(n.h) || 48,
  })),
  edges: (Array.isArray(g.edges) ? g.edges : []).filter(e => e && e.from && e.to).map(e => ({
    id: typeof e.id === 'string' && e.id ? e.id : crypto.randomUUID(),
    from: e.from, to: e.to,
    text: String(e.text ?? '').slice(0, 120),
    dashed: !!e.dashed,
  })),
  created: Number(g.created) || Date.now(),
  updated: Number(g.updated) || Date.now(),
});

const cleanDoc = d => ({
  id: typeof d.id === 'string' && d.id ? d.id : crypto.randomUUID(),
  title: String(d.title ?? '').slice(0, 200),
  html: sanitize(d.html ?? ''),
  created: Number(d.created) || Date.now(),
  updated: Number(d.updated) || Date.now(),
});

$('#export').addEventListener('click', async () => {
  flushDoc(); flushDia();
  const bilder = [];
  for (const i of (await all('images')) || [])
    bilder.push({ id: i.id, data: await toDataURL(i.blob) });
  download(JSON.stringify({ app: 'aufgaben', version: 4, tasks, projects: projekte, docs, diagrams: dias, images: bilder }, null, 1),
           `sicherung-${todayISO()}.json`);
  notify(`${pl(tasks.length, 'Aufgabe', 'Aufgaben')}, ${pl(docs.length, 'Dokument', 'Dokumente')}, ${pl(dias.length, 'Diagramm', 'Diagramme')}, ${pl(bilder.length, 'Bild', 'Bilder')} gesichert`);
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
    const gRows = (alt ? [] : data.diagrams || []).filter(g => g && Array.isArray(g.nodes)).map(cleanDia);
    if (!tRows.length && !dRows.length && !gRows.length) throw new Error('nichts Brauchbares enthalten');

    const pRows = (alt ? [] : data.projects || []).filter(p => p && typeof p.name === 'string').map(p => ({
      id: typeof p.id === 'string' && p.id ? p.id : crypto.randomUUID(),
      name: String(p.name).slice(0, 60),
      color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : FARBEN[0],
    }));
    if (pRows.length) await tx('projects', s => pRows.forEach(p => s.put(p)));
    if (tRows.length) await tx('tasks', s => tRows.forEach(t => s.put(t)));
    if (dRows.length) await tx('docs',  s => dRows.forEach(d => s.put(d)));
    if (gRows.length) await tx('diagrams', s => gRows.forEach(g => s.put(g)));
    for (const im of iRows) {
      const blob = await (await fetch(im.data)).blob();
      await tx('images', s => s.put({ id: im.id, blob }));
    }

    tasks = await all('tasks');
    projekte = await all('projects');
    docs = await all('docs');
    dias = await all('diagrams');
    curDoc = null; curDia = null;
    releaseImages();
    render(); renderDocs(); renderDiaList();
    const neuestes = [...docs].sort((a, b) => b.updated - a.updated)[0];
    if (neuestes) await openDoc(neuestes.id);
    const neuestesDia = [...dias].sort((a, b) => b.updated - a.updated)[0];
    if (neuestesDia) openDia(neuestesDia.id);
    notify(`${pl(tRows.length, 'Aufgabe', 'Aufgaben')}, ${pl(dRows.length, 'Dokument', 'Dokumente')}, ${pl(gRows.length, 'Diagramm', 'Diagramme')}, ${pl(iRows.length, 'Bild', 'Bilder')} übernommen`);
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

  if (tab === 'dia' && !typing) {                    // Diagramm-Tastatur
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); loeschen(); return; }
    if (e.key === 'Enter' && auswahl) { e.preventDefault(); beschriften(auswahl); return; }
    if (e.key === 'Escape') { auswahl = null; verbindeVon = null; verbindeModus = false; renderDia(); return; }
  }

  if (e.key === 'Escape') {
    if (e.target.isContentEditable) { e.target.blur(); return; }
    if (editing !== null) { editing = null; render(); }
    else if (typing && e.target.value !== '') { e.target.value = ''; e.target.dispatchEvent(new Event('input')); }
    else if (typing) e.target.blur();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || tab !== 'tasks') return;
  if (ansicht === 'tabelle' && aktiv) return;      // in der Tabelle tippt man in die Zelle

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
  tasks = (await all('tasks')).map(t => ({
    note: '', due: '', prio: 0, projekt: '', parent: null,
    status: t.done ? 'done' : 'open', ord: t.created || Date.now(), ...t,
  }));
  docs  = (await all('docs')).map(d => ({ title: '', html: '', ...d }));
  dias  = (await all('diagrams')).map(d => ({ title: '', nodes: [], edges: [], ...d }));
  projekte = await all('projects');
  await praefixeUebernehmen();

  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* egal */ }

  let gemerkteAnsicht = 'tabelle';
  try { gemerkteAnsicht = localStorage.getItem('ansicht') || 'tabelle'; } catch { /* egal */ }
  setAnsicht(gemerkteAnsicht);

  renderDocs();
  renderDiaList();

  let letztes = null, letztesDia = null, reiter = 'tasks';
  try {
    letztes = localStorage.getItem('lastDoc');
    letztesDia = localStorage.getItem('lastDia');
    reiter = localStorage.getItem('tab') || 'tasks';
    neuProj = localStorage.getItem('neuProj') || '';
    breiten = JSON.parse(localStorage.getItem('spaltenbreiten') || '{}');
    const s = localStorage.getItem('sort');
    if (SORTEN[s]) { sort = s; $('#sort').value = s; }
  } catch { /* egal */ }

  const start = docs.find(d => d.id === letztes) || [...docs].sort((a, b) => b.updated - a.updated)[0];
  if (start) await openDoc(start.id);

  const startDia = dias.find(d => d.id === letztesDia) || [...dias].sort((a, b) => b.updated - a.updated)[0];
  if (startDia) openDia(startDia.id);

  setTab(['text', 'dia'].includes(reiter) ? reiter : 'tasks');

  sweepImages();
  navigator.storage?.persist?.()?.catch(() => {});   // Browser soll die Daten nicht wegräumen
}).catch(fail);
