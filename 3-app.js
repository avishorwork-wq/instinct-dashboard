/* Dashboard UI logic. */
(function () {
  var state = { data: null, project: null, v: null, expanded: {}, doneOpen: false, logFilter: 'all' };
  var receivedAt = null, connection = 'Connecting', refreshBusy = false, refreshAgain = false;
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
  function fullTime(iso) { return iso ? esc(new Date(iso).toLocaleString()) : 'Not yet'; }
  function safeLink(url) { return /^https?:\/\//i.test(String(url || '')) ? esc(url) : '#'; }
  function linkHtml(links) {
    return (links || []).map(function (l) {
      return '<a target="_blank" rel="noopener noreferrer" href="' + safeLink(l.url) + '">' + esc(l.label || l.name || l.url) + '</a>';
    }).join(' · ');
  }

  function projectName(id) {
    var p = (state.data.projects || []).find(function (x) { return String(x.id) === String(id); });
    return p ? p.name : (id || '');
  }
  function byUpdated(a, b) {
    return String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at));
  }

  /* ---------- shared fragments ---------- */

  function noteHtml(n) {
    return '<li class="request-note"><time>' + fullTime(n.ts) + '</time><span class="note-author">' + esc(n.author || '') + '</span>' +
      (n.state ? ' <span class="status-pill ' + (n.state === 'open' ? 'open' : 'resolved') + '">' + (n.state === 'open' ? 'Open request' : 'Answered') + '</span>' : '') +
      '<p class="prewrap">' + esc(n.text || '') + '</p>' +
      (n.image ? galleryHtml([{ src: n.image, caption: 'Note attachment', added_at: n.ts }]) : '') +
      (n.replies || []).map(function (r) {
        return '<div class="note-reply"><small>' + fullTime(r.ts) + ' · Instinct</small><p class="prewrap">' + esc(r.text) + '</p>' +
          (r.image ? galleryHtml([{ src: r.image, caption: 'Reply attachment', added_at: r.ts }]) : '') + '</div>';
      }).join('') + '</li>';
  }
  function noteThread(history) {
    if (!history || !history.length) return '';
    return '<ol class="note-thread">' + history.slice().reverse().map(noteHtml).join('') + '</ol>';
  }
  async function compressedAttachment(file) {
    if (!file) return '';
    if (!/^image\//.test(file.type)) throw new Error('Choose an image file');
    var url = URL.createObjectURL(file);
    try {
      var img = new Image(); img.src = url; await img.decode();
      var scale = Math.min(1, 1200 / img.width, 1200 / img.height);
      var canvas = document.createElement('canvas');
      canvas.width = img.width * scale; canvas.height = img.height * scale;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      for (var q of [0.8, 0.6, 0.4, 0.2]) {
        var data = canvas.toDataURL('image/jpeg', q);
        if (data.length <= 110000) return data;
      }
      throw new Error('Image too large. Try a smaller crop.');
    } finally { URL.revokeObjectURL(url); }
  }
  function resultHtml(result) {
    if (!result || (!result.url && !result.summary)) return '';
    return '<div class="result-box"><strong>Result</strong><p>' + esc(result.summary || '') + '</p>' +
      (result.url ? '<a href="' + safeLink(result.url) + '" target="_blank" rel="noopener noreferrer">' + esc(result.url) + '</a>' : '') + '</div>';
  }
  function galleryHtml(images) {
    if (!images.length) return '<p class="empty">No images shared yet.</p>';
    return '<div class="image-gallery">' + images.map(function (i) {
      var valid = /^https:\/\//i.test(i.src) || /^data:image\/(jpeg|png|webp);base64,/.test(i.src);
      if (!valid) return '';
      return '<figure><a href="' + esc(i.src) + '" target="_blank" rel="noopener noreferrer"><img loading="lazy" src="' + esc(i.src) + '" alt="' + esc(i.caption || 'Shared image') + '"></a><figcaption>' + esc(i.caption || '') + '<small>' + fullTime(i.added_at) + '</small></figcaption></figure>';
    }).join('') + '</div>';
  }
  function stepsHtml(substeps) {
    if (!substeps || !substeps.length) return '';
    var lis = substeps.map(function (x) {
      var st = x.status || (x.done ? 'resolved' : 'open');
      var done = st === 'resolved' || st === 'done';
      var doing = st === 'in_progress';
      var cls = done ? 'done' : (doing ? 'doing' : '');
      var mark = done ? '✓' : (doing ? '…' : '');
      return '<li class="' + cls + '"><span class="step-check">' + mark + '</span><span><span class="step-title">' +
        esc(x.title || x.text || '') + '</span>' +
        (x.details ? '<div class="step-details">' + esc(x.details) + '</div>' : '') + '</span></li>';
    }).join('');
    var doneCount = substeps.filter(function (x) { var st = x.status || (x.done ? 'resolved' : 'open'); return st === 'resolved' || st === 'done'; }).length;
    return '<ul class="steps">' + lis + '</ul>' +
      '<div class="task-meta">' + doneCount + ' of ' + substeps.length + ' steps done</div>';
  }

  /* ---------- Happening now ---------- */

  function renderNow() {
    var d = state.data;
    var working = (d.tasks || []).filter(function (t) { return t.status === 'in_progress'; })
      .sort(function (a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); });
    if (!working.length) {
      $('now').innerHTML = '<div class="now-empty">Nothing running right this second. Open items are listed per project below.</div>';
      return;
    }
    $('now').innerHTML = working.map(function (t) {
      return '<div class="now-card"><div class="nc-proj">' + esc(projectName(t.project_id)) + '</div>' +
        '<div class="nc-title">' + esc(t.title) + '</div>' +
        (t.status_text ? '<div class="nc-status">' + esc(t.status_text) + '</div>' : '') +
        '<div class="nc-time">Started ' + esc(fmtWhen(t.started_at || t.created_at)) +
        (t.started_at ? ' · running <span class="elapsed" data-from="' + esc(t.started_at) + '" data-to=""></span>' : '') + '</div></div>';
    }).join('');
  }

  /* ---------- Project nav ---------- */

  function renderNav() {
    var d = state.data;
    var open = (d.tasks || []).filter(function (t) { return t.status !== 'resolved'; });
    var counts = {};
    open.forEach(function (t) { counts[t.project_id] = (counts[t.project_id] || 0) + 1; });
    var html = '<button class="proj-item' + (state.project === 'all' ? ' active' : '') + '" data-p="all">All projects' +
      '<span class="count">' + open.length + '</span></button>';
    (d.projects || []).slice().sort(byUpdated).forEach(function (p) {
      var pstatus = p.status === 'in_progress' ? 'in_progress' : (p.status === 'active' ? 'active' : 'complete');
      html += '<button class="proj-item' + (state.project === String(p.id) ? ' active' : '') + '" data-p="' + esc(p.id) + '">' +
        '<span class="pstatus ' + pstatus + '"></span>' + esc(p.name) + '<span class="count">' + (counts[p.id] || 0) + '</span></button>';
    });
    $('projects').innerHTML = html;
    Array.prototype.forEach.call($('projects').querySelectorAll('.proj-item'), function (b) {
      b.onclick = function () { state.project = b.getAttribute('data-p'); render(); };
    });
  }

  /* ---------- Project header ---------- */

  function renderProjectHead() {
    var d = state.data;
    var projects = state.project === 'all' ? [] : (d.projects || []).filter(function (p) { return String(p.id) === state.project; });
    if (state.project === 'all') {
      var allTasks = d.tasks || [];
      var doneAll = allTasks.filter(function (t) { return t.status === 'resolved'; }).length;
      $('project-head').innerHTML = '<div class="proj-head"><h2>All projects</h2>' +
        '<div class="proj-stats"><span><b>' + (allTasks.length - doneAll) + '</b> open tasks</span><span><b>' + doneAll + '</b> done</span><span><b>' + (d.projects || []).length + '</b> projects</span></div></div>';
      return;
    }
    $('project-head').innerHTML = projects.map(function (p) {
      var tasks = (d.tasks || []).filter(function (t) { return String(t.project_id) === String(p.id); });
      var done = tasks.filter(function (t) { return t.status === 'resolved'; }).length;
      var active = tasks.filter(function (t) { return t.status === 'in_progress'; }).length;
      var openCount = tasks.length - done;
      var percent = tasks.length ? Math.round(done / tasks.length * 100) : 0;
      return '<div class="proj-head"><h2>' + esc(p.name) + ' <span class="status-pill ' + esc(p.status === 'in_progress' ? 'in_progress' : (p.status === 'complete' || p.status === 'closed' ? 'resolved' : 'open')) + '">' + esc(p.status || 'active') + '</span></h2>' +
        (p.status_text ? '<p class="ph-status-line">' + esc(p.status_text) + '</p>' : '') +
        (p.details ? '<p class="ph-details prewrap">' + esc(p.details) + '</p>' : '') +
        '<div class="proj-stats"><span><b>' + done + '</b> of <b>' + tasks.length + '</b> done</span><span><b>' + active + '</b> in progress</span><span><b>' + openCount + '</b> open</span><span>' + percent + '%</span></div>' +
        '<progress max="100" value="' + percent + '"></progress>' +
        (p.links && p.links.length ? '<div class="ph-links">' + linkHtml(p.links) + '</div>' : '') +
        resultHtml(p.result) +
        '<div class="task-detail"><details><summary>Project notes &amp; requests</summary>' +
        (noteThread(p.note_history) || '<p class="empty">No notes yet.</p>') +
        '<div class="note-form"><input class="note-input" id="project-note-' + esc(p.id) + '" placeholder="Add a project note or request">' +
        '<input type="file" accept="image/*" id="project-image-' + esc(p.id) + '">' +
        '<button class="btn ghost" data-project-note="' + esc(p.id) + '">Add note</button></div></details></div></div>';
    }).join('');
    Array.prototype.forEach.call($('project-head').querySelectorAll('[data-project-note]'), function (b) {
      b.onclick = async function () {
        try {
          b.disabled = true;
          var input = $('project-note-' + b.getAttribute('data-project-note'));
          var image = await compressedAttachment($('project-image-' + b.getAttribute('data-project-note')).files[0]);
          await doAction('addRequest', { project_id: b.getAttribute('data-project-note'), text: input.value.trim(), image: image });
        } catch (e) { alert(e.message); } finally { b.disabled = false; }
      };
    });
  }

  /* ---------- Tasks ---------- */

  function taskHtml(t) {
    var resolved = t.status === 'resolved';
    var owner = t.owner || ((t.notes || '').match(/^Owner: ([^\n]+)/) || [null, 'Not assigned'])[1];
    var progress = t.progress !== undefined ? t.progress : (resolved ? 100 : 0);
    var opts = ['low', 'normal', 'high', 'urgent'].map(function (p) {
      return '<option value="' + p + '"' + (t.priority === p ? ' selected' : '') + '>' + p + '</option>';
    }).join('');
    var timeline = (t.history || []).slice().reverse().map(function (h) {
      return '<li><time>' + fullTime(h.ts) + '</time><strong>' + esc(h.actor || 'Instinct') + '</strong> ' + esc(h.action) +
        '<ul>' + Object.keys(h.changes || {}).map(function (k) {
          var c = h.changes[k];
          return '<li>' + esc(k) + ': ' + esc(typeof c.to === 'object' ? JSON.stringify(c.to) : c.to) + '</li>';
        }).join('') + '</ul></li>';
    }).join('');
    var reasoning = (t.reasoning || []).slice().reverse().map(function (r) {
      return '<li><time>' + fullTime(r.ts) + '</time><p><strong>' + esc(r.decision) + '</strong></p><p>Why: ' + esc(r.why) + '</p>' +
        ['alternatives', 'assumptions', 'open_questions', 'outcome'].filter(function (k) { return r[k] !== undefined; }).map(function (k) {
          return '<p>' + esc(k.replace(/_/g, ' ')) + ': ' + esc(Array.isArray(r[k]) ? r[k].join('; ') : r[k]) + '</p>';
        }).join('') + '</li>';
    }).join('');
    var linked = (t.links || []).concat((state.data.files || []).filter(function (f) { return f.task_id === t.id; }));
    return '<div class="task' + (resolved ? ' resolved' : '') + '" data-id="' + esc(t.id) + '" data-priority="' + esc(t.priority || 'normal') + '">' +
      '<div class="task-head"><div class="task-title">' + esc(t.title) + '</div>' +
      '<span class="badge ' + esc(t.priority || 'normal') + '">' + esc(t.priority || 'normal') + '</span>' +
      '<span class="status-pill ' + esc(t.status) + '">' + esc(t.status.replace(/_/g, ' ')) + '</span></div>' +
      '<div class="task-meta">' + esc(projectName(t.project_id)) + ' · Owner: ' + esc(owner) + ' · ' + progress + '% · Updated ' + fullTime(t.updated_at) + '</div>' +
      (t.status_text ? '<p class="status-text">' + esc(t.status_text) + '</p>' : '') +
      '<progress max="100" value="' + Number(progress) + '"></progress>' +
      resultHtml(t.result) +
      stepsHtml(t.substeps) +
      '<details class="task-detail"' + (state.expanded[t.id] ? ' open' : '') + '><summary>Details, notes, links and history</summary>' +
      '<dl><dt>Created</dt><dd>' + fullTime(t.created_at) + '</dd><dt>Started</dt><dd>' + fullTime(t.started_at) + '</dd><dt>Resolved</dt><dd>' + fullTime(t.resolved_at) + '</dd>' +
      '<dt>Elapsed</dt><dd>' + (t.started_at ? '<span class="elapsed" data-from="' + esc(t.started_at) + '" data-to="' + esc(t.resolved_at || '') + '"></span>' : 'Not started') + '</dd>' +
      (t.estimated_minutes ? '<dt>Estimate</dt><dd>' + esc(t.estimated_minutes) + ' min</dd>' : '') +
      '<dt>ID</dt><dd>' + esc(t.id) + '</dd></dl>' +
      '<h4>Details</h4><p class="prewrap">' + esc(t.details || 'No extra details yet.') + '</p>' +
      '<h4>Notes &amp; requests</h4>' + (noteThread(t.note_history) || '<p class="prewrap">' + esc(t.notes || 'No notes yet.') + '</p>') +
      '<div class="note-form"><input class="note-input" placeholder="Add a note or request" data-note-text>' +
      '<input type="file" accept="image/*" data-note-image><button class="btn ghost" data-act="addnote">Add</button></div>' +
      '<h4>Links and files</h4>' + (linked.length ? linkHtml(linked) : '<p>None yet.</p>') +
      '<h4>Images and screenshots</h4>' + galleryHtml((state.data.images || []).filter(function (i) { return i.task_id === t.id; })) +
      '<h4>Decisions &amp; reasoning</h4>' + (reasoning ? '<ol class="timeline">' + reasoning + '</ol>' : '<p>No decision summaries yet.</p>') +
      '<h4>History</h4>' + (timeline ? '<ol class="timeline">' + timeline + '</ol>' : '<p>No recorded history before detailed tracking was enabled.</p>') +
      '</details>' +
      '<div class="task-actions"><button class="btn ' + (resolved ? 'reopen' : 'resolve') + '" data-act="' + (resolved ? 'reopen' : 'resolve') + '">' + (resolved ? 'Reopen' : 'Resolve') + '</button>' +
      '<select class="prio" data-act="prio">' + opts + '</select></div></div>';
  }

  function renderTasks() {
    var d = state.data;
    var tasks = d.tasks || [];
    var sel = state.project === 'all' ? tasks : tasks.filter(function (t) { return String(t.project_id) === state.project; });
    var prioRank = { urgent: 0, high: 1, normal: 2, low: 3 };
    function sorter(a, b) {
      var pa = prioRank[a.priority] != null ? prioRank[a.priority] : 2;
      var pb = prioRank[b.priority] != null ? prioRank[b.priority] : 2;
      if (pa !== pb) return pa - pb;
      return String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''));
    }
    var open = sel.filter(function (t) { return t.status !== 'resolved'; }).sort(sorter);
    var done = sel.filter(function (t) { return t.status === 'resolved'; }).sort(function (a, b) {
      return String(b.resolved_at || b.updated_at || '').localeCompare(String(a.resolved_at || a.updated_at || ''));
    });
    $('open-title').innerHTML = 'Open <span class="n">(' + open.length + ')</span>';
    $('tasks-open').innerHTML = open.length ? open.map(taskHtml).join('') : '<div class="empty">Nothing open here.</div>';
    var dt = $('done-title');
    dt.innerHTML = 'Done <span class="n">(' + done.length + ')</span>';
    dt.className = 'section-title done-toggle' + (state.doneOpen ? ' open' : '');
    $('tasks-done').style.display = state.doneOpen ? '' : 'none';
    $('tasks-done').innerHTML = done.length ? done.map(taskHtml).join('') : '<div class="empty">Nothing finished yet.</div>';
    dt.onclick = function () { state.doneOpen = !state.doneOpen; renderTasks(); };
    bindTaskActions();
  }

  function bindTaskActions() {
    Array.prototype.forEach.call(document.querySelectorAll('.task'), function (card) {
      var id = card.getAttribute('data-id');
      var detail = card.querySelector('details');
      if (detail) detail.ontoggle = function () { state.expanded[id] = detail.open; };
      Array.prototype.forEach.call(card.querySelectorAll('[data-act]'), function (el) {
        var act = el.getAttribute('data-act');
        if (act === 'resolve') el.onclick = function () { doAction('resolveTask', { id: id }); };
        if (act === 'reopen') el.onclick = function () { doAction('reopenTask', { id: id }); };
        if (act === 'prio') el.onchange = function () { doAction('setPriority', { id: id, priority: el.value }); };
        if (act === 'addnote') el.onclick = async function () {
          try {
            el.disabled = true;
            var noteInput = card.querySelector('[data-note-text]');
            var image = await compressedAttachment(card.querySelector('[data-note-image]').files[0]);
            var v = noteInput.value.trim();
            if (v || image) await doAction('addRequest', { task_id: id, text: v, image: image });
          } catch (e) { alert(e.message); } finally { el.disabled = false; }
        };
      });
    });
  }

  /* ---------- Activity & fix log ---------- */

  function renderLogs() {
    var d = state.data;
    var logs = d.logs || [];
    if (state.project !== 'all') logs = logs.filter(function (l) { return String(l.project_id) === state.project; });
    var filters = [['all', 'All'], ['fix', 'Fixes'], ['done', 'Done'], ['info', 'Info']];
    $('log-filters').innerHTML = filters.map(function (f) {
      return '<button class="log-filter' + (state.logFilter === f[0] ? ' active' : '') + '" data-lf="' + f[0] + '">' + f[1] + '</button>';
    }).join('');
    Array.prototype.forEach.call($('log-filters').querySelectorAll('.log-filter'), function (b) {
      b.onclick = function () { state.logFilter = b.getAttribute('data-lf'); renderLogs(); };
    });
    var shown = state.logFilter === 'all' ? logs : logs.filter(function (l) { return (l.level || 'info') === state.logFilter; });
    $('logs').innerHTML = shown.length ? shown.slice(0, 300).map(function (l) {
      var lvl = l.level || 'info';
      return '<div class="log-row' + (lvl === 'fix' ? ' log-fix' : '') + '"><span class="ts">' + esc(fmtWhen(l.ts)) + '</span>' +
        '<span class="lvl ' + esc(lvl) + '">' + esc(lvl) + '</span>' +
        '<span class="msg">' + esc(l.message) + '</span></div>';
    }).join('') : '<div class="empty">No activity yet.</div>';
  }

  /* ---------- Gallery & files ---------- */

  function renderGalleryFiles() {
    var d = state.data;
    var images = (d.images || []).filter(function (i) {
      return state.project === 'all' || i.project_id === state.project;
    });
    $('gallery').innerHTML = galleryHtml(images);
    var files = d.files || [];
    $('files').innerHTML = files.length ? files.map(function (f) {
      return '<div class="file-row"><a href="' + safeLink(f.url) + '" target="_blank" rel="noopener">' + esc(f.name) + '</a>' +
        '<span class="when">' + esc(fmtWhen(f.added_at)) + '</span></div>';
    }).join('') : '<div class="empty">No files shared yet.</div>';
  }

  function render() {
    var d = state.data;
    if (!d) return;
    if (state.project === null) {
      var withOpen = (d.projects || []).slice().sort(byUpdated).find(function (p) {
        return (d.tasks || []).some(function (t) { return String(t.project_id) === String(p.id) && t.status !== 'resolved'; });
      });
      var newest = (d.projects || []).slice().sort(byUpdated)[0];
      state.project = String((withOpen || newest || { id: 'all' }).id);
    }
    renderNow();
    renderNav();
    renderProjectHead();
    renderTasks();
    renderLogs();
    renderGalleryFiles();
    updateSync();
  }

  function tick() {
    Array.prototype.forEach.call(document.querySelectorAll('.elapsed'), function (el) {
      el.textContent = fmtElapsed(el.getAttribute('data-from'), el.getAttribute('data-to'));
    });
  }

  async function doAction(action, payload) {
    var r = await DashAuth.call(action, payload);
    if (!r || !r.ok) { alert('That did not go through (' + (r && r.error || 'network') + '). Try again.'); return; }
    await refresh();
  }

  function updateSync() {
    var el = $('last-sync'); if (!el) return;
    el.textContent = connection + (receivedAt ? ' · updated ' + new Date(receivedAt).toLocaleTimeString() : '');
    var dot = $('live-dot');
    if (dot) dot.className = 'live-dot' + (connection === 'Live connected' ? ' live' : (connection.indexOf('Offline') >= 0 ? ' off' : ''));
  }

  async function refresh() {
    if (refreshBusy) { refreshAgain = true; return; }
    refreshBusy = true;
    try { await refreshNow(); } finally { refreshBusy = false; if (refreshAgain) { refreshAgain = false; refresh(); } }
  }
  async function refreshNow() {
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
    state.data = r.data; receivedAt = Date.now();
    try {
      render();
      tick();
    } catch (e) {
      if (eb) { eb.hidden = false; eb.textContent = 'Display error (' + (e && e.message || 'error') + '). Try reloading the page.'; }
    }
  }

  /* ---------- gate / boot ---------- */

  function showGate() {
    if (socket) socket.close(); clearTimeout(reconnectTimer);
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
      receivedAt = Date.now(); updateSync();
      if (state.v === null) { await refresh(); return; }
      if (force || r.v !== state.v || !state.data) await refresh();
    } catch (e) { connection = 'Offline / retrying'; updateSync(); }
  }

  var socket = null, reconnectTimer = null, reconnectDelay = 1000;
  function connectLive() {
    if (!DashAuth.isSignedIn() || document.visibilityState !== 'visible') return;
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
    clearTimeout(reconnectTimer);
    connection = 'Connecting'; updateSync();
    socket = new WebSocket(DashAuth.watchUrl());
    socket.onopen = function () { connection = 'Live connected'; updateSync(); reconnectDelay = 1000; checkVersion(true); };
    socket.onmessage = function (event) {
      try { var msg = JSON.parse(event.data); if (msg.v !== state.v) refresh(); } catch (_) {}
    };
    socket.onclose = function () {
      connection = 'Reconnecting (30s safety check)'; updateSync(); socket = null;
      if (DashAuth.isSignedIn() && document.visibilityState === 'visible') { reconnectTimer = setTimeout(connectLive, reconnectDelay); reconnectDelay = Math.min(30000, reconnectDelay * 2); }
    };
    socket.onerror = function () { try { socket.close(); } catch (_) {} };
  }
  function enter() {
    $('gate').style.display = 'none';
    $('app').hidden = false;
    $('who').textContent = DashAuth.email() || '';
    $('refresh-now').onclick = function () { refresh(); connectLive(); };
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
      if (document.visibilityState === 'visible') { checkVersion(true); connectLive(); } else if (socket) socket.close();
    });
    if (DashAuth.isSignedIn()) enter(); else showGate();
  });
})();
