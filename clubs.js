/**
 * ════════════════════════════════════════════════════════════════
 * SPORTSYNC — clubs.js  v3
 * Annuaire des clubs
 * ════════════════════════════════════════════════════════════════
 *
 * Nouveautés v3 :
 *   - Multi-sports : champ `sport` = "Padel, Squash, Bad" → tags séparés
 *   - Filtres par sport individuel (pills scrollables)
 *   - Colonne `installations` (JSON Ten'up) : affichage par sport + surface + couverts
 *   - Notes personnelles locales (localStorage, editables dans la fiche)
 *   - Calcul de distance via Nominatim (géocodage gratuit, aucune clé API)
 *     + tri automatique par distance
 */
;(function($){
  'use strict';

  // ══════════════════════════════════════════════════
  // 1. STATE
  // ══════════════════════════════════════════════════
  const CS = {
    clubs:           [],
    filteredClubs:   [],
    activeClub:      null,
    searchQuery:     '',
    sportFilter:     '',        // sport individuel sélectionné (lowercase)
    sortBy:          'name',    // 'name' | 'distance'
    userCoords:      null,      // { lat, lon } après géocodage
    userAddress:     '',
    geocodeTimer:    null,
    geocodeLoading:  false,
  };

  const LS_NOTES_KEY     = 'sportsync_club_notes';     // { clubId: "texte" }
  const LS_ADDRESS_KEY   = 'sportsync_user_address';

  // ══════════════════════════════════════════════════
  // 2. CONFIGURATION SPORTS
  //    Liste officielle : les sports affichés en priorité dans les filtres
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

  function sportColor(sport){
    if(!sport) return SPORT_COLORS.default;
    const s=sport.toLowerCase();
    for(const k in SPORT_COLORS)if(s.includes(k))return SPORT_COLORS[k];
    return SPORT_COLORS.default;
  }
  function sportEmoji(sport){
    if(!sport)return SPORT_EMOJI.default;
    const s=sport.toLowerCase();
    for(const k in SPORT_EMOJI)if(s.includes(k))return SPORT_EMOJI[k];
    return SPORT_EMOJI.default;
  }

  /**
   * Parse la chaîne multi-sports "Padel, Squash, Bad" → ['Padel','Squash','Bad']
   * Normalise et dédoublonne.
   */
  function parseSports(raw){
    if(!raw)return[];
    return raw.split(',').map(s=>s.trim()).filter(Boolean);
  }

  /** Retourne l'URL de photo placeholder selon le premier sport */
  function photoUrl(club){
    if(club.photoUrl&&club.photoUrl.startsWith('http'))return club.photoUrl;
    const sports=parseSports(club.sport);
    const sportQuery=(sports[0]||'sport').toLowerCase().replace(/\s+/,',');
    return `https://source.unsplash.com/featured/400x200/?${encodeURIComponent(sportQuery)},court,sport`;
  }

  // ══════════════════════════════════════════════════
  // 3. EXTRACTION DES SPORTS UNIQUES (pour les filtres)
  // ══════════════════════════════════════════════════
  function getAllSportsFromClubs(clubs){
    const set = new Set();
    clubs.forEach(c => parseSports(c.sport).forEach(s => set.add(s)));
    // Trier : sports prioritaires d'abord, puis le reste alphabétique
    const priority = SPORTS_PRIORITY.filter(s => set.has(s));
    const others   = [...set].filter(s => !SPORTS_PRIORITY.includes(s)).sort();
    return [...priority, ...others];
  }

  // ══════════════════════════════════════════════════
  // 4. INSTALLATIONS (style Ten'up)
  //
  // Format JSON dans la colonne `installations` :
  // [
  //   { "sport": "Padel", "surface": "Gazon synthétique", "total": 4, "covered": 4 },
  //   { "sport": "Squash", "surface": "Résine", "total": 3, "covered": 3 },
  //   { "sport": "Tennis", "surface": "Terre battue", "total": 6, "covered": 2 }
  // ]
  // ══════════════════════════════════════════════════
  function parseInstallations(raw){
    if(!raw)return[];
    try{
      const data=typeof raw==='string'&&raw.trim().startsWith('[')?JSON.parse(raw):null;
      return Array.isArray(data)?data:[];
    }catch(e){return[];}
  }

  function renderInstallations(raw){
    const installs=parseInstallations(raw);
    if(!installs.length)return'';
    const rows=installs.map(inst=>{
      const total   = Number(inst.total)||0;
      const covered = Number(inst.covered)||0;
      const open    = total-covered;
      const coverStr = covered===total
        ? `${total} terrain${total>1?'s':''} (${covered} couvert${covered>1?'s':''})`
        : covered===0
        ? `${total} terrain${total>1?'s':''}`
        : `${total} terrain${total>1?'s':''} (${covered} couvert${covered>1?'s':''}, ${open} découvert${open>1?'s':''})`;
      return `<div class="install-row">
        <div class="install-sport">${sportEmoji(inst.sport||'')} ${inst.sport||'—'}</div>
        ${inst.surface?`<div class="install-surface">${inst.surface}</div>`:''}
        <div class="install-count">${coverStr}</div>
      </div>`;
    }).join('');
    return `<div class="installations-block">
      <div class="installations-title">🏗 Installations</div>
      ${rows}
    </div>`;
  }

  /** Résumé compact pour la carte (ex: "🎾×4  🏸×3") */
  function installSummary(raw){
    const installs=parseInstallations(raw);
    if(!installs.length)return'';
    return installs.map(i=>`${sportEmoji(i.sport||'')}×${i.total||'?'}`).join('  ');
  }

  // ══════════════════════════════════════════════════
  // 5. NOTES LOCALES (localStorage)
  // ══════════════════════════════════════════════════
  function getLocalNotes(){
    try{return JSON.parse(localStorage.getItem(LS_NOTES_KEY)||'{}');}catch(e){return{};}
  }
  function saveLocalNote(clubId,text){
    const notes=getLocalNotes();
    if(text.trim())notes[clubId]=text;
    else delete notes[clubId];
    localStorage.setItem(LS_NOTES_KEY,JSON.stringify(notes));
  }
  function getLocalNote(clubId){
    return getLocalNotes()[clubId]||'';
  }

  // ══════════════════════════════════════════════════
  // 6. CALCUL DE DISTANCE (Nominatim + Haversine)
  // ══════════════════════════════════════════════════

  /**
   * Géocode une adresse via Nominatim (OpenStreetMap, gratuit, sans clé).
   * Retourne { lat, lon } ou null.
   * Respecte la politique d'usage : max 1 req/s, User-Agent identifié.
   */
  async function geocodeAddress(address){
    if(!address||address.length<5)return null;
    const url=`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`;
    try{
      const resp=await fetch(url,{
        headers:{'Accept-Language':'fr','User-Agent':'SportSync/1.0 (sport.app)'},
      });
      const data=await resp.json();
      if(data&&data.length>0)return{lat:Number(data[0].lat),lon:Number(data[0].lon)};
    }catch(e){console.warn('[geocode]',e);}
    return null;
  }

  /**
   * Géocode une adresse de club (depuis son champ address ou mapsUrl).
   * Utilise un cache en mémoire sur CS.clubs pour éviter les re-requêtes.
   */
  async function geocodeClub(club){
    if(club._lat&&club._lon)return{lat:club._lat,lon:club._lon};
    const addr=club.address||(club.name+', France');
    const coords=await geocodeAddress(addr);
    if(coords){club._lat=coords.lat;club._lon=coords.lon;}
    return coords;
  }

  /**
   * Distance Haversine en km entre deux coordonnées.
   */
  function haversine(lat1,lon1,lat2,lon2){
    const R=6371;
    const dLat=(lat2-lat1)*Math.PI/180;
    const dLon=(lon2-lon1)*Math.PI/180;
    const a=Math.sin(dLat/2)*Math.sin(dLat/2)+
            Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*
            Math.sin(dLon/2)*Math.sin(dLon/2);
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }

  function distanceLabel(km){
    if(km<1)return`${Math.round(km*1000)} m`;
    return`${km.toFixed(1).replace('.',',')} km`;
  }

  /**
   * Lance le géocodage de l'adresse utilisateur et met à jour les distances.
   * Appelé après un debounce de 800ms sur l'input adresse.
   */
  async function updateDistances(){
    const addr=$('#clubs-distance-input').val().trim();
    if(!addr){
      CS.userCoords=null;CS.userAddress='';
      CS.clubs.forEach(c=>{c._dist=null;c._distLabel='';});
      applyFilters();return;
    }
    CS.geocodeLoading=true;
    $('#clubs-distance-status').text('Géolocalisation…').addClass('loading');
    CS.userAddress=addr;
    const coords=await geocodeAddress(addr);
    if(!coords){
      $('#clubs-distance-status').text('Adresse introuvable').removeClass('loading').addClass('error');
      CS.geocodeLoading=false;return;
    }
    CS.userCoords=coords;
    localStorage.setItem(LS_ADDRESS_KEY,addr);
    // Calculer les distances de tous les clubs
    let geocoded=0;
    for(const club of CS.clubs){
      const cCoords=await geocodeClub(club);
      if(cCoords){
        club._dist=haversine(coords.lat,coords.lon,cCoords.lat,cCoords.lon);
        club._distLabel=distanceLabel(club._dist);
        geocoded++;
      }else{club._dist=null;club._distLabel='';}
    }
    CS.geocodeLoading=false;
    $('#clubs-distance-status').text(`${geocoded} clubs géolocalisés`).removeClass('loading').removeClass('error');
    if(CS.sortBy==='distance')applyFilters();
    else applyFilters();
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

  /** Restaure les distances déjà calculées si l'utilisateur a une adresse sauvegardée */
  function _restoreDistances(){
    const savedAddr=localStorage.getItem(LS_ADDRESS_KEY)||'';
    if(savedAddr){
      $('#clubs-distance-input').val(savedAddr);
      // Lancer le géocodage en arrière-plan sans bloquer l'affichage
      setTimeout(updateDistances,500);
    }
  }

  function applyFilters(){
    let clubs=[...CS.clubs];
    // Filtre texte
    const q=CS.searchQuery.toLowerCase();
    if(q)clubs=clubs.filter(c=>
      c.name.toLowerCase().includes(q)||
      (c.address||'').toLowerCase().includes(q)||
      parseSports(c.sport).some(s=>s.toLowerCase().includes(q)));
    // Filtre sport (multi-sport)
    const sp=CS.sportFilter;
    if(sp)clubs=clubs.filter(c=>
      parseSports(c.sport).some(s=>s.toLowerCase()===sp.toLowerCase()));
    // Tri
    if(CS.sortBy==='distance'&&CS.userCoords){
      clubs.sort((a,b)=>{
        const da=a._dist!=null?a._dist:Infinity;
        const db=b._dist!=null?b._dist:Infinity;
        return da-db;
      });
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

    // ── Toolbar (filtres + distance) ──────────────────
    const allSports=getAllSportsFromClubs(CS.clubs);
    const sportTabs=`<div class="sport-tabs" id="sport-tabs-container">
      <button class="sport-tab ${!CS.sportFilter?'active':''}" data-sport="">Tous</button>
      ${allSports.map(s=>`<button class="sport-tab ${CS.sportFilter.toLowerCase()===s.toLowerCase()?'active':''}" data-sport="${s}">${sportEmoji(s)} ${s}</button>`).join('')}
    </div>`;

    const sortBtn=CS.userCoords
      ? `<div class="clubs-sort-row">
          <button class="clubs-sort-btn ${CS.sortBy==='name'?'active':''}" data-sort="name">🔤 Nom</button>
          <button class="clubs-sort-btn ${CS.sortBy==='distance'?'active':''}" data-sort="distance">📍 Distance</button>
         </div>`
      : '';

    const distanceBar=`<div class="clubs-distance-bar">
      <div class="clubs-distance-input-wrap">
        <span class="clubs-distance-icon">📍</span>
        <input type="text" id="clubs-distance-input" class="clubs-distance-input"
          placeholder="Votre adresse pour calculer les distances…" autocomplete="street-address" />
        <button class="clubs-distance-clear ${CS.userCoords?'':'hidden'}" id="clubs-distance-clear">✕</button>
      </div>
      <span class="clubs-distance-status" id="clubs-distance-status"></span>
    </div>`;

    // ── Cartes ────────────────────────────────────────
    if(!CS.filteredClubs.length){
      $c.html(sportTabs+distanceBar+sortBtn+`<div class="clubs-empty"><div class="clubs-empty-icon">🏟️</div>
        <p>${CS.searchQuery||CS.sportFilter?'Aucun club trouvé pour cette recherche.':'Aucun club enregistré.'}</p>
        ${!CS.searchQuery&&!CS.sportFilter?'<p class="clubs-empty-sub">Ajoutez des clubs dans l\'onglet "Clubs" de votre Google Sheet.</p>':''}</div>`);
      bindFilterEvents($c);return;
    }

    const cards=CS.filteredClubs.map(c=>{
      const sports  = parseSports(c.sport);
      const color   = sportColor(sports[0]);
      const img     = photoUrl(c);
      const instSum = installSummary(c.installations);
      const distBadge = c._distLabel
        ? `<span class="club-badge club-badge--dist">📍 ${c._distLabel}</span>` : '';

      // Pills multi-sports pour la carte
      const sportPills = sports.map(s=>
        `<span class="club-sport-pill" style="background:${sportColor(s)}22;border-color:${sportColor(s)}44;color:${sportColor(s)}">${sportEmoji(s)} ${s}</span>`
      ).join('');

      return `<div class="club-card" data-club-id="${c.id}">
        <div class="club-card-photo" style="background-image:url('${img}')">
          <div class="club-card-sports-row">${sportPills}</div>
          ${c._distLabel?`<div class="club-card-dist-badge">📍 ${c._distLabel}</div>`:''}
        </div>
        <div class="club-card-body">
          <div class="club-card-name">${c.name}</div>
          ${c.address?`<div class="club-card-addr">📍 ${c.address}</div>`:''}
          <div class="club-card-badges">
            ${c.pricing?`<span class="club-badge">💶 ${c.pricing}</span>`:''}
            ${instSum?`<span class="club-badge club-badge--install">${instSum}</span>`:''}
            ${distBadge}
          </div>
        </div>
      </div>`;
    }).join('');

    $c.html(sportTabs+distanceBar+sortBtn+`<div class="clubs-grid">${cards}</div>`);
    bindFilterEvents($c);
  }

  function bindFilterEvents($c){
    // Tabs sport
    $c.off('click','.sport-tab').on('click','.sport-tab',function(){
      CS.sportFilter=$(this).data('sport');
      applyFilters();
    });
    // Tri
    $c.off('click','.clubs-sort-btn').on('click','.clubs-sort-btn',function(){
      CS.sortBy=$(this).data('sort');
      applyFilters();
    });
    // Clic carte
    $c.off('click','.club-card').on('click','.club-card',function(){
      const id=String($(this).data('club-id'));
      const club=CS.clubs.find(c=>String(c.id)===id);
      if(club)openDetail(club);
    });
    // Distance input — debounce 800ms
    const $distInput=$('#clubs-distance-input');
    $distInput.off('input').on('input',function(){
      clearTimeout(CS.geocodeTimer);
      CS.geocodeTimer=setTimeout(updateDistances,800);
    });
    // Clear distance
    $('#clubs-distance-clear').off('click').on('click',function(){
      $distInput.val('');CS.userCoords=null;CS.userAddress='';
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
    const color=sportColor(sports[0]);
    const img=photoUrl(club);
    const localNote=getLocalNote(club.id);
    const installHTML=renderInstallations(club.installations);

    // Pills sports pour la fiche
    const sportPills=sports.map(s=>
      `<span class="detail-sport-pill" style="background:${sportColor(s)}22;border-color:${sportColor(s)}44;color:${sportColor(s)}">${sportEmoji(s)} ${s}</span>`
    ).join('');

    $overlay.find('#club-detail-content').html(`
      <div class="club-detail-photo" style="background-image:url('${img}')">
        <button class="club-detail-close" id="btn-club-close">✕</button>
        <div class="club-detail-sports">${sportPills}</div>
        ${club._distLabel?`<div class="club-detail-dist">📍 ${club._distLabel}</div>`:''}
      </div>
      <div class="club-detail-body">
        <h2 class="club-detail-name">${club.name}</h2>

        ${club.address?`<div class="club-detail-row">📍 <span>${club.address}</span></div>`:''}
        ${club._distLabel?`<div class="club-detail-row">🛣 <span>${club._distLabel} de votre adresse</span></div>`:''}
        ${club.phone?`<div class="club-detail-row">📞 <span><a href="tel:${club.phone}" style="color:var(--accent)">${club.phone}</a></span></div>`:''}
        ${club.hours?`<div class="club-detail-row">🕐 <div class="hours-grid">${formatHours(club.hours)}</div></div>`:''}
        ${club.pricing?`<div class="club-detail-row">💶 <span>${club.pricing}</span></div>`:''}
        ${club.maxPlayers?`<div class="club-detail-row">👥 <span>Max ${club.maxPlayers} joueurs</span></div>`:''}

        ${installHTML}

        ${club.notes?`<div class="club-detail-notes">${club.notes}</div>`:''}

        <!-- Notes personnelles locales -->
        <div class="local-notes-section">
          <div class="local-notes-header">
            <span class="local-notes-title">📝 Mes notes personnelles</span>
            <span class="local-notes-hint">Sauvegardé sur cet appareil uniquement</span>
          </div>
          <textarea class="local-notes-textarea" id="local-notes-input"
            placeholder="Ajouter vos notes sur ce club (stationnement, contact, préférences…)"
            rows="3">${localNote}</textarea>
        </div>

        <div class="club-detail-actions">
          ${club.mapsUrl?`<a href="${club.mapsUrl}" target="_blank" class="btn btn-outline btn-sm">📍 Google Maps</a>`:''}
          ${club.url?`<a href="${club.url}" target="_blank" class="btn btn-outline btn-sm">🌐 Site du club</a>`:''}
          ${club.bookingUrl?`<a href="${club.bookingUrl}" target="_blank" class="btn btn-outline btn-sm">🔗 Réserver</a>`:''}
          <button class="btn btn-primary" id="btn-club-organize">🏅 Organiser un match ici</button>
        </div>
      </div>`);

    $overlay.removeClass('hidden');

    // Auto-save notes au keyup (debounce 600ms)
    let noteTimer=null;
    $overlay.find('#local-notes-input').on('input',function(){
      clearTimeout(noteTimer);
      const val=$(this).val();
      noteTimer=setTimeout(()=>{
        saveLocalNote(club.id,val);
        _showNoteSaved($overlay);
      },600);
    });
  }

  function _showNoteSaved($overlay){
    let $badge=$overlay.find('.note-saved-badge');
    if(!$badge.length){
      $badge=$('<span class="note-saved-badge">✓ Sauvegardé</span>');
      $overlay.find('.local-notes-header').append($badge);
    }
    $badge.addClass('visible');
    setTimeout(()=>$badge.removeClass('visible'),1800);
  }

  // ══════════════════════════════════════════════════
  // 10. UTILITAIRES formatage
  // ══════════════════════════════════════════════════
  function formatHours(hoursRaw){
    if(!hoursRaw)return'';
    try{
      const h=typeof hoursRaw==='string'&&hoursRaw.trim().startsWith('{')?JSON.parse(hoursRaw):null;
      if(!h)return`<span>${hoursRaw}</span>`;
      const days=['lun','mar','mer','jeu','ven','sam','dim'];
      const daysFr=['Lun.','Mar.','Mer.','Jeu.','Ven.','Sam.','Dim.'];
      return days.map((d,i)=>{
        const v=h[d]||h[daysFr[i]]||h[daysFr[i].toLowerCase()]||'';
        return v?`<span class="hours-row"><span class="hours-day">${daysFr[i]}</span><span class="hours-val">${v}</span></span>`:'';
      }).filter(Boolean).join('');
    }catch(e){return`<span>${hoursRaw}</span>`;}
  }

  // ══════════════════════════════════════════════════
  // 11. ACTIONS
  // ══════════════════════════════════════════════════
  function openById(id){
    if(!CS.clubs.length){
      loadClubs().then(()=>{
        const club=CS.clubs.find(c=>String(c.id)===String(id));
        if(club)openDetail(club);
      });
      return;
    }
    const club=CS.clubs.find(c=>String(c.id)===String(id));
    if(club)openDetail(club);
    else typeof showToast==='function'&&showToast('Club introuvable','error');
  }

  function closeDetail(){$('#club-detail-overlay').addClass('hidden');CS.activeClub=null;}

  function bindEvents(){
    // Recherche texte
    $(document).on('input','#clubs-search',function(){
      CS.searchQuery=$(this).val().trim();applyFilters();
    });
    // Fermer modale
    $(document).on('click','#btn-club-close',closeDetail);
    $(document).on('click','#club-detail-overlay',function(e){if(e.target===this)closeDetail();});

    // Organiser un match ici
    $(document).on('click','#btn-club-organize',function(){
      if(!CS.activeClub)return;
      const c=CS.activeClub;closeDetail();
      if(typeof showView==='function')showView('session');
      if(typeof goToStep==='function')goToStep(3);
      const sports=parseSports(c.sport);
      setTimeout(function(){
        $('#session-venue').val(c.name||'');
        $('#session-address').val(c.address||'');
        if(sports.length===1)$('#session-sport').val(sports[0]);
        else if(sports.length>1)$('#session-sport').val(sports[0]); // premier sport par défaut
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
