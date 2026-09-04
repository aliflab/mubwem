/* MuBWeM monitor-list rendering — plain JS, no build step.
 *
 * Shared by the authenticated dashboard (app.js, GET /status) and the public
 * status page (public.js, GET /public/status). Both responses have the same
 * shape — documented at the top of lambda/api/handler.py — so exactly one
 * renderer serves both; the URL, the auth header, and how much detail belongs
 * on a card are what differ.
 *
 * Usage:
 *   MubwemDashboard.start({
 *     apiUrl: "https://.../status",
 *     headers: function () { return { Authorization: "Bearer ..." }; },  // optional
 *     onUnauthorized: function () { ... },                              // optional
 *     detailHref: function (siteId) { return "monitor.html?site=" + siteId; },
 *     inlineDetails: true      // keep stats + incidents on the card itself
 *   });
 *
 * detailHref and inlineDetails are the two modes. The dashboard sets
 * detailHref, so a card is a link and its detail lives on monitor.html. The
 * public page has no detail page to send anyone to, so it sets inlineDetails
 * instead and keeps the stats and incident list on the card — otherwise the
 * public page would lose information it has always shown and gain nothing.
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
    overall: document.getElementById("overall"),
    summary: document.getElementById("summary")
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

  /* Seconds as a coarse human span, for the summary card. Distinct from
     duration() above, which is about incident lengths and says "ongoing". */
  function span(secs) {
    if (secs === null || secs === undefined) return null;
    if (secs < 60) return Math.round(secs) + "s";
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
      // A paused site is not going to be checked, so it gets no countdown.
      checkedAt:
        site.status !== "paused" && site.lastCheckedAt
          ? Date.parse(site.lastCheckedAt)
          : NaN,
      progress: progress,
      label: label
    });
    return wrap;
  }

  function tickRings() {
    var interval = scheduleIntervalSec();
    rings.forEach(function (ring) {
      if (isNaN(ring.checkedAt)) {
        // Never checked, or paused: an empty ring rather than a fake countdown.
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

  // ------------------------------------------------------------ hourly bars
  /* 24 bars, one per hour of the last 24 hours, oldest on the left.

     The buckets are computed server-side (hourly_buckets() in the API) over
     the same 24h of checks the uptime percentage uses, so the bar and the
     percentage under it always describe the same window. A bar is red if any
     check in that hour failed, grey if no check was recorded at all. */
  function renderHourlyBar(site, large) {
    var buckets = site.hourlyBuckets || [];
    var wrap = text("div", "hourbar" + (large ? " hourbar-large" : ""), null);
    wrap.setAttribute("role", "img");
    wrap.setAttribute(
      "aria-label",
      "Hourly status for the last 24 hours, oldest first"
    );

    for (var i = 0; i < 24; i++) {
      var state = buckets[i] || "none";
      var bar = text("span", "hourbar-cell hourbar-" + state, null);
      var hoursAgo = 24 - i;
      bar.title =
        hoursAgo +
        "h ago — " +
        (state === "none" ? "no checks recorded" : state);
      wrap.appendChild(bar);
    }
    return wrap;
  }

  function renderUptimeFooter(site) {
    var row = text("div", "hourbar-foot", null);
    row.appendChild(text("span", "hourbar-scale", "24h ago"));
    row.appendChild(
      text(
        "span",
        "hourbar-pct",
        site.uptime24h === null || site.uptime24h === undefined
          ? "No data"
          : site.uptime24h.toFixed(2) + "%"
      )
    );
    row.appendChild(text("span", "hourbar-scale", "now"));
    return row;
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

  function renderStats(site) {
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
    return stats;
  }

  function renderCard(site, options) {
    // A card is an <a> when there is a detail page to reach, and a plain
    // <article> otherwise — never a div pretending to be a link.
    var href = options.detailHref ? options.detailHref(site.siteId) : null;
    var card = document.createElement(href ? "a" : "article");
    card.className = "card card-" + site.status + (href ? " card-link" : "");
    if (href) card.href = href;

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

    var url = text("span", "card-url", site.url || "");
    card.appendChild(url);

    card.appendChild(renderHourlyBar(site, false));
    card.appendChild(renderUptimeFooter(site));

    if (options.inlineDetails) {
      card.appendChild(renderStats(site));
      card.appendChild(renderIncidents(site));
    }

    return card;
  }

  // ------------------------------------------------------------------ summary
  function statBlock(label, value, modifier) {
    var block = text("div", "sumstat" + (modifier ? " sumstat-" + modifier : ""));
    block.appendChild(text("span", "sumstat-value", value));
    block.appendChild(text("span", "sumstat-label", label));
    return block;
  }

  function renderSummary(summary) {
    if (!el.summary) return;
    el.summary.innerHTML = "";
    if (!summary) return;

    var current = text("section", "panel summary-card");
    current.appendChild(text("h2", null, "Current status"));
    var currentRow = text("div", "sumstat-row");
    currentRow.appendChild(statBlock("Up", summary.upCount, "up"));
    currentRow.appendChild(statBlock("Down", summary.downCount, "down"));
    currentRow.appendChild(statBlock("Paused", summary.pausedCount, "paused"));
    currentRow.appendChild(statBlock("Monitors", summary.totalMonitors));
    current.appendChild(currentRow);
    el.summary.appendChild(current);

    var day = text("section", "panel summary-card");
    day.appendChild(text("h2", null, "Last 24 hours"));
    var dayRow = text("div", "sumstat-row");
    dayRow.appendChild(
      statBlock(
        "Overall uptime",
        summary.overallUptime24h === null || summary.overallUptime24h === undefined
          ? "No data yet"
          : summary.overallUptime24h.toFixed(2) + "%"
      )
    );
    // null here means "not enough incident history to compute an interval",
    // which is not the same as zero — say so rather than showing a number
    // that reads like a measurement.
    dayRow.appendChild(
      statBlock("Mean time between failures", span(summary.mtbfSeconds) || "Not enough data yet")
    );
    dayRow.appendChild(
      statBlock(
        "Since last incident",
        span(summary.timeSinceLastIncidentSeconds) || "No incidents recorded"
      )
    );
    dayRow.appendChild(statBlock("Incidents", summary.incidentCount24h));
    day.appendChild(dayRow);
    el.summary.appendChild(day);
  }

  function renderOverall(summary, sites) {
    if (!el.overall) return;
    var down = summary ? summary.downCount : 0;
    var total = summary ? summary.totalMonitors : sites.length;
    var paused = summary ? summary.pausedCount : 0;
    var active = total - paused;

    if (total === 0) {
      el.overall.textContent = "No sites monitored";
      el.overall.className = "overall overall-unknown";
    } else if (down === 0) {
      // Paused sites are counted separately: saying "all 7 operational" when
      // two of them are switched off is the miscount this replaces.
      el.overall.textContent =
        "All " + active + " active sites operational" +
        (paused ? " · " + paused + " paused" : "");
      el.overall.className = "overall overall-up";
    } else {
      el.overall.textContent =
        down + " of " + active + " active sites down" +
        (paused ? " · " + paused + " paused" : "");
      el.overall.className = "overall overall-down";
    }
  }

  function render(payload, options) {
    var sites = payload.sites || [];
    // The old ring nodes are about to be thrown away with the cards; drop the
    // references too, or the ticker keeps writing to detached elements.
    rings = [];
    el.cards.innerHTML = "";
    sites.forEach(function (site) {
      el.cards.appendChild(renderCard(site, options));
    });
    el.empty.hidden = sites.length > 0;
    if (el.updated) el.updated.textContent = relativeTime(payload.generatedAt);
    renderSummary(payload.summary);
    renderOverall(payload.summary, sites);

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
    if (!el.overall) return;
    el.overall.textContent = message;
    el.overall.className = "overall overall-" + (modifier || "unknown");
  }

  // ----------------------------------------------------------------- polling
  function start(options) {
    var opts = options || {};
    var apiUrl = opts.apiUrl;
    var headers = opts.headers;
    var onUnauthorized = opts.onUnauthorized;

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
          render(payload, opts);
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
    setOverall: setOverall,
    // Reused by monitor.js so the detail page draws the same bar and the same
    // incident list as the cards do.
    renderHourlyBar: renderHourlyBar,
    renderIncidents: renderIncidents,
    renderStats: renderStats,
    relativeTime: relativeTime,
    duration: duration
  };
})();
