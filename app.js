/**
 * ════════════════════════════════════════════════════════════════
 * SPORTSYNC — app.js  v4  (jQuery)
 * ════════════════════════════════════════════════════════════════
 * BUG FIXES v4 :
 *   - formatDate() : gère correctement les strings avec T (datetime-local)
 *   - importRemoteData dispos : conserve updatedAt, _compositeKey cohérent
 *   - idbPut dispos : id stocké en string pour éviter conflit avec autoIncrement
 *   - loadStateFromIDB : charge state.clubs depuis IDB
 *   - addPlayer : lit maxPlayers depuis state.session à chaque appel
 *   - gasRequest : JSON.stringify(body) même si body est null
 */

// ══════════════════════════════════════════════════
// 1. CONFIGURATION
// ══════════════════════════════════════════════════

const CONFIG = {
  GAS_URL: 'https://script.google.com/macros/s/AKfycbyNxNS7n5u6_YmLfPQpzc47yqaYDMACC8ABkeMI7IA1pTFHR0qgIu9q1y5pNmEI0SIT/exec',
  METEO:   { DEFAULT_LAT: 44.8378, DEFAULT_LON: -0.5792 },
  IDB:     { NAME:'sportsync', VERSION:4,
             STORES:['session','dispos','slots','players','clubs','sessions_index'] },
};

// ══════════════════════════════════════════════════
// 2. STATE GLOBAL
// ══════════════════════════════════════════════════

const state = {
  sessionType: 'once',
  sessionId:   null,
  currentStep: 1,
  currentView: 'dashboard', // 'dashboard' | 'session' | 'clubs' | 'profile'
  isOffline:   !navigator.onLine,
  isSyncing:   false,
  db:          null,
  dispos:      [],
  slots:       [],
  players:     [],
  waitlist:    [],
  session:     null,
  clubs:       [],          // annuaire clubs
  allSessions: [],          // index global sessions (dashboard)
};

// ══════════════════════════════════════════════════
// 3. INDEXEDDB
// ══════════════════════════════════════════════════

function initIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CONFIG.IDB.NAME, CONFIG.IDB.VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      CONFIG.IDB.STORES.forEach(name => {
        if (!db.objectStoreNames.contains(name))
          db.createObjectStore(name, { keyPath:'id', autoIncrement:true });
      });
      if (!db.objectStoreNames.contains('meta'))
        db.createObjectStore('meta', { keyPath:'key' });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function idbPut(store, data) {
  return new Promise((res,rej) => {
    const req = state.db.transaction(store,'readwrite').objectStore(store).put(data);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}
function idbGetAll(store) {
  return new Promise((res,rej) => {
    const req = state.db.transaction(store,'readonly').objectStore(store).getAll();
    req.onsuccess = () => res(req.result||[]);
    req.onerror   = () => rej(req.error);
  });
}
function idbDelete(store, id) {
  return new Promise((res,rej) => {
    const req = state.db.transaction(store,'readwrite').objectStore(store).delete(id);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}
function idbClear(store) {
  return new Promise((res,rej) => {
    const req = state.db.transaction(store,'readwrite').objectStore(store).clear();
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

// ══════════════════════════════════════════════════
// 4. GAS PROXY
// ══════════════════════════════════════════════════

function gasRequest(method, body, params) {
  params = params || {};
  if (!CONFIG.GAS_URL || CONFIG.GAS_URL === 'VOTRE_URL_APPS_SCRIPT_ICI')
    return $.Deferred().reject(new Error('GAS_URL non configurée')).promise();
  if (method === 'GET')
    return $.ajax({ url:CONFIG.GAS_URL+'?'+$.param(params), method:'GET', dataType:'json' });
  return $.ajax({ url:CONFIG.GAS_URL, method:'POST', contentType:'text/plain',
                  data:JSON.stringify(body||{}), dataType:'json' });
}

function gasFetchAll()        { return gasRequest('GET',null,{action:'getData',sessionId:state.sessionId||'recurring'}); }
function gasWrite(action, pl) { return gasRequest('POST',Object.assign({action,sessionId:state.sessionId||'recurring'},pl||{})); }
function gasGetAllClubs()     { return gasRequest('GET',null,{action:'getAllClubs'}); }
function gasSearchClubs(q)    { return gasRequest('GET',null,{action:'searchClubs',q}); }
function gasGetMyMatches(em)  { return gasRequest('GET',null,{action:'getMyMatches',email:em}); }
function gasGetAllSessions()  { return gasRequest('GET',null,{action:'getAllSessions'}); }

// ── Synchronisation ──────────────────────────────

async function syncFromSheets() {
  if (state.isOffline) { setSyncStatus('📵 Hors ligne','err'); return; }
  setSyncStatus('⏳ Synchronisation…');
  state.isSyncing = true;
  try {
    const remote = await gasFetchAll();
    const localMeta = await new Promise(res => {
      const req = state.db.transaction('meta','readonly').objectStore('meta').get('lastSync');
      req.onsuccess = () => res(req.result);
      req.onerror   = () => res(null);
    });
    const localTs  = (localMeta && localMeta.value) || 0;
    const remoteTs = Number(remote.timestamp) || 0;
    if (remoteTs > localTs) {
      await importRemoteData(remote);
      await idbPut('meta',{key:'lastSync',value:remoteTs});
      setSyncStatus('✅ Mis à jour — '+new Date(remoteTs).toLocaleTimeString(),'ok');
    } else {
      setSyncStatus('✅ À jour — '+new Date().toLocaleTimeString(),'ok');
    }
  } catch(err) {
    console.error('[Sync]',err);
    setSyncStatus(String(err.message||err).includes('GAS_URL') ? '⚙️ GAS_URL non configurée' : '⚠️ Synchro échouée','err');
  }
  state.isSyncing = false;
}

async function importRemoteData(remote) {
  // ── Dispos ── FIX: conserver updatedAt + _compositeKey cohérent
  await idbClear('dispos');
  for (const d of (remote.dispos||[])) {
    const ck = (d.sessionId||'')+'::'+d.name+'::'+d.date+'::'+d.slot;
    await idbPut('dispos', {
      id:            ck,          // FIX: utiliser la clé composite comme id string (pas number)
      _compositeKey: ck,
      name:          d.name      || '',
      date:          d.date      || '',  // déjà YYYY-MM-DD depuis GAS
      slot:          d.slot      || '',
      state:         d.state     || '',
      sessionId:     d.sessionId || '',
      updatedAt:     d.updatedAt || '',
    });
  }
  // ── Slots ──
  await idbClear('slots');
  for (const s of (remote.slots||[]))
    await idbPut('slots',{id:s.id,date:s.date||'',start:s.start||'',end:s.end||'',
                          venue:s.venue||'',price:s.price||'',votes:Number(s.votes)||0});
  // ── Players ──
  await idbClear('players');
  for (const p of (remote.players||[]))
    await idbPut('players',{id:p.id,name:p.name||'',status:p.status||'player'});
  // ── Session ──
  if (remote.session) {
    const s = remote.session;
    await idbPut('session',{id:'current',date:s.date||'',venue:s.venue||'',
      address:s.address||'',mapsUrl:s.mapsUrl||'',bookingUrl:s.bookingUrl||'',
      price:s.price||'',notes:s.notes||'',maxPlayers:Number(s.maxPlayers)||10,sport:s.sport||''});
  }
  await loadStateFromIDB();
}

async function loadStateFromIDB() {
  state.dispos   = await idbGetAll('dispos');
  state.slots    = await idbGetAll('slots');
  const allP     = await idbGetAll('players');
  state.players  = allP.filter(p => p.status==='player');
  state.waitlist = allP.filter(p => p.status==='waitlist');
  const sessions = await idbGetAll('session');
  state.session  = sessions.find(s => s.id==='current') || null;
  state.clubs    = await idbGetAll('clubs');
  state.allSessions = await idbGetAll('sessions_index');

  renderSlots();
  renderPlayers();
  renderSession();
  if (window.SportSyncDispo) window.SportSyncDispo.refresh();
  if (window.SportSyncHome)  window.SportSyncHome.render();
  if (window.SportSyncClubs) window.SportSyncClubs.render();
}

// Charge les clubs depuis GAS et met en cache IDB
async function loadClubs(force) {
  if (!force && state.clubs.length) return state.clubs;
  try {
    const r = await gasGetAllClubs();
    const clubs = r.clubs || [];
    await idbClear('clubs');
    for (const c of clubs) await idbPut('clubs',{...c, id: c.id||c.name});
    state.clubs = clubs;
    return clubs;
  } catch(e) {
    console.warn('[clubs]',e);
    state.clubs = await idbGetAll('clubs');
    return state.clubs;
  }
}

// ══════════════════════════════════════════════════
// 5. SMART PARSER
// ══════════════════════════════════════════════════

function smartParse(rawText) {
  const results=[], text=rawText.trim();
  if(!text) return results;
  const DATE_FR=/(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)?\s*(\d{1,2})\s+(janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)(?:\s+(\d{4}))?/gi;
  const DATE_NUM=/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/g;
  const DATE_ISO=/(\d{4})-(\d{2})-(\d{2})/g;
  const TIME_RNG=/(\d{1,2})[h:](\d{0,2})\s*[-–à]\s*(\d{1,2})[h:](\d{0,2})/gi;
  const TIME_SGL=/(\d{1,2})[h:](\d{2})/gi;
  const PRICE=/(\d+[.,]?\d*)\s*(?:€|EUR|euros?)/gi;
  const VENUE=/(?:terrain|court|salle|gymnase|stade|complexe|halle|piste|piscine|dojo)\s+(?:n[°o]?\s*\d+|[a-zÀ-ÿ\s]+)?/gi;
  const MOIS={'janvier':'01','février':'02','fevrier':'02','mars':'03','avril':'04','mai':'05',
               'juin':'06','juillet':'07','août':'08','aout':'08','septembre':'09','octobre':'10',
               'novembre':'11','décembre':'12','decembre':'12'};
  for(const block of text.split(/\n{2,}|---+|===+/)){
    if(block.trim().length<5) continue;
    const s={date:'',start:'',end:'',venue:'',price:'',raw:block.trim()};
    const mDF=DATE_FR.exec(block); DATE_FR.lastIndex=0;
    if(mDF) s.date=`${mDF[3]||new Date().getFullYear()}-${MOIS[mDF[2].toLowerCase()]||'01'}-${mDF[1].padStart(2,'0')}`;
    if(!s.date){const m=DATE_ISO.exec(block);DATE_ISO.lastIndex=0;if(m)s.date=`${m[1]}-${m[2]}-${m[3]}`;}
    if(!s.date){const m=DATE_NUM.exec(block);DATE_NUM.lastIndex=0;
      if(m)s.date=`${m[3]?(m[3].length===2?'20'+m[3]:m[3]):new Date().getFullYear()}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;}
    const mTR=TIME_RNG.exec(block);TIME_RNG.lastIndex=0;
    if(mTR){s.start=`${mTR[1].padStart(2,'0')}:${(mTR[2]||'00').padStart(2,'0')}`;
            s.end=`${mTR[3].padStart(2,'0')}:${(mTR[4]||'00').padStart(2,'0')}`;}
    else{const ts=[...block.matchAll(TIME_SGL)];
      if(ts[0])s.start=`${ts[0][1].padStart(2,'0')}:${ts[0][2].padStart(2,'0')}`;
      if(ts[1])s.end=`${ts[1][1].padStart(2,'0')}:${ts[1][2].padStart(2,'0')}`;}
    const mP=PRICE.exec(block);PRICE.lastIndex=0;if(mP)s.price=mP[1].replace(',','.')+'€';
    const mV=VENUE.exec(block);VENUE.lastIndex=0;if(mV)s.venue=mV[0].trim();
    if(s.date||s.start) results.push(s);
  }
  return results;
}

// ══════════════════════════════════════════════════
// 6. MÉTÉO
// ══════════════════════════════════════════════════

async function fetchWeather(date) {
  const{DEFAULT_LAT:lat,DEFAULT_LON:lon}=CONFIG.METEO;
  const data=await $.getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max&timezone=Europe%2FParis&start_date=${date}&end_date=${date}`);
  return{tempMax:data.daily.temperature_2m_max[0],tempMin:data.daily.temperature_2m_min[0],
         rain:data.daily.precipitation_sum[0],wind:data.daily.windspeed_10m_max[0]};
}
async function renderWeather(date){
  const $c=$('#weather-content');if(!$c.length)return;
  if(!date){$c.html('<p class="empty-state">Sélectionnez un créneau.</p>');return;}
  $c.html('<p class="empty-state">Chargement météo…</p>');
  try{const w=await fetchWeather(date);const rain=w.rain>5?'🌧':w.rain>0?'🌦':'☀️';
    $c.html(`<div class="weather-grid">
      <div class="weather-cell"><div class="weather-temp">${w.tempMax??'--'}°</div><div class="weather-label">Max</div></div>
      <div class="weather-cell"><div class="weather-temp" style="color:var(--text-sub)">${w.tempMin??'--'}°</div><div class="weather-label">Min</div></div>
      <div class="weather-cell"><div class="weather-temp" style="font-size:1.6rem">${rain}</div><div class="weather-label">${w.rain??0} mm</div></div>
      <div class="weather-cell"><div class="weather-temp" style="font-size:1rem;color:var(--accent3)">${w.wind??'--'}</div><div class="weather-label">km/h vent</div></div>
    </div>`);}catch{$c.html('<p class="empty-state">Météo non disponible.</p>');}
}

// ══════════════════════════════════════════════════
// 7. EXPORTS
// ══════════════════════════════════════════════════

function exportXLSX(){
  const wb=XLSX.utils.book_new(),s=state.session||{};
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['#','Prénom','Statut'],
    ...state.players.map((p,i)=>[i+1,p.name,'Inscrit']),
    ...state.waitlist.map((p,i)=>[state.players.length+i+1,p.name,"Liste d'attente"])]),'Inscrits');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Champ','Valeur'],
    ['Date',s.date||''],['Sport',s.sport||''],['Lieu',s.venue||''],
    ['Adresse',s.address||''],['Maps',s.mapsUrl||''],['Réservation',s.bookingUrl||''],
    ['Prix',s.price||''],['Notes',s.notes||''],['Max joueurs',s.maxPlayers||10],
    ['Inscrits',state.players.length],['Attente',state.waitlist.length]]),'Session');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Date','Début','Fin','Lieu','Prix','Votes'],
    ...state.slots.map(sl=>[sl.date,sl.start,sl.end,sl.venue,sl.price,sl.votes||0])]),'Créneaux');
  XLSX.writeFile(wb,`sportsync-${Date.now()}.xlsx`);
  showToast('Export Excel généré ✓','success');
}

function exportICS(){
  const s=state.session;if(!s?.date){showToast("Renseignez d'abord la date",'error');return;}
  // FIX: éviter double 'T' en tronquant à 16 chars si datetime-local
  const dtStr = s.date.length > 10 ? s.date : s.date+'T00:00';
  const dt=new Date(dtStr),dtEnd=new Date(dt.getTime()+3600000);
  const fmt=d=>d.toISOString().replace(/[-:]/g,'').split('.')[0]+'Z';
  const ics=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//SportSync//FR','CALSCALE:GREGORIAN',
    'METHOD:PUBLISH','BEGIN:VEVENT',
    `UID:sportsync-${state.sessionId||'session'}@app`,
    `DTSTART:${fmt(dt)}`,`DTEND:${fmt(dtEnd)}`,
    `SUMMARY:Session ${s.sport||'Sport'} — ${s.venue||'SportSync'}`,
    `DESCRIPTION:Inscrits : ${state.players.map(p=>p.name).join(', ')}\\n${s.notes||''}`,
    `LOCATION:${s.address||s.venue||''}`, 'STATUS:CONFIRMED','END:VEVENT','END:VCALENDAR'].join('\r\n');
  const url=URL.createObjectURL(new Blob([ics],{type:'text/calendar;charset=utf-8'}));
  $('<a>').attr({href:url,download:'sportsync-session.ics'})[0].click();
  URL.revokeObjectURL(url);
  showToast('Fichier calendrier généré ✓','success');
}

// ══════════════════════════════════════════════════
// 8. RENDU — étapes 2 & 3
// ══════════════════════════════════════════════════

function renderSlots(){
  const $c=$('#slots-container');if(!$c.length)return;
  if(!state.slots.length){$c.html('<p class="empty-state">Aucun créneau ajouté.</p>');return;}
  $c.html(state.slots.map(slot=>`
    <div class="slot-item">
      <div class="slot-info">
        <div class="slot-date">${formatDate(slot.date)} · ${slot.start}${slot.end?' – '+slot.end:''}</div>
        <div class="slot-meta">${slot.venue||'Lieu non précisé'}</div>
      </div>
      <span class="slot-price">${slot.price||'—'}</span>
      <button class="vote-btn ${slot._voted?'voted':''}" data-id="${slot.id}" ${state.isOffline?'disabled':''}>
        👍 ${slot.votes||0}
      </button>
    </div>`).join(''));
  $c.off('click','.vote-btn').on('click','.vote-btn',function(){voteSlot(String($(this).data('id')));});
}

function renderPlayers(){
  const $pl=$('#players-list'),$wl=$('#waitlist-container');if(!$pl.length)return;
  const maxP=(state.session&&state.session.maxPlayers)||10;
  $('#player-count').text(state.players.length);
  $('#player-max').text(maxP);
  $('#waitlist-count').text(state.waitlist.length);
  $pl.html(state.players.length?state.players.map((p,i)=>`
    <div class="player-item">
      <div><span class="player-name">${p.name}</span><span class="player-num"> #${i+1}</span></div>
      <button class="btn-delete" data-id="${p.id}" data-status="player" ${state.isOffline?'disabled':''}>✕</button>
    </div>`).join(''):'<p class="empty-state">Aucun inscrit.</p>');
  if($wl.length)$wl.html(state.waitlist.length?state.waitlist.map((p,i)=>`
    <div class="player-item">
      <div><span class="player-name">${p.name}</span><span class="player-num" style="color:var(--accent2)"> attente #${i+1}</span></div>
      <button class="btn-delete" data-id="${p.id}" data-status="waitlist" ${state.isOffline?'disabled':''}>✕</button>
    </div>`).join(''):"<p class='empty-state'>Liste d'attente vide.</p>");
  $('#players-list,#waitlist-container').off('click','.btn-delete').on('click','.btn-delete',function(){
    removePlayer(String($(this).data('id')),$(this).data('status'));});
}

function renderSession(editMode){
  const s=state.session;
  const $view=$('#session-view'),$form=$('#session-form');
  if(!$view.length||!$form.length)return;

  if(!s||!s.date){ $view.addClass('hidden');$form.removeClass('hidden');return; }

  if(editMode){
    $('#session-date').val(s.date||'');
    $('#session-venue').val(s.venue||'');
    $('#session-address').val(s.address||'');
    $('#session-maps-url').val(s.mapsUrl||'');
    $('#session-booking-url').val(s.bookingUrl||'');
    $('#session-price').val(s.price||'');
    $('#session-notes').val(s.notes||'');
    $('#session-max-players').val(s.maxPlayers||10);
    $('#session-sport').val(s.sport||'');
    $view.addClass('hidden');$form.removeClass('hidden');
  } else {
    const mapsBtn=s.mapsUrl?`<a href="${s.mapsUrl}" target="_blank" class="btn btn-outline btn-sm session-maps-btn">📍 Maps</a>`:'';
    const bookBtn=s.bookingUrl?`<a href="${s.bookingUrl}" target="_blank" class="btn btn-outline btn-sm">🔗 Réservation</a>`:'';
    $view.html(`
      <div class="session-recap">
        <div class="session-recap-row session-recap-row--main">
          <div class="session-recap-info">
            <div class="session-recap-date">${formatDateDisplay(s.date)}</div>
            <div class="session-recap-venue">${s.venue||'Lieu non renseigné'}${s.sport?' · '+s.sport:''}</div>
          </div>
          <span class="session-recap-price">${s.price?s.price+'€':'—'}</span>
        </div>
        ${s.address?`<div class="session-recap-address">📍 ${s.address}</div>`:''}
        ${s.notes?`<div class="session-recap-notes">💬 ${s.notes}</div>`:''}
        <div class="session-recap-actions">${mapsBtn}${bookBtn}
          <button class="btn btn-ghost btn-sm" id="btn-edit-session">✏️ Modifier</button>
        </div>
      </div>`);
    $view.removeClass('hidden');$form.addClass('hidden');
  }
}

// ══════════════════════════════════════════════════
// 9. CLUBS — Autocomplétion dans formulaire session
// ══════════════════════════════════════════════════

let _clubSearchTimer=null;
function initClubSearch(){
  $(document).on('input','#session-club-search',function(){
    const q=$(this).val().trim();
    clearTimeout(_clubSearchTimer);
    if(q.length<2){$('#club-suggestions').addClass('hidden').empty();return;}
    _clubSearchTimer=setTimeout(async()=>{
      try{
        // Chercher d'abord dans le cache local
        const local=state.clubs.filter(c=>
          c.name.toLowerCase().includes(q.toLowerCase())||
          (c.sport||'').toLowerCase().includes(q.toLowerCase()));
        if(local.length) renderClubSuggestions(local);
        else {
          const res=await gasSearchClubs(q);
          renderClubSuggestions(res.clubs||[]);
        }
      }catch(e){console.warn('[clubs]',e);}
    },300);
  });
  $(document).on('click',function(e){
    if(!$(e.target).closest('#club-suggestions,#session-club-search').length)
      $('#club-suggestions').addClass('hidden');
  });
}

function renderClubSuggestions(clubs){
  const $s=$('#club-suggestions');
  if(!clubs.length){$s.addClass('hidden').empty();return;}
  $s.html(clubs.map(c=>`
    <div class="club-suggestion" data-club='${JSON.stringify(c).replace(/'/g,"&#39;")}'>
      <span class="club-name">${c.name}${c.sport?' <span class="club-sport-tag">'+c.sport+'</span>':''}</span>
      ${c.address?`<span class="club-addr">📍 ${c.address}</span>`:''}
    </div>`).join('')).removeClass('hidden');
}

$(document).on('click','.club-suggestion',function(){
  try{
    const c=JSON.parse($(this).attr('data-club').replace(/&#39;/g,"'"));
    $('#session-venue').val(c.name||'');
    $('#session-address').val(c.address||'');
    $('#session-maps-url').val(c.mapsUrl||'');
    $('#session-booking-url').val(c.bookingUrl||'');
    $('#session-club-search').val(c.name||'');
    $('#club-suggestions').addClass('hidden');
  }catch(e){console.warn('[club fill]',e);}
});

// ══════════════════════════════════════════════════
// 10. ACTIONS UTILISATEUR
// ══════════════════════════════════════════════════

async function addDispo(){/* géré par dispo.js */}

async function addSlot(slotData){
  if(state.isOffline)return showToast('Mode consultation','error');
  const slot=Object.assign({},slotData,{votes:0,_voted:false});
  const localId=await idbPut('slots',slot);
  slot.id=String(localId);
  state.slots.push(slot);
  renderSlots();
  showToast('Créneau ajouté ✓','success');
  gasWrite('addSlot',{date:slot.date,start:slot.start,end:slot.end,venue:slot.venue,price:slot.price})
    .then(r=>{if(r.id&&r.id!==slot.id){idbDelete('slots',localId);slot.id=r.id;idbPut('slots',slot);
              state.slots=state.slots.map(s=>String(s.id)===String(localId)?slot:s);}})
    .catch(e=>console.warn('[addSlot]',e));
}

async function voteSlot(id){
  if(state.isOffline)return showToast('Mode consultation','error');
  const slot=state.slots.find(s=>String(s.id)===String(id));if(!slot)return;
  slot._voted=!slot._voted;
  const delta=slot._voted?1:-1;
  slot.votes=(slot.votes||0)+delta;
  await idbPut('slots',slot);
  if(slot._voted&&slot.date)renderWeather(slot.date);
  renderSlots();
  gasWrite('voteSlot',{id,delta}).catch(e=>console.warn('[voteSlot]',e));
}

async function addPlayer(){
  if(state.isOffline)return showToast('Mode consultation','error');
  const name=$('#new-player-name').val().trim();if(!name)return;
  // FIX: relire maxPlayers depuis state.session à chaque appel
  const maxP=(state.session&&Number(state.session.maxPlayers))||10;
  const status=state.players.length>=maxP?'waitlist':'player';
  const player={name,status};
  const localId=await idbPut('players',player);
  player.id=String(localId);
  (status==='player'?state.players:state.waitlist).push(player);
  renderPlayers();
  $('#new-player-name').val('');
  showToast(status==='waitlist'?`${name} en liste d'attente`:`${name} inscrit ✓`,'success');
  gasWrite('addPlayer',{name,status}).catch(e=>console.warn('[addPlayer]',e));
}

async function removePlayer(id,status){
  await idbDelete('players',id);
  if(status==='player'){
    state.players=state.players.filter(p=>String(p.id)!==String(id));
    if(state.waitlist.length){
      const promoted=state.waitlist.shift();promoted.status='player';
      await idbPut('players',promoted);state.players.push(promoted);
      showToast(`${promoted.name} promu ✓`,'success');
      gasWrite('promotePlayer',{id:promoted.id}).catch(()=>{});
    }
  } else { state.waitlist=state.waitlist.filter(p=>String(p.id)!==String(id)); }
  renderPlayers();
  gasWrite('removePlayer',{id}).catch(e=>console.warn('[removePlayer]',e));
}

async function saveSession(){
  const session={
    id:'current',
    date:       $('#session-date').val(),
    venue:      $('#session-venue').val(),
    address:    $('#session-address').val(),
    mapsUrl:    $('#session-maps-url').val(),
    bookingUrl: $('#session-booking-url').val(),
    price:      $('#session-price').val(),
    notes:      $('#session-notes').val(),
    maxPlayers: Number($('#session-max-players').val())||10,
    sport:      $('#session-sport').val()||'',
  };
  await idbPut('session',session);
  state.session=session;
  showToast('Session enregistrée ✓','success');
  renderSession(false);
  renderPlayers();
  gasWrite('saveSession',{date:session.date,venue:session.venue,address:session.address,
    mapsUrl:session.mapsUrl,bookingUrl:session.bookingUrl,price:session.price,
    notes:session.notes,maxPlayers:session.maxPlayers,sport:session.sport})
    .catch(e=>console.warn('[saveSession]',e));
}

// ══════════════════════════════════════════════════
// 11. NAVIGATION VUES + ÉTAPES
// ══════════════════════════════════════════════════

function showView(viewName){
  state.currentView = viewName;
  $('.app-view').addClass('hidden');
  $(`#view-${viewName}`).removeClass('hidden');
  // Mettre à jour la bottom nav
  $('.bnav-btn').removeClass('active');
  $(`.bnav-btn[data-view="${viewName}"]`).addClass('active');
  // Charger les clubs au besoin
  if(viewName==='clubs') window.SportSyncClubs && window.SportSyncClubs.render();
  if(viewName==='dashboard') window.SportSyncHome && window.SportSyncHome.render();
}

function goToStep(n){
  // S'assurer d'être dans la vue session
  if(state.currentView!=='session') showView('session');
  $('.step-panel').removeClass('active');
  $(`#step-${n}`).addClass('active');
  $('.step-btn').each(function(){
    const s=Number($(this).data('step'));
    $(this).toggleClass('active',s===n).toggleClass('done',s<n);
  });
  state.currentStep=n;
  window.scrollTo({top:0,behavior:'smooth'});
}

// ══════════════════════════════════════════════════
// 12. URL PARAMS
// ══════════════════════════════════════════════════

function parseURLParams(){
  const params=new URLSearchParams(window.location.search);
  const type=params.get('type')||'once';
  const id=params.get('id')||generateUUID();
  const view=params.get('view')||'dashboard';
  state.sessionType=type;
  state.sessionId=type==='recurring'?'recurring':id;
  if(type==='recurring')
    $('#session-badge').text('🔁 Récurrent').css({borderColor:'var(--accent-dim)',color:'var(--accent)'});
  else
    $('#session-badge').text('🎯 '+id.slice(0,8).toUpperCase());
  if(type==='once'&&!params.get('id'))
    history.replaceState(null,'',window.location.pathname+'?type=once&id='+id);
  // Vue initiale depuis URL
  if(['dashboard','clubs','profile','session'].includes(view)) showView(view);
}

// ══════════════════════════════════════════════════
// 13. UTILITAIRES
// ══════════════════════════════════════════════════

function generateUUID(){
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{
    const r=Math.random()*16|0;return(c==='x'?r:(r&0x3|0x8)).toString(16);});
}

/**
 * FIX : formatDate gère correctement les strings ISO avec et sans heure.
 * 'YYYY-MM-DD'          → formatage court
 * 'YYYY-MM-DDTHH:MM'   → on extrait la partie date seulement
 */
function formatDate(dateStr){
  if(!dateStr) return '—';
  try{
    // Tronquer à la partie date (avant le T s'il y en a un)
    const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    // Ajouter T12:00 pour éviter le décalage UTC→local sur les dates sans heure
    return new Date(datePart+'T12:00:00').toLocaleDateString('fr-FR',
      {weekday:'short',day:'numeric',month:'short'});
  }catch(e){return dateStr;}
}

function formatDateDisplay(dateStr){
  if(!dateStr) return '—';
  try{
    const hasTime = dateStr.includes('T') && dateStr.length > 10;
    if(hasTime){
      const dt=new Date(dateStr);
      return dt.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'})
        +' à '+dt.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
    }
    return new Date(dateStr+'T12:00:00').toLocaleDateString('fr-FR',
      {weekday:'long',day:'numeric',month:'long',year:'numeric'});
  }catch(e){return dateStr;}
}

function setSyncStatus(msg,type){$('#sync-status').text(msg).attr('class','sync-status '+(type||''));}
function showToast(msg,type){
  const $t=$('#toast');
  $t.text(msg).attr('class','toast '+(type||'')).removeClass('hidden');
  clearTimeout($t.data('timer'));
  $t.data('timer',setTimeout(()=>$t.addClass('hidden'),3000));
}

function setOfflineMode(offline){
  state.isOffline=offline;
  $('#offline-banner').toggleClass('hidden',!offline);
  $('input,textarea').prop('disabled',offline);
  $('button').not('.btn-ghost,.btn-delete,.vote-btn,.plany-btn,.plany-nav-arrow,.plany-nav-cal,.plany-cell-close,.plany-bulk-btn,.cell-sheet-btn,.session-maps-btn,.bnav-btn,.fab-btn').prop('disabled',offline);
  if(offline)setSyncStatus('📵 Hors ligne','err');
}

// ══════════════════════════════════════════════════
// 14. BINDING ÉVÉNEMENTS
// ══════════════════════════════════════════════════

function bindEvents(){
  // Bottom nav
  $(document).on('click','.bnav-btn',function(){ showView($(this).data('view')); });
  // FAB "nouveau match"
  $(document).on('click','#fab-new-match',function(){ showView('session'); goToStep(1); });

  // Steps nav (dans la vue session)
  $(document).on('click','.step-btn',function(){ goToStep(Number($(this).data('step'))); });
  $(document).on('click','#btn-dispo-next',()=>goToStep(2));
  $(document).on('click','#btn-skip-dispo',()=>goToStep(2));
  $(document).on('click','#btn-slots-back',()=>goToStep(1));
  $(document).on('click','#btn-slots-next',()=>goToStep(3));
  $(document).on('click','#btn-final-back',()=>goToStep(2));

  // Smart Parser
  $(document).on('click','#btn-parse',function(){
    const raw=$('#smart-parser-input').val();
    const results=smartParse(raw);
    const $el=$('#parser-result');
    if(!results.length){$el.text('⚠️ Aucun créneau détecté.').removeClass('hidden');return;}
    $el.text(JSON.stringify(results,null,2)).removeClass('hidden');
    results.forEach(slot=>{if(slot.date||slot.start)addSlot(slot);});
    showToast(results.length+' créneau(x) détecté(s) ✓','success');
  });
  $(document).on('click','#btn-parse-clear',function(){
    $('#smart-parser-input').val('');$('#parser-result').addClass('hidden');});

  // Modal créneau manuel
  $(document).on('click','#btn-add-slot-manual',()=>$('#modal-slot').removeClass('hidden'));
  $(document).on('click','#btn-modal-cancel',   ()=>$('#modal-slot').addClass('hidden'));
  $(document).on('click','#modal-slot',function(e){if(e.target===this)$(this).addClass('hidden');});
  $(document).on('click','#btn-modal-confirm',function(){
    const price=$('#modal-slot-price').val();
    const slot={date:$('#modal-slot-date').val(),start:$('#modal-slot-start').val(),
                end:$('#modal-slot-end').val(),venue:$('#modal-slot-venue').val(),
                price:price?price+'€':''};
    if(!slot.date&&!slot.start){showToast('Date ou heure requise','error');return;}
    addSlot(slot);$('#modal-slot').addClass('hidden');
    $('#modal-slot-date,#modal-slot-start,#modal-slot-end,#modal-slot-venue,#modal-slot-price').val('');
  });

  // Session
  $(document).on('click','#btn-save-session',saveSession);
  $(document).on('click','#btn-edit-session',()=>renderSession(true));
  $(document).on('click','#btn-cancel-edit', ()=>renderSession(false));

  // Players
  $(document).on('click','#btn-add-player',addPlayer);
  $(document).on('keydown','#new-player-name',function(e){if(e.key==='Enter')addPlayer();});

  // Exports
  $(document).on('click','#btn-export-xlsx',exportXLSX);
  $(document).on('click','#btn-export-ics', exportICS);

  // Sync
  $(document).on('click','#btn-force-sync',syncFromSheets);

  // Réseau
  $(window).on('online', ()=>{setOfflineMode(false);syncFromSheets();});
  $(window).on('offline',()=>setOfflineMode(true));
}

// ══════════════════════════════════════════════════
// 15. BOOT
// ══════════════════════════════════════════════════

async function boot(){
  try{
    state.db=await initIDB();
    console.log('[Boot] IDB v4');
    parseURLParams();
    await loadStateFromIDB();

    // Synchro réseau + chargement clubs en parallèle
    if(!state.isOffline){
      syncFromSheets().catch(err=>{
        console.warn('[Boot] Synchro:',err.message||err);
        setSyncStatus('⚠️ Synchro échouée','err');
      });
      loadClubs().then(()=>{
        if(window.SportSyncClubs) window.SportSyncClubs.render();
      }).catch(()=>{});
    } else { setOfflineMode(true); }

    window._sportSyncDB=state.db;
    if(window.SportSyncDispo){
      window._dispoInitialized=true;
      await window.SportSyncDispo.init({db:state.db,sessionId:state.sessionId||'recurring'});
    }

    bindEvents();
    initClubSearch();

    // Afficher le dashboard par défaut si pas de vue dans l'URL
    if(state.currentView==='dashboard') showView('dashboard');

    console.log('[Boot] SportSync v4 ✓',{type:state.sessionType,id:state.sessionId});
  }catch(err){
    console.error('[Boot]',err);
    setSyncStatus('❌ Erreur au démarrage','err');
  }
}

$(document).ready(boot);
window.voteSlot     = voteSlot;
window.removePlayer = removePlayer;
window.showView     = showView;
