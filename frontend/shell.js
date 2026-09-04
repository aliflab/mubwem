/* MuBWeM page shell — the bootstrap every authenticated page shares.
 *
 * Signs in through auth.js, renders the side nav, fills in the session strip,
 * and optionally gates the page on a Cognito group before handing control to
 * the page's own code.
 *
 * Usage:
 *   MubwemShell.boot({
 *     page: "incidents",                  // nav key to highlight
 *     requireGroups: ["Admins"],          // optional; redirects if not met
 *     ready: function (claims) { ... }
 *   });
 *
 * The requireGroups check is display-level routing, not access control: it
 * decides which page the browser lands on, nothing more. Every /admin/* call
 * those pages make is authorized server-side in lambda/admin/handler.py from
 * the JWT's own groups claim, and would be refused there regardless of what
 * this file allowed onto the screen.
 */
window.MubwemShell = (function () {
  "use strict";

  function el(id) {
    return document.getElementById(id);
  }

  function showError(message) {
    var node = el("error");
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
  }

  function clearError() {
    var node = el("error");
    if (node) node.hidden = true;
  }

  var noticeTimer = null;

  function showNotice(message) {
    var node = el("notice");
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () {
      node.hidden = true;
    }, 6000);
  }

  function boot(options) {
    var opts = options || {};

    var logout = el("logout");
    if (logout) {
      logout.addEventListener("click", function (event) {
        event.preventDefault();
        MubwemAuth.logout();
      });
    }

    return MubwemAuth.init()
      .then(function (token) {
        var claims = MubwemAuth.claims();

        if (opts.requireGroups && !MubwemAuth.inAnyGroup(opts.requireGroups)) {
          // Nothing on this page is usable by this role. Send them somewhere
          // that is, rather than rendering controls that will be refused.
          window.location.replace("index.html");
          return null;
        }

        if (window.MubwemNav) MubwemNav.render(opts.page);

        var who = el("signed-in-as");
        if (who && claims.email) who.textContent = claims.email;
        if (logout) logout.hidden = false;

        if (opts.ready) opts.ready(claims, token);
        return token;
      })
      .catch(function (err) {
        var overall = el("overall");
        if (overall) {
          overall.textContent = "Not signed in";
          overall.className = "overall overall-down";
        }
        showError(err.message);
        throw err;
      });
  }

  /* Authenticated fetch against an absolute URL, returning parsed JSON.
     A 401 means the token died mid-session; bounce through the hosted UI. */
  function apiFetch(url, options) {
    var token = MubwemAuth.getIdToken();
    if (!token) {
      MubwemAuth.clearSession();
      MubwemAuth.login();
      return Promise.reject(new Error("signing in again"));
    }

    var opts = options || {};
    var headers = { Authorization: "Bearer " + token };
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    return fetch(url, {
      method: opts.method || "GET",
      cache: "no-store",
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    }).then(function (res) {
      if (res.status === 401) {
        MubwemAuth.clearSession();
        MubwemAuth.login();
        throw new Error("signing in again");
      }
      return res.json().then(
        function (payload) {
          if (!res.ok) {
            var err = new Error((payload && payload.error) || "HTTP " + res.status);
            err.status = res.status;
            throw err;
          }
          return payload;
        },
        function () {
          var err = new Error("HTTP " + res.status);
          err.status = res.status;
          throw err;
        }
      );
    });
  }

  // ------------------------------------------------------------- formatting
  function relativeTime(iso) {
    if (!iso) return "never";
    var then = Date.parse(iso);
    if (isNaN(then)) return "unknown";
    return durationLabel(Math.max(0, Math.round((Date.now() - then) / 1000))) + " ago";
  }

  function durationLabel(secs) {
    if (secs === null || secs === undefined) return "—";
    secs = Math.round(secs);
    if (secs < 60) return secs + "s";
    if (secs < 3600) return Math.round(secs / 60) + "m";
    if (secs < 86400) return (secs / 3600).toFixed(1) + "h";
    return (secs / 86400).toFixed(1) + "d";
  }

  function text(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = value;
    return node;
  }

  /* The deploy-generated config.js sets the window globals. For local
     development, append ?api=https://... once and it is remembered in
     localStorage. Only the endpoint is ever stored there — never a token. */
  function resolveApiUrl(globalName, storageKey) {
    var fromQuery = new URLSearchParams(window.location.search).get("api");
    if (fromQuery) {
      try {
        localStorage.setItem(storageKey, fromQuery);
      } catch (e) {
        /* private browsing — fine, it just will not persist */
      }
      return fromQuery;
    }
    if (window[globalName]) return window[globalName];
    try {
      return localStorage.getItem(storageKey);
    } catch (e) {
      return null;
    }
  }

  return {
    boot: boot,
    apiFetch: apiFetch,
    showError: showError,
    clearError: clearError,
    showNotice: showNotice,
    relativeTime: relativeTime,
    durationLabel: durationLabel,
    text: text,
    resolveApiUrl: resolveApiUrl
  };
})();
