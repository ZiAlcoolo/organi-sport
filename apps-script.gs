/**
 * ═══════════════════════════════════════════════════════════════
 * SPORTSYNC — apps-script.gs  v6
 * ═══════════════════════════════════════════════════════════════
 *
 * CHANGEMENTS v6 :
 *   - Votes uniques par joueur : colonne votes = JSON {"nom":1,"Paul":1}
 *   - Clubs : nouveaux champs url, phone, mapsUrl, maxPlayers, active, hours (JSON)
 *   - Sessions : linkUserToSession automatique à saveSession
 *   - getAllData renvoie aussi les sessions de l'utilisateur (via email param)
 *
 * STRUCTURE DES ONGLETS
 *   Meta         : lastTimestamp | value
 *   Dispos       : id | name | date | slot | state | sessionId | updatedAt
 *   Slots        : id | date | start | end | venue | price | votes | sessionId
 *                  votes = JSON string : { "Mamat": 1, "Paul": 1 }
 *   Players      : id | name | status | sessionId
 *   Session      : sessionId | date | venue | address | mapsUrl | bookingUrl
 *                  | price | notes | maxPlayers | sport | clubId | updatedAt
 *   Sessions     : id | sessionId | sport | status | venue | date | maxPlayers
 *                  | createdAt | ownerEmail
 *   Clubs        : id | name | sport | address | photoUrl | hours | pricing
 *                  | courts | notes | url | phone | mapsUrl | maxPlayers | active | installations
 *   UserSessions : email | sessionId | joinedAt
 */

var SHEETS = {
  META:'Meta', DISPOS:'Dispos', SLOTS:'Slots', PLAYERS:'Players',
  SESSION:'Session', SESSIONS:'Sessions', CLUBS:'Clubs', USER_SESSIONS:'UserSessions',
};

var SCHEMAS = {
  Meta:         ['lastTimestamp','value'],
  Dispos:       ['id','name','date','slot','state','sessionId','updatedAt'],
  Slots:        ['id','date','start','end','venue','price','votes','sessionId'],
  Players:      ['id','name','status','sessionId'],
  Session:      ['sessionId','date','venue','address','mapsUrl','bookingUrl',
                 'price','notes','maxPlayers','sport','clubId','updatedAt'],
  Sessions:     ['id','sessionId','sport','status','venue','date','maxPlayers',
                 'createdAt','ownerEmail'],
  Clubs:        ['id','name','sport','address','photoUrl','hours','pricing','courts',
                 'notes','url','phone','mapsUrl','maxPlayers','active','installations'],
  UserSessions: ['email','sessionId','joinedAt'],
};

// ─────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    initSheets();
    var action    = (e.parameter&&e.parameter.action)    ||'getData';
    var sessionId = (e.parameter&&e.parameter.sessionId) ||'recurring';
    var query     = (e.parameter&&e.parameter.q)         ||'';
    var email     = (e.parameter&&e.parameter.email)     ||'';
    var result;
    switch(action){
      case 'getData':        result=getAllData(sessionId,email);  break;
      case 'getAllClubs':    result=getAllClubs();                 break;
      case 'searchClubs':   result=searchClubs(query);           break;
      case 'getMyMatches':  result=getMatchesByEmail(email);     break;
      case 'getAllSessions': result=getAllSessions();             break;
      case 'geocode':        result=geocodeProxy(query);       break;
      case 'geocodeBatch':   result=geocodeBatchProxy(e.parameter.addresses||''); break;
      default: result={error:'Action GET inconnue : '+action};
    }
    return jsonResponse(result);
  } catch(err){ return jsonResponse({error:err.message,stack:err.stack}); }
}

// ─────────────────────────────────────────────────────────────
// POST
// ─────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    initSheets();
    var body      = JSON.parse(e.postData.contents);
    var action    = body.action    ||'';
    var sessionId = body.sessionId ||'recurring';
    var result;
    switch(action){
      case 'setDispoCell':      result=setDispoCell(body,sessionId);           break;
      case 'batchSetDispos':    result=batchSetDispos(body,sessionId);         break;
      case 'addSlot':           result=addSlot(body,sessionId);                break;
      case 'voteSlot':          result=voteSlotAction(body,sessionId);         break;
      case 'addPlayer':         result=addPlayer(body,sessionId);              break;
      case 'removePlayer':      result=deleteRow(SHEETS.PLAYERS,body.id);      break;
      case 'promotePlayer':     result=promotePlayer(body.id);                 break;
      case 'saveSession':       result=saveSession(body,sessionId);            break;
      case 'createSession':     result=createSession(body);                    break;
      case 'linkUserToSession': result=linkUserToSession(body.email,body.sessionId); break;
      case 'deduplicateDispos':        result=deduplicateDispos();               break;
      case 'createRecurringSession': result=createRecurringSession(body);      break;
      default: result={error:'Action inconnue : '+action};
    }
    return jsonResponse(result);
  } catch(err){ return jsonResponse({error:err.message,stack:err.stack}); }
}

// ─────────────────────────────────────────────────────────────
// LECTURE
// ─────────────────────────────────────────────────────────────
function getAllData(sessionId, email) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var result = {
    timestamp : getTimestamp(ss),
    dispos    : readDispos(ss,sessionId),
    slots     : readSlots(ss,sessionId),
    players   : readPlayers(ss,sessionId),
    session   : readSession(ss,sessionId),
  };
  // Inclure les sessions de l'utilisateur si email fourni
  if(email) result.userSessions = getMatchesByEmail(email).sessions;
  return result;
}

function readDispos(ss,sessionId){
  var sheet=ss.getSheetByName(SHEETS.DISPOS);if(!sheet)return[];
  var data=sheet.getDataRange().getValues();if(data.length<=1)return[];
  var h=data[0].map(String);
  var idI=h.indexOf('id'),nmI=h.indexOf('name'),dtI=h.indexOf('date'),
      slI=h.indexOf('slot'),stI=h.indexOf('state'),sidI=h.indexOf('sessionId'),updI=h.indexOf('updatedAt');
  var rows=[];
  for(var i=1;i<data.length;i++){
    var r=data[i];if(!r[idI]&&r[idI]!==0)continue;
    if(sidI>=0&&sessionId!=='recurring'&&String(r[sidI])!==sessionId)continue;
    rows.push({id:String(r[idI]),name:String(r[nmI]||''),date:formatDateValue(r[dtI]),
      slot:String(r[slI]||''),state:String(r[stI]||''),sessionId:String(r[sidI]||''),
      updatedAt:String(r[updI]||'')});
  }
  return rows;
}

function readSlots(ss,sessionId){
  var sheet=ss.getSheetByName(SHEETS.SLOTS);if(!sheet)return[];
  var data=sheet.getDataRange().getValues();if(data.length<=1)return[];
  var h=data[0].map(String);
  var idI=h.indexOf('id'),dtI=h.indexOf('date'),stI=h.indexOf('start'),enI=h.indexOf('end'),
      vnI=h.indexOf('venue'),prI=h.indexOf('price'),vtI=h.indexOf('votes'),sidI=h.indexOf('sessionId');
  var rows=[];
  for(var i=1;i<data.length;i++){
    var r=data[i];if(!r[idI]&&r[idI]!==0)continue;
    if(sidI>=0&&sessionId!=='recurring'&&String(r[sidI])!==sessionId)continue;
    // votes = JSON string {"name":1,...} ou nombre legacy
    var votesRaw=r[vtI];
    var votesObj={};
    if(typeof votesRaw==='string'&&votesRaw.trim().startsWith('{')){
      try{votesObj=JSON.parse(votesRaw);}catch(e){votesObj={};}
    } else {
      // Legacy : nombre simple → on ne peut pas attribuer, on garde comme info
      votesObj = typeof votesRaw==='number'&&votesRaw>0 ? {'__legacy__':votesRaw} : {};
    }
    rows.push({id:String(r[idI]),date:formatDateValue(r[dtI]),start:formatTimeValue(r[stI]),
      end:formatTimeValue(r[enI]),venue:String(r[vnI]||''),price:String(r[prI]||''),
      votes:votesObj,sessionId:String(r[sidI]||'')});
  }
  return rows;
}

function readPlayers(ss,sessionId){
  var sheet=ss.getSheetByName(SHEETS.PLAYERS);if(!sheet)return[];
  var data=sheet.getDataRange().getValues();if(data.length<=1)return[];
  var h=data[0].map(String);
  var idI=h.indexOf('id'),nmI=h.indexOf('name'),stI=h.indexOf('status'),sidI=h.indexOf('sessionId');
  var rows=[];
  for(var i=1;i<data.length;i++){
    var r=data[i];if(!r[idI]&&r[idI]!==0)continue;
    if(sidI>=0&&sessionId!=='recurring'&&String(r[sidI])!==sessionId)continue;
    rows.push({id:String(r[idI]),name:String(r[nmI]||''),status:String(r[stI]||'player'),sessionId:String(r[sidI]||'')});
  }
  return rows;
}

function readSession(ss,sessionId){
  var sheet=ss.getSheetByName(SHEETS.SESSION);if(!sheet)return null;
  var data=sheet.getDataRange().getValues();if(data.length<=1)return null;
  var h=data[0].map(String),sidI=h.indexOf('sessionId');
  for(var i=1;i<data.length;i++){
    var r=data[i],sid=sidI>=0?String(r[sidI]):'';
    if(sessionId==='recurring'||sid===sessionId){
      var get=function(col){var idx=h.indexOf(col);return idx>=0?r[idx]:'';};
      return{date:formatDateTimeValue(get('date')),venue:String(get('venue')||''),
        address:String(get('address')||''),mapsUrl:String(get('mapsUrl')||''),
        bookingUrl:String(get('bookingUrl')||''),price:String(get('price')||''),
        notes:String(get('notes')||''),maxPlayers:Number(get('maxPlayers'))||10,
        sport:String(get('sport')||''),clubId:String(get('clubId')||'')};
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// CLUBS (nouveaux champs v6)
// ─────────────────────────────────────────────────────────────
function getAllClubs(){
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.CLUBS);
  if(!sheet)return{clubs:[]};
  var data=sheet.getDataRange().getValues();if(data.length<=1)return{clubs:[]};
  var h=data[0].map(String);
  var clubs=[];
  for(var i=1;i<data.length;i++){
    var r=data[i];
    var get=function(col){var idx=h.indexOf(col);return idx>=0?String(r[idx]||''):'';};
    if(!get('id'))continue;
    // Filtrer les clubs désactivés
    var active=get('active');
    if(active.toLowerCase()==='false'||active==='0')continue;
    clubs.push({
      id:get('id'),name:get('name'),sport:get('sport'),address:get('address'),
      photoUrl:get('photoUrl'),hours:get('hours'),pricing:get('pricing'),
      courts:get('courts'),notes:get('notes'),
      url:get('url'),phone:get('phone'),mapsUrl:get('mapsUrl'),
      maxPlayers:Number(get('maxPlayers'))||0,active:get('active'),
      installations:get('installations'),
    });
  }
  return{clubs:clubs};
}

function searchClubs(query){
  if(!query)return getAllClubs();
  var all=getAllClubs().clubs,q=query.toLowerCase();
  return{clubs:all.filter(function(c){
    return c.name.toLowerCase().indexOf(q)>=0||c.sport.toLowerCase().indexOf(q)>=0||
           c.address.toLowerCase().indexOf(q)>=0;
  })};
}

// ─────────────────────────────────────────────────────────────
// SESSIONS & USER_SESSIONS
// ─────────────────────────────────────────────────────────────
function getAllSessions(){
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SESSIONS);
  if(!sheet)return{sessions:[]};
  var data=sheet.getDataRange().getValues();if(data.length<=1)return{sessions:[]};
  var h=data[0].map(String),sessions=[];
  for(var i=1;i<data.length;i++){
    var r=data[i];
    var get=function(col){var idx=h.indexOf(col);return idx>=0?r[idx]:'';};
    if(!get('sessionId'))continue;
    sessions.push({id:String(get('id')||''),sessionId:String(get('sessionId')),
      sport:String(get('sport')||''),status:String(get('status')||'open'),
      venue:String(get('venue')||''),date:formatDateTimeValue(get('date')),
      maxPlayers:Number(get('maxPlayers'))||10,createdAt:String(get('createdAt')||''),
      ownerEmail:String(get('ownerEmail')||'')});
  }
  return{sessions:sessions};
}

function getMatchesByEmail(email){
  if(!email)return{sessions:[]};
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.USER_SESSIONS);
  if(!sheet)return{sessions:[]};
  var data=sheet.getDataRange().getValues();
  var h=data[0].map(String),emI=h.indexOf('email'),sidI=h.indexOf('sessionId');
  var sessionIds=[];
  for(var i=1;i<data.length;i++){
    if(String(data[i][emI]).toLowerCase()===email.toLowerCase())
      sessionIds.push(String(data[i][sidI]));
  }
  if(!sessionIds.length)return{sessions:[]};
  var all=getAllSessions().sessions;
  return{sessions:all.filter(function(s){return sessionIds.indexOf(s.sessionId)>=0;})};
}

// ─────────────────────────────────────────────────────────────
// VOTES UNIQUES PAR JOUEUR
// votes colonne = JSON string { "Mamat": 1, "Paul": 1 }
// ─────────────────────────────────────────────────────────────
function voteSlotAction(body, sessionId) {
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SLOTS);
  var data=sheet.getDataRange().getValues();
  var h=data[0].map(String),idI=h.indexOf('id'),vtI=h.indexOf('votes');
  var voterName = String(body.voterName||'Anonyme');
  var action    = body.action==='remove' ? 'remove' : 'add'; // add ou remove

  for(var i=1;i<data.length;i++){
    if(String(data[i][idI])===String(body.id)){
      var votesRaw=data[i][vtI];
      var votesObj={};
      if(typeof votesRaw==='string'&&votesRaw.trim().startsWith('{')){
        try{votesObj=JSON.parse(votesRaw);}catch(e){votesObj={};}
      }
      if(action==='remove'){
        delete votesObj[voterName];
      } else {
        votesObj[voterName]=1;
      }
      sheet.getRange(i+1,vtI+1).setValue(JSON.stringify(votesObj));
      bumpTimestamp();
      return{ok:true,votes:votesObj,timestamp:getTimestamp()};
    }
  }
  return{ok:false,error:'Créneau introuvable : '+body.id};
}

// ─────────────────────────────────────────────────────────────
// DISPOS
// ─────────────────────────────────────────────────────────────
function setDispoCell(body,sessionId){
  var lock=LockService.getScriptLock();
  try{lock.waitLock(8000);}catch(e){return{ok:false,error:'Lock timeout'};}
  try{return _upsertDispoCell(body.name,body.date,body.slot,body.state||'',sessionId);}
  finally{lock.releaseLock();}
}

function batchSetDispos(body,sessionId){
  var cells=body.cells||[];if(!cells.length)return{ok:true,processed:0};
  var lock=LockService.getScriptLock();
  try{lock.waitLock(15000);}catch(e){return{ok:false,error:'Lock timeout batch'};}
  try{
    var processed=0;
    for(var ci=0;ci<cells.length;ci++){
      var cell=cells[ci],cellSid=cell.sessionId||sessionId;
      _upsertDispoCell(cell.name,cell.date,cell.slot,cell.state||'',cellSid);
      processed++;
    }
    bumpTimestamp();
    return{ok:true,processed:processed,timestamp:getTimestamp()};
  }finally{lock.releaseLock();}
}

function _upsertDispoCell(name,date,slot,newState,sessionId){
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.DISPOS);
  var data=sheet.getDataRange().getValues();
  var h=data[0].map(String);
  var nmI=h.indexOf('name'),dtI=h.indexOf('date'),slI=h.indexOf('slot'),
      stI=h.indexOf('state'),sidI=h.indexOf('sessionId'),updI=h.indexOf('updatedAt');
  if(slI===-1||stI===-1){
    sheet.getRange(1,1,1,SCHEMAS.Dispos.length).setValues([SCHEMAS.Dispos]);
    nmI=1;dtI=2;slI=3;stI=4;sidI=5;updI=6;
    data=sheet.getDataRange().getValues();h=data[0].map(String);
  }
  var nameStr=String(name||'Anonyme'),dateStr=String(date||''),
      slotStr=String(slot||''),now=new Date().toISOString();
  var matchingRows=[];
  for(var i=1;i<data.length;i++){
    var r=data[i];if(!r||r.length===0)continue;
    if(String(r[nmI])===nameStr&&formatDateValue(r[dtI])===dateStr&&
       String(r[slI])===slotStr&&String(r[sidI])===sessionId)matchingRows.push(i+1);
  }
  if(matchingRows.length>0){
    if(newState===''){
      for(var k=matchingRows.length-1;k>=0;k--)sheet.deleteRow(matchingRows[k]);
    }else{
      for(var k=matchingRows.length-1;k>=1;k--)sheet.deleteRow(matchingRows[k]);
      var fd=sheet.getDataRange().getValues(),fh=fd[0].map(String);
      var fnI=fh.indexOf('name'),fdtI=fh.indexOf('date'),fslI=fh.indexOf('slot'),
          fsidI=fh.indexOf('sessionId'),fstI=fh.indexOf('state'),fuI=fh.indexOf('updatedAt');
      var tRow=-1;
      for(var j=1;j<fd.length;j++){
        var fr=fd[j];
        if(String(fr[fnI])===nameStr&&formatDateValue(fr[fdtI])===dateStr&&
           String(fr[fslI])===slotStr&&String(fr[fsidI])===sessionId){tRow=j+1;break;}
      }
      if(tRow>0){sheet.getRange(tRow,fstI+1).setValue(newState);if(fuI>=0)sheet.getRange(tRow,fuI+1).setValue(now);}
    }
  }else if(newState!==''){
    var newId=generateId();
    sheet.appendRow([newId,nameStr,dateStr,slotStr,newState,sessionId,now]);
  }
}

// ─────────────────────────────────────────────────────────────
// SLOTS, PLAYERS, SESSION, SESSIONS
// ─────────────────────────────────────────────────────────────
function addSlot(body,sessionId){
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SLOTS);
  var id=generateId();
  sheet.appendRow([id,body.date||'',body.start||'',body.end||'',body.venue||'',body.price||'','{}',sessionId]);
  bumpTimestamp();return{ok:true,id:String(id),timestamp:getTimestamp()};
}

function addPlayer(body,sessionId){
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PLAYERS);
  var id=generateId();
  sheet.appendRow([id,body.name||'',body.status||'player',sessionId]);
  bumpTimestamp();return{ok:true,id:String(id),timestamp:getTimestamp()};
}

function promotePlayer(id){
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PLAYERS);
  var data=sheet.getDataRange().getValues(),h=data[0].map(String);
  var idI=h.indexOf('id'),stI=h.indexOf('status');
  for(var i=1;i<data.length;i++){
    if(String(data[i][idI])===String(id)){sheet.getRange(i+1,stI+1).setValue('player');bumpTimestamp();return{ok:true};}
  }
  return{ok:false,error:'Joueur introuvable : '+id};
}

function saveSession(body,sessionId){
  var ss=SpreadsheetApp.getActiveSpreadsheet();
  var sheet=ss.getSheetByName(SHEETS.SESSION);
  var data=sheet.getDataRange().getValues(),h=data[0].map(String);
  var sidI=h.indexOf('sessionId'),now=new Date().toISOString();
  var row=[sessionId,body.date||'',body.venue||'',body.address||'',body.mapsUrl||'',
           body.bookingUrl||'',body.price||'',body.notes||'',Number(body.maxPlayers)||10,
           body.sport||'',body.clubId||'',now];
  for(var i=1;i<data.length;i++){
    var sid=sidI>=0?String(data[i][sidI]):'';
    if(sid===sessionId||(sessionId==='recurring'&&!sid)){
      sheet.getRange(i+1,1,1,row.length).setValues([row]);
      bumpTimestamp();return{ok:true,timestamp:getTimestamp()};
    }
  }
  sheet.appendRow(row);
  // Aussi créer/mettre à jour dans Sessions et UserSessions
  _upsertSessionIndex(body,sessionId);
  if(body.ownerEmail)linkUserToSession(body.ownerEmail,sessionId);
  bumpTimestamp();return{ok:true,timestamp:getTimestamp()};
}

function _upsertSessionIndex(body,sessionId){
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SESSIONS);
  var data=sheet.getDataRange().getValues(),h=data[0].map(String);
  var sidI=h.indexOf('sessionId');
  for(var i=1;i<data.length;i++){
    if(String(data[i][sidI])===sessionId){
      // Mise à jour des champs
      var get=function(col){var idx=h.indexOf(col);return idx>=0?String(data[i][idx]||''):'';};
      sheet.getRange(i+1,h.indexOf('sport')+1).setValue(body.sport||get('sport'));
      sheet.getRange(i+1,h.indexOf('venue')+1).setValue(body.venue||get('venue'));
      sheet.getRange(i+1,h.indexOf('date')+1).setValue(body.date||get('date'));
      sheet.getRange(i+1,h.indexOf('maxPlayers')+1).setValue(Number(body.maxPlayers)||10);
      return;
    }
  }
  // Créer
  var newId=generateId();
  sheet.appendRow([newId,sessionId,body.sport||'','open',body.venue||'',body.date||'',
                   Number(body.maxPlayers)||10,new Date().toISOString(),body.ownerEmail||'']);
}

function createSession(body){
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SESSIONS);
  var id=generateId(),now=new Date().toISOString();
  sheet.appendRow([id,body.sessionId||'',body.sport||'',body.status||'open',body.venue||'',
                   body.date||'',Number(body.maxPlayers)||10,now,body.ownerEmail||'']);
  if(body.ownerEmail)linkUserToSession(body.ownerEmail,body.sessionId||id);
  bumpTimestamp();return{ok:true,id:String(id),timestamp:getTimestamp()};
}

function linkUserToSession(email,sessionId){
  if(!email||!sessionId)return{ok:false,error:'email et sessionId requis'};
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.USER_SESSIONS);
  var data=sheet.getDataRange().getValues(),h=data[0].map(String);
  var emI=h.indexOf('email'),siI=h.indexOf('sessionId');
  for(var i=1;i<data.length;i++){
    if(String(data[i][emI]).toLowerCase()===email.toLowerCase()&&String(data[i][siI])===sessionId)
      return{ok:true,note:'Déjà lié'};
  }
  sheet.appendRow([email.toLowerCase(),sessionId,new Date().toISOString()]);
  return{ok:true};
}

// ─────────────────────────────────────────────────────────────
// SUPPRESSION + DÉDUP
// ─────────────────────────────────────────────────────────────
function deleteRow(sheetName,id){
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if(!sheet)return{ok:false,error:'Onglet introuvable : '+sheetName};
  var data=sheet.getDataRange().getValues(),h=data[0].map(String),idI=h.indexOf('id');
  for(var i=1;i<data.length;i++){
    if(String(data[i][idI])===String(id)){sheet.deleteRow(i+1);bumpTimestamp();return{ok:true};}
  }
  return{ok:false,error:'Introuvable id='+id};
}

function deduplicateDispos(){
  var sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.DISPOS);
  if(!sheet)return{ok:false};
  var data=sheet.getDataRange().getValues();if(data.length<=1)return{ok:true,removed:0};
  var h=data[0].map(String);
  var nmI=h.indexOf('name'),dtI=h.indexOf('date'),slI=h.indexOf('slot'),
      sidI=h.indexOf('sessionId'),updI=h.indexOf('updatedAt');
  var best={},toDelete=[];
  for(var i=1;i<data.length;i++){
    var r=data[i];
    var ck=String(r[sidI])+'::'+String(r[nmI])+'::'+formatDateValue(r[dtI])+'::'+String(r[slI]);
    var upd=updI>=0?String(r[updI]):'';
    if(!best[ck]){best[ck]={rowIdx:i,updatedAt:upd};}
    else if(upd>best[ck].updatedAt){toDelete.push(best[ck].rowIdx);best[ck]={rowIdx:i,updatedAt:upd};}
    else{toDelete.push(i);}
  }
  toDelete.sort(function(a,b){return b-a;});
  for(var j=0;j<toDelete.length;j++)sheet.deleteRow(toDelete[j]+1);
  bumpTimestamp();return{ok:true,removed:toDelete.length};
}

// ─────────────────────────────────────────────────────────────
// TIMESTAMP
// ─────────────────────────────────────────────────────────────
function getTimestamp(ss){ss=ss||SpreadsheetApp.getActiveSpreadsheet();var meta=ss.getSheetByName(SHEETS.META);if(!meta)return 0;var val=meta.getRange('B1').getValue();return val?Number(val):0;}
function bumpTimestamp(){var ss=SpreadsheetApp.getActiveSpreadsheet();var meta=ss.getSheetByName(SHEETS.META)||ss.insertSheet(SHEETS.META);meta.getRange('A1').setValue('lastTimestamp');meta.getRange('B1').setValue(Date.now());}

// ─────────────────────────────────────────────────────────────
// INITIALISATION DES ONGLETS
// ─────────────────────────────────────────────────────────────
function initSheets(){
  var ss=SpreadsheetApp.getActiveSpreadsheet();
  var S={bg:'#1e1e2e',color:'#a6e3a1',bold:true};
  Object.keys(SCHEMAS).forEach(function(name){
    var schema=SCHEMAS[name],sheet=ss.getSheetByName(name);
    if(!sheet){
      sheet=ss.insertSheet(name);sheet.appendRow(schema);sheet.setFrozenRows(1);
      sheet.getRange(1,1,1,schema.length).setBackground(S.bg).setFontColor(S.color).setFontWeight('bold');
    }else{
      var lastCol=Math.max(sheet.getLastColumn(),1);
      var existing=sheet.getRange(1,1,1,lastCol).getValues()[0].map(String);
      schema.forEach(function(col){
        if(existing.indexOf(col)===-1){
          var newCol=existing.length+1;
          sheet.getRange(1,newCol).setValue(col).setBackground(S.bg).setFontColor(S.color).setFontWeight('bold');
          existing.push(col);
        }
      });
    }
  });
  var meta=ss.getSheetByName(SHEETS.META);
  if(!meta){meta=ss.insertSheet(SHEETS.META);meta.appendRow(['lastTimestamp','value']);}
  if(!meta.getRange('B1').getValue()){meta.getRange('A1').setValue('lastTimestamp');meta.getRange('B1').setValue(Date.now());}
}

// ─────────────────────────────────────────────────────────────
// UTILITAIRES DATES
// ─────────────────────────────────────────────────────────────
function formatDateValue(val){
  if(!val&&val!==0)return'';
  if(val instanceof Date){return val.getUTCFullYear()+'-'+String(val.getUTCMonth()+1).padStart(2,'0')+'-'+String(val.getUTCDate()).padStart(2,'0');}
  if(typeof val==='number'){return formatDateValue(new Date(Math.round((val-25569)*86400000)));}
  var s=String(val).trim();if(!s)return'';
  if(/^\d{4}-\d{2}-\d{2}/.test(s))return s.slice(0,10);
  var m=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if(m)return m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
  return s;
}
function formatTimeValue(val){
  if(!val&&val!==0)return'';
  if(val instanceof Date)return String(val.getHours()).padStart(2,'0')+':'+String(val.getMinutes()).padStart(2,'0');
  if(typeof val==='number'&&val<1){var t=Math.round(val*1440);return String(Math.floor(t/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0');}
  var s=String(val).trim();if(/^\d{1,2}:\d{2}$/.test(s))return s.length===4?'0'+s:s;return s;
}
function formatDateTimeValue(val){
  if(!val&&val!==0)return'';
  if(val instanceof Date){var dp=formatDateValue(val),tp=String(val.getHours()).padStart(2,'0')+':'+String(val.getMinutes()).padStart(2,'0');return dp+(tp!=='00:00'?'T'+tp:'');}
  if(typeof val==='number')return formatDateTimeValue(new Date(Math.round((val-25569)*86400000)));
  var s=String(val).trim();if(!s)return'';
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s))return s.slice(0,16);
  if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;
  return s;
}
// ─────────────────────────────────────────────────────────────
// GÉOCODAGE PROXY — Nominatim via UrlFetchApp (pas de CORS côté serveur)
// ─────────────────────────────────────────────────────────────

/**
 * Géocode une adresse via Nominatim côté serveur.
 * Appel : GET ?action=geocode&q=12+rue+des+Sports+Bordeaux
 * Réponse : { lat: 44.83, lon: -0.57 } ou { error: "..." }
 */
function geocodeProxy(address) {
  if (!address || address.length < 4) return { error: 'Adresse trop courte' };
  var url = 'https://nominatim.openstreetmap.org/search?format=json&q='
    + encodeURIComponent(address) + '&limit=1&accept-language=fr';
  try {
    var resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'SportSync/1.0 (contact@sportsync.app)' },
    });
    var code = resp.getResponseCode();
    if (code !== 200) return { error: 'Nominatim HTTP ' + code };
    var data = JSON.parse(resp.getContentText());
    if (!data || !data.length) return { error: 'Adresse introuvable' };
    return { lat: Number(data[0].lat), lon: Number(data[0].lon), display: data[0].display_name };
  } catch(e) {
    return { error: e.message };
  }
}

/**
 * Géocode une liste d'adresses en une seule requête GAS.
 * Appel : GET ?action=geocodeBatch&addresses=addr1|addr2|addr3
 * Réponse : { results: [{ idx, lat, lon } | { idx, error }] }
 * Respecte la limite Nominatim : 1 req/s (Utilities.sleep entre les requêtes).
 */
function geocodeBatchProxy(addressesStr) {
  if (!addressesStr) return { results: [] };
  var addresses = addressesStr.split('|').map(function(a){ return a.trim(); });
  var results = [];
  for (var i = 0; i < addresses.length; i++) {
    if (i > 0) Utilities.sleep(1100); // Nominatim : max 1 req/s
    var r = geocodeProxy(addresses[i]);
    r.idx = i;
    results.push(r);
  }
  return { results: results };
}

function generateId(){return String(Date.now())+String(Math.floor(Math.random()*9000+1000));}
function jsonResponse(data){return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);}

// ─────────────────────────────────────────────────────────────
// SESSIONS RÉCURRENTES
// ─────────────────────────────────────────────────────────────

/**
 * Crée une session récurrente dans l'onglet Sessions avec
 * les champs de récurrence : recurrenceDay, recurrenceSlot, recurrenceWeeks.
 *
 * body = {
 *   sessionId,   // ID maître de la récurrence (ex: "recurring_padel_lundi")
 *   sport,
 *   venue,
 *   address,
 *   recurrenceDay,    // 1=Lun, 2=Mar, ..., 7=Dim
 *   recurrenceSlot,   // 'morning'|'afternoon'|'evening'
 *   recurrenceWeeks,  // nombre de semaines à générer (ex: 8)
 *   maxPlayers,
 *   ownerEmail,
 * }
 *
 * Génère N occurrences dans l'onglet Sessions, chacune avec
 * son propre sessionId = parentId + "_" + dateISO.
 */
function createRecurringSession(body) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SESSIONS);
  var parentId = body.sessionId || ('recurring_' + generateId());
  var nbWeeks  = Number(body.recurrenceWeeks) || 4;
  var dow      = Number(body.recurrenceDay)   || 1; // 1=Lun (ISO)

  // Trouver la prochaine occurrence du jour demandé
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var diff = (dow - today.getDay() + 7) % 7 || 7; // au moins 1 semaine
  var startDate = new Date(today);
  startDate.setDate(today.getDate() + diff);

  var created = [];
  for (var w = 0; w < nbWeeks; w++) {
    var occDate = new Date(startDate);
    occDate.setDate(startDate.getDate() + w * 7);
    var occDateStr = formatDateValue(occDate);
    var occId      = parentId + '_' + occDateStr;
    var now        = new Date().toISOString();

    sheet.appendRow([
      generateId(), occId,
      body.sport    || '',
      'open',
      body.venue    || '',
      occDateStr,
      Number(body.maxPlayers) || 10,
      now,
      body.ownerEmail || '',
    ]);

    if (body.ownerEmail) linkUserToSession(body.ownerEmail, occId);
    created.push(occId);
  }

  bumpTimestamp();
  return { ok: true, parentId: parentId, sessions: created, timestamp: getTimestamp() };
}
