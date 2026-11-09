/* Dashboard UI logic. */
(function () {
  var state = { data: null, project: 'all', pollTimer: null, tickTimer: null };
  var POLL_MS = 60000;

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

    // Files
    var files = d.files || [];
    $('files').innerHTML = files.length ? files.map(function (f) {
      return '<div class="file-row"><a href="' + esc(f.url) + '" target="_blank" rel="noopener">' + esc(f.name) + '</a>' +
        '<span class="when">' + esc(fmtWhen(f.added_at)) + '</span></div>';
    }).join('') : '<div class="empty">No files shared yet.</div>';

    // Logs
    var logs = d.logs || [];
    if (state.project !== 'all') logs = logs.filter(function (l) { return String(l.project_id) === state.project; });
    $('logs').innerHTML = logs.length ? logs.slice(0, 100).map(function (l) {
      return '<div class="log-row"><span class="ts">' + esc(fmtWhen(l.ts)) + '</span>' +
        '<span class="lvl ' + esc(l.level || 'info') + '">' + esc(l.level || 'info') + '</span>' +
        '<span class="msg">' + esc(l.message) + '</span></div>';
    }).join('') : '<div class="empty">No activity yet.</div>';

    $('last-sync').textContent = 'Updated ' + fmtWhen(d.ts);
  }

  function taskHtml(t) {
    var resolved = t.status === 'resolved';
    var opts = ['low', 'normal', 'high', 'urgent'].map(function (p) {
      return '<option value="' + p + '"' + (t.priority === p ? ' selected' : '') + '>' + p + '</option>';
    }).join('');
    return '<div class="task' + (resolved ? ' resolved' : '') + '" data-id="' + esc(t.id) + '">' +
      '<div class="task-head">' +
        '<div class="task-title">' + esc(t.title) +
          (state.project === 'all' && t.project_id ? '<span class="proj-tag">' + esc(projectName(t.project_id)) + '</span>' : '') +
        '</div>' +
        '<span class="badge ' + esc(resolved ? 'resolved' : (t.priority || 'normal')) + '">' + esc(resolved ? 'resolved' : (t.priority || 'normal')) + '</span>' +
        '<span class="elapsed" data-from="' + esc(t.created_at) + '"' + (resolved ? ' data-to="' + esc(t.resolved_at) + '"' : '') + '></span>' +
      '</div>' +
      (t.notes ? '<div class="task-notes">' + esc(t.notes) + '</div>' : '') +
      '<div class="task-actions">' +
        (resolved
          ? '<button class="btn reopen" data-act="reopen">Reopen</button>'
          : '<button class="btn resolve" data-act="resolve">Resolve</button>') +
        '<select class="prio" data-act="prio">' + opts + '</select>' +
        '<input class="note-input" placeholder="Add a note" data-act="note">' +
        '<button class="btn ghost" data-act="addnote">Add</button>' +
      '</div>' +
    '</div>';
  }

  function tick() {
    Array.prototype.forEach.call(document.querySelectorAll('.elapsed'), function (el) {
      el.textContent = fmtElapsed(el.getAttribute('data-from'), el.getAttribute('data-to'));
    });
  }

  function bindTaskActions() {
    Array.prototype.forEach.call(document.querySelectorAll('.task'), function (card) {
      var id = card.getAttribute('data-id');
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

  function enter() {
    $('gate').style.display = 'none';
    $('app').hidden = false;
    $('who').textContent = DashAuth.email() || '';
    refresh();
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(refresh, POLL_MS);
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
    if (DashAuth.isSignedIn()) enter(); else showGate();
  });
})();
