/* Dashboard UI logic. */
(function () {
  var state = { data: null, project: 'all', pollTimer: null, tickTimer: null, v: null, expanded: {} };
  var VER_MS = 30000; // cheap version poll; full data only loads when the version changes

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtElapsed(fromIso, toIso) {
    if (!fromIso) return '';
    var ms = new Date(toIso || Date.now()) - new Date(fromIso);
    if (isNaN(ms) || ms < 0) return '';
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }
  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  /* ---------- rendering ---------- */

  function projectName(id) {
    var p = (state.data.projects || []).find(function (x) { return String(x.id) === String(id); });
    return p ? p.name : (id || '');
  }

  function render() {
    var d = state.data;
    if (!d) return;
    var tasks = d.tasks || [];
    var open = tasks.filter(function (t) { return t.status !== 'resolved'; });

    // Sidebar
    var counts = {};
    open.forEach(function (t) { counts[t.project_id] = (counts[t.project_id] || 0) + 1; });
    var html = '<button class="proj-item' + (state.project === 'all' ? ' active' : '') + '" data-p="all">All projects' +
      '<span class="count">' + open.length + '</span></button>';
    (d.projects || []).forEach(function (p) {
      html += '<button class="proj-item' + (state.project === String(p.id) ? ' active' : '') + '" data-p="' + esc(p.id) + '">' +
        esc(p.name) + '<span class="count">' + (counts[p.id] || 0) + '</span></button>';
    });
    $('projects').innerHTML = html;
    Array.prototype.forEach.call($('projects').querySelectorAll('.proj-item'), function (b) {
      b.onclick = function () { state.project = b.getAttribute('data-p'); render(); };
    });

    // Tasks
    var sel = state.project === 'all' ? tasks : tasks.filter(function (t) { return String(t.project_id) === state.project; });
    var prioRank = { urgent: 0, high: 1, normal: 2, low: 3 };
    sel = sel.slice().sort(function (a, b) {
      var ra = a.status === 'resolved' ? 1 : 0, rb = b.status === 'resolved' ? 1 : 0;
      if (ra !== rb) return ra - rb;
      var pa = prioRank[a.priority] != null ? prioRank[a.priority] : 2;
      var pb = prioRank[b.priority] != null ? prioRank[b.priority] : 2;
      if (pa !== pb) return pa - pb;
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
    $('project-title').textContent = state.project === 'all' ? 'All projects' : projectName(state.project);
    $('tasks').innerHTML = sel.length ? sel.map(taskHtml).join('') : '<div class="empty">No tasks here yet.</div>';
    bindTaskActions();
    renderProjectSummary();

    // Files
    var files = d.files || [];
    $('files').innerHTML = files.length ? files.map(function (f) {
      return '<div class="file-row"><a href="' + esc(f.url) + '" target="_blank" rel="noopener">' + esc(f.name) + '</a>' +
        '<span class="when">' + esc(fmtWhen(f.added_at)) + '</span></div>';
    }).join('') : '<div class="empty">No files shared yet.</div>';

    // Logs
    var logs = d.logs || [];
    if (state.project !== 'all') logs = logs.filter(function (l) { return String(l.project_id) === state.project; });
    $('logs').innerHTML = logs.length ? logs.slice(0, 500).map(function (l) {
      return '<div class="log-row"><span class="ts">' + esc(fmtWhen(l.ts)) + '</span>' +
        '<span class="lvl ' + esc(l.level || 'info') + '">' + esc(l.level || 'info') + '</span>' +
        '<span class="msg">' + esc(l.message) + '</span></div>';
    }).join('') : '<div class="empty">No activity yet.</div>';

    $('last-sync').textContent = 'Updated ' + fmtWhen(d.ts);
  }

  function safeLink(url) { return /^https?:\/\//i.test(String(url || '')) ? esc(url) : '#'; }
  function linkHtml(links) { return (links || []).map(function(l){return '<a target="_blank" rel="noopener noreferrer" href="'+safeLink(l.url)+'">'+esc(l.label || l.name || l.url)+'</a>';}).join(' · '); }
  function fullTime(iso) { return iso ? esc(new Date(iso).toLocaleString()) : 'Not yet'; }
  function resultHtml(result) {
    if(!result || (!result.url && !result.summary)) return '';
    return '<div class="result-box"><strong>Result</strong><p>'+esc(result.summary || '')+'</p>'+(result.url?'<a href="'+safeLink(result.url)+'" target="_blank" rel="noopener noreferrer">'+esc(result.url)+'</a>':'')+'</div>';
  }
  function galleryHtml(images) {
    if(!images.length) return '<p class="empty">No images shared yet.</p>';
    return '<div class="image-gallery">'+images.map(function(i){
      var valid=/^https:\/\//i.test(i.src) || /^data:image\/(jpeg|png|webp);base64,/.test(i.src);
      if(!valid) return '';
      return '<figure><a href="'+esc(i.src)+'" target="_blank" rel="noopener noreferrer"><img loading="lazy" src="'+esc(i.src)+'" alt="'+esc(i.caption || 'Shared image')+'"></a><figcaption>'+esc(i.caption || '')+'<small>'+fullTime(i.added_at)+'</small></figcaption></figure>';
    }).join('')+'</div>';
  }
  function renderProjectSummary() {
    var box = $('project-summary');
    if (!box) { box = document.createElement('div'); box.id='project-summary'; $('project-title').after(box); }
    var projects = state.project === 'all' ? state.data.projects : state.data.projects.filter(function(p){return p.id === state.project;});
    box.innerHTML = projects.map(function(p){
      var tasks=state.data.tasks.filter(function(t){return t.project_id===p.id;});
      var done=tasks.filter(function(t){return t.status==='resolved';}).length;
      var active=tasks.filter(function(t){return t.status==='in_progress';}).length;
      var blocked=tasks.filter(function(t){return t.status==='blocked';}).length;
      var percent=tasks.length ? Math.round(done/tasks.length*100) : 0;
      return '<div class="project-summary"><strong>'+esc(p.name)+'</strong><span>'+done+' of '+tasks.length+' done · '+active+' active · '+blocked+' blocked · '+percent+'%</span><progress max="100" value="'+percent+'"></progress>'+(p.details ? '<p>'+esc(p.details)+'</p>' : '')+(p.status_text ? '<p>'+esc(p.status_text)+'</p>':'')+linkHtml(p.links)+resultHtml(p.result)+'</div>';
    }).join('');
    var gallery=$('project-gallery'); if(!gallery) {gallery=document.createElement('section');gallery.id='project-gallery';$('files-section').before(gallery);}
    gallery.innerHTML='<h3>Project gallery</h3>'+galleryHtml((state.data.images || []).filter(function(i){return state.project==='all' || i.project_id===state.project;}));
  }
  function taskHtml(t) {
    var resolved=t.status==='resolved';
    var owner=t.owner || ((t.notes || '').match(/^Owner: ([^\n]+)/) || [null,'Not assigned'])[1];
    var progress=t.progress !== undefined ? t.progress : (resolved ? 100 : 0);
    var opts=['low','normal','high','urgent'].map(function(p){return '<option value="'+p+'"'+(t.priority===p?' selected':'')+'>'+p+'</option>';}).join('');
    var timeline=(t.history || []).slice().reverse().map(function(h){
      return '<li><time>'+fullTime(h.ts)+'</time> <strong>'+esc(h.actor || 'Instinct')+'</strong> '+esc(h.action)+'<ul>'+Object.keys(h.changes || {}).map(function(k){var c=h.changes[k];return '<li>'+esc(k)+': '+esc(typeof c.to==='object'?JSON.stringify(c.to):c.to)+'</li>';}).join('')+'</ul></li>';
    }).join('');
    var notes=(t.note_history || []).slice().reverse().map(function(n){return '<li><time>'+fullTime(n.ts)+'</time> '+esc(n.author || '')+'<p>'+esc(n.text)+'</p></li>';}).join('');
    var sub=(t.substeps || []).map(function(x){return '<li>'+esc(x.status || (x.done?'resolved':'open'))+' · '+esc(x.title || x.text || '')+(x.details?'<p>'+esc(x.details)+'</p>':'')+'</li>';}).join('');
    var reasoning=(t.reasoning || []).slice().reverse().map(function(r){
      return '<li><time>'+fullTime(r.ts)+'</time><p><strong>'+esc(r.decision)+'</strong></p><p>Why: '+esc(r.why)+'</p>'+['alternatives','assumptions','open_questions','outcome'].filter(function(k){return r[k]!==undefined;}).map(function(k){return '<p>'+esc(k.replace(/_/g,' '))+': '+esc(Array.isArray(r[k])?r[k].join('; '):r[k])+'</p>';}).join('')+'</li>';
    }).join('');
    var linked=(t.links || []).concat((state.data.files || []).filter(function(f){return f.task_id===t.id;}));
    return '<div class="task'+(resolved?' resolved':'')+'" data-id="'+esc(t.id)+'">'+
      '<div class="task-head"><div class="task-title">'+esc(t.title)+'<span class="proj-tag">'+esc(projectName(t.project_id))+'</span></div><span class="badge '+esc(t.priority || 'normal')+'">'+esc(t.priority || 'normal')+'</span><span class="status-pill">'+esc(t.status)+'</span></div>'+
      '<div class="task-meta">Owner: '+esc(owner)+' · '+progress+'% complete · Updated '+fullTime(t.updated_at)+'</div>'+
      (t.status_text?'<p class="status-text">'+esc(t.status_text)+'</p>':'')+
      '<progress max="100" value="'+Number(progress)+'"></progress>'+resultHtml(t.result)+
      '<details class="task-detail"'+(state.expanded[t.id]?' open':'')+'><summary>Task details, notes and timeline</summary>'+
      '<dl><dt>ID</dt><dd>'+esc(t.id)+'</dd><dt>Created</dt><dd>'+fullTime(t.created_at)+'</dd><dt>Started</dt><dd>'+fullTime(t.started_at)+'</dd><dt>Resolved</dt><dd>'+fullTime(t.resolved_at)+'</dd><dt>Age</dt><dd class="elapsed" data-from="'+esc(t.created_at)+'" data-to="'+esc(t.resolved_at || '')+'"></dd><dt>Elapsed since start (includes pauses)</dt><dd>'+(t.started_at?'<span class="elapsed" data-from="'+esc(t.started_at)+'" data-to="'+esc(t.resolved_at || '')+'"></span>':'Not started')+'</dd><dt>Estimate</dt><dd>'+(t.estimated_minutes?esc(t.estimated_minutes)+' min':'Not set')+'</dd></dl>'+
      '<h4>Details</h4><p class="prewrap">'+esc(t.details || 'No extra details yet.')+'</p>'+
      '<h4>Notes</h4>'+(notes?'<ol class="timeline">'+notes+'</ol>':'<p class="prewrap">'+esc(t.notes || 'No notes yet.')+'</p>')+
      '<h4>Links and files</h4>'+(linked.length?linkHtml(linked):'<p>None yet.</p>')+
      '<h4>Sub-steps</h4>'+(sub?'<ul>'+sub+'</ul>':'<p>No sub-steps yet.</p>')+
      '<h4>Images and screenshots</h4>'+galleryHtml((state.data.images || []).filter(function(i){return i.task_id===t.id;}))+
      '<h4>Decisions &amp; reasoning</h4>'+(reasoning?'<ol class="timeline">'+reasoning+'</ol>':'<p>No decision summaries yet.</p>')+
      '<h4>History</h4>'+(timeline?'<ol class="timeline">'+timeline+'</ol>':'<p>No recorded history before detailed tracking was enabled.</p>')+
      '</details><div class="task-actions"><button class="btn '+(resolved?'reopen':'resolve')+'" data-act="'+(resolved?'reopen':'resolve')+'">'+(resolved?'Reopen':'Resolve')+'</button><select class="prio" data-act="prio">'+opts+'</select><input class="note-input" placeholder="Add a timestamped note" data-act="note"><button class="btn ghost" data-act="addnote">Add</button></div></div>';
  }

  function tick() {
    Array.prototype.forEach.call(document.querySelectorAll('.elapsed'), function (el) {
      el.textContent = fmtElapsed(el.getAttribute('data-from'), el.getAttribute('data-to'));
    });
  }

  function bindTaskActions() {
    Array.prototype.forEach.call(document.querySelectorAll('.task'), function (card) {
      var id = card.getAttribute('data-id');
      var detail=card.querySelector('details'); if(detail) detail.ontoggle=function(){state.expanded[id]=detail.open;};
      var noteInput = card.querySelector('input[data-act="note"]');
      Array.prototype.forEach.call(card.querySelectorAll('[data-act]'), function (el) {
        var act = el.getAttribute('data-act');
        if (act === 'resolve') el.onclick = function () { doAction('resolveTask', { id: id }); };
        if (act === 'reopen') el.onclick = function () { doAction('reopenTask', { id: id }); };
        if (act === 'prio') el.onchange = function () { doAction('setPriority', { id: id, priority: el.value }); };
        if (act === 'addnote') el.onclick = function () {
          var v = noteInput.value.trim();
          if (v) doAction('addNote', { id: id, notes: v });
        };
      });
    });
  }

  async function doAction(action, payload) {
    var r = await DashAuth.call(action, payload);
    if (!r || !r.ok) { alert('That did not go through (' + (r && r.error || 'network') + '). Try again.'); return; }
    await refresh();
  }

  async function refresh() {
    var eb = $('app-error');
    var r;
    try {
      r = await DashAuth.call('list');
    } catch (e) {
      if (eb) { eb.hidden = false; eb.textContent = 'Could not load data (' + (e && e.message || 'network') + '). Retrying in the background...'; }
      return;
    }
    if (!r || !r.ok) {
      if (r && r.error === 'auth') { showGate(); return; }
      if (eb) { eb.hidden = false; eb.textContent = 'Could not load data (' + ((r && r.error) || 'network') + '). Retrying in the background...'; }
      return;
    }
    if (eb) eb.hidden = true;
    if (r.v !== undefined) state.v = r.v;
    state.data = r.data;
    try {
      render();
      tick();
    } catch (e) {
      if (eb) { eb.hidden = false; eb.textContent = 'Display error (' + (e && e.message || 'error') + '). Try reloading the page.'; }
    }
  }

  /* ---------- gate / boot ---------- */

  function showGate() {
    if(socket) socket.close(); clearTimeout(reconnectTimer);
    $('app').hidden = true;
    $('gate').style.display = 'flex';
    clearInterval(state.pollTimer); clearInterval(state.tickTimer);
    var err = $('gate-error');
    err.hidden = true;
    DashAuth.renderSignIn($('signin-btn'), function () { enter(); }, function (e) {
      err.hidden = false;
      err.textContent = e && e.message === 'not_allowed'
        ? 'This Google account is not approved for this dashboard. Pick a different Google account and try again.'
        : 'Sign-in did not complete (' + (e && e.message || 'error') + '). Try again.';
    });
  }

  /* Lightweight change detector: one tiny GET every few seconds while the tab
     is visible; full data loads only when the server's version counter moves. */
  async function checkVersion(force) {
    if (!DashAuth.isSignedIn()) return;
    if (!force && document.visibilityState !== 'visible') return;
    try {
      var r = await fetch((window.DASH_CONFIG || {}).endpoint + '?action=version').then(function (x) { return x.json(); });
      if (!r || r.v === undefined) return;
      if (state.v === null) { await refresh(); return; }
      if (force || r.v !== state.v || !state.data) await refresh();
    } catch (e) { /* offline or sleeping - next tick retries */ }
  }

  var socket=null, reconnectTimer=null, reconnectDelay=1000;
  function connectLive() {
    if (!DashAuth.isSignedIn() || document.visibilityState !== 'visible') return;
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
    clearTimeout(reconnectTimer);
    socket = new WebSocket(DashAuth.watchUrl());
    socket.onopen = function(){ reconnectDelay=1000; checkVersion(true); };
    socket.onmessage = function(event){
      try { var msg=JSON.parse(event.data); if(msg.v !== state.v) refresh(); } catch (_) {}
    };
    socket.onclose = function(){ socket=null; if(DashAuth.isSignedIn() && document.visibilityState==='visible') { reconnectTimer=setTimeout(connectLive,reconnectDelay); reconnectDelay=Math.min(30000,reconnectDelay*2); } };
    socket.onerror = function(){ try {socket.close();} catch (_){} };
  }
  function enter() {
    $('gate').style.display = 'none';
    $('app').hidden = false;
    $('who').textContent = DashAuth.email() || '';
    refresh();
    connectLive();
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(checkVersion, VER_MS);
    clearInterval(state.tickTimer);
    state.tickTimer = setInterval(tick, 1000);
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('signout').onclick = async function () { await DashAuth.signOut(); showGate(); };
    if ((window.DASH_CONFIG || {}).endpoint === 'PENDING_DEPLOYMENT') {
      var err = $('gate-error');
      err.hidden = false;
      err.textContent = 'Dashboard backend is not connected yet. Check back soon.';
      return;
    }
    window.addEventListener('online', function () { checkVersion(true); connectLive(); });
    window.addEventListener('pageshow', function () { checkVersion(true); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { checkVersion(true); connectLive(); } else if(socket) socket.close();
    });
    if (DashAuth.isSignedIn()) enter(); else showGate();
  });
})();
