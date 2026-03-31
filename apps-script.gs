/**
 * ═══════════════════════════════════════════════════════════════
 * SPORTSYNC — apps-script.gs  v3
 * ═══════════════════════════════════════════════════════════════
 *
 * INSTALLATION
 *   1. Extensions → Apps Script → coller ce fichier
 *   2. Déployer → Nouveau déploiement
 *        Type              : Application Web
 *        Exécuter en tant que : Moi
 *        Accès             : Tout le monde (anonyme)
 *   3. Copier l'URL /exec → CONFIG.GAS_URL dans app.js
 *
 * STRUCTURE DES ONGLETS (créés automatiquement)
 *   Meta    : lastTimestamp | value
 *   Dispos  : id | name | date | slot | state | sessionId | updatedAt
 *   Slots   : id | date | start | end | venue | price | votes | sessionId
 *   Players : id | name | status | sessionId
 *   Session : sessionId | date | venue | address | mapsUrl | bookingUrl
 *             | price | notes | maxPlayers | updatedAt
 *   Clubs   : id | name | address | mapsUrl | bookingUrl | notes
 *             (onglet externe en lecture seule, peut être sur un autre Sheet)
 * ═══════════════════════════════════════════════════════════════
 */

var SHEETS = {
  META:    'Meta',
  DISPOS:  'Dispos',
  SLOTS:   'Slots',
  PLAYERS: 'Players',
  SESSION: 'Session',
  CLUBS:   'Clubs',   // Optionnel : base des clubs
};

// ─────────────────────────────────────────────────────────────
// SCHÉMAS — source de vérité pour les en-têtes
// ─────────────────────────────────────────────────────────────
var SCHEMAS = {
  Meta:    ['lastTimestamp', 'value'],
  Dispos:  ['id', 'name', 'date', 'slot', 'state', 'sessionId', 'updatedAt'],
  Slots:   ['id', 'date', 'start', 'end', 'venue', 'price', 'votes', 'sessionId'],
  Players: ['id', 'name', 'status', 'sessionId'],
  Session: ['sessionId', 'date', 'venue', 'address', 'mapsUrl', 'bookingUrl',
            'price', 'notes', 'maxPlayers', 'updatedAt'],
  Clubs:   ['id', 'name', 'address', 'mapsUrl', 'bookingUrl', 'notes'],
};

// ─────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    initSheets();
    var action    = (e.parameter && e.parameter.action)    || 'getData';
    var sessionId = (e.parameter && e.parameter.sessionId) || 'recurring';
    var query     = (e.parameter && e.parameter.q)         || '';

    var result;
    if      (action === 'getData')     result = getAllData(sessionId);
    else if (action === 'searchClubs') result = searchClubs(query);
    else                               result = { error: 'Action GET inconnue : ' + action };

    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err.message, stack: err.stack });
  }
}

// ─────────────────────────────────────────────────────────────
// POST
// ─────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    initSheets();
    var body      = JSON.parse(e.postData.contents);
    var action    = body.action    || '';
    var sessionId = body.sessionId || 'recurring';

    var result;
    switch (action) {
      case 'setDispoCell':  result = setDispoCell(body, sessionId);            break;
      case 'addSlot':       result = addSlot(body, sessionId);                 break;
      case 'voteSlot':      result = voteSlot(body.id, body.delta, sessionId); break;
      case 'addPlayer':     result = addPlayer(body, sessionId);               break;
      case 'removePlayer':  result = deleteRow(SHEETS.PLAYERS, body.id);       break;
      case 'promotePlayer': result = promotePlayer(body.id);                   break;
      case 'saveSession':         result = saveSession(body, sessionId);       break;
      case 'deduplicateDispos':   result = deduplicateDispos();                   break;
      default:                    result = { error: 'Action inconnue : ' + action };
    }
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err.message, stack: err.stack });
  }
}

// ─────────────────────────────────────────────────────────────
// LECTURE GLOBALE
// ─────────────────────────────────────────────────────────────

function getAllData(sessionId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    timestamp : getTimestamp(ss),
    dispos    : readDispos(ss, sessionId),
    slots     : readSlots(ss, sessionId),
    players   : readPlayers(ss, sessionId),
    session   : readSession(ss, sessionId),
  };
}

/**
 * Lit l'onglet Dispos (v2 : slot + state).
 * Convertit les valeurs de type Date en string YYYY-MM-DD.
 */
function readDispos(ss, sessionId) {
  var sheet = ss.getSheetByName(SHEETS.DISPOS);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  var h      = data[0];
  var idIdx  = h.indexOf('id');
  var nmIdx  = h.indexOf('name');
  var dtIdx  = h.indexOf('date');
  var slIdx  = h.indexOf('slot');
  var stIdx  = h.indexOf('state');
  var sidIdx = h.indexOf('sessionId');

  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[idIdx]) continue;
    // Filtre sessionId
    if (sidIdx >= 0 && sessionId !== 'recurring' && String(r[sidIdx]) !== sessionId) continue;
    rows.push({
      id:        String(r[idIdx]),
      name:      String(r[nmIdx]  || ''),
      date:      formatDateValue(r[dtIdx]),
      slot:      String(r[slIdx]  || ''),
      state:     String(r[stIdx]  || ''),
      sessionId: String(r[sidIdx] || ''),
    });
  }
  return rows;
}

/**
 * Lit l'onglet Slots.
 * Convertit les dates et les heures (Google Sheets stocke parfois l'heure comme Date).
 */
function readSlots(ss, sessionId) {
  var sheet = ss.getSheetByName(SHEETS.SLOTS);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  var h      = data[0];
  var idIdx  = h.indexOf('id');
  var dtIdx  = h.indexOf('date');
  var stIdx  = h.indexOf('start');
  var enIdx  = h.indexOf('end');
  var vnIdx  = h.indexOf('venue');
  var prIdx  = h.indexOf('price');
  var vtIdx  = h.indexOf('votes');
  var sidIdx = h.indexOf('sessionId');

  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[idIdx]) continue;
    if (sidIdx >= 0 && sessionId !== 'recurring' && String(r[sidIdx]) !== sessionId) continue;
    rows.push({
      id:        String(r[idIdx]),
      date:      formatDateValue(r[dtIdx]),
      start:     formatTimeValue(r[stIdx]),
      end:       formatTimeValue(r[enIdx]),
      venue:     String(r[vnIdx]  || ''),
      price:     String(r[prIdx]  || ''),
      votes:     Number(r[vtIdx]) || 0,
      sessionId: String(r[sidIdx] || ''),
    });
  }
  return rows;
}

/**
 * Lit l'onglet Players.
 */
function readPlayers(ss, sessionId) {
  var sheet = ss.getSheetByName(SHEETS.PLAYERS);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  var h      = data[0];
  var idIdx  = h.indexOf('id');
  var nmIdx  = h.indexOf('name');
  var stIdx  = h.indexOf('status');
  var sidIdx = h.indexOf('sessionId');

  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[idIdx]) continue;
    if (sidIdx >= 0 && sessionId !== 'recurring' && String(r[sidIdx]) !== sessionId) continue;
    rows.push({
      id:        String(r[idIdx]),
      name:      String(r[nmIdx]  || ''),
      status:    String(r[stIdx]  || 'player'),
      sessionId: String(r[sidIdx] || ''),
    });
  }
  return rows;
}

/**
 * Lit les infos de session (onglet Session, colonnes v3 étendues).
 */
function readSession(ss, sessionId) {
  var sheet = ss.getSheetByName(SHEETS.SESSION);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return null;

  var h      = data[0];
  var sidIdx = h.indexOf('sessionId');

  for (var i = 1; i < data.length; i++) {
    var r   = data[i];
    var sid = sidIdx >= 0 ? String(r[sidIdx]) : '';
    if (sessionId === 'recurring' || sid === sessionId) {
      return {
        date:       formatDateTimeValue(r[h.indexOf('date')]),
        venue:      String(r[h.indexOf('venue')]      || ''),
        address:    String(r[h.indexOf('address')]    || ''),
        mapsUrl:    String(r[h.indexOf('mapsUrl')]    || ''),
        bookingUrl: String(r[h.indexOf('bookingUrl')] || ''),
        price:      String(r[h.indexOf('price')]      || ''),
        notes:      String(r[h.indexOf('notes')]      || ''),
        maxPlayers: Number(r[h.indexOf('maxPlayers')]) || 10,
      };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// RECHERCHE CLUBS
// ─────────────────────────────────────────────────────────────

/**
 * Recherche dans l'onglet Clubs par nom (recherche insensible à la casse).
 * @param {string} query
 */
function searchClubs(query) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.CLUBS);
  if (!sheet || !query) return { clubs: [] };

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { clubs: [] };

  var h      = data[0];
  var idIdx  = h.indexOf('id');
  var nmIdx  = h.indexOf('name');
  var adIdx  = h.indexOf('address');
  var mpIdx  = h.indexOf('mapsUrl');
  var bkIdx  = h.indexOf('bookingUrl');
  var ntIdx  = h.indexOf('notes');

  var q    = query.toLowerCase();
  var clubs = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    var name = String(r[nmIdx] || '');
    if (name.toLowerCase().indexOf(q) >= 0) {
      clubs.push({
        id:         String(r[idIdx]  || ''),
        name:       name,
        address:    String(r[adIdx]  || ''),
        mapsUrl:    String(r[mpIdx]  || ''),
        bookingUrl: String(r[bkIdx]  || ''),
        notes:      String(r[ntIdx]  || ''),
      });
    }
  }
  return { clubs: clubs };
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — DISPONIBILITÉS (grille créneaux)
// ─────────────────────────────────────────────────────────────

/**
 * Upsert d'une cellule avec :
 *   1. Lock Service       — sérialise les écritures concurrentes côté Sheets
 *   2. Dédoublonnage      — supprime les doublons éventuels (clé composite identique)
 *   3. Upsert par clé     — met à jour la ligne si elle existe, en crée une sinon
 *
 * Clé composite (côté GAS) : name + date + slot + sessionId
 */
function setDispoCell(body, sessionId) {

  // ── 1. Lock : une seule exécution à la fois sur cet onglet ──
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(8000); // attend jusqu'à 8s avant de lancer une erreur
  } catch(e) {
    return { ok: false, error: 'Lock timeout — réessayez' };
  }

  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.DISPOS);
    var data  = sheet.getDataRange().getValues();
    var h     = data[0];

    var idIdx  = h.indexOf('id');
    var nmIdx  = h.indexOf('name');
    var dtIdx  = h.indexOf('date');
    var slIdx  = h.indexOf('slot');
    var stIdx  = h.indexOf('state');
    var sidIdx = h.indexOf('sessionId');
    var updIdx = h.indexOf('updatedAt');

    // Migration auto si colonnes manquantes
    if (slIdx === -1 || stIdx === -1) {
      var newH = SCHEMAS.Dispos;
      sheet.getRange(1, 1, 1, newH.length).setValues([newH]);
      idIdx=0; nmIdx=1; dtIdx=2; slIdx=3; stIdx=4; sidIdx=5; updIdx=6;
      data = sheet.getDataRange().getValues();
      h    = data[0];
    }

    var name     = String(body.name  || 'Anonyme');
    var date     = String(body.date  || '');
    var slot     = String(body.slot  || '');
    var newState = String(body.state || '');
    var now      = new Date().toISOString();

    // ── 2. Trouver TOUTES les lignes correspondant à la clé composite ──
    //    (il peut y en avoir plusieurs en cas de doublons antérieurs)
    var matchingRows = [];
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      if (String(r[nmIdx]) === name &&
          String(r[dtIdx]) === date &&
          String(r[slIdx]) === slot &&
          String(r[sidIdx]) === sessionId) {
        matchingRows.push(i); // index 1-based dans data[]
      }
    }

    if (matchingRows.length > 0) {
      // ── 3a. Il y a au moins une ligne correspondante ──

      if (newState === '') {
        // Supprimer toutes les lignes correspondantes (en partant du bas pour ne pas décaler)
        for (var k = matchingRows.length - 1; k >= 0; k--) {
          sheet.deleteRow(matchingRows[k] + 1); // +1 car sheet est 1-indexed
        }
      } else {
        // Garder la première ligne, supprimer les doublons, mettre à jour l'état
        // Suppression des doublons (toutes les lignes sauf la première)
        for (var k = matchingRows.length - 1; k >= 1; k--) {
          sheet.deleteRow(matchingRows[k] + 1);
        }
        // Mise à jour de la première ligne
        var targetSheetRow = matchingRows[0] + 1;
        sheet.getRange(targetSheetRow, stIdx+1).setValue(newState);
        if (updIdx >= 0) sheet.getRange(targetSheetRow, updIdx+1).setValue(now);
      }

    } else if (newState !== '') {
      // ── 3b. Aucune ligne existante → créer ──
      var id = generateId();
      sheet.appendRow([id, name, date, slot, newState, sessionId, now]);
    }

    bumpTimestamp();
    return { ok: true, timestamp: getTimestamp() };

  } finally {
    // Toujours libérer le lock, même en cas d'erreur
    lock.releaseLock();
  }
}

/**
 * Nettoie les doublons dans l'onglet Dispos.
 * À appeler manuellement depuis l'éditeur Apps Script si nécessaire.
 * Peut aussi être déclenché via un POST { action: 'deduplicateDispos' }.
 */
function deduplicateDispos() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.DISPOS);
  var data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return { ok: true, removed: 0 };

  var h      = data[0];
  var nmIdx  = h.indexOf('name');
  var dtIdx  = h.indexOf('date');
  var slIdx  = h.indexOf('slot');
  var sidIdx = h.indexOf('sessionId');
  var updIdx = h.indexOf('updatedAt');

  // Construire un dictionnaire clé composite → ligne la plus récente
  var best    = {};  // ck → { rowIdx (0-based dans data), updatedAt }
  var toDelete = []; // row indices 0-based dans data[]

  for (var i = 1; i < data.length; i++) {
    var r  = data[i];
    var ck = String(r[sidIdx]) + '::'
           + String(r[nmIdx])  + '::'
           + String(r[dtIdx])  + '::'
           + String(r[slIdx]);

    var upd = updIdx >= 0 ? String(r[updIdx]) : '';

    if (!best[ck]) {
      best[ck] = { rowIdx: i, updatedAt: upd };
    } else {
      // Garder la plus récente, marquer l'autre pour suppression
      if (upd > best[ck].updatedAt) {
        toDelete.push(best[ck].rowIdx);
        best[ck] = { rowIdx: i, updatedAt: upd };
      } else {
        toDelete.push(i);
      }
    }
  }

  // Supprimer en partant du bas pour ne pas décaler les index
  toDelete.sort(function(a,b) { return b-a; });
  for (var j = 0; j < toDelete.length; j++) {
    sheet.deleteRow(toDelete[j] + 1); // +1 car sheet est 1-indexed
  }

  bumpTimestamp();
  return { ok: true, removed: toDelete.length };
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — CRÉNEAUX
// ─────────────────────────────────────────────────────────────

function addSlot(body, sessionId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SLOTS);
  var id    = generateId();
  sheet.appendRow([id, body.date, body.start, body.end, body.venue, body.price, 0, sessionId]);
  bumpTimestamp();
  return { ok: true, id: String(id), timestamp: getTimestamp() };
}

function voteSlot(id, delta, sessionId) {
  var sheet  = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SLOTS);
  var data   = sheet.getDataRange().getValues();
  var h      = data[0];
  var idIdx  = h.indexOf('id');
  var vtIdx  = h.indexOf('votes');

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === String(id)) {
      var cur = Number(data[i][vtIdx]) || 0;
      sheet.getRange(i+1, vtIdx+1).setValue(Math.max(0, cur + delta));
      bumpTimestamp();
      return { ok: true, votes: cur+delta, timestamp: getTimestamp() };
    }
  }
  return { ok: false, error: 'Créneau introuvable : ' + id };
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — JOUEURS
// ─────────────────────────────────────────────────────────────

function addPlayer(body, sessionId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PLAYERS);
  var id    = generateId();
  sheet.appendRow([id, body.name, body.status, sessionId]);
  bumpTimestamp();
  return { ok: true, id: String(id), timestamp: getTimestamp() };
}

function promotePlayer(id) {
  var sheet  = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PLAYERS);
  var data   = sheet.getDataRange().getValues();
  var h      = data[0];
  var idIdx  = h.indexOf('id');
  var stIdx  = h.indexOf('status');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === String(id)) {
      sheet.getRange(i+1, stIdx+1).setValue('player');
      bumpTimestamp();
      return { ok: true };
    }
  }
  return { ok: false, error: 'Joueur introuvable : ' + id };
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — SESSION (v3 : champs étendus + maxPlayers)
// ─────────────────────────────────────────────────────────────

function saveSession(body, sessionId) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.SESSION);
  var data  = sheet.getDataRange().getValues();
  var h     = data[0];
  var sidIdx = h.indexOf('sessionId');
  var now    = new Date().toISOString();

  var row = [
    sessionId,
    body.date       || '',
    body.venue      || '',
    body.address    || '',
    body.mapsUrl    || '',
    body.bookingUrl || '',
    body.price      || '',
    body.notes      || '',
    Number(body.maxPlayers) || 10,
    now,
  ];

  for (var i = 1; i < data.length; i++) {
    var sid = sidIdx >= 0 ? String(data[i][sidIdx]) : '';
    if (sid === sessionId || (sessionId === 'recurring' && !sid)) {
      sheet.getRange(i+1, 1, 1, row.length).setValues([row]);
      bumpTimestamp();
      return { ok: true, timestamp: getTimestamp() };
    }
  }
  sheet.appendRow(row);
  bumpTimestamp();
  return { ok: true, timestamp: getTimestamp() };
}

// ─────────────────────────────────────────────────────────────
// SUPPRESSION
// ─────────────────────────────────────────────────────────────

function deleteRow(sheetName, id) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  var data  = sheet.getDataRange().getValues();
  var h     = data[0];
  var idIdx = h.indexOf('id');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === String(id)) {
      sheet.deleteRow(i+1);
      bumpTimestamp();
      return { ok: true, timestamp: getTimestamp() };
    }
  }
  return { ok: false, error: 'Ligne introuvable id=' + id + ' dans ' + sheetName };
}

// ─────────────────────────────────────────────────────────────
// TIMESTAMP
// ─────────────────────────────────────────────────────────────

function getTimestamp(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var meta = ss.getSheetByName(SHEETS.META);
  if (!meta) return 0;
  var val = meta.getRange('B1').getValue();
  return val ? Number(val) : 0;
}

function bumpTimestamp() {
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var meta = ss.getSheetByName(SHEETS.META) || ss.insertSheet(SHEETS.META);
  meta.getRange('A1').setValue('lastTimestamp');
  meta.getRange('B1').setValue(Date.now());
}

// ─────────────────────────────────────────────────────────────
// INITIALISATION DES ONGLETS
// ─────────────────────────────────────────────────────────────

function initSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SCHEMAS).forEach(function(name) {
    if (name === SHEETS.CLUBS) return; // Clubs géré manuellement
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(SCHEMAS[name]);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, SCHEMAS[name].length)
           .setBackground('#1e1e2e').setFontColor('#a6e3a1').setFontWeight('bold');
    } else {
      // Migration : ajouter les colonnes manquantes à droite
      var existingH = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      SCHEMAS[name].forEach(function(col, idx) {
        if (existingH.indexOf(col) === -1) {
          var newCol = existingH.length + 1;
          sheet.getRange(1, newCol).setValue(col)
               .setBackground('#1e1e2e').setFontColor('#a6e3a1').setFontWeight('bold');
          existingH.push(col);
        }
      });
    }
  });

  var meta = ss.getSheetByName(SHEETS.META);
  if (!meta.getRange('B1').getValue()) {
    meta.getRange('A1').setValue('lastTimestamp');
    meta.getRange('B1').setValue(Date.now());
  }
}

// ─────────────────────────────────────────────────────────────
// UTILITAIRES — Conversion de dates
// ─────────────────────────────────────────────────────────────

/**
 * Convertit n'importe quelle valeur de cellule de date en string 'YYYY-MM-DD'.
 * Google Sheets peut retourner un objet Date, un nombre sériel, ou une string.
 */
function formatDateValue(val) {
  if (!val) return '';
  if (val instanceof Date) {
    var y = val.getFullYear();
    var m = String(val.getMonth()+1).padStart(2,'0');
    var d = String(val.getDate()).padStart(2,'0');
    return y + '-' + m + '-' + d;
  }
  if (typeof val === 'number') {
    // Nombre sériel Excel → Date
    var d2 = new Date(Math.round((val - 25569) * 86400 * 1000));
    return formatDateValue(d2);
  }
  // String : normaliser en YYYY-MM-DD
  var s = String(val).trim();
  // Format DD/MM/YYYY ou DD-MM-YYYY
  var m2 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m2) return m2[3]+'-'+m2[2].padStart(2,'0')+'-'+m2[1].padStart(2,'0');
  return s;
}

/**
 * Convertit une valeur de cellule d'heure en 'HH:MM'.
 * Google Sheets stocke parfois les heures comme fractions décimales (0.833... = 20:00).
 */
function formatTimeValue(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return String(val.getHours()).padStart(2,'0') + ':' + String(val.getMinutes()).padStart(2,'0');
  }
  if (typeof val === 'number' && val < 1) {
    // Fraction décimale : 0.8333... = 20h
    var totalMin = Math.round(val * 24 * 60);
    var h  = Math.floor(totalMin / 60);
    var mn = totalMin % 60;
    return String(h).padStart(2,'0') + ':' + String(mn).padStart(2,'0');
  }
  return String(val).trim();
}

/**
 * Convertit une valeur datetime en 'YYYY-MM-DDTHH:MM' (format datetime-local HTML).
 */
function formatDateTimeValue(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return formatDateValue(val) + 'T' +
      String(val.getHours()).padStart(2,'0') + ':' + String(val.getMinutes()).padStart(2,'0');
  }
  var s = String(val).trim();
  if (s.match(/^\d{4}-\d{2}-\d{2}$/)) return s; // déjà YYYY-MM-DD, pas d'heure
  return formatDateValue(val); // fallback
}

/**
 * Génère un ID unique (timestamp + random).
 */
function generateId() {
  return String(Date.now()) + String(Math.floor(Math.random()*1000));
}

/**
 * Réponse JSON via ContentService (CORS géré automatiquement).
 */
function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
                       .setMimeType(ContentService.MimeType.JSON);
}
