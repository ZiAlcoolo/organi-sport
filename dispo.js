/**
 * ════════════════════════════════════════════════════════════════
 * SPORTSYNC — dispo.js  v5  (jQuery)
 * Module Disponibilités — Grille style Plany + créneaux communs
 * ════════════════════════════════════════════════════════════════
 *
 * Stratégie anti-doublons & synchro rapide v5 :
 *   1. Mise à jour IDB locale immédiate (UX réactive)
 *   2. Debounce 350ms par cellule via _pendingCells
 *   3. Batch flush : quand la file est vide, on envoie TOUTES les
 *      cellules pending en UN SEUL POST (action batchSetDispos),
 *      ce qui est bien plus rapide que des requêtes séquentielles.
 *   4. Sauvegarde secours dans localStorage : si l'utilisateur
 *      ferme/quitte la page avec des items en attente, ils sont
 *      persistés et renvoyés au prochain démarrage.
 *   5. Sync 30s passive : ne touche pas aux cellules pending.
 *   6. Lock Service côté GAS pour les écritures concurrentes.
 */

;(function ($) {
  'use strict';

  // ══════════════════════════════════════════════════
  // 1. CONSTANTES
  // ══════════════════════════════════════════════════

  const SLOTS = [
    { key:'morning',   labelShort:'Matin',      labelLong:'Matin',      sub:'6H à 12H'        },
    { key:'afternoon', labelShort:'Après-midi', labelLong:'Après-midi', sub:'12H à 18H'       },
    { key:'evening',   labelShort:'Soir',       labelLong:'Soir',       sub:'à partir de 18H' },
  ];

  const DAYS_FR    = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
  const DAYS_SHORT = ['Dim.','Lun.','Mar.','Mer.','Jeu.','Ven.','Sam.'];
  const MONTHS_FR  = ['janvier','février','mars','avril','mai','juin',
                       'juillet','août','septembre','octobre','novembre','décembre'];

  const LS_PENDING_KEY = 'sportsync_pending_dispos'; // localStorage fallback

  // ══════════════════════════════════════════════════
  // 2. STATE
  // ══════════════════════════════════════════════════

  const DS = {
    weekStart:  null,
    grid:       {},
    allDispos:  [],
    userName:   '',
    sessionId:  'recurring',
    activeCell: null,
    bulkTarget: null,
  };

  // ══════════════════════════════════════════════════
  // 3. BATCH SYNC — Pending cells + envoi groupé
  // ══════════════════════════════════════════════════

  /**
   * _pendingCells : Map<compositeKey, { timerId, dateKey, slotKey, state }>
   *   Même principe debounce qu'avant, mais le flush envoie TOUT en batch.
   */
  const _pendingCells = new Map();
  let   _batchTimer   = null;
  let   _isSending    = false;

  /**
   * Planifie l'envoi d'une cellule.
   * - Annule le timer existant pour cette cellule (debounce individuel 350ms)
   * - Planifie un batch flush global 500ms après le dernier changement
   */
  function _scheduleSend(ck, dateKey, slotKey, newState) {
    // Debounce individuel : si la cellule change encore dans 350ms, on annule
    if (_pendingCells.has(ck)) clearTimeout(_pendingCells.get(ck).timerId);

    const timerId = setTimeout(() => {
      // Après 350ms sans nouveau changement sur CETTE cellule, elle est
      // considérée "stable" et prête pour le batch
      const cell = _pendingCells.get(ck);
      if (cell) cell.ready = true;
      _scheduleBatchFlush();
    }, 350);

    _pendingCells.set(ck, { timerId, dateKey, slotKey, state: newState, ready: false });
    _persistPendingToLS(); // sauvegarde immédiate dans localStorage

    // Timeout de sécurité : si le batch n'est pas envoyé dans 5s,
    // forcer quand même (protège contre des debounces qui se réenchaînent)
    clearTimeout(_batchTimer);
    _batchTimer = setTimeout(_flushBatch, 5000);
  }

  function _scheduleBatchFlush() {
    clearTimeout(_batchTimer);
    _batchTimer = setTimeout(_flushBatch, 200); // léger délai pour agréger
  }

  /**
   * Envoie toutes les cellules "ready" en un seul POST.
   * Les cellules encore en debounce (ready=false) restent dans la map.
   */
  async function _flushBatch() {
    if (_isSending) return; // déjà en cours
    if (!_pendingCells.size) return;
    if (typeof gasWrite !== 'function') return;

    // Sélectionner seulement les cellules prêtes
    const toSend = [];
    for (const [ck, cell] of _pendingCells.entries()) {
      if (cell.ready) toSend.push({ ck, ...cell });
    }
    if (!toSend.length) return;

    _isSending = true;
    _updatePendingBadge();

    // Retirer de la map AVANT l'envoi pour éviter un double envoi
    toSend.forEach(c => _pendingCells.delete(c.ck));
    _persistPendingToLS();

    try {
      await gasWrite('batchSetDispos', {
        cells: toSend.map(c => ({
          name:      DS.userName || 'Anonyme',
          date:      c.dateKey,
          slot:      c.slotKey,
          state:     c.state,
          sessionId: DS.sessionId,
        })),
      });
      console.log(`[dispo] Batch envoyé : ${toSend.length} cellule(s)`);
    } catch(e) {
      console.warn('[dispo] Batch GAS échoué, remettre en pending:', e.message||e);
      // Remettre en pending pour retry
      toSend.forEach(c => {
        _pendingCells.set(c.ck, { ...c, ready: true });
      });
      _persistPendingToLS();
      _scheduleBatchFlush(); // réessayer dans 200ms
    }

    _isSending = false;
    _updatePendingBadge();

    // S'il reste des items ready, relancer
    const stillReady = Array.from(_pendingCells.values()).some(c => c.ready);
    if (stillReady) _scheduleBatchFlush();
  }

  // ── Persistance localStorage (fallback page close) ──

  function _persistPendingToLS() {
    try {
      if (_pendingCells.size) {
        const data = Array.from(_pendingCells.entries()).map(([ck, cell]) => ({
          ck, dateKey: cell.dateKey, slotKey: cell.slotKey,
          state: cell.state, sessionId: DS.sessionId,
          name: DS.userName||'Anonyme',
        }));
        localStorage.setItem(LS_PENDING_KEY, JSON.stringify(data));
      } else {
        localStorage.removeItem(LS_PENDING_KEY);
      }
    } catch(e) { /* localStorage plein ou indisponible */ }
  }

  /** Au démarrage, envoie les cellules non envoyées lors de la session précédente */
  async function _replayPendingFromLS() {
    try {
      const raw = localStorage.getItem(LS_PENDING_KEY);
      if (!raw) return;
      const pending = JSON.parse(raw);
      if (!pending || !pending.length) return;
      localStorage.removeItem(LS_PENDING_KEY);

      // Filtrer uniquement les cellules de la session courante
      const mine = pending.filter(c =>
        c.sessionId === DS.sessionId && c.name === (DS.userName||'Anonyme'));
      if (!mine.length) return;

      console.log(`[dispo] Replay ${mine.length} cellule(s) non envoyée(s)`);
      await gasWrite('batchSetDispos', {
        cells: mine.map(c => ({
          name: c.name, date: c.dateKey, slot: c.slotKey,
          state: c.state, sessionId: c.sessionId,
        })),
      });
    } catch(e) {
      console.warn('[dispo] Replay LS échoué:', e.message||e);
    }
  }

  /** Badge visuel "X en attente d'envoi" */
  function _updatePendingBadge() {
    const n = _pendingCells.size;
    const $b = $('#dispo-pending-badge');
    if (!$b.length) return;
    if (n > 0) $b.text(`⏳ ${n} en cours d'envoi…`).removeClass('hidden');
    else        $b.addClass('hidden');
  }

  // Sauvegarde avant fermeture de la page
  function _bindBeforeUnload() {
    $(window).on('beforeunload', () => {
      // Marquer toutes les cellules pending comme ready et persister
      for (const [, cell] of _pendingCells.entries()) cell.ready = true;
      _persistPendingToLS();
      // Tenter un envoi synchrone (navigator.sendBeacon si disponible)
      if (_pendingCells.size && typeof navigator.sendBeacon === 'function' &&
          CONFIG && CONFIG.GAS_URL && CONFIG.GAS_URL !== 'VOTRE_URL_APPS_SCRIPT_ICI') {
        const cells = Array.from(_pendingCells.values()).map(c => ({
          name: DS.userName||'Anonyme', date: c.dateKey, slot: c.slotKey,
          state: c.state, sessionId: DS.sessionId,
        }));
        const body = JSON.stringify({ action:'batchSetDispos', sessionId:DS.sessionId, cells });
        navigator.sendBeacon(CONFIG.GAS_URL, new Blob([body], {type:'text/plain'}));
      }
    });
  }

  // ══════════════════════════════════════════════════
  // 4. UTILITAIRES DATE
  // ══════════════════════════════════════════════════

  function toDateKey(d) {
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  }

  function normalizeDateKey(val) {
    if (!val) return '';
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s.includes('T') ? s : s+'T12:00');
    if (!isNaN(d.getTime())) return toDateKey(d);
    return s;
  }

  function getMondayOf(date) {
    const d = new Date(date), day = d.getDay();
    d.setDate(d.getDate()+(day===0?-6:1-day));
    d.setHours(0,0,0,0);
    return d;
  }

  function getWeekDays(monday) {
    return Array.from({length:7},(_,i)=>{ const d=new Date(monday); d.setDate(d.getDate()+i); return d; });
  }

  function formatPeriodLabel(days) {
    const f=days[0],l=days[6];
    return f.getMonth()===l.getMonth()
      ? `${f.getDate()} au ${l.getDate()} ${MONTHS_FR[l.getMonth()]} ${l.getFullYear()}`
      : `${f.getDate()} ${MONTHS_FR[f.getMonth()]} au ${l.getDate()} ${MONTHS_FR[l.getMonth()]} ${l.getFullYear()}`;
  }

  function formatCellTitle(dateKey, slotKey) {
    const [y,m,d]=dateKey.split('-').map(Number);
    const date=new Date(y,m-1,d);
    const slot=SLOTS.find(s=>s.key===slotKey);
    return `${slot.labelLong} du ${DAYS_FR[date.getDay()].toLowerCase()} ${d} ${MONTHS_FR[m-1]}`;
  }

  function formatDateFR(dateKey) {
    if (!dateKey) return '';
    const clean=normalizeDateKey(dateKey);
    const [y,m,d]=clean.split('-').map(Number);
    const date=new Date(y,m-1,d);
    if (isNaN(date.getTime())) return dateKey;
    return `${DAYS_FR[date.getDay()]} ${d} ${MONTHS_FR[m-1]}`;
  }

  // ══════════════════════════════════════════════════
  // 5. DONNÉES — IDB
  // ══════════════════════════════════════════════════

  function getCellState(dateKey, slotKey) {
    return (DS.grid[dateKey] && DS.grid[dateKey][slotKey]) || '';
  }

  function _makeCompositeKey(dateKey, slotKey) {
    return DS.sessionId+'::'+( DS.userName||'Anonyme')+'::'+dateKey+'::'+slotKey;
  }

  function _makeKeyFromEntry(e) {
    if (!e.sessionId||!e.name||!e.date||!e.slot) return null;
    return e.sessionId+'::'+e.name+'::'+normalizeDateKey(e.date)+'::'+e.slot;
  }

  async function setCellState(dateKey, slotKey, newState) {
    const ck = _makeCompositeKey(dateKey, slotKey);
    if (!DS.grid[dateKey]) DS.grid[dateKey] = {};
    DS.grid[dateKey][slotKey] = newState;
    await _persistToIDB(dateKey, slotKey, newState, ck);
    _scheduleSend(ck, dateKey, slotKey, newState);
    _updatePendingBadge();
    renderCommonSlots();
  }

  async function _persistToIDB(dateKey, slotKey, newState, ck) {
    const db = window._sportSyncDB;
    if (!db) return;
    const all      = await idbGetAll(db,'dispos');
    const existing = all.find(e=>e._compositeKey===ck);
    const entry = {
      _compositeKey: ck,
      name:      DS.userName||'Anonyme',
      date:      dateKey,
      slot:      slotKey,
      state:     newState,
      sessionId: DS.sessionId,
      createdAt: (existing&&existing.createdAt)||new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (existing) { entry.id=existing.id; await idbPutRaw(db,'dispos',entry); }
    else          { const id=await idbPutRaw(db,'dispos',entry); entry.id=id; }
    const idx=DS.allDispos.findIndex(e=>e._compositeKey===ck);
    if(idx>=0) DS.allDispos[idx]=entry; else DS.allDispos.push(entry);
  }

  /**
   * Charge les données depuis IDB.
   * Paramètre `preserveLocalGrid` : si true, ne remplace PAS les cellules
   * de l'utilisateur courant qui sont en cours d'envoi (_pendingCells).
   * Utilisé pour la synchro passive des 30s.
   */
  async function loadFromIDB(preserveLocalGrid) {
    const db = window._sportSyncDB;
    if (!db) return;
    const all = await idbGetAll(db,'dispos');

    const byKey = new Map();
    for (const e of all) {
      const ck = e._compositeKey || _makeKeyFromEntry(e);
      if (!ck) continue;
      const existing = byKey.get(ck);
      if (!existing || e.updatedAt > existing.updatedAt)
        byKey.set(ck, {...e, _compositeKey:ck});
    }

    DS.allDispos = Array.from(byKey.values()).map(e=>({...e, date:normalizeDateKey(e.date)}));

    if (preserveLocalGrid) {
      // Ne mettre à jour que les cellules des AUTRES utilisateurs
      // (garder intact le grid de l'utilisateur courant avec ses pending)
      for (const e of DS.allDispos) {
        if (e.name===DS.userName) continue; // skip ses propres cellules
        if (e.sessionId!==DS.sessionId || !e.slot) continue;
        if (!DS.grid[e.date]) DS.grid[e.date] = {};
        // Ne pas écraser si une cellule locale est en pending pour cette date/slot
        const ck = _makeKeyFromEntry(e);
        if (!_pendingCells.has(ck)) DS.grid[e.date][e.slot] = e.state||'';
      }
    } else {
      // Reconstruction complète du grid
      DS.grid = {};
      for (const e of DS.allDispos) {
        if (e.name===DS.userName && e.sessionId===DS.sessionId && e.slot) {
          if (!DS.grid[e.date]) DS.grid[e.date] = {};
          DS.grid[e.date][e.slot] = e.state||'';
        }
      }
    }
  }

  function idbGetAll(db,storeName) {
    return new Promise((res,rej)=>{
      const req=db.transaction(storeName,'readonly').objectStore(storeName).getAll();
      req.onsuccess=()=>res(req.result||[]);
      req.onerror=()=>rej(req.error);
    });
  }
  function idbPutRaw(db,storeName,data) {
    return new Promise((res,rej)=>{
      const req=db.transaction(storeName,'readwrite').objectStore(storeName).put(data);
      req.onsuccess=()=>res(req.result);
      req.onerror=()=>rej(req.error);
    });
  }

  // ══════════════════════════════════════════════════
  // 6. SYNC PASSIVE 30s
  // ══════════════════════════════════════════════════

  let _autoSyncTimer = null;

  function startAutoSync() {
    stopAutoSync();
    _autoSyncTimer = setInterval(async () => {
      if (typeof gasWrite !== 'function') return;
      if (!window._sportSyncDB) return;
      // Ne pas lancer si on a une synchro GAS en cours (les cellules pending)
      if (_isSending) return;
      try {
        // Récupérer uniquement les données distantes
        const remote = await (typeof gasFetchAll === 'function' ? gasFetchAll() : Promise.reject('no fn'));
        if (!remote || !remote.dispos) return;

        // Merger les dispos distantes dans IDB sans toucher aux pending locaux
        const db = window._sportSyncDB;
        if (!db) return;

        for (const d of (remote.dispos||[])) {
          const ck = (d.sessionId||'')+'::'+d.name+'::'+d.date+'::'+d.slot;
          // Ne pas écraser une cellule pending de l'utilisateur courant
          if (_pendingCells.has(ck)) continue;
          const existing = DS.allDispos.find(e=>e._compositeKey===ck);
          if (existing && existing.updatedAt >= (d.updatedAt||'')) continue; // déjà à jour
          await idbPutRaw(db,'dispos',{
            _compositeKey: ck,
            id: (existing&&existing.id) || ck,
            name: d.name||'', date: d.date||'', slot: d.slot||'',
            state: d.state||'', sessionId: d.sessionId||'',
            updatedAt: d.updatedAt||'',
          });
        }

        // Recharger depuis IDB en mode "préserve local"
        await loadFromIDB(true);
        renderGrid();
        renderCommonSlots();

        // Mettre à jour le footer de sync
        if (typeof updateSyncFooter === 'function') updateSyncFooter();
        console.log('[dispo] Auto-sync 30s OK');
      } catch(e) {
        console.warn('[dispo] Auto-sync échouée:', e.message||e);
      }
    }, 30000);
  }

  function stopAutoSync() {
    if (_autoSyncTimer) { clearInterval(_autoSyncTimer); _autoSyncTimer=null; }
  }

  // ══════════════════════════════════════════════════
  // 7. RENDU GRILLE
  // ══════════════════════════════════════════════════

  function renderGrid() {
    const $grid=$('#plany-grid');
    if(!$grid.length) return;
    const isDesktop=window.innerWidth>=700;
    const days=getWeekDays(DS.weekStart);
    const today=toDateKey(new Date());
    $('#plany-period-label').text(formatPeriodLabel(days));
    $grid.html(isDesktop ? buildDesktopGrid(days,today) : buildMobileGrid(days,today));
    bindCellEvents($grid);
  }

  function buildDesktopGrid(days,today) {
    const hd=days.map(d=>{
      const dk=toDateKey(d),it=dk===today;
      const name=DAYS_FR[d.getDay()===0?0:d.getDay()];
      return `<th class="col-header${it?' today-col':''}" scope="col">${name}<br><span style="font-weight:400">${d.getDate()}</span></th>`;
    }).join('');
    const rows=SLOTS.map(slot=>{
      const cells=days.map(d=>buildCell(toDateKey(d),slot.key)).join('');
      return `<tr><td class="row-header" scope="row"><span class="row-header-day">${slot.labelShort}</span><span class="row-header-date">${slot.sub}</span></td>${cells}</tr>`;
    }).join('');
    return `<thead><tr><th class="corner"></th>${hd}</tr></thead><tbody>${rows}</tbody>`;
  }

  function buildMobileGrid(days,today) {
    const hd=SLOTS.map(s=>`<th class="col-header" scope="col">${s.labelShort}<br><span style="font-weight:400;font-size:.63rem">${s.sub}</span></th>`).join('');
    const rows=days.map(d=>{
      const dk=toDateKey(d),it=dk===today,dayIdx=d.getDay()===0?0:d.getDay();
      const cells=SLOTS.map(slot=>buildCell(dk,slot.key)).join('');
      return `<tr><td class="row-header${it?' today-row':''}" scope="row"><span class="row-header-day">${DAYS_SHORT[dayIdx]} ${d.getDate()}</span></td>${cells}</tr>`;
    }).join('');
    return `<thead><tr><th class="corner"></th>${hd}</tr></thead><tbody>${rows}</tbody>`;
  }

  function buildCell(dateKey,slotKey) {
    const st=getCellState(dateKey,slotKey);
    const icon=st==='ok'?'✓':st==='no'?'✕':'';
    const icolor=st==='ok'?'color:var(--dispo-ok)':st==='no'?'color:var(--dispo-no)':'';
    const ck=_makeCompositeKey(dateKey,slotKey);
    const isPending=_pendingCells.has(ck);
    const others=buildOthersSummary(dateKey,slotKey);
    const hover=buildHoverButtons(st);
    return `<td class="dispo-cell${isPending?' dispo-cell--pending':''}" data-date="${dateKey}" data-slot="${slotKey}" data-state="${st}" role="button" tabindex="0" aria-label="${formatCellTitle(dateKey,slotKey)}">
      <span class="cell-icon" style="${icolor}">${icon}</span>
      ${others}
      <div class="cell-hover-options">${hover}</div>
    </td>`;
  }

  function buildHoverButtons(st) {
    let h='';
    if(st!=='ok') h+=`<button class="cell-hover-btn cell-hover-btn--ok" data-action="ok" tabindex="-1">✓ Dispo</button>`;
    if(st!=='no') h+=`<button class="cell-hover-btn cell-hover-btn--no" data-action="no" tabindex="-1">✕ Indispo</button>`;
    if(st!=='')   h+=`<button class="cell-hover-btn cell-hover-btn--clear" data-action="clear" tabindex="-1">🗑</button>`;
    return h;
  }

  function buildOthersSummary(dateKey,slotKey) {
    const byName=new Map();
    for(const e of DS.allDispos){
      if(normalizeDateKey(e.date)!==dateKey) continue;
      if(e.slot!==slotKey||e.name===DS.userName||e.sessionId!==DS.sessionId||!e.state) continue;
      const existing=byName.get(e.name);
      if(!existing||e.updatedAt>existing.updatedAt) byName.set(e.name,e);
    }
    if(!byName.size) return '';
    const dots=Array.from(byName.values()).slice(0,5).map(e=>{
      const c=e.state==='ok'?'var(--dispo-ok)':'var(--dispo-no)';
      return `<span style="width:6px;height:6px;border-radius:50%;background:${c};display:inline-block;margin:0 1px" title="${e.name}"></span>`;
    }).join('');
    const more=byName.size>5?`<span style="font-size:.6rem;color:var(--dispo-sub)">+${byName.size-5}</span>`:'';
    return `<div style="position:absolute;bottom:4px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:1px">${dots}${more}</div>`;
  }

  function bindCellEvents($grid) {
    $grid.on('click','.cell-hover-btn',function(e){
      e.stopPropagation();
      const $cell=$(this).closest('.dispo-cell');
      const action=$(this).data('action');
      applyState($cell.data('date'),$cell.data('slot'),action==='clear'?'':action,$cell);
    });
    $grid.on('click','.dispo-cell',function(e){
      if(window.innerWidth>=700&&window.matchMedia('(hover:hover)').matches) return;
      const $cell=$(this);
      DS.activeCell={dateKey:$cell.data('date'),slotKey:$cell.data('slot'),$el:$cell};
      openCellSheet($cell.data('date'),$cell.data('slot'),getCellState($cell.data('date'),$cell.data('slot')));
    });
    $grid.on('keydown','.dispo-cell',function(e){
      if(e.key==='Enter'||e.key===' '){e.preventDefault();$(this).click();}
    });
  }

  // ══════════════════════════════════════════════════
  // 8. APPLICATION D'UN ÉTAT
  // ══════════════════════════════════════════════════

  async function applyState(dateKey,slotKey,newState,$cell) {
    updateCellDOM(dateKey,slotKey,newState,$cell);
    if($cell&&$cell.length){
      $cell.removeClass('popping');
      void $cell[0].offsetWidth;
      $cell.addClass('popping');
      setTimeout(()=>$cell.removeClass('popping'),300);
    }
    await setCellState(dateKey,slotKey,newState);
  }

  function updateCellDOM(dateKey,slotKey,newState,$cell) {
    if(!$cell||!$cell.length) $cell=$(`.dispo-cell[data-date="${dateKey}"][data-slot="${slotKey}"]`);
    if(!$cell.length) return;
    $cell.attr('data-state',newState);
    const icon=newState==='ok'?'✓':newState==='no'?'✕':'';
    const icolor=newState==='ok'?'color:var(--dispo-ok)':newState==='no'?'color:var(--dispo-no)':'';
    $cell.find('.cell-icon').text(icon).attr('style',icolor);
    $cell.find('.cell-hover-options').html(buildHoverButtons(newState));
  }

  // ══════════════════════════════════════════════════
  // 9. BOTTOM SHEETS
  // ══════════════════════════════════════════════════

  function openCellSheet(dateKey,slotKey,currentState) {
    $('#plany-cell-title').text(formatCellTitle(dateKey,slotKey));
    const opts=[];
    if(currentState!=='ok') opts.push(`<button class="cell-sheet-btn" data-action="ok"><span class="cell-sheet-icon cell-sheet-icon--ok">✅</span> Disponible</button>`);
    if(currentState!=='no') opts.push(`<button class="cell-sheet-btn" data-action="no"><span class="cell-sheet-icon cell-sheet-icon--no">❌</span> Non disponible</button>`);
    if(currentState!=='')   opts.push(`<button class="cell-sheet-btn" data-action="clear"><span class="cell-sheet-icon cell-sheet-icon--clear">🗑️</span> Annuler</button>`);
    $('#plany-cell-options').html(opts.join(''));
    $('#plany-cell-overlay').removeClass('hidden').attr('aria-hidden','false');
  }
  function closeCellSheet(){$('#plany-cell-overlay').addClass('hidden').attr('aria-hidden','true');DS.activeCell=null;}
  function openBulkSheet(target){
    DS.bulkTarget=target;
    const label=target==='week'?'Semaine (Lun.→Ven.)':target==='weekend'?'Week-end (Sam.→Dim.)':'Toute la semaine';
    $('#plany-bulk-title').text(label);
    $('#plany-bulk-overlay').removeClass('hidden');
  }
  function closeBulkSheet(){$('#plany-bulk-overlay').addClass('hidden');DS.bulkTarget=null;}

  async function applyBulk(target,action) {
    const days=getWeekDays(DS.weekStart);
    const newState=action==='ok'?'ok':action==='no'?'no':'';
    let targets=[];
    if(target==='week')    targets=days.filter(d=>d.getDay()>=1&&d.getDay()<=5);
    else if(target==='weekend') targets=days.filter(d=>d.getDay()===0||d.getDay()===6);
    else targets=days;
    for(const d of targets) {
      const dk=toDateKey(d);
      for(const slot of SLOTS) await setCellState(dk,slot.key,newState);
    }
    renderGrid();
    renderCommonSlots();
  }

  // ══════════════════════════════════════════════════
  // 10. PANNEAU CRÉNEAUX COMMUNS
  // ══════════════════════════════════════════════════

  function renderCommonSlots() {
    const $panel=$('#dispo-common-slots');
    if(!$panel.length) return;
    const tally={};
    const sorted=[...DS.allDispos].sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''));
    for(const e of sorted){
      if(!e.date||!e.slot||!e.sessionId||e.sessionId!==DS.sessionId) continue;
      const dk=normalizeDateKey(e.date);if(!dk) continue;
      if(!tally[dk]) tally[dk]={};
      if(!tally[dk][e.slot]) tally[dk][e.slot]={ok:new Set(),no:new Set()};
      const cell=tally[dk][e.slot];
      if(e.state==='ok')      cell.ok.add(e.name);
      else if(e.state==='no') cell.no.add(e.name);
    }
    const items=[];
    for(const[date,slots] of Object.entries(tally))
      for(const[slot,counts] of Object.entries(slots))
        if(counts.ok.size>0) items.push({date,slot,ok:Array.from(counts.ok),no:Array.from(counts.no)});
    items.sort((a,b)=>b.ok.length-a.ok.length||a.date.localeCompare(b.date));
    if(!items.length){$panel.html('<p class="empty-state">Aucun créneau commun.<br>Renseignez vos disponibilités ci-dessus.</p>');return;}
    const participants=new Set(DS.allDispos.filter(e=>e.sessionId===DS.sessionId&&e.state).map(e=>e.name));
    const total=participants.size;
    const html=items.slice(0,8).map(item=>{
      const slotDef=SLOTS.find(s=>s.key===item.slot);
      const pct=total>0?Math.round((item.ok.length/total)*100):0;
      const score=item.ok.length,perfect=score>=total&&total>0;
      const barClass=perfect?'bar--perfect':pct>=70?'bar--high':pct>=40?'bar--mid':'bar--low';
      return `<div class="common-slot-item ${perfect?'common-slot-item--perfect':''}">
        <div class="common-slot-main">
          <div class="common-slot-meta">
            <span class="common-slot-date">${formatDateFR(item.date)}</span>
            <span class="common-slot-period">${slotDef?slotDef.labelShort+' · '+slotDef.sub:item.slot}</span>
          </div>
          <div class="common-slot-score">
            <span class="score-badge ${perfect?'score-badge--perfect':''}">
              ${perfect?'🏆':'👥'} ${score}${total>0?'/'+total:''} dispo
            </span>
          </div>
        </div>
        <div class="common-slot-bar-wrap"><div class="common-slot-bar ${barClass}" style="width:${pct}%"></div></div>
        ${item.ok.length?`<div class="common-slot-names ok-names">✓ ${item.ok.join(', ')}</div>`:''}
        ${item.no.length?`<div class="common-slot-names no-names">✕ ${item.no.join(', ')}</div>`:''}
      </div>`;
    }).join('');
    $panel.html(`<div class="common-slots-header"><span class="common-slots-title">Créneaux les plus favorables</span><span class="common-slots-participants">${total} participant${total>1?'s':''}</span></div>${html}`);
  }

  // ══════════════════════════════════════════════════
  // 11. NAVIGATION
  // ══════════════════════════════════════════════════

  function navigateWeek(delta){DS.weekStart=new Date(DS.weekStart);DS.weekStart.setDate(DS.weekStart.getDate()+delta*7);renderGrid();}
  function goToToday(){DS.weekStart=getMondayOf(new Date());renderGrid();}

  // ══════════════════════════════════════════════════
  // 12. PRÉNOM
  // ══════════════════════════════════════════════════

  function initUserName() {
    const saved=localStorage.getItem('sportsync_username')||'';
    DS.userName=saved;
    $('#dispo-username').val(saved);
    $(document).on('change blur','#dispo-username',async function(){
      const newName=$(this).val().trim();
      if(newName===DS.userName) return;
      DS.userName=newName;
      localStorage.setItem('sportsync_username',newName);
      await loadFromIDB(false);
      renderGrid();
      renderCommonSlots();
    });
  }

  // ══════════════════════════════════════════════════
  // 13. BINDING
  // ══════════════════════════════════════════════════

  function bindDispoEvents() {
    $(document).on('click','#btn-week-prev',()=>navigateWeek(-1));
    $(document).on('click','#btn-week-next',()=>navigateWeek(+1));
    $(document).on('click','#btn-week-today',goToToday);
    $(document).on('click','#btn-filter-week',()=>openBulkSheet('week'));
    $(document).on('click','#btn-filter-weekend',()=>openBulkSheet('weekend'));
    $(document).on('click','#btn-filter-clear',()=>openBulkSheet('all'));
    $(document).on('click','[data-bulk]',async function(){
      const action=$(this).data('bulk'),target=DS.bulkTarget;
      closeBulkSheet();
      if(action&&action!=='cancel') await applyBulk(target,action);
    });
    $(document).on('click','#btn-bulk-cancel',closeBulkSheet);
    $(document).on('click','#plany-bulk-overlay',function(e){if(e.target===this)closeBulkSheet();});
    $(document).on('click','#plany-cell-options .cell-sheet-btn',async function(){
      const action=$(this).data('action'),newState=action==='clear'?'':action;
      if(DS.activeCell) await applyState(DS.activeCell.dateKey,DS.activeCell.slotKey,newState,DS.activeCell.$el);
      closeCellSheet();
    });
    $(document).on('click','#btn-cell-close',closeCellSheet);
    $(document).on('click','#plany-cell-overlay',function(e){if(e.target===this)closeCellSheet();});
    let lastBp=window.innerWidth>=700;
    $(window).on('resize.dispo',function(){const cur=window.innerWidth>=700;if(cur!==lastBp){lastBp=cur;renderGrid();}});
  }

  // ══════════════════════════════════════════════════
  // 14. INIT
  // ══════════════════════════════════════════════════

  async function init(opts) {
    opts=opts||{};
    if(opts.db)        window._sportSyncDB=opts.db;
    if(opts.sessionId) DS.sessionId=opts.sessionId;
    if(window.state&&window.state.sessionId) DS.sessionId=window.state.sessionId;
    DS.weekStart=getMondayOf(new Date());
    initUserName();
    await loadFromIDB(false);
    bindDispoEvents();
    _bindBeforeUnload();
    renderGrid();
    renderCommonSlots();
    // Replayer les cellules non envoyées lors de la session précédente
    _replayPendingFromLS().catch(()=>{});
    startAutoSync();
    console.log('[Dispo v5] Initialisé ✓ sessionId='+DS.sessionId);
  }

  async function refresh(preserveLocal) {
    await loadFromIDB(!!preserveLocal);
    renderGrid();
    renderCommonSlots();
  }

  function getSummary() {
    const out={};
    for(const[dk,slots] of Object.entries(DS.grid))
      for(const[sk,st] of Object.entries(slots)){if(!out[dk])out[dk]={};out[dk][sk]=st;}
    return out;
  }

  window.SportSyncDispo={init,refresh,getSummary,renderGrid,renderCommonSlots,startAutoSync,stopAutoSync};

  $(document).ready(function(){
    setTimeout(function(){
      if(!window._dispoInitialized){console.info('[Dispo] auto-init');init();window._dispoInitialized=true;}
    },350);
  });

}(jQuery));
