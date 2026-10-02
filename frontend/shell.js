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
     URL" behaves identically in both places.

     It is a convenience and never load-bearing. Detection can
     fail for a dozen ordinary reasons — the site is slow, it has no <title>,
     it sits behind a WAF that dislikes robots — so nothing here disables an
     input, blocks a submit, or overwrites something the user typed. The name
     field stays a plain, always-editable text input whether detection runs,
     fails, or is never invoked at all. */

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
  /* Timezone of every absolute time the dashboard prints.
     Three layers, highest first:
       1. the viewer's own choice, saved in localStorage from the Settings page
       2. MUBWEM_DISPLAY_TIMEZONE, baked into config.js at deploy time
       3. "auto" - whatever the browser is set to
     This is presentation only. Every timestamp on the wire is ISO8601 UTC with
     a trailing Z, and stays that way: UptimeChecks.checkedAt and
     Incidents.startedAt are DynamoDB sort keys that rely on that fixed-width
     format sorting lexicographically. Nothing here touches it. */
  var TZ_KEY = "mubwem.timeZone";

  function storedZone() {
    try {
      return localStorage.getItem(TZ_KEY);
    } catch (e) {
      return null; /* private browsing - fall through to the deploy default */
    }
  }

  function forgetZone() {
    try {
      localStorage.removeItem(TZ_KEY);
    } catch (e) {
      /* nothing to forget, then */
    }
  }

  function timeZone() {
    var chosen = storedZone() || window.MUBWEM_DISPLAY_TIMEZONE || "auto";
    if (chosen === "auto") return "auto";
    // A zone name can be stale (saved before a browser upgrade) or simply a
    // typo in CDK context. Intl throws RangeError on one it does not know, and
    // an unreadable timestamp is not worth taking the whole page down for.
    if (!formatterFor(chosen, { year: "numeric" })) {
      if (storedZone() === chosen) forgetZone();
      return "auto";
    }
    return chosen;
  }

  /* "auto" is stored, not treated as "no preference" - picking Browser local
     where the deployment default is Australia/Sydney has to mean browser
     local. resetTimeZone() is the way back to the deployment default. */
  function setTimeZone(value) {
    try {
      localStorage.setItem(TZ_KEY, value || "auto");
    } catch (e) {
      /* it just will not persist past this tab */
    }
    announceZone();
  }

  function resetTimeZone() {
    forgetZone();
    announceZone();
  }

  function announceZone() {
    // Let an open page re-render without a reload.
    try {
      window.dispatchEvent(new CustomEvent("mubwem:timezone"));
    } catch (e) {
      /* no CustomEvent constructor - the preference is still saved */
    }
  }

  /* Re-render on a zone change. Two events, because there are two ways it can
     happen: the custom one for this tab, and the native storage event for a
     change made in another tab (which fires only in the *other* tabs, so the
     two never double up). Without this a dashboard left open in a second tab
     keeps showing the old zone until its next poll. */
  function onTimeZoneChange(fn) {
    window.addEventListener("mubwem:timezone", function () {
      fn();
    });
    window.addEventListener("storage", function (event) {
      if (!event || event.key === null || event.key === TZ_KEY) fn();
    });
  }

  /* The zone name to show a human. "auto" resolves to whatever the browser
     actually resolved it to, which is more useful than the word "auto". */
  function zoneLabel() {
    var zone = timeZone();
    if (zone !== "auto") return zone;
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "browser local";
    } catch (e) {
      return "browser local";
    }
  }

  /* Intl.DateTimeFormat construction is not cheap and these run once per table
     row, so every distinct (zone, options) pair is built once and kept.
     Returns null rather than throwing when the zone is unknown - that is what
     makes timeZone() above able to test a candidate. */
  var formatters = Object.create(null);

  /* `locale` is undefined for anything a human reads, so date order and month
     naming stay the viewer's own - that is what the toLocaleString calls this
     replaced already did, and only the zone is being added. The CSV builder
     passes an explicit locale because it needs Latin digits and a fixed
     structure to reassemble. */
  function formatterFor(zone, options, locale) {
    var key = (locale || "-") + "|" + zone + "|" + JSON.stringify(options);
    if (key in formatters) return formatters[key];

    var opts = {};
    for (var name in options) {
      if (Object.prototype.hasOwnProperty.call(options, name)) {
        opts[name] = options[name];
      }
    }
    if (zone !== "auto") opts.timeZone = zone;

    var made;
    try {
      made = new Intl.DateTimeFormat(locale, opts);
    } catch (e) {
      made = null;
    }
    formatters[key] = made;
    return made;
  }

  /* Accepts an ISO string, epoch milliseconds or a Date. Returns null for
     anything that is not a real instant, so each caller can decide what to
     show in its place. */
  function toDate(value) {
    if (value === null || value === undefined || value === "") return null;
    var date = value instanceof Date ? value : new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  var DATE_TIME_OPTS = {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short"
  };

  /* "12 Sep 2026, 14:02 AEST" - an absolute time that says which zone it is
     in, so the same incident never reads as two different times depending on
     which page you opened it from. */
  function formatDateTime(value) {
    var date = toDate(value);
    if (!date) return value === null || value === undefined ? "—" : String(value);
    var fmt = formatterFor(timeZone(), DATE_TIME_OPTS);
    if (!fmt) return date.toLocaleString();
    return fmt.format(date);
  }

  var TIME_OF_DAY_OPTS = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

  /* "14:02" - for chart axis ticks and hour-bar tooltips, where repeating the
     zone on every tick would be noise. The zone is stated once nearby. */
  function formatTimeOfDay(value) {
    var date = toDate(value);
    if (!date) return "—";
    var fmt = formatterFor(timeZone(), TIME_OF_DAY_OPTS);
    if (!fmt) return date.toLocaleTimeString([], TIME_OF_DAY_OPTS);
    return fmt.format(date);
  }

  var ISO_OPTS = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset"
  };

  function part(parts, type) {
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === type) return parts[i].value;
    }
    return "";
  }

  /* "2026-09-12T14:02:11+10:00" - the CSV form. Offset-bearing rather than
     zone-named so a spreadsheet can parse it, and so the exported file agrees
     with the table it was exported from instead of silently being UTC.
     There is no built-in for this; formatToParts is the only way to get a
     wall-clock reading in an arbitrary zone. */
  function formatIsoInZone(value) {
    var date = toDate(value);
    if (!date) return value === null || value === undefined ? "" : String(value);

    var zone = timeZone();
    var fmt = formatterFor(zone, ISO_OPTS, "en-GB");
    if (!fmt || !fmt.formatToParts) return date.toISOString();

    var parts;
    try {
      parts = fmt.formatToParts(date);
    } catch (e) {
      return date.toISOString();
    }

    // "GMT+10:00" / "GMT" (UTC itself) -> "+10:00" / "Z".
    var offset = part(parts, "timeZoneName").replace("GMT", "");
    if (!offset || offset === "+00:00" || offset === "-00:00") offset = "Z";

    return (
      part(parts, "year") + "-" + part(parts, "month") + "-" + part(parts, "day") +
      "T" +
      part(parts, "hour") + ":" + part(parts, "minute") + ":" + part(parts, "second") +
      offset
    );
  }

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
    attachNameDetection: attachNameDetection,
    timeZone: timeZone,
    setTimeZone: setTimeZone,
    resetTimeZone: resetTimeZone,
    onTimeZoneChange: onTimeZoneChange,
    zoneLabel: zoneLabel,
    formatDateTime: formatDateTime,
    formatTimeOfDay: formatTimeOfDay,
    formatIsoInZone: formatIsoInZone
  };
})();
