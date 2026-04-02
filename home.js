/**
 * SPORTSYNC — home.js v2
 * Dashboard : "Mes Matchs" + Vue Agenda + avancement session
 */
;(function($){
  'use strict';

  const HS = { viewMode:'cards', userEmail:'', matchSessions:[] };

  const SPORT_EMOJI={'padel':'🎾','tennis':'🎾','foot':'⚽','football':'⚽','futsal':'⚽',
    'basket':'🏀','basketball':'🏀','volley':'🏐','handball':'🤾','rugby':'🏉',
    'badminton':'🏸','squash':'🏸','piscine':'🏊','natation':'🏊',
    'velo':'🚴','cyclisme':'🚴','run':'🏃','course':'🏃','default':'🏅'};
  function sportEmoji(sport){
    if(!sport)return SPORT_EMOJI.default;const s=sport.toLowerCase();
    for(const k in SPORT_EMOJI)if(s.includes(k))return SPORT_EMOJI[k];
    return SPORT_EMOJI.default;
  }

  function statusLabel(status,players,maxPlayers){
    const filled=Number(players)||0,max=Number(maxPlayers)||10;
    if(status==='closed')return{label:'Terminé',cls:'status--closed'};
    if(filled>=max)return{label:'Complet · '+filled+'/'+max,cls:'status--full'};
    return{label:'Ouvert · '+filled+'/'+max,cls:'status--open'};
  }

  /**
   * Calcule le statut d'avancement d'une session pour l'affichage dashboard.
   * Retourne un objet { step, label, icon, detail }
   */
  function sessionProgress(s){
    const date=s.date?new Date(s.date.includes('T')?s.date:s.date+'T12:00'):null;
    const now=new Date();
    const isPast=date&&date<now;
    const filled=Number(s.players)||0,max=Number(s.maxPlayers)||10;
    const hasDate=!!(s.date&&s.date.length>3);
    const hasVenue=!!(s.venue&&s.venue.length>1);
    const status=s.status||'open';

    if(isPast&&status!=='open'){
      return{step:5,icon:'✅',label:'Match terminé',cls:'step--done'};
    }
    if(hasDate&&hasVenue&&filled>=max){
      return{step:4,icon:'🎮',label:'Match programmé · '+filled+'/'+max+' joueurs',cls:'step--ready'};
    }
    if(hasDate&&hasVenue&&filled>0){
      const missing=max-filled;
      return{step:3,icon:'👥',label:`${filled}/${max} joueurs · ${missing} manquant${missing>1?'s':''}`,cls:'step--players'};
    }
    if(hasDate&&hasVenue){
      return{step:2,icon:'📍',label:'Lieu & date définis · inscription ouverte',cls:'step--venue'};
    }
    if(hasDate||hasVenue){
      return{step:1,icon:'🗳',label:'Recherche de créneaux',cls:'step--dispos'};
    }
    return{step:0,icon:'🆕',label:'Session en cours de création',cls:'step--new'};
  }

  async function loadMyMatches(){
    const email=HS.userEmail;
    if(window.state&&window.state.allSessions&&window.state.allSessions.length){
      HS.matchSessions=window.state.allSessions;render();
    }
    if(email&&typeof gasGetMyMatches==='function'){
      try{
        const r=await gasGetMyMatches(email);
        HS.matchSessions=r.sessions||[];
        if(window.state)window.state.allSessions=HS.matchSessions;
        render();
      }catch(e){console.warn('[home] loadMyMatches:',e);}
    }
  }

  function render(){
    const $c=$('#home-matches-container');if(!$c.length)return;
    const sessions=HS.matchSessions;
    if(!sessions.length){
      $c.html(`<div class="home-empty"><div class="home-empty-icon">🏅</div>
        <p class="home-empty-title">Aucun match pour l'instant</p>
        <p class="home-empty-sub">Créez votre première session ou rejoignez-en une.</p></div>`);
      return;
    }
    if(HS.viewMode==='agenda')renderAgenda(sessions,$c);
    else                      renderCards(sessions,$c);
  }

  function renderCards(sessions,$c){
    const now=new Date();
    const sorted=[...sessions].sort((a,b)=>{
      const da=a.date?new Date(a.date):new Date('2099');
      const db=b.date?new Date(b.date):new Date('2099');
      return da-db;
    });
    $c.html(sorted.map(s=>{
      const dt=s.date?new Date(s.date.includes('T')?s.date:s.date+'T12:00'):null;
      const isPast=dt&&dt<now;
      const st=statusLabel(s.status,s.players,s.maxPlayers);
      const emoji=sportEmoji(s.sport);
      const dateStr=s.date?formatSessionDate(s.date):'—';
      const prog=sessionProgress(s);
      return `<div class="match-card ${isPast?'match-card--past':''}" data-sid="${s.sessionId}">
        <div class="match-card-sport">${emoji}</div>
        <div class="match-card-body">
          <div class="match-card-title">${s.sport||'Session sport'}</div>
          <div class="match-card-venue">📍 ${s.venue||'Lieu non précisé'}</div>
          <div class="match-card-date">🗓 ${dateStr}</div>
          <div class="session-progress">
            <span class="session-step-badge session-step-badge--active">${prog.icon} ${prog.label}</span>
          </div>
        </div>
        <div class="match-card-right">
          <span class="match-status ${st.cls}">${st.label}</span>
          <button class="btn btn-outline btn-xs match-open-btn" data-sid="${s.sessionId}">Ouvrir</button>
        </div>
      </div>`;
    }).join(''));
    $c.off('click','.match-open-btn').on('click','.match-open-btn',function(){openSession($(this).data('sid'));});
  }

  function renderAgenda(sessions,$c){
    const groups={};
    sessions.forEach(s=>{
      if(!s.date)return;
      const dt=new Date(s.date.includes('T')?s.date:s.date+'T12:00');
      const mon=getMondayStr(dt);
      if(!groups[mon])groups[mon]=[];
      groups[mon].push(s);
    });
    const keys=Object.keys(groups).sort();
    if(!keys.length){$c.html('<p class="empty-state">Aucun match planifié.</p>');return;}
    $c.html(keys.map(week=>{
      const items=groups[week].map(s=>{
        const st=statusLabel(s.status,s.players,s.maxPlayers);
        const emoji=sportEmoji(s.sport);
        const dt=new Date(s.date.includes('T')?s.date:s.date+'T12:00');
        const prog=sessionProgress(s);
        return `<div class="agenda-item" data-sid="${s.sessionId}">
          <div class="agenda-day">
            <span class="agenda-day-name">${dt.toLocaleDateString('fr-FR',{weekday:'short'})}</span>
            <span class="agenda-day-num">${dt.getDate()}</span>
          </div>
          <div class="agenda-body">
            <div class="agenda-title">${emoji} ${s.sport||'Sport'} · ${s.venue||'—'}</div>
            <div class="agenda-time">${formatSessionTime(s.date)}</div>
            <div class="session-progress"><span class="session-step-badge session-step-badge--active">${prog.icon} ${prog.label}</span></div>
          </div>
          <span class="match-status ${st.cls}">${st.label}</span>
        </div>`;
      }).join('');
      return `<div class="agenda-week"><div class="agenda-week-label">${weekLabel(week)}</div>${items}</div>`;
    }).join(''));
    $c.off('click','.agenda-item').on('click','.agenda-item',function(){openSession($(this).data('sid'));});
  }

  function openSession(sessionId){
    const url=new URL(window.location.href);
    url.searchParams.set('type','once');
    url.searchParams.set('id',sessionId);
    url.searchParams.set('view','session');
    window.location.href=url.toString();
  }

  function formatSessionDate(dateStr){
    if(!dateStr)return'—';
    try{
      const hasTime=dateStr.includes('T')&&dateStr.length>10;
      const dt=new Date(hasTime?dateStr:dateStr+'T12:00');
      const opts={weekday:'short',day:'numeric',month:'short'};
      if(hasTime)return dt.toLocaleDateString('fr-FR',opts)+' à '+dt.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
      return dt.toLocaleDateString('fr-FR',opts);
    }catch(e){return dateStr;}
  }
  function formatSessionTime(dateStr){
    if(!dateStr||!dateStr.includes('T'))return'';
    try{return new Date(dateStr).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});}catch(e){return'';}
  }
  function getMondayStr(date){
    const d=new Date(date),day=d.getDay();d.setDate(d.getDate()+(day===0?-6:1-day));
    return d.toISOString().slice(0,10);
  }
  function weekLabel(mondayStr){
    const m=new Date(mondayStr+'T12:00'),s=new Date(m);s.setDate(s.getDate()+6);
    const opts={day:'numeric',month:'short'};
    return 'Semaine du '+m.toLocaleDateString('fr-FR',opts)+' au '+s.toLocaleDateString('fr-FR',opts);
  }

  function initEmailForm(){
    const saved=localStorage.getItem('sportsync_email')||'';
    HS.userEmail=saved;$('#home-email-input').val(saved);
    if(saved){$('#home-email-section').addClass('collapsed');loadMyMatches();}
    $(document).on('click','#home-email-submit',function(){
      const em=$('#home-email-input').val().trim().toLowerCase();
      if(!em.includes('@')){typeof showToast==='function'&&showToast('Email invalide','error');return;}
      HS.userEmail=em;localStorage.setItem('sportsync_email',em);
      $('#home-email-section').addClass('collapsed');loadMyMatches();
    });
    $(document).on('click','#home-email-change',function(){$('#home-email-section').removeClass('collapsed');});
  }

  function initViewToggle(){
    $(document).on('click','#home-toggle-view',function(){
      HS.viewMode=HS.viewMode==='cards'?'agenda':'cards';
      $(this).text(HS.viewMode==='cards'?'📅 Vue agenda':'🃏 Vue cartes');
      render();
    });
  }

  function init(){initEmailForm();initViewToggle();loadMyMatches();}

  window.SportSyncHome={init,render,loadMyMatches};

  $(document).ready(function(){
    setTimeout(function(){if($('#view-dashboard').length)init();},400);
  });
}(jQuery));
