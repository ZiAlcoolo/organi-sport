/**
 * ═══════════════════════════════════════════════════════════════
 * SPORTSYNC — apps-script.gs  v5
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
 * STRUCTURE DES ONGLETS
 *   Meta         : lastTimestamp | value
 *   Dispos       : id | name | date | slot | state | sessionId | updatedAt
 *   Slots        : id | date | start | end | venue | price | votes | sessionId
 *   Players      : id | name | status | sessionId
 *   Session      : sessionId | date | venue | address | mapsUrl | bookingUrl
 *                  | price | notes | maxPlayers | sport | updatedAt
 *   Sessions     : id | sessionId | sport | status | venue | date | maxPlayers
 *                  | createdAt | ownerEmail
 *   Clubs        : id | name | sport | address | photoUrl | hours | pricing | courts | notes
 *   UserSessions : email | sessionId | joinedAt
 * ═══════════════════════════════════════════════════════════════
 */

var SHEETS = {
  META:          'Meta',
  DISPOS:        'Dispos',
  SLOTS:         'Slots',
  PLAYERS:       'Players',
  SESSION:       'Session',
  SESSIONS:      'Sessions',
  CLUBS:         'Clubs',
  USER_SESSIONS: 'UserSessions',
};

var SCHEMAS = {
  Meta:         ['lastTimestamp', 'value'],
  Dispos:       ['id', 'name', 'date', 'slot', 'state', 'sessionId', 'updatedAt'],
  Slots:        ['id', 'date', 'start', 'end', 'venue', 'price', 'votes', 'sessionId'],
  Players:      ['id', 'name', 'status', 'sessionId'],
  Session:      ['sessionId', 'date', 'venue', 'address', 'mapsUrl', 'bookingUrl',
                 'price', 'notes', 'maxPlayers', 'sport', 'updatedAt'],
  Sessions:     ['id', 'sessionId', 'sport', 'status', 'venue', 'date', 'maxPlayers',
                 'createdAt', 'ownerEmail'],
  Clubs:        ['id', 'name', 'sport', 'address', 'photoUrl', 'hours',
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
      case 'getData':        result = getAllData(sessionId);     break;
      case 'getAllClubs':    result = getAllClubs();             break;
      case 'searchClubs':   result = searchClubs(query);       break;
      case 'getMyMatches':  result = getMatchesByEmail(email);  break;
      case 'getAllSessions': result = getAllSessions();          break;
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
      case 'batchSetDispos':     result = batchSetDispos(body, sessionId);          break;
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

function readDispos(ss, sessionId) {
  var sheet = ss.getSheetByName(SHEETS.DISPOS);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  var h = data[0].map(String);
  var idIdx=h.indexOf('id'), nmIdx=h.indexOf('name'), dtIdx=h.indexOf('date');
  var slIdx=h.indexOf('slot'), stIdx=h.indexOf('state'), sidIdx=h.indexOf('sessionId'), updIdx=h.indexOf('updatedAt');
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[idIdx] && r[idIdx] !== 0) continue;
    if (sidIdx >= 0 && sessionId !== 'recurring' && String(r[sidIdx]) !== sessionId) continue;
    rows.push({
      id:        String(r[idIdx]),
      name:      String(r[nmIdx]  || ''),
      date:      formatDateValue(r[dtIdx]),
      slot:      String(r[slIdx]  || ''),
      state:     String(r[stIdx]  || ''),
      sessionId: String(r[sidIdx] || ''),
      updatedAt: String(r[updIdx] || ''),
    });
  }
  return rows;
}

function readSlots(ss, sessionId) {
  var sheet = ss.getSheetByName(SHEETS.SLOTS);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  var h = data[0].map(String);
  var idIdx=h.indexOf('id'), dtIdx=h.indexOf('date'), stIdx=h.indexOf('start'), enIdx=h.indexOf('end');
  var vnIdx=h.indexOf('venue'), prIdx=h.indexOf('price'), vtIdx=h.indexOf('votes'), sidIdx=h.indexOf('sessionId');
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[idIdx] && r[idIdx] !== 0) continue;
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

function readPlayers(ss, sessionId) {
  var sheet = ss.getSheetByName(SHEETS.PLAYERS);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  var h = data[0].map(String);
  var idIdx=h.indexOf('id'), nmIdx=h.indexOf('name'), stIdx=h.indexOf('status'), sidIdx=h.indexOf('sessionId');
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

function readSession(ss, sessionId) {
  var sheet = ss.getSheetByName(SHEETS.SESSION);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return null;
  var h = data[0].map(String);
  var sidIdx = h.indexOf('sessionId');
  for (var i = 1; i < data.length; i++) {
    var r   = data[i];
    var sid = sidIdx >= 0 ? String(r[sidIdx]) : '';
    if (sessionId === 'recurring' || sid === sessionId) {
      var get = function(col) { var idx=h.indexOf(col); return idx>=0?r[idx]:''; };
      return {
        date:       formatDateTimeValue(get('date')),
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
// LECTURE — Clubs, Sessions, UserSessions
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
    var get = function(col) { var idx=h.indexOf(col); return idx>=0?String(r[idx]||''):''; };
    if (!get('id')) continue;
    clubs.push({ id:get('id'), name:get('name'), sport:get('sport'), address:get('address'),
                 photoUrl:get('photoUrl'), hours:get('hours'), pricing:get('pricing'),
                 courts:get('courts'), notes:get('notes') });
  }
  return { clubs: clubs };
}

function searchClubs(query) {
  if (!query) return getAllClubs();
  var all = getAllClubs().clubs, q = query.toLowerCase();
  return { clubs: all.filter(function(c) {
    return c.name.toLowerCase().indexOf(q)>=0 || c.sport.toLowerCase().indexOf(q)>=0 ||
           c.address.toLowerCase().indexOf(q)>=0;
  })};
}

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
    if (!get('sessionId')) continue;
    sessions.push({ id:String(get('id')||''), sessionId:String(get('sessionId')),
      sport:String(get('sport')||''), status:String(get('status')||'open'),
      venue:String(get('venue')||''), date:formatDateTimeValue(get('date')),
      maxPlayers:Number(get('maxPlayers'))||10,
      createdAt:String(get('createdAt')||''), ownerEmail:String(get('ownerEmail')||'') });
  }
  return { sessions: sessions };
}

function getMatchesByEmail(email) {
  if (!email) return { sessions: [] };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.USER_SESSIONS);
  if (!sheet) return { sessions: [] };
  var data = sheet.getDataRange().getValues();
  var h = data[0].map(String);
  var emIdx=h.indexOf('email'), sidIdx=h.indexOf('sessionId');
  var sessionIds = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][emIdx]).toLowerCase() === email.toLowerCase())
      sessionIds.push(String(data[i][sidIdx]));
  }
  if (!sessionIds.length) return { sessions: [] };
  var all = getAllSessions().sessions;
  return { sessions: all.filter(function(s){ return sessionIds.indexOf(s.sessionId)>=0; }) };
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — setDispoCell (une cellule, avec Lock)
// ─────────────────────────────────────────────────────────────

function setDispoCell(body, sessionId) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch(e) { return {ok:false,error:'Lock timeout'}; }
  try {
    return _upsertDispoCell(body.name, body.date, body.slot, body.state||'', sessionId);
  } finally { lock.releaseLock(); }
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — batchSetDispos (plusieurs cellules en une requête)
//
// BUG FIX v5 : la version précédente gardait data[] en mémoire et
// invalidait les lignes avec data[i]=[] après deleteRow. Problème :
// sheet.deleteRow() décale immédiatement les numéros physiques de lignes,
// donc les indices stockés dans data[] ne correspondaient plus au Sheet réel.
// La ligne suivante du batch lisait alors des données décalées → date vide.
//
// Solution : on RELIT le Sheet après chaque deleteRow au lieu de
// maintenir data[] en mémoire. C'est plus lent mais 100% correct.
// Pour minimiser les relectures, on regroupe d'abord toutes les opérations
// en deux passes : 1) identifier, 2) écrire en partant du bas.
// ─────────────────────────────────────────────────────────────

function batchSetDispos(body, sessionId) {
  var cells = body.cells || [];
  if (!cells.length) return { ok: true, processed: 0 };

  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch(e) { return {ok:false,error:'Lock timeout batch'}; }

  try {
    var processed = 0;
    // Traiter chaque cellule séquentiellement avec relecture du Sheet à chaque fois.
    // C'est la seule approche correcte : les deleteRow/appendRow modifient
    // les index physiques en temps réel, une copie mémoire de data[] devient
    // immédiatement obsolète après la première modification.
    for (var ci = 0; ci < cells.length; ci++) {
      var cell    = cells[ci];
      var cellSid = cell.sessionId || sessionId;
      _upsertDispoCell(cell.name, cell.date, cell.slot, cell.state||'', cellSid);
      processed++;
    }
    bumpTimestamp();
    return { ok: true, processed: processed, timestamp: getTimestamp() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Logique d'upsert partagée entre setDispoCell et batchSetDispos.
 * RELIT toujours le Sheet depuis le début (getDataRange) pour avoir
 * les index physiques corrects après d'éventuels deleteRow précédents.
 *
 * @param {string} name
 * @param {string} date     — format YYYY-MM-DD attendu
 * @param {string} slot     — 'morning' | 'afternoon' | 'evening'
 * @param {string} newState — 'ok' | 'no' | ''
 * @param {string} sessionId
 */
function _upsertDispoCell(name, date, slot, newState, sessionId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.DISPOS);

  // Relecture fraîche du Sheet à chaque appel
  var data  = sheet.getDataRange().getValues();
  var h     = data[0].map(String);

  var nmIdx  = h.indexOf('name');
  var dtIdx  = h.indexOf('date');
  var slIdx  = h.indexOf('slot');
  var stIdx  = h.indexOf('state');
  var sidIdx = h.indexOf('sessionId');
  var updIdx = h.indexOf('updatedAt');

  // Migration si colonnes manquantes
  if (slIdx === -1 || stIdx === -1) {
    sheet.getRange(1, 1, 1, SCHEMAS.Dispos.length).setValues([SCHEMAS.Dispos]);
    nmIdx=1;dtIdx=2;slIdx=3;stIdx=4;sidIdx=5;updIdx=6;
    data = sheet.getDataRange().getValues();
    h    = data[0].map(String);
  }

  var nameStr = String(name  || 'Anonyme');
  var dateStr = String(date  || '');
  var slotStr = String(slot  || '');
  var now     = new Date().toISOString();

  // Trouver toutes les lignes correspondant à la clé composite
  var matchingRows = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r || r.length === 0) continue;
    // Normaliser la date stockée avant comparaison (elle peut être un objet Date)
    var storedDate = formatDateValue(r[dtIdx]);
    if (String(r[nmIdx])  === nameStr &&
        storedDate         === dateStr &&
        String(r[slIdx])  === slotStr &&
        String(r[sidIdx]) === sessionId) {
      matchingRows.push(i + 1); // +1 = numéro de ligne dans le Sheet (1-indexed)
    }
  }

  if (matchingRows.length > 0) {
    if (newState === '') {
      // Supprimer toutes les occurrences en partant du bas
      // (évite le décalage des numéros de lignes lors de suppressions successives)
      for (var k = matchingRows.length - 1; k >= 0; k--) {
        sheet.deleteRow(matchingRows[k]);
      }
    } else {
      // Supprimer les doublons (toutes les lignes sauf la première)
      for (var k = matchingRows.length - 1; k >= 1; k--) {
        sheet.deleteRow(matchingRows[k]);
      }
      // Après les suppressions, la première ligne a pu se décaler.
      // On relit une dernière fois pour avoir son vrai numéro de ligne.
      var freshData   = sheet.getDataRange().getValues();
      var freshH      = freshData[0].map(String);
      var freshNmIdx  = freshH.indexOf('name');
      var freshDtIdx  = freshH.indexOf('date');
      var freshSlIdx  = freshH.indexOf('slot');
      var freshSidIdx = freshH.indexOf('sessionId');
      var freshStIdx  = freshH.indexOf('state');
      var freshUpdIdx = freshH.indexOf('updatedAt');
      var targetRow   = -1;
      for (var j = 1; j < freshData.length; j++) {
        var fr = freshData[j];
        if (String(fr[freshNmIdx])  === nameStr &&
            formatDateValue(fr[freshDtIdx]) === dateStr &&
            String(fr[freshSlIdx])  === slotStr &&
            String(fr[freshSidIdx]) === sessionId) {
          targetRow = j + 1; // numéro de ligne Sheet
          break;
        }
      }
      if (targetRow > 0) {
        sheet.getRange(targetRow, freshStIdx+1).setValue(newState);
        if (freshUpdIdx >= 0) sheet.getRange(targetRow, freshUpdIdx+1).setValue(now);
      }
    }
  } else if (newState !== '') {
    // Aucune ligne existante → créer
    var newId = generateId();
    sheet.appendRow([newId, nameStr, dateStr, slotStr, newState, sessionId, now]);
  }
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — Slots, Players, Session, Sessions, UserSessions
// ─────────────────────────────────────────────────────────────

function addSlot(body, sessionId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SLOTS);
  var id    = generateId();
  sheet.appendRow([id, body.date||'', body.start||'', body.end||'', body.venue||'', body.price||'', 0, sessionId]);
  bumpTimestamp();
  return { ok:true, id:String(id), timestamp:getTimestamp() };
}

function voteSlot(id, delta, sessionId) {
  var sheet  = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SLOTS);
  var data   = sheet.getDataRange().getValues();
  var h      = data[0].map(String);
  var idIdx  = h.indexOf('id'), vtIdx=h.indexOf('votes');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === String(id)) {
      var cur = Number(data[i][vtIdx]) || 0;
      sheet.getRange(i+1, vtIdx+1).setValue(Math.max(0, cur + Number(delta)));
      bumpTimestamp();
      return { ok:true, votes:cur+Number(delta), timestamp:getTimestamp() };
    }
  }
  return { ok:false, error:'Créneau introuvable : '+id };
}

function addPlayer(body, sessionId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PLAYERS);
  var id    = generateId();
  sheet.appendRow([id, body.name||'', body.status||'player', sessionId]);
  bumpTimestamp();
  return { ok:true, id:String(id), timestamp:getTimestamp() };
}

function promotePlayer(id) {
  var sheet  = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PLAYERS);
  var data   = sheet.getDataRange().getValues();
  var h      = data[0].map(String);
  var idIdx  = h.indexOf('id'), stIdx=h.indexOf('status');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === String(id)) {
      sheet.getRange(i+1, stIdx+1).setValue('player');
      bumpTimestamp();
      return { ok:true };
    }
  }
  return { ok:false, error:'Joueur introuvable : '+id };
}

function saveSession(body, sessionId) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.SESSION);
  var data  = sheet.getDataRange().getValues();
  var h     = data[0].map(String);
  var sidIdx = h.indexOf('sessionId'), now = new Date().toISOString();
  var row = [sessionId, body.date||'', body.venue||'', body.address||'', body.mapsUrl||'',
             body.bookingUrl||'', body.price||'', body.notes||'', Number(body.maxPlayers)||10,
             body.sport||'', now];
  for (var i = 1; i < data.length; i++) {
    var sid = sidIdx>=0 ? String(data[i][sidIdx]) : '';
    if (sid===sessionId || (sessionId==='recurring'&&!sid)) {
      sheet.getRange(i+1, 1, 1, row.length).setValues([row]);
      bumpTimestamp(); return { ok:true, timestamp:getTimestamp() };
    }
  }
  sheet.appendRow(row);
  bumpTimestamp(); return { ok:true, timestamp:getTimestamp() };
}

function createSession(body) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SESSIONS);
  var id    = generateId(), now = new Date().toISOString();
  sheet.appendRow([id, body.sessionId||'', body.sport||'', body.status||'open', body.venue||'',
                   body.date||'', Number(body.maxPlayers)||10, now, body.ownerEmail||'']);
  if (body.ownerEmail) linkUserToSession(body.ownerEmail, body.sessionId||id);
  bumpTimestamp();
  return { ok:true, id:String(id), timestamp:getTimestamp() };
}

function linkUserToSession(email, sessionId) {
  if (!email||!sessionId) return { ok:false, error:'email et sessionId requis' };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.USER_SESSIONS);
  var data  = sheet.getDataRange().getValues();
  var h     = data[0].map(String);
  var emIdx=h.indexOf('email'), siIdx=h.indexOf('sessionId');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][emIdx]).toLowerCase()===email.toLowerCase() &&
        String(data[i][siIdx])===sessionId) return { ok:true, note:'Déjà lié' };
  }
  sheet.appendRow([email.toLowerCase(), sessionId, new Date().toISOString()]);
  return { ok:true };
}

// ─────────────────────────────────────────────────────────────
// SUPPRESSION + DÉDUPLICATION
// ─────────────────────────────────────────────────────────────

function deleteRow(sheetName, id) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return {ok:false, error:'Onglet introuvable : '+sheetName};
  var data  = sheet.getDataRange().getValues();
  var h     = data[0].map(String), idIdx=h.indexOf('id');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === String(id)) {
      sheet.deleteRow(i+1);
      bumpTimestamp();
      return { ok:true, timestamp:getTimestamp() };
    }
  }
  return { ok:false, error:'Introuvable id='+id+' dans '+sheetName };
}

function deduplicateDispos() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.DISPOS);
  if (!sheet) return {ok:false, error:'Onglet Dispos introuvable'};
  var data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return { ok:true, removed:0 };
  var h      = data[0].map(String);
  var nmIdx=h.indexOf('name'), dtIdx=h.indexOf('date'), slIdx=h.indexOf('slot');
  var sidIdx=h.indexOf('sessionId'), updIdx=h.indexOf('updatedAt');
  var best={}, toDelete=[];
  for (var i = 1; i < data.length; i++) {
    var r  = data[i];
    var ck = String(r[sidIdx])+'::'+String(r[nmIdx])+'::'+formatDateValue(r[dtIdx])+'::'+String(r[slIdx]);
    var upd = updIdx>=0 ? String(r[updIdx]) : '';
    if (!best[ck])                    { best[ck]={rowIdx:i,updatedAt:upd}; }
    else if (upd>best[ck].updatedAt)  { toDelete.push(best[ck].rowIdx); best[ck]={rowIdx:i,updatedAt:upd}; }
    else                              { toDelete.push(i); }
  }
  toDelete.sort(function(a,b){return b-a;});
  for (var j=0;j<toDelete.length;j++) sheet.deleteRow(toDelete[j]+1);
  bumpTimestamp();
  return { ok:true, removed:toDelete.length };
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
  var HEADER_STYLE = { bg:'#1e1e2e', color:'#a6e3a1', bold:true };
  Object.keys(SCHEMAS).forEach(function(name) {
    var schema = SCHEMAS[name];
    var sheet  = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(schema);
      sheet.setFrozenRows(1);
      sheet.getRange(1,1,1,schema.length).setBackground(HEADER_STYLE.bg).setFontColor(HEADER_STYLE.color).setFontWeight('bold');
    } else {
      var lastCol     = Math.max(sheet.getLastColumn(),1);
      var existingRow = sheet.getRange(1,1,1,lastCol).getValues()[0].map(String);
      schema.forEach(function(col) {
        if (existingRow.indexOf(col)===-1) {
          var newCol = existingRow.length+1;
          sheet.getRange(1,newCol).setValue(col).setBackground(HEADER_STYLE.bg).setFontColor(HEADER_STYLE.color).setFontWeight('bold');
          existingRow.push(col);
        }
      });
    }
  });
  var meta = ss.getSheetByName(SHEETS.META);
  if (!meta) { meta=ss.insertSheet(SHEETS.META); meta.appendRow(['lastTimestamp','value']); }
  if (!meta.getRange('B1').getValue()) {
    meta.getRange('A1').setValue('lastTimestamp');
    meta.getRange('B1').setValue(Date.now());
  }
}

// ─────────────────────────────────────────────────────────────
// UTILITAIRES — Conversion dates
// ─────────────────────────────────────────────────────────────

function formatDateValue(val) {
  if (!val && val !== 0) return '';
  if (val instanceof Date) {
    return val.getUTCFullYear()+'-'+String(val.getUTCMonth()+1).padStart(2,'0')+'-'+String(val.getUTCDate()).padStart(2,'0');
  }
  if (typeof val === 'number') {
    var dt = new Date(Math.round((val-25569)*86400000));
    return formatDateValue(dt);
  }
  var s = String(val).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
  return s;
}

function formatTimeValue(val) {
  if (!val && val !== 0) return '';
  if (val instanceof Date) {
    return String(val.getHours()).padStart(2,'0')+':'+String(val.getMinutes()).padStart(2,'0');
  }
  if (typeof val === 'number' && val < 1) {
    var totalMin = Math.round(val*1440);
    return String(Math.floor(totalMin/60)).padStart(2,'0')+':'+String(totalMin%60).padStart(2,'0');
  }
  var s = String(val).trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return s.length===4?'0'+s:s;
  return s;
}

function formatDateTimeValue(val) {
  if (!val && val !== 0) return '';
  if (val instanceof Date) {
    var dp = formatDateValue(val);
    var tp = String(val.getHours()).padStart(2,'0')+':'+String(val.getMinutes()).padStart(2,'0');
    return dp+(tp!=='00:00'?'T'+tp:'');
  }
  if (typeof val === 'number') { return formatDateTimeValue(new Date(Math.round((val-25569)*86400000))); }
  var s = String(val).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0,16);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s;
}

function generateId() {
  return String(Date.now())+String(Math.floor(Math.random()*9000+1000));
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
