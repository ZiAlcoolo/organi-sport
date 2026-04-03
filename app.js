/**
 * ════════════════════════════════════════════════════════════════
 * SPORTSYNC — app.js  v6
 * ════════════════════════════════════════════════════════════════
 * Changements v6 :
 *   - Votes uniques par joueur (JSON {"Mamat":1}) + état local en localStorage
 *   - Météo semaine complète + toggle heure par heure
 *   - applyProfile() ne toast QUE si appelée explicitement par l'utilisateur
 *   - FAB + bouton "Nouvelle session" → nouveau UUID à chaque clic
 *   - Bouton Partager fixed (au-dessus du FAB) visible seulement en vue session
 *   - Autocomplétion club remplit sport, mapsUrl, url club, maxPlayers
 *   - renderSession() affiche bouton "Voir le club" si session.clubId renseigné
 *   - saveSession() appelle linkUserToSession automatiquement
 *   - importRemoteData intègre slots.votes (JSON)
 */

// ══════════════════════════════════════════════════
// 1. CONFIGURATION
// ══════════════════════════════════════════════════
const CONFIG = {
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwGdzBCPtni4gTUIRtyfRUkHggmPE6k5AhlC4mj2KJuNCfG5PHTH5AtUrJ7IDrzFk5O/exec',
  METEO:   { DEFAULT_LAT:44.8378, DEFAULT_LON:-0.5792 },
  IDB:     { NAME:'sportsync', VERSION:5,
             STORES:['session','dispos','slots','players','clubs','sessions_index'] },
};

// ══════════════════════════════════════════════════
// 2. STATE
// ══════════════════════════════════════════════════
const state = {
  sessionType:'once', sessionId:null,
  currentView:'dashboard', currentStep:1,
  isOffline:!navigator.onLine, isSyncing:false, db:null,
  dispos:[], slots:[], players:[], waitlist:[],
  session:null, clubs:[], allSessions:[],
  lastSyncTs:0,
};

// Clé LS pour votes locaux : { slotId: { voterName: 1 } }
const LS_VOTES_KEY = 'sportsync_votes';
function getLocalVotes(){ try{ return JSON.parse(localStorage.getItem(LS_VOTES_KEY)||'{}'); }catch(e){return{};} }
function setLocalVotes(v){ try{ localStorage.setItem(LS_VOTES_KEY,JSON.stringify(v)); }catch(e){} }

// ══════════════════════════════════════════════════
// 3. INDEXEDDB
// ══════════════════════════════════════════════════
function initIDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(CONFIG.IDB.NAME,CONFIG.IDB.VERSION);
    req.onupgradeneeded=(e)=>{
      const db=e.target.result;
      CONFIG.IDB.STORES.forEach(name=>{
        if(!db.objectStoreNames.contains(name))
          db.createObjectStore(name,{keyPath:'id',autoIncrement:true});
      });
      if(!db.objectStoreNames.contains('meta'))
        db.createObjectStore('meta',{keyPath:'key'});
    };
    req.onsuccess=(e)=>resolve(e.target.result);
    req.onerror=(e)=>reject(e.target.error);
  });
}
function idbPut(store,data){return new Promise((res,rej)=>{const req=state.db.transaction(store,'readwrite').objectStore(store).put(data);req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error);});}
function idbGetAll(store){return new Promise((res,rej)=>{const req=state.db.transaction(store,'readonly').objectStore(store).getAll();req.onsuccess=()=>res(req.result||[]);req.onerror=()=>rej(req.error);});}
function idbDelete(store,id){return new Promise((res,rej)=>{const req=state.db.transaction(store,'readwrite').objectStore(store).delete(id);req.onsuccess=()=>res();req.onerror=()=>rej(req.error);});}
function idbClear(store){return new Promise((res,rej)=>{const req=state.db.transaction(store,'readwrite').objectStore(store).clear();req.onsuccess=()=>res();req.onerror=()=>rej(req.error);});}

// ══════════════════════════════════════════════════
// 4. GAS PROXY
// ══════════════════════════════════════════════════
function gasRequest(method,body,params){
  params=params||{};
  if(!CONFIG.GAS_URL||CONFIG.GAS_URL==='VOTRE_URL_APPS_SCRIPT_ICI')
    return $.Deferred().reject(new Error('GAS_URL non configurée')).promise();
  if(method==='GET')
    return $.ajax({url:CONFIG.GAS_URL+'?'+$.param(params),method:'GET',dataType:'json'});
  return $.ajax({url:CONFIG.GAS_URL,method:'POST',contentType:'text/plain',
                 data:JSON.stringify(body||{}),dataType:'json'});
}
function gasFetchAll(){
  const email=localStorage.getItem('sportsync_email')||'';
  return gasRequest('GET',null,{action:'getData',sessionId:state.sessionId||'recurring',email});
}
function gasWrite(action,pl){ return gasRequest('POST',Object.assign({action,sessionId:state.sessionId||'recurring'},pl||{})); }
function gasGetAllClubs()    { return gasRequest('GET',null,{action:'getAllClubs'}); }
function gasSearchClubs(q)   { return gasRequest('GET',null,{action:'searchClubs',q}); }
function gasGetMyMatches(em)   { return gasRequest('GET',null,{action:'getMyMatches',email:em}); }
function gasCreateRecurring(b) { return gasRequest('POST',Object.assign({action:'createRecurringSession'},b)); }

// ══════════════════════════════════════════════════
// 5. SYNCHRONISATION
// ══════════════════════════════════════════════════
async function syncFromSheets(){
  if(state.isOffline){setSyncStatus('📵 Hors ligne','err');return;}
  setSyncStatus('⏳ Synchronisation…');state.isSyncing=true;
  try{
    const remote=await gasFetchAll();
    const localMeta=await new Promise(res=>{
      const req=state.db.transaction('meta','readonly').objectStore('meta').get('lastSync');
      req.onsuccess=()=>res(req.result);req.onerror=()=>res(null);
    });
    const localTs=(localMeta&&localMeta.value)||0,remoteTs=Number(remote.timestamp)||0;
    if(remoteTs>localTs){
      await importRemoteData(remote);
      await idbPut('meta',{key:'lastSync',value:remoteTs});
      state.lastSyncTs=remoteTs;
    }else{state.lastSyncTs=Date.now();}
    // Syncer aussi les sessions de l'utilisateur depuis la réponse enrichie
    if(remote.userSessions){
      await idbClear('sessions_index');
      for(const s of remote.userSessions) await idbPut('sessions_index',{...s,id:s.sessionId});
      state.allSessions=await idbGetAll('sessions_index');
      if(window.SportSyncHome) window.SportSyncHome.render();
    }
    setSyncStatus('✅ Synchronisé','ok');updateSyncFooter();
  }catch(err){
    console.error('[Sync]',err);
    setSyncStatus(String(err.message||err).includes('GAS_URL')?'⚙️ GAS_URL non configurée':'⚠️ Synchro échouée','err');
    updateSyncFooter();
  }
  state.isSyncing=false;
}

async function importRemoteData(remote){
  for(const d of (remote.dispos||[])){
    const ck=(d.sessionId||'')+'::'+d.name+'::'+d.date+'::'+d.slot;
    const existing=(await idbGetAll('dispos')).find(e=>e._compositeKey===ck||e.id===ck);
    if(existing&&existing.updatedAt&&d.updatedAt&&existing.updatedAt>=d.updatedAt)continue;
    await idbPut('dispos',{id:ck,_compositeKey:ck,name:d.name||'',date:d.date||'',
      slot:d.slot||'',state:d.state||'',sessionId:d.sessionId||'',updatedAt:d.updatedAt||''});
  }
  await idbClear('slots');
  for(const s of (remote.slots||[]))
    // votes vient du GAS comme objet JSON
    await idbPut('slots',{id:s.id,date:s.date||'',start:s.start||'',end:s.end||'',
                          venue:s.venue||'',price:s.price||'',votes:s.votes||{}});
  await idbClear('players');
  for(const p of (remote.players||[]))
    await idbPut('players',{id:p.id,name:p.name||'',status:p.status||'player'});
  if(remote.session){
    const s=remote.session;
    await idbPut('session',{id:'current',date:s.date||'',venue:s.venue||'',
      address:s.address||'',mapsUrl:s.mapsUrl||'',bookingUrl:s.bookingUrl||'',
      price:s.price||'',notes:s.notes||'',maxPlayers:Number(s.maxPlayers)||10,
      sport:s.sport||'',clubId:s.clubId||''});
  }
  await loadStateFromIDB();
}

async function loadStateFromIDB(){
  state.dispos  =await idbGetAll('dispos');
  state.slots   =await idbGetAll('slots');
  const allP    =await idbGetAll('players');
  state.players  =allP.filter(p=>p.status==='player');
  state.waitlist =allP.filter(p=>p.status==='waitlist');
  const sessions =await idbGetAll('session');
  state.session  =sessions.find(s=>s.id==='current')||null;
  state.clubs    =await idbGetAll('clubs');
  state.allSessions=await idbGetAll('sessions_index');
  renderSlots();renderPlayers();renderSession();
  if(window.SportSyncDispo) window.SportSyncDispo.refresh(true);
  if(window.SportSyncHome)  window.SportSyncHome.render();
  if(window.SportSyncClubs) window.SportSyncClubs.render();
}

async function loadClubs(force){
  if(!force&&state.clubs.length)return state.clubs;
  try{
    const r=await gasGetAllClubs();const clubs=r.clubs||[];
    await idbClear('clubs');
    for(const c of clubs)await idbPut('clubs',{...c,id:c.id||c.name});
    state.clubs=clubs;return clubs;
  }catch(e){console.warn('[clubs]',e);state.clubs=await idbGetAll('clubs');return state.clubs;}
}

// ══════════════════════════════════════════════════
// 6. FOOTER SYNC
// ══════════════════════════════════════════════════
function updateSyncFooter(){
  const now=state.lastSyncTs?new Date(state.lastSyncTs):null;
  const timeStr=now?now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
  $('.sync-footer-time').text(timeStr);
  $('.sync-footer-status').attr('class','sync-footer-status '+(state.isSyncing?'syncing':now?'ok':''));
}

// ══════════════════════════════════════════════════
// 7. NAVIGATION
// ══════════════════════════════════════════════════
const NAV_KEY='sportsync_nav';
function saveNavState(view,step){try{sessionStorage.setItem(NAV_KEY,JSON.stringify({view:view||state.currentView,step:step||state.currentStep}));}catch(e){}}
function loadNavState(){try{const r=sessionStorage.getItem(NAV_KEY);return r?JSON.parse(r):null;}catch(e){return null;}}

function showView(viewName,updateHistory){
  state.currentView=viewName;
  $('.app-view').addClass('hidden');
  $(`#view-${viewName}`).removeClass('hidden');
  $('.bnav-btn').removeClass('active');
  $(`.bnav-btn[data-view="${viewName}"]`).addClass('active');
  $('#steps-nav').toggleClass('hidden',viewName!=='session');
  // Bouton Partager + FAB : visibles seulement en vue session
  $('#fab-share-btn').toggleClass('hidden', viewName!=='session');
  saveNavState(viewName,state.currentStep);
  if(viewName==='clubs')     window.SportSyncClubs&&window.SportSyncClubs.render();
  if(viewName==='dashboard') window.SportSyncHome&&window.SportSyncHome.render();
  if(updateHistory!==false){
    const url=new URL(window.location.href);
    url.searchParams.set('view',viewName);
    history.replaceState(null,'',url.toString());
  }
}

function goToStep(n){
  if(state.currentView!=='session')showView('session');
  $('.step-panel').removeClass('active');$(`#step-${n}`).addClass('active');
  $('.step-btn').each(function(){const s=Number($(this).data('step'));$(this).toggleClass('active',s===n).toggleClass('done',s<n);});
  state.currentStep=n;saveNavState(state.currentView,n);
  window.scrollTo({top:0,behavior:'smooth'});
}

// Crée une toute nouvelle session (nouveau UUID)
function newSession(){
  const newId=generateUUID();
  state.sessionId=newId;
  state.session=null;
  // Nettoyer IDB session courante
  idbClear('session').catch(()=>{});
  idbClear('slots').catch(()=>{});
  idbClear('players').catch(()=>{});
  state.slots=[];state.players=[];state.waitlist=[];
  // Mettre à jour l'URL
  const url=new URL(window.location.href);
  url.searchParams.set('type','once');
  url.searchParams.set('id',newId);
  url.searchParams.set('view','session');
  history.replaceState(null,'',url.toString());
  $('#session-badge').text('🎯 '+newId.slice(0,8).toUpperCase());
  renderSlots();renderPlayers();renderSession();
  showView('session');goToStep(1);
  if(window.SportSyncDispo)
    window.SportSyncDispo.init({db:state.db,sessionId:newId});
}

// ══════════════════════════════════════════════════
// 8. PROFIL — FIX : toast seulement si appelée manuellement
// ══════════════════════════════════════════════════
function applyProfile(name,email,showFeedback){
  if(name)  localStorage.setItem('sportsync_username',name);
  if(email) localStorage.setItem('sportsync_email',email.toLowerCase());
  const finalName  = name  || localStorage.getItem('sportsync_username')||'';
  const finalEmail = email || localStorage.getItem('sportsync_email')||'';
  $('#dispo-username').val(finalName).trigger('change');
  $('#profile-name').val(finalName);
  $('#profile-email').val(finalEmail);
  $('#home-email-input').val(finalEmail);
  if(finalEmail){
    $('#home-email-display').text('📧 '+finalEmail);
    $('#home-email-section').addClass('collapsed');
  }
  if(finalEmail&&window.SportSyncHome)window.SportSyncHome.loadMyMatches();
  // FIX : toast uniquement quand l'utilisateur a cliqué "Enregistrer"
  if(showFeedback)showToast('Profil mis à jour ✓','success');
}

// ══════════════════════════════════════════════════
// 9. URL PARAMS
// ══════════════════════════════════════════════════
function parseURLParams(){
  const params=new URLSearchParams(window.location.search);
  const type=params.get('type')||'once';
  const id=params.get('id')||generateUUID();
  const urlView=params.get('view')||null;
  state.sessionType=type;
  state.sessionId=type==='recurring'?'recurring':id;
  if(type==='recurring') $('#session-badge').text('🔁 Récurrent').css({borderColor:'var(--accent-dim)',color:'var(--accent)'});
  else                   $('#session-badge').text('🎯 '+id.slice(0,8).toUpperCase());
  if(type==='once'&&!params.get('id'))
    history.replaceState(null,'',window.location.pathname+'?type=once&id='+id);
  const navState=loadNavState();
  const targetView=urlView||(navState&&navState.view)||'dashboard';
  const targetStep=(navState&&navState.step)||1;
  if(['dashboard','clubs','profile','session'].includes(targetView)){
    showView(targetView,false);
    if(targetView==='session')setTimeout(()=>goToStep(targetStep),100);
  }
}

// ══════════════════════════════════════════════════
// 10. SMART PARSER
// ══════════════════════════════════════════════════
function smartParse(rawText){
  const results=[],text=rawText.trim();if(!text)return results;
  const DATE_FR=/(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)?\s*(\d{1,2})\s+(janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)(?:\s+(\d{4}))?/gi;
  const DATE_NUM=/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/g;
  const DATE_ISO=/(\d{4})-(\d{2})-(\d{2})/g;
  const TIME_RNG=/(\d{1,2})[h:](\d{0,2})\s*[-–à]\s*(\d{1,2})[h:](\d{0,2})/gi;
  const TIME_SGL=/(\d{1,2})[h:](\d{2})/gi;
  const PRICE=/(\d+[.,]?\d*)\s*(?:€|EUR|euros?)/gi;
  const VENUE=/(?:terrain|court|salle|gymnase|stade|complexe|halle|piste|piscine|dojo)\s+(?:n[°o]?\s*\d+|[a-zÀ-ÿ\s]+)?/gi;
  const MOIS={'janvier':'01','février':'02','fevrier':'02','mars':'03','avril':'04','mai':'05','juin':'06','juillet':'07','août':'08','aout':'08','septembre':'09','octobre':'10','novembre':'11','décembre':'12','decembre':'12'};
  for(const block of text.split(/\n{2,}|---+|===+/)){
    if(block.trim().length<5)continue;
    const s={date:'',start:'',end:'',venue:'',price:'',raw:block.trim()};
    const mDF=DATE_FR.exec(block);DATE_FR.lastIndex=0;
    if(mDF)s.date=`${mDF[3]||new Date().getFullYear()}-${MOIS[mDF[2].toLowerCase()]||'01'}-${mDF[1].padStart(2,'0')}`;
    if(!s.date){const m=DATE_ISO.exec(block);DATE_ISO.lastIndex=0;if(m)s.date=`${m[1]}-${m[2]}-${m[3]}`;}
    if(!s.date){const m=DATE_NUM.exec(block);DATE_NUM.lastIndex=0;if(m)s.date=`${m[3]?(m[3].length===2?'20'+m[3]:m[3]):new Date().getFullYear()}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;}
    const mTR=TIME_RNG.exec(block);TIME_RNG.lastIndex=0;
    if(mTR){s.start=`${mTR[1].padStart(2,'0')}:${(mTR[2]||'00').padStart(2,'0')}`;s.end=`${mTR[3].padStart(2,'0')}:${(mTR[4]||'00').padStart(2,'0')}`;}
    else{const ts=[...block.matchAll(TIME_SGL)];if(ts[0])s.start=`${ts[0][1].padStart(2,'0')}:${ts[0][2].padStart(2,'0')}`;if(ts[1])s.end=`${ts[1][1].padStart(2,'0')}:${ts[1][2].padStart(2,'0')}`;}
    const mP=PRICE.exec(block);PRICE.lastIndex=0;if(mP)s.price=mP[1].replace(',','.')+'€';
    const mV=VENUE.exec(block);VENUE.lastIndex=0;if(mV)s.venue=mV[0].trim();
    if(s.date||s.start)results.push(s);
  }
  return results;
}

// ══════════════════════════════════════════════════
// 11. MÉTÉO SEMAINE COMPLÈTE
// ══════════════════════════════════════════════════
let _weatherCache = {}; // date → données

async function fetchWeekWeather(startDate){
  const{DEFAULT_LAT:lat,DEFAULT_LON:lon}=CONFIG.METEO;
  const d=new Date(startDate+'T12:00');
  // Lundi de la semaine
  const day=d.getDay(),diff=(day===0?-6:1-day);
  const monday=new Date(d);monday.setDate(d.getDate()+diff);
  const friday=new Date(monday);friday.setDate(monday.getDate()+6);
  const fmt=dt=>`${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  const startStr=fmt(monday),endStr=fmt(friday);
  const cacheKey=startStr;
  if(_weatherCache[cacheKey]) return _weatherCache[cacheKey];

  const [daily,hourly]=await Promise.all([
    $.getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,weathercode&timezone=Europe%2FParis&start_date=${startStr}&end_date=${endStr}`),
    $.getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation,weathercode&timezone=Europe%2FParis&start_date=${startStr}&end_date=${endStr}`),
  ]);

  const result={
    dates:   daily.daily.time,
    tempMax: daily.daily.temperature_2m_max,
    tempMin: daily.daily.temperature_2m_min,
    rain:    daily.daily.precipitation_sum,
    wind:    daily.daily.windspeed_10m_max,
    codes:   daily.daily.weathercode,
    hourly:  {
      time:  hourly.hourly.time,
      temp:  hourly.hourly.temperature_2m,
      rain:  hourly.hourly.precipitation,
      codes: hourly.hourly.weathercode,
    },
    startStr,endStr,
  };
  _weatherCache[cacheKey]=result;
  return result;
}

function wmoIcon(code){
  if(code===0)return'☀️';if(code<=2)return'🌤';if(code<=3)return'☁️';
  if(code<=49)return'🌫';if(code<=59)return'🌧';if(code<=69)return'❄️';
  if(code<=79)return'🌨';if(code<=82)return'🌧';if(code<=86)return'❄️';
  return'⛈';
}

let _weatherHourlyOpen=null; // date string ouverte

async function renderWeather(date){
  const $c=$('#weather-content');if(!$c.length)return;
  if(!date){$c.html('<p class="empty-state">Sélectionnez un créneau.</p>');return;}
  $c.html('<p class="empty-state">Chargement météo semaine…</p>');
  try{
    const w=await fetchWeekWeather(date);
    // Tableau jour par jour
    const rows=w.dates.map((d,i)=>{
      const isTarget=d===date.split('T')[0];
      const dtObj=new Date(d+'T12:00');
      const dayLabel=dtObj.toLocaleDateString('fr-FR',{weekday:'short',day:'numeric',month:'short'});
      return `<div class="weather-day-row ${isTarget?'weather-day-row--active':''}" data-date="${d}">
        <div class="wd-label">${dayLabel}</div>
        <div class="wd-icon">${wmoIcon(w.codes[i])}</div>
        <div class="wd-temp"><span class="wd-max">${w.tempMax[i]??'--'}°</span><span class="wd-min">${w.tempMin[i]??'--'}°</span></div>
        <div class="wd-rain">${w.rain[i]??0}mm</div>
        <button class="wd-expand-btn" data-date="${d}" title="Voir heure par heure">⌄</button>
      </div>
      <div class="weather-hourly-panel hidden" id="whp-${d}"></div>`;
    }).join('');
    $c.html(`<div class="weather-week">${rows}</div>`);

    // Ouvrir automatiquement le jour sélectionné
    _showHourlyPanel(date.split('T')[0], w);

    $c.off('click','.wd-expand-btn').on('click','.wd-expand-btn',function(){
      const d=$(this).data('date');
      const $panel=$(`#whp-${d}`);
      if($panel.hasClass('hidden')){
        _showHourlyPanel(d,w);$panel.slideDown(200).removeClass('hidden');
      }else{$panel.slideUp(200).addClass('hidden');}
    });
    $c.off('click','.weather-day-row').on('click','.weather-day-row',function(){
      const d=$(this).data('date');
      $c.find('.wd-expand-btn[data-date="'+d+'"]').click();
    });
  }catch(e){$c.html('<p class="empty-state">Météo non disponible.</p>');}
}

function _showHourlyPanel(date,w){
  const $panel=$(`#whp-${date}`);if(!$panel.length)return;
  const dayStart=date+'T00:00',dayEnd=date+'T23:00';
  const hours=w.hourly.time.filter(t=>t>=dayStart&&t<=dayEnd);
  if(!hours.length){$panel.html('<p style="font-size:.75rem;color:var(--text-sub);padding:.35rem">Pas de données horaires.</p>');return;}
  const rows=hours.map(t=>{
    const idx=w.hourly.time.indexOf(t);
    const hour=t.split('T')[1]||'';
    return `<div class="hourly-row">
      <span class="hr-time">${hour}</span>
      <span class="hr-icon">${wmoIcon(w.hourly.codes[idx])}</span>
      <span class="hr-temp">${w.hourly.temp[idx]??'--'}°</span>
      <span class="hr-rain">${w.hourly.rain[idx]??0}mm</span>
    </div>`;
  }).join('');
  $panel.html(`<div class="hourly-grid">${rows}</div>`).removeClass('hidden');
}

// ══════════════════════════════════════════════════
// 12. EXPORTS
// ══════════════════════════════════════════════════
function exportXLSX(){
  const wb=XLSX.utils.book_new(),s=state.session||{};
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['#','Prénom','Statut'],...state.players.map((p,i)=>[i+1,p.name,'Inscrit']),...state.waitlist.map((p,i)=>[state.players.length+i+1,p.name,"Liste d'attente"])]),'Inscrits');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Champ','Valeur'],['Date',s.date||''],['Sport',s.sport||''],['Lieu',s.venue||''],['Adresse',s.address||''],['Maps',s.mapsUrl||''],['Réservation',s.bookingUrl||''],['Prix',s.price||''],['Notes',s.notes||''],['Max',s.maxPlayers||10],['Inscrits',state.players.length],['Attente',state.waitlist.length]]),'Session');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Date','Début','Fin','Lieu','Prix','Votes'],...state.slots.map(sl=>[sl.date,sl.start,sl.end,sl.venue,sl.price,Object.keys(sl.votes||{}).length])]),'Créneaux');
  XLSX.writeFile(wb,`sportsync-${Date.now()}.xlsx`);showToast('Export Excel ✓','success');
}
function exportICS(){
  const s=state.session;if(!s?.date){showToast("Renseignez d'abord la date",'error');return;}
  const dtStr=s.date.length>10?s.date:s.date+'T00:00';
  const dt=new Date(dtStr),dtEnd=new Date(dt.getTime()+3600000);
  const fmt=d=>d.toISOString().replace(/[-:]/g,'').split('.')[0]+'Z';
  const ics=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//SportSync//FR','CALSCALE:GREGORIAN','METHOD:PUBLISH','BEGIN:VEVENT',
    `UID:sportsync-${state.sessionId||'session'}@app`,`DTSTART:${fmt(dt)}`,`DTEND:${fmt(dtEnd)}`,
    `SUMMARY:Session ${s.sport||'Sport'} — ${s.venue||'SportSync'}`,
    `DESCRIPTION:Inscrits : ${state.players.map(p=>p.name).join(', ')}\\n${s.notes||''}`,
    `LOCATION:${s.address||s.venue||''}`, 'STATUS:CONFIRMED','END:VEVENT','END:VCALENDAR'].join('\r\n');
  const url=URL.createObjectURL(new Blob([ics],{type:'text/calendar;charset=utf-8'}));
  $('<a>').attr({href:url,download:'sportsync-session.ics'})[0].click();
  URL.revokeObjectURL(url);showToast('Fichier calendrier ✓','success');
}

// ══════════════════════════════════════════════════
// 13. RENDU — Slots avec votes uniques
// ══════════════════════════════════════════════════
function renderSlots(){
  const $c=$('#slots-container');if(!$c.length)return;
  if(!state.slots.length){$c.html('<p class="empty-state">Aucun créneau ajouté.</p>');return;}
  const myName=localStorage.getItem('sportsync_username')||'';
  const localVotes=getLocalVotes();
  $c.html(state.slots.map(slot=>{
    const votesObj=slot.votes||{};
    const voteCount=Object.keys(votesObj).filter(k=>k!=='__legacy__').length;
    const hasVoted=myName&&(!!votesObj[myName]||!!(localVotes[slot.id]));
    return `<div class="slot-item">
      <div class="slot-info">
        <div class="slot-date">${formatDate(slot.date)} · ${slot.start}${slot.end?' – '+slot.end:''}</div>
        <div class="slot-meta">${slot.venue||'Lieu non précisé'}</div>
      </div>
      <span class="slot-price">${slot.price||'—'}</span>
      <button class="vote-btn ${hasVoted?'voted':''}" data-id="${slot.id}" ${state.isOffline?'disabled':''}>
        👍 ${voteCount}
      </button>
    </div>`;
  }).join(''));
  $c.off('click','.vote-btn').on('click','.vote-btn',function(){voteSlot(String($(this).data('id')));});
}

function renderPlayers(){
  const $pl=$('#players-list'),$wl=$('#waitlist-container');if(!$pl.length)return;
  const maxP=(state.session&&state.session.maxPlayers)||10;
  $('#player-count').text(state.players.length);$('#player-max').text(maxP);$('#waitlist-count').text(state.waitlist.length);
  $pl.html(state.players.length?state.players.map((p,i)=>`<div class="player-item"><div><span class="player-name">${p.name}</span><span class="player-num"> #${i+1}</span></div><button class="btn-delete" data-id="${p.id}" data-status="player" ${state.isOffline?'disabled':''}>✕</button></div>`).join(''):'<p class="empty-state">Aucun inscrit.</p>');
  if($wl.length)$wl.html(state.waitlist.length?state.waitlist.map((p,i)=>`<div class="player-item"><div><span class="player-name">${p.name}</span><span class="player-num" style="color:var(--accent2)"> attente #${i+1}</span></div><button class="btn-delete" data-id="${p.id}" data-status="waitlist" ${state.isOffline?'disabled':''}>✕</button></div>`).join(''):"<p class='empty-state'>Liste d'attente vide.</p>");
  $('#players-list,#waitlist-container').off('click','.btn-delete').on('click','.btn-delete',function(){removePlayer(String($(this).data('id')),$(this).data('status'));});
}

function renderSession(editMode){
  const s=state.session;
  const $view=$('#session-view'),$form=$('#session-form');
  if(!$view.length||!$form.length)return;
  if(!s||!s.date){$view.addClass('hidden');$form.removeClass('hidden');return;}
  if(editMode){
    $('#session-date').val(s.date||'');$('#session-venue').val(s.venue||'');
    $('#session-address').val(s.address||'');$('#session-maps-url').val(s.mapsUrl||'');
    $('#session-booking-url').val(s.bookingUrl||'');$('#session-price').val(s.price||'');
    $('#session-notes').val(s.notes||'');$('#session-max-players').val(s.maxPlayers||10);
    $('#session-sport').val(s.sport||'');
    $view.addClass('hidden');$form.removeClass('hidden');
  }else{
    const mapsBtn=s.mapsUrl?`<a href="${s.mapsUrl}" target="_blank" class="btn btn-outline btn-sm session-maps-btn">📍 Maps</a>`:'';
    const bookBtn=s.bookingUrl?`<a href="${s.bookingUrl}" target="_blank" class="btn btn-outline btn-sm">🔗 Réservation</a>`:'';
    // Bouton "Voir le club" si session.clubId renseigné
    const clubBtn=s.clubId
      ? `<button class="btn btn-outline btn-sm" id="btn-goto-club" data-club-id="${s.clubId}">🏟 Voir le club</button>` : '';
    $view.html(`<div class="session-recap">
      <div class="session-recap-row session-recap-row--main">
        <div class="session-recap-info">
          <div class="session-recap-date">${formatDateDisplay(s.date)}</div>
          <div class="session-recap-venue">${s.venue||'Lieu non renseigné'}${s.sport?' · '+s.sport:''}</div>
        </div>
        <span class="session-recap-price">${s.price?s.price+'€':'—'}</span>
      </div>
      ${s.address?`<div class="session-recap-address">📍 ${s.address}</div>`:''}
      ${s.notes?`<div class="session-recap-notes">💬 ${s.notes}</div>`:''}
      <div class="session-recap-actions">${mapsBtn}${bookBtn}${clubBtn}
        <button class="btn btn-ghost btn-sm" id="btn-edit-session">✏️ Modifier</button>
      </div>
    </div>`);
    $view.removeClass('hidden');$form.addClass('hidden');
  }
}

// ══════════════════════════════════════════════════
// 14. CLUBS autocomplétion (avec sport, mapsUrl, url, maxPlayers)
// ══════════════════════════════════════════════════
let _clubSearchTimer=null;
function initClubSearch(){
  $(document).on('input','#session-club-search',function(){
    const q=$(this).val().trim();clearTimeout(_clubSearchTimer);
    if(q.length<2){$('#club-suggestions').addClass('hidden').empty();return;}
    _clubSearchTimer=setTimeout(async()=>{
      try{
        const local=state.clubs.filter(c=>c.name.toLowerCase().includes(q.toLowerCase())||(c.sport||'').toLowerCase().includes(q.toLowerCase()));
        if(local.length)renderClubSuggestions(local);
        else{const res=await gasSearchClubs(q);renderClubSuggestions(res.clubs||[]);}
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
  $s.html(clubs.map(c=>`<div class="club-suggestion" data-club='${JSON.stringify(c).replace(/'/g,"&#39;")}'>
    <span class="club-name">${c.name}${c.sport?` <span class="club-sport-tag">${c.sport}</span>`:''}</span>
    ${c.address?`<span class="club-addr">📍 ${c.address}</span>`:''}
  </div>`).join('')).removeClass('hidden');
}

$(document).on('click','.club-suggestion',function(){
  try{
    const c=JSON.parse($(this).attr('data-club').replace(/&#39;/g,"'"));
    $('#session-venue').val(c.name||'');
    $('#session-address').val(c.address||'');
    // Remplir sport, mapsUrl (champ dédié), url réservation, maxPlayers
    if(c.sport)       $('#session-sport').val(c.sport);
    if(c.mapsUrl)     $('#session-maps-url').val(c.mapsUrl);
    if(c.url)         $('#session-booking-url').val(c.url);
    if(c.maxPlayers)  $('#session-max-players').val(c.maxPlayers);
    // Stocker l'id du club pour le bouton "Voir le club"
    $('#session-club-id-hidden').val(c.id||'');
    $('#session-club-search').val(c.name||'');
    $('#club-suggestions').addClass('hidden');
  }catch(e){console.warn('[club fill]',e);}
});

// ══════════════════════════════════════════════════
// 15. ACTIONS UTILISATEUR
// ══════════════════════════════════════════════════
async function addDispo(){/* géré par dispo.js */}

async function addSlot(slotData){
  if(state.isOffline)return showToast('Mode consultation','error');
  const slot=Object.assign({},slotData,{votes:{},_localVote:false});
  const localId=await idbPut('slots',slot);slot.id=String(localId);
  state.slots.push(slot);renderSlots();showToast('Créneau ajouté ✓','success');
  gasWrite('addSlot',{date:slot.date,start:slot.start,end:slot.end,venue:slot.venue,price:slot.price})
    .then(r=>{if(r.id&&r.id!==slot.id){idbDelete('slots',localId);slot.id=r.id;idbPut('slots',slot);state.slots=state.slots.map(s=>String(s.id)===String(localId)?slot:s);}})
    .catch(e=>console.warn('[addSlot]',e));
}

async function voteSlot(id){
  if(state.isOffline)return showToast('Mode consultation','error');
  const myName=localStorage.getItem('sportsync_username')||'Anonyme';
  const slot=state.slots.find(s=>String(s.id)===String(id));if(!slot)return;
  const votesObj=slot.votes||{};
  const localVotes=getLocalVotes();
  const hasVoted=!!votesObj[myName]||!!localVotes[id];
  if(hasVoted){
    // Retirer le vote
    delete votesObj[myName];
    delete localVotes[id];
    showToast('Vote retiré','success');
  }else{
    // Ajouter le vote
    votesObj[myName]=1;
    localVotes[id]=1;
    showToast('Vote enregistré 👍','success');
  }
  slot.votes=votesObj;
  setLocalVotes(localVotes);
  await idbPut('slots',slot);
  if(!hasVoted&&slot.date)renderWeather(slot.date);
  renderSlots();
  const action=hasVoted?'remove':'add';
  gasWrite('voteSlot',{id,voterName:myName,action}).catch(e=>console.warn('[voteSlot]',e));
}

async function addPlayer(){
  if(state.isOffline)return showToast('Mode consultation','error');
  const name=$('#new-player-name').val().trim();if(!name)return;
  const maxP=(state.session&&Number(state.session.maxPlayers))||10;
  const status=state.players.length>=maxP?'waitlist':'player';
  const player={name,status};const localId=await idbPut('players',player);player.id=String(localId);
  (status==='player'?state.players:state.waitlist).push(player);renderPlayers();
  $('#new-player-name').val('');showToast(status==='waitlist'?`${name} en attente`:`${name} inscrit ✓`,'success');
  gasWrite('addPlayer',{name,status}).catch(e=>console.warn('[addPlayer]',e));
}

async function removePlayer(id,status){
  await idbDelete('players',id);
  if(status==='player'){
    state.players=state.players.filter(p=>String(p.id)!==String(id));
    if(state.waitlist.length){const promoted=state.waitlist.shift();promoted.status='player';
      await idbPut('players',promoted);state.players.push(promoted);
      showToast(`${promoted.name} promu ✓`,'success');
      gasWrite('promotePlayer',{id:promoted.id}).catch(()=>{});}
  }else{state.waitlist=state.waitlist.filter(p=>String(p.id)!==String(id));}
  renderPlayers();gasWrite('removePlayer',{id}).catch(e=>console.warn('[removePlayer]',e));
}

async function saveSession(){
  const clubId=$('#session-club-id-hidden').val()||'';
  const session={id:'current',date:$('#session-date').val(),venue:$('#session-venue').val(),
    address:$('#session-address').val(),mapsUrl:$('#session-maps-url').val(),
    bookingUrl:$('#session-booking-url').val(),price:$('#session-price').val(),
    notes:$('#session-notes').val(),maxPlayers:Number($('#session-max-players').val())||10,
    sport:$('#session-sport').val()||'',clubId};
  await idbPut('session',session);state.session=session;
  showToast('Session enregistrée ✓','success');renderSession(false);renderPlayers();
  const email=localStorage.getItem('sportsync_email')||'';
  gasWrite('saveSession',{...session,ownerEmail:email,clubId})
    .catch(e=>console.warn('[saveSession]',e));
  // Lier l'email à la session dans UserSessions
  if(email)gasWrite('linkUserToSession',{email,sessionId:state.sessionId}).catch(()=>{});
  // Créer/màj dans l'index Sessions
  gasWrite('createSession',{sessionId:state.sessionId,sport:session.sport,status:'open',
    venue:session.venue,date:session.date,maxPlayers:session.maxPlayers,ownerEmail:email})
    .catch(()=>{});
}

// ─── Sessions récurrentes ──────────────────────────────────────
/**
 * Crée une série de sessions récurrentes (N semaines consécutives).
 * @param {object} opts - { sport, venue, address, day (1=Lun..7=Dim), slot, weeks, maxPlayers }
 */
async function createRecurringSession(opts){
  if(state.isOffline)return showToast('Mode consultation','error');
  const email=localStorage.getItem('sportsync_email')||'';
  if(!email){showToast('Renseignez votre email dans Profil avant de créer une récurrence','error');showView('profile');return;}
  const parentId='rec_'+generateUUID().slice(0,8);
  showToast('Création en cours…');
  try{
    const r=await gasCreateRecurring({
      sessionId:        parentId,
      sport:            opts.sport||'',
      venue:            opts.venue||'',
      address:          opts.address||'',
      recurrenceDay:    Number(opts.day)||1,
      recurrenceSlot:   opts.slot||'evening',
      recurrenceWeeks:  Number(opts.weeks)||4,
      maxPlayers:       Number(opts.maxPlayers)||10,
      ownerEmail:       email,
    });
    if(r&&r.ok){
      showToast(`${r.sessions.length} séances créées ✓`,'success');
      $('#modal-recurring').addClass('hidden');
      await syncFromSheets();
      if(window.SportSyncHome)window.SportSyncHome.loadMyMatches();
    }else{
      showToast((r&&r.error)||'Erreur lors de la création','error');
    }
  }catch(e){
    console.error('[recurring]',e);
    showToast('Erreur réseau','error');
  }
}

// Partager la session
function shareSession(){
  const url=window.location.href;
  if(navigator.share){
    navigator.share({title:'Session SportSync',url}).catch(()=>{});
  }else{
    navigator.clipboard&&navigator.clipboard.writeText(url).then(()=>showToast('Lien copié ✓','success')).catch(()=>showToast('Copiez l\'URL manuellement',''));
  }
}

// ══════════════════════════════════════════════════
// 16. UTILITAIRES
// ══════════════════════════════════════════════════
function generateUUID(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:(r&0x3|0x8)).toString(16);});}

function formatDate(dateStr){
  if(!dateStr)return'—';
  try{const dp=dateStr.includes('T')?dateStr.split('T')[0]:dateStr;
    return new Date(dp+'T12:00:00').toLocaleDateString('fr-FR',{weekday:'short',day:'numeric',month:'short'});}
  catch(e){return dateStr;}
}

function formatDateDisplay(dateStr){
  if(!dateStr)return'—';
  try{const hasTime=dateStr.includes('T')&&dateStr.length>10;
    if(hasTime){const dt=new Date(dateStr);return dt.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'})+' à '+dt.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});}
    return new Date(dateStr+'T12:00:00').toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});}
  catch(e){return dateStr;}
}

function setSyncStatus(msg,type){$('#sync-status').text(msg).attr('class','sync-status '+(type||''));}
function showToast(msg,type){
  const $t=$('#toast');$t.text(msg).attr('class','toast '+(type||'')).removeClass('hidden');
  clearTimeout($t.data('timer'));$t.data('timer',setTimeout(()=>$t.addClass('hidden'),3000));
}
function setOfflineMode(offline){
  state.isOffline=offline;$('#offline-banner').toggleClass('hidden',!offline);
  $('input,textarea').prop('disabled',offline);
  $('button').not('.btn-ghost,.btn-delete,.vote-btn,.plany-btn,.plany-nav-arrow,.plany-nav-cal,.plany-cell-close,.plany-bulk-btn,.cell-sheet-btn,.session-maps-btn,.bnav-btn,.fab-btn,.sync-btn,.fab-share-btn').prop('disabled',offline);
  if(offline)setSyncStatus('📵 Hors ligne','err');
}

// ══════════════════════════════════════════════════
// 17. BINDING
// ══════════════════════════════════════════════════
function bindEvents(){
  // Bottom nav
  $(document).on('click','.bnav-btn',function(){showView($(this).data('view'));});

  // FAB + bouton "Nouvelle session" → nouveau UUID
  $(document).on('click','#fab-new-match',function(){newSession();});
  $(document).on('click','.btn-new-session',function(){newSession();});

  // Bouton Partager
  $(document).on('click','#fab-share-btn',shareSession);

  // Steps
  $(document).on('click','.step-btn',function(){goToStep(Number($(this).data('step')));});
  $(document).on('click','#btn-dispo-next',()=>goToStep(2));
  $(document).on('click','#btn-skip-dispo',()=>goToStep(2));
  $(document).on('click','#btn-slots-back',()=>goToStep(1));
  $(document).on('click','#btn-slots-next',()=>goToStep(3));
  $(document).on('click','#btn-final-back',()=>goToStep(2));

  // Smart Parser — toggle collapsible
  $(document).on('click','#smart-parser-toggle',function(){
    const $body=$('#smart-parser-body');
    const open=$body.is(':visible');
    $body.slideToggle(200);
    $(this).toggleClass('open',!open);
  });
  $(document).on('click','#btn-parse',function(){
    const raw=$('#smart-parser-input').val(),results=smartParse(raw),$el=$('#parser-result');
    if(!results.length){$el.text('⚠️ Aucun créneau détecté.').removeClass('hidden');return;}
    $el.text(JSON.stringify(results,null,2)).removeClass('hidden');
    results.forEach(slot=>{if(slot.date||slot.start)addSlot(slot);});
    showToast(results.length+' créneau(x) ✓','success');
  });
  $(document).on('click','#btn-parse-clear',function(){$('#smart-parser-input').val('');$('#parser-result').addClass('hidden');});

  // Modal créneau
  $(document).on('click','#btn-add-slot-manual',()=>$('#modal-slot').removeClass('hidden'));
  $(document).on('click','#btn-modal-cancel',   ()=>$('#modal-slot').addClass('hidden'));
  $(document).on('click','#modal-slot',function(e){if(e.target===this)$(this).addClass('hidden');});
  $(document).on('click','#btn-modal-confirm',function(){
    const price=$('#modal-slot-price').val();
    const slot={date:$('#modal-slot-date').val(),start:$('#modal-slot-start').val(),end:$('#modal-slot-end').val(),venue:$('#modal-slot-venue').val(),price:price?price+'€':''};
    if(!slot.date&&!slot.start){showToast('Date ou heure requise','error');return;}
    addSlot(slot);$('#modal-slot').addClass('hidden');
    $('#modal-slot-date,#modal-slot-start,#modal-slot-end,#modal-slot-venue,#modal-slot-price').val('');
  });

  // Session
  $(document).on('click','#btn-save-session',saveSession);
  $(document).on('click','#btn-edit-session',()=>renderSession(true));
  $(document).on('click','#btn-cancel-edit', ()=>renderSession(false));
  // Bouton "Voir le club" dans la fiche session
  $(document).on('click','#btn-goto-club',function(){
    const clubId=$(this).data('club-id');
    showView('clubs');
    if(window.SportSyncClubs)window.SportSyncClubs.openById(String(clubId));
  });
  $(document).on('click','#btn-add-player',addPlayer);
  $(document).on('keydown','#new-player-name',function(e){if(e.key==='Enter')addPlayer();});

  // Exports
  $(document).on('click','#btn-export-xlsx',exportXLSX);
  $(document).on('click','#btn-export-ics', exportICS);

  // Sync
  $(document).on('click','.sync-btn',async function(){
    await syncFromSheets();
    if(window.SportSyncDispo)window.SportSyncDispo.refresh(true);
  });

  // Profil — FIX : toast uniquement ici (showFeedback=true)
  $(document).on('click','#btn-save-profile',function(){
    const name=$('#profile-name').val().trim();
    const email=$('#profile-email').val().trim();
    applyProfile(name,email,true); // true = montrer le toast
  });

  // Email dashboard
  $(document).on('click','#home-email-submit',function(){
    const email=$('#home-email-input').val().trim();
    if(!email.includes('@')){showToast('Email invalide','error');return;}
    applyProfile('',email,true);
  });
  $(document).on('click','#home-email-change',function(){$('#home-email-section').removeClass('collapsed');});

  // Modale sessions récurrentes
  $(document).on('click','#btn-new-recurring',function(){
    _updateRecurringPreview(); // mettre à jour la preview dès l'ouverture
    $('#modal-recurring').removeClass('hidden');
  });
  $(document).on('click','#btn-recurring-cancel',function(){
    $('#modal-recurring').addClass('hidden');
  });
  $(document).on('click','#modal-recurring',function(e){
    if(e.target===this)$(this).addClass('hidden');
  });
  // Mise à jour live de la preview quand les champs changent
  $(document).on('change input','#rec-day,#rec-slot,#rec-weeks',function(){
    _updateRecurringPreview();
  });
  $(document).on('click','#btn-recurring-confirm',async function(){
    const btn=$(this);
    btn.prop('disabled',true).text('Création…');
    await createRecurringSession({
      sport:      $('#rec-sport').val().trim(),
      venue:      $('#rec-venue').val().trim(),
      address:    $('#rec-address').val().trim(),
      day:        $('#rec-day').val(),
      slot:       $('#rec-slot').val(),
      weeks:      $('#rec-weeks').val(),
      maxPlayers: $('#rec-max-players').val(),
    });
    btn.prop('disabled',false).text('✅ Créer la série');
  });

  // Réseau
  $(window).on('online', ()=>{setOfflineMode(false);syncFromSheets();});
  $(window).on('offline',()=>setOfflineMode(true));
}

// ══════════════════════════════════════════════════
// 18. BOOT
// ══════════════════════════════════════════════════
async function boot(){
  try{
    state.db=await initIDB();console.log('[Boot] IDB v5');
    parseURLParams();
    await loadStateFromIDB();
    applyProfile(null,null,false); // false = pas de toast au boot

    if(!state.isOffline){
      syncFromSheets().catch(err=>{console.warn('[Boot] Synchro:',err.message||err);setSyncStatus('⚠️ Synchro échouée','err');});
      loadClubs().then(()=>{if(window.SportSyncClubs)window.SportSyncClubs.render();}).catch(()=>{});
    }else{setOfflineMode(true);}

    window._sportSyncDB=state.db;
    if(window.SportSyncDispo){
      window._dispoInitialized=true;
      await window.SportSyncDispo.init({db:state.db,sessionId:state.sessionId||'recurring'});
    }

    bindEvents();
    initClubSearch();
    updateSyncFooter();
    console.log('[Boot] SportSync v6 ✓',{view:state.currentView,step:state.currentStep});
  }catch(err){
    console.error('[Boot]',err);setSyncStatus('❌ Erreur au démarrage','err');
  }
}

$(document).ready(boot);
window.voteSlot               = voteSlot;
window.removePlayer           = removePlayer;
window.showView               = showView;
window.goToStep               = goToStep;
window.newSession             = newSession;
window.updateSyncFooter       = updateSyncFooter;
window.createRecurringSession = createRecurringSession;

// ── Preview dynamique des occurrences récurrentes ──────────────
/**
 * Calcule et affiche les dates qui seront générées pour la série.
 * Appel : dès que l'utilisateur modifie le formulaire récurrent.
 */
function _updateRecurringPreview(){
  const $preview = $('#recurring-preview');
  if(!$preview.length) return;

  const dow   = Number($('#rec-day').val())   || 6;  // 1=Lun..7=Dim (ISO)
  const weeks = Number($('#rec-weeks').val()) || 8;
  const slot  = $('#rec-slot').val() || 'evening';

  const slotLabel = {morning:'Matin',afternoon:'Après-midi',evening:'Soir'}[slot]||slot;

  // Trouver la prochaine occurrence du jour demandé
  // getDay() : 0=dim,1=lun,...,6=sam — ISO : 1=lun...7=dim
  // Conversion ISO→getDay : getDay = dow % 7
  const targetGetDay = dow % 7; // ex: 6 (sam ISO) → getDay=6; 7 (dim ISO) → getDay=0
  const today = new Date(); today.setHours(0,0,0,0);
  let diff = (targetGetDay - today.getDay() + 7) % 7 || 7;
  const firstDate = new Date(today);
  firstDate.setDate(today.getDate() + diff);

  let html = `<div class="recurring-preview-title">📅 ${weeks} séance${weeks>1?'s':''} prévues</div>`;
  for(let w=0; w<Math.min(weeks,20); w++){
    const d = new Date(firstDate);
    d.setDate(firstDate.getDate() + w*7);
    const label = d.toLocaleDateString('fr-FR',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
    html += `<div class="recurring-occ">
      <span class="recurring-occ-num">#${w+1}</span>
      <span class="recurring-occ-date">${label}</span>
      <span class="recurring-occ-slot">${slotLabel}</span>
    </div>`;
  }
  if(weeks>20) html += `<div class="recurring-occ" style="font-style:italic;color:var(--muted)">+ ${weeks-20} séances supplémentaires…</div>`;
  $preview.html(html);
}
