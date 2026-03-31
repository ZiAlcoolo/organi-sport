/**
 * ════════════════════════════════════════════════════════════════
 * SPORTSYNC — dispo.js  v4  (jQuery)
 * Module Disponibilités — Grille style Plany + créneaux communs
 * ════════════════════════════════════════════════════════════════
 *
 * Stratégie anti-doublons :
 *   1. Verrou local  : _pendingCells Map — une seule opération en cours par cellule
 *   2. Debounce 400ms: les clics rapides sont fusionnés, seul le dernier état part
 *   3. File GAS      : _gasQueue — les requêtes sont envoyées une par une (FIFO)
 *   4. Côté GAS      : upsert strict par clé composite (name::date::slot::sessionId)
 *                      + Lock Service pour sérialiser les écritures concurrentes
 *
 * Données IDB : { _compositeKey, name, date, slot, state, sessionId, createdAt, updatedAt }
 *   date  = 'YYYY-MM-DD'
 *   slot  = 'morning' | 'afternoon' | 'evening'
 *   state = 'ok' | 'no' | ''
 */

;(function ($) {
  'use strict';

  // ══════════════════════════════════════════════════
  // 1. CONSTANTES
  // ══════════════════════════════════════════════════

  const SLOTS = [
    { key: 'morning',   labelShort: 'Matin',      labelLong: 'Matin',      sub: '6H à 12H'        },
    { key: 'afternoon', labelShort: 'Après-midi', labelLong: 'Après-midi', sub: '12H à 18H'       },
    { key: 'evening',   labelShort: 'Soir',       labelLong: 'Soir',       sub: 'à partir de 18H' },
  ];

  const DAYS_FR    = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
  const DAYS_SHORT = ['Dim.','Lun.','Mar.','Mer.','Jeu.','Ven.','Sam.'];
  const MONTHS_FR  = ['janvier','février','mars','avril','mai','juin',
                       'juillet','août','septembre','octobre','novembre','décembre'];

  // ══════════════════════════════════════════════════
  // 2. STATE
  // ══════════════════════════════════════════════════

  const DS = {
    weekStart:  null,
    grid:       {},       // grid[dateKey][slotKey] = 'ok'|'no'|''
    allDispos:  [],       // toutes les dispos (tous utilisateurs), dédoublonnées
    userName:   '',
    sessionId:  'recurring',
    activeCell: null,     // { dateKey, slotKey, $el }
    bulkTarget: null,     // 'week'|'weekend'|'all'
  };

  // ══════════════════════════════════════════════════
  // 3. ANTI-DOUBLONS — Verrou + Debounce + File GAS
  // ══════════════════════════════════════════════════

  /**
   * _pendingCells : Map<compositeKey, { timerId, latestState }>
   *   Pour chaque cellule, on stocke le timer debounce en cours et
   *   l'état qui sera envoyé quand il se déclenchera.
   *   Si une nouvelle action arrive avant la fin du debounce,
   *   on annule le timer et on en crée un nouveau avec le nouvel état.
   */
  const _pendingCells = new Map();

  /**
   * _gasQueue : file d'attente FIFO des fonctions asynchrones GAS.
   *   Garantit qu'une seule requête GAS est en vol à la fois,
   *   évitant les collisions côté Google Sheets (même si deux
   *   cellules différentes sont modifiées quasi-simultanément).
   */
  const _gasQueue = {
    _queue:   [],
    _running: false,

    push(fn) {
      this._queue.push(fn);
      this._tick();
    },

    async _tick() {
      if (this._running || !this._queue.length) return;
      this._running = true;
      const fn = this._queue.shift();
      try { await fn(); } catch(e) { console.warn('[GAS queue]', e); }
      this._running = false;
      this._tick(); // traiter la suivante
    },
  };

  // ══════════════════════════════════════════════════
  // 4. UTILITAIRES DATE
  // ══════════════════════════════════════════════════

  function toDateKey(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth()+1).padStart(2,'0') + '-' +
      String(d.getDate()).padStart(2,'0');
  }

  /** Normalise n'importe quelle valeur de date en 'YYYY-MM-DD' */
  function normalizeDateKey(val) {
    if (!val) return '';
    const s = String(val).trim();
    // Déjà au bon format
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // Tenter une conversion JS
    const d = new Date(s);
    if (!isNaN(d.getTime())) return toDateKey(d);
    return s;
  }

  function getMondayOf(date) {
    const d   = new Date(date);
    const day = d.getDay();
    d.setDate(d.getDate() + (day===0 ? -6 : 1-day));
    d.setHours(0,0,0,0);
    return d;
  }

  function getWeekDays(monday) {
    return Array.from({length:7}, (_,i) => {
      const d = new Date(monday);
      d.setDate(d.getDate()+i);
      return d;
    });
  }

  function formatPeriodLabel(days) {
    const f=days[0], l=days[6];
    return f.getMonth()===l.getMonth()
      ? `${f.getDate()} au ${l.getDate()} ${MONTHS_FR[l.getMonth()]} ${l.getFullYear()}`
      : `${f.getDate()} ${MONTHS_FR[f.getMonth()]} au ${l.getDate()} ${MONTHS_FR[l.getMonth()]} ${l.getFullYear()}`;
  }

  function formatCellTitle(dateKey, slotKey) {
    const [y,m,d] = dateKey.split('-').map(Number);
    const date = new Date(y, m-1, d);
    const slot = SLOTS.find(s => s.key===slotKey);
    return `${slot.labelLong} du ${DAYS_FR[date.getDay()].toLowerCase()} ${d} ${MONTHS_FR[m-1]}`;
  }

  function formatDateFR(dateKey) {
    if (!dateKey) return '';
    const clean = normalizeDateKey(dateKey);
    const [y,m,d] = clean.split('-').map(Number);
    const date = new Date(y, m-1, d);
    if (isNaN(date.getTime())) return dateKey;
    return `${DAYS_FR[date.getDay()]} ${d} ${MONTHS_FR[m-1]}`;
  }

  // ══════════════════════════════════════════════════
  // 5. DONNÉES — IDB
  // ══════════════════════════════════════════════════

  function getCellState(dateKey, slotKey) {
    return (DS.grid[dateKey] && DS.grid[dateKey][slotKey]) || '';
  }

  /**
   * Point d'entrée principal pour changer l'état d'une cellule.
   *
   * Stratégie :
   *  a) Mise à jour IDB + mémoire immédiate (UX réactive, pas d'attente réseau)
   *  b) Si un envoi GAS est déjà en attente pour cette cellule → annuler son timer
   *  c) Planifier un envoi GAS avec debounce de 400ms
   *     → seul le dernier état déclenché dans la fenêtre est envoyé
   */
  async function setCellState(dateKey, slotKey, newState) {
    const ck = _makeCompositeKey(dateKey, slotKey);

    // a) Mise à jour locale immédiate
    if (!DS.grid[dateKey]) DS.grid[dateKey] = {};
    DS.grid[dateKey][slotKey] = newState;
    await _persistToIDB(dateKey, slotKey, newState, ck);
    renderCommonSlots();

    // b) Annuler le timer debounce existant pour cette cellule
    if (_pendingCells.has(ck)) {
      clearTimeout(_pendingCells.get(ck).timerId);
    }

    // c) Planifier un nouvel envoi dans 400ms
    const timerId = setTimeout(async () => {
      _pendingCells.delete(ck);
      // Lire l'état actuel en IDB (peut avoir changé depuis le déclenchement)
      const finalState = (DS.grid[dateKey] && DS.grid[dateKey][slotKey]) || '';
      // Pousser dans la file GAS (exécution séquentielle)
      _gasQueue.push(() => _sendToGAS(dateKey, slotKey, finalState, ck));
    }, 400);

    _pendingCells.set(ck, { timerId, latestState: newState });
  }

  function _makeCompositeKey(dateKey, slotKey) {
    return DS.sessionId + '::' + (DS.userName||'Anonyme') + '::' + dateKey + '::' + slotKey;
  }

  /** Persiste en IDB (sans toucher à GAS) */
  async function _persistToIDB(dateKey, slotKey, newState, ck) {
    const db = window._sportSyncDB;
    if (!db) return;

    const all      = await idbGetAll(db, 'dispos');
    const existing = all.find(e => e._compositeKey === ck);

    const entry = {
      _compositeKey: ck,
      name:      DS.userName || 'Anonyme',
      date:      dateKey,
      slot:      slotKey,
      state:     newState,
      sessionId: DS.sessionId,
      createdAt: (existing && existing.createdAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (existing) {
      entry.id = existing.id;
      await idbPutRaw(db, 'dispos', entry);
    } else {
      const newId = await idbPutRaw(db, 'dispos', entry);
      entry.id    = newId;
    }

    // Mettre à jour DS.allDispos en mémoire
    const idx = DS.allDispos.findIndex(e => e._compositeKey === ck);
    if (idx >= 0) DS.allDispos[idx] = entry;
    else          DS.allDispos.push(entry);
  }

  /** Envoi effectif vers GAS (appelé depuis la file) */
  async function _sendToGAS(dateKey, slotKey, finalState, ck) {
    if (typeof gasWrite !== 'function') return;
    try {
      await gasWrite('setDispoCell', {
        name:      DS.userName || 'Anonyme',
        date:      dateKey,
        slot:      slotKey,
        state:     finalState,
        sessionId: DS.sessionId,
      });
    } catch(e) {
      console.warn('[dispo] GAS sync échouée pour', ck, ':', e.message||e);
    }
  }

  // ── Chargement depuis IDB ──────────────────────────

  async function loadFromIDB() {
    const db = window._sportSyncDB;
    if (!db) return;

    const all = await idbGetAll(db, 'dispos');

    /**
     * Dédoublonnage en mémoire :
     *   On garde, pour chaque clé composite, l'entrée avec l'updatedAt le plus récent.
     *   Cela corrige les doublons éventuels déjà présents en IDB
     *   (issus de sessions précédentes avant la correction).
     */
    const byKey = new Map();
    for (const e of all) {
      const ck = e._compositeKey || _makeKeyFromEntry(e);
      if (!ck) continue;

      const existing = byKey.get(ck);
      if (!existing || e.updatedAt > existing.updatedAt) {
        byKey.set(ck, { ...e, _compositeKey: ck });
      }
    }

    DS.allDispos = Array.from(byKey.values()).map(e => ({
      ...e,
      date: normalizeDateKey(e.date),
    }));

    // Reconstruire la grille locale de l'utilisateur courant
    DS.grid = {};
    for (const e of DS.allDispos) {
      if (e.name===DS.userName && e.sessionId===DS.sessionId && e.slot) {
        if (!DS.grid[e.date]) DS.grid[e.date] = {};
        DS.grid[e.date][e.slot] = e.state || '';
      }
    }
  }

  /** Reconstitue une clé composite depuis les champs de l'entrée (fallback) */
  function _makeKeyFromEntry(e) {
    if (!e.sessionId || !e.name || !e.date || !e.slot) return null;
    return e.sessionId + '::' + e.name + '::' + normalizeDateKey(e.date) + '::' + e.slot;
  }

  // ── IDB bas niveau ─────────────────────────────────

  function idbGetAll(db, storeName) {
    return new Promise((res,rej) => {
      const req = db.transaction(storeName,'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => res(req.result||[]);
      req.onerror   = () => rej(req.error);
    });
  }

  function idbPutRaw(db, storeName, data) {
    return new Promise((res,rej) => {
      const req = db.transaction(storeName,'readwrite').objectStore(storeName).put(data);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  }

  // ══════════════════════════════════════════════════
  // 6. RENDU GRILLE
  // ══════════════════════════════════════════════════

  function renderGrid() {
    const $grid = $('#plany-grid');
    if (!$grid.length) return;
    const isDesktop = window.innerWidth >= 700;
    const days      = getWeekDays(DS.weekStart);
    const today     = toDateKey(new Date());

    $('#plany-period-label').text(formatPeriodLabel(days));
    $grid.html(isDesktop ? buildDesktopGrid(days,today) : buildMobileGrid(days,today));
    bindCellEvents($grid);
  }

  function buildDesktopGrid(days, today) {
    const headerCells = days.map(d => {
      const dk      = toDateKey(d);
      const isToday = dk===today;
      const name    = DAYS_FR[d.getDay()===0?0:d.getDay()];
      return `<th class="col-header${isToday?' today-col':''}" scope="col">${name}<br><span style="font-weight:400">${d.getDate()}</span></th>`;
    }).join('');

    const rows = SLOTS.map(slot => {
      const cells = days.map(d => buildCell(toDateKey(d), slot.key)).join('');
      return `<tr>
        <td class="row-header" scope="row">
          <span class="row-header-day">${slot.labelShort}</span>
          <span class="row-header-date">${slot.sub}</span>
        </td>${cells}</tr>`;
    }).join('');

    return `<thead><tr><th class="corner"></th>${headerCells}</tr></thead><tbody>${rows}</tbody>`;
  }

  function buildMobileGrid(days, today) {
    const headerCells = SLOTS.map(s =>
      `<th class="col-header" scope="col">${s.labelShort}<br><span style="font-weight:400;font-size:.63rem">${s.sub}</span></th>`
    ).join('');

    const rows = days.map(d => {
      const dk      = toDateKey(d);
      const isToday = dk===today;
      const dayIdx  = d.getDay()===0?0:d.getDay();
      const cells   = SLOTS.map(slot => buildCell(dk, slot.key)).join('');
      return `<tr>
        <td class="row-header${isToday?' today-row':''}" scope="row">
          <span class="row-header-day">${DAYS_SHORT[dayIdx]} ${d.getDate()}</span>
        </td>${cells}</tr>`;
    }).join('');

    return `<thead><tr><th class="corner"></th>${headerCells}</tr></thead><tbody>${rows}</tbody>`;
  }

  function buildCell(dateKey, slotKey) {
    const st     = getCellState(dateKey, slotKey);
    const icon   = st==='ok' ? '✓' : st==='no' ? '✕' : '';
    const icolor = st==='ok' ? 'color:var(--dispo-ok)' : st==='no' ? 'color:var(--dispo-no)' : '';
    const others = buildOthersSummary(dateKey, slotKey);
    const hover  = buildHoverButtons(st);

    return `<td class="dispo-cell" data-date="${dateKey}" data-slot="${slotKey}" data-state="${st}"
      role="button" tabindex="0" aria-label="${formatCellTitle(dateKey,slotKey)}">
      <span class="cell-icon" style="${icolor}">${icon}</span>
      ${others}
      <div class="cell-hover-options">${hover}</div>
    </td>`;
  }

  function buildHoverButtons(st) {
    let h = '';
    if (st!=='ok') h += `<button class="cell-hover-btn cell-hover-btn--ok"    data-action="ok"    tabindex="-1">✓ Dispo</button>`;
    if (st!=='no') h += `<button class="cell-hover-btn cell-hover-btn--no"    data-action="no"    tabindex="-1">✕ Indispo</button>`;
    if (st!=='')   h += `<button class="cell-hover-btn cell-hover-btn--clear" data-action="clear" tabindex="-1">🗑</button>`;
    return h;
  }

  function buildOthersSummary(dateKey, slotKey) {
    // Dédoublonnage par nom : on garde l'entrée la plus récente par utilisateur
    const byName = new Map();
    for (const e of DS.allDispos) {
      if (normalizeDateKey(e.date) !== dateKey) continue;
      if (e.slot !== slotKey)                  continue;
      if (e.name === DS.userName)              continue;
      if (e.sessionId !== DS.sessionId)        continue;
      if (!e.state)                            continue;

      const existing = byName.get(e.name);
      if (!existing || e.updatedAt > existing.updatedAt) byName.set(e.name, e);
    }

    if (!byName.size) return '';

    const dots = Array.from(byName.values()).slice(0,5).map(e => {
      const c = e.state==='ok' ? 'var(--dispo-ok)' : 'var(--dispo-no)';
      return `<span style="width:6px;height:6px;border-radius:50%;background:${c};display:inline-block;margin:0 1px" title="${e.name}"></span>`;
    }).join('');

    const more = byName.size>5 ? `<span style="font-size:.6rem;color:var(--dispo-sub)">+${byName.size-5}</span>` : '';

    return `<div style="position:absolute;bottom:4px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:1px">${dots}${more}</div>`;
  }

  function bindCellEvents($grid) {
    // Desktop : hover buttons
    $grid.on('click', '.cell-hover-btn', function(e) {
      e.stopPropagation();
      const $cell  = $(this).closest('.dispo-cell');
      const action = $(this).data('action');
      applyState($cell.data('date'), $cell.data('slot'), action==='clear' ? '' : action, $cell);
    });

    // Mobile : clic direct → bottom sheet
    $grid.on('click', '.dispo-cell', function(e) {
      if (window.innerWidth>=700 && window.matchMedia('(hover:hover)').matches) return;
      const $cell = $(this);
      DS.activeCell = { dateKey:$cell.data('date'), slotKey:$cell.data('slot'), $el:$cell };
      openCellSheet($cell.data('date'), $cell.data('slot'), getCellState($cell.data('date'), $cell.data('slot')));
    });

    // Accessibilité
    $grid.on('keydown', '.dispo-cell', function(e) {
      if (e.key==='Enter'||e.key===' ') { e.preventDefault(); $(this).click(); }
    });
  }

  // ══════════════════════════════════════════════════
  // 7. APPLICATION D'UN ÉTAT + FEEDBACK VISUEL
  // ══════════════════════════════════════════════════

  async function applyState(dateKey, slotKey, newState, $cell) {
    // Feedback visuel immédiat (avant même la fin de l'async IDB)
    updateCellDOM(dateKey, slotKey, newState, $cell);
    if ($cell && $cell.length) {
      $cell.removeClass('popping');
      void $cell[0].offsetWidth;
      $cell.addClass('popping');
      setTimeout(() => $cell.removeClass('popping'), 300);
    }
    // Persistance + debounce GAS
    await setCellState(dateKey, slotKey, newState);
  }

  function updateCellDOM(dateKey, slotKey, newState, $cell) {
    if (!$cell || !$cell.length)
      $cell = $(`.dispo-cell[data-date="${dateKey}"][data-slot="${slotKey}"]`);
    if (!$cell.length) return;

    $cell.attr('data-state', newState);
    const icon   = newState==='ok' ? '✓' : newState==='no' ? '✕' : '';
    const icolor = newState==='ok' ? 'color:var(--dispo-ok)' : newState==='no' ? 'color:var(--dispo-no)' : '';
    $cell.find('.cell-icon').text(icon).attr('style', icolor);
    $cell.find('.cell-hover-options').html(buildHoverButtons(newState));
  }

  // ══════════════════════════════════════════════════
  // 8. BOTTOM SHEET — CELLULE (mobile)
  // ══════════════════════════════════════════════════

  function openCellSheet(dateKey, slotKey, currentState) {
    $('#plany-cell-title').text(formatCellTitle(dateKey, slotKey));
    const opts = [];
    if (currentState!=='ok') opts.push(`<button class="cell-sheet-btn" data-action="ok"><span class="cell-sheet-icon cell-sheet-icon--ok">✅</span> Disponible</button>`);
    if (currentState!=='no') opts.push(`<button class="cell-sheet-btn" data-action="no"><span class="cell-sheet-icon cell-sheet-icon--no">❌</span> Non disponible</button>`);
    if (currentState!=='')   opts.push(`<button class="cell-sheet-btn" data-action="clear"><span class="cell-sheet-icon cell-sheet-icon--clear">🗑️</span> Annuler</button>`);
    $('#plany-cell-options').html(opts.join(''));
    $('#plany-cell-overlay').removeClass('hidden').attr('aria-hidden','false');
  }

  function closeCellSheet() {
    $('#plany-cell-overlay').addClass('hidden').attr('aria-hidden','true');
    DS.activeCell = null;
  }

  // ══════════════════════════════════════════════════
  // 9. BOTTOM SHEET — BULK
  // ══════════════════════════════════════════════════

  function openBulkSheet(target) {
    DS.bulkTarget = target;
    const label = target==='week'    ? 'Appliquer à la semaine (Lun.→Ven.)'
                : target==='weekend' ? 'Appliquer au week-end (Sam.→Dim.)'
                :                      'Toute la semaine';
    $('#plany-bulk-title').text(label);
    $('#plany-bulk-overlay').removeClass('hidden');
  }

  function closeBulkSheet() {
    $('#plany-bulk-overlay').addClass('hidden');
    DS.bulkTarget = null;
  }

  async function applyBulk(target, action) {
    const days      = getWeekDays(DS.weekStart);
    const newState  = action==='ok' ? 'ok' : action==='no' ? 'no' : '';
    let   targets   = [];

    if (target==='week')    targets = days.filter(d => d.getDay()>=1 && d.getDay()<=5);
    else if (target==='weekend') targets = days.filter(d => d.getDay()===0 || d.getDay()===6);
    else                    targets = days;

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

    /**
     * Agrégation avec dédoublonnage strict :
     *   Pour chaque (date, slot, name), on ne prend que l'entrée la plus récente.
     *   tally[dateKey][slotKey] = { ok: Set<name>, no: Set<name> }
     *   L'utilisation de Set empêche le même nom d'être compté deux fois.
     */
    const tally = {};

    // Trier par updatedAt décroissant → les plus récents sont traités en premier
    const sorted = [...DS.allDispos].sort((a,b) =>
      (b.updatedAt||'').localeCompare(a.updatedAt||'')
    );

    for (const e of sorted) {
      if (!e.date || !e.slot || !e.sessionId) continue;
      if (e.sessionId !== DS.sessionId)       continue;

      const dk = normalizeDateKey(e.date);
      if (!dk) continue;

      if (!tally[dk])          tally[dk] = {};
      if (!tally[dk][e.slot])  tally[dk][e.slot] = { ok: new Set(), no: new Set() };

      const cell = tally[dk][e.slot];
      // Le Set garantit l'unicité par nom
      if      (e.state==='ok')  cell.ok.add(e.name);
      else if (e.state==='no')  cell.no.add(e.name);
      // Si '' (effacé) → on ne l'ajoute à aucun des deux sets
    }

    // Construire la liste triée
    const items = [];
    for (const [date, slots] of Object.entries(tally)) {
      for (const [slot, counts] of Object.entries(slots)) {
        if (counts.ok.size > 0) {
          items.push({
            date,
            slot,
            ok: Array.from(counts.ok),
            no: Array.from(counts.no),
          });
        }
      }
    }
    items.sort((a,b) => b.ok.length - a.ok.length || a.date.localeCompare(b.date));

    if (!items.length) {
      $panel.html('<p class="empty-state">Aucun créneau commun pour l\'instant.<br>Renseignez vos disponibilités dans la grille ci-dessus.</p>');
      return;
    }

    // Participants distincts ayant répondu (au moins un créneau renseigné)
    const participants = new Set(
      DS.allDispos
        .filter(e => e.sessionId===DS.sessionId && e.state)
        .map(e => e.name)
    );
    const total = participants.size;

    const html = items.slice(0,8).map(item => {
      const slotDef  = SLOTS.find(s => s.key===item.slot);
      const pct      = total>0 ? Math.round((item.ok.length/total)*100) : 0;
      const score    = item.ok.length;
      const perfect  = score>=total && total>0;
      const barClass = perfect ? 'bar--perfect' : pct>=70 ? 'bar--high' : pct>=40 ? 'bar--mid' : 'bar--low';

      return `
        <div class="common-slot-item ${perfect?'common-slot-item--perfect':''}">
          <div class="common-slot-main">
            <div class="common-slot-meta">
              <span class="common-slot-date">${formatDateFR(item.date)}</span>
              <span class="common-slot-period">${slotDef ? slotDef.labelShort+' · '+slotDef.sub : item.slot}</span>
            </div>
            <div class="common-slot-score">
              <span class="score-badge ${perfect?'score-badge--perfect':''}">
                ${perfect?'🏆':'👥'} ${score}${total>0?'/'+total:''} dispo
              </span>
            </div>
          </div>
          <div class="common-slot-bar-wrap">
            <div class="common-slot-bar ${barClass}" style="width:${pct}%"></div>
          </div>
          ${item.ok.length ? `<div class="common-slot-names ok-names">✓ ${item.ok.join(', ')}</div>` : ''}
          ${item.no.length ? `<div class="common-slot-names no-names">✕ ${item.no.join(', ')}</div>` : ''}
        </div>`;
    }).join('');

    $panel.html(`
      <div class="common-slots-header">
        <span class="common-slots-title">Créneaux les plus favorables</span>
        <span class="common-slots-participants">${total} participant${total>1?'s':''}</span>
      </div>
      ${html}`);
  }

  // ══════════════════════════════════════════════════
  // 11. NAVIGATION SEMAINE
  // ══════════════════════════════════════════════════

  function navigateWeek(delta) {
    DS.weekStart = new Date(DS.weekStart);
    DS.weekStart.setDate(DS.weekStart.getDate() + delta*7);
    renderGrid();
  }

  function goToToday() {
    DS.weekStart = getMondayOf(new Date());
    renderGrid();
  }

  // ══════════════════════════════════════════════════
  // 12. PRÉNOM UTILISATEUR
  // ══════════════════════════════════════════════════

  function initUserName() {
    const saved = localStorage.getItem('sportsync_username') || '';
    DS.userName = saved;
    $('#dispo-username').val(saved);

    $(document).on('change blur', '#dispo-username', async function() {
      const newName = $(this).val().trim();
      if (newName === DS.userName) return;
      DS.userName = newName;
      localStorage.setItem('sportsync_username', newName);
      await loadFromIDB();
      renderGrid();
      renderCommonSlots();
    });
  }

  // ══════════════════════════════════════════════════
  // 13. BINDING ÉVÉNEMENTS
  // ══════════════════════════════════════════════════

  function bindDispoEvents() {
    $(document).on('click','#btn-week-prev',    () => navigateWeek(-1));
    $(document).on('click','#btn-week-next',    () => navigateWeek(+1));
    $(document).on('click','#btn-week-today',   goToToday);

    $(document).on('click','#btn-filter-week',    () => openBulkSheet('week'));
    $(document).on('click','#btn-filter-weekend', () => openBulkSheet('weekend'));
    $(document).on('click','#btn-filter-clear',   () => openBulkSheet('all'));

    $(document).on('click','[data-bulk]', async function() {
      const action = $(this).data('bulk');
      const target = DS.bulkTarget;
      closeBulkSheet();
      if (action && action!=='cancel') await applyBulk(target, action);
    });
    $(document).on('click','#btn-bulk-cancel', closeBulkSheet);
    $(document).on('click','#plany-bulk-overlay', function(e) { if(e.target===this) closeBulkSheet(); });

    $(document).on('click','#plany-cell-options .cell-sheet-btn', async function() {
      const action   = $(this).data('action');
      const newState = action==='clear' ? '' : action;
      if (DS.activeCell)
        await applyState(DS.activeCell.dateKey, DS.activeCell.slotKey, newState, DS.activeCell.$el);
      closeCellSheet();
    });
    $(document).on('click','#btn-cell-close', closeCellSheet);
    $(document).on('click','#plany-cell-overlay', function(e) { if(e.target===this) closeCellSheet(); });

    let lastBp = window.innerWidth >= 700;
    $(window).on('resize.dispo', function() {
      const cur = window.innerWidth >= 700;
      if (cur!==lastBp) { lastBp=cur; renderGrid(); }
    });
  }

  // ══════════════════════════════════════════════════
  // 14. INITIALISATION
  // ══════════════════════════════════════════════════

  async function init(opts) {
    opts = opts || {};
    if (opts.db)        window._sportSyncDB = opts.db;
    if (opts.sessionId) DS.sessionId        = opts.sessionId;
    if (window.state && window.state.sessionId) DS.sessionId = window.state.sessionId;

    DS.weekStart = getMondayOf(new Date());
    initUserName();
    await loadFromIDB();
    bindDispoEvents();
    renderGrid();
    renderCommonSlots();
    console.log('[Dispo v4] Initialisé ✓ sessionId=' + DS.sessionId);
  }

  async function refresh() {
    await loadFromIDB();
    renderGrid();
    renderCommonSlots();
  }

  function getSummary() {
    const out = {};
    for (const [dk, slots] of Object.entries(DS.grid))
      for (const [sk, st] of Object.entries(slots))
        { if (!out[dk]) out[dk]={}; out[dk][sk]=st; }
    return out;
  }

  // ── Export global ────────────────────────────────
  window.SportSyncDispo = { init, refresh, getSummary, renderGrid, renderCommonSlots };

  // Auto-init fallback
  $(document).ready(function() {
    setTimeout(function() {
      if (!window._dispoInitialized) {
        console.info('[Dispo] auto-init (sans app.js)');
        init();
        window._dispoInitialized = true;
      }
    }, 350);
  });

}(jQuery));
