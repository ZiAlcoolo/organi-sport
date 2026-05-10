/**
 * ════════════════════════════════════════════════════════════════
 * SPORTSYNC — tutorial.js
 * Système tutoriel + popup nouveautés
 * ════════════════════════════════════════════════════════════════
 *
 * Trois composants :
 *   1. Popup "Bienvenue" — bloquant, s'affiche au premier lancement
 *      jusqu'à ce que l'utilisateur lise le tutoriel ou le passe.
 *   2. Page tutoriel — défilable, explique chaque fonctionnalité.
 *   3. Popup "Nouveautés" — s'affiche une seule fois par version.
 *
 * Stockage localStorage :
 *   sportsync_tutorial_done   : '1' si tutoriel vu
 *   sportsync_whats_new_seen  : version vue (ex: '1.3')
 */
;(function($){
  'use strict';

  // ══════════════════════════════════════════════════
  // CONFIGURATION — modifier ici pour chaque release
  // ══════════════════════════════════════════════════

  /** Version courante de l'app — changer pour déclencher le popup nouveautés */
  const APP_VERSION = '1.3';

  const LS_TUTORIAL_KEY  = 'sportsync_tutorial_done';
  const LS_WHATSNEW_KEY  = 'sportsync_whats_new_seen';

  // ══════════════════════════════════════════════════
  // CONTENU DU TUTORIEL
  // Modifier/ajouter des steps ici
  // ══════════════════════════════════════════════════
  const TUTORIAL_STEPS = [
    {
      icon: '🏠',
      title: 'Tableau de bord',
      content: 'La page d\'accueil affiche toutes vos sessions passées et à venir. Identifiez-vous avec votre email pour retrouver automatiquement vos matchs sur n\'importe quel appareil.',
      tip: 'Tapez sur une carte de match pour l\'ouvrir directement.',
    },
    {
      icon: '➕',
      title: 'Créer une session',
      content: 'Appuyez sur le bouton <strong>+</strong> en bas à droite pour créer une nouvelle session. Chaque session a un identifiant unique que vous pouvez partager à vos amis.',
      tip: 'Le bouton 🔁 permet de créer une série de séances récurrentes hebdomadaires.',
    },
    {
      icon: '🗓',
      title: 'Disponibilités',
      content: 'La grille de disponibilités permet à chaque joueur d\'indiquer ses créneaux libres sur la semaine. Utilisez les boutons <em>Semaine</em> et <em>Week-end</em> pour remplir plusieurs jours d\'un coup.',
      tip: 'Le panneau "Créneaux communs" calcule automatiquement les meilleurs moments pour tout le groupe.',
    },
    {
      icon: '⏰',
      title: 'Proposer des créneaux',
      content: 'Dans l\'étape "Créneaux", collez une annonce de réservation (texte copié depuis un site de terrain) dans le Smart Parser — l\'IA locale extrait automatiquement les dates, horaires et prix. Vous avez également la possibilité d\'entrer manuellement les créneaux un par un.',
      tip: 'Votez 👍 sur un créneau pour indiquer votre préférence. Un seul vote par joueur.',
    },
    {
      icon: '📋',
      title: 'Finaliser la session',
      content: 'Renseignez les infos de la session : lieu, date, sport, prix. Recherchez un club dans l\'annuaire pour pré-remplir les champs automatiquement. Gérez les inscrits et la liste d\'attente.',
      tip: 'Exportez la liste en Excel (.xlsx) ou ajoutez la date à votre calendrier (.ics).',
    },
    {
      icon: '🏟',
      title: 'Annuaire des clubs',
      content: 'Parcourez les clubs disponibles, filtrez par sport (Padel, Squash, Tennis…) et consultez les détails : horaires, terrains, tarifs. Ajoutez vos clubs préférés en favoris ♥.',
      tip: 'Entrez votre adresse et cliquez "Valider" pour trier les clubs par distance ou durée de trajet voiture.',
    },
    {
      icon: '🔗',
      title: 'Partager une session',
      content: 'Depuis la vue session, le bouton 🔗 (au-dessus du +) copie le lien unique de la session. Partagez-le à vos amis : ils accèdent directement à la session pour renseigner leurs dispos.',
      tip: 'Les disponibilités se synchronisent en temps réel toutes les 30 secondes.',
    },
    {
      icon: '⚙️',
      title: 'Profil & synchronisation',
      content: 'Configurez votre prénom (affiché sur la grille) et votre email. Ce paramétrage est important pour pouvoir garder vos données à travers vos différents appareils. Renseignez-les immédiatement dès la première ouverture de l\'application. (Ces données ne sont utilisées que pour associer vos données de match à votre profil).',
      tip: 'Le bouton "Actualiser" en bas de chaque page force une synchronisation manuelle.',
    },
  ];

  // ══════════════════════════════════════════════════
  // CONTENU DES NOUVEAUTÉS (mettre à jour à chaque release)
  // ══════════════════════════════════════════════════
  const WHATS_NEW = {
    version: APP_VERSION,
    title: '✨ Nouveautés v1.3',
    items: [
      { icon: '🏟', text: 'Annuaire clubs enrichi : multi-sports, installations détaillées, ...' },
      { icon: '📍', text: 'Calcul de distance depuis votre adresse — distances à vol d\'oiseau + durées de trajet voiture (OSRM).' },
      { icon: '♥',  text: 'Favoris : marquez vos clubs préférés et retrouvez-les dans un onglet dédié.' },
      { icon: '📝', text: 'Notes personnelles locales sur chaque fiche club (sauvegardées sur votre appareil).' },
      { icon: '🔁', text: 'Sessions récurrentes : créez automatiquement une série de séances hebdomadaires.' },
      { icon: '👍', text: 'Votes de créneaux uniques par joueur, mémorisés en local.' },
    ],
  };

  // ══════════════════════════════════════════════════
  // 1. ÉTAT
  // ══════════════════════════════════════════════════
  const TS = {
    currentStep: 0,   // index dans TUTORIAL_STEPS
    totalSteps: TUTORIAL_STEPS.length,
  };

  function tutorialDone(){
    return localStorage.getItem(LS_TUTORIAL_KEY)==='1';
  }
  function markTutorialDone(){
    localStorage.setItem(LS_TUTORIAL_KEY,'1');
  }
  function whatsNewSeen(){
    return localStorage.getItem(LS_WHATSNEW_KEY)===APP_VERSION;
  }
  function markWhatsNewSeen(){
    localStorage.setItem(LS_WHATSNEW_KEY,APP_VERSION);
  }

  // ══════════════════════════════════════════════════
  // 2. POPUP BIENVENUE (bloquant tant que tutoriel non vu)
  // ══════════════════════════════════════════════════
  function showWelcomePopup(){
    $('#tutorial-welcome').removeClass('hidden');
    // Empêcher scroll du body
    $('body').addClass('no-scroll');
  }
  function hideWelcomePopup(){
    $('#tutorial-welcome').addClass('hidden');
    $('body').removeClass('no-scroll');
  }

  // ══════════════════════════════════════════════════
  // 3. PAGE TUTORIEL (vue intégrée dans l'app)
  // ══════════════════════════════════════════════════
  function openTutorial(fromWelcome){
    hideWelcomePopup();
    // Afficher la vue tutoriel
    if(typeof showView==='function') showView('tutorial');
    else {
      $('.app-view').addClass('hidden');
      $('#view-tutorial').removeClass('hidden');
    }
    TS.currentStep=0;
    renderTutorialStep();
    if(fromWelcome) $('body').addClass('no-scroll'); // garde le lock pendant le tuto
  }

  function closeTutorial(){
    markTutorialDone();
    $('body').removeClass('no-scroll');
    // Retourner au dashboard
    if(typeof showView==='function') showView('dashboard');
    else {
      $('#view-tutorial').addClass('hidden');
      $('#view-dashboard').removeClass('hidden');
    }
    // Afficher les nouveautés si pas encore vues
    if(!whatsNewSeen()) setTimeout(showWhatsNew, 400);
  }

  function renderTutorialStep(){
    const step=TUTORIAL_STEPS[TS.currentStep];
    const $content=$('#tutorial-step-content');
    const isFirst=TS.currentStep===0;
    const isLast=TS.currentStep===TS.totalSteps-1;
    const pct=Math.round(((TS.currentStep+1)/TS.totalSteps)*100);

    $content.html(`
      <div class="tuto-step-icon">${step.icon}</div>
      <h2 class="tuto-step-title">${step.title}</h2>
      <p class="tuto-step-content">${step.content}</p>
      ${step.tip?`<div class="tuto-tip"><span class="tuto-tip-icon">💡</span><span>${step.tip}</span></div>`:''}
    `);

    // Dots de progression
    const dots=TUTORIAL_STEPS.map((_,i)=>
      `<span class="tuto-dot ${i===TS.currentStep?'active':i<TS.currentStep?'done':''}"></span>`
    ).join('');
    $('#tutorial-dots').html(dots);

    // Barre de progression
    $('#tutorial-progress-bar').css('width',pct+'%');
    $('#tutorial-step-label').text(`${TS.currentStep+1} / ${TS.totalSteps}`);

    // Boutons navigation
    $('#btn-tuto-prev').toggleClass('hidden',isFirst);
    $('#btn-tuto-next').text(isLast?'✓ Terminer':'Suivant →');

    // Animation slide
    $content.addClass('tuto-slide-in');
    setTimeout(()=>$content.removeClass('tuto-slide-in'),350);
  }

  function goTutoStep(n){
    if(n<0||n>=TS.totalSteps)return;
    const dir=n>TS.currentStep?'forward':'backward';
    const $content=$('#tutorial-step-content');
    $content.addClass(dir==='forward'?'tuto-exit-left':'tuto-exit-right');
    setTimeout(()=>{
      $content.removeClass('tuto-exit-left tuto-exit-right');
      TS.currentStep=n;
      renderTutorialStep();
    },200);
  }

  // ══════════════════════════════════════════════════
  // 4. POPUP NOUVEAUTÉS
  // ══════════════════════════════════════════════════
  function showWhatsNew(){
    const $p=$('#whats-new-popup');
    const items=WHATS_NEW.items.map(item=>
      `<div class="wn-item"><span class="wn-icon">${item.icon}</span><span>${item.text}</span></div>`
    ).join('');
    $p.find('.wn-title').text(WHATS_NEW.title);
    $p.find('.wn-items').html(items);
    $p.removeClass('hidden');
  }
  function hideWhatsNew(){
    markWhatsNewSeen();
    $('#whats-new-popup').addClass('hidden');
  }

  // ══════════════════════════════════════════════════
  // 5. BINDING
  // ══════════════════════════════════════════════════
  function bindEvents(){
    // Popup bienvenue
    $(document).on('click','#btn-welcome-start', function(){
      openTutorial(true);
    });
    $(document).on('click','#btn-welcome-skip', function(){
      markTutorialDone();
      hideWelcomePopup();
      if(!whatsNewSeen()) setTimeout(showWhatsNew,400);
    });

    // Tutoriel — navigation
    $(document).on('click','#btn-tuto-next', function(){
      if(TS.currentStep>=TS.totalSteps-1) closeTutorial();
      else goTutoStep(TS.currentStep+1);
    });
    $(document).on('click','#btn-tuto-prev', function(){
      goTutoStep(TS.currentStep-1);
    });
    $(document).on('click','#btn-tuto-close', function(){
      closeTutorial();
    });
    // Navigation par swipe sur mobile
    let touchStartX=0;
    $('#tutorial-step-content').on('touchstart',function(e){
      touchStartX=e.originalEvent.changedTouches[0].clientX;
    });
    $('#tutorial-step-content').on('touchend',function(e){
      const dx=e.originalEvent.changedTouches[0].clientX-touchStartX;
      if(Math.abs(dx)>50){
        if(dx<0) goTutoStep(TS.currentStep+1); // swipe gauche → suivant
        else     goTutoStep(TS.currentStep-1); // swipe droite → précédent
      }
    });

    // Popup nouveautés
    $(document).on('click','#btn-whats-new-close', hideWhatsNew);
    $(document).on('click','#whats-new-popup',function(e){
      if(e.target===this)hideWhatsNew();
    });

    // Bouton "Tutoriel" dans le profil + dans le dashboard
    $(document).on('click','.btn-open-tutorial', function(){
      openTutorial(false);
    });
    // Bouton "Nouveautés" dans le profil
    $(document).on('click','#btn-open-whats-new', function(){
      showWhatsNew();
    });
  }

  // ══════════════════════════════════════════════════
  // 6. INIT
  // ══════════════════════════════════════════════════
  function init(){
    bindEvents();
    // Au premier lancement : popup bienvenue bloquant
    if(!tutorialDone()){
      setTimeout(showWelcomePopup, 600); // léger délai après le boot
    }
    // Nouveautés : si tutoriel déjà vu mais nouvelle version
    else if(!whatsNewSeen()){
      setTimeout(showWhatsNew, 800);
    }
  }

  window.SportSyncTutorial = { init, openTutorial, showWhatsNew };

  $(document).ready(function(){
    setTimeout(init, 500);
  });

}(jQuery));
