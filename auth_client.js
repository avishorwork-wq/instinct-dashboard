/* Dashboard sign-in. Google Identity Services ID-token flow.
   The ID token goes to the backend (Cloudflare Worker), which verifies it with
   Google and returns an opaque session token. Session is kept in sessionStorage
   (survives reloads in the same tab, cleared when the tab closes). */
(function () {
  var cfg = window.DASH_CONFIG || {};
  var session = null, email = null, timer = null;
  try { session = sessionStorage.getItem('dash_session'); email = sessionStorage.getItem('dash_email'); } catch (e) {}

  async function post(body) {
    var r = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
    return r.json();
  }

  function setSession(token, em, ttl) {
    session = token; email = em;
    try { sessionStorage.setItem('dash_session', token); sessionStorage.setItem('dash_email', em); } catch (e) {}
    clearTimeout(timer);
    if (ttl) timer = setTimeout(function () { clearSession(); }, ttl * 1000);
  }
  function clearSession() {
    session = null; email = null;
    try { sessionStorage.removeItem('dash_session'); sessionStorage.removeItem('dash_email'); } catch (e) {}
  }

  window.DashAuth = {
    isSignedIn: function () { return !!session; },
    email: function () { return email; },
    watchUrl: function () { return cfg.endpoint.replace(/^http/, 'ws') + '?action=watch&session=' + encodeURIComponent(session || ''); },
    call: async function (action, payload) {
      var r = await post(Object.assign({ action: action, session: session }, payload || {}));
      if (r && r.error === 'auth') { clearSession(); }
      return r;
    },
    renderSignIn: function (el, onSignedIn, onError) {
      var attempts = 0;
      function waitForGoogle() {
        if (window.google && google.accounts && google.accounts.id) { render(); return; }
        attempts++;
        if (attempts === 20) {
          var p = document.createElement('p');
          p.className = 'muted small';
          p.id = 'signin-loading';
          p.textContent = 'Loading Google sign-in, this can take a moment...';
          el.appendChild(p);
        }
        if (attempts > 240) { onError(new Error('google_lib_missing')); return; }
        setTimeout(waitForGoogle, 500);
      }
      function render() {
      var loading = document.getElementById('signin-loading');
      if (loading) loading.remove();
      google.accounts.id.initialize({
        client_id: cfg.googleClientId,
        callback: async function (resp) {
          try {
            var r = await post({ action: 'authToken', credential: resp.credential });
            if (!r.ok) { onError(new Error(r.error || 'auth_failed')); return; }
            setSession(r.session, r.email, r.ttl);
            onSignedIn(r.email);
          } catch (e) { onError(e); }
        }
      });
      google.accounts.id.renderButton(el, { theme: 'filled_black', size: 'large', text: 'signin_with', shape: 'pill' });
      }
      waitForGoogle();
    },
    signOut: async function () {
      var s = session; clearSession();
      if (s) { try { await post({ action: 'authLogout', session: s }); } catch (e) {} }
    }
  };
})();
