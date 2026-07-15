const DEFAULT_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbyh1BqVN_uOqyHWw0zPxxSdqAIDKtapr0hQMvivgSc1TOidLOEem5muvh-Q2r3sbziTdQ/exec';
const DEFAULT_TOKEN = 'warehouse_secret_2026'; // <- put the value you set in Script Properties

let webAppUrl = DEFAULT_WEBAPP_URL;
let accessToken = DEFAULT_TOKEN;
let connected = false;

// ========== Edit lock ==========
// This is a front-end convenience lock only — it hides the editing controls from
// casual visitors. It does NOT stop someone who reads script.js and calls the
// Apps Script API directly with the token above. See chat notes for the real fix.
//
// SHA-256 hash of the current passcode ("shoplayout2026" by default).
// To change the passcode: open this page's browser console and run
//   crypto.subtle.digest('SHA-256', new TextEncoder().encode('yourNewPasscode'))
//     .then(b => console.log([...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('')))
// then paste the printed hash in as EDIT_PASSCODE_HASH below.
const EDIT_PASSCODE_HASH = 'd740b3968a92fdb9dd59457a00cdaddd2cc0c5022eeea76883a4847beee4ccbb';

let editUnlocked = false; // always starts locked on load/refresh, by design

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function updateLockUI() {
  document.body.classList.toggle('locked', !editUnlocked);
  const status = document.getElementById('lock-status');
  const unlockBtn = document.getElementById('unlock-btn');
  const lockBtn = document.getElementById('lock-btn');
  if (editUnlocked) {
    status.textContent = '🔓 Editing unlocked for this session';
    status.classList.remove('locked'); status.classList.add('unlocked');
    unlockBtn.style.display = 'none';
    lockBtn.style.display = 'block';
  } else {
    status.textContent = '🔒 View-only — editing is locked';
    status.classList.remove('unlocked'); status.classList.add('locked');
    unlockBtn.style.display = 'block';
    lockBtn.style.display = 'none';
  }
}

document.getElementById('unlock-btn').addEventListener('click', async function() {
  const attempt = prompt('Enter passcode to unlock editing:');
  if (attempt === null) return;
  const hash = await sha256Hex(attempt.trim());
  if (hash === EDIT_PASSCODE_HASH) {
    editUnlocked = true;
    updateLockUI();
    render();
    if (selectedId) { const el = elements.find(e => e.id === selectedId); if (el) renderDetail(el); }
  } else {
    alert('Incorrect passcode.');
  }
});

document.getElementById('lock-btn').addEventListener('click', function() {
  editUnlocked = false;
  updateLockUI();
  if (selectedId) { const el = elements.find(e => e.id === selectedId); if (el) renderDetail(el); }
});

updateLockUI();

// ========== Side panel toggle ==========
(function() {
  const toggleBtn = document.getElementById('panel-toggle');
  const mainEl = document.querySelector('main');
  const label = toggleBtn.querySelector('span');
  let panelHidden = true; // starts hidden — see main.html's initial "panel-hidden" class + button state

  toggleBtn.addEventListener('click', function() {
    panelHidden = !panelHidden;
    mainEl.classList.toggle('panel-hidden', panelHidden);
    toggleBtn.setAttribute('aria-pressed', String(panelHidden));
    toggleBtn.title = panelHidden ? 'Show side panel' : 'Hide side panel';
    label.textContent = panelHidden ? 'Show panel' : 'Hide panel';
    // Grid metrics depend on the plan area's width, which just changed.
    onViewportChange();
  });
})();

const LAYOUT_TABLE = 'Layout Elements';
const SHELVES_TABLE = 'Shelves';
const ITEMS_TABLE = 'Items';
const INVENTORY_TABLE = 'Inventory Management';
const MASTER_TABLE = 'Masterlist';

// ========== Web App API helpers ==========
async function apiGet(table) {
  const url = webAppUrl + '?action=list&table=' + encodeURIComponent(table) + '&token=' + encodeURIComponent(accessToken);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from Web App');
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Request failed');
  return json.rows || [];
}

async function apiPost(action, table, extra) {
  const payload = Object.assign({ token: accessToken, action: action, table: table }, extra || {});
  const res = await fetch(webAppUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from Web App');
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Request failed');
  return json;
}

// ========== Load + join data ==========
async function loadElementsFromSheet() {
  const [layoutRows, shelfRows, itemRows, inventoryRows, masterRows] = await Promise.all([
    apiGet(LAYOUT_TABLE),
    apiGet(SHELVES_TABLE),
    apiGet(ITEMS_TABLE),
    apiGet(INVENTORY_TABLE).catch(() => []), // Fallback if Inventory table doesn't exist
    apiGet(MASTER_TABLE).catch(() => []) // Fallback if Masterlist table doesn't exist
  ]);

  const seenNames = new Set();
  inventoryData = [];
  inventoryRows.concat(masterRows).forEach(inv => {
    const name = String(inv['Part Name'] || '').trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seenNames.has(key)) return;
    seenNames.add(key);
    inventoryData.push(inv);
  });

  const shelfLabelMap = {};
  shelfRows.forEach(s => { shelfLabelMap[s['Shelf ID']] = s['Shelf Label'] || ''; });

  const itemsByShelf = {};
  itemRows.forEach(it => {
    const sid = it['Shelf ID'];
    if (!sid) return;
    if (!itemsByShelf[sid]) itemsByShelf[sid] = [];
    itemsByShelf[sid].push({
      partName: it['Part Name'] || '',
      sku: it['SKUCode'] || '',
      qty: it['Quantity on Shelf'] || '',
      date: it['Date Last Stocked'] || '',
      altNames: it['Alt Names'] || ''
    });
  });

  return layoutRows.map(row => {
    const shelfId = row['Shelf ID'] || (row['Type'] === 'Shelf' ? row['ID'] : null);
    const manualItems = row['Items'] ? String(row['Items']).split(',').map(s => s.trim()).filter(Boolean) : [];
    const realItems = shelfId && itemsByShelf[shelfId] ? itemsByShelf[shelfId] : [];

    const searchable = realItems.flatMap(it => [
      String(it.partName || '').toLowerCase(),
      String(it.sku || '').toLowerCase(),
      String(it.altNames || '').toLowerCase()
    ]).filter(Boolean)
      .concat(manualItems.map(m => String(m).toLowerCase()));

    return {
      id: row['ID'] || ('row_' + Math.random().toString(36).slice(2, 8)),
      type: (row['Type'] || 'shelf').toLowerCase(),
      row: parseInt(row['Row'], 10) || 0,
      col: parseInt(row['Column'], 10) || 0,
      w: parseInt(row['Width'], 10) || 1,
      h: parseInt(row['Height'], 10) || 1,
      label: row['Label'] || '',
      shelfId: shelfId,
      shelfLabel: shelfId ? (shelfLabelMap[shelfId] || '') : '',
      realItems: realItems,
      rawItems: manualItems,
      items: searchable
    };
  });
}

async function saveElementToSheet(el, isNew) {
  const rowData = {
    'ID': el.id,
    'Type': el.type.charAt(0).toUpperCase() + el.type.slice(1),
    'Row': el.row,
    'Column': el.col,
    'Width': el.w,
    'Height': el.h,
    'Label': el.label,
    'Shelf ID': el.type === 'shelf' ? (el.shelfId || el.id) : (el.shelfId || ''),
    'Items': (el.rawItems || []).join(', ')
  };
  if (isNew) {
    await apiPost('add', LAYOUT_TABLE, { row: rowData });
  } else {
    await apiPost('edit', LAYOUT_TABLE, { key: 'ID', keyValue: el.id, row: rowData });
  }
}

async function deleteElementFromSheet(id) {
  await apiPost('delete', LAYOUT_TABLE, { key: 'ID', keyValue: id });
}

async function addItemToSheet(shelfId, partName, skuCode, qty, dateStocked, altNames) {
  const rowData = {
    'Shelf ID': shelfId,
    'Part Name': partName,
    'SKUCode': skuCode,
    'Quantity on Shelf': qty,
    'Date Last Stocked': dateStocked,
    'Alt Names': altNames
  };
  await apiPost('add', ITEMS_TABLE, { row: rowData });

  const existingMaster = inventoryData.find(inv =>
    String(inv['Part Name'] || '').toLowerCase() === String(partName || '').toLowerCase()
  );
  if (!existingMaster) {
    await apiPost('add', MASTER_TABLE, { row: {
      'Part Name': partName,
      'SKUCode': skuCode,
      'Alt Names': altNames
    }}).catch(() => {});
  }
}

async function deleteItemFromSheet(shelfId, partName) {
  // Find and delete by matching Part Name
  await apiPost('delete', ITEMS_TABLE, { key: 'Part Name', keyValue: partName });
}

// ========== Prototype variables ==========
// Cell size is fitted dynamically to the plan area's actual available width
// (so the grid never needs a horizontal scrollbar), capped at a sensible
// default per breakpoint so cells don't look oversized when there's room
// to spare. Mirrors the --cell-size defaults set in index.css.
function getBreakpointCellSize() {
  const w = window.innerWidth;
  if (w <= 480) return 30;
  if (w <= 900) return 38;
  return 48;
}

function getCellSize() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--cell-size').trim();
  const px = parseFloat(raw);
  return (isFinite(px) && px > 0) ? px : 48;
}

let CELL = getCellSize();
let GAP = 0;
let TRACK = CELL + GAP;

function recalcGridMetrics() {
  CELL = getCellSize();
  TRACK = CELL + GAP;
}

function applyCellSize(px) {
  document.documentElement.style.setProperty('--cell-size', px + 'px');
  recalcGridMetrics();
}

// Called from render() with the current column count, so it can react to
// elements being added/removed/moved as well as the window resizing.
function fitCellSizeToContainer(maxCol) {
  const defaultSize = getBreakpointCellSize();
  const wrap = document.querySelector('.plan-grid-wrap');
  if (!wrap || maxCol <= 0) { applyCellSize(defaultSize); return; }

  const rowRuler = document.getElementById('row-ruler');
  const rulerWidth = rowRuler ? rowRuler.getBoundingClientRect().width : 26;
  const available = wrap.clientWidth - rulerWidth;

  if (available <= 0) { applyCellSize(defaultSize); return; }

  const fitBySpace = Math.floor(available / maxCol);
  const finalSize = Math.max(20, Math.min(defaultSize, fitBySpace));
  applyCellSize(finalSize);
}

let gridResizeTimer = null;
function onViewportChange() {
  clearTimeout(gridResizeTimer);
  gridResizeTimer = setTimeout(function() {
    render();
    if (selectedId) { const el = elements.find(e => e.id === selectedId); if (el) renderDetail(el); }
  }, 150);
}
window.addEventListener('resize', onViewportChange);
window.addEventListener('orientationchange', onViewportChange);

let elements = [];
let inventoryData = [];
const grid = document.getElementById('grid');
const searchInput = document.getElementById('search');
const searchStatus = document.getElementById('search-status');
const detailEmpty = document.getElementById('detail-empty');
const detailContent = document.getElementById('detail-content');
const dataStatus = document.getElementById('data-status');
let selectedId = null;
let lastAddedId = null;

function updateDataStatus() {
  dataStatus.textContent = elements.length
    ? ('Loaded ' + elements.length + ' element' + (elements.length !== 1 ? 's' : '') + ' from Layout Elements.')
    : 'No rows returned from Layout Elements.';
}

// ========== Render ==========
function rectsOverlap(a, b) {
  return a.col < b.col + (b.w || 1) && a.col + (a.w || 1) > b.col &&
         a.row < b.row + (b.h || 1) && a.row + (a.h || 1) > b.row;
}

function render() {
  grid.innerHTML = '';
  const query = searchInput.value.trim().toLowerCase();
  let matchCount = 0;

  const maxCol = Math.max(9, ...elements.map(e => e.col + (e.w || 1))) + 1;
  const maxRow = Math.max(7, ...elements.map(e => e.row + (e.h || 1))) + 1;
  fitCellSizeToContainer(maxCol);
  grid.style.gridTemplateColumns = `repeat(${maxCol}, ${CELL}px)`;
  renderRulers(maxCol, maxRow);

  const overlapIds = new Set();
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      if (rectsOverlap(elements[i], elements[j])) {
        overlapIds.add(elements[i].id);
        overlapIds.add(elements[j].id);
      }
    }
  }
  document.getElementById('overlap-banner').classList.toggle('show', overlapIds.size > 0);

  // Flag elements that share BOTH the same ID and the same name — a genuine
  // duplicate (as opposed to two different shelves both defaulted to "New Shelf").
  const dupGroups = {};
  elements.forEach(el => {
    const key = el.id + '||' + el.label;
    (dupGroups[key] = dupGroups[key] || []).push(el);
  });
  const dupIds = new Set();
  Object.values(dupGroups).forEach(group => {
    if (group.length > 1) {
      dupIds.add(group[0].id);
    }
  });
  const dupBanner = document.getElementById('duplicate-banner');
  if (dupIds.size > 0) {
    const examples = [...dupIds].slice(0, 3).join(', ');
    dupBanner.textContent = '⚠ Duplicate shelf' + (dupIds.size > 1 ? 's' : '') + ' detected (same ID and name): ' + examples + (dupIds.size > 3 ? ', …' : '') + ' — rename or remove one.';
    dupBanner.classList.add('show');
  } else {
    dupBanner.classList.remove('show');
  }

  elements.forEach(el => {
    const div = document.createElement('div');
    div.className = 'cell ' + el.type;
    div.dataset.id = el.id;
    div.style.gridColumnStart = el.col + 1;
    div.style.gridRowStart = el.row + 1;
    div.style.gridColumnEnd = 'span ' + (el.w || 1);
    div.style.gridRowEnd = 'span ' + (el.h || 1);

    const isMatch = el.type === 'shelf' && query && el.items &&
      el.items.some(i => String(i).includes(query));
    if (isMatch) { div.classList.add('match'); matchCount++; }
    if (el.id === selectedId) div.classList.add('selected');
    if (overlapIds.has(el.id)) div.classList.add('overlap');
    if (dupIds.has(el.id)) div.classList.add('duplicate');
    if (el.id === lastAddedId) div.classList.add('pop-in');

    div.innerHTML = '<div class="label">' + el.label + '</div>' +
      (el.type === 'shelf' ? '<div class="sub">' + el.id + '</div>' : '') +
      '<div class="resize-handle" title="Drag to resize"></div>';

    attachDrag(div, el);
    attachResize(div.querySelector('.resize-handle'), el, div);
    grid.appendChild(div);
  });

  if (lastAddedId) setTimeout(() => { lastAddedId = null; }, 260);

  if (query) {
    searchStatus.textContent = matchCount > 0
      ? ('Found on ' + matchCount + ' shelf' + (matchCount > 1 ? 's' : '') + ' — pulsing on the plan')
      : 'No matching item found';
    searchStatus.classList.toggle('match', matchCount > 0);
  } else {
    searchStatus.textContent = '';
    searchStatus.classList.remove('match');
  }
  renderManageList();
}

function renderRulers(maxCol, maxRow) {
  const colRuler = document.getElementById('col-ruler');
  const rowRuler = document.getElementById('row-ruler');
  colRuler.innerHTML = ''; rowRuler.innerHTML = '';
  for (let c = 0; c < maxCol; c++) { const s = document.createElement('span'); s.textContent = c; colRuler.appendChild(s); }
  for (let r = 0; r < maxRow; r++) { const s = document.createElement('span'); s.textContent = r; rowRuler.appendChild(s); }
}

// ========== Drag / resize / palette ==========
function attachDrag(div, el) {
  div.addEventListener('pointerdown', function(e) {
    if (e.target.classList.contains('resize-handle')) return;
    if (!editUnlocked) {
      // View-only: tapping/clicking a shelf still opens its detail panel, just no moving it.
      if (el.type === 'shelf') { selectedId = el.id; renderDetail(el); render(); }
      return;
    }
    e.preventDefault();
    div.setPointerCapture(e.pointerId);
    const gridRect = grid.getBoundingClientRect();
    const divRect = div.getBoundingClientRect();
    const offsetX = e.clientX - divRect.left;
    const offsetY = e.clientY - divRect.top;
    let moved = false;
    const startLeft = divRect.left - gridRect.left;
    const startTop = divRect.top - gridRect.top;

    function onMove(ev) {
      const dx = ev.clientX - divRect.left - offsetX;
      const dy = ev.clientY - divRect.top - offsetY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) { moved = true; div.classList.add('dragging'); }
      if (moved) {
        div.style.position = 'absolute';
        div.style.left = Math.round(ev.clientX - gridRect.left - offsetX) + 'px';
        div.style.top = Math.round(ev.clientY - gridRect.top - offsetY) + 'px';
        div.style.width = ((el.w || 1) * CELL + ((el.w || 1) - 1) * GAP) + 'px';
        div.style.height = ((el.h || 1) * CELL + ((el.h || 1) - 1) * GAP) + 'px';
        div.style.zIndex = 15;
        div.style.gridColumnStart = ''; div.style.gridRowStart = ''; div.style.gridColumnEnd = ''; div.style.gridRowEnd = '';
      }
    }
    function onUp() {
      if (finished) return;
      finished = true;
      div.removeEventListener('pointermove', onMove);
      div.removeEventListener('pointerup', onUp);
      div.removeEventListener('pointercancel', onUp);
      if (moved) {
        el.col = Math.max(0, Math.round((parseFloat(div.style.left) || 0) / TRACK));
        el.row = Math.max(0, Math.round((parseFloat(div.style.top) || 0) / TRACK));
        div.style.position = ''; div.style.left = ''; div.style.top = ''; div.style.width = ''; div.style.height = ''; div.style.zIndex = '';
        div.classList.remove('dragging');
        render();
        if (connected) saveElementToSheet(el, false).catch(showDataError);
      } else if (el.type === 'shelf') {
        selectedId = el.id; renderDetail(el); render();
      }
    }

    let finished = false;
    div.style.position = 'absolute';
    div.style.left = Math.round(startLeft) + 'px';
    div.style.top = Math.round(startTop) + 'px';
    div.style.width = ((el.w || 1) * CELL + ((el.w || 1) - 1) * GAP) + 'px';
    div.style.height = ((el.h || 1) * CELL + ((el.h || 1) - 1) * GAP) + 'px';
    div.style.zIndex = 15;
    div.style.gridColumnStart = ''; div.style.gridRowStart = ''; div.style.gridColumnEnd = ''; div.style.gridRowEnd = '';
    div.addEventListener('pointermove', onMove);
    div.addEventListener('pointerup', onUp);
    div.addEventListener('pointercancel', onUp);
  });
}

function attachResize(handle, el, div) {
  handle.addEventListener('pointerdown', function(e) {
    if (!editUnlocked) return;
    e.preventDefault(); e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const gridRect = grid.getBoundingClientRect();
    const divRect = div.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const origW = el.w || 1, origH = el.h || 1;

    div.style.position = 'absolute';
    div.style.left = Math.round(divRect.left - gridRect.left) + 'px';
    div.style.top = Math.round(divRect.top - gridRect.top) + 'px';
    div.style.zIndex = 15;
    div.style.gridColumnStart = ''; div.style.gridRowStart = ''; div.style.gridColumnEnd = ''; div.style.gridRowEnd = '';

    function px(n) { return n * CELL + (n - 1) * GAP; }
    function onMove(ev) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      div.style.width = px(Math.max(1, Math.round(origW + dx / TRACK))) + 'px';
      div.style.height = px(Math.max(1, Math.round(origH + dy / TRACK))) + 'px';
    }
    function onUp(ev) {
      if (finished) return;
      finished = true;
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      el.w = Math.max(1, Math.round(origW + dx / TRACK));
      el.h = Math.max(1, Math.round(origH + dy / TRACK));
      div.style.position = ''; div.style.left = ''; div.style.top = ''; div.style.width = ''; div.style.height = ''; div.style.zIndex = '';
      render();
      if (connected) saveElementToSheet(el, false).catch(showDataError);
    }
    let finished = false;
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

function attachPalette() {
  document.querySelectorAll('.palette-tile').forEach(function(tile) {
    tile.addEventListener('pointerdown', function(e) {
      if (!editUnlocked) return;
      if (tile.dataset.dragging === '1') return; // a previous drag on this tile never cleaned up — ignore instead of stacking a 2nd listener set
      tile.dataset.dragging = '1';
      e.preventDefault();
      tile.setPointerCapture(e.pointerId);
      const type = tile.dataset.type;
      const ghost = document.createElement('div');
      ghost.className = 'ghost-tile';
      ghost.style.width = CELL + 'px'; ghost.style.height = CELL + 'px';
      ghost.style.background = type === 'shelf' ? 'var(--paper)' : type === 'entrance' ? 'var(--entrance)' : 'var(--cashier)';
      ghost.style.color = type === 'shelf' ? 'var(--ink)' : '#fff';
      ghost.textContent = type === 'shelf' ? 'New' : type;
      document.body.appendChild(ghost);
      function pos(ev) { ghost.style.left = Math.round(ev.clientX - CELL / 2) + 'px'; ghost.style.top = Math.round(ev.clientY - CELL / 2) + 'px'; }
      pos(e);
      function onMove(ev) { pos(ev); }
      let finished = false; // belt-and-suspenders: even if both pointerup and pointercancel fire, only act once
      function onUp(ev) {
        if (finished) return;
        finished = true;
        tile.dataset.dragging = '';
        tile.removeEventListener('pointermove', onMove);
        tile.removeEventListener('pointerup', onUp);
        tile.removeEventListener('pointercancel', onUp);
        ghost.remove();
        const gridRect = grid.getBoundingClientRect();
        if (ev.clientX < gridRect.left || ev.clientY < gridRect.top) return;
        const col = Math.max(0, Math.round((ev.clientX - gridRect.left) / TRACK));
        const row = Math.max(0, Math.round((ev.clientY - gridRect.top) / TRACK));
        let idNum = elements.filter(el => el.type === 'shelf').length + 1;
        let id;
        if (type === 'shelf') {
          do { id = 'S' + String(idNum).padStart(3, '0'); idNum++; } while (elements.some(el => el.id === id));
        } else {
          id = type.toUpperCase() + (Date.now() % 1000);
        }
        const newEl = { id, type, row, col, w: 1, h: 1, label: type === 'shelf' ? 'New Shelf' : (type === 'entrance' ? 'Entrance' : 'Checkout'), shelfId: null, realItems: [], rawItems: [], items: [] };
        elements.push(newEl); selectedId = newEl.id; lastAddedId = newEl.id;
        render(); renderDetail(newEl);
        if (connected) saveElementToSheet(newEl, true).catch(showDataError);
      }
      tile.addEventListener('pointermove', onMove);
      tile.addEventListener('pointerup', onUp);
      tile.addEventListener('pointercancel', onUp);
    });
  });
}

// ========== Manage list / detail / remove ==========
function renderManageList() {
  const list = document.getElementById('manage-list');
  list.innerHTML = '';
  elements.forEach(function(el) {
    const row = document.createElement('div');
    row.className = 'manage-row';
    row.innerHTML =
      '<div class="m-label"><span>' + el.label + '</span>' +
      '<span class="tag">' + el.type + ' · ' + el.id + ' · r' + el.row + 'c' + el.col + ' · ' + (el.w || 1) + '×' + (el.h || 1) + '</span></div>' +
      (editUnlocked ? '<button title="Remove">×</button>' : '');
    if (editUnlocked) {
      row.querySelector('button').addEventListener('click', function() { removeElement(el.id); });
    }
    list.appendChild(row);
  });
}

async function removeElement(id) {
  if (!editUnlocked) return;
  const el = elements.find(e => e.id === id);
  elements = elements.filter(e => e.id !== id);
  if (selectedId === id) { selectedId = null; detailEmpty.style.display = 'block'; detailContent.style.display = 'none'; }
  render();
  if (connected) { 
    try { 
      await deleteElementFromSheet(id);
      // If it was a shelf, also delete all items on that shelf
      if (el && el.type === 'shelf') {
        const shelfId = el.shelfId || el.id;
        const itemsToDelete = el.realItems || [];
        for (const item of itemsToDelete) {
          try {
            await deleteItemFromSheet(shelfId, item.partName);
          } catch (err) { console.warn('Could not delete item:', err); }
        }
      }
    } catch (err) { showDataError(err); } 
  }
}

function renderDetail(el) {
  detailEmpty.style.display = 'none';
  detailContent.style.display = 'block';
  const showItems = el.type === 'shelf';

  const realItemsHtml = (el.realItems || []).length
    ? '<ul style="margin:0 0 10px; padding-left:18px; font-size:12px;">' +
        el.realItems.slice(0, 3).map(it => '<li style="margin-bottom:6px; line-height:1.4;">' + it.partName + (it.qty !== '' ? ' — <strong>' + it.qty + '</strong>' : '') + (it.sku ? ' <span style="color:var(--chrome-dim);font-family:\'IBM Plex Mono\',monospace;font-size:10px;">(' + it.sku + ')</span>' : '') + (it.date ? ' <span style="color:var(--chrome-dim);font-size:10px;">• ' + it.date + '</span>' : '') + '</li>').join('') +
        (el.realItems.length > 3 ? '<li style="color:var(--chrome-dim); font-size:11px; margin-top:4px;">+ ' + (el.realItems.length - 3) + ' more</li>' : '')
      + '</ul>'
    : '<p style="font-size:12px; color:var(--chrome-dim); margin:0 0 10px;">No items on this shelf yet.</p>';

  detailContent.innerHTML =
    '<span class="shelf-id">' + el.id + ' · ' + (el.w || 1) + '×' + (el.h || 1) + ' cells' + (el.shelfLabel ? ' · ' + el.shelfLabel : '') + '</span>' +
    '<input class="edit-field" id="edit-label" type="text" value="' + el.label.replace(/"/g, '&quot;') + '"' + (editUnlocked ? '' : ' readonly') + '>' +
    (showItems ? ('<div style="font-size:11px; color:var(--chrome-dim); margin-bottom:6px; margin-top:10px;"><strong>Items on this shelf</strong></div>' + realItemsHtml) : '') +
    (showItems && editUnlocked ? '<div style="background:var(--bg); border:1px solid var(--bg-line-strong); padding:10px; border-radius:6px; margin-bottom:10px;">' +
      '<div style="font-size:11px; color:var(--chrome-dim); margin-bottom:8px;"><strong>Add new item</strong></div>' +
      '<input class="edit-field" id="item-part-name" list="inventory-list" type="text" placeholder="Type to search items..." style="margin-bottom:6px;">' +
      '<datalist id="inventory-list">' + 
        inventoryData.map(inv => '<option value="' + (inv['Part Name'] || '') + '" data-sku="' + (inv['SKUCode'] || '') + '">').join('') +
      '</datalist>' +
      '<input class="edit-field" id="item-sku" type="text" placeholder="SKU Code (auto-filled)" style="margin-bottom:6px;">' +
      '<input class="edit-field" id="item-qty" type="text" placeholder="Quantity" style="margin-bottom:6px;">' +
      '<input class="edit-field" id="item-date" type="date" style="margin-bottom:6px;">' +
      '<input class="edit-field" id="item-alt-names" type="text" placeholder="Alt Names (comma separated)" style="margin-bottom:6px;">' +
      '<button id="add-item-btn" style="background:var(--highlight); color:var(--ink); border:none; padding:6px 10px; border-radius:4px; font-weight:600; font-size:11px; cursor:pointer; width:100%;">Add Item</button>' +
      '</div>' : '') +
    (editUnlocked
      ? ('<button id="save-btn">Save shelf label</button>' +
         '<button id="remove-btn">Remove this element</button>' +
         '<div id="save-status" style="margin-top:8px;font-size:12px;color:var(--chrome-dim)"></div>')
      : '<div class="locked-note">🔒 Unlock editing to rename, restock, move, or remove elements.</div>');

  if (editUnlocked) {
    document.getElementById('save-btn').addEventListener('click', function() {
      const status = document.getElementById('save-status');
      el.label = document.getElementById('edit-label').value.trim() || el.label;
      render(); renderDetail(el);
      if (!connected) { status.textContent = 'Not connected — changes are local only.'; status.style.color = 'var(--chrome-dim)'; return; }
      status.textContent = 'Saving…'; status.style.color = 'var(--highlight)';
      saveElementToSheet(el, false).then(() => {
        status.textContent = 'Saved ✓'; status.style.color = 'var(--highlight)';
      }).catch(err => { status.textContent = err.message; status.style.color = 'var(--danger)'; });
    });
    document.getElementById('remove-btn').addEventListener('click', function() { removeElement(el.id); });
  }

  if (showItems && editUnlocked) {
    // Auto-fill SKU when Part Name is selected from inventory
    const partNameInput = document.getElementById('item-part-name');
    const skuInput = document.getElementById('item-sku');
    
    partNameInput.addEventListener('input', function() {
      const partName = this.value.trim();
      // Try to find matching item as user types
      const inventoryItem = inventoryData.find(inv => 
        (inv['Part Name'] || '').toLowerCase() === partName.toLowerCase()
      );
      if (inventoryItem) {
        skuInput.value = inventoryItem['SKUCode'] || '';
      }
    });
    
    document.getElementById('add-item-btn').addEventListener('click', async function() {
      const status = document.getElementById('save-status');
      const partName = document.getElementById('item-part-name').value.trim();
      const sku = document.getElementById('item-sku').value.trim();
      const qty = document.getElementById('item-qty').value.trim();
      const date = document.getElementById('item-date').value.trim();
      const altNames = document.getElementById('item-alt-names').value.trim();
      
      if (!partName) { status.textContent = 'Part Name is required'; status.style.color = 'var(--danger)'; return; }
      
      if (!connected) { status.textContent = 'Not connected — cannot save items.'; status.style.color = 'var(--danger)'; return; }
      
      status.textContent = 'Adding item…'; status.style.color = 'var(--highlight)';
      try {
        await addItemToSheet(el.shelfId || el.id, partName, sku, qty, date, altNames);
        // Clear form
        document.getElementById('item-part-name').value = '';
        document.getElementById('item-sku').value = '';
        document.getElementById('item-qty').value = '';
        document.getElementById('item-date').value = '';
        document.getElementById('item-alt-names').value = '';
        status.textContent = 'Item added ✓'; status.style.color = 'var(--highlight)';
        // Reload data from sheet
        elements = await loadElementsFromSheet();
        const updatedEl = elements.find(e => e.id === el.id);
        if (updatedEl) renderDetail(updatedEl);
        render();
      } catch (err) {
        status.textContent = 'Error: ' + err.message; status.style.color = 'var(--danger)';
      }
    });
  }
}

// ========== Search ==========
searchInput.addEventListener('input', function() {
  render();
  renderSearchResults();
  if (selectedId) { const el = elements.find(e => e.id === selectedId); if (el) renderDetail(el); }
});

searchInput.addEventListener('focus', function() {
  if (searchInput.value.trim()) renderSearchResults();
});

searchInput.addEventListener('blur', function() {
  // Small delay so a click on a result row registers before the dropdown disappears.
  setTimeout(() => { document.getElementById('search-results').classList.remove('show'); }, 150);
});

function jumpToShelf(id, name) {
  const el = elements.find(e => e.id === id);
  if (!el) return;
  if (name) searchInput.value = name;
  selectedId = id;
  render();
  renderDetail(el);
  document.getElementById('search-results').classList.remove('show');
  const cellDiv = document.querySelector('.cell[data-id="' + CSS.escape(id) + '"]');
  if (cellDiv) cellDiv.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
}

function renderSearchResults() {
  const box = document.getElementById('search-results');
  const query = searchInput.value.trim().toLowerCase();
  if (!query) { box.classList.remove('show'); box.innerHTML = ''; return; }

  const results = [];
  elements.forEach(el => {
    if (el.type !== 'shelf') return;
    (el.realItems || []).forEach(it => {
      const hay = [it.partName, it.sku, it.altNames].map(v => String(v || '').toLowerCase());
      if (hay.some(h => h.includes(query))) {
        results.push({
          name: it.partName || '(unnamed item)',
          meta: el.id + (el.shelfLabel ? ' · ' + el.shelfLabel : '') + (it.sku ? ' · ' + it.sku : ''),
          qty: it.qty !== '' && it.qty != null ? String(it.qty) : '',
          shelfId: el.id
        });
      }
    });
    (el.rawItems || []).forEach(name => {
      if (String(name).toLowerCase().includes(query)) {
        results.push({ name: name, meta: el.id + (el.shelfLabel ? ' · ' + el.shelfLabel : ''), qty: '', shelfId: el.id });
      }
    });
  });

  if (results.length === 0) {
    box.innerHTML = '<div class="search-result-empty">No matching items</div>';
    box.classList.add('show');
    return;
  }

  const LIMIT = 8;
  const shown = results.slice(0, LIMIT);
  box.innerHTML = shown.map(r =>
    '<div class="search-result-row" data-shelf-id="' + r.shelfId.replace(/"/g, '&quot;') + '" data-name="' + r.name.replace(/"/g, '&quot;') + '">' +
      '<div class="sr-main">' +
        '<div class="sr-name">' + r.name.replace(/</g, '&lt;') + '</div>' +
        '<div class="sr-meta">' + r.meta.replace(/</g, '&lt;') + '</div>' +
      '</div>' +
      (r.qty ? '<div class="sr-qty">' + r.qty + '</div>' : '') +
    '</div>'
  ).join('') + (results.length > LIMIT ? '<div class="search-result-more">+ ' + (results.length - LIMIT) + ' more — refine your search</div>' : '');

  box.querySelectorAll('.search-result-row').forEach(row => {
    row.addEventListener('mousedown', function(e) {
      // mousedown (not click) fires before the input's blur handler removes the dropdown
      e.preventDefault();
      jumpToShelf(row.dataset.shelfId, row.dataset.name);
    });
  });

  box.classList.add('show');
}

// ========== Connect ==========
function showDataError(err) {
  console.error(err);
  dataStatus.textContent = 'Error: ' + err.message;
  dataStatus.style.color = 'var(--danger)';
}

// Auto-load on page load using default credentials
(async function autoConnect() {
  dataStatus.textContent = 'Loading from Sheet…';
  dataStatus.style.color = 'var(--chrome-dim)';
  try {
    elements = await loadElementsFromSheet();
    connected = true;
    dataStatus.style.color = 'var(--chrome-dim)';
    updateDataStatus();
  } catch (err) {
    connected = false;
    showDataError(err);
    elements = [];
  }
  render();
})();

// Attach palette listeners once on load
attachPalette();