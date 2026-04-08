/**
 * ════════════════════════════════════════════════════════════════
 * SPORTSYNC — clubs.js  v4
 * ════════════════════════════════════════════════════════════════
 *
 * v4 :
 *   - CORS FIX : géocodage via GAS proxy (UrlFetchApp) au lieu de
 *     Nominatim directement (qui bloque les navigateurs en CORS)
 *   - Géocodage batch : une seule requête GAS pour tous les clubs
 *   - FAVORIS : icône ♥ sur chaque carte, onglet dédié "Mes favoris"
 *     persisté en localStorage
 */
;(function($){
  'use strict';

  // ══════════════════════════════════════════════════
  // 1. STATE
  // ══════════════════════════════════════════════════
  const CS = {
    clubs:          [],
    filteredClubs:  [],
    activeClub:     null,
    searchQuery:    '',
    sportFilter:    '',
    activeTab:      'all',      // 'all' | 'favorites'
    sortBy:         'name',     // 'name' | 'distance'
    userCoords:     null,
    userAddress:    '',
    geocodeTimer:   null,
    geocodingBatch: false,
  };

  const LS_NOTES_KEY   = 'sportsync_club_notes';
  const LS_ADDRESS_KEY = 'sportsync_user_address';
  const LS_FAVS_KEY    = 'sportsync_club_favorites';  // Set d'ids

  // ══════════════════════════════════════════════════
  // 2. SPORTS
  // ══════════════════════════════════════════════════
  const SPORTS_PRIORITY = ['Padel','Squash','Bad','Pickleball','Five','Tennis'];

  const SPORT_COLORS = {
    'padel':'#4ade80','tennis':'#f59e0b','squash':'#c084fc',
    'bad':'#34d399','badminton':'#34d399','pickleball':'#fb923c',
    'five':'#60a5fa','foot':'#60a5fa','football':'#60a5fa',
    'basket':'#f87171','handball':'#fb923c','natation':'#38bdf8',
    'cyclisme':'#fbbf24','default':'#9299b0',
  };
  const SPORT_EMOJI = {
    'padel':'🎾','tennis':'🎾','squash':'🏸','bad':'🏸','badminton':'🏸',
    'pickleball':'🏓','five':'⚽','foot':'⚽','football':'⚽',
    'basket':'🏀','handball':'🤾','natation':'🏊','cyclisme':'🚴','default':'🏅',
  };

  function sportColor(s){
    if(!s)return SPORT_COLORS.default;
    const k=s.toLowerCase();
    for(const n in SPORT_COLORS)if(k.includes(n))return SPORT_COLORS[n];
    return SPORT_COLORS.default;
  }
  function sportEmoji(s){
    if(!s)return SPORT_EMOJI.default;
    const k=s.toLowerCase();
    for(const n in SPORT_EMOJI)if(k.includes(n))return SPORT_EMOJI[n];
    return SPORT_EMOJI.default;
  }
  function parseSports(raw){
    if(!raw)return[];
    return raw.split(',').map(s=>s.trim()).filter(Boolean);
  }
  function getAllSportsFromClubs(clubs){
    const set=new Set();
    clubs.forEach(c=>parseSports(c.sport).forEach(s=>set.add(s)));
    const priority=SPORTS_PRIORITY.filter(s=>set.has(s));
    const others=[...set].filter(s=>!SPORTS_PRIORITY.includes(s)).sort();
    return [...priority,...others];
  }

  function photoUrl(club){
    if(club.photoUrl&&club.photoUrl.startsWith('http'))return club.photoUrl;
    const sports=parseSports(club.sport);
    const q=(sports[0]||'sport').toLowerCase().replace(/\s+/,',');
    return`https://source.unsplash.com/featured/400x200/?${encodeURIComponent(q)},court,sport`;
  }

  // ══════════════════════════════════════════════════
  // 3. FAVORIS
  // ══════════════════════════════════════════════════
  function getFavorites(){
    try{return new Set(JSON.parse(localStorage.getItem(LS_FAVS_KEY)||'[]'));}
    catch(e){return new Set();}
  }
  function saveFavorites(set){
    localStorage.setItem(LS_FAVS_KEY,JSON.stringify([...set]));
  }
  function isFavorite(clubId){return getFavorites().has(String(clubId));}

  function toggleFavorite(clubId){
    const favs=getFavorites();
    const id=String(clubId);
    if(favs.has(id))favs.delete(id);
    else            favs.add(id);
    saveFavorites(favs);
    return favs.has(id); // true = ajouté
  }

  // ══════════════════════════════════════════════════
  // 4. INSTALLATIONS
  // ══════════════════════════════════════════════════
  function parseInstallations(raw){
    if(!raw)return[];
    try{const d=typeof raw==='string'&&raw.trim().startsWith('[')?JSON.parse(raw):null;
      return Array.isArray(d)?d:[];}catch(e){return[];}
  }

  function renderInstallations(raw){
    const inst=parseInstallations(raw);if(!inst.length)return'';
    const rows=inst.map(i=>{
      const t=Number(i.total)||0,cv=Number(i.covered)||0,op=t-cv;
      const s=cv===t?`${t} terrain${t>1?'s':''} (${cv} couvert${cv>1?'s':''})`
               :cv===0?`${t} terrain${t>1?'s':''}`
               :`${t} terrain${t>1?'s':''} (${cv} couvert${cv>1?'s':''}, ${op} découvert${op>1?'s':''})`;
      return`<div class="install-row">
        <div class="install-sport">${sportEmoji(i.sport||'')} ${i.sport||'—'}</div>
        ${i.surface?`<div class="install-surface">${i.surface}</div>`:''}
        <div class="install-count">${s}</div>
      </div>`;
    }).join('');
    return`<div class="installations-block"><div class="installations-title">🏗 Installations</div>${rows}</div>`;
  }

  function installSummary(raw){
    const inst=parseInstallations(raw);if(!inst.length)return'';
    return inst.map(i=>`${sportEmoji(i.sport||'')}×${i.total||'?'}`).join('  ');
  }

  // ══════════════════════════════════════════════════
  // 5. NOTES LOCALES
  // ══════════════════════════════════════════════════
  function getLocalNotes(){try{return JSON.parse(localStorage.getItem(LS_NOTES_KEY)||'{}');}catch(e){return{};}}
  function saveLocalNote(clubId,text){
    const n=getLocalNotes();
    if(text.trim())n[clubId]=text;else delete n[clubId];
    localStorage.setItem(LS_NOTES_KEY,JSON.stringify(n));
  }
  function getLocalNote(clubId){return getLocalNotes()[clubId]||'';}

  // ══════════════════════════════════════════════════
  // 6. GÉOCODAGE — VIA GAS PROXY (CORS FIX)
  //
  //  AVANT (bloqué par CORS depuis le navigateur) :
  //    fetch('https://nominatim.openstreetmap.org/search?...')
  //
  //  APRÈS (GAS = serveur, pas de CORS) :
  //    gasRequest('GET', null, { action:'geocode', q: address })
  //    gasRequest('GET', null, { action:'geocodeBatch', addresses:'a1|a2|a3' })
  // ══════════════════════════════════════════════════

  /** Géocode l'adresse de l'utilisateur via le proxy GAS */
  async function geocodeUserAddress(address){
    if(!address||address.length<4)return null;
    try{
      const r=await gasRequest('GET',null,{action:'geocode',q:address});
      if(r&&r.lat&&r.lon)return{lat:Number(r.lat),lon:Number(r.lon)};
    }catch(e){console.warn('[geocode user]',e);}
    return null;
  }

  /**
   * Géocode tous les clubs en un seul appel GAS batch.
   * GAS appelle Nominatim séquentiellement (1 req/s) côté serveur.
   * Les clubs déjà géocodés (_lat/_lon en mémoire) sont ignorés.
   */
  async function geocodeAllClubs(){
    const needGeocode=CS.clubs.filter(c=>!c._lat||!c._lon);
    if(!needGeocode.length)return;

    // Construire la liste d'adresses (séparateur |)
    const addresses=needGeocode.map(c=>c.address||(c.name+', France'));
    CS.geocodingBatch=true;
    $('#clubs-distance-status').text(`Géolocalisation de ${needGeocode.length} clubs…`).addClass('loading');

    try{
      const r=await gasRequest('GET',null,{
        action:'geocodeBatch',
        addresses:addresses.join('|'),
      });
      if(r&&r.results){
        r.results.forEach(res=>{
          if(res.lat&&res.lon){
            needGeocode[res.idx]._lat=Number(res.lat);
            needGeocode[res.idx]._lon=Number(res.lon);
          }
        });
      }
    }catch(e){
      console.warn('[geocode batch]',e);
      $('#clubs-distance-status').text('Erreur de géolocalisation').addClass('error').removeClass('loading');
    }
    CS.geocodingBatch=false;
  }

  /** Distance Haversine (km) */
  function haversine(lat1,lon1,lat2,lon2){
    const R=6371,toRad=x=>x*Math.PI/180;
    const dLat=toRad(lat2-lat1),dLon=toRad(lon2-lon1);
    const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }
  function distanceLabel(km){
    return km<1?`${Math.round(km*1000)} m`:`${km.toFixed(1).replace('.',',')} km`;
  }

  /**
   * Lance le géocodage de l'adresse utilisateur et calcule les distances.
   * Appelé après debounce 800ms sur l'input.
   */
  async function updateDistances(){
    const addr=$('#clubs-distance-input').val().trim();
    if(!addr){
      CS.userCoords=null;CS.userAddress='';
      CS.clubs.forEach(c=>{c._dist=null;c._distLabel='';});
      localStorage.removeItem(LS_ADDRESS_KEY);
      $('#clubs-distance-status').text('');
      applyFilters();return;
    }
    CS.userAddress=addr;
    $('#clubs-distance-status').text('Géolocalisation de votre adresse…').addClass('loading').removeClass('error');

    // 1. Géocoder l'adresse utilisateur
    const userCoords=await geocodeUserAddress(addr);
    if(!userCoords){
      $('#clubs-distance-status').text('Adresse introuvable').removeClass('loading').addClass('error');
      return;
    }
    CS.userCoords=userCoords;
    localStorage.setItem(LS_ADDRESS_KEY,addr);
    $('#clubs-distance-status').text('Géolocalisation des clubs…');

    // 2. Géocoder les clubs non encore géocodés (batch)
    await geocodeAllClubs();

    // 3. Calculer les distances
    let geocoded=0;
    CS.clubs.forEach(c=>{
      if(c._lat&&c._lon){
        c._dist=haversine(userCoords.lat,userCoords.lon,c._lat,c._lon);
        c._distLabel=distanceLabel(c._dist);
        geocoded++;
      }else{c._dist=null;c._distLabel='';}
    });

    $('#clubs-distance-status').text(`${geocoded} clubs localisés ✓`).removeClass('loading').removeClass('error');

    // Basculer auto sur le tri par distance
    CS.sortBy='distance';
    applyFilters();
  }

  // ══════════════════════════════════════════════════
  // 7. CHARGEMENT & FILTRAGE
  // ══════════════════════════════════════════════════
  async function loadClubs(force){
    if(!force&&window.state&&window.state.clubs&&window.state.clubs.length){
      CS.clubs=window.state.clubs;_restoreDistances();applyFilters();return;
    }
    try{
      const r=await(typeof gasGetAllClubs==='function'?gasGetAllClubs():Promise.reject('no fn'));
      CS.clubs=r.clubs||[];
      if(window.state)window.state.clubs=CS.clubs;
    }catch(e){console.warn('[clubs]',e);CS.clubs=(window.state&&window.state.clubs)||[];}
    _restoreDistances();
    applyFilters();
  }

  function _restoreDistances(){
    const savedAddr=localStorage.getItem(LS_ADDRESS_KEY)||'';
    if(savedAddr){
      $('#clubs-distance-input').val(savedAddr);
      // Géocodage silencieux en arrière-plan
      setTimeout(updateDistances,600);
    }
  }

  function applyFilters(){
    const favs=getFavorites();
    let clubs=[...CS.clubs];

    // Onglet favoris
    if(CS.activeTab==='favorites')clubs=clubs.filter(c=>favs.has(String(c.id)));

    // Filtre texte
    const q=CS.searchQuery.toLowerCase();
    if(q)clubs=clubs.filter(c=>
      c.name.toLowerCase().includes(q)||
      (c.address||'').toLowerCase().includes(q)||
      parseSports(c.sport).some(s=>s.toLowerCase().includes(q)));

    // Filtre sport
    const sp=CS.sportFilter;
    if(sp)clubs=clubs.filter(c=>parseSports(c.sport).some(s=>s.toLowerCase()===sp.toLowerCase()));

    // Tri
    if(CS.sortBy==='distance'&&CS.userCoords){
      clubs.sort((a,b)=>(a._dist!=null?a._dist:Infinity)-(b._dist!=null?b._dist:Infinity));
    }else{
      clubs.sort((a,b)=>a.name.localeCompare(b.name,'fr'));
    }
    CS.filteredClubs=clubs;
    renderList();
  }

  // ══════════════════════════════════════════════════
  // 8. RENDU LISTE
  // ══════════════════════════════════════════════════
  function render(){loadClubs();}

  function renderList(){
    const $c=$('#clubs-list');if(!$c.length)return;
    const favs=getFavorites();
    const favCount=favs.size;
    const allSports=getAllSportsFromClubs(CS.clubs);

    // ── Onglets Tous / Favoris ──
    const tabs=`<div class="clubs-tabs">
      <button class="clubs-tab ${CS.activeTab==='all'?'active':''}" data-tab="all">
        Tous <span class="clubs-tab-count">${CS.clubs.length}</span>
      </button>
      <button class="clubs-tab ${CS.activeTab==='favorites'?'active':''}" data-tab="favorites">
        ♥ Favoris <span class="clubs-tab-count">${favCount}</span>
      </button>
    </div>`;

    // ── Filtres sport ──
    const sportTabs=`<div class="sport-tabs">
      <button class="sport-tab ${!CS.sportFilter?'active':''}" data-sport="">Tous</button>
      ${allSports.map(s=>`<button class="sport-tab ${CS.sportFilter.toLowerCase()===s.toLowerCase()?'active':''}" data-sport="${s}">${sportEmoji(s)} ${s}</button>`).join('')}
    </div>`;

    // ── Barre distance ──
    const distanceBar=`<div class="clubs-distance-bar">
      <div class="clubs-distance-input-wrap">
        <span class="clubs-distance-icon">📍</span>
        <input type="text" id="clubs-distance-input" class="clubs-distance-input"
          value="${CS.userAddress||localStorage.getItem(LS_ADDRESS_KEY)||''}"
          placeholder="Votre adresse pour trier par proximité…" autocomplete="street-address" />
        <button class="clubs-distance-clear ${CS.userCoords?'':'hidden'}" id="clubs-distance-clear" title="Effacer">✕</button>
      </div>
      <span class="clubs-distance-status" id="clubs-distance-status"></span>
    </div>`;

    // ── Boutons tri ──
    const sortRow=CS.userCoords?`<div class="clubs-sort-row">
      <button class="clubs-sort-btn ${CS.sortBy==='name'?'active':''}" data-sort="name">🔤 Nom</button>
      <button class="clubs-sort-btn ${CS.sortBy==='distance'?'active':''}" data-sort="distance">📍 Distance</button>
    </div>`:'';

    if(!CS.filteredClubs.length){
      $c.html(tabs+sportTabs+distanceBar+sortRow+`<div class="clubs-empty">
        <div class="clubs-empty-icon">${CS.activeTab==='favorites'?'♥':'🏟️'}</div>
        <p>${CS.activeTab==='favorites'?'Aucun favori enregistré.':CS.searchQuery||CS.sportFilter?'Aucun club trouvé.':'Aucun club enregistré.'}</p>
        ${CS.activeTab==='favorites'?'<p class="clubs-empty-sub">Cliquez sur ♥ sur une carte pour ajouter un club à vos favoris.</p>':''}
      </div>`);
      bindListEvents($c);return;
    }

    const cards=CS.filteredClubs.map(c=>{
      const sports=parseSports(c.sport);
      const img=photoUrl(c);
      const instSum=installSummary(c.installations);
      const isFav=favs.has(String(c.id));

      const sportPills=sports.map(s=>
        `<span class="club-sport-pill" style="background:${sportColor(s)}22;border-color:${sportColor(s)}44;color:${sportColor(s)}">${sportEmoji(s)} ${s}</span>`
      ).join('');

      return `<div class="club-card" data-club-id="${c.id}">
        <div class="club-card-photo" style="background-image:url('${img}')">
          <div class="club-card-sports-row">${sportPills}</div>
          ${c._distLabel?`<div class="club-card-dist-badge">📍 ${c._distLabel}</div>`:''}
          <button class="club-fav-btn ${isFav?'active':''}" data-club-id="${c.id}" title="${isFav?'Retirer des favoris':'Ajouter aux favoris'}">
            ${isFav?'♥':'♡'}
          </button>
        </div>
        <div class="club-card-body">
          <div class="club-card-name">${c.name} ${isFav?'<span class="club-fav-indicator" title="Favori">♥</span>':''}</div>
          ${c.address?`<div class="club-card-addr">📍 ${c.address}</div>`:''}
          <div class="club-card-badges">
            ${c.pricing?`<span class="club-badge">💶 ${c.pricing}</span>`:''}
            ${instSum?`<span class="club-badge club-badge--install">${instSum}</span>`:''}
            ${c._distLabel?`<span class="club-badge club-badge--dist">📍 ${c._distLabel}</span>`:''}
          </div>
        </div>
      </div>`;
    }).join('');

    $c.html(tabs+sportTabs+distanceBar+sortRow+`<div class="clubs-grid">${cards}</div>`);
    bindListEvents($c);
  }

  function bindListEvents($c){
    // Onglets
    $c.off('click','.clubs-tab').on('click','.clubs-tab',function(){
      CS.activeTab=$(this).data('tab');applyFilters();
    });
    // Filtres sport
    $c.off('click','.sport-tab').on('click','.sport-tab',function(){
      CS.sportFilter=$(this).data('sport');applyFilters();
    });
    // Tri
    $c.off('click','.clubs-sort-btn').on('click','.clubs-sort-btn',function(){
      CS.sortBy=$(this).data('sort');applyFilters();
    });
    // Favori (stopper la propagation pour ne pas ouvrir la fiche)
    $c.off('click','.club-fav-btn').on('click','.club-fav-btn',function(e){
      e.stopPropagation();
      const id=$(this).data('club-id');
      const added=toggleFavorite(id);
      const icon=added?'♥':'♡';
      const $btn=$(this);
      $btn.toggleClass('active',added).text(icon).attr('title',added?'Retirer des favoris':'Ajouter aux favoris');
      // Mettre à jour l'indicateur dans le nom
      const $card=$btn.closest('.club-card');
      const $name=$card.find('.club-card-name');
      $name.find('.club-fav-indicator').remove();
      if(added)$name.append('<span class="club-fav-indicator" title="Favori">♥</span>');
      // Si on est dans l'onglet favoris et qu'on retire, masquer la carte
      if(CS.activeTab==='favorites'&&!added){
        $card.addClass('club-card--removing');
        setTimeout(()=>applyFilters(),350);
      }
      typeof showToast==='function'&&showToast(added?'Ajouté aux favoris ♥':'Retiré des favoris','');
    });
    // Clic carte → fiche
    $c.off('click','.club-card').on('click','.club-card',function(){
      const id=String($(this).data('club-id'));
      const club=CS.clubs.find(c=>String(c.id)===id);
      if(club)openDetail(club);
    });
    // Distance input
    $c.find('#clubs-distance-input').off('input').on('input',function(){
      clearTimeout(CS.geocodeTimer);
      CS.geocodeTimer=setTimeout(updateDistances,800);
    });
    // Clear distance
    $c.find('#clubs-distance-clear').off('click').on('click',function(){
      $c.find('#clubs-distance-input').val('');
      CS.userCoords=null;CS.userAddress='';
      CS.clubs.forEach(c=>{c._dist=null;c._distLabel='';});
      localStorage.removeItem(LS_ADDRESS_KEY);
      $('#clubs-distance-status').text('');
      CS.sortBy='name';
      applyFilters();
    });
  }

  // ══════════════════════════════════════════════════
  // 9. FICHE DÉTAIL
  // ══════════════════════════════════════════════════
  function openDetail(club){
    CS.activeClub=club;
    const $overlay=$('#club-detail-overlay');
    const sports=parseSports(club.sport);
    const img=photoUrl(club);
    const localNote=getLocalNote(club.id);
    const installHTML=renderInstallations(club.installations);
    const isFav=isFavorite(club.id);

    const sportPills=sports.map(s=>
      `<span class="detail-sport-pill" style="background:${sportColor(s)}22;border-color:${sportColor(s)}44;color:${sportColor(s)}">${sportEmoji(s)} ${s}</span>`
    ).join('');

    $overlay.find('#club-detail-content').html(`
      <div class="club-detail-photo" style="background-image:url('${img}')">
        <div class="club-detail-top-bar">
          <button class="club-detail-close" id="btn-club-close">✕</button>
          <button class="club-detail-fav-btn ${isFav?'active':''}" id="btn-club-fav" data-club-id="${club.id}" title="${isFav?'Retirer des favoris':'Ajouter aux favoris'}">
            ${isFav?'♥':'♡'}
          </button>
        </div>
        <div class="club-detail-sports">${sportPills}</div>
        ${club._distLabel?`<div class="club-detail-dist">📍 ${club._distLabel}</div>`:''}
      </div>
      <div class="club-detail-body">
        <div class="club-detail-name-row">
          <h2 class="club-detail-name">${club.name}</h2>
          ${isFav?'<span class="club-fav-indicator club-fav-indicator--lg">♥</span>':''}
        </div>

        ${club.address?`<div class="club-detail-row">📍 <span>${club.address}</span></div>`:''}
        ${club._distLabel?`<div class="club-detail-row">🛣 <span>${club._distLabel} de votre adresse</span></div>`:''}
        ${club.phone?`<div class="club-detail-row">📞 <span><a href="tel:${club.phone}" style="color:var(--accent)">${club.phone}</a></span></div>`:''}
        ${club.hours?`<div class="club-detail-row">🕐 <div class="hours-grid">${formatHours(club.hours)}</div></div>`:''}
        ${club.pricing?`<div class="club-detail-row">💶 <span>${club.pricing}</span></div>`:''}
        ${club.maxPlayers?`<div class="club-detail-row">👥 <span>Max ${club.maxPlayers} joueurs</span></div>`:''}

        ${installHTML}

        ${club.notes?`<div class="club-detail-notes">${club.notes}</div>`:''}

        <div class="local-notes-section">
          <div class="local-notes-header">
            <span class="local-notes-title">📝 Mes notes personnelles</span>
            <span class="local-notes-hint">Sauvegardé sur cet appareil uniquement</span>
          </div>
          <textarea class="local-notes-textarea" id="local-notes-input"
            placeholder="Stationnement, contact, préférences…" rows="3">${localNote}</textarea>
        </div>

        <div class="club-detail-actions">
          ${club.mapsUrl?`<a href="${club.mapsUrl}" target="_blank" class="btn btn-outline btn-sm">📍 Google Maps</a>`:''}
          ${club.url?`<a href="${club.url}" target="_blank" class="btn btn-outline btn-sm">🌐 Site du club</a>`:''}
          ${club.bookingUrl?`<a href="${club.bookingUrl}" target="_blank" class="btn btn-outline btn-sm">🔗 Réserver</a>`:''}
          <button class="btn btn-primary" id="btn-club-organize">🏅 Organiser un match ici</button>
        </div>
      </div>`);

    $overlay.removeClass('hidden');

    // Favori depuis la fiche
    $overlay.find('#btn-club-fav').off('click').on('click',function(){
      const id=$(this).data('club-id');
      const added=toggleFavorite(id);
      $(this).toggleClass('active',added).text(added?'♥':'♡').attr('title',added?'Retirer des favoris':'Ajouter aux favoris');
      $overlay.find('.club-fav-indicator--lg').remove();
      if(added)$overlay.find('.club-detail-name-row').append('<span class="club-fav-indicator club-fav-indicator--lg">♥</span>');
      typeof showToast==='function'&&showToast(added?'Ajouté aux favoris ♥':'Retiré des favoris','');
      // Mettre à jour la carte dans la liste si visible
      const $card=$(`.club-card[data-club-id="${id}"]`);
      if($card.length){
        $card.find('.club-fav-btn').toggleClass('active',added).text(added?'♥':'♡');
        $card.find('.club-card-name .club-fav-indicator').remove();
        if(added)$card.find('.club-card-name').append('<span class="club-fav-indicator">♥</span>');
      }
    });

    // Auto-save notes
    let noteTimer=null;
    $overlay.find('#local-notes-input').off('input').on('input',function(){
      clearTimeout(noteTimer);
      const val=$(this).val();
      noteTimer=setTimeout(()=>{saveLocalNote(club.id,val);_showNoteSaved($overlay);},600);
    });
  }

  function _showNoteSaved($overlay){
    let $b=$overlay.find('.note-saved-badge');
    if(!$b.length){$b=$('<span class="note-saved-badge">✓ Sauvegardé</span>');$overlay.find('.local-notes-header').append($b);}
    $b.addClass('visible');setTimeout(()=>$b.removeClass('visible'),1800);
  }

  // ══════════════════════════════════════════════════
  // 10. UTILITAIRES
  // ══════════════════════════════════════════════════
  function formatHours(raw){
    if(!raw)return'';
    try{
      const h=typeof raw==='string'&&raw.trim().startsWith('{')?JSON.parse(raw):null;
      if(!h)return`<span>${raw}</span>`;
      const days=['lun','mar','mer','jeu','ven','sam','dim'];
      const fr=['Lun.','Mar.','Mer.','Jeu.','Ven.','Sam.','Dim.'];
      return days.map((d,i)=>{const v=h[d]||h[fr[i]]||h[fr[i].toLowerCase()]||'';
        return v?`<span class="hours-row"><span class="hours-day">${fr[i]}</span><span class="hours-val">${v}</span></span>`:'';
      }).filter(Boolean).join('');
    }catch(e){return`<span>${raw}</span>`;}
  }

  // ══════════════════════════════════════════════════
  // 11. ACTIONS
  // ══════════════════════════════════════════════════
  function openById(id){
    if(!CS.clubs.length){loadClubs().then(()=>{const c=CS.clubs.find(c=>String(c.id)===String(id));if(c)openDetail(c);});return;}
    const club=CS.clubs.find(c=>String(c.id)===String(id));
    if(club)openDetail(club);
    else typeof showToast==='function'&&showToast('Club introuvable','error');
  }

  function closeDetail(){$('#club-detail-overlay').addClass('hidden');CS.activeClub=null;}

  function bindEvents(){
    $(document).on('input','#clubs-search',function(){CS.searchQuery=$(this).val().trim();applyFilters();});
    $(document).on('click','#btn-club-close',closeDetail);
    $(document).on('click','#club-detail-overlay',function(e){if(e.target===this)closeDetail();});

    $(document).on('click','#btn-club-organize',function(){
      if(!CS.activeClub)return;
      const c=CS.activeClub;closeDetail();
      if(typeof showView==='function')showView('session');
      if(typeof goToStep==='function')goToStep(3);
      const sports=parseSports(c.sport);
      setTimeout(function(){
        $('#session-venue').val(c.name||'');
        $('#session-address').val(c.address||'');
        if(sports.length)$('#session-sport').val(sports[0]);
        if(c.mapsUrl)    $('#session-maps-url').val(c.mapsUrl);
        if(c.url)        $('#session-booking-url').val(c.url);
        if(c.maxPlayers) $('#session-max-players').val(c.maxPlayers);
        $('#session-club-id-hidden').val(c.id||'');
        if(typeof renderSession==='function')renderSession(true);
        typeof showToast==='function'&&showToast(`Lieu pré-rempli : ${c.name}`,'success');
      },300);
    });
  }

  function init(){bindEvents();loadClubs();}

  window.SportSyncClubs={init,render,loadClubs,openById};

  $(document).ready(function(){
    setTimeout(function(){if($('#view-clubs').length)init();},400);
  });

}(jQuery));
