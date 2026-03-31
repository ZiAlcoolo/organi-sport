/**
 * ════════════════════════════════════════════════════════════════
 * SPORTSYNC — home.js
 * Dashboard : "Mes Matchs" + Vue Agenda + FAB création
 * ════════════════════════════════════════════════════════════════
 */
;(function($){
  'use strict';

  // ── State local ──────────────────────────────────
  const HS = {
    viewMode: 'cards',  // 'cards' | 'agenda'
    userEmail: '',
    matchSessions: [], // sessions chargées pour cet utilisateur
  };

  const SPORT_EMOJI = {
    'padel':'🎾','tennis':'🎾','foot':'⚽','football':'⚽','futsal':'⚽',
    'basket':'🏀','basketball':'🏀','volley':'🏐','handball':'🤾','rugby':'🏉',
    'badminton':'🏸','squash':'🏸','piscine':'🏊','natation':'🏊',
    'velo':'🚴','cyclisme':'🚴','run':'🏃','course':'🏃','default':'🏅',
  };

  function sportEmoji(sport) {
    if(!sport) return SPORT_EMOJI.default;
    const s = sport.toLowerCase();
    for(const key in SPORT_EMOJI) if(s.includes(key)) return SPORT_EMOJI[key];
    return SPORT_EMOJI.default;
  }

  function statusLabel(status, players, maxPlayers){
    const filled = Number(players)||0;
    const max    = Number(maxPlayers)||10;
    if(status==='closed') return { label:'Terminé', cls:'status--closed' };
    if(filled>=max)       return { label:'Complet · '+filled+'/'+max, cls:'status--full' };
    return { label:'Ouvert · '+filled+'/'+max, cls:'status--open' };
  }

  // ── Chargement des matchs ────────────────────────

  async function loadMyMatches(){
    const email = HS.userEmail;
    // 1. Depuis l'IDB local (sessions_index)
    if(window.state && window.state.allSessions && window.state.allSessions.length){
      HS.matchSessions = window.state.allSessions;
      render();
    }
    // 2. Si email → charger depuis GAS les sessions liées
    if(email && typeof gasGetMyMatches === 'function'){
      try{
        const r = await gasGetMyMatches(email);
        HS.matchSessions = r.sessions||[];
        render();
      }catch(e){ console.warn('[home] loadMyMatches:',e); }
    }
  }

  // ── Rendu ────────────────────────────────────────

  function render(){
    const $c = $('#home-matches-container');
    if(!$c.length) return;

    // En-tête avec toggle vue
    const sessions = HS.matchSessions;

    if(!sessions.length){
      $c.html(`
        <div class="home-empty">
          <div class="home-empty-icon">🏅</div>
          <p class="home-empty-title">Aucun match pour l'instant</p>
          <p class="home-empty-sub">Créez votre première session ou rejoignez-en une.</p>
        </div>`);
      return;
    }

    if(HS.viewMode==='agenda') renderAgenda(sessions, $c);
    else                        renderCards(sessions, $c);
  }

  function renderCards(sessions, $c){
    // Trier par date croissante, les passés à la fin
    const now = new Date();
    const sorted = [...sessions].sort((a,b)=>{
      const da = a.date ? new Date(a.date) : new Date('2099');
      const db = b.date ? new Date(b.date) : new Date('2099');
      return da-db;
    });

    $c.html(sorted.map(s=>{
      const dt      = s.date ? new Date(s.date) : null;
      const isPast  = dt && dt < now;
      const st      = statusLabel(s.status, s.players, s.maxPlayers);
      const emoji   = sportEmoji(s.sport);
      const dateStr = s.date ? formatSessionDate(s.date) : '—';

      return `
        <div class="match-card ${isPast?'match-card--past':''}" data-sid="${s.sessionId}">
          <div class="match-card-sport">${emoji}</div>
          <div class="match-card-body">
            <div class="match-card-title">${s.sport||'Session sport'}</div>
            <div class="match-card-venue">📍 ${s.venue||'Lieu non précisé'}</div>
            <div class="match-card-date">🗓 ${dateStr}</div>
          </div>
          <div class="match-card-right">
            <span class="match-status ${st.cls}">${st.label}</span>
            <button class="btn btn-outline btn-xs match-open-btn" data-sid="${s.sessionId}">Ouvrir</button>
          </div>
        </div>`;
    }).join(''));

    // Ouvrir une session au clic
    $c.off('click','.match-open-btn').on('click','.match-open-btn',function(){
      const sid = $(this).data('sid');
      openSession(sid);
    });
  }

  function renderAgenda(sessions, $c){
    // Grouper par semaine
    const groups = {};
    sessions.forEach(s=>{
      if(!s.date) return;
      const dt  = new Date(s.date.includes('T') ? s.date : s.date+'T12:00');
      const mon = getMondayStr(dt);
      if(!groups[mon]) groups[mon]=[];
      groups[mon].push(s);
    });

    const keys = Object.keys(groups).sort();
    if(!keys.length){ $c.html('<p class="empty-state">Aucun match planifié.</p>'); return; }

    $c.html(keys.map(week=>{
      const items = groups[week].map(s=>{
        const st    = statusLabel(s.status, s.players, s.maxPlayers);
        const emoji = sportEmoji(s.sport);
        const dt    = new Date(s.date.includes('T') ? s.date : s.date+'T12:00');
        return `
          <div class="agenda-item" data-sid="${s.sessionId}">
            <div class="agenda-day">
              <span class="agenda-day-name">${dt.toLocaleDateString('fr-FR',{weekday:'short'})}</span>
              <span class="agenda-day-num">${dt.getDate()}</span>
            </div>
            <div class="agenda-body">
              <div class="agenda-title">${emoji} ${s.sport||'Sport'} · ${s.venue||'—'}</div>
              <div class="agenda-time">${formatSessionTime(s.date)}</div>
            </div>
            <span class="match-status ${st.cls}">${st.label}</span>
          </div>`;
      }).join('');
      return `
        <div class="agenda-week">
          <div class="agenda-week-label">${weekLabel(week)}</div>
          ${items}
        </div>`;
    }).join(''));

    $c.off('click','.agenda-item').on('click','.agenda-item',function(){
      openSession($(this).data('sid'));
    });
  }

  function openSession(sessionId){
    // Naviguer vers la vue session et paramétrer l'URL
    const url = new URL(window.location.href);
    url.searchParams.set('type','once');
    url.searchParams.set('id',sessionId);
    url.searchParams.set('view','session');
    window.location.href = url.toString();
  }

  // ── Utilitaires date ─────────────────────────────

  function formatSessionDate(dateStr){
    if(!dateStr) return '—';
    try{
      const hasTime = dateStr.includes('T') && dateStr.length>10;
      const dt = new Date(hasTime ? dateStr : dateStr+'T12:00');
      const opts = {weekday:'short',day:'numeric',month:'short'};
      if(hasTime) return dt.toLocaleDateString('fr-FR',opts)+' à '+
        dt.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
      return dt.toLocaleDateString('fr-FR',opts);
    }catch(e){return dateStr;}
  }

  function formatSessionTime(dateStr){
    if(!dateStr||!dateStr.includes('T')) return '';
    try{
      const dt=new Date(dateStr);
      return dt.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
    }catch(e){return '';}
  }

  function getMondayStr(date){
    const d = new Date(date);
    const day = d.getDay();
    d.setDate(d.getDate()+(day===0?-6:1-day));
    return d.toISOString().slice(0,10);
  }

  function weekLabel(mondayStr){
    const m = new Date(mondayStr+'T12:00');
    const s = new Date(m); s.setDate(s.getDate()+6);
    const opts={day:'numeric',month:'short'};
    return 'Semaine du '+m.toLocaleDateString('fr-FR',opts)+' au '+s.toLocaleDateString('fr-FR',opts);
  }

  // ── Email utilisateur ────────────────────────────

  function initEmailForm(){
    const saved = localStorage.getItem('sportsync_email')||'';
    HS.userEmail = saved;
    $('#home-email-input').val(saved);
    if(saved) { $('#home-email-section').addClass('collapsed'); loadMyMatches(); }

    $(document).on('click','#home-email-submit',function(){
      const em = $('#home-email-input').val().trim().toLowerCase();
      if(!em.includes('@')){ showToast('Email invalide','error'); return; }
      HS.userEmail = em;
      localStorage.setItem('sportsync_email',em);
      $('#home-email-section').addClass('collapsed');
      loadMyMatches();
    });

    $(document).on('click','#home-email-change',function(){
      $('#home-email-section').removeClass('collapsed');
    });
  }

  // ── Toggle vue ───────────────────────────────────

  function initViewToggle(){
    $(document).on('click','#home-toggle-view',function(){
      HS.viewMode = HS.viewMode==='cards' ? 'agenda' : 'cards';
      $(this).text(HS.viewMode==='cards' ? '📅 Vue agenda' : '🃏 Vue cartes');
      render();
    });
  }

  // ── Init ─────────────────────────────────────────

  function init(){
    initEmailForm();
    initViewToggle();
    loadMyMatches();
  }

  window.SportSyncHome = { init, render, loadMyMatches };

  $(document).ready(function(){
    // Auto-init si la vue home est visible
    setTimeout(function(){
      if($('#view-dashboard').length) init();
    }, 400);
  });

}(jQuery));
