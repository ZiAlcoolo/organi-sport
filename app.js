/**
 * ═══════════════════════════════════════════════════════════
 * SPORTSYNC — app.js
 * Architecture : Vanilla JS + IndexedDB + Google Apps Script
 * ═══════════════════════════════════════════════════════════
 *
 * 📋 GUIDE DE CONFIGURATION — Google Apps Script (proxy API)
 * ──────────────────────────────────────────────────────────
 * Avantages vs appel direct à l'API Sheets v4 :
 *   ✅ Aucune clé API exposée côté client
 *   ✅ Lecture ET écriture sans OAuth2 côté navigateur
 *   ✅ Le script tourne avec les droits du compte Google propriétaire
 *   ✅ CORS géré nativement par le déploiement "Web App"
 *
 * Étapes de déploiement :
 *   1. Ouvrir votre Google Sheet
 *   2. Extensions → Apps Script
 *   3. Coller le contenu de `apps-script.gs` (fourni avec ce projet)
 *   4. Déployer : Déployer → Nouveau déploiement
 *        - Type : Application Web
 *        - Exécuter en tant que : Moi (votre compte Google)
 *        - Accès : Tout le monde (ou "Tout le monde, même anonyme")
 *   5. Copier l'URL de déploiement obtenue (format script.google.com/…/exec)
 *   6. Coller cette URL dans GAS_URL ci-dessous
 *
 * ⚠️  À chaque modification du script .gs, créer un NOUVEAU déploiement
 *      (les URLs de déploiement sont versionnées et immuables).
 *
 * 📋 GUIDE DE CONFIGURATION — Open-Meteo
 * ─────────────────────────────────────────
 * Aucune clé API nécessaire ! Open-Meteo est gratuit et sans auth.
 * ═══════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════
// 1. CONFIGURATION
// ═══════════════════════════════════════════════════

const CONFIG = {
  // ── Google Apps Script ───────────────────────────
  // URL obtenue après déploiement du script lié à votre Sheet.
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwv3Zz33d3Uq3Sfwhd7egCkapkoaOp-CiXKmIIX_8jZJWDvrQin8PuBrr5GNCzxF0gp/exec',

  // ── Open-Meteo ───────────────────────────────────
  METEO: {
    // Bordeaux par défaut — remplacez par les coordonnées de votre ville
    DEFAULT_LAT: 44.8378,
    DEFAULT_LON: -0.5792,
  },

  // ── IndexedDB ────────────────────────────────────
  IDB: {
    NAME:    'sportsync',
    VERSION: 1,
    STORES:  ['session', 'dispos', 'slots', 'players'],
  },

  // ── Session ──────────────────────────────────────
  MAX_PLAYERS: 10,    // Joueurs max avant liste d'attente
};

// ═══════════════════════════════════════════════════
// 2. STATE GLOBAL
// ═══════════════════════════════════════════════════

const state = {
  sessionType: 'once',    // 'once' | 'recurring'
  sessionId:   null,      // UUID pour les sessions uniques
  currentStep: 1,
  isOffline:   !navigator.onLine,
  isSyncing:   false,
  db:          null,       // instance IndexedDB

  // Données locales
  dispos:   [],
  slots:    [],
  players:  [],
  waitlist: [],
  session:  null,
};

// ═══════════════════════════════════════════════════
// 3. INDEXEDDB — Initialisation & CRUD
// ═══════════════════════════════════════════════════

/**
 * Initialise IndexedDB et crée les object stores nécessaires.
 * @returns {Promise<IDBDatabase>}
 */
function initIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CONFIG.IDB.NAME, CONFIG.IDB.VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      CONFIG.IDB.STORES.forEach(storeName => {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true });
        }
      });
      // Store spécial pour les métadonnées (timestamp de synchro, etc.)
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    req.onsuccess  = (e) => resolve(e.target.result);
    req.onerror    = (e) => reject(e.target.error);
  });
}

/**
 * Écrit un enregistrement dans un store.
 * @param {string} storeName
 * @param {object} data
 */
function idbPut(storeName, data) {
  return new Promise((resolve, reject) => {
    const tx  = state.db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Lit tous les enregistrements d'un store.
 * @param {string} storeName
 * @returns {Promise<Array>}
 */
function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx  = state.db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Supprime un enregistrement par clé.
 * @param {string} storeName
 * @param {number} id
 */
function idbDelete(storeName, id) {
  return new Promise((resolve, reject) => {
    const tx  = state.db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Vide complètement un store (après synchro depuis Sheets).
 * @param {string} storeName
 */
function idbClear(storeName) {
  return new Promise((resolve, reject) => {
    const tx  = state.db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ═══════════════════════════════════════════════════
// 4. GOOGLE APPS SCRIPT — Couche API proxy
// ═══════════════════════════════════════════════════
//
// Toutes les communications avec le Sheet passent par une seule
// fonction : gasRequest(). Elle envoie des requêtes GET ou POST
// à l'URL de déploiement Apps Script, qui fait office de proxy
// sécurisé entre le navigateur et Google Sheets.
//
// Protocole :
//   GET  ?action=getData            → reçoit { timestamp, dispos, slots, players, session }
//   POST body JSON { action, ... }  → écrit dans le Sheet, reçoit { ok, timestamp }
//
// Actions POST disponibles (définies dans apps-script.gs) :
//   addDispo    { name, date, time }
//   deleteDispo { id }
//   addSlot     { date, start, end, venue, price }
//   voteSlot    { id, delta }          (+1 ou -1)
//   addPlayer   { name, status }
//   removePlayer{ id }
//   saveSession { date, venue, price, notes }
// ═══════════════════════════════════════════════════

/**
 * Requête générique vers le proxy Apps Script.
 *
 * @param {'GET'|'POST'} method
 * @param {object}       [body]   - payload JSON pour les POST
 * @param {object}       [params] - query params supplémentaires pour les GET
 * @returns {Promise<object>}     - réponse JSON du script
 */
async function gasRequest(method, body = null, params = {}) {
  if (!CONFIG.GAS_URL || CONFIG.GAS_URL === 'VOTRE_URL_APPS_SCRIPT_ICI') {
    throw new Error('GAS_URL non configurée — collez l\'URL de déploiement Apps Script dans CONFIG.GAS_URL');
  }

  let url = CONFIG.GAS_URL;

  if (method === 'GET') {
    // Apps Script GET : les paramètres passent en query string
    const qs = new URLSearchParams({ ...params });
    url = `${url}?${qs.toString()}`;

    const resp = await fetch(url, {
      method:  'GET',
      redirect: 'follow', // indispensable : Apps Script redirige vers l'URL finale
    });
    if (!resp.ok) throw new Error(`GAS GET error ${resp.status}`);
    return resp.json();
  }

  // POST — Apps Script reçoit le JSON dans e.postData.contents
  const resp = await fetch(url, {
    method:  'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain' }, // ⚠️ Apps Script ne parse pas application/json en mode anonyme
    body:    JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`GAS POST error ${resp.status}`);
  return resp.json();
}

/**
 * Récupère toutes les données du Sheet en un seul appel GET.
 * Le script Apps Script renvoie un objet structuré :
 * {
 *   timestamp : <number>,
 *   dispos    : [{ id, name, date, time, createdAt }, …],
 *   slots     : [{ id, date, start, end, venue, price, votes }, …],
 *   players   : [{ id, name, status }, …],
 *   session   : { date, venue, price, notes } | null
 * }
 * @returns {Promise<object>}
 */
async function gasFetchAll() {
  return gasRequest('GET', null, { action: 'getData', sessionId: state.sessionId || 'recurring' });
}

/**
 * Envoie une action d'écriture au proxy Apps Script.
 * @param {string} action  - nom de l'action (ex: 'addDispo')
 * @param {object} payload - données associées
 * @returns {Promise<{ ok: boolean, timestamp: number }>}
 */
async function gasWrite(action, payload = {}) {
  return gasRequest('POST', { action, sessionId: state.sessionId || 'recurring', ...payload });
}

/**
 * Vérifie le timestamp distant et synchronise IndexedDB si nécessaire.
 *
 * Logique :
 *   1. GET getData → reçoit { timestamp, dispos, slots, players, session }
 *   2. Compare timestamp distant avec celui stocké en IDB meta.lastSync
 *   3. Si distant > local  → écrase IDB avec les données reçues
 *   4. Si identique        → rien à faire, IDB déjà à jour
 *   5. Si offline          → mode consultation (pas de requête réseau)
 */
async function syncFromSheets() {
  if (state.isOffline) {
    setSyncStatus('📵 Hors ligne — mode consultation', 'err');
    return;
  }

  setSyncStatus('⏳ Synchronisation…');
  state.isSyncing = true;

  try {
    // Récupérer toutes les données + timestamp en un seul aller-retour
    const remote = await gasFetchAll();

    // Lire le timestamp local depuis IDB
    const localMeta = await new Promise(resolve => {
      const tx  = state.db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get('lastSync');
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => resolve(null);
    });
    const localTs  = localMeta?.value || 0;
    const remoteTs = Number(remote.timestamp) || 0;

    if (remoteTs > localTs) {
      console.log('[Sync] Sheet plus récent, import en cours…');
      await importRemoteData(remote);
      await idbPut('meta', { key: 'lastSync', value: remoteTs });
      setSyncStatus(`✅ Mis à jour — ${new Date(remoteTs).toLocaleTimeString()}`, 'ok');
    } else {
      setSyncStatus(`✅ À jour — ${new Date().toLocaleTimeString()}`, 'ok');
    }

  } catch (err) {
    console.error('[Sync] Erreur:', err);
    // Si GAS_URL non configurée, on le signale clairement
    const msg = err.message.includes('GAS_URL')
      ? '⚙️ GAS_URL non configurée'
      : '⚠️ Synchro échouée — données locales';
    setSyncStatus(msg, 'err');
  }

  state.isSyncing = false;
}

/**
 * Écrase IndexedDB avec les données reçues du proxy Apps Script.
 * @param {object} remote - réponse de gasFetchAll()
 */
async function importRemoteData(remote) {
  // ── Disponibilités ──────────────────────────────
  await idbClear('dispos');
  for (const d of (remote.dispos || [])) {
    await idbPut('dispos', {
      id:        Number(d.id) || Date.now(),
      name:      d.name      || '',
      date:      d.date      || '',
      time:      d.time      || '',
      createdAt: d.createdAt || '',
    });
  }

  // ── Créneaux ────────────────────────────────────
  await idbClear('slots');
  for (const s of (remote.slots || [])) {
    await idbPut('slots', {
      id:    Number(s.id) || Date.now(),
      date:  s.date  || '',
      start: s.start || '',
      end:   s.end   || '',
      venue: s.venue || '',
      price: s.price || '',
      votes: Number(s.votes) || 0,
    });
  }

  // ── Joueurs ─────────────────────────────────────
  await idbClear('players');
  for (const p of (remote.players || [])) {
    await idbPut('players', {
      id:     Number(p.id) || Date.now(),
      name:   p.name   || '',
      status: p.status || 'player',
    });
  }

  // ── Session ──────────────────────────────────────
  if (remote.session) {
    await idbPut('session', { id: 'current', ...remote.session });
  }

  // Recharge le state depuis IDB
  await loadStateFromIDB();
}

/**
 * Charge les données depuis IDB dans le state local.
 */
async function loadStateFromIDB() {
  state.dispos   = await idbGetAll('dispos');
  state.slots    = await idbGetAll('slots');
  const all      = await idbGetAll('players');
  state.players  = all.filter(p => p.status === 'player');
  state.waitlist = all.filter(p => p.status === 'waitlist');
  renderAll();
}

// ═══════════════════════════════════════════════════
// 5. SMART PARSER — Extraction de créneaux
// ═══════════════════════════════════════════════════

/**
 * Parse du texte brut collé depuis un site de réservation.
 * Retourne un tableau de créneaux potentiels sous forme d'objets JSON.
 *
 * Stratégie multi-passes :
 *  1. Extraction des dates (formats FR + ISO)
 *  2. Extraction des heures (HH:MM ou HHhMM)
 *  3. Extraction des prix (€, EUR)
 *  4. Extraction du lieu (mots-clés : terrain, court, salle…)
 *
 * @param {string} rawText
 * @returns {Array<{date, start, end, venue, price}>}
 */
function smartParse(rawText) {
  const results = [];
  const text    = rawText.trim();

  if (!text) return results;

  // ── Patterns ─────────────────────────────────────

  // Dates françaises : "15 juillet", "15/07/2025", "15-07-2025", "mardi 15 juillet 2025"
  const DATE_FR_LONG = /(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)?\s*(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)(?:\s+(\d{4}))?/gi;
  const DATE_NUMERIC = /(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/g;
  const DATE_ISO     = /(\d{4})-(\d{2})-(\d{2})/g;

  // Heures : "20h00", "20:00", "20h", "20h30 - 21h30"
  const TIME_RANGE   = /(\d{1,2})[h:](\d{0,2})\s*[-–à]\s*(\d{1,2})[h:](\d{0,2})/gi;
  const TIME_SINGLE  = /(\d{1,2})[h:](\d{2})/gi;

  // Prix : "18€", "18 €", "18.50€", "18,50 EUR"
  const PRICE        = /(\d+[.,]?\d*)\s*(?:€|EUR|euros?)/gi;

  // Lieu : mots-clés communs
  const VENUE_KW     = /(?:terrain|court|salle|gymnase|stade|complexe|halle|piste|piscine|dojo)\s+(?:n[°o]?\s*\d+|[a-zÀ-ÿ\s]+)?/gi;

  // ── Extraction des blocs de créneaux ─────────────
  // On découpe le texte en "blocs" séparés par lignes vides ou séparateurs
  const blocks = text.split(/\n{2,}|---+|===+|•{2,}/);

  for (const block of blocks) {
    if (block.trim().length < 5) continue;

    const slot = {
      date:  '',
      start: '',
      end:   '',
      venue: '',
      price: '',
      raw:   block.trim(),
    };

    // Chercher une date longue FR
    const matchDateFR = DATE_FR_LONG.exec(block);
    DATE_FR_LONG.lastIndex = 0;
    if (matchDateFR) {
      const mois = {
        janvier:'01', février:'02', mars:'03', avril:'04',
        mai:'05', juin:'06', juillet:'07', août:'08',
        septembre:'09', octobre:'10', novembre:'11', décembre:'12'
      };
      const jour = matchDateFR[1].padStart(2, '0');
      const mo   = mois[matchDateFR[2].toLowerCase()] || '01';
      const an   = matchDateFR[3] || new Date().getFullYear();
      slot.date  = `${an}-${mo}-${jour}`;
    }

    // Fallback : date numérique
    if (!slot.date) {
      const matchISO = DATE_ISO.exec(block);
      DATE_ISO.lastIndex = 0;
      if (matchISO) {
        slot.date = `${matchISO[1]}-${matchISO[2]}-${matchISO[3]}`;
      }
    }

    if (!slot.date) {
      const matchNum = DATE_NUMERIC.exec(block);
      DATE_NUMERIC.lastIndex = 0;
      if (matchNum) {
        const j  = matchNum[1].padStart(2, '0');
        const m  = matchNum[2].padStart(2, '0');
        const an = matchNum[3]
          ? (matchNum[3].length === 2 ? '20' + matchNum[3] : matchNum[3])
          : new Date().getFullYear();
        slot.date = `${an}-${m}-${j}`;
      }
    }

    // Chercher une plage horaire (20h00 - 21h00)
    const matchTimeRange = TIME_RANGE.exec(block);
    TIME_RANGE.lastIndex = 0;
    if (matchTimeRange) {
      slot.start = `${matchTimeRange[1].padStart(2,'0')}:${(matchTimeRange[2] || '00').padStart(2,'0')}`;
      slot.end   = `${matchTimeRange[3].padStart(2,'0')}:${(matchTimeRange[4] || '00').padStart(2,'0')}`;
    } else {
      // Chercher une heure simple
      const times = [...block.matchAll(TIME_SINGLE)];
      if (times.length >= 1) {
        slot.start = `${times[0][1].padStart(2,'0')}:${(times[0][2] || '00').padStart(2,'0')}`;
      }
      if (times.length >= 2) {
        slot.end = `${times[1][1].padStart(2,'0')}:${(times[1][2] || '00').padStart(2,'0')}`;
      }
    }

    // Chercher le prix
    const matchPrice = PRICE.exec(block);
    PRICE.lastIndex = 0;
    if (matchPrice) {
      slot.price = matchPrice[1].replace(',', '.') + '€';
    }

    // Chercher le lieu
    const matchVenue = VENUE_KW.exec(block);
    VENUE_KW.lastIndex = 0;
    if (matchVenue) {
      slot.venue = matchVenue[0].trim();
    }

    // N'ajouter que si on a au moins une date OU une heure
    if (slot.date || slot.start) {
      results.push(slot);
    }
  }

  // Si aucun bloc distinct n'a été trouvé, essayer sur le texte entier
  if (results.length === 0) {
    const fallback = { date:'', start:'', end:'', venue:'', price:'', raw: text };

    const mDate = DATE_FR_LONG.exec(text);
    DATE_FR_LONG.lastIndex = 0;
    if (mDate) {
      const mois = { janvier:'01', février:'02', mars:'03', avril:'04', mai:'05', juin:'06', juillet:'07', août:'08', septembre:'09', octobre:'10', novembre:'11', décembre:'12' };
      fallback.date = `${mDate[3] || new Date().getFullYear()}-${mois[mDate[2].toLowerCase()]}-${mDate[1].padStart(2,'0')}`;
    }

    const mRange = TIME_RANGE.exec(text);
    TIME_RANGE.lastIndex = 0;
    if (mRange) {
      fallback.start = `${mRange[1].padStart(2,'0')}:${(mRange[2]||'00').padStart(2,'0')}`;
      fallback.end   = `${mRange[3].padStart(2,'0')}:${(mRange[4]||'00').padStart(2,'0')}`;
    }

    const mPrice = PRICE.exec(text);
    PRICE.lastIndex = 0;
    if (mPrice) fallback.price = mPrice[1] + '€';

    const mVenue = VENUE_KW.exec(text);
    VENUE_KW.lastIndex = 0;
    if (mVenue) fallback.venue = mVenue[0].trim();

    if (fallback.date || fallback.start) results.push(fallback);
  }

  return results;
}

// ═══════════════════════════════════════════════════
// 6. OPEN-METEO — Météo
// ═══════════════════════════════════════════════════

/**
 * Récupère la météo pour une date donnée via Open-Meteo.
 * API gratuite, sans clé, précision hourly.
 * @param {string} date - Format YYYY-MM-DD
 * @param {number} lat
 * @param {number} lon
 */
async function fetchWeather(date, lat = CONFIG.METEO.DEFAULT_LAT, lon = CONFIG.METEO.DEFAULT_LON) {
  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${lat}&longitude=${lon}`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max`
    + `&timezone=Europe%2FParis`
    + `&start_date=${date}&end_date=${date}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Météo indisponible');
  const data = await resp.json();

  return {
    tempMax:  data.daily.temperature_2m_max?.[0],
    tempMin:  data.daily.temperature_2m_min?.[0],
    rain:     data.daily.precipitation_sum?.[0],
    wind:     data.daily.windspeed_10m_max?.[0],
  };
}

/**
 * Affiche la météo dans la card dédiée.
 * @param {string} date
 */
async function renderWeather(date) {
  const container = document.getElementById('weather-content');
  if (!date) {
    container.innerHTML = '<p class="empty-state">Sélectionnez un créneau pour voir la météo.</p>';
    return;
  }

  container.innerHTML = '<p class="empty-state">Chargement météo…</p>';
  try {
    const w    = await fetchWeather(date);
    const rain = w.rain > 5 ? '🌧' : w.rain > 0 ? '🌦' : '☀️';
    container.innerHTML = `
      <div class="weather-grid">
        <div class="weather-cell">
          <div class="weather-temp">${w.tempMax ?? '--'}°</div>
          <div class="weather-label">Max</div>
        </div>
        <div class="weather-cell">
          <div class="weather-temp" style="color:var(--text-sub)">${w.tempMin ?? '--'}°</div>
          <div class="weather-label">Min</div>
        </div>
        <div class="weather-cell">
          <div class="weather-temp" style="font-size:1.6rem">${rain}</div>
          <div class="weather-label">${w.rain ?? 0} mm</div>
        </div>
        <div class="weather-cell">
          <div class="weather-temp" style="font-size:1rem;color:var(--accent3)">${w.wind ?? '--'}</div>
          <div class="weather-label">km/h vent</div>
        </div>
      </div>
    `;
  } catch {
    container.innerHTML = '<p class="empty-state">Météo non disponible.</p>';
  }
}

// ═══════════════════════════════════════════════════
// 7. EXPORTS — XLSX & ICS
// ═══════════════════════════════════════════════════

/**
 * Exporte les données de la session en fichier .xlsx via SheetJS.
 */
function exportXLSX() {
  const wb   = XLSX.utils.book_new();

  // Feuille Inscrits
  const playersData = [
    ['#', 'Prénom', 'Statut'],
    ...state.players.map((p, i) => [i + 1, p.name, 'Inscrit']),
    ...state.waitlist.map((p, i) => [state.players.length + i + 1, p.name, 'Liste d\'attente']),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(playersData), 'Inscrits');

  // Feuille Session
  const s = state.session || {};
  const sessionData = [
    ['Champ', 'Valeur'],
    ['Date',        s.date    || ''],
    ['Lieu',        s.venue   || ''],
    ['Prix total',  s.price   || ''],
    ['Notes',       s.notes   || ''],
    ['Nb inscrits', state.players.length],
    ['Nb attente',  state.waitlist.length],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sessionData), 'Session');

  // Feuille Créneaux
  const slotsData = [
    ['Date', 'Début', 'Fin', 'Lieu', 'Prix', 'Votes'],
    ...state.slots.map(s => [s.date, s.start, s.end, s.venue, s.price, s.votes || 0]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(slotsData), 'Créneaux');

  XLSX.writeFile(wb, `sportsync-session-${Date.now()}.xlsx`);
  showToast('Export Excel généré ✓', 'success');
}

/**
 * Génère et télécharge un fichier .ics (iCalendar) pour la session.
 */
function exportICS() {
  const s = state.session;
  if (!s || !s.date) {
    showToast('Renseignez d\'abord la date de la session', 'error');
    return;
  }

  const dt      = new Date(s.date);
  const dtEnd   = new Date(dt.getTime() + 60 * 60 * 1000); // +1h par défaut
  const fmt     = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SportSync//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:sportsync-${state.sessionId || 'session'}@app`,
    `DTSTART:${fmt(dt)}`,
    `DTEND:${fmt(dtEnd)}`,
    `SUMMARY:Session Sport — ${s.venue || 'SportSync'}`,
    `DESCRIPTION:Inscrits : ${state.players.map(p => p.name).join(', ')}\\n${s.notes || ''}`,
    `LOCATION:${s.venue || ''}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `sportsync-session.ics`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Fichier calendrier généré ✓', 'success');
}

// ═══════════════════════════════════════════════════
// 8. RENDU — Mise à jour du DOM
// ═══════════════════════════════════════════════════

function renderAll() {
  renderDispos();
  renderSlots();
  renderPlayers();
}

/** Affiche le tableau des disponibilités */
function renderDispos() {
  const container = document.getElementById('dispo-table-container');
  if (state.dispos.length === 0) {
    container.innerHTML = '<p class="empty-state">Aucune disponibilité pour l\'instant.</p>';
    return;
  }

  const rows = state.dispos.map(d => `
    <tr>
      <td>${d.name}</td>
      <td>${formatDate(d.date)}</td>
      <td>${d.time || '—'}</td>
      <td>
        <button class="btn-delete" onclick="removeDispo(${d.id})" ${state.isOffline ? 'disabled' : ''}>
          ✕
        </button>
      </td>
    </tr>
  `).join('');

  container.innerHTML = `
    <table class="dispo-table">
      <thead><tr><th>Prénom</th><th>Date</th><th>Heure</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/** Affiche les créneaux avec votes */
function renderSlots() {
  const container = document.getElementById('slots-container');
  if (state.slots.length === 0) {
    container.innerHTML = '<p class="empty-state">Aucun créneau ajouté pour l\'instant.</p>';
    return;
  }

  const items = state.slots.map(slot => {
    const voted = slot._voted || false;
    return `
      <div class="slot-item">
        <div class="slot-info">
          <div class="slot-date">${formatDate(slot.date)} · ${slot.start}${slot.end ? ' – ' + slot.end : ''}</div>
          <div class="slot-meta">${slot.venue || 'Lieu non précisé'}</div>
        </div>
        <span class="slot-price">${slot.price || '—'}</span>
        <button
          class="vote-btn ${voted ? 'voted' : ''}"
          onclick="voteSlot(${slot.id})"
          ${state.isOffline ? 'disabled' : ''}
        >
          👍 ${slot.votes || 0}
        </button>
      </div>
    `;
  }).join('');

  container.innerHTML = items;
}

/** Affiche les inscrits et la liste d'attente */
function renderPlayers() {
  const container = document.getElementById('players-list');
  document.getElementById('player-count').textContent  = state.players.length;
  document.getElementById('waitlist-count').textContent = state.waitlist.length;

  if (state.players.length === 0) {
    container.innerHTML = '<p class="empty-state">Aucun inscrit pour l\'instant.</p>';
  } else {
    container.innerHTML = state.players.map((p, i) => `
      <div class="player-item">
        <div>
          <span class="player-name">${p.name}</span>
          <span class="player-num"> #${i + 1}</span>
        </div>
        <button class="btn-delete" onclick="removePlayer(${p.id}, 'player')" ${state.isOffline ? 'disabled' : ''}>✕</button>
      </div>
    `).join('');
  }

  const waitlistContainer = document.getElementById('waitlist-container');
  if (state.waitlist.length === 0) {
    waitlistContainer.innerHTML = '<p class="empty-state">Liste d\'attente vide.</p>';
  } else {
    waitlistContainer.innerHTML = state.waitlist.map((p, i) => `
      <div class="player-item">
        <div>
          <span class="player-name">${p.name}</span>
          <span class="player-num" style="color:var(--accent2)"> attente #${i + 1}</span>
        </div>
        <button class="btn-delete" onclick="removePlayer(${p.id}, 'waitlist')" ${state.isOffline ? 'disabled' : ''}>✕</button>
      </div>
    `).join('');
  }
}

// ═══════════════════════════════════════════════════
// 9. ACTIONS UTILISATEUR
// ═══════════════════════════════════════════════════

/** Ajoute une disponibilité */
async function addDispo() {
  if (state.isOffline) return showToast('Mode consultation — modifications désactivées', 'error');

  const name = document.getElementById('dispo-name').value.trim();
  const date = document.getElementById('dispo-date').value;
  const time = document.getElementById('dispo-time').value;

  if (!name || !date) return showToast('Prénom et date requis', 'error');

  const createdAt = new Date().toISOString();

  // 1. Écriture locale IDB immédiate (UX réactive, pas d'attente réseau)
  const entry   = { name, date, time, createdAt };
  const localId = await idbPut('dispos', entry);
  entry.id = localId;
  state.dispos.push(entry);
  renderDispos();

  // Reset formulaire dès maintenant
  document.getElementById('dispo-name').value = '';
  document.getElementById('dispo-date').value = '';
  document.getElementById('dispo-time').value = '';

  // 2. Synchro distante Apps Script (en arrière-plan)
  try {
    const result = await gasWrite('addDispo', { name, date, time, createdAt });
    // Si le script retourne un id canonique, on remplace l'id local
    if (result.id && result.id !== localId) {
      await idbDelete('dispos', localId);
      entry.id = result.id;
      await idbPut('dispos', entry);
      state.dispos = state.dispos.map(d => d.id === localId ? entry : d);
    }
    showToast('Disponibilité ajoutée ✓', 'success');
  } catch (err) {
    console.warn('[addDispo] Synchro distante échouée:', err.message);
    showToast('Ajouté localement — synchro au prochain démarrage', 'success');
  }
}

/** Supprime une disponibilité */
async function removeDispo(id) {
  // 1. Suppression locale immédiate
  await idbDelete('dispos', id);
  state.dispos = state.dispos.filter(d => d.id !== id);
  renderDispos();

  // 2. Synchro distante
  try {
    await gasWrite('deleteDispo', { id });
  } catch (err) {
    console.warn('[removeDispo] Synchro distante échouée:', err.message);
  }
}

/** Ajoute un créneau (depuis le modal ou le Smart Parser) */
async function addSlot(slotData) {
  if (state.isOffline) return showToast('Mode consultation — modifications désactivées', 'error');

  // 1. IDB local
  const slot    = { ...slotData, votes: 0, _voted: false };
  const localId = await idbPut('slots', slot);
  slot.id = localId;
  state.slots.push(slot);
  renderSlots();
  showToast('Créneau ajouté ✓', 'success');

  // 2. Synchro distante
  try {
    const result = await gasWrite('addSlot', {
      date: slot.date, start: slot.start, end: slot.end,
      venue: slot.venue, price: slot.price,
    });
    if (result.id && result.id !== localId) {
      await idbDelete('slots', localId);
      slot.id = result.id;
      await idbPut('slots', slot);
      state.slots = state.slots.map(s => s.id === localId ? slot : s);
    }
  } catch (err) {
    console.warn('[addSlot] Synchro distante échouée:', err.message);
  }
}

/** Vote pour un créneau */
async function voteSlot(id) {
  if (state.isOffline) return showToast('Mode consultation — modifications désactivées', 'error');

  const slot = state.slots.find(s => s.id === id);
  if (!slot) return;

  // Toggle vote local
  slot._voted = !slot._voted;
  const delta = slot._voted ? 1 : -1;
  slot.votes  = (slot.votes || 0) + delta;
  await idbPut('slots', slot);

  // Mise à jour météo si ce créneau a une date
  if (slot._voted && slot.date) renderWeather(slot.date);
  renderSlots();

  // Synchro distante du compteur de votes
  try {
    await gasWrite('voteSlot', { id, delta });
  } catch (err) {
    console.warn('[voteSlot] Synchro distante échouée:', err.message);
  }
}

/** Ajoute un joueur ou le met en liste d'attente */
async function addPlayer() {
  if (state.isOffline) return showToast('Mode consultation — modifications désactivées', 'error');

  const name = document.getElementById('new-player-name').value.trim();
  if (!name) return;

  const status   = state.players.length >= CONFIG.MAX_PLAYERS ? 'waitlist' : 'player';
  const player   = { name, status };
  const localId  = await idbPut('players', player);
  player.id = localId;

  if (status === 'player') state.players.push(player);
  else                     state.waitlist.push(player);

  renderPlayers();
  document.getElementById('new-player-name').value = '';

  showToast(
    status === 'waitlist' ? `${name} ajouté en liste d'attente` : `${name} inscrit ✓`,
    'success'
  );

  // Synchro distante
  try {
    const result = await gasWrite('addPlayer', { name, status });
    if (result.id && result.id !== localId) {
      await idbDelete('players', localId);
      player.id = result.id;
      await idbPut('players', player);
      const list = status === 'player' ? state.players : state.waitlist;
      const idx  = list.findIndex(p => p.id === localId);
      if (idx !== -1) list[idx] = player;
    }
  } catch (err) {
    console.warn('[addPlayer] Synchro distante échouée:', err.message);
  }
}

/** Retire un joueur et promeut la liste d'attente si besoin */
async function removePlayer(id, status) {
  // 1. Suppression locale
  await idbDelete('players', id);
  if (status === 'player') {
    state.players = state.players.filter(p => p.id !== id);
    // Promotion automatique depuis la liste d'attente
    if (state.waitlist.length > 0) {
      const promoted  = state.waitlist.shift();
      promoted.status = 'player';
      await idbPut('players', promoted);
      state.players.push(promoted);
      showToast(`${promoted.name} promu depuis la liste d'attente ✓`, 'success');
      // Synchro promotion
      gasWrite('promotePlayer', { id: promoted.id }).catch(() => {});
    }
  } else {
    state.waitlist = state.waitlist.filter(p => p.id !== id);
  }
  renderPlayers();

  // 2. Synchro distante suppression
  try {
    await gasWrite('removePlayer', { id });
  } catch (err) {
    console.warn('[removePlayer] Synchro distante échouée:', err.message);
  }
}

/** Sauvegarde les infos de session */
async function saveSession() {
  const session = {
    id:    'current',
    date:  document.getElementById('session-date').value,
    venue: document.getElementById('session-venue').value,
    price: document.getElementById('session-price').value,
    notes: document.getElementById('session-notes').value,
  };

  // 1. IDB local
  await idbPut('session', session);
  state.session = session;
  showToast('Session enregistrée ✓', 'success');

  // 2. Synchro distante
  try {
    await gasWrite('saveSession', {
      date: session.date, venue: session.venue,
      price: session.price, notes: session.notes,
    });
  } catch (err) {
    console.warn('[saveSession] Synchro distante échouée:', err.message);
  }
}

// ═══════════════════════════════════════════════════
// 10. NAVIGATION PAR ÉTAPES
// ═══════════════════════════════════════════════════

function goToStep(n) {
  // Panels
  document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`step-${n}`)?.classList.add('active');

  // Nav buttons
  document.querySelectorAll('.step-btn').forEach(btn => {
    const s = Number(btn.dataset.step);
    btn.classList.toggle('active', s === n);
    btn.classList.toggle('done',   s < n);
  });

  state.currentStep = n;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ═══════════════════════════════════════════════════
// 11. URL PARAMS — Type de session
// ═══════════════════════════════════════════════════

/**
 * Parse les paramètres d'URL pour configurer le type de session.
 *
 * Exemples d'URL supportées :
 *   ?type=recurring          → Session récurrente (foot du mardi)
 *   ?type=once               → Session unique
 *   ?type=once&id=UUID       → Session unique identifiée
 */
function parseURLParams() {
  const params = new URLSearchParams(window.location.search);
  const type   = params.get('type') || 'once';
  const id     = params.get('id')   || generateUUID();

  state.sessionType = type;
  state.sessionId   = type === 'recurring' ? null : id;

  // Mettre à jour le badge
  const badge = document.getElementById('session-badge');
  if (type === 'recurring') {
    badge.textContent = '🔁 Récurrent';
    badge.style.borderColor = 'var(--accent-dim)';
    badge.style.color       = 'var(--accent)';
  } else {
    badge.textContent = `🎯 ${id.slice(0, 8).toUpperCase()}`;
  }

  // Pour une session once, écrire l'UUID dans l'URL si pas déjà présent
  if (type === 'once' && !params.get('id')) {
    const newURL = `${window.location.pathname}?type=once&id=${id}`;
    history.replaceState(null, '', newURL);
  }
}

// ═══════════════════════════════════════════════════
// 12. UTILITAIRES
// ═══════════════════════════════════════════════════

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('fr-FR', {
      weekday: 'short', day: 'numeric', month: 'short'
    });
  } catch { return dateStr; }
}

function setSyncStatus(msg, type = '') {
  const el = document.getElementById('sync-status');
  el.textContent = msg;
  el.className   = `sync-status ${type}`;
}

function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = `toast ${type}`;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function setOfflineMode(offline) {
  state.isOffline = offline;
  const banner    = document.getElementById('offline-banner');
  banner.classList.toggle('hidden', !offline);
  // Désactiver les champs en mode offline
  document.querySelectorAll('input, textarea, button:not(.btn-ghost):not(.btn-delete):not(.vote-btn)')
    .forEach(el => {
      if (offline) el.setAttribute('disabled', '');
      else         el.removeAttribute('disabled');
    });
  if (offline) setSyncStatus('📵 Hors ligne — consultation uniquement', 'err');
}

// ═══════════════════════════════════════════════════
// 13. ÉVÉNEMENTS DOM
// ═══════════════════════════════════════════════════

function bindEvents() {
  // ── Navigation ───────────────────────────────────
  document.querySelectorAll('.step-btn').forEach(btn =>
    btn.addEventListener('click', () => goToStep(Number(btn.dataset.step)))
  );

  // Étape 1
  document.getElementById('btn-add-dispo').addEventListener('click', addDispo);
  document.getElementById('btn-dispo-next').addEventListener('click', () => goToStep(2));
  document.getElementById('btn-skip-dispo').addEventListener('click', () => goToStep(2));

  // Étape 2
  document.getElementById('btn-slots-back').addEventListener('click', () => goToStep(1));
  document.getElementById('btn-slots-next').addEventListener('click', () => goToStep(3));

  // Smart Parser
  document.getElementById('btn-parse').addEventListener('click', () => {
    const raw     = document.getElementById('smart-parser-input').value;
    const results = smartParse(raw);
    const el      = document.getElementById('parser-result');

    if (results.length === 0) {
      el.textContent = '⚠️ Aucun créneau détecté. Essayez avec un texte plus détaillé.';
      el.classList.remove('hidden');
      return;
    }

    el.textContent = JSON.stringify(results, null, 2);
    el.classList.remove('hidden');

    // Proposer d'ajouter les créneaux détectés
    results.forEach(slot => {
      if (slot.date || slot.start) addSlot(slot);
    });
    showToast(`${results.length} créneau(x) détecté(s) ✓`, 'success');
  });

  document.getElementById('btn-parse-clear').addEventListener('click', () => {
    document.getElementById('smart-parser-input').value = '';
    document.getElementById('parser-result').classList.add('hidden');
  });

  // Modal créneau manuel
  document.getElementById('btn-add-slot-manual').addEventListener('click', () => {
    document.getElementById('modal-slot').classList.remove('hidden');
  });

  document.getElementById('btn-modal-cancel').addEventListener('click', () => {
    document.getElementById('modal-slot').classList.add('hidden');
  });

  document.getElementById('btn-modal-confirm').addEventListener('click', () => {
    const slot = {
      date:  document.getElementById('modal-slot-date').value,
      start: document.getElementById('modal-slot-start').value,
      end:   document.getElementById('modal-slot-end').value,
      venue: document.getElementById('modal-slot-venue').value,
      price: document.getElementById('modal-slot-price').value
        ? document.getElementById('modal-slot-price').value + '€' : '',
    };
    if (!slot.date && !slot.start) {
      showToast('Date ou heure requise', 'error');
      return;
    }
    addSlot(slot);
    document.getElementById('modal-slot').classList.add('hidden');
    // Reset modal
    ['modal-slot-date','modal-slot-start','modal-slot-end','modal-slot-venue','modal-slot-price']
      .forEach(id => document.getElementById(id).value = '');
  });

  // Fermer modal sur overlay
  document.getElementById('modal-slot').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });

  // Étape 3
  document.getElementById('btn-final-back').addEventListener('click', () => goToStep(2));
  document.getElementById('btn-save-session').addEventListener('click', saveSession);
  document.getElementById('btn-add-player').addEventListener('click', addPlayer);
  document.getElementById('new-player-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addPlayer();
  });

  // Exports
  document.getElementById('btn-export-xlsx').addEventListener('click', exportXLSX);
  document.getElementById('btn-export-ics').addEventListener('click',  exportICS);

  // Sync manuelle
  document.getElementById('btn-force-sync').addEventListener('click', syncFromSheets);

  // ── Réseau ───────────────────────────────────────
  window.addEventListener('online',  () => { setOfflineMode(false); syncFromSheets(); });
  window.addEventListener('offline', () => setOfflineMode(true));
}

// ═══════════════════════════════════════════════════
// 14. BOOT
// ═══════════════════════════════════════════════════

async function boot() {
  try {
    // 1. IndexedDB
    state.db = await initIDB();
    console.log('[Boot] IndexedDB initialisée');

    // 2. URL params
    parseURLParams();

    // 3. Charger les données locales immédiatement (expérience rapide)
    await loadStateFromIDB();

    // 4. Synchro réseau en arrière-plan
    if (!state.isOffline) {
      syncFromSheets().catch(err => {
        console.warn('[Boot] Synchro échouée, données locales utilisées:', err.message);
        setSyncStatus('⚠️ Synchro échouée — données locales', 'err');
      });
    } else {
      setOfflineMode(true);
    }

    // 5. Binding événements
    bindEvents();

    // 6. Afficher étape 1 par défaut
    goToStep(1);

    console.log('[Boot] SportSync prêt ✓', {
      type: state.sessionType,
      id:   state.sessionId,
    });

  } catch (err) {
    console.error('[Boot] Erreur critique:', err);
    setSyncStatus('❌ Erreur au démarrage', 'err');
  }
}

// ── Démarrage ────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

// ── Expose globalement (appelé depuis le HTML inline) ─
window.removeDispo   = removeDispo;
window.voteSlot      = voteSlot;
window.removePlayer  = removePlayer;
