/**
 * ═══════════════════════════════════════════════════════════════
 * SPORTSYNC — apps-script.gs  v4
 * ═══════════════════════════════════════════════════════════════
 *
 * INSTALLATION
 *   1. Extensions → Apps Script → remplacer par ce fichier
 *   2. Déployer → Nouveau déploiement
 *        Type              : Application Web
 *        Exécuter en tant que : Moi
 *        Accès             : Tout le monde (anonyme)
 *   3. Copier l'URL /exec → CONFIG.GAS_URL dans app.js
 *
 * STRUCTURE DES ONGLETS (créés / migrés automatiquement)
 *   Meta    : lastTimestamp | value
 *   Dispos  : id | name | date | slot | state | sessionId | updatedAt
 *   Slots   : id | date | start | end | venue | price | votes | sessionId
 *   Players : id | name | status | sessionId
 *   Session : sessionId | date | venue | address | mapsUrl | bookingUrl
 *             | price | notes | maxPlayers | updatedAt
 *   Sessions: id | sessionId | sport | status | createdAt | ownerEmail
 *             (index global de toutes les sessions, pour le dashboard)
 *   Clubs   : id | name | sport | address | photoUrl | hours | pricing | courts | notes
 *   UserSessions : email | sessionId | joinedAt
 *             (lien user ↔ sessions, pour récupérer les matchs par email)
 * ═══════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────

var SHEETS = {
  META:         'Meta',
  DISPOS:       'Dispos',
  SLOTS:        'Slots',
  PLAYERS:      'Players',
  SESSION:      'Session',
  SESSIONS:     'Sessions',
  CLUBS:        'Clubs',
  USER_SESSIONS: 'UserSessions',
};

var SCHEMAS = {
  Meta:    ['lastTimestamp', 'value'],
  Dispos:  ['id', 'name', 'date', 'slot', 'state', 'sessionId', 'updatedAt'],
  Slots:   ['id', 'date', 'start', 'end', 'venue', 'price', 'votes', 'sessionId'],
  Players: ['id', 'name', 'status', 'sessionId'],
  Session: ['sessionId', 'date', 'venue', 'address', 'mapsUrl', 'bookingUrl',
            'price', 'notes', 'maxPlayers', 'sport', 'updatedAt'],
  Sessions:['id', 'sessionId', 'sport', 'status', 'venue', 'date', 'maxPlayers',
            'createdAt', 'ownerEmail'],
  Clubs:   ['id', 'name', 'sport', 'address', 'photoUrl', 'hours',
            'pricing', 'courts', 'notes'],
  UserSessions: ['email', 'sessionId', 'joinedAt'],
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
    var email     = (e.parameter && e.parameter.email)     || '';

    var result;
    switch (action) {
      case 'getData':        result = getAllData(sessionId);    break;
      case 'getAllClubs':    result = getAllClubs();            break;
      case 'searchClubs':   result = searchClubs(query);      break;
      case 'getMyMatches':  result = getMatchesByEmail(email); break;
      case 'getAllSessions': result = getAllSessions();         break;
      default: result = { error: 'Action GET inconnue : ' + action };
    }
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
      case 'setDispoCell':       result = setDispoCell(body, sessionId);            break;
      case 'batchSetDispos':    result = batchSetDispos(body, sessionId);         break;
      case 'addSlot':            result = addSlot(body, sessionId);                 break;
      case 'voteSlot':           result = voteSlot(body.id, body.delta, sessionId); break;
      case 'addPlayer':          result = addPlayer(body, sessionId);               break;
      case 'removePlayer':       result = deleteRow(SHEETS.PLAYERS, body.id);       break;
      case 'promotePlayer':      result = promotePlayer(body.id);                   break;
      case 'saveSession':        result = saveSession(body, sessionId);             break;
      case 'createSession':      result = createSession(body);                      break;
      case 'linkUserToSession':  result = linkUserToSession(body.email, body.sessionId); break;
      case 'deduplicateDispos':  result = deduplicateDispos();                      break;
      default: result = { error: 'Action inconnue : ' + action };
    }
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err.message, stack: err.stack });
  }
}

// ─────────────────────────────────────────────────────────────
// LECTURE — getAllData (session courante)
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

// ─────────────────────────────────────────────────────────────
// LECTURE — Dispos
// Colonnes v4 : id | name | date | slot | state | sessionId | updatedAt
// ─────────────────────────────────────────────────────────────

function readDispos(ss, sessionId) {
  var sheet = ss.getSheetByName(SHEETS.DISPOS);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  var h      = data[0].map(String);
  var idIdx  = h.indexOf('id');
  var nmIdx  = h.indexOf('name');
  var dtIdx  = h.indexOf('date');
  var slIdx  = h.indexOf('slot');
  var stIdx  = h.indexOf('state');
  var sidIdx = h.indexOf('sessionId');
  var updIdx = h.indexOf('updatedAt');

  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[idIdx] && r[idIdx] !== 0) continue;
    if (sidIdx >= 0 && sessionId !== 'recurring' && String(r[sidIdx]) !== sessionId) continue;
    rows.push({
      id:        String(r[idIdx]),
      name:      String(r[nmIdx]  || ''),
      date:      formatDateValue(r[dtIdx]),   // → YYYY-MM-DD garanti
      slot:      String(r[slIdx]  || ''),
      state:     String(r[stIdx]  || ''),
      sessionId: String(r[sidIdx] || ''),
      updatedAt: String(r[updIdx] || ''),
    });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────
// LECTURE — Slots
// ─────────────────────────────────────────────────────────────

function readSlots(ss, sessionId) {
  var sheet = ss.getSheetByName(SHEETS.SLOTS);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  var h      = data[0].map(String);
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
    if (!r[idIdx] && r[idIdx] !== 0) continue;
    if (sidIdx >= 0 && sessionId !== 'recurring' && String(r[sidIdx]) !== sessionId) continue;
    rows.push({
      id:        String(r[idIdx]),
      date:      formatDateValue(r[dtIdx]),   // → YYYY-MM-DD
      start:     formatTimeValue(r[stIdx]),   // → HH:MM
      end:       formatTimeValue(r[enIdx]),
      venue:     String(r[vnIdx]  || ''),
      price:     String(r[prIdx]  || ''),
      votes:     Number(r[vtIdx]) || 0,
      sessionId: String(r[sidIdx] || ''),
    });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────
// LECTURE — Players
// ─────────────────────────────────────────────────────────────

function readPlayers(ss, sessionId) {
  var sheet = ss.getSheetByName(SHEETS.PLAYERS);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  var h      = data[0].map(String);
  var idIdx  = h.indexOf('id');
  var nmIdx  = h.indexOf('name');
  var stIdx  = h.indexOf('status');
  var sidIdx = h.indexOf('sessionId');

  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[idIdx] && r[idIdx] !== 0) continue;
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

// ─────────────────────────────────────────────────────────────
// LECTURE — Session (onglet Session = détails d'une session)
// Colonnes v4 : sessionId | date | venue | address | mapsUrl | bookingUrl
//               | price | notes | maxPlayers | sport | updatedAt
// ─────────────────────────────────────────────────────────────

function readSession(ss, sessionId) {
  var sheet = ss.getSheetByName(SHEETS.SESSION);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return null;

  var h      = data[0].map(String);
  var sidIdx = h.indexOf('sessionId');

  for (var i = 1; i < data.length; i++) {
    var r   = data[i];
    var sid = sidIdx >= 0 ? String(r[sidIdx]) : '';
    if (sessionId === 'recurring' || sid === sessionId) {
      var get = function(col) {
        var idx = h.indexOf(col);
        return idx >= 0 ? r[idx] : '';
      };
      return {
        date:       formatDateTimeValue(get('date')), // → YYYY-MM-DDTHH:MM
        venue:      String(get('venue')      || ''),
        address:    String(get('address')    || ''),
        mapsUrl:    String(get('mapsUrl')    || ''),
        bookingUrl: String(get('bookingUrl') || ''),
        price:      String(get('price')      || ''),
        notes:      String(get('notes')      || ''),
        maxPlayers: Number(get('maxPlayers')) || 10,
        sport:      String(get('sport')      || ''),
      };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// LECTURE — Tous les clubs (annuaire)
// Colonnes : id | name | sport | address | photoUrl | hours | pricing | courts | notes
// ─────────────────────────────────────────────────────────────

function getAllClubs() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.CLUBS);
  if (!sheet) return { clubs: [] };
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { clubs: [] };

  var h = data[0].map(String);
  var clubs = [];
  for (var i = 1; i < data.length; i++) {
    var r   = data[i];
    var get = function(col) { var idx=h.indexOf(col); return idx>=0?r[idx]:''; };
    var id  = String(get('id') || '');
    if (!id) continue;
    clubs.push({
      id:       id,
      name:     String(get('name')     || ''),
      sport:    String(get('sport')    || ''),
      address:  String(get('address')  || ''),
      photoUrl: String(get('photoUrl') || ''),
      hours:    String(get('hours')    || ''),
      pricing:  String(get('pricing')  || ''),
      courts:   String(get('courts')   || ''),
      notes:    String(get('notes')    || ''),
    });
  }
  return { clubs: clubs };
}

// ─────────────────────────────────────────────────────────────
// LECTURE — Recherche clubs par nom ou sport
// ─────────────────────────────────────────────────────────────

function searchClubs(query) {
  if (!query) return getAllClubs();
  var all = getAllClubs().clubs;
  var q   = query.toLowerCase();
  return {
    clubs: all.filter(function(c) {
      return c.name.toLowerCase().indexOf(q) >= 0 ||
             c.sport.toLowerCase().indexOf(q) >= 0 ||
             c.address.toLowerCase().indexOf(q) >= 0;
    })
  };
}

// ─────────────────────────────────────────────────────────────
// LECTURE — Index global des sessions (dashboard)
// ─────────────────────────────────────────────────────────────

function getAllSessions() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SESSIONS);
  if (!sheet) return { sessions: [] };
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { sessions: [] };

  var h = data[0].map(String);
  var sessions = [];
  for (var i = 1; i < data.length; i++) {
    var r   = data[i];
    var get = function(col) { var idx=h.indexOf(col); return idx>=0?r[idx]:''; };
    var id  = String(get('sessionId') || '');
    if (!id) continue;
    sessions.push({
      id:          String(get('id')          || ''),
      sessionId:   id,
      sport:       String(get('sport')       || ''),
      status:      String(get('status')      || 'open'),
      venue:       String(get('venue')       || ''),
      date:        formatDateTimeValue(get('date')),
      maxPlayers:  Number(get('maxPlayers')) || 10,
      createdAt:   String(get('createdAt')   || ''),
      ownerEmail:  String(get('ownerEmail')  || ''),
    });
  }
  return { sessions: sessions };
}

// ─────────────────────────────────────────────────────────────
// LECTURE — Sessions par email utilisateur
// ─────────────────────────────────────────────────────────────

function getMatchesByEmail(email) {
  if (!email) return { sessions: [] };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.USER_SESSIONS);
  if (!sheet) return { sessions: [] };

  var data   = sheet.getDataRange().getValues();
  var h      = data[0].map(String);
  var emIdx  = h.indexOf('email');
  var sidIdx = h.indexOf('sessionId');

  var sessionIds = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][emIdx]).toLowerCase() === email.toLowerCase())
      sessionIds.push(String(data[i][sidIdx]));
  }

  if (!sessionIds.length) return { sessions: [] };

  var all = getAllSessions().sessions;
  return { sessions: all.filter(function(s) { return sessionIds.indexOf(s.sessionId) >= 0; }) };
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — Créer une nouvelle session (index global)
// ─────────────────────────────────────────────────────────────

function createSession(body) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SESSIONS);
  var id    = generateId();
  var now   = new Date().toISOString();
  sheet.appendRow([
    id,
    body.sessionId   || '',
    body.sport       || '',
    body.status      || 'open',
    body.venue       || '',
    body.date        || '',
    Number(body.maxPlayers) || 10,
    now,
    body.ownerEmail  || '',
  ]);
  // Lier l'owner à la session
  if (body.ownerEmail) linkUserToSession(body.ownerEmail, body.sessionId || id);
  bumpTimestamp();
  return { ok: true, id: String(id), timestamp: getTimestamp() };
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — Lier un utilisateur (email) à une session
// ─────────────────────────────────────────────────────────────

function linkUserToSession(email, sessionId) {
  if (!email || !sessionId) return { ok: false, error: 'email et sessionId requis' };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.USER_SESSIONS);
  var data  = sheet.getDataRange().getValues();
  var h     = data[0].map(String);
  var emIdx = h.indexOf('email');
  var siIdx = h.indexOf('sessionId');

  // Vérifier si le lien existe déjà
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][emIdx]).toLowerCase() === email.toLowerCase() &&
        String(data[i][siIdx]) === sessionId) {
      return { ok: true, note: 'Déjà lié' };
    }
  }
  sheet.appendRow([email.toLowerCase(), sessionId, new Date().toISOString()]);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — setDispoCell (Lock + dédup)
// ─────────────────────────────────────────────────────────────

function setDispoCell(body, sessionId) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); }
  catch(e) { return { ok:false, error:'Lock timeout — réessayez' }; }

  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.DISPOS);
    var data  = sheet.getDataRange().getValues();
    var h     = data[0].map(String);

    var idIdx  = h.indexOf('id');
    var nmIdx  = h.indexOf('name');
    var dtIdx  = h.indexOf('date');
    var slIdx  = h.indexOf('slot');
    var stIdx  = h.indexOf('state');
    var sidIdx = h.indexOf('sessionId');
    var updIdx = h.indexOf('updatedAt');

    if (slIdx === -1 || stIdx === -1) {
      sheet.getRange(1, 1, 1, SCHEMAS.Dispos.length).setValues([SCHEMAS.Dispos]);
      idIdx=0;nmIdx=1;dtIdx=2;slIdx=3;stIdx=4;sidIdx=5;updIdx=6;
      data = sheet.getDataRange().getValues();
      h    = data[0].map(String);
    }

    var name     = String(body.name  || 'Anonyme');
    var date     = String(body.date  || '');
    var slot     = String(body.slot  || '');
    var newState = String(body.state || '');
    var now      = new Date().toISOString();

    // Trouver TOUTES les lignes correspondant à la clé (name+date+slot+sessionId)
    var matchingRows = [];
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      if (String(r[nmIdx]) === name &&
          formatDateValue(r[dtIdx]) === date &&  // normalise avant comparaison
          String(r[slIdx]) === slot &&
          String(r[sidIdx]) === sessionId) {
        matchingRows.push(i);
      }
    }

    if (matchingRows.length > 0) {
      if (newState === '') {
        for (var k = matchingRows.length - 1; k >= 0; k--)
          sheet.deleteRow(matchingRows[k] + 1);
      } else {
        // Supprimer les doublons (tous sauf le premier)
        for (var k = matchingRows.length - 1; k >= 1; k--)
          sheet.deleteRow(matchingRows[k] + 1);
        // Mettre à jour le premier
        sheet.getRange(matchingRows[0]+1, stIdx+1).setValue(newState);
        if (updIdx >= 0) sheet.getRange(matchingRows[0]+1, updIdx+1).setValue(now);
      }
    } else if (newState !== '') {
      var newId = generateId();
      sheet.appendRow([newId, name, date, slot, newState, sessionId, now]);
    }

    bumpTimestamp();
    return { ok: true, timestamp: getTimestamp() };
  } finally {
    lock.releaseLock();
  }
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — Batch dispos (envoi groupé côté client)
// ─────────────────────────────────────────────────────────────

/**
 * Traite plusieurs cellules de disponibilité en une seule requête.
 * body.cells = [{ name, date, slot, state, sessionId }, ...]
 * Appelle setDispoCell pour chaque cellule (Lock global).
 */
function batchSetDispos(body, sessionId) {
  var cells = body.cells || [];
  if (!cells.length) return { ok: true, processed: 0 };

  // Un seul Lock pour tout le batch
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch(e) { return { ok: false, error: 'Lock timeout batch' }; }

  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.DISPOS);
    // Relire une seule fois pour tout le batch (optimisation)
    var data  = sheet.getDataRange().getValues();
    var h     = data[0].map(String);

    var idIdx  = h.indexOf('id');
    var nmIdx  = h.indexOf('name');
    var dtIdx  = h.indexOf('date');
    var slIdx  = h.indexOf('slot');
    var stIdx  = h.indexOf('state');
    var sidIdx = h.indexOf('sessionId');
    var updIdx = h.indexOf('updatedAt');

    // Migration auto
    if (slIdx === -1 || stIdx === -1) {
      sheet.getRange(1, 1, 1, SCHEMAS.Dispos.length).setValues([SCHEMAS.Dispos]);
      idIdx=0;nmIdx=1;dtIdx=2;slIdx=3;stIdx=4;sidIdx=5;updIdx=6;
      data = sheet.getDataRange().getValues();
      h    = data[0].map(String);
    }

    var now = new Date().toISOString();
    var processed = 0;

    cells.forEach(function(cell) {
      var cellSid  = cell.sessionId || sessionId;
      var name     = String(cell.name  || 'Anonyme');
      var date     = String(cell.date  || '');
      var slot     = String(cell.slot  || '');
      var newState = String(cell.state || '');

      // Trouver les lignes correspondantes (re-lire data[] à jour)
      // Note : après des suppressions, les index de data[] sont décalés
      // On relit le sheet à chaque cellule si nécessaire (sécurité)
      // Mais pour la perf, on travaille sur data[] en mémoire

      var matchingRows = [];
      for (var i = 1; i < data.length; i++) {
        if (!data[i] || data[i].length === 0) continue;
        if (String(data[i][nmIdx])  === name &&
            formatDateValue(data[i][dtIdx]) === date &&
            String(data[i][slIdx])  === slot &&
            String(data[i][sidIdx]) === cellSid) {
          matchingRows.push(i);
        }
      }

      if (matchingRows.length > 0) {
        if (newState === '') {
          // Supprimer en partant du bas
          for (var k = matchingRows.length - 1; k >= 0; k--) {
            sheet.deleteRow(matchingRows[k] + 1);
            // Invalider la ligne dans data[] pour éviter des faux positifs
            data[matchingRows[k]] = [];
          }
        } else {
          // Supprimer les doublons, mettre à jour le premier
          for (var k = matchingRows.length - 1; k >= 1; k--) {
            sheet.deleteRow(matchingRows[k] + 1);
            data[matchingRows[k]] = [];
          }
          sheet.getRange(matchingRows[0]+1, stIdx+1).setValue(newState);
          if (updIdx >= 0) sheet.getRange(matchingRows[0]+1, updIdx+1).setValue(now);
          if (stIdx < data[matchingRows[0]].length) data[matchingRows[0]][stIdx] = newState;
        }
      } else if (newState !== '') {
        var newId = generateId();
        sheet.appendRow([newId, name, date, slot, newState, cellSid, now]);
        // Ajouter à data[] pour les prochaines recherches du même batch
        var newRow = new Array(h.length).fill('');
        newRow[idIdx]=newId; newRow[nmIdx]=name; newRow[dtIdx]=date;
        newRow[slIdx]=slot; newRow[stIdx]=newState; newRow[sidIdx]=cellSid;
        if(updIdx>=0) newRow[updIdx]=now;
        data.push(newRow);
      }
      processed++;
    });

    bumpTimestamp();
    return { ok: true, processed: processed, timestamp: getTimestamp() };
  } finally {
    lock.releaseLock();
  }
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — Slots
// ─────────────────────────────────────────────────────────────

function addSlot(body, sessionId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SLOTS);
  var id    = generateId();
  // S'assurer que date et heures sont en format texte propre
  sheet.appendRow([id, body.date||'', body.start||'', body.end||'',
                   body.venue||'', body.price||'', 0, sessionId]);
  bumpTimestamp();
  return { ok: true, id: String(id), timestamp: getTimestamp() };
}

function voteSlot(id, delta, sessionId) {
  var sheet  = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SLOTS);
  var data   = sheet.getDataRange().getValues();
  var h      = data[0].map(String);
  var idIdx  = h.indexOf('id');
  var vtIdx  = h.indexOf('votes');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === String(id)) {
      var cur = Number(data[i][vtIdx]) || 0;
      sheet.getRange(i+1, vtIdx+1).setValue(Math.max(0, cur + Number(delta)));
      bumpTimestamp();
      return { ok: true, votes: cur+Number(delta), timestamp: getTimestamp() };
    }
  }
  return { ok: false, error: 'Créneau introuvable : ' + id };
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — Players
// ─────────────────────────────────────────────────────────────

function addPlayer(body, sessionId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PLAYERS);
  var id    = generateId();
  sheet.appendRow([id, body.name||'', body.status||'player', sessionId]);
  bumpTimestamp();
  return { ok: true, id: String(id), timestamp: getTimestamp() };
}

function promotePlayer(id) {
  var sheet  = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PLAYERS);
  var data   = sheet.getDataRange().getValues();
  var h      = data[0].map(String);
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
// ÉCRITURE — Session (détails)
// ─────────────────────────────────────────────────────────────

function saveSession(body, sessionId) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.SESSION);
  var data  = sheet.getDataRange().getValues();
  var h     = data[0].map(String);
  var sidIdx = h.indexOf('sessionId');
  var now    = new Date().toISOString();

  // Ordre conforme au schéma : sessionId | date | venue | address | mapsUrl | bookingUrl
  //                            | price | notes | maxPlayers | sport | updatedAt
  var row = [
    sessionId,
    body.date        || '',
    body.venue       || '',
    body.address     || '',
    body.mapsUrl     || '',
    body.bookingUrl  || '',
    body.price       || '',
    body.notes       || '',
    Number(body.maxPlayers) || 10,
    body.sport       || '',
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
// SUPPRESSION générique
// ─────────────────────────────────────────────────────────────

function deleteRow(sheetName, id) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return { ok:false, error:'Onglet introuvable : '+sheetName };
  var data  = sheet.getDataRange().getValues();
  var h     = data[0].map(String);
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
// DÉDOUBLONNAGE dispos
// ─────────────────────────────────────────────────────────────

function deduplicateDispos() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.DISPOS);
  if (!sheet) return { ok:false, error:'Onglet Dispos introuvable' };
  var data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return { ok: true, removed: 0 };

  var h      = data[0].map(String);
  var nmIdx  = h.indexOf('name');
  var dtIdx  = h.indexOf('date');
  var slIdx  = h.indexOf('slot');
  var sidIdx = h.indexOf('sessionId');
  var updIdx = h.indexOf('updatedAt');

  var best     = {};
  var toDelete = [];

  for (var i = 1; i < data.length; i++) {
    var r  = data[i];
    var ck = String(r[sidIdx])+'::'+String(r[nmIdx])+'::'+formatDateValue(r[dtIdx])+'::'+String(r[slIdx]);
    var upd = updIdx >= 0 ? String(r[updIdx]) : '';

    if (!best[ck]) {
      best[ck] = { rowIdx: i, updatedAt: upd };
    } else if (upd > best[ck].updatedAt) {
      toDelete.push(best[ck].rowIdx);
      best[ck] = { rowIdx: i, updatedAt: upd };
    } else {
      toDelete.push(i);
    }
  }

  toDelete.sort(function(a,b) { return b-a; });
  for (var j = 0; j < toDelete.length; j++) sheet.deleteRow(toDelete[j]+1);

  bumpTimestamp();
  return { ok: true, removed: toDelete.length };
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
// INITIALISATION DES ONGLETS (idempotent)
// ─────────────────────────────────────────────────────────────

function initSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var HEADER_STYLE = { bg: '#1e1e2e', color: '#a6e3a1', bold: true };

  Object.keys(SCHEMAS).forEach(function(name) {
    var schema = SCHEMAS[name];
    var sheet  = ss.getSheetByName(name);

    if (!sheet) {
      // Créer l'onglet
      sheet = ss.insertSheet(name);
      sheet.appendRow(schema);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, schema.length)
           .setBackground(HEADER_STYLE.bg)
           .setFontColor(HEADER_STYLE.color)
           .setFontWeight('bold');
    } else {
      // Migrer : ajouter les colonnes manquantes
      var lastCol     = Math.max(sheet.getLastColumn(), 1);
      var existingRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
      schema.forEach(function(col) {
        if (existingRow.indexOf(col) === -1) {
          var newCol = existingRow.length + 1;
          var cell   = sheet.getRange(1, newCol);
          cell.setValue(col)
              .setBackground(HEADER_STYLE.bg)
              .setFontColor(HEADER_STYLE.color)
              .setFontWeight('bold');
          existingRow.push(col);
        }
      });
    }
  });

  // Initialiser le timestamp si vide
  var meta = ss.getSheetByName(SHEETS.META);
  if (!meta) { meta = ss.insertSheet(SHEETS.META); meta.appendRow(['lastTimestamp','value']); }
  if (!meta.getRange('B1').getValue()) {
    meta.getRange('A1').setValue('lastTimestamp');
    meta.getRange('B1').setValue(Date.now());
  }
}

// ─────────────────────────────────────────────────────────────
// UTILITAIRES — Conversion de dates (robuste)
// ─────────────────────────────────────────────────────────────

/**
 * → 'YYYY-MM-DD'
 * Gère : Date object, nombre sériel Excel, string DD/MM/YYYY, string ISO.
 * BUG FIX : nombre sériel → UTC correct (pas de décalage TZ local).
 */
function formatDateValue(val) {
  if (!val && val !== 0) return '';
  if (val instanceof Date) {
    // Utiliser UTC pour éviter les décalages de fuseau horaire
    var y = val.getUTCFullYear();
    var m = String(val.getUTCMonth()+1).padStart(2,'0');
    var d = String(val.getUTCDate()).padStart(2,'0');
    return y + '-' + m + '-' + d;
  }
  if (typeof val === 'number') {
    // Sériel Excel : nombre de jours depuis 1900-01-01
    // 25569 = jours entre 1900-01-01 et 1970-01-01 (epoch Unix)
    var ms  = Math.round((val - 25569) * 86400000);
    var dt  = new Date(ms);
    return formatDateValue(dt); // récursion avec un Date object
  }
  var s = String(val).trim();
  if (!s) return '';
  // Déjà YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  // DD/MM/YYYY ou DD-MM-YYYY
  var m2 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m2) return m2[3]+'-'+m2[2].padStart(2,'0')+'-'+m2[1].padStart(2,'0');
  return s;
}

/**
 * → 'HH:MM'
 * Gère : Date object (utilise heure locale), fraction décimale, string.
 */
function formatTimeValue(val) {
  if (!val && val !== 0) return '';
  if (val instanceof Date) {
    // Heure locale (les heures dans les cellules Sheets sont en TZ du Sheet)
    return String(val.getHours()).padStart(2,'0')+':'+String(val.getMinutes()).padStart(2,'0');
  }
  if (typeof val === 'number') {
    if (val < 1) {
      // Fraction décimale : 0.8333 ≈ 20:00
      var totalMin = Math.round(val * 1440); // 1440 = 24*60
      return String(Math.floor(totalMin/60)).padStart(2,'0')+':'+String(totalMin%60).padStart(2,'0');
    }
    // Nombre entier improbable pour une heure, renvoyer vide
    return '';
  }
  var s = String(val).trim();
  // HH:MM ou H:MM
  if (/^\d{1,2}:\d{2}$/.test(s)) return s.length===4 ? '0'+s : s;
  return s;
}

/**
 * → 'YYYY-MM-DDTHH:MM'  (format datetime-local HTML)
 * BUG FIX : si val est un Date object, on utilise getUTCDate pour la partie date
 *           mais getHours pour la partie heure (les heures sont locales dans Sheets).
 */
function formatDateTimeValue(val) {
  if (!val && val !== 0) return '';
  if (val instanceof Date) {
    var datePart = formatDateValue(val);           // UTC date
    var timePart = String(val.getHours()).padStart(2,'0')+':'+String(val.getMinutes()).padStart(2,'0');
    return datePart + (timePart !== '00:00' ? 'T'+timePart : '');
  }
  if (typeof val === 'number') {
    // Sériel Excel — peut encoder date+heure comme fraction
    var ms  = Math.round((val - 25569) * 86400000);
    var dt  = new Date(ms);
    return formatDateTimeValue(dt);
  }
  var s = String(val).trim();
  if (!s) return '';
  // Déjà YYYY-MM-DDTHH:MM
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0,16);
  // Juste YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s;
}

// ─────────────────────────────────────────────────────────────
// UTILITAIRES — ID & JSON
// ─────────────────────────────────────────────────────────────

function generateId() {
  return String(Date.now()) + String(Math.floor(Math.random()*9000+1000));
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
                       .setMimeType(ContentService.MimeType.JSON);
}
