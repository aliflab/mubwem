/* MuBWeM dashboard rendering — plain JS, no build step.
 *
 * Shared by the authenticated dashboard (app.js, GET /status) and the public
 * status page (public.js, GET /public/status). Both responses have the same
 * shape — documented at the top of lambda/api/handler.py — so exactly one
 * renderer serves both; only the URL and the auth header differ.
 *
 * Usage:
 *   MubwemDashboard.start({
 *     apiUrl: "https://.../status",
 *     headers: function () { return { Authorization: "Bearer ..." }; },  // optional
 *     onUnauthorized: function () { ... }                               // optional
 *   });
 */
window.MubwemDashboard = (function () {
  "use strict";

  var POLL_MS = 20000;
  var RING_TICK_MS = 1000;

  // Countdown ring geometry, in the SVG's own user units.
  var RING_R = 18;
  var RING_C = 2 * Math.PI * RING_R;

  // The rings currently on the page. Rebuilt on every render, ticked by a
  // single shared interval rather than one timer per card.
  var rings = [];
  var ringTimer = null;

  var el = {
    cards: document.getElementById("cards"),
    empty: document.getElementById("empty"),
    error: document.getElementById("error"),
    updated: document.getElementById("updated"),
    overall: document.getElementById("overall")
  };

  // ---------------------------------------------------------------- helpers
  function relativeTime(iso) {
    if (!iso) return "never";
    var then = Date.parse(iso);
    if (isNaN(then)) return "unknown";
    var secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 60) return secs + "s ago";
    if (secs < 3600) return Math.round(secs / 60) + "m ago";
    if (secs < 86400) return Math.round(secs / 3600) + "h ago";
    return Math.round(secs / 86400) + "d ago";
  }

  function duration(secs) {
    if (secs === null || secs === undefined) return "ongoing";
    if (secs < 60) return secs + "s";
    if (secs < 3600) return Math.round(secs / 60) + "m";
    return (secs / 3600).toFixed(1) + "h";
  }

  function text(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = value;
    return node;
  }

  // Deploy-time config.js sets the window globals. For local development,
  // append ?api=https://... once and it is remembered in localStorage. Only the
  // endpoint is ever stored there — never a token.
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

  // ------------------------------------------------------------ countdown ring
  function scheduleIntervalSec() {
    // Set by the deploy-generated config.js, derived from the same schedule
    // expression that drives EventBridge Scheduler.
    var configured = Number(window.MUBWEM_SCHEDULE_INTERVAL_SEC);
    return configured > 0 ? configured : 60;
  }

  function svgNode(tag, attrs) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs).forEach(function (key) {
      node.setAttribute(key, attrs[key]);
    });
    return node;
  }

  /* A ring counting down to this site's next check.

     This is an approximation based on the last recorded check time plus the
     configured schedule interval, not a live signal from EventBridge - the
     browser has no way to know when the scheduler will actually fire. */
  function renderRing(site) {
    var wrap = text("div", "ring", null);
    wrap.title = "Approximate time until the next check";

    var svg = svgNode("svg", {
      viewBox: "0 0 44 44",
      width: "44",
      height: "44",
      class: "ring-svg",
      "aria-hidden": "true"
    });
    svg.appendChild(
      svgNode("circle", {
        class: "ring-track",
        cx: 22,
        cy: 22,
        r: RING_R,
        fill: "none"
      })
    );
    var progress = svgNode("circle", {
      class: "ring-progress",
      cx: 22,
      cy: 22,
      r: RING_R,
      fill: "none",
      "stroke-dasharray": RING_C,
      "stroke-dashoffset": RING_C
    });
    svg.appendChild(progress);
    wrap.appendChild(svg);

    var label = text("span", "ring-label", "-");
    wrap.appendChild(label);

    rings.push({
      checkedAt: site.lastCheckedAt ? Date.parse(site.lastCheckedAt) : NaN,
      progress: progress,
      label: label
    });
    return wrap;
  }

  function tickRings() {
    var interval = scheduleIntervalSec();
    rings.forEach(function (ring) {
      if (isNaN(ring.checkedAt)) {
        // Never checked: an empty ring rather than a fake countdown.
        ring.progress.setAttribute("stroke-dashoffset", RING_C);
        ring.label.textContent = "-";
        return;
      }
      var elapsed = Math.max(0, (Date.now() - ring.checkedAt) / 1000);
      var remaining = interval - (elapsed % interval);
      var fraction = remaining / interval;
      ring.progress.setAttribute("stroke-dashoffset", RING_C * (1 - fraction));
      ring.label.textContent = Math.ceil(remaining) + "s";
    });
  }

  // --------------------------------------------------------------- rendering
  function renderIncidents(site) {
    var wrap = text("div", "incidents");
    if (!site.incidents || site.incidents.length === 0) {
      wrap.appendChild(text("p", "incidents-none", "No incidents recorded."));
      return wrap;
    }

    wrap.appendChild(text("h3", null, "Recent incidents"));
    var list = document.createElement("ul");
    site.incidents.forEach(function (inc) {
      var li = document.createElement("li");
      li.className = inc.resolved ? "incident" : "incident incident-open";

      var when = new Date(inc.startedAt);
      var whenLabel = isNaN(when.getTime())
        ? inc.startedAt
        : when.toLocaleString();

      li.appendChild(text("span", "incident-when", whenLabel));
      li.appendChild(
        text(
          "span",
          "incident-duration",
          inc.resolved ? duration(inc.durationSec) : "ongoing"
        )
      );
      li.appendChild(text("span", "incident-reason", inc.triggerReason || ""));
      list.appendChild(li);
    });
    wrap.appendChild(list);
    return wrap;
  }

  function renderCard(site) {
    var card = text("article", "card card-" + site.status);

    var head = text("div", "card-head");
    var title = text("div", "card-title");
    title.appendChild(text("span", "dot", null));
    var names = text("div", null);
    names.appendChild(text("h2", null, site.name));
    names.appendChild(text("p", "brand-label", site.brand || ""));
    title.appendChild(names);
    head.appendChild(title);

    var aside = text("div", "card-aside", null);
    aside.appendChild(
      text("span", "badge badge-" + site.status, site.status.toUpperCase())
    );
    aside.appendChild(renderRing(site));
    head.appendChild(aside);
    card.appendChild(head);

    var link = document.createElement("a");
    link.className = "card-url";
    link.href = site.url || "#";
    link.textContent = site.url || "";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    card.appendChild(link);

    var stats = text("dl", "stats");
    function stat(label, value) {
      stats.appendChild(text("dt", null, label));
      stats.appendChild(text("dd", null, value));
    }
    stat("Last checked", relativeTime(site.lastCheckedAt));
    stat(
      "Response",
      site.lastResponseTimeMs === null || site.lastResponseTimeMs === undefined
        ? "—"
        : site.lastResponseTimeMs + " ms"
    );
    stat(
      "Uptime 24h",
      site.uptime24h === null || site.uptime24h === undefined
        ? "—"
        : site.uptime24h.toFixed(2) + "%"
    );
    stat(
      "Failures in a row",
      site.consecutiveFailures === undefined ? "—" : site.consecutiveFailures
    );
    card.appendChild(stats);

    card.appendChild(renderIncidents(site));
    return card;
  }

  function renderOverall(sites) {
    var down = sites.filter(function (s) {
      return s.status === "down";
    }).length;

    if (sites.length === 0) {
      el.overall.textContent = "No sites monitored";
      el.overall.className = "overall overall-unknown";
    } else if (down === 0) {
      el.overall.textContent = "All " + sites.length + " sites operational";
      el.overall.className = "overall overall-up";
    } else {
      el.overall.textContent = down + " of " + sites.length + " sites down";
      el.overall.className = "overall overall-down";
    }
  }

  function render(payload) {
    var sites = payload.sites || [];
    // The old ring nodes are about to be thrown away with the cards; drop the
    // references too, or the ticker keeps writing to detached elements.
    rings = [];
    el.cards.innerHTML = "";
    sites.forEach(function (site) {
      el.cards.appendChild(renderCard(site));
    });
    el.empty.hidden = sites.length > 0;
    el.updated.textContent = relativeTime(payload.generatedAt);
    renderOverall(sites);

    // Once per second, independent of the 20s poll, so the countdown moves
    // instead of jumping a third of a minute at a time.
    tickRings();
    if (!ringTimer) ringTimer = setInterval(tickRings, RING_TICK_MS);
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
  }

  function setOverall(message, modifier) {
    el.overall.textContent = message;
    el.overall.className = "overall overall-" + (modifier || "unknown");
  }

  // ----------------------------------------------------------------- polling
  function start(options) {
    var apiUrl = options.apiUrl;
    var headers = options.headers;
    var onUnauthorized = options.onUnauthorized;

    if (!apiUrl) {
      showError(
        "No API URL configured. Deploy the stack (config.js is generated for " +
          "you) or open this page with ?api=https://your-api-url/status"
      );
      return;
    }

    function refresh() {
      var requestHeaders;
      try {
        requestHeaders = headers ? headers() : {};
      } catch (e) {
        showError("Could not load status: " + e.message);
        return;
      }
      if (requestHeaders === null) {
        // The caller has no valid credentials any more and is handling it.
        if (onUnauthorized) onUnauthorized();
        return;
      }

      fetch(apiUrl, { cache: "no-store", headers: requestHeaders })
        .then(function (res) {
          if (res.status === 401 || res.status === 403) {
            var authErr = new Error("not authorised");
            authErr.unauthorized = true;
            throw authErr;
          }
          if (!res.ok) throw new Error("API returned HTTP " + res.status);
          return res.json();
        })
        .then(function (payload) {
          el.error.hidden = true;
          render(payload);
        })
        .catch(function (err) {
          if (err.unauthorized && onUnauthorized) {
            onUnauthorized();
            return;
          }
          showError("Could not load status: " + err.message);
        });
    }

    refresh();
    setInterval(refresh, POLL_MS);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refresh();
    });
  }

  return {
    start: start,
    resolveApiUrl: resolveApiUrl,
    showError: showError,
    setOverall: setOverall
  };
})();
