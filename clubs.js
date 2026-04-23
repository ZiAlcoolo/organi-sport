/**
 * ════════════════════════════════════════════════════════════════
 * SPORTSYNC — clubs.js  v5
 * ════════════════════════════════════════════════════════════════
 *
 * Stratégie de distance v5 (nouvelle architecture) :
 *
 *   CLUBS → colonnes `lat` et `lon` renseignées manuellement dans
 *   le Google Sheet (ex : lat=44.8378, lon=-0.5792). Plus besoin
 *   de géocoder les clubs → zéro requête supplémentaire.
 *
 *   UTILISATEUR → entre son adresse + clique "Valider" :
 *     1. GAS proxy appelle Nominatim (1 seule requête, pas de CORS)
 *        → retourne lat/lon de l'utilisateur
 *     2. Haversine JS calcule distance à vol d'oiseau → affiché
 *        immédiatement en quelques secondes
 *     3. En arrière-plan : OSRM route API (gratuit, CORS ok direct)
 *        → durées de trajet en voiture pour tous les clubs en 1 batch
 *     4. Tout est caché en localStorage (adresse + coords + distances)
 *
 *   Interface : bouton "Valider" explicite (pas de debounce automatique)
 *   → l'utilisateur contrôle quand le calcul est déclenché.
 */
; (function ($) {
  'use strict';

  // ══════════════════════════════════════════════════
  // 1. STATE
  // ══════════════════════════════════════════════════
  const CS = {
    clubs: [],
    filteredClubs: [],
    activeClub: null,
    searchQuery: '',
    sportFilter: '',
    activeTab: 'all',      // 'all' | 'favorites'
    sortBy: 'name',     // 'name' | 'distance'
    userCoords: null,       // { lat, lon } coords utilisateur géocodées
    userAddress: '',
    distanceMode: 'haversine',// 'haversine' | 'osrm'
    isGeocoding: false,
  };

  // localStorage keys
  const LS_NOTES_KEY = 'sportsync_club_notes';
  const LS_ADDRESS_KEY = 'sportsync_user_address';
  const LS_COORDS_KEY = 'sportsync_user_coords';   // { lat, lon }
  const LS_DISTS_KEY = 'sportsync_club_distances'; // { clubId: { km, min } }
  const LS_FAVS_KEY = 'sportsync_club_favorites';

  // OSRM public API — accepte CORS directement depuis le navigateur
  const OSRM_URL = 'https://router.project-osrm.org/table/v1/driving/';

  // ══════════════════════════════════════════════════
  // 2. SPORTS
  // ══════════════════════════════════════════════════
  const SPORTS_PRIORITY = ['Padel', 'Squash', 'Bad', 'Pickleball', 'Five', 'Tennis'];

  const SPORT_COLORS = {
    'padel': '#4ade80', 'tennis': '#f59e0b', 'squash': '#c084fc',
    'bad': '#34d399', 'badminton': '#34d399', 'pickleball': '#fb923c',
    'five': '#60a5fa', 'foot': '#60a5fa', 'football': '#60a5fa',
    'basket': '#f87171', 'handball': '#fb923c', 'natation': '#38bdf8',
    'cyclisme': '#fbbf24', 'default': '#9299b0',
  };
  const SPORT_EMOJI = {
    'padel': '🎾', 'tennis': '🎾', 'squash': '🏸', 'bad': '🏸', 'badminton': '🏸',
    'pickleball': '🏓', 'five': '⚽', 'foot': '⚽', 'football': '⚽',
    'basket': '🏀', 'handball': '🤾', 'natation': '🏊', 'cyclisme': '🚴', 'default': '🏅',
  };

  function sportColor(s) {
    if (!s) return SPORT_COLORS.default; const k = s.toLowerCase();
    for (const n in SPORT_COLORS) if (k.includes(n)) return SPORT_COLORS[n];
    return SPORT_COLORS.default;
  }
  function sportEmoji(s) {
    if (!s) return SPORT_EMOJI.default; const k = s.toLowerCase();
    for (const n in SPORT_EMOJI) if (k.includes(n)) return SPORT_EMOJI[n];
    return SPORT_EMOJI.default;
  }
  function parseSports(raw) {
    if (!raw) return [];
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  function getAllSportsFromClubs(clubs) {
    const set = new Set();
    clubs.forEach(c => parseSports(c.sport).forEach(s => set.add(s)));
    const priority = SPORTS_PRIORITY.filter(s => set.has(s));
    const others = [...set].filter(s => !SPORTS_PRIORITY.includes(s)).sort();
    return [...priority, ...others];
  }
  function photoUrl(club) {
    if (club.photoUrl && club.photoUrl.startsWith('http')) return club.photoUrl;
    const sports = parseSports(club.sport);
    const q = (sports[0] || 'sport').toLowerCase().replace(/\s+/, ',');
    return `https://source.unsplash.com/featured/400x200/?${encodeURIComponent(q)},court,sport`;
  }

  // ══════════════════════════════════════════════════
  // 3. FAVORIS
  // ══════════════════════════════════════════════════
  function getFavorites() {
    try { return new Set(JSON.parse(localStorage.getItem(LS_FAVS_KEY) || '[]')); }
    catch (e) { return new Set(); }
  }
  function saveFavorites(set) {
    localStorage.setItem(LS_FAVS_KEY, JSON.stringify([...set]));
  }
  function isFavorite(clubId) { return getFavorites().has(String(clubId)); }
  function toggleFavorite(clubId) {
    const favs = getFavorites(), id = String(clubId);
    if (favs.has(id)) favs.delete(id); else favs.add(id);
    saveFavorites(favs); return favs.has(id);
  }

  // ══════════════════════════════════════════════════
  // 4. INSTALLATIONS
  // ══════════════════════════════════════════════════
  function parseInstallations(raw) {
    if (!raw) return [];
    try {
      const d = typeof raw === 'string' && raw.trim().startsWith('[') ? JSON.parse(raw) : null;
      return Array.isArray(d) ? d : [];
    } catch (e) { return []; }
  }
  function renderInstallations(raw) {
    const inst = parseInstallations(raw); if (!inst.length) return '';
    const rows = inst.map(i => {
      const t = Number(i.total) || 0, cv = Number(i.covered) || 0, op = t - cv;
      const s = cv === t ? `${t} terrain${t > 1 ? 's' : ''} (${cv} couvert${cv > 1 ? 's' : ''})`
        : cv === 0 ? `${t} terrain${t > 1 ? 's' : ''}`
          : `${t} terrain${t > 1 ? 's' : ''} (${cv} couvert${cv > 1 ? 's' : ''}, ${op} découvert${op > 1 ? 's' : ''})`;
      return `<div class="install-row">
        <div class="install-sport">${sportEmoji(i.sport || '')} ${i.sport || '—'}</div>
        ${i.surface ? `<div class="install-surface">${i.surface}</div>` : ''}
        <div class="install-count">${s}</div>
      </div>`;
    }).join('');
    return `<div class="installations-block"><div class="installations-title">🏗 Installations</div>${rows}</div>`;
  }
  function installSummary(raw) {
    const inst = parseInstallations(raw); if (!inst.length) return '';
    return inst.map(i => `${sportEmoji(i.sport || '')}×${i.total || '?'}`).join('  ');
  }

  // ══════════════════════════════════════════════════
  // 5. NOTES LOCALES
  // ══════════════════════════════════════════════════
  function getLocalNotes() { try { return JSON.parse(localStorage.getItem(LS_NOTES_KEY) || '{}'); } catch (e) { return {}; } }
  function saveLocalNote(clubId, text) {
    const n = getLocalNotes();
    if (text.trim()) n[clubId] = text; else delete n[clubId];
    localStorage.setItem(LS_NOTES_KEY, JSON.stringify(n));
  }
  function getLocalNote(clubId) { return getLocalNotes()[clubId] || ''; }

  // ══════════════════════════════════════════════════
  // 6. DISTANCES — CACHE localStorage
  // ══════════════════════════════════════════════════
  function getSavedDistances() {
    try { return JSON.parse(localStorage.getItem(LS_DISTS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveDistances(obj) {
    localStorage.setItem(LS_DISTS_KEY, JSON.stringify(obj));
  }

  /** Charge les distances cachées sur les objets clubs en mémoire */
  function _applyDistanceCache() {
    const saved = getSavedDistances();
    CS.clubs.forEach(c => {
      const d = saved[String(c.id)];
      if (d) {
        c._dist = d.km;
        c._distMin = d.min || null;
        c._distLabel = _buildDistLabel(d.km, d.min);
      }
    });
  }

  function _buildDistLabel(km, min) {
    if (km == null) return '';
    const kmStr = km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1).replace('.', ',')} km`;
    return min ? `${kmStr} · ${Math.round(min)} min` : kmStr;
  }

  // ══════════════════════════════════════════════════
  // 7. GÉOCODAGE UTILISATEUR
  // ══════════════════════════════════════════════════

  /**
   * Géocode l'adresse de l'utilisateur
   */


  async function geocodeUserAddress(address) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`;

    try {
      const resp = await fetch(url, {
        headers: {
          'Accept': 'application/json'
        }
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();

      if (!data || !data.length) return null;

      return {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon)
      };

    } catch (e) {
      console.warn('[Geocode]', e.message || e);
      return null;
    }
  }

  // ══════════════════════════════════════════════════
  // 8. HAVERSINE — distance vol d'oiseau
  // ══════════════════════════════════════════════════
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371, toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Calcule les distances Haversine pour tous les clubs
   * qui ont des coords `lat`/`lon` dans le Sheet.
   * Instantané — aucune requête réseau.
   */
  function computeHaversineDistances(userLat, userLon) {
    const cache = {};
    let count = 0;
    CS.clubs.forEach(c => {
      // lat/lon proviennent des colonnes du Sheet (renseignées manuellement)
      const cLat = parseFloat(c.lat || c._lat);
      const cLon = parseFloat(c.lon || c._lon);
      if (!isNaN(cLat) && !isNaN(cLon)) {
        const km = haversine(userLat, userLon, cLat, cLon);
        c._dist = km;
        c._distMin = null; // sera mis à jour par OSRM
        c._distLabel = _buildDistLabel(km, null);
        cache[String(c.id)] = { km, min: null };
        count++;
      } else {
        c._dist = null; c._distMin = null; c._distLabel = '';
      }
    });
    // Sauvegarder dans le cache (les durées OSRM viendront après)
    const existing = getSavedDistances();
    Object.assign(existing, cache);
    saveDistances(existing);
    return count;
  }

  // ══════════════════════════════════════════════════
  // 9. OSRM — durées de trajet en voiture (arrière-plan)
  //    API publique gratuite, accepte CORS directement depuis le nav.
  //    Format : /table/v1/driving/lon,lat;lon,lat;...
  //    ?sources=0&annotations=duration,distance
  // ══════════════════════════════════════════════════

  /**
   * Récupère les durées de trajet depuis l'adresse utilisateur
   * vers tous les clubs qui ont des coords (lat/lon).
   * Appel unique batch — tous les clubs en une seule requête.
   * @param {number} userLat
   * @param {number} userLon
   */
  async function fetchOSRMDurations(userLat, userLon) {
    const clubsWithCoords = CS.clubs.filter(c => {
      const lat = parseFloat(c.lat || c._lat), lon = parseFloat(c.lon || c._lon);
      return !isNaN(lat) && !isNaN(lon);
    });
    if (!clubsWithCoords.length) return;

    // Construire la chaîne de coordonnées : utilisateur en index 0,
    // puis tous les clubs. Format OSRM : lon,lat (inversé vs standard)
    const coords = [`${userLon},${userLat}`];
    clubsWithCoords.forEach(c => {
      const lat = parseFloat(c.lat || c._lat), lon = parseFloat(c.lon || c._lon);
      coords.push(`${lon},${lat}`);
    });

    const url = `${OSRM_URL}${coords.join(';')}?sources=0&annotations=duration,distance`;

    try {
      const resp = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (!resp.ok) throw new Error(`OSRM HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.code !== 'Ok') throw new Error('OSRM code: ' + data.code);

      const durations = data.durations[0]; // tableau des durées depuis source 0
      const distances = data.distances[0]; // tableau des distances depuis source 0
      const cache = getSavedDistances();

      clubsWithCoords.forEach((c, i) => {
        // i+1 car index 0 = l'utilisateur lui-même
        const durationSec = durations[i + 1];
        const distanceM = distances[i + 1];
        if (durationSec != null && distanceM != null) {
          const km = distanceM / 1000;
          const min = durationSec / 60;
          c._dist = km;
          c._distMin = min;
          c._distLabel = _buildDistLabel(km, min);
          cache[String(c.id)] = { km, min };
        }
      });

      saveDistances(cache);
      console.log(`[OSRM] ${clubsWithCoords.length} clubs mis à jour`);

      // Rafraîchir l'affichage avec les durées
      const $status = $('#clubs-distance-status');
      $status.text(`${clubsWithCoords.length} clubs · trajet voiture calculé ✓`).removeClass('loading').removeClass('error');
      applyFilters(); // re-render avec les nouvelles infos
    } catch (e) {
      console.warn('[OSRM]', e.message || e);
      // OSRM a échoué mais les distances Haversine sont déjà affichées → pas de message d'erreur bloquant
      const $status = $('#clubs-distance-status');
      $status.text($status.text().replace('…', '') + ' (trajet voiture indisponible)');
    }
  }

  // ══════════════════════════════════════════════════
  // 10. POINT D'ENTRÉE — "Valider" adresse
  // ══════════════════════════════════════════════════

  /**
   * Déclenché par le clic sur le bouton "Valider".
   * Séquence complète :
   *   1. Géocode l'adresse utilisateur via GAS proxy (1 requête)
   *   2. Haversine instantané sur coords des clubs (0 requête)
   *   3. OSRM en arrière-plan pour les durées voiture (1 requête)
   */
  async function onValidateAddress() {
    const addr = $('#clubs-distance-input').val().trim();
    if (!addr) {
      _clearDistances(); return;
    }
    if (CS.isGeocoding) return;
    CS.isGeocoding = true;
    const $btn = $('#clubs-distance-validate');
    $btn.prop('disabled', true).text('…');
    _setDistStatus('Géolocalisation de votre adresse…', 'loading');

    // ── Étape 1 : Géocoder l'adresse utilisateur ──
    const coords = await geocodeUserAddress(addr);
    if (!coords) {
      _setDistStatus('Adresse introuvable. Essayez avec la ville ou le code postal.', 'error');
      $btn.prop('disabled', false).text('Valider');
      CS.isGeocoding = false; return;
    }
    CS.userCoords = coords;
    CS.userAddress = addr;
    // Sauvegarder en localStorage
    localStorage.setItem(LS_ADDRESS_KEY, addr);
    localStorage.setItem(LS_COORDS_KEY, JSON.stringify(coords));

    // ── Étape 2 : Haversine (immédiat) ──
    const count = computeHaversineDistances(coords.lat, coords.lon);
    if (!count) {
      _setDistStatus('Aucun club avec coordonnées GPS. Ajoutez les colonnes lat/lon dans le Sheet.', 'error');
      $btn.prop('disabled', false).text('Valider');
      CS.isGeocoding = false; return;
    }
    _setDistStatus(`${count} clubs localisés · calcul trajet voiture…`, 'loading');
    CS.sortBy = 'distance';
    applyFilters(); // afficher distances à vol d'oiseau immédiatement

    $btn.prop('disabled', false).text('Valider');
    CS.isGeocoding = false;

    // ── Étape 3 : OSRM en arrière-plan (non bloquant) ──
    fetchOSRMDurations(coords.lat, coords.lon).catch(e => console.warn('[OSRM bg]', e));
  }

  function _clearDistances() {
    CS.userCoords = null; CS.userAddress = '';
    CS.clubs.forEach(c => { c._dist = null; c._distMin = null; c._distLabel = ''; });
    localStorage.removeItem(LS_ADDRESS_KEY);
    localStorage.removeItem(LS_COORDS_KEY);
    localStorage.removeItem(LS_DISTS_KEY);
    _setDistStatus('', '');
    CS.sortBy = 'name';
    applyFilters();
  }

  function _setDistStatus(msg, cls) {
    const $s = $('#clubs-distance-status');
    if (!$s.length) return;
    $s.text(msg).attr('class', 'clubs-distance-status' + (cls ? ' ' + cls : ''));
  }

  /** Restaure les distances depuis le cache au démarrage */
  function _restoreFromCache() {
    const savedAddr = localStorage.getItem(LS_ADDRESS_KEY) || '';
    const savedCoords = localStorage.getItem(LS_COORDS_KEY);
    if (!savedAddr) return;

    CS.userAddress = savedAddr;
    if (savedCoords) {
      try { CS.userCoords = JSON.parse(savedCoords); } catch (e) { }
    }
    // Appliquer le cache de distances sur les objets clubs
    _applyDistanceCache();
  }

  // ══════════════════════════════════════════════════
  // 11. CHARGEMENT & FILTRAGE
  // ══════════════════════════════════════════════════
  async function loadClubs(force) {
    if (!force && window.state && window.state.clubs && window.state.clubs.length) {
      CS.clubs = window.state.clubs;
      _restoreFromCache();
      applyFilters(); return;
    }
    try {
      const r = await (typeof gasGetAllClubs === 'function' ? gasGetAllClubs() : Promise.reject('no fn'));
      CS.clubs = r.clubs || [];
      if (window.state) window.state.clubs = CS.clubs;
    } catch (e) { console.warn('[clubs]', e); CS.clubs = (window.state && window.state.clubs) || []; }
    _restoreFromCache();
    applyFilters();
  }

  function applyFilters() {
    const favs = getFavorites();
    let clubs = [...CS.clubs];
    // Onglet favoris
    if (CS.activeTab === 'favorites') clubs = clubs.filter(c => favs.has(String(c.id)));
    // Filtre texte
    const q = CS.searchQuery.toLowerCase();
    if (q) clubs = clubs.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.address || '').toLowerCase().includes(q) ||
      parseSports(c.sport).some(s => s.toLowerCase().includes(q)));
    // Filtre sport
    const sp = CS.sportFilter;
    if (sp) clubs = clubs.filter(c => parseSports(c.sport).some(s => s.toLowerCase() === sp.toLowerCase()));
    // Tri
    if (CS.sortBy === 'distance' && CS.userCoords) {
      clubs.sort((a, b) => (a._dist != null ? a._dist : Infinity) - (b._dist != null ? b._dist : Infinity));
    } else {
      clubs.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    }
    CS.filteredClubs = clubs;
    renderList();
  }

  // ══════════════════════════════════════════════════
  // 12. RENDU LISTE
  // ══════════════════════════════════════════════════
  function render() { loadClubs(); }

  function renderList() {
    const $c = $('#clubs-list'); if (!$c.length) return;
    const favs = getFavorites();
    const favCount = favs.size;
    const allSports = getAllSportsFromClubs(CS.clubs);
    const savedAddr = CS.userAddress || localStorage.getItem(LS_ADDRESS_KEY) || '';

    // ── Onglets ──
    const tabs = `<div class="clubs-tabs">
      <button class="clubs-tab ${CS.activeTab === 'all' ? 'active' : ''}" data-tab="all">Tous <span class="clubs-tab-count">${CS.clubs.length}</span></button>
      <button class="clubs-tab ${CS.activeTab === 'favorites' ? 'active' : ''}" data-tab="favorites">♥ Favoris <span class="clubs-tab-count">${favCount}</span></button>
    </div>`;

    // ── Filtres sport ──
    const sportTabs = `<div class="sport-tabs">
      <button class="sport-tab ${!CS.sportFilter ? 'active' : ''}" data-sport="">Tous</button>
      ${allSports.map(s => `<button class="sport-tab ${CS.sportFilter.toLowerCase() === s.toLowerCase() ? 'active' : ''}" data-sport="${s}">${sportEmoji(s)} ${s}</button>`).join('')}
    </div>`;

    // ── Barre adresse ──
    // Bouton "Valider" explicite — pas de debounce automatique
    const distBar = `<div class="clubs-distance-bar">
      <div class="clubs-distance-label">📍 Calculer les distances depuis votre position</div>
      <div class="clubs-distance-row">
        <input type="text" id="clubs-distance-input" class="clubs-distance-input"
          value="${savedAddr.replace(/"/g, '&quot;')}"
          placeholder="ex: 12 rue des Sports, Bordeaux"
          autocomplete="street-address" />
        <button class="clubs-distance-validate" id="clubs-distance-validate">Valider</button>
        ${CS.userCoords ? `<button class="clubs-distance-clear" id="clubs-distance-clear" title="Effacer">✕</button>` : ''}
      </div>
      <div class="clubs-distance-status" id="clubs-distance-status">${CS.userCoords ? `${CS.clubs.filter(c => c._dist != null).length} clubs localisés ✓` : ''}</div>
    </div>`;

    // ── Tri (visible seulement si coords disponibles) ──
    const sortRow = CS.userCoords ? `<div class="clubs-sort-row">
      <button class="clubs-sort-btn ${CS.sortBy === 'name' ? 'active' : ''}" data-sort="name">🔤 Nom</button>
      <button class="clubs-sort-btn ${CS.sortBy === 'distance' ? 'active' : ''}" data-sort="distance">📍 Distance</button>
    </div>`: '';

    if (!CS.filteredClubs.length) {
      $c.html(tabs + sportTabs + distBar + sortRow + `<div class="clubs-empty">
        <div class="clubs-empty-icon">${CS.activeTab === 'favorites' ? '♥' : '🏟️'}</div>
        <p>${CS.activeTab === 'favorites' ? 'Aucun favori enregistré.' : CS.searchQuery || CS.sportFilter ? 'Aucun club trouvé.' : 'Aucun club enregistré.'}</p>
        ${CS.activeTab === 'favorites' ? '<p class="clubs-empty-sub">Cliquez sur ♥ sur une carte pour ajouter un club à vos favoris.</p>' : ''}
      </div>`);
      bindListEvents($c); return;
    }

    const cards = CS.filteredClubs.map(c => {
      const sports = parseSports(c.sport);
      const img = photoUrl(c);
      const instSum = installSummary(c.installations);
      const isFav = favs.has(String(c.id));
      const sportPills = sports.map(s =>
        `<span class="club-sport-pill" style="background:${sportColor(s)}22;border-color:${sportColor(s)}44;color:${sportColor(s)}">${sportEmoji(s)} ${s}</span>`
      ).join('');
      const distBadge = c._distLabel ? `<div class="club-card-dist-badge">
        ${c._distMin ? '🚗' : '📍'} ${c._distLabel}
      </div>`: '';
      return `<div class="club-card" data-club-id="${c.id}">
        <div class="club-card-photo" style="background-image:url('${img}')">
          <div class="club-card-sports-row">${sportPills}</div>
          ${distBadge}
          <button class="club-fav-btn ${isFav ? 'active' : ''}" data-club-id="${c.id}" title="${isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${isFav ? '♥' : '♡'}</button>
        </div>
        <div class="club-card-body">
          <div class="club-card-name">${c.name}${isFav ? ' <span class="club-fav-indicator">♥</span>' : ''}</div>
          ${c.address ? `<div class="club-card-addr">📍 ${c.address}</div>` : ''}
          <div class="club-card-badges">
            ${c.pricing ? `<span class="club-badge">💶 ${c.pricing}</span>` : ''}
            ${instSum ? `<span class="club-badge club-badge--install">${instSum}</span>` : ''}
            ${c._distLabel ? `<span class="club-badge club-badge--dist">${c._distMin ? '🚗' : '📍'} ${c._distLabel}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');

    $c.html(tabs + sportTabs + distBar + sortRow + `<div class="clubs-grid">${cards}</div>`);
    bindListEvents($c);
  }

  function bindListEvents($c) {
    $c.off('click', '.clubs-tab').on('click', '.clubs-tab', function () {
      CS.activeTab = $(this).data('tab'); applyFilters();
    });
    $c.off('click', '.sport-tab').on('click', '.sport-tab', function () {
      CS.sportFilter = $(this).data('sport'); applyFilters();
    });
    $c.off('click', '.clubs-sort-btn').on('click', '.clubs-sort-btn', function () {
      CS.sortBy = $(this).data('sort'); applyFilters();
    });
    // Bouton Valider
    $c.off('click', '#clubs-distance-validate').on('click', '#clubs-distance-validate', function () {
      onValidateAddress();
    });
    // Enter dans l'input
    $c.off('keydown', '#clubs-distance-input').on('keydown', '#clubs-distance-input', function (e) {
      if (e.key === 'Enter') onValidateAddress();
    });
    // Effacer
    $c.off('click', '#clubs-distance-clear').on('click', '#clubs-distance-clear', function () {
      $c.find('#clubs-distance-input').val('');
      _clearDistances();
    });
    // Favori
    $c.off('click', '.club-fav-btn').on('click', '.club-fav-btn', function (e) {
      e.stopPropagation();
      const id = $(this).data('club-id');
      const added = toggleFavorite(id);
      $(this).toggleClass('active', added).text(added ? '♥' : '♡').attr('title', added ? 'Retirer des favoris' : 'Ajouter aux favoris');
      const $card = $(this).closest('.club-card');
      $card.find('.club-card-name .club-fav-indicator').remove();
      if (added) $card.find('.club-card-name').append('<span class="club-fav-indicator">♥</span>');
      if (CS.activeTab === 'favorites' && !added) {
        $card.addClass('club-card--removing'); setTimeout(() => applyFilters(), 350);
      }
      typeof showToast === 'function' && showToast(added ? 'Ajouté aux favoris ♥' : 'Retiré des favoris', '');
    });
    // Clic carte
    $c.off('click', '.club-card').on('click', '.club-card', function () {
      const id = String($(this).data('club-id'));
      const club = CS.clubs.find(c => String(c.id) === id);
      if (club) openDetail(club);
    });
  }

  // ══════════════════════════════════════════════════
  // 13. FICHE DÉTAIL
  // ══════════════════════════════════════════════════
  function openDetail(club) {
    CS.activeClub = club;
    const $overlay = $('#club-detail-overlay');
    const sports = parseSports(club.sport);
    const img = photoUrl(club);
    const localNote = getLocalNote(club.id);
    const installHTML = renderInstallations(club.installations);
    const isFav = isFavorite(club.id);
    const sportPills = sports.map(s =>
      `<span class="detail-sport-pill" style="background:${sportColor(s)}22;border-color:${sportColor(s)}44;color:${sportColor(s)}">${sportEmoji(s)} ${s}</span>`
    ).join('');

    // Label distance enrichi
    const distRow = club._distLabel ? `<div class="club-detail-row">
      ${club._distMin ? '🚗' : '📍'}
      <span>${club._distLabel}${club._distMin ? ` de votre adresse (voiture)` : `de votre adresse (à vol d'oiseau)`}</span>
    </div>`: '';

    $overlay.find('#club-detail-content').html(`
      <div class="club-detail-photo" style="background-image:url('${img}')">
        <div class="club-detail-top-bar">
          <button class="club-detail-close" id="btn-club-close">✕</button>
          <button class="club-detail-fav-btn ${isFav ? 'active' : ''}" id="btn-club-fav" data-club-id="${club.id}" title="${isFav ? 'Retirer' : 'Ajouter aux favoris'}">${isFav ? '♥' : '♡'}</button>
        </div>
        <div class="club-detail-sports">${sportPills}</div>
        ${club._distLabel ? `<div class="club-detail-dist">${club._distMin ? '🚗' : '📍'} ${club._distLabel}</div>` : ''}
      </div>
      <div class="club-detail-body">
        <div class="club-detail-name-row">
          <h2 class="club-detail-name">${club.name}</h2>
          ${isFav ? '<span class="club-fav-indicator club-fav-indicator--lg">♥</span>' : ''}
        </div>
        ${club.address ? `<div class="club-detail-row">📍 <span>${club.address}</span></div>` : ''}
        ${distRow}
        ${club.phone ? `<div class="club-detail-row">📞 <span><a href="tel:${club.phone}" style="color:var(--accent)">${club.phone}</a></span></div>` : ''}
        ${club.hours ? `<div class="club-detail-row">🕐 <div class="hours-grid">${formatHours(club.hours)}</div></div>` : ''}
        ${club.pricing ? `<div class="club-detail-row">💶 <span>${club.pricing}</span></div>` : ''}
        ${club.maxPlayers ? `<div class="club-detail-row">👥 <span>Max ${club.maxPlayers} joueurs</span></div>` : ''}
        ${installHTML}
        ${club.notes ? `<div class="club-detail-notes">${club.notes}</div>` : ''}
        <div class="local-notes-section">
          <div class="local-notes-header">
            <span class="local-notes-title">📝 Mes notes personnelles</span>
            <span class="local-notes-hint">Sauvegardé sur cet appareil uniquement</span>
          </div>
          <textarea class="local-notes-textarea" id="local-notes-input"
            placeholder="Stationnement, contact, préférences…" rows="3">${localNote}</textarea>
        </div>
        <div class="club-detail-actions">
          ${club.mapsUrl ? `<a href="${club.mapsUrl}" target="_blank" class="btn btn-outline btn-sm">📍 Google Maps</a>` : ''}
          ${club.url ? `<a href="${club.url}" target="_blank" class="btn btn-outline btn-sm">🌐 Site du club</a>` : ''}
          ${club.bookingUrl ? `<a href="${club.bookingUrl}" target="_blank" class="btn btn-outline btn-sm">🔗 Réserver</a>` : ''}
          <button class="btn btn-primary" id="btn-club-organize">🏅 Organiser un match ici</button>
        </div>
      </div>`);
    $overlay.removeClass('hidden');

    // Favori
    $overlay.find('#btn-club-fav').off('click').on('click', function () {
      const id = $(this).data('club-id'), added = toggleFavorite(id);
      $(this).toggleClass('active', added).text(added ? '♥' : '♡');
      $overlay.find('.club-fav-indicator--lg').remove();
      if (added) $overlay.find('.club-detail-name-row').append('<span class="club-fav-indicator club-fav-indicator--lg">♥</span>');
      typeof showToast === 'function' && showToast(added ? 'Ajouté aux favoris ♥' : 'Retiré des favoris', '');
      // Sync carte dans la liste
      const $card = $(`.club-card[data-club-id="${id}"]`);
      if ($card.length) {
        $card.find('.club-fav-btn').toggleClass('active', added).text(added ? '♥' : '♡');
        $card.find('.club-card-name .club-fav-indicator').remove();
        if (added) $card.find('.club-card-name').append('<span class="club-fav-indicator">♥</span>');
      }
    });

    // Auto-save notes
    let noteTimer = null;
    $overlay.find('#local-notes-input').off('input').on('input', function () {
      clearTimeout(noteTimer); const val = $(this).val();
      noteTimer = setTimeout(() => { saveLocalNote(club.id, val); _showNoteSaved($overlay); }, 600);
    });
  }

  function _showNoteSaved($overlay) {
    let $b = $overlay.find('.note-saved-badge');
    if (!$b.length) { $b = $('<span class="note-saved-badge">✓ Sauvegardé</span>'); $overlay.find('.local-notes-header').append($b); }
    $b.addClass('visible'); setTimeout(() => $b.removeClass('visible'), 1800);
  }

  // ══════════════════════════════════════════════════
  // 14. UTILITAIRES
  // ══════════════════════════════════════════════════
  function formatHours(raw) {
    if (!raw) return '';
    try {
      const h = typeof raw === 'string' && raw.trim().startsWith('{') ? JSON.parse(raw) : null;
      if (!h) return `<span>${raw}</span>`;
      const days = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
      const fr = ['Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.', 'Dim.'];
      return days.map((d, i) => {
        const v = h[d] || h[fr[i]] || h[fr[i].toLowerCase()] || '';
        return v ? `<span class="hours-row"><span class="hours-day">${fr[i]}</span><span class="hours-val">${v}</span></span>` : '';
      }).filter(Boolean).join('');
    } catch (e) { return `<span>${raw}</span>`; }
  }

  // ══════════════════════════════════════════════════
  // 15. ACTIONS
  // ══════════════════════════════════════════════════
  function openById(id) {
    if (!CS.clubs.length) {
      loadClubs().then(() => { const c = CS.clubs.find(c => String(c.id) === String(id)); if (c) openDetail(c); }); return;
    }
    const club = CS.clubs.find(c => String(c.id) === String(id));
    if (club) openDetail(club);
    else typeof showToast === 'function' && showToast('Club introuvable', 'error');
  }

  function closeDetail() { $('#club-detail-overlay').addClass('hidden'); CS.activeClub = null; }

  function bindEvents() {
    $(document).on('input', '#clubs-search', function () { CS.searchQuery = $(this).val().trim(); applyFilters(); });
    $(document).on('click', '#btn-club-close', closeDetail);
    $(document).on('click', '#club-detail-overlay', function (e) { if (e.target === this) closeDetail(); });
    $(document).on('click', '#btn-club-organize', function () {
      if (!CS.activeClub) return;
      const c = CS.activeClub; closeDetail();
      if (typeof showView === 'function') showView('session');
      if (typeof goToStep === 'function') goToStep(3);
      const sports = parseSports(c.sport);
      setTimeout(function () {
        $('#session-venue').val(c.name || ''); $('#session-address').val(c.address || '');
        if (sports.length) $('#session-sport').val(sports[0]);
        if (c.mapsUrl) $('#session-maps-url').val(c.mapsUrl);
        if (c.url) $('#session-booking-url').val(c.url);
        if (c.maxPlayers) $('#session-max-players').val(c.maxPlayers);
        $('#session-club-id-hidden').val(c.id || '');
        if (typeof renderSession === 'function') renderSession(true);
        typeof showToast === 'function' && showToast(`Lieu pré-rempli : ${c.name}`, 'success');
      }, 300);
    });
  }

  function init() { bindEvents(); loadClubs(); }

  window.SportSyncClubs = { init, render, loadClubs, openById };
  $(document).ready(function () {
    setTimeout(function () { if ($('#view-clubs').length) init(); }, 400);
  });

}(jQuery));
