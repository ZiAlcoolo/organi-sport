/**
 * ═══════════════════════════════════════════════════════════════
 * SPORTSYNC — apps-script.gs
 * Proxy API entre l'application web et Google Sheets
 * ═══════════════════════════════════════════════════════════════
 *
 * 📋 INSTALLATION
 * ─────────────────
 * 1. Ouvrir votre Google Sheet
 * 2. Extensions → Apps Script
 * 3. Coller tout ce fichier dans l'éditeur (remplace le contenu par défaut)
 * 4. Déployer → Nouveau déploiement
 *      - Type              : Application Web
 *      - Exécuter en tant que : Moi
 *      - Accès             : Tout le monde (anonyme)
 * 5. Autoriser les permissions demandées (lecture/écriture Sheets)
 * 6. Copier l'URL /exec dans CONFIG.GAS_URL de app.js
 *
 * ⚠️  Chaque modification de ce script nécessite un NOUVEAU déploiement.
 *     L'URL /exec reste stable entre déploiements du même projet.
 *
 * 📋 STRUCTURE DU SPREADSHEET ATTENDUE
 * ──────────────────────────────────────
 * Onglet "Meta"    : A1=lastTimestamp  B1=<timestamp unix ms>
 * Onglet "Dispos"  : id | name | date | time | createdAt | sessionId
 * Onglet "Slots"   : id | date | start | end | venue | price | votes | sessionId
 * Onglet "Players" : id | name | status | sessionId
 * Onglet "Session" : sessionId | date | venue | price | notes | updatedAt
 *
 * Le script crée automatiquement les onglets et les en-têtes
 * s'ils n'existent pas encore (voir initSheets()).
 * ═══════════════════════════════════════════════════════════════
 */

// ── Constantes ───────────────────────────────────────────────
var SHEETS = {
  META:    'Meta',
  DISPOS:  'Dispos',
  SLOTS:   'Slots',
  PLAYERS: 'Players',
  SESSION: 'Session',
};

// ─────────────────────────────────────────────────────────────
// POINT D'ENTRÉE — GET
// Appelé par : gasRequest('GET', null, { action: 'getData', sessionId: '…' })
// ─────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    initSheets(); // Crée les onglets manquants si besoin

    var action    = (e.parameter && e.parameter.action)    || 'getData';
    var sessionId = (e.parameter && e.parameter.sessionId) || 'recurring';

    var result;
    if (action === 'getData') {
      result = getAllData(sessionId);
    } else {
      result = { error: 'Action GET inconnue : ' + action };
    }

    return jsonResponse(result);

  } catch (err) {
    return jsonResponse({ error: err.message, stack: err.stack });
  }
}

// ─────────────────────────────────────────────────────────────
// POINT D'ENTRÉE — POST
// Appelé par : gasRequest('POST', { action, sessionId, …payload })
// ─────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    initSheets();

    // Apps Script reçoit le JSON dans postData.contents
    var body      = JSON.parse(e.postData.contents);
    var action    = body.action    || '';
    var sessionId = body.sessionId || 'recurring';

    var result;

    switch (action) {
      case 'addDispo':
        result = addDispo(body, sessionId);
        break;
      case 'deleteDispo':
        result = deleteRow(SHEETS.DISPOS, body.id, sessionId);
        break;
      case 'addSlot':
        result = addSlot(body, sessionId);
        break;
      case 'voteSlot':
        result = voteSlot(body.id, body.delta, sessionId);
        break;
      case 'addPlayer':
        result = addPlayer(body, sessionId);
        break;
      case 'removePlayer':
        result = deleteRow(SHEETS.PLAYERS, body.id, sessionId);
        break;
      case 'promotePlayer':
        result = promotePlayer(body.id, sessionId);
        break;
      case 'saveSession':
        result = saveSession(body, sessionId);
        break;
      default:
        result = { error: 'Action POST inconnue : ' + action };
    }

    return jsonResponse(result);

  } catch (err) {
    return jsonResponse({ error: err.message, stack: err.stack });
  }
}

// ─────────────────────────────────────────────────────────────
// LECTURE GLOBALE
// ─────────────────────────────────────────────────────────────

/**
 * Renvoie toutes les données de la session en un seul objet.
 * @param {string} sessionId
 */
function getAllData(sessionId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  return {
    timestamp : getTimestamp(ss),
    dispos    : readSheet(ss, SHEETS.DISPOS,  sessionId, ['id','name','date','time','createdAt']),
    slots     : readSheet(ss, SHEETS.SLOTS,   sessionId, ['id','date','start','end','venue','price','votes']),
    players   : readSheet(ss, SHEETS.PLAYERS, sessionId, ['id','name','status']),
    session   : readSession(ss, sessionId),
  };
}

/**
 * Lit un onglet et retourne les lignes correspondant au sessionId
 * sous forme d'objets, en utilisant la première ligne comme en-tête.
 * @param {Spreadsheet} ss
 * @param {string}      sheetName
 * @param {string}      sessionId
 * @param {string[]}    fields - colonnes à inclure (dans l'ordre du Sheet)
 * @returns {object[]}
 */
function readSheet(ss, sheetName, sessionId, fields) {
  var sheet  = ss.getSheetByName(sheetName);
  if (!sheet) return [];

  var data   = sheet.getDataRange().getValues();
  if (data.length <= 1) return []; // Seulement l'en-tête

  var header     = data[0];
  var sidColIdx  = header.indexOf('sessionId');
  var rows       = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    // Filtre par sessionId si la colonne existe
    // 'recurring' voit toutes les lignes sans sessionId strict
    if (sidColIdx >= 0 && sessionId !== 'recurring') {
      if (row[sidColIdx] !== sessionId) continue;
    }
    // Construire l'objet avec les champs demandés
    var obj = {};
    fields.forEach(function(field) {
      var idx = header.indexOf(field);
      obj[field] = idx >= 0 ? row[idx] : '';
    });
    // Ignorer les lignes sans id valide
    if (!obj.id) continue;
    rows.push(obj);
  }

  return rows;
}

/**
 * Lit les infos de session depuis l'onglet Session.
 */
function readSession(ss, sessionId) {
  var sheet = ss.getSheetByName(SHEETS.SESSION);
  if (!sheet) return null;

  var data   = sheet.getDataRange().getValues();
  var header = data[0];
  var sidIdx = header.indexOf('sessionId');

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var sid = sidIdx >= 0 ? row[sidIdx] : '';
    if (sessionId === 'recurring' || sid === sessionId) {
      return {
        date:  row[header.indexOf('date')]  || '',
        venue: row[header.indexOf('venue')] || '',
        price: row[header.indexOf('price')] || '',
        notes: row[header.indexOf('notes')] || '',
      };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — DISPONIBILITÉS
// ─────────────────────────────────────────────────────────────

function addDispo(body, sessionId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.DISPOS);
  var id    = generateId();
  sheet.appendRow([id, body.name, body.date, body.time, body.createdAt, sessionId]);
  bumpTimestamp();
  return { ok: true, id: id, timestamp: getTimestamp() };
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — CRÉNEAUX
// ─────────────────────────────────────────────────────────────

function addSlot(body, sessionId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SLOTS);
  var id    = generateId();
  sheet.appendRow([id, body.date, body.start, body.end, body.venue, body.price, 0, sessionId]);
  bumpTimestamp();
  return { ok: true, id: id, timestamp: getTimestamp() };
}

/**
 * Incrémente ou décrémente le compteur de votes d'un créneau.
 * @param {string|number} id
 * @param {number}        delta  +1 ou -1
 * @param {string}        sessionId
 */
function voteSlot(id, delta, sessionId) {
  var sheet   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SLOTS);
  var data    = sheet.getDataRange().getValues();
  var header  = data[0];
  var idIdx   = header.indexOf('id');
  var voteIdx = header.indexOf('votes');

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === String(id)) {
      var current = Number(data[i][voteIdx]) || 0;
      sheet.getRange(i + 1, voteIdx + 1).setValue(Math.max(0, current + delta));
      bumpTimestamp();
      return { ok: true, votes: current + delta, timestamp: getTimestamp() };
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
  return { ok: true, id: id, timestamp: getTimestamp() };
}

/**
 * Passe le statut d'un joueur de 'waitlist' à 'player'.
 */
function promotePlayer(id, sessionId) {
  var sheet  = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PLAYERS);
  var data   = sheet.getDataRange().getValues();
  var header = data[0];
  var idIdx  = header.indexOf('id');
  var stIdx  = header.indexOf('status');

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === String(id)) {
      sheet.getRange(i + 1, stIdx + 1).setValue('player');
      bumpTimestamp();
      return { ok: true, timestamp: getTimestamp() };
    }
  }
  return { ok: false, error: 'Joueur introuvable : ' + id };
}

// ─────────────────────────────────────────────────────────────
// ÉCRITURE — SESSION
// ─────────────────────────────────────────────────────────────

function saveSession(body, sessionId) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.SESSION);
  var data  = sheet.getDataRange().getValues();
  var header= data[0];
  var sidIdx= header.indexOf('sessionId');

  // Chercher une ligne existante pour ce sessionId
  for (var i = 1; i < data.length; i++) {
    var sid = sidIdx >= 0 ? String(data[i][sidIdx]) : '';
    if (sid === sessionId || (sessionId === 'recurring' && !sid)) {
      // Mise à jour de la ligne existante
      sheet.getRange(i + 1, 1, 1, header.length).setValues([[
        sessionId,
        body.date  || '',
        body.venue || '',
        body.price || '',
        body.notes || '',
        new Date().toISOString(),
      ]]);
      bumpTimestamp();
      return { ok: true, timestamp: getTimestamp() };
    }
  }

  // Aucune ligne trouvée → ajout
  sheet.appendRow([sessionId, body.date, body.venue, body.price, body.notes, new Date().toISOString()]);
  bumpTimestamp();
  return { ok: true, timestamp: getTimestamp() };
}

// ─────────────────────────────────────────────────────────────
// SUPPRESSION GÉNÉRIQUE
// ─────────────────────────────────────────────────────────────

/**
 * Supprime la première ligne d'un onglet dont la colonne 'id' correspond.
 * @param {string}        sheetName
 * @param {string|number} id
 * @param {string}        sessionId  (non utilisé pour la suppression, mais conservé pour logs)
 */
function deleteRow(sheetName, id, sessionId) {
  var sheet  = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  var data   = sheet.getDataRange().getValues();
  var header = data[0];
  var idIdx  = header.indexOf('id');

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === String(id)) {
      sheet.deleteRow(i + 1);
      bumpTimestamp();
      return { ok: true, timestamp: getTimestamp() };
    }
  }
  return { ok: false, error: 'Ligne introuvable : id=' + id + ' dans ' + sheetName };
}

// ─────────────────────────────────────────────────────────────
// TIMESTAMP — Mécanisme de synchronisation
// ─────────────────────────────────────────────────────────────

/**
 * Retourne le timestamp stocké dans Meta!B1 (ou 0 si absent).
 * @param {Spreadsheet} [ss]
 */
function getTimestamp(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var meta = ss.getSheetByName(SHEETS.META);
  if (!meta) return 0;
  var val = meta.getRange('B1').getValue();
  return val ? Number(val) : 0;
}

/**
 * Met à jour Meta!B1 avec le timestamp courant (ms).
 * Appelée après chaque écriture pour déclencher la synchro côté client.
 */
function bumpTimestamp() {
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var meta = ss.getSheetByName(SHEETS.META);
  if (!meta) meta = ss.insertSheet(SHEETS.META);
  meta.getRange('A1').setValue('lastTimestamp');
  meta.getRange('B1').setValue(Date.now());
}

// ─────────────────────────────────────────────────────────────
// INITIALISATION DES ONGLETS
// ─────────────────────────────────────────────────────────────

/**
 * Crée les onglets et leurs en-têtes s'ils n'existent pas encore.
 * Appelée à chaque requête GET/POST pour être idempotent et sûr.
 */
function initSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var schemas = {};
  schemas[SHEETS.META]    = ['lastTimestamp', 'value'];
  schemas[SHEETS.DISPOS]  = ['id', 'name', 'date', 'time', 'createdAt', 'sessionId'];
  schemas[SHEETS.SLOTS]   = ['id', 'date', 'start', 'end', 'venue', 'price', 'votes', 'sessionId'];
  schemas[SHEETS.PLAYERS] = ['id', 'name', 'status', 'sessionId'];
  schemas[SHEETS.SESSION] = ['sessionId', 'date', 'venue', 'price', 'notes', 'updatedAt'];

  Object.keys(schemas).forEach(function(name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(schemas[name]);
      // Figer la première ligne (en-tête)
      sheet.setFrozenRows(1);
      // Style de l'en-tête
      sheet.getRange(1, 1, 1, schemas[name].length)
           .setBackground('#1e1e2e')
           .setFontColor('#a6e3a1')
           .setFontWeight('bold');
    }
  });

  // Initialiser Meta!B1 si vide
  var meta = ss.getSheetByName(SHEETS.META);
  if (!meta.getRange('B1').getValue()) {
    meta.getRange('A1').setValue('lastTimestamp');
    meta.getRange('B1').setValue(Date.now());
  }
}

// ─────────────────────────────────────────────────────────────
// UTILITAIRES
// ─────────────────────────────────────────────────────────────

/**
 * Génère un identifiant unique basé sur le timestamp + random.
 * @returns {number}
 */
function generateId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

/**
 * Formatte la réponse JSON avec les headers CORS nécessaires.
 * Apps Script en mode "Tout le monde" gère le CORS automatiquement
 * via ContentService — pas besoin d'ajouter des headers manuellement.
 * @param {object} data
 */
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
