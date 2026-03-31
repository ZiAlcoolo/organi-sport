/**
 * ════════════════════════════════════════════════════════════════
 * SPORTSYNC — clubs.js
 * Annuaire des clubs : liste + fiche détail + "Organiser ici"
 * ════════════════════════════════════════════════════════════════
 */
;(function($){
  'use strict';

  const CS = {
    clubs:         [],
    filteredClubs: [],
    activeClub:    null,
    searchQuery:   '',
    sportFilter:   '',
  };

  const SPORT_COLORS = {
    'padel':   '#4ade80', 'tennis':  '#f59e0b', 'foot':    '#60a5fa',
    'football':'#60a5fa', 'basket':  '#f87171', 'volleyball':'#a78bfa',
    'handball':'#fb923c', 'badminton':'#34d399','squash':  '#c084fc',
    'natation':'#38bdf8', 'cyclisme':'#fbbf24', 'default': '#9299b0',
  };

  function sportColor(sport){
    if(!sport) return SPORT_COLORS.default;
    const s = sport.toLowerCase();
    for(const key in SPORT_COLORS) if(s.includes(key)) return SPORT_COLORS[key];
    return SPORT_COLORS.default;
  }

  const SPORT_EMOJI = {
    'padel':'🎾','tennis':'🎾','foot':'⚽','football':'⚽','basket':'🏀',
    'volley':'🏐','volleyball':'🏐','handball':'🤾','badminton':'🏸',
    'squash':'🏸','natation':'🏊','cyclisme':'🚴','default':'🏅',
  };

  function sportEmoji(sport){
    if(!sport) return SPORT_EMOJI.default;
    const s=sport.toLowerCase();
    for(const key in SPORT_EMOJI) if(s.includes(key)) return SPORT_EMOJI[key];
    return SPORT_EMOJI.default;
  }

  // Photo placeholder Unsplash selon le sport
  function photoUrl(club){
    if(club.photoUrl && club.photoUrl.startsWith('http')) return club.photoUrl;
    const sport = (club.sport||'sport').toLowerCase().replace(/\s+/,',');
    return `https://source.unsplash.com/featured/400x200/?${sport},court`;
  }

  // ── Chargement ───────────────────────────────────

  async function loadClubs(force){
    // Utiliser d'abord le cache state (chargé par app.js)
    if(!force && window.state && window.state.clubs && window.state.clubs.length){
      CS.clubs = window.state.clubs;
      applyFilters();
      return;
    }
    try{
      const r = await (typeof gasGetAllClubs==='function' ? gasGetAllClubs() : Promise.reject('no fn'));
      CS.clubs = r.clubs||[];
      if(window.state) window.state.clubs = CS.clubs;
    }catch(e){
      console.warn('[clubs]',e);
      CS.clubs = (window.state && window.state.clubs)||[];
    }
    applyFilters();
  }

  // ── Filtres ──────────────────────────────────────

  function applyFilters(){
    let clubs = CS.clubs;
    const q  = CS.searchQuery.toLowerCase();
    const sp = CS.sportFilter.toLowerCase();

    if(q)  clubs = clubs.filter(c=>
      c.name.toLowerCase().includes(q)||
      (c.address||'').toLowerCase().includes(q)||
      (c.sport||'').toLowerCase().includes(q));

    if(sp) clubs = clubs.filter(c=>(c.sport||'').toLowerCase().includes(sp));

    CS.filteredClubs = clubs;
    renderList();
  }

  // ── Rendu liste ──────────────────────────────────

  function render(){
    loadClubs();
  }

  function renderList(){
    const $c = $('#clubs-list');
    if(!$c.length) return;

    if(!CS.filteredClubs.length){
      $c.html(`
        <div class="clubs-empty">
          <div class="clubs-empty-icon">🏟️</div>
          <p>${CS.searchQuery||CS.sportFilter ? 'Aucun club trouvé pour cette recherche.' : 'Aucun club enregistré.'}</p>
          ${!CS.searchQuery && !CS.sportFilter ? '<p class="clubs-empty-sub">Ajoutez des clubs dans l\'onglet "Clubs" de votre Google Sheet.</p>' : ''}
        </div>`);
      return;
    }

    // Bâtir les filtres sport uniques
    const sports = [...new Set(CS.clubs.map(c=>c.sport||'').filter(Boolean))];
    const sportTabs = `<div class="sport-tabs">
      <button class="sport-tab ${!CS.sportFilter?'active':''}" data-sport="">Tous</button>
      ${sports.map(s=>`<button class="sport-tab ${CS.sportFilter===s.toLowerCase()?'active':''}" data-sport="${s.toLowerCase()}">${sportEmoji(s)} ${s}</button>`).join('')}
    </div>`;

    const cards = CS.filteredClubs.map(c=>{
      const color = sportColor(c.sport);
      const img   = photoUrl(c);
      return `
        <div class="club-card" data-club-id="${c.id}">
          <div class="club-card-photo" style="background-image:url('${img}')">
            <div class="club-card-sport-badge" style="background:${color}22;border-color:${color}44;color:${color}">
              ${sportEmoji(c.sport)} ${c.sport||'Sport'}
            </div>
          </div>
          <div class="club-card-body">
            <div class="club-card-name">${c.name}</div>
            ${c.address?`<div class="club-card-addr">📍 ${c.address}</div>`:''}
            <div class="club-card-badges">
              ${c.pricing?`<span class="club-badge">💶 ${c.pricing}</span>`:''}
              ${c.courts?`<span class="club-badge">🏟 ${c.courts} terrains</span>`:''}
            </div>
          </div>
        </div>`;
    }).join('');

    $c.html(sportTabs + `<div class="clubs-grid">${cards}</div>`);

    $c.off('click','.sport-tab').on('click','.sport-tab',function(){
      CS.sportFilter = $(this).data('sport');
      applyFilters();
    });
    $c.off('click','.club-card').on('click','.club-card',function(){
      const id = String($(this).data('club-id'));
      const club = CS.clubs.find(c=>String(c.id)===id);
      if(club) openDetail(club);
    });
  }

  // ── Fiche détail (modale) ────────────────────────

  function openDetail(club){
    CS.activeClub = club;
    const $overlay = $('#club-detail-overlay');
    const color = sportColor(club.sport);
    const img   = photoUrl(club);

    $overlay.find('#club-detail-content').html(`
      <div class="club-detail-photo" style="background-image:url('${img}')">
        <button class="club-detail-close" id="btn-club-close">✕</button>
        <div class="club-detail-sport" style="color:${color}">
          ${sportEmoji(club.sport)} ${club.sport||'Sport'}
        </div>
      </div>
      <div class="club-detail-body">
        <h2 class="club-detail-name">${club.name}</h2>
        ${club.address?`<div class="club-detail-row">📍 <span>${club.address}</span></div>`:''}
        ${club.hours?`<div class="club-detail-row">🕐 <span>${club.hours}</span></div>`:''}
        ${club.pricing?`<div class="club-detail-row">💶 <span>${club.pricing}</span></div>`:''}
        ${club.courts?`<div class="club-detail-row">🏟 <span>${club.courts} terrains disponibles</span></div>`:''}
        ${club.notes?`<div class="club-detail-notes">${club.notes}</div>`:''}

        <div class="club-detail-actions">
          ${club.mapsUrl?`<a href="${club.mapsUrl}" target="_blank" class="btn btn-outline btn-sm">📍 Google Maps</a>`:''}
          ${club.bookingUrl?`<a href="${club.bookingUrl}" target="_blank" class="btn btn-outline btn-sm">🔗 Réserver</a>`:''}
          <button class="btn btn-primary" id="btn-club-organize">🏅 Organiser un match ici</button>
        </div>
      </div>`);

    $overlay.removeClass('hidden');
  }

  function closeDetail(){
    $('#club-detail-overlay').addClass('hidden');
    CS.activeClub = null;
  }

  // ── Binding ──────────────────────────────────────

  function bindEvents(){
    // Recherche
    $(document).on('input','#clubs-search',function(){
      CS.searchQuery = $(this).val().trim();
      applyFilters();
    });

    // Fermer modale
    $(document).on('click','#btn-club-close',closeDetail);
    $(document).on('click','#club-detail-overlay',function(e){
      if(e.target===this) closeDetail();
    });

    // "Organiser un match ici" → pré-remplir le formulaire session
    $(document).on('click','#btn-club-organize',function(){
      if(!CS.activeClub) return;
      const c = CS.activeClub;
      closeDetail();
      // Naviguer vers la vue session
      if(typeof showView==='function') showView('session');
      if(typeof goToStep==='function') goToStep(3);
      // Attendre le render puis pré-remplir
      setTimeout(function(){
        $('#session-venue').val(c.name||'');
        $('#session-address').val(c.address||'');
        $('#session-maps-url').val(c.mapsUrl||'');
        $('#session-booking-url').val(c.bookingUrl||'');
        // Forcer le mode édition
        if(typeof renderSession==='function') renderSession(true);
        showToast(`Lieu pré-rempli : ${c.name}`,'success');
      }, 300);
    });
  }

  // ── Init ─────────────────────────────────────────

  function init(){
    bindEvents();
    loadClubs();
  }

  window.SportSyncClubs = { init, render, loadClubs };

  $(document).ready(function(){
    setTimeout(function(){
      if($('#view-clubs').length) init();
    }, 400);
  });

}(jQuery));
