/* Instinct Dashboard API - Cloudflare Worker
 *
 * Bindings (set in Worker Settings):
 *   KV             - KV namespace binding (variable name KV)
 *   API_KEY        - secret: agent API key for action apiUpdate
 *   ALLOWED_EMAILS - var: comma-separated emails allowed to sign in
 *   CLIENT_ID      - var: Google OAuth Web client ID (public, verifies ID tokens)
 *
 * API contract (same as the Apps Script version):
 *   GET  ?action=ping
 *   GET  ?action=list&session=...
 *   POST {action:'authToken', id_token}        -> {ok, session, email}
 *   POST {action:'authLogout', session}
 *   POST {action:'apiUpdate', apiKey, ops:[...]}
 *   POST {action:'setPriority'|'resolveTask'|'reopenTask'|'addNote', session, ...}
 *
 * No secrets in this file. Data lives in the KV namespace.
 */

const SESSION_TTL_SEC = 12 * 60 * 60; // 12 hours
const MAX_LOG_ROWS = 500;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const ALLOWED_ORIGINS = [
  'https://avishorwork-wq.github.io',
  'http://localhost:8000'
];

function json(obj, origin, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(origin)
    }
  });
}

function corsHeaders(origin) {
  const h = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400'
  };
  if (origin && ALLOWED_ORIGINS.indexOf(origin) >= 0) {
    h['access-control-allow-origin'] = origin;
  }
  return h;
}

function nowIso() {
  return new Date().toISOString();
}

async function getData(env) {
  const d = await env.KV.get('data', 'json');
  return d || { projects: [], tasks: [], logs: [], files: [] };
}

async function putData(env, data) {
  await env.KV.put('data', JSON.stringify(data));
}

async function sessionEmail(env, token) {
  if (!token) return null;
  return await env.KV.get('s_' + token);
}

async function verifyGoogleToken(env, idToken) {
  if (!idToken) return null;
  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!res.ok) return null;
  const info = await res.json();
  if (!info || info.aud !== env.CLIENT_ID) return null;
  const email = (info.email || '').toLowerCase();
  const allowed = (env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!email || allowed.indexOf(email) < 0) return null;
  if (String(info.email_verified) !== 'true') return null;
  return email;
}

/* ---------- ops ---------- */

function applyOp(data, op) {
  const name = (op && op.op) || '';
  const ts = nowIso();

  if (name === 'upsertProject') {
    if (!op.id || !op.name) return { ok: false, error: 'missing_fields' };
    const ex = data.projects.find(p => String(p.id) === String(op.id));
    if (ex) {
      ex.name = String(op.name);
      if (op.status) ex.status = String(op.status);
      ex.updated_at = ts;
    } else {
      data.projects.push({ id: String(op.id), name: String(op.name), status: String(op.status || 'active'), created_at: ts, updated_at: ts });
    }
    return { ok: true, op: name, id: op.id };
  }

  if (name === 'upsertTask') {
    if (!op.id || !op.title) return { ok: false, error: 'missing_fields' };
    const ext = data.tasks.find(t => String(t.id) === String(op.id));
    if (ext) {
      if (op.title) ext.title = String(op.title);
      if (op.notes !== undefined) ext.notes = String(op.notes);
      if (op.priority && PRIORITIES.indexOf(op.priority) >= 0) ext.priority = op.priority;
      if (op.status) writeStatus(ext, String(op.status), ts);
      ext.updated_at = ts;
    } else {
      const st = String(op.status || 'open');
      const t = {
        id: String(op.id), project_id: String(op.project_id || ''), title: String(op.title),
        notes: String(op.notes || ''), priority: PRIORITIES.indexOf(op.priority) >= 0 ? op.priority : 'normal',
        status: st, created_at: ts, started_at: st === 'in_progress' ? ts : '',
        resolved_at: st === 'resolved' ? ts : '', updated_at: ts
      };
      data.tasks.push(t);
    }
    return { ok: true, op: name, id: op.id };
  }

  if (name === 'setPriority') {
    if (PRIORITIES.indexOf(op.priority) < 0) return { ok: false, error: 'bad_priority' };
    const t = data.tasks.find(t => String(t.id) === String(op.id));
    if (!t) return { ok: false, error: 'not_found' };
    t.priority = op.priority;
    t.updated_at = ts;
    return { ok: true, op: name, id: op.id };
  }

  if (name === 'resolveTask' || name === 'reopenTask') {
    const t = data.tasks.find(t => String(t.id) === String(op.id));
    if (!t) return { ok: false, error: 'not_found' };
    writeStatus(t, name === 'resolveTask' ? 'resolved' : 'open', ts);
    t.updated_at = ts;
    return { ok: true, op: name, id: op.id };
  }

  if (name === 'note') {
    const t = data.tasks.find(t => String(t.id) === String(op.id));
    if (!t) return { ok: false, error: 'not_found' };
    t.notes = String(op.notes || '');
    t.updated_at = ts;
    return { ok: true, op: name, id: op.id };
  }

  if (name === 'log') {
    data.logs.push({
      ts: ts, project_id: String(op.project_id || ''), task_id: String(op.task_id || ''),
      level: String(op.level || 'info'), message: String(op.message || '').slice(0, 1000)
    });
    if (data.logs.length > MAX_LOG_ROWS) data.logs = data.logs.slice(data.logs.length - MAX_LOG_ROWS);
    return { ok: true, op: name };
  }

  if (name === 'registerFile') {
    if (!op.name || !op.url) return { ok: false, error: 'missing_fields' };
    data.files.push({
      id: crypto.randomUUID(), name: String(op.name), drive_file_id: String(op.drive_file_id || ''),
      url: String(op.url), mime_type: String(op.mime_type || ''), added_at: ts, note: String(op.note || '')
    });
    return { ok: true, op: name, name: op.name };
  }

  return { ok: false, error: 'unknown_op', op: name };
}

function writeStatus(t, st, ts) {
  t.status = st;
  if (st === 'in_progress' && !t.started_at) t.started_at = ts;
  if (st === 'resolved') t.resolved_at = ts;
  if (st === 'open') t.resolved_at = '';
}

/* ---------- entry ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === 'GET') {
      const action = url.searchParams.get('action') || '';
      if (action === 'ping') {
        return json({ ok: true, service: 'instinct-dashboard', ts: nowIso() }, origin);
      }
      if (action === 'list') {
        const email = await sessionEmail(env, url.searchParams.get('session') || '');
        if (!email) return json({ ok: false, error: 'auth' }, origin);
        const data = await getData(env);
        const logs = data.logs.slice(-MAX_LOG_ROWS).reverse(); // newest first
        return json({ ok: true, email: email, data: { ...data, logs, ts: nowIso() } }, origin);
      }
      return json({ ok: false, error: 'unknown_action' }, origin);
    }

    if (request.method !== 'POST') return json({ ok: false, error: 'method' }, origin, 405);

    let body = {};
    try {
      body = await request.json();
    } catch (err) {
      return json({ ok: false, error: 'bad_json' }, origin);
    }
    const action = (body.action || '').toString();

    if (action === 'authToken') {
      const email = await verifyGoogleToken(env, body.credential || body.id_token || '');
      if (!email) return json({ ok: false, error: 'auth' }, origin);
      const token = crypto.randomUUID() + crypto.randomUUID();
      await env.KV.put('s_' + token, email, { expirationTtl: SESSION_TTL_SEC });
      return json({ ok: true, session: token, ttl: SESSION_TTL_SEC, email: email }, origin);
    }

    if (action === 'authLogout') {
      if (body.session) await env.KV.delete('s_' + body.session);
      return json({ ok: true }, origin);
    }

    // Agent API: secret-key writes.
    if (action === 'apiUpdate') {
      if (!env.API_KEY || !body.apiKey || body.apiKey !== env.API_KEY) {
        return json({ ok: false, error: 'auth' }, origin);
      }
      const ops = Array.isArray(body.ops) ? body.ops : [];
      if (ops.length > 100) return json({ ok: false, error: 'too_many_ops' }, origin);
      const data = await getData(env);
      const results = ops.map(op => applyOp(data, op));
      await putData(env, data);
      return json({ ok: true, results: results }, origin);
    }

    // Owner session actions.
    const email = await sessionEmail(env, body.session);
    if (!email) return json({ ok: false, error: 'auth' }, origin);
    const data = await getData(env);
    let result;
    if (action === 'setPriority') result = applyOp(data, { op: 'setPriority', id: body.id, priority: body.priority });
    else if (action === 'resolveTask') result = applyOp(data, { op: 'resolveTask', id: body.id });
    else if (action === 'reopenTask') result = applyOp(data, { op: 'reopenTask', id: body.id });
    else if (action === 'addNote') result = applyOp(data, { op: 'note', id: body.id, notes: body.notes });
    else return json({ ok: false, error: 'unknown_action' }, origin);
    if (result.ok) await putData(env, data);
    return json(result, origin);
  }
};
