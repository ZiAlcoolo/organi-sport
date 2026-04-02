/**
 * SPORTSYNC — clubs.js v2
 * Annuaire des clubs : liste + fiche détail + "Organiser ici"
 * Nouveautés v2 : openById(), champs url/phone/mapsUrl/maxPlayers/active/hours(JSON)
 */
;(function($){
  'use strict';

  const CS = {
    clubs:[], filteredClubs:[], activeClub:null, searchQuery:'', sportFilter:'',
  };

  const SPORT_COLORS = {
    'padel':'#4ade80','tennis':'#f59e0b','foot':'#60a5fa','football':'#60a5fa',
    'basket':'#f87171','volleyball':'#a78bfa','handball':'#fb923c','badminton':'#34d399',
    'squash':'#c084fc','natation':'#38bdf8','cyclisme':'#fbbf24','default':'#9299b0',
  };
  function sportColor(sport){
    if(!sport)return SPORT_COLORS.default;
    const s=sport.toLowerCase();
    for(const k in SPORT_COLORS)if(s.includes(k))return SPORT_COLORS[k];
    return SPORT_COLORS.default;
  }
  const SPORT_EMOJI={'padel':'🎾','tennis':'🎾','foot':'⚽','football':'⚽','basket':'🏀',
    'volley':'🏐','volleyball':'🏐','handball':'🤾','badminton':'🏸','squash':'🏸',
    'natation':'🏊','cyclisme':'🚴','default':'🏅'};
  function sportEmoji(sport){
    if(!sport)return SPORT_EMOJI.default;
    const s=sport.toLowerCase();
    for(const k in SPORT_EMOJI)if(s.includes(k))return SPORT_EMOJI[k];
    return SPORT_EMOJI.default;
  }
  function photoUrl(club){
    if(club.photoUrl&&club.photoUrl.startsWith('http'))return club.photoUrl;
    const sport=(club.sport||'sport').toLowerCase().replace(/\s+/,',');
    return `https://source.unsplash.com/featured/400x200/?${sport},court`;
  }

  /** Formate les horaires JSON en HTML lisible */
  function formatHours(hoursRaw){
    if(!hoursRaw)return'';
    // Essayer de parser comme JSON
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

  async function loadClubs(force){
    if(!force&&window.state&&window.state.clubs&&window.state.clubs.length){
      CS.clubs=window.state.clubs;applyFilters();return;
    }
    try{
      const r=await(typeof gasGetAllClubs==='function'?gasGetAllClubs():Promise.reject('no fn'));
      CS.clubs=r.clubs||[];
      if(window.state)window.state.clubs=CS.clubs;
    }catch(e){console.warn('[clubs]',e);CS.clubs=(window.state&&window.state.clubs)||[];}
    applyFilters();
  }

  function applyFilters(){
    let clubs=CS.clubs;
    const q=CS.searchQuery.toLowerCase(),sp=CS.sportFilter.toLowerCase();
    if(q)clubs=clubs.filter(c=>c.name.toLowerCase().includes(q)||(c.address||'').toLowerCase().includes(q)||(c.sport||'').toLowerCase().includes(q));
    if(sp)clubs=clubs.filter(c=>(c.sport||'').toLowerCase().includes(sp));
    CS.filteredClubs=clubs;
    renderList();
  }

  function render(){loadClubs();}

  function renderList(){
    const $c=$('#clubs-list');if(!$c.length)return;
    if(!CS.filteredClubs.length){
      $c.html(`<div class="clubs-empty"><div class="clubs-empty-icon">🏟️</div>
        <p>${CS.searchQuery||CS.sportFilter?'Aucun club trouvé.':'Aucun club enregistré.'}</p>
        ${!CS.searchQuery&&!CS.sportFilter?'<p class="clubs-empty-sub">Ajoutez des clubs dans l\'onglet "Clubs" de votre Google Sheet.</p>':''}</div>`);
      return;
    }
    const sports=[...new Set(CS.clubs.map(c=>c.sport||'').filter(Boolean))];
    const sportTabs=`<div class="sport-tabs">
      <button class="sport-tab ${!CS.sportFilter?'active':''}" data-sport="">Tous</button>
      ${sports.map(s=>`<button class="sport-tab ${CS.sportFilter===s.toLowerCase()?'active':''}" data-sport="${s.toLowerCase()}">${sportEmoji(s)} ${s}</button>`).join('')}
    </div>`;
    const cards=CS.filteredClubs.map(c=>{
      const color=sportColor(c.sport),img=photoUrl(c);
      return `<div class="club-card" data-club-id="${c.id}">
        <div class="club-card-photo" style="background-image:url('${img}')">
          <div class="club-card-sport-badge" style="background:${color}22;border-color:${color}44;color:${color}">${sportEmoji(c.sport)} ${c.sport||'Sport'}</div>
        </div>
        <div class="club-card-body">
          <div class="club-card-name">${c.name}</div>
          ${c.address?`<div class="club-card-addr">📍 ${c.address}</div>`:''}
          <div class="club-card-badges">
            ${c.pricing?`<span class="club-badge">💶 ${c.pricing}</span>`:''}
            ${c.courts?`<span class="club-badge">🏟 ${c.courts} terrains</span>`:''}
            ${c.maxPlayers?`<span class="club-badge">👥 max ${c.maxPlayers}</span>`:''}
          </div>
        </div>
      </div>`;
    }).join('');
    $c.html(sportTabs+`<div class="clubs-grid">${cards}</div>`);
    $c.off('click','.sport-tab').on('click','.sport-tab',function(){CS.sportFilter=$(this).data('sport');applyFilters();});
    $c.off('click','.club-card').on('click','.club-card',function(){
      const id=String($(this).data('club-id'));
      const club=CS.clubs.find(c=>String(c.id)===id);
      if(club)openDetail(club);
    });
  }

  function openDetail(club){
    CS.activeClub=club;
    const $overlay=$('#club-detail-overlay');
    const color=sportColor(club.sport),img=photoUrl(club);
    $overlay.find('#club-detail-content').html(`
      <div class="club-detail-photo" style="background-image:url('${img}')">
        <button class="club-detail-close" id="btn-club-close">✕</button>
        <div class="club-detail-sport" style="color:${color}">${sportEmoji(club.sport)} ${club.sport||'Sport'}</div>
      </div>
      <div class="club-detail-body">
        <h2 class="club-detail-name">${club.name}</h2>
        ${club.address?`<div class="club-detail-row">📍 <span>${club.address}</span></div>`:''}
        ${club.phone?`<div class="club-detail-row">📞 <span><a href="tel:${club.phone}" style="color:var(--accent)">${club.phone}</a></span></div>`:''}
        ${club.hours?`<div class="club-detail-row">🕐 <div class="hours-grid">${formatHours(club.hours)}</div></div>`:''}
        ${club.pricing?`<div class="club-detail-row">💶 <span>${club.pricing}</span></div>`:''}
        ${club.courts?`<div class="club-detail-row">🏟 <span>${club.courts} terrains</span></div>`:''}
        ${club.maxPlayers?`<div class="club-detail-row">👥 <span>Max ${club.maxPlayers} joueurs</span></div>`:''}
        ${club.notes?`<div class="club-detail-notes">${club.notes}</div>`:''}
        <div class="club-detail-actions">
          ${club.mapsUrl?`<a href="${club.mapsUrl}" target="_blank" class="btn btn-outline btn-sm">📍 Google Maps</a>`:''}
          ${club.url?`<a href="${club.url}" target="_blank" class="btn btn-outline btn-sm">🌐 Site du club</a>`:''}
          ${club.bookingUrl?`<a href="${club.bookingUrl}" target="_blank" class="btn btn-outline btn-sm">🔗 Réserver</a>`:''}
          <button class="btn btn-primary" id="btn-club-organize">🏅 Organiser un match ici</button>
        </div>
      </div>`);
    $overlay.removeClass('hidden');
  }

  /** Ouvre la fiche d'un club par son id (appelé depuis renderSession) */
  function openById(id){
    // Charger si pas encore fait
    if(!CS.clubs.length){
      loadClubs().then(()=>{
        const club=CS.clubs.find(c=>String(c.id)===String(id));
        if(club)openDetail(club);
      });
      return;
    }
    const club=CS.clubs.find(c=>String(c.id)===String(id));
    if(club)openDetail(club);
    else showToast&&showToast('Club introuvable','error');
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
      setTimeout(function(){
        $('#session-venue').val(c.name||'');
        $('#session-address').val(c.address||'');
        if(c.sport)       $('#session-sport').val(c.sport);
        if(c.mapsUrl)     $('#session-maps-url').val(c.mapsUrl);
        if(c.url)         $('#session-booking-url').val(c.url);
        if(c.maxPlayers)  $('#session-max-players').val(c.maxPlayers);
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
