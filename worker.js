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

async function getVersion(env) {
  return parseInt(await env.KV.get('v')) || 0;
}

async function putData(env, data) {
  await env.KV.put('data', JSON.stringify(data));
  // Bump the change counter so clients polling ?action=version see the write.
  await env.KV.put('v', String((await getVersion(env)) + 1));
}

async function sessionEmail(env, token) {
  if (!token) return null;
  return await env.KV.get('s_' + token);
}

/* Returns {email} on success, or {reason:'not_allowed'|'bad_token', email?} on failure. */
async function verifyGoogleToken(env, idToken) {
  if (!idToken) return { reason: 'bad_token' };
  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!res.ok) return { reason: 'bad_token' };
  const info = await res.json();
  if (!info || info.aud !== env.CLIENT_ID) return { reason: 'bad_token' };
  const email = (info.email || '').toLowerCase();
  const allowed = (env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!email || allowed.indexOf(email) < 0) return { reason: 'not_allowed', email: email || undefined };
  if (String(info.email_verified) !== 'true') return { reason: 'bad_token' };
  return { email: email };
}

/* ---------- ops ---------- */

function applyOp(data, op) {
  const ts = nowIso();
  const before = data.tasks.find(t => t.id === op.id);
  const old = before ? JSON.parse(JSON.stringify(before)) : null;
  const result = applyOpRaw(data, op);
  if (!result.ok) return result;
  const t = data.tasks.find(t => t.id === op.id);
  if (t && ['upsertTask','setPriority','resolveTask','reopenTask','note'].includes(op.op)) {
    if (op.op === 'upsertTask') {
      for (const key of ['owner','details','status_text','project_id','started_at','resolved_at','created_at','links','substeps','estimated_minutes']) {
        if (op[key] !== undefined) t[key] = op[key];
      }
      if (op.progress !== undefined) t.progress = Math.max(0, Math.min(100, Number(op.progress) || 0));
      if (op.notes !== undefined && (!old || old.notes !== op.notes)) {
        t.note_history = t.note_history || [];
        t.note_history.push({ts,text:String(op.notes),author:op.author || 'Instinct'});
      }
    }
    if (t.status === 'resolved') t.progress = 100;
    t.history = t.history || [];
    const changes = {};
    for (const key of ['title','status','priority','owner','details','status_text','progress','notes','links','substeps']) {
      if (JSON.stringify(old && old[key]) !== JSON.stringify(t[key])) changes[key] = {from:old ? old[key] : null,to:t[key]};
    }
    t.history.push({ts,action:op.op,actor:op.author || 'Instinct',changes});
    t.updated_at = ts;
    data.logs.push({ts,project_id:t.project_id,task_id:t.id,level:t.status === 'resolved' ? 'done' : 'info',message:t.title + ': ' + (op.status_text || (op.op === 'note' ? 'note added' : Object.keys(changes).join(', ') + ' updated'))});
    if (data.logs.length > MAX_LOG_ROWS) data.logs = data.logs.slice(-MAX_LOG_ROWS);
  }
  if (op.op === 'upsertProject') {
    const p = data.projects.find(p => p.id === op.id);
    for (const key of ['details','owner','links','status_text']) if (op[key] !== undefined) p[key] = op[key];
  }
  return result;
}

function applyOpRaw(data, op) {
  const name = (op && op.op) || '';
  const ts = nowIso();

  if (name === 'addImage') {
    const t = data.tasks.find(t => t.id === op.task_id);
    const project = data.projects.find(p => p.id === (op.project_id || (t && t.project_id)));
    if (!t && !project) return {ok:false,error:'not_found'};
    const src = String(op.data || op.url || '');
    if (!/^https:\/\//i.test(src) && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) return {ok:false,error:'invalid_image'};
    if (src.length > 110000) return {ok:false,error:'image_too_large_max_110000_chars'};
    data.images = data.images || [];
    if (data.images.length >= 60 || JSON.stringify(data.images).length + src.length > 3000000) return {ok:false,error:'gallery_limit'};
    const image = {id:op.id || crypto.randomUUID(),task_id:t ? t.id : '',project_id:project ? project.id : t.project_id,caption:String(op.caption || ''),src,added_at:ts};
    const index = data.images.findIndex(i => i.id === image.id);
    if (index >= 0) data.images[index] = image; else data.images.push(image);
    if(t) t.updated_at=ts;
    data.logs.push({ts,project_id:image.project_id,task_id:image.task_id,level:'info',message:'Image added: '+(image.caption || 'Screenshot')});
    return {ok:true,op:name,id:image.id};
  }
  if (name === 'setResult') {
    const target = op.task_id ? data.tasks.find(t => t.id === op.task_id) : data.projects.find(p => p.id === op.project_id);
    if (!target) return {ok:false,error:'not_found'};
    target.result={url:String(op.url || ''),summary:String(op.summary || ''),updated_at:ts}; target.updated_at=ts;
    data.logs.push({ts,project_id:op.project_id || target.project_id,task_id:op.task_id || '',level:'done',message:'Result: '+target.result.summary});
    return {ok:true,op:name};
  }
  if (name === 'reasoning') {
    const t = data.tasks.find(t => t.id === (op.task_id || op.id));
    if (!t || !op.decision || !op.why) return {ok:false,error:t ? 'missing_fields' : 'not_found'};
    const entry = {ts,decision:String(op.decision),why:String(op.why),author:op.author || 'Instinct'};
    for (const key of ['alternatives','assumptions','open_questions','outcome']) if (op[key] !== undefined) entry[key] = op[key];
    t.reasoning = t.reasoning || []; t.reasoning.push(entry); t.updated_at = ts;
    data.logs.push({ts,task_id:t.id,project_id:t.project_id,level:'info',message:'Decision: '+entry.decision+' - '+entry.why});
    return {ok:true,op:name,id:t.id};
  }
  if (name === 'deleteProjectCascade') {
    const ids = new Set(data.tasks.filter(t => t.project_id === op.id).map(t => t.id));
    data.projects = data.projects.filter(p => p.id !== op.id);
    data.tasks = data.tasks.filter(t => t.project_id !== op.id);
    data.logs = data.logs.filter(l => l.project_id !== op.id && !ids.has(l.task_id));
    data.files = data.files.filter(f => f.project_id !== op.id && !ids.has(f.task_id));
    data.images = (data.images || []).filter(f => f.project_id !== op.id && !ids.has(f.task_id));
    return {ok:true,op:name,id:op.id};
  }
  if (name === 'deleteProject') { data.projects = data.projects.filter(p => p.id !== op.id); return {ok:true,op:name}; }
  if (name === 'deleteTask') { data.tasks = data.tasks.filter(t => t.id !== op.id); return {ok:true,op:name}; }
  if (name === 'deleteTestLog') { data.logs = data.logs.filter(l => l.message !== op.message); return {ok:true,op:name}; }
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
    if (!op.id || (!op.title && !data.tasks.some(t => t.id === op.id))) return { ok: false, error: 'missing_fields' };
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
    t.note_history = t.note_history || [];
    t.note_history.push({ts, text:t.notes, author:op.author || 'Avi'});
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

const handler = {
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
      if (action === 'version') {
        return json({ ok: true, v: await getVersion(env) }, origin);
      }
      if (action === 'list') {
        const email = await sessionEmail(env, url.searchParams.get('session') || '');
        if (!email) return json({ ok: false, error: 'auth' }, origin);
        const data = await getData(env);
        const logs = data.logs.slice(-MAX_LOG_ROWS).reverse(); // newest first
        return json({ ok: true, email: email, v: await getVersion(env), data: { ...data, logs, ts: nowIso() } }, origin);
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
      const v = await verifyGoogleToken(env, body.credential || body.id_token || '');
      if (v.reason || !v.email) return json({ ok: false, error: v.reason === 'not_allowed' ? 'not_allowed' : 'auth' }, origin);
      const token = crypto.randomUUID() + crypto.randomUUID();
      await env.KV.put('s_' + token, v.email, { expirationTtl: SESSION_TTL_SEC });
      return json({ ok: true, session: token, ttl: SESSION_TTL_SEC, email: v.email }, origin);
    }

    if (action === 'authLogout') {
      if (body.session) await env.KV.delete('s_' + body.session);
      return json({ ok: true }, origin);
    }

    if (action === 'listNotes') {
      if (!env.API_KEY || body.apiKey !== env.API_KEY) return json({ok:false,error:'auth'},origin);
      const data=await getData(env), since=body.since || '';
      const notes=[];
      for(const type of ['tasks','projects']) for(const item of data[type]) for(const note of item.note_history || []) {
        if(note.ts > since && (!body.author || note.author === body.author)) notes.push({...note,type:type==='tasks'?'task':'project',id:item.id,title:item.title || item.name,project_id:item.project_id || item.id});
      }
      notes.sort((a,b)=>a.ts.localeCompare(b.ts));
      return json({ok:true,notes,ts:nowIso()},origin);
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
    if (action === 'list') {
      const logs = data.logs.slice(-MAX_LOG_ROWS).reverse(); // newest first
      return json({ ok: true, email: email, v: await getVersion(env), data: { ...data, logs, ts: nowIso() } }, origin);
    }
    let result;
    if (action === 'setPriority') result = applyOp(data, { op: 'setPriority', id: body.id, priority: body.priority });
    else if (action === 'resolveTask') result = applyOp(data, { op: 'resolveTask', id: body.id });
    else if (action === 'reopenTask') result = applyOp(data, { op: 'reopenTask', id: body.id });
    else if (action === 'addNote') result = applyOp(data, { op: 'note', id: body.id, notes: body.notes, author:'Avi' });
    else if (action === 'addProjectNote') {
      const p=data.projects.find(p=>p.id===body.id);
      if(!p) return json({ok:false,error:'not_found'},origin);
      const ts=nowIso(); p.note_history=p.note_history || []; p.note_history.push({ts,author:'Avi',text:String(body.notes || '')});p.updated_at=ts;data.logs.push({ts,project_id:p.id,level:'info',message:'Avi added a project note: '+String(body.notes || '')});result={ok:true};
    }
    else return json({ ok: false, error: 'unknown_action' }, origin);
    if (result.ok) await putData(env, data);
    return json(result, origin);
  }
};

// One strongly consistent SQLite-backed object. Sessions remain in the original
// KV namespace so existing phone sign-ins keep working.
export class DashboardState {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const storage = this.ctx.storage;
    const url = new URL(request.url);
    if (url.searchParams.get('action') === 'watch') {
      const email = await sessionEmail(this.env, url.searchParams.get('session'));
      if (!email) return new Response('Unauthorized', {status:401});
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('WebSocket required',{status:426});
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({v:await storage.get('v') || 0}));
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    const oldKV = this.env.KV;
    const adapter = {
      get: async (key, type) => {
        if (key !== 'data' && key !== 'v') return oldKV.get(key, type);
        let value;
        if (key === 'data') { const count = await storage.get('data_chunks') || 0; if(count) { const parts=[]; for(let i=0;i<count;i++) parts.push(await storage.get('data_'+i) || ''); value=parts.join(''); } else value=await storage.get(key); } else value=await storage.get(key);
        return type === 'json' && value ? JSON.parse(value) : (value || null);
      },
      put: async (key, value, opts) => {
        if (key !== 'data' && key !== 'v') return oldKV.put(key, value, opts);
        if(key==='data') { const count=Math.ceil(value.length/50000); for(let i=0;i<count;i++) await storage.put('data_'+i,value.slice(i*50000,(i+1)*50000)); await storage.put('data_chunks',count); } else await storage.put(key, value);
        if (key === 'v') for (const socket of this.ctx.getWebSockets()) {
          try { socket.send(JSON.stringify({v:Number(value)})); } catch (_) { }
        }
      },
      delete: async (key) => oldKV.delete(key)
    };
    return handler.fetch(request, { ...this.env, KV: adapter });
  }
  webSocketMessage(ws, message) { if (message === 'ping') ws.send('pong'); }
  webSocketClose(ws, code, reason) { ws.close(code, reason); }
  webSocketError(ws) { try { ws.close(1011, 'Reconnect'); } catch (_) {} }
}
export default {
  fetch(request, env) {
    return env.STATE.get(env.STATE.idFromName('dashboard-owner')).fetch(request);
  }
};
