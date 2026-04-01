/**
 * ════════════════════════════════════════════════════════════════
 * SPORTSYNC — dispo.js  v6  (jQuery)
 * Module Disponibilités — Grille style Plany + créneaux communs
 * ════════════════════════════════════════════════════════════════
 *
 * Corrections v6 :
 *   1. BUG DATE MANQUANTE → la cause était côté GAS (batchSetDispos
 *      gardait data[] en mémoire avec des indices décalés après deleteRow).
 *      Côté client, on s'assure que chaque cellule du batch a bien
 *      ses 3 champs (name, date, slot) avant l'envoi.
 *
 *   2. BUG PROPRIÉTÉ DISPOS → au premier chargement, DS.userName peut
 *      être '' alors que des dispos d'autres joueurs sont en IDB.
 *      La grille ne doit afficher QUE les dispos de DS.userName.
 *      Si DS.userName est vide au moment du loadFromIDB, le grid reste vide.
 *      Règle : les données LOCALES de l'utilisateur courant ont
 *      toujours priorité absolue sur les données GAS.
 *
 *   3. FLAG synced → chaque entrée IDB a un champ `synced: boolean`.
 *      false = enregistré localement, pas encore confirmé par GAS.
 *      true  = GAS a confirmé la réception.
 *      La pastille orange (dispo-cell--pending) se base sur ce flag.
 *
 *   4. SYNC PASSIVE 30s → merge uniquement les données des AUTRES joueurs,
 *      ne touche jamais aux entrées où e.name === DS.userName.
 */

; (function ($) {
  'use strict';

  // ══════════════════════════════════════════════════
  // 1. CONSTANTES
  // ══════════════════════════════════════════════════

  const SLOTS = [
    { key: 'morning', labelShort: 'Matin', labelLong: 'Matin', sub: '6H à 12H' },
    { key: 'afternoon', labelShort: 'Aprem', labelLong: 'Après-midi', sub: '12H à 18H' },
    { key: 'evening', labelShort: 'Soir', labelLong: 'Soir', sub: '18H à 23H' },
  ];

  const DAYS_FR = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const DAYS_SHORT = ['Dim.', 'Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.'];
  const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  const LS_PENDING_KEY = 'sportsync_pending_dispos';

  // ══════════════════════════════════════════════════
  // 2. STATE
  // ══════════════════════════════════════════════════

  const DS = {
    weekStart: null,
    grid: {},        // grid[dateKey][slotKey] = 'ok'|'no'|''
    allDispos: [],        // toutes les dispos tous utilisateurs (dédoublonnées)
    userName: '',
    sessionId: 'recurring',
    activeCell: null,
    bulkTarget: null,
  };

  // ══════════════════════════════════════════════════
  // 3. BATCH SYNC — Pending cells
  // ══════════════════════════════════════════════════

  const _pendingCells = new Map(); // ck → { timerId, dateKey, slotKey, state, ready }
  let _batchTimer = null;
  let _isSending = false;

  function _scheduleSend(ck, dateKey, slotKey, newState) {
    if (_pendingCells.has(ck)) clearTimeout(_pendingCells.get(ck).timerId);

    const timerId = setTimeout(() => {
      const cell = _pendingCells.get(ck);
      if (cell) cell.ready = true;
      _scheduleBatchFlush();
    }, 350);

    _pendingCells.set(ck, { timerId, dateKey, slotKey, state: newState, ready: false });
    _persistPendingToLS();

    // Timeout de sécurité global
    clearTimeout(_batchTimer);
    _batchTimer = setTimeout(_flushBatch, 5000);
  }

  function _scheduleBatchFlush() {
    clearTimeout(_batchTimer);
    _batchTimer = setTimeout(_flushBatch, 200);
  }

  async function _flushBatch() {
    if (_isSending) return;
    if (!_pendingCells.size) return;
    if (typeof gasWrite !== 'function') return;

    const toSend = [];
    for (const [ck, cell] of _pendingCells.entries()) {
      if (cell.ready) toSend.push({ ck, ...cell });
    }
    if (!toSend.length) return;

    _isSending = true;
    _updatePendingBadge();

    toSend.forEach(c => _pendingCells.delete(c.ck));
    _persistPendingToLS();

    // Validation : s'assurer que chaque cellule a bien name, date, slot
    const validCells = toSend.filter(c => c.dateKey && c.slotKey);
    if (!validCells.length) { _isSending = false; _updatePendingBadge(); return; }

    try {
      await gasWrite('batchSetDispos', {
        cells: validCells.map(c => ({
          name: DS.userName || 'Anonyme',
          date: c.dateKey,
          slot: c.slotKey,
          state: c.state,
          sessionId: DS.sessionId,
        })),
      });

      // Marquer les cellules comme synced dans IDB
      for (const c of validCells) {
        await _markSynced(c.ck, true);
      }
      renderGrid(); // met à jour les pastilles orange → vertes
      console.log(`[dispo] Batch envoyé et confirmé : ${validCells.length} cellule(s)`);
    } catch (e) {
      console.warn('[dispo] Batch GAS échoué, retry:', e.message || e);
      validCells.forEach(c => { _pendingCells.set(c.ck, { ...c, ready: true }); });
      _persistPendingToLS();
      _scheduleBatchFlush();
    }

    _isSending = false;
    _updatePendingBadge();

    const stillReady = Array.from(_pendingCells.values()).some(c => c.ready);
    if (stillReady) _scheduleBatchFlush();
  }

  function _persistPendingToLS() {
    try {
      if (_pendingCells.size) {
        const data = Array.from(_pendingCells.entries()).map(([ck, cell]) => ({
          ck, dateKey: cell.dateKey, slotKey: cell.slotKey,
          state: cell.state, sessionId: DS.sessionId, name: DS.userName || 'Anonyme',
        }));
        localStorage.setItem(LS_PENDING_KEY, JSON.stringify(data));
      } else {
        localStorage.removeItem(LS_PENDING_KEY);
      }
    } catch (e) { }
  }

  async function _replayPendingFromLS() {
    try {
      const raw = localStorage.getItem(LS_PENDING_KEY);
      if (!raw) return;
      const pending = JSON.parse(raw);
      if (!pending || !pending.length) return;
      localStorage.removeItem(LS_PENDING_KEY);
      const mine = pending.filter(c => c.sessionId === DS.sessionId && c.name === (DS.userName || 'Anonyme'));
      if (!mine.length) return;
      const validMine = mine.filter(c => c.dateKey && c.slotKey);
      if (!validMine.length) return;
      console.log(`[dispo] Replay ${validMine.length} cellule(s) depuis localStorage`);
      await gasWrite('batchSetDispos', {
        cells: validMine.map(c => ({
          name: c.name, date: c.dateKey, slot: c.slotKey,
          state: c.state, sessionId: c.sessionId,
        })),
      });
      for (const c of validMine) await _markSynced(c.ck, true);
    } catch (e) { console.warn('[dispo] Replay LS échoué:', e.message || e); }
  }

  function _updatePendingBadge() {
    const n = _pendingCells.size;
    const $b = $('#dispo-pending-badge');
    if (!$b.length) return;
    if (n > 0) $b.text(`⏳ ${n} créneau(x) en attente d'envoi…`).removeClass('hidden');
    else $b.addClass('hidden');
  }

  function _bindBeforeUnload() {
    $(window).on('beforeunload', () => {
      for (const [, cell] of _pendingCells.entries()) cell.ready = true;
      _persistPendingToLS();
      if (_pendingCells.size && typeof navigator.sendBeacon === 'function' &&
        typeof CONFIG !== 'undefined' && CONFIG.GAS_URL &&
        CONFIG.GAS_URL !== 'VOTRE_URL_APPS_SCRIPT_ICI') {
        const cells = Array.from(_pendingCells.values())
          .filter(c => c.dateKey && c.slotKey)
          .map(c => ({
            name: DS.userName || 'Anonyme', date: c.dateKey, slot: c.slotKey,
            state: c.state, sessionId: DS.sessionId
          }));
        if (cells.length) {
          const body = JSON.stringify({ action: 'batchSetDispos', sessionId: DS.sessionId, cells });
          navigator.sendBeacon(CONFIG.GAS_URL, new Blob([body], { type: 'text/plain' }));
        }
      }
    });
  }

  // ══════════════════════════════════════════════════
  // 4. UTILITAIRES DATE
  // ══════════════════════════════════════════════════

  function toDateKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function normalizeDateKey(val) {
    if (!val) return '';
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s.includes('T') ? s : s + 'T12:00');
    if (!isNaN(d.getTime())) return toDateKey(d);
    return s;
  }

  function getMondayOf(date) {
    const d = new Date(date), day = d.getDay();
    d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function getWeekDays(monday) {
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(d.getDate() + i); return d; });
  }

  function formatPeriodLabel(days) {
    const f = days[0], l = days[6];
    return f.getMonth() === l.getMonth()
      ? `${f.getDate()} au ${l.getDate()} ${MONTHS_FR[l.getMonth()]} ${l.getFullYear()}`
      : `${f.getDate()} ${MONTHS_FR[f.getMonth()]} au ${l.getDate()} ${MONTHS_FR[l.getMonth()]} ${l.getFullYear()}`;
  }

  function formatCellTitle(dateKey, slotKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const slot = SLOTS.find(s => s.key === slotKey);
    return `${slot.labelLong} du ${DAYS_FR[date.getDay()].toLowerCase()} ${d} ${MONTHS_FR[m - 1]}`;
  }

  function formatDateFR(dateKey) {
    if (!dateKey) return '';
    const clean = normalizeDateKey(dateKey);
    const [y, m, d] = clean.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    if (isNaN(date.getTime())) return dateKey;
    return `${DAYS_FR[date.getDay()]} ${d} ${MONTHS_FR[m - 1]}`;
  }

  // ══════════════════════════════════════════════════
  // 5. DONNÉES — IDB
  // ══════════════════════════════════════════════════

  function getCellState(dateKey, slotKey) {
    return (DS.grid[dateKey] && DS.grid[dateKey][slotKey]) || '';
  }

  function _makeCompositeKey(dateKey, slotKey) {
    return DS.sessionId + '::' + (DS.userName || 'Anonyme') + '::' + dateKey + '::' + slotKey;
  }

  function _makeKeyFromEntry(e) {
    if (!e.sessionId || !e.name || !e.date || !e.slot) return null;
    return e.sessionId + '::' + e.name + '::' + normalizeDateKey(e.date) + '::' + e.slot;
  }

  /**
   * Indique si une cellule de l'utilisateur courant est non encore confirmée par GAS.
   * Basé sur le flag `synced` en IDB.
   */
  function _isCellUnsynced(dateKey, slotKey) {
    const ck = _makeCompositeKey(dateKey, slotKey);
    // Si elle est dans _pendingCells, elle n'est pas encore envoyée
    if (_pendingCells.has(ck)) return true;
    // Sinon, vérifier le flag synced dans allDispos
    const entry = DS.allDispos.find(e => e._compositeKey === ck);
    return entry ? entry.synced === false : false;
  }

  async function setCellState(dateKey, slotKey, newState) {
    // Validation : ne pas enregistrer si dateKey est vide ou invalide
    if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      console.error('[dispo] setCellState: dateKey invalide', dateKey);
      return;
    }

    const ck = _makeCompositeKey(dateKey, slotKey);
    if (!DS.grid[dateKey]) DS.grid[dateKey] = {};
    DS.grid[dateKey][slotKey] = newState;

    // synced: false = pas encore confirmé par GAS
    await _persistToIDB(dateKey, slotKey, newState, ck, false);
    _scheduleSend(ck, dateKey, slotKey, newState);
    _updatePendingBadge();
    renderCommonSlots();
  }

  async function _persistToIDB(dateKey, slotKey, newState, ck, synced) {
    const db = window._sportSyncDB;
    if (!db) return;
    const all = await idbGetAll(db, 'dispos');
    const existing = all.find(e => e._compositeKey === ck);
    const entry = {
      _compositeKey: ck,
      name: DS.userName || 'Anonyme',
      date: dateKey,
      slot: slotKey,
      state: newState,
      sessionId: DS.sessionId,
      synced: synced !== undefined ? synced : (existing ? existing.synced : false),
      createdAt: (existing && existing.createdAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (existing) { entry.id = existing.id; await idbPutRaw(db, 'dispos', entry); }
    else { const id = await idbPutRaw(db, 'dispos', entry); entry.id = id; }
    const idx = DS.allDispos.findIndex(e => e._compositeKey === ck);
    if (idx >= 0) DS.allDispos[idx] = entry; else DS.allDispos.push(entry);
  }

  /** Met à jour le flag synced d'une entrée en IDB */
  async function _markSynced(ck, syncedVal) {
    const db = window._sportSyncDB;
    if (!db) return;
    const all = await idbGetAll(db, 'dispos');
    const existing = all.find(e => e._compositeKey === ck);
    if (!existing) return;
    existing.synced = syncedVal;
    await idbPutRaw(db, 'dispos', existing);
    const idx = DS.allDispos.findIndex(e => e._compositeKey === ck);
    if (idx >= 0) DS.allDispos[idx].synced = syncedVal;
  }

  /**
   * Charge depuis IDB.
   *
   * RÈGLE DE PROPRIÉTÉ v6 :
   *   - Les entrées où e.name === DS.userName sont les données PROPRIÉTAIRES.
   *     Elles ne sont JAMAIS écrasées par des données distantes.
   *   - Les entrées des autres utilisateurs sont toujours acceptées depuis GAS
   *     (uniquement pour l'affichage des dots et du panneau commun).
   *   - Si DS.userName est vide, aucune entrée n'est considérée comme propriétaire
   *     → le grid reste vide jusqu'à ce que l'utilisateur saisisse son nom.
   *
   * @param {boolean} preserveOwnerGrid - si true, ne touche pas les entrées du userName courant
   */
  async function loadFromIDB(preserveOwnerGrid) {
    const db = window._sportSyncDB;
    if (!db) return;
    const all = await idbGetAll(db, 'dispos');

    // Dédoublonnage : pour chaque clé composite, garder l'entrée la plus récente
    const byKey = new Map();
    for (const e of all) {
      const ck = e._compositeKey || _makeKeyFromEntry(e);
      if (!ck) continue;
      const existing = byKey.get(ck);
      if (!existing || (e.updatedAt || '') > (existing.updatedAt || ''))
        byKey.set(ck, { ...e, _compositeKey: ck });
    }

    DS.allDispos = Array.from(byKey.values()).map(e => ({
      ...e,
      date: normalizeDateKey(e.date),
    }));

    if (preserveOwnerGrid) {
      // Mode sync passive : mettre à jour uniquement les AUTRES utilisateurs
      // Ne jamais toucher aux cellules de DS.userName
      for (const e of DS.allDispos) {
        if (!e.name || e.name === DS.userName) continue; // préserver les données propres
        if (e.sessionId !== DS.sessionId || !e.slot || !e.date) continue;
        const dk = normalizeDateKey(e.date);
        if (!dk) continue;
        if (!DS.grid[dk]) DS.grid[dk] = {};
        // Pas d'écriture sur le grid propre (géré par setCellState uniquement)
        // On ne met à jour que allDispos (pour les dots et le panneau commun)
        // Le grid de l'utilisateur courant ne stocke QUE ses propres cellules
      }
      // Note : le grid de DS.userName est déjà correct car setCellState
      // l'écrit directement. On n'a pas besoin de le recharger ici.
    } else {
      // Reconstruction complète du grid depuis les données PROPRIÉTAIRES uniquement
      DS.grid = {};
      if (DS.userName) {
        for (const e of DS.allDispos) {
          if (e.name !== DS.userName) continue;           // STRICTEMENT ses propres données
          if (e.sessionId !== DS.sessionId) continue;
          if (!e.slot || !e.date) continue;
          const dk = normalizeDateKey(e.date);
          if (!dk) continue;
          if (!DS.grid[dk]) DS.grid[dk] = {};
          DS.grid[dk][e.slot] = e.state || '';
        }
      }
      // Si DS.userName est vide → grid reste {} (pas de données affichées)
    }
  }

  function idbGetAll(db, storeName) {
    return new Promise((res, rej) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }

  function idbPutRaw(db, storeName, data) {
    return new Promise((res, rej) => {
      const req = db.transaction(storeName, 'readwrite').objectStore(storeName).put(data);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  // ══════════════════════════════════════════════════
  // 6. SYNC PASSIVE 30s
  // ══════════════════════════════════════════════════

  let _autoSyncTimer = null;

  function startAutoSync() {
    stopAutoSync();
    _autoSyncTimer = setInterval(async () => {
      if (typeof gasFetchAll !== 'function') return;
      if (!window._sportSyncDB) return;
      if (_isSending) return;
      try {
        const remote = await gasFetchAll();
        if (!remote || !remote.dispos) return;
        const db = window._sportSyncDB;
        if (!db) return;

        for (const d of (remote.dispos || [])) {
          // NE JAMAIS écraser les données de l'utilisateur courant
          if (d.name === DS.userName) continue;

          const ck = (d.sessionId || '') + '::' + d.name + '::' + d.date + '::' + d.slot;
          const existing = DS.allDispos.find(e => e._compositeKey === ck);
          if (existing && (existing.updatedAt || '') >= (d.updatedAt || '')) continue;

          await idbPutRaw(db, 'dispos', {
            _compositeKey: ck,
            id: (existing && existing.id) || ck,
            name: d.name || '', date: d.date || '', slot: d.slot || '',
            state: d.state || '', sessionId: d.sessionId || '',
            updatedAt: d.updatedAt || '',
            synced: true, // données venant du cloud = déjà synced
          });
        }

        // Recharger en préservant le grid propriétaire
        await loadFromIDB(true);
        renderGrid();
        renderCommonSlots();
        if (typeof updateSyncFooter === 'function') updateSyncFooter();
      } catch (e) {
        console.warn('[dispo] Auto-sync 30s échouée:', e.message || e);
      }
    }, 30000);
  }

  function stopAutoSync() {
    if (_autoSyncTimer) { clearInterval(_autoSyncTimer); _autoSyncTimer = null; }
  }

  // ══════════════════════════════════════════════════
  // 7. RENDU GRILLE
  // ══════════════════════════════════════════════════

  function renderGrid() {
    const $grid = $('#plany-grid');
    if (!$grid.length) return;
    const isDesktop = window.innerWidth >= 700;
    const days = getWeekDays(DS.weekStart);
    const today = toDateKey(new Date());
    $('#plany-period-label').text(formatPeriodLabel(days));
    $grid.html(isDesktop ? buildDesktopGrid(days, today) : buildMobileGrid(days, today));
    bindCellEvents($grid);
  }

  function buildDesktopGrid(days, today) {
    const hd = days.map(d => {
      const dk = toDateKey(d), it = dk === today;
      return `<th class="col-header${it ? ' today-col' : ''}" scope="col">${DAYS_FR[d.getDay() === 0 ? 0 : d.getDay()]}<br><span style="font-weight:400">${d.getDate()}</span></th>`;
    }).join('');
    const rows = SLOTS.map(slot => {
      const cells = days.map(d => buildCell(toDateKey(d), slot.key)).join('');
      return `<tr><td class="row-header" scope="row"><span class="row-header-day">${slot.labelShort}</span><span class="row-header-date">${slot.sub}</span></td>${cells}</tr>`;
    }).join('');
    return `<thead><tr><th class="corner"></th>${hd}</tr></thead><tbody>${rows}</tbody>`;
  }

  function buildMobileGrid(days, today) {
    const hd = SLOTS.map(s => `<th class="col-header" scope="col">${s.labelShort}<br><span style="font-weight:400;font-size:.63rem">${s.sub}</span></th>`).join('');
    const rows = days.map(d => {
      const dk = toDateKey(d), it = dk === today, dayIdx = d.getDay() === 0 ? 0 : d.getDay();
      const cells = SLOTS.map(slot => buildCell(dk, slot.key)).join('');
      return `<tr><td class="row-header${it ? ' today-row' : ''}" scope="row"><span class="row-header-day">${DAYS_SHORT[dayIdx]} ${d.getDate()}</span></td>${cells}</tr>`;
    }).join('');
    return `<thead><tr><th class="corner"></th>${hd}</tr></thead><tbody>${rows}</tbody>`;
  }

  function buildCell(dateKey, slotKey) {
    const st = getCellState(dateKey, slotKey);
    const icon = st === 'ok' ? '✓' : st === 'no' ? '✕' : '';
    const icolor = st === 'ok' ? 'color:var(--dispo-ok)' : st === 'no' ? 'color:var(--dispo-no)' : '';
    const pending = _isCellUnsynced(dateKey, slotKey) && st !== '';
    const others = buildOthersSummary(dateKey, slotKey);
    const hover = buildHoverButtons(st);
    return `<td class="dispo-cell${pending ? ' dispo-cell--pending' : ''}" data-date="${dateKey}" data-slot="${slotKey}" data-state="${st}" role="button" tabindex="0" aria-label="${formatCellTitle(dateKey, slotKey)}">
      <span class="cell-icon" style="${icolor}">${icon}</span>
      ${others}
      <div class="cell-hover-options">${hover}</div>
    </td>`;
  }

  function buildHoverButtons(st) {
    let h = '';
    if (st !== 'ok') h += `<button class="cell-hover-btn cell-hover-btn--ok" data-action="ok" tabindex="-1">✓ Dispo</button>`;
    if (st !== 'no') h += `<button class="cell-hover-btn cell-hover-btn--no" data-action="no" tabindex="-1">✕ Indispo</button>`;
    if (st !== '') h += `<button class="cell-hover-btn cell-hover-btn--clear" data-action="clear" tabindex="-1">🗑</button>`;
    return h;
  }

  function buildOthersSummary(dateKey, slotKey) {
    const byName = new Map();
    for (const e of DS.allDispos) {
      if (normalizeDateKey(e.date) !== dateKey) continue;
      if (e.slot !== slotKey || e.name === DS.userName) continue;
      if (e.sessionId !== DS.sessionId || !e.state) continue;
      const ex = byName.get(e.name);
      if (!ex || (e.updatedAt || '') > (ex.updatedAt || '')) byName.set(e.name, e);
    }
    if (!byName.size) return '';
    const dots = Array.from(byName.values()).slice(0, 5).map(e => {
      const c = e.state === 'ok' ? 'var(--dispo-ok)' : 'var(--dispo-no)';
      return `<span style="width:6px;height:6px;border-radius:50%;background:${c};display:inline-block;margin:0 1px" title="${e.name}"></span>`;
    }).join('');
    const more = byName.size > 5 ? `<span style="font-size:.6rem;color:var(--dispo-sub)">+${byName.size - 5}</span>` : '';
    return `<div class="dispo-dots" style="position:absolute;bottom:4px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:1px">${dots}${more}</div>`;
  }

  function bindCellEvents($grid) {
    // On retire les anciens écouteurs sur ces sélecteurs précis 
    // pour éviter l'accumulation à chaque appel de la fonction.
    $grid.off('click', '.cell-hover-btn');
    $grid.off('click', '.dispo-cell');
    $grid.off('keydown', '.dispo-cell');

    console.log("BINDING EVENTS (1 seul appel attendu par clic)");

    $grid.on('click', '.cell-hover-btn', function (e) {
      e.stopPropagation();
      const $cell = $(this).closest('.dispo-cell');
      const action = $(this).data('action');
      applyState($cell.data('date'), $cell.data('slot'), action === 'clear' ? '' : action, $cell);
    });

    $grid.on('click', '.dispo-cell', function () {
      // Check hover pour desktop
      if (window.innerWidth >= 700 && window.matchMedia('(hover:hover)').matches) return;

      const $cell = $(this);
      DS.activeCell = { dateKey: $cell.data('date'), slotKey: $cell.data('slot'), $el: $cell };
      openCellSheet($cell.data('date'), $cell.data('slot'), getCellState($cell.data('date'), $cell.data('slot')));
    });

    $grid.on('keydown', '.dispo-cell', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        $(this).click();
      }
    });
  }

  // ══════════════════════════════════════════════════
  // 8. APPLICATION D'UN ÉTAT
  // ══════════════════════════════════════════════════

  async function applyState(dateKey, slotKey, newState, $cell) {
    console.log("test", dateKey, slotKey)
    // Vérification préventive de la date
    if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey))) {

      console.error('[dispo] applyState: dateKey invalide', dateKey, slotKey);
      return;
    }
    updateCellDOM(dateKey, slotKey, newState, $cell);
    if ($cell && $cell.length) {
      $cell.removeClass('popping'); void $cell[0].offsetWidth;
      $cell.addClass('popping'); setTimeout(() => $cell.removeClass('popping'), 300);
    }
    await setCellState(dateKey, slotKey, newState);
  }

  function updateCellDOM(dateKey, slotKey, newState, $cell) {
    if (!$cell || !$cell.length) $cell = $(`.dispo-cell[data-date="${dateKey}"][data-slot="${slotKey}"]`);
    if (!$cell.length) return;
    $cell.attr('data-state', newState);
    $cell.find('.cell-icon').text(newState === 'ok' ? '✓' : newState === 'no' ? '✕' : '')
      .attr('style', newState === 'ok' ? 'color:var(--dispo-ok)' : newState === 'no' ? 'color:var(--dispo-no)' : '');
    $cell.find('.cell-hover-options').html(buildHoverButtons(newState));
    // Ajouter la pastille pending immédiatement (synced=false)
    if (newState !== '') $cell.addClass('dispo-cell--pending');
  }

  // ══════════════════════════════════════════════════
  // 9. BOTTOM SHEETS
  // ══════════════════════════════════════════════════

  function openCellSheet(dateKey, slotKey, currentState) {
    $('#plany-cell-title').text(formatCellTitle(dateKey, slotKey));
    const opts = [];
    if (currentState !== 'ok') opts.push(`<button class="cell-sheet-btn" data-action="ok"><span class="cell-sheet-icon cell-sheet-icon--ok">✅</span> Disponible</button>`);
    if (currentState !== 'no') opts.push(`<button class="cell-sheet-btn" data-action="no"><span class="cell-sheet-icon cell-sheet-icon--no">❌</span> Non disponible</button>`);
    if (currentState !== '') opts.push(`<button class="cell-sheet-btn" data-action="clear"><span class="cell-sheet-icon cell-sheet-icon--clear">🗑️</span> Annuler</button>`);
    $('#plany-cell-options').html(opts.join(''));
    $('#plany-cell-overlay').removeClass('hidden').attr('aria-hidden', 'false');
  }

  function closeCellSheet() { $('#plany-cell-overlay').addClass('hidden').attr('aria-hidden', 'true'); DS.activeCell = null; }
  function openBulkSheet(target) {
    DS.bulkTarget = target;
    const label = target === 'week' ? 'Semaine (Lun.→Ven.)' : target === 'weekend' ? 'Week-end (Sam.→Dim.)' : 'Toute la semaine';
    $('#plany-bulk-title').text(label);
    $('#plany-bulk-overlay').removeClass('hidden');
  }
  function closeBulkSheet() { $('#plany-bulk-overlay').addClass('hidden'); DS.bulkTarget = null; }

  async function applyBulk(target, action) {
    const days = getWeekDays(DS.weekStart);
    const newState = action === 'ok' ? 'ok' : action === 'no' ? 'no' : '';
    let targets = [];
    if (target === 'week') targets = days.filter(d => d.getDay() >= 1 && d.getDay() <= 5);
    else if (target === 'weekend') targets = days.filter(d => d.getDay() === 0 || d.getDay() === 6);
    else targets = days;
    for (const d of targets) {
      const dk = toDateKey(d);
      for (const slot of SLOTS) await setCellState(dk, slot.key, newState);
    }
    renderGrid();
    renderCommonSlots();
  }

  // ══════════════════════════════════════════════════
  // 10. PANNEAU CRÉNEAUX COMMUNS
  // ══════════════════════════════════════════════════

  function renderCommonSlots() {
    const $panel = $('#dispo-common-slots');
    if (!$panel.length) return;
    const tally = {};
    const sorted = [...DS.allDispos].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    for (const e of sorted) {
      if (!e.date || !e.slot || !e.sessionId || e.sessionId !== DS.sessionId) continue;
      const dk = normalizeDateKey(e.date); if (!dk) continue;
      if (!tally[dk]) tally[dk] = {};
      if (!tally[dk][e.slot]) tally[dk][e.slot] = { ok: new Set(), no: new Set() };
      const cell = tally[dk][e.slot];
      if (e.state === 'ok') cell.ok.add(e.name);
      else if (e.state === 'no') cell.no.add(e.name);
    }
    const items = [];
    for (const [date, slots] of Object.entries(tally))
      for (const [slot, counts] of Object.entries(slots))
        if (counts.ok.size > 0) items.push({ date, slot, ok: Array.from(counts.ok), no: Array.from(counts.no) });
    items.sort((a, b) => b.ok.length - a.ok.length || a.date.localeCompare(b.date));
    if (!items.length) {
      $panel.html('<p class="empty-state">Aucun créneau commun.<br>Renseignez vos disponibilités ci-dessus.</p>');
      return;
    }
    const participants = new Set(DS.allDispos.filter(e => e.sessionId === DS.sessionId && e.state).map(e => e.name));
    const total = participants.size;
    const html = items.slice(0, 8).map(item => {
      const slotDef = SLOTS.find(s => s.key === item.slot);
      const pct = total > 0 ? Math.round((item.ok.length / total) * 100) : 0;
      const score = item.ok.length, perfect = score >= total && total > 0;
      const barClass = perfect ? 'bar--perfect' : pct >= 70 ? 'bar--high' : pct >= 40 ? 'bar--mid' : 'bar--low';
      return `<div class="common-slot-item ${perfect ? 'common-slot-item--perfect' : ''}">
        <div class="common-slot-main">
          <div class="common-slot-meta">
            <span class="common-slot-date">${formatDateFR(item.date)}</span>
            <span class="common-slot-period">${slotDef ? slotDef.labelShort + ' · ' + slotDef.sub : item.slot}</span>
          </div>
          <div class="common-slot-score">
            <span class="score-badge ${perfect ? 'score-badge--perfect' : ''}">${perfect ? '🏆' : '👥'} ${score}${total > 0 ? '/' + total : ''} dispo</span>
          </div>
        </div>
        <div class="common-slot-bar-wrap"><div class="common-slot-bar ${barClass}" style="width:${pct}%"></div></div>
        ${item.ok.length ? `<div class="common-slot-names ok-names">✓ ${item.ok.join(', ')}</div>` : ''}
        ${item.no.length ? `<div class="common-slot-names no-names">✕ ${item.no.join(', ')}</div>` : ''}
      </div>`;
    }).join('');
    $panel.html(`<div class="common-slots-header"><span class="common-slots-title">Créneaux les plus favorables</span><span class="common-slots-participants">${total} participant${total > 1 ? 's' : ''}</span></div>${html}`);
  }

  // ══════════════════════════════════════════════════
  // 11. NAVIGATION SEMAINE
  // ══════════════════════════════════════════════════

  function navigateWeek(delta) { DS.weekStart = new Date(DS.weekStart); DS.weekStart.setDate(DS.weekStart.getDate() + delta * 7); renderGrid(); }
  function goToToday() { DS.weekStart = getMondayOf(new Date()); renderGrid(); }

  // ══════════════════════════════════════════════════
  // 12. PRÉNOM
  // ══════════════════════════════════════════════════

  function initUserName() {
    const saved = localStorage.getItem('sportsync_username') || '';
    DS.userName = saved;
    $('#dispo-username').val(saved);

    $(document).on('change blur', '#dispo-username', async function () {
      const newName = $(this).val().trim();
      if (newName === DS.userName) return;
      DS.userName = newName;
      localStorage.setItem('sportsync_username', newName);
      // Reconstruction complète du grid avec les données du nouvel utilisateur
      await loadFromIDB(false);
      renderGrid();
      renderCommonSlots();
    });
  }

  // ══════════════════════════════════════════════════
  // 13. BINDING
  // ══════════════════════════════════════════════════

  function bindDispoEvents() {
    $(document).on('click', '#btn-week-prev', () => navigateWeek(-1));
    $(document).on('click', '#btn-week-next', () => navigateWeek(+1));
    $(document).on('click', '#btn-week-today', goToToday);
    $(document).on('click', '#btn-filter-week', () => openBulkSheet('week'));
    $(document).on('click', '#btn-filter-weekend', () => openBulkSheet('weekend'));
    $(document).on('click', '#btn-filter-clear', () => openBulkSheet('all'));
    $(document).on('click', '[data-bulk]', async function () {
      const action = $(this).data('bulk'), target = DS.bulkTarget;
      closeBulkSheet();
      if (action && action !== 'cancel') await applyBulk(target, action);
    });
    $(document).on('click', '#btn-bulk-cancel', closeBulkSheet);
    $(document).on('click', '#plany-bulk-overlay', function (e) { if (e.target === this) closeBulkSheet(); });
    $(document).on('click', '#plany-cell-options .cell-sheet-btn', async function () {
      const action = $(this).data('action'), newState = action === 'clear' ? '' : action;
      if (DS.activeCell) await applyState(DS.activeCell.dateKey, DS.activeCell.slotKey, newState, DS.activeCell.$el);
      closeCellSheet();
    });
    $(document).on('click', '#btn-cell-close', closeCellSheet);
    $(document).on('click', '#plany-cell-overlay', function (e) { if (e.target === this) closeCellSheet(); });
    let lastBp = window.innerWidth >= 700;
    $(window).on('resize.dispo', function () {
      const cur = window.innerWidth >= 700;
      if (cur !== lastBp) { lastBp = cur; renderGrid(); }
    });
  }

  // ══════════════════════════════════════════════════
  // 14. INIT
  // ══════════════════════════════════════════════════

  async function init(opts) {
    opts = opts || {};
    if (opts.db) window._sportSyncDB = opts.db;
    if (opts.sessionId) DS.sessionId = opts.sessionId;
    if (window.state && window.state.sessionId) DS.sessionId = window.state.sessionId;
    DS.weekStart = getMondayOf(new Date());
    initUserName();
    await loadFromIDB(false); // chargement initial complet
    bindDispoEvents();
    _bindBeforeUnload();
    renderGrid();
    renderCommonSlots();
    _replayPendingFromLS().catch(() => { });
    startAutoSync();
    console.log('[Dispo v6] Initialisé ✓ userName=' + DS.userName + ' sessionId=' + DS.sessionId);
  }

  async function refresh(preserveOwnerGrid) {
    await loadFromIDB(!!preserveOwnerGrid);
    renderGrid();
    renderCommonSlots();
  }

  function getSummary() {
    const out = {};
    for (const [dk, slots] of Object.entries(DS.grid))
      for (const [sk, st] of Object.entries(slots)) { if (!out[dk]) out[dk] = {}; out[dk][sk] = st; }
    return out;
  }

  window.SportSyncDispo = { init, refresh, getSummary, renderGrid, renderCommonSlots, startAutoSync, stopAutoSync };

  $(document).ready(function () {
    setTimeout(function () {
      if (!window._dispoInitialized) { console.info('[Dispo] auto-init'); init(); window._dispoInitialized = true; }
    }, 350);
  });

}(jQuery));
