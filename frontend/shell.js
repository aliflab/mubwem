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
          window.location.replace("/");
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

  // --------------------------------------------------- monitor form helpers
  /* Shared by add-monitor.js and the edit form in monitor.js, so "Detect from
     URL" and the brand suggestions behave identically in both places.

     Both are conveniences and neither is ever load-bearing. Detection can
     fail for a dozen ordinary reasons — the site is slow, it has no <title>,
     it sits behind a WAF that dislikes robots — so nothing here disables an
     input, blocks a submit, or overwrites something the user typed. The name
     field stays a plain, always-editable text input whether detection runs,
     fails, or is never invoked at all. */

  /* Distinct brands across the sites list, sorted, blanks dropped. Real data
     from the deployment, not a guessed vocabulary — the field stays free text
     so a brand nobody has used yet can still be typed. */
  function distinctBrands(sites) {
    var seen = Object.create(null);
    (sites || []).forEach(function (site) {
      var brand = (site && site.brand ? String(site.brand) : "").trim();
      if (brand && brand !== "Unassigned") seen[brand] = true;
    });
    return Object.keys(seen).sort(function (a, b) {
      return a.toLowerCase().localeCompare(b.toLowerCase());
    });
  }

  /* Points `input` at a <datalist> of the brands already in use. Native HTML
     autocomplete: no dependency, no custom dropdown, and the field is still a
     text input that accepts anything. A failed fetch leaves the field exactly
     as it was — an empty datalist simply offers no suggestions. */
  function attachBrandSuggestions(input, adminBase, listId) {
    if (!input || !adminBase) return Promise.resolve([]);

    var list = document.getElementById(listId);
    if (!list) {
      list = document.createElement("datalist");
      list.id = listId;
      document.body.appendChild(list);
    }
    input.setAttribute("list", listId);

    return apiFetch(adminBase + "/sites")
      .then(function (payload) {
        var brands = distinctBrands(payload && payload.sites);
        list.innerHTML = "";
        brands.forEach(function (brand) {
          var option = document.createElement("option");
          option.value = brand;
          list.appendChild(option);
        });
        return brands;
      })
      .catch(function () {
        /* No suggestions, then. The field works the same way without them. */
        return [];
      });
  }

  /* Wires a "Detect from URL" button and a blur handler onto a URL field.
     opts: { urlInput, nameInput, button, status, adminBase }

     User-initiated only — a click, or the URL field losing focus after its
     value changed. Never on keystroke: a request per character would hammer
     the endpoint and fire against half-typed hostnames. */
  function attachNameDetection(opts) {
    var urlInput = opts.urlInput;
    var nameInput = opts.nameInput;
    var button = opts.button;
    var status = opts.status;
    var adminBase = opts.adminBase;
    if (!urlInput || !nameInput || !adminBase) return;

    var inFlight = false;
    var lastTried = "";

    function say(message, kind) {
      if (!status) return;
      status.textContent = message || "";
      status.className = "detect-status" + (kind ? " detect-" + kind : "");
      status.hidden = !message;
    }

    /* The name field already has text, so the suggestion is offered rather
       than applied. Clicking accepts it; ignoring it costs nothing. */
    function offer(suggestion) {
      say("", null);
      if (!status) return;
      status.hidden = false;
      status.className = "detect-status detect-offer";
      status.appendChild(document.createTextNode("Use "));
      var accept = document.createElement("button");
      accept.type = "button";
      accept.className = "link-button";
      accept.textContent = "“" + suggestion + "”";
      accept.addEventListener("click", function () {
        nameInput.value = suggestion;
        say("Name updated.", "ok");
      });
      status.appendChild(accept);
      status.appendChild(document.createTextNode(" instead?"));
    }

    function detect() {
      var url = (urlInput.value || "").trim();
      if (inFlight) return;
      if (url.indexOf("https://") !== 0) {
        // Not a failure worth reporting: the field's own help text and the
        // submit-time check already say the URL must be HTTPS.
        say("", null);
        return;
      }

      inFlight = true;
      lastTried = url;
      if (button) button.disabled = true;
      say("Checking…", "busy");

      apiFetch(adminBase + "/sites/preview", { method: "POST", body: { url: url } })
        .then(function (payload) {
          var suggestion = (payload && payload.suggestedName) || "";
          if (!suggestion) {
            say("Couldn’t detect a name automatically — enter one manually.", "warn");
            return;
          }
          var current = (nameInput.value || "").trim();
          if (!current) {
            nameInput.value = suggestion;
            say(
              payload.detected
                ? "Name filled in from the page."
                : "No page title found — used the hostname.",
              "ok"
            );
            return;
          }
          if (current === suggestion) {
            say("Name already matches the page.", "ok");
            return;
          }
          // Never silently overwrite what someone typed.
          offer(suggestion);
        })
        .catch(function () {
          say("Couldn’t detect a name automatically — enter one manually.", "warn");
        })
        .then(function () {
          inFlight = false;
          if (button) button.disabled = false;
        });
    }

    if (button) button.addEventListener("click", detect);

    urlInput.addEventListener("blur", function () {
      var url = (urlInput.value || "").trim();
      // Only once per distinct URL, and only when there is something to fill.
      if (!url || url === lastTried) return;
      if ((nameInput.value || "").trim()) return;
      detect();
    });

    urlInput.addEventListener("input", function () {
      if ((urlInput.value || "").trim() !== lastTried) say("", null);
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
    resolveApiUrl: resolveApiUrl,
    distinctBrands: distinctBrands,
    attachBrandSuggestions: attachBrandSuggestions,
    attachNameDetection: attachNameDetection
  };
})();
