/**
 * Instinct Dashboard backend (Google Apps Script web app).
 *
 * Script Properties (set in Project Settings):
 *   SHEET_ID       - private Google Sheet that stores all dashboard data
 *   API_KEY        - secret key for agent API updates (action apiUpdate)
 *   ALLOWED_EMAILS - comma-separated emails allowed to sign in
 *   CLIENT_ID      - Google OAuth Web client ID (public, used to verify ID tokens)
 *
 * No secrets in this file. Data stays in the private sheet.
 */

var SESSION_TTL_SEC = 12 * 60 * 60; // 12 hours
var MAX_LOG_ROWS = 500;

function props() {
  return PropertiesService.getScriptProperties().getProperties();
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function nowIso() {
  return new Date().toISOString();
}

/* ---------- entry points ---------- */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = (p.action || '').toString();
  if (action === 'ping') {
    return json({ ok: true, service: 'instinct-dashboard', ts: nowIso() });
  }
  if (action === 'list') {
    var email = sessionEmail(p.session);
    if (!email) return json({ ok: false, error: 'auth' });
    return json({ ok: true, email: email, data: readAll() });
  }
  return json({ ok: false, error: 'unknown_action' });
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json({ ok: false, error: 'bad_json' });
  }
  var action = (body.action || '').toString();

  // Sign-in: verify a Google ID token, return a session.
  if (action === 'authToken') return authToken_(body);
  if (action === 'authLogout') {
    if (body.session) CacheService.getScriptCache().remove('s_' + body.session);
    return json({ ok: true });
  }

  // Agent API: secret-key writes.
  if (action === 'apiUpdate') {
    var P = props();
    if (!P.API_KEY || !body.apiKey || body.apiKey !== P.API_KEY) {
      return json({ ok: false, error: 'auth' });
    }
    var ops = Array.isArray(body.ops) ? body.ops : [];
    if (ops.length > 100) return json({ ok: false, error: 'too_many_ops' });
    var results = ops.map(function (op) { return applyOp_(op); });
    return json({ ok: true, results: results });
  }

  // Owner session actions.
  var email = sessionEmail(body.session);
  if (!email) return json({ ok: false, error: 'auth' });
  if (action === 'list') return json({ ok: true, email: email, data: readAll() });
  if (action === 'setPriority') return applyOp_({ op: 'setPriority', id: body.id, priority: body.priority });
  if (action === 'resolveTask') return applyOp_({ op: 'resolveTask', id: body.id });
  if (action === 'reopenTask') return applyOp_({ op: 'reopenTask', id: body.id });
  if (action === 'addNote') return applyOp_({ op: 'note', id: body.id, notes: body.notes });
  return json({ ok: false, error: 'unknown_action' });
}

/* ---------- auth ---------- */

function authToken_(body) {
  var P = props();
  var cred = (body.credential || '').toString();
  if (!cred) return json({ ok: false, error: 'missing_credential' });
  var resp;
  try {
    resp = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred),
      { muteHttpExceptions: true });
  } catch (err) {
    return json({ ok: false, error: 'verify_failed' });
  }
  if (resp.getResponseCode() !== 200) return json({ ok: false, error: 'verify_failed' });
  var info = JSON.parse(resp.getContentText());
  if (info.aud !== P.CLIENT_ID) return json({ ok: false, error: 'wrong_audience' });
  var email = (info.email || '').toLowerCase();
  var allowed = (P.ALLOWED_EMAILS || '').toLowerCase().split(',').map(function (s) { return s.trim(); });
  if (!email || allowed.indexOf(email) === -1) return json({ ok: false, error: 'not_allowed' });
  if (String(info.email_verified) !== 'true') return json({ ok: false, error: 'not_allowed' });
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('s_' + token, email, SESSION_TTL_SEC);
  return json({ ok: true, session: token, ttl: SESSION_TTL_SEC, email: email });
}

function sessionEmail(token) {
  if (!token) return null;
  return CacheService.getScriptCache().get('s_' + token);
}

/* ---------- sheet access ---------- */

function sheet_(name) {
  return SpreadsheetApp.openById(props().SHEET_ID).getSheetByName(name);
}

function rows_(name) {
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0];
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = {};
    var empty = true;
    for (var j = 0; j < head.length; j++) {
      var v = values[i][j];
      if (v !== '' && v !== null) empty = false;
      row[head[j]] = (v instanceof Date) ? v.toISOString() : v;
    }
    if (!empty) { row._row = i + 1; out.push(row); }
  }
  return out;
}

function readAll() {
  var logs = rows_('logs');
  if (logs.length > MAX_LOG_ROWS) logs = logs.slice(logs.length - MAX_LOG_ROWS);
  logs.reverse(); // newest first
  return {
    projects: rows_('projects'),
    tasks: rows_('tasks'),
    logs: logs,
    files: rows_('files'),
    ts: nowIso()
  };
}

function findRow_(name, id) {
  var rows = rows_(name);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(id)) return rows[i];
  }
  return null;
}

/* ---------- write ops ---------- */

var PRIORITIES = ['low', 'normal', 'high', 'urgent'];

function applyOp_(op) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return applyOpLocked_(op || {});
  } catch (err) {
    return { ok: false, error: 'exception', detail: String(err) };
  } finally {
    lock.releaseLock();
  }
}

function applyOpLocked_(op) {
  var name = op.op || '';
  var ts = nowIso();

  if (name === 'upsertProject') {
    if (!op.id || !op.name) return { ok: false, error: 'missing_fields' };
    var ex = findRow_('projects', op.id);
    var sh = sheet_('projects');
    if (ex) {
      sh.getRange(ex._row, 2).setValue(String(op.name));
      if (op.status) sh.getRange(ex._row, 3).setValue(String(op.status));
      sh.getRange(ex._row, 5).setValue(ts);
    } else {
      sh.appendRow([String(op.id), String(op.name), String(op.status || 'active'), ts, ts]);
    }
    return { ok: true, op: name, id: op.id };
  }

  if (name === 'upsertTask') {
    if (!op.id || !op.title) return { ok: false, error: 'missing_fields' };
    var ext = findRow_('tasks', op.id);
    var sht = sheet_('tasks');
    if (ext) {
      if (op.title) sht.getRange(ext._row, 3).setValue(String(op.title));
      if (op.notes !== undefined) sht.getRange(ext._row, 4).setValue(String(op.notes));
      if (op.priority && PRIORITIES.indexOf(op.priority) >= 0) sht.getRange(ext._row, 5).setValue(op.priority);
      if (op.status) writeStatus_(sht, ext._row, String(op.status), ts);
      sht.getRange(ext._row, 10).setValue(ts);
    } else {
      var st = String(op.status || 'open');
      sht.appendRow([
        String(op.id), String(op.project_id || ''), String(op.title),
        String(op.notes || ''), PRIORITIES.indexOf(op.priority) >= 0 ? op.priority : 'normal',
        st, ts, st === 'in_progress' ? ts : '', st === 'resolved' ? ts : '', ts
      ]);
    }
    return { ok: true, op: name, id: op.id };
  }

  if (name === 'setPriority') {
    if (PRIORITIES.indexOf(op.priority) < 0) return { ok: false, error: 'bad_priority' };
    var t = findRow_('tasks', op.id);
    if (!t) return { ok: false, error: 'not_found' };
    var sh2 = sheet_('tasks');
    sh2.getRange(t._row, 5).setValue(op.priority);
    sh2.getRange(t._row, 10).setValue(ts);
    return { ok: true, op: name, id: op.id };
  }

  if (name === 'resolveTask' || name === 'reopenTask') {
    var t2 = findRow_('tasks', op.id);
    if (!t2) return { ok: false, error: 'not_found' };
    var sh3 = sheet_('tasks');
    writeStatus_(sh3, t2._row, name === 'resolveTask' ? 'resolved' : 'open', ts);
    sh3.getRange(t2._row, 10).setValue(ts);
    return { ok: true, op: name, id: op.id };
  }

  if (name === 'note') {
    var t3 = findRow_('tasks', op.id);
    if (!t3) return { ok: false, error: 'not_found' };
    var sh4 = sheet_('tasks');
    var existing = String(t3.notes || '');
    var stamp = '[' + ts.slice(0, 16).replace('T', ' ') + '] ';
    var combined = existing ? existing + '\n' + stamp + String(op.notes || '') : stamp + String(op.notes || '');
    sh4.getRange(t3._row, 4).setValue(combined);
    sh4.getRange(t3._row, 10).setValue(ts);
    return { ok: true, op: name, id: op.id };
  }

  if (name === 'log') {
    sheet_('logs').appendRow([
      ts, String(op.project_id || ''), String(op.task_id || ''),
      String(op.level || 'info'), String(op.message || '').slice(0, 1000)
    ]);
    return { ok: true, op: name };
  }

  if (name === 'registerFile') {
    if (!op.name || !op.url) return { ok: false, error: 'missing_fields' };
    sheet_('files').appendRow([
      Utilities.getUuid(), String(op.name), String(op.drive_file_id || ''),
      String(op.url), String(op.mime_type || ''), ts, String(op.note || '')
    ]);
    return { ok: true, op: name, name: op.name };
  }

  return { ok: false, error: 'unknown_op' };
}

function writeStatus_(sh, row, status, ts) {
  sh.getRange(row, 6).setValue(status);
  if (status === 'in_progress') sh.getRange(row, 8).setValue(ts);
  if (status === 'resolved') sh.getRange(row, 9).setValue(ts);
  if (status === 'open') sh.getRange(row, 9).setValue('');
}
