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
 * inlineDetails has nowhere to go in a list row, so it applies to card density
 * only.
 *
 * FILTERING
 *
 * The toolbar (search, status, brand, density) filters the payload that has
 * already been fetched. It issues no request of its own and needs no backend
 * support: everything it works on is in the one /status document the page was
 * already polling. Filtering never re-sorts — the API returns sites down-first
 * then by name, and preserving that order across every filter is the point.
 */
window.MubwemDashboard = (function () {
  "use strict";

  var POLL_MS = 20000;
  var TICK_MS = 1000;
  var SKELETON_CARDS = 6;

  // Countdown ring geometry, in the SVG's own user units.
  var RING_R = 18;
  var RING_C = 2 * Math.PI * RING_R;

  // The rings currently on the page. Rebuilt on every render, ticked by a
  // single shared interval rather than one timer per card.
  var rings = [];
  var ticker = null;

  // What the last poll returned, so a toolbar interaction can re-render the
  // grid without waiting 20 seconds for the next one.
  var lastPayload = null;
  var lastOptions = {};
  var generatedAt = null;

  var filters = { query: "", status: "all", brand: "all", density: "cards" };
  var VIEW_KEY = "mubwem.dashboardView";
  var SEARCH_DEBOUNCE_MS = 120;

  var toolbar = null; // built once; only its dynamic parts are updated after

  var el = {
    cards: document.getElementById("cards"),
    empty: document.getElementById("empty"),
    error: document.getElementById("error"),
    updated: document.getElementById("updated"),
    overall: document.getElementById("overall"),
    summary: document.getElementById("summary"),
    toolbar: document.getElementById("toolbar"),
    resultCount: document.getElementById("result-count"),
    filterEmpty: null // created on demand, below the grid
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

  function uptimeLabel(site, fallback) {
    return site.uptime24h === null || site.uptime24h === undefined
      ? fallback
      : site.uptime24h.toFixed(2) + "%";
  }

  function brandOf(site) {
    return site.brand || "Unassigned";
  }

  function text(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = value;
    return node;
  }

  /* Only reassign when the string actually differs. #overall is an aria-live
     region, and rewriting identical text on every 20s poll is how a live
     region turns into a screen-reader metronome. */
  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
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

  /* Remembered view state: the status filter and the density, nothing else.
     Not the search text (stale and confusing on return) and not the brand (the
     brand set changes as monitors are added). Same rule as the API URL above —
     view preferences only, never anything sensitive. */
  function loadView() {
    var saved;
    try {
      saved = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}");
    } catch (e) {
      return;
    }
    if (!saved || typeof saved !== "object") return;
    if (["all", "up", "down", "paused"].indexOf(saved.status) !== -1) {
      filters.status = saved.status;
    }
    if (saved.density === "list" || saved.density === "cards") {
      filters.density = saved.density;
    }
  }

  function saveView() {
    try {
      localStorage.setItem(
        VIEW_KEY,
        JSON.stringify({ status: filters.status, density: filters.density })
      );
    } catch (e) {
      /* private browsing — the view just will not be remembered */
    }
  }

  // ------------------------------------------------------------ countdown ring
  /* The deployment-wide sweep cadence, from the deploy-generated config.js,
     derived from the same schedule expression that drives EventBridge
     Scheduler. Only a fallback now - see intervalFor(). */
  function scheduleIntervalSec() {
    var configured = Number(window.MUBWEM_SCHEDULE_INTERVAL_SEC);
    return configured > 0 ? configured : 60;
  }

  /* A site's own configured interval, which every /status route now returns.
     The global cadence is the fallback for a site whose row predates the
     field - it should not happen, but a ring counting the wrong number is
     worse than a ring counting an approximate one. */
  function intervalFor(site) {
    var own = Number(site && site.checkIntervalSec);
    return own > 0 ? own : scheduleIntervalSec();
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
    wrap.title =
      "Approximate time until the next check (every " +
      intervalFor(site) +
      "s)";

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
      interval: intervalFor(site),
      progress: progress,
      label: label
    });
    return wrap;
  }

  function tickRings() {
    rings.forEach(function (ring) {
      if (isNaN(ring.checkedAt)) {
        // Never checked, or paused: an empty ring rather than a fake countdown.
        ring.progress.setAttribute("stroke-dashoffset", RING_C);
        ring.label.textContent = "-";
        return;
      }
      // Each ring carries its own site's interval, so a 30s site counts down
      // from 30 while a 60s one beside it counts down from 60.
      var interval = ring.interval;
      var elapsed = Math.max(0, (Date.now() - ring.checkedAt) / 1000);
      var remaining = interval - (elapsed % interval);
      var fraction = remaining / interval;
      ring.progress.setAttribute("stroke-dashoffset", RING_C * (1 - fraction));
      ring.label.textContent = Math.ceil(remaining) + "s";
    });
  }

  /* One second, one timer, everything time-relative on the page. The "Updated
     Xs ago" label rides along here rather than being written once per 20s
     poll, where it used to read "0s ago" and then sit there lying for the rest
     of the interval. */
  function tick() {
    tickRings();
    if (el.updated && generatedAt) {
      setText(el.updated, relativeTime(generatedAt));
    }
  }

  // ------------------------------------------------------------ hourly bars
  function bucketState(value) {
    return value === "up" || value === "down" ? value : "none";
  }

  /* A spoken summary of the bar, since the bar itself is pure colour and the
     per-cell title tooltips are invisible to a screen reader and to touch. */
  function bucketSummary(buckets) {
    var counts = { up: 0, down: 0, none: 0 };
    for (var i = 0; i < 24; i++) counts[bucketState(buckets[i])]++;

    var parts = [];
    function part(n, singular, plural) {
      if (n) parts.push(n + " " + (n === 1 ? singular : plural));
    }
    part(counts.up, "hour up", "hours up");
    part(counts.down, "hour down", "hours down");
    part(counts.none, "hour with no checks", "hours with no checks");
    return "Last 24 hours: " + (parts.length ? parts.join(", ") : "no data");
  }

  /* 24 bars, one per hour of the last 24 hours, oldest on the left.

     The buckets are computed server-side (hourly_buckets() in the API) over
     the same 24h of checks the uptime percentage uses, so the bar and the
     percentage under it always describe the same window. A bar is red if any
     check in that hour failed, grey if no check was recorded at all. */
  function renderHourlyBar(site, large) {
    var buckets = site.hourlyBuckets || [];
    var wrap = text("div", "hourbar" + (large ? " hourbar-large" : ""), null);
    wrap.setAttribute("role", "img");
    wrap.setAttribute("aria-label", bucketSummary(buckets));

    for (var i = 0; i < 24; i++) {
      var state = bucketState(buckets[i]);
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
    row.appendChild(text("span", "hourbar-pct", uptimeLabel(site, "No data")));
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
    stat("Uptime 24h", uptimeLabel(site, "—"));
    stat(
      "Failures in a row",
      site.consecutiveFailures === undefined ? "—" : site.consecutiveFailures
    );
    return stats;
  }

  /* A card or a row is an <a> when there is a detail page to reach, and a
     plain element otherwise — never a div pretending to be a link. */
  function linkOrBlock(href, tag, className) {
    var node = document.createElement(href ? "a" : tag);
    node.className = className;
    if (href) node.href = href;
    return node;
  }

  function renderCard(site, options) {
    var href = options.detailHref ? options.detailHref(site.siteId) : null;
    var card = linkOrBlock(
      href,
      "article",
      "card card-" + site.status + (href ? " card-link" : "")
    );

    var head = text("div", "card-head");
    var title = text("div", "card-title");
    title.appendChild(text("span", "dot", null));
    var names = text("div", "card-names");
    names.appendChild(text("h2", null, site.name));
    names.appendChild(text("p", "brand-label", brandOf(site)));
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
    url.title = site.url || "";
    card.appendChild(url);

    card.appendChild(renderHourlyBar(site, false));
    card.appendChild(renderUptimeFooter(site));

    if (options.inlineDetails) {
      card.appendChild(renderStats(site));
      card.appendChild(renderIncidents(site));
    }

    return card;
  }

  /* The compact density. Same data as a card minus the inline detail, laid out
     as aligned columns so thirty monitors read as a table rather than as three
     screens of scrolling. */
  function renderRow(site, options) {
    var href = options.detailHref ? options.detailHref(site.siteId) : null;
    var row = linkOrBlock(
      href,
      "div",
      "monitor-row monitor-row-" + site.status + (href ? " row-link" : "")
    );

    var name = text("div", "row-name");
    name.appendChild(text("span", "dot", null));
    var names = text("div", "row-names");
    names.appendChild(text("span", "row-title", site.name));
    names.appendChild(text("span", "brand-label", brandOf(site)));
    name.appendChild(names);
    row.appendChild(name);

    row.appendChild(
      text("span", "badge badge-" + site.status, site.status.toUpperCase())
    );

    var bar = text("div", "row-bar");
    bar.appendChild(renderHourlyBar(site, false));
    row.appendChild(bar);

    row.appendChild(text("span", "row-uptime", uptimeLabel(site, "—")));
    row.appendChild(
      text(
        "span",
        "row-checked",
        site.status === "paused" ? "paused" : relativeTime(site.lastCheckedAt)
      )
    );
    row.appendChild(renderRing(site));

    return row;
  }

  function listHeader() {
    var head = text("div", "monitor-list-head");
    ["Monitor", "Status", "Last 24 hours", "Uptime", "Checked", "Next"].forEach(
      function (label) {
        head.appendChild(text("span", null, label));
      }
    );
    return head;
  }

  // ------------------------------------------------------------------ summary
  function statBlock(label, value, modifier, isEmpty) {
    var block = text("div", "sumstat" + (modifier ? " sumstat-" + modifier : ""));
    // A placeholder is a sentence, not a measurement. Rendering "Not enough
    // data yet" at the same 20px/700 tabular-nums as a real number made the
    // absence of data louder than the data.
    block.appendChild(
      text("span", "sumstat-value" + (isEmpty ? " sumstat-value-empty" : ""), value)
    );
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

    var uptime = summary.overallUptime24h;
    var hasUptime = uptime !== null && uptime !== undefined;
    // null on these two means "not enough incident history to compute an
    // interval", which is not the same as zero — say so rather than showing a
    // number that reads like a measurement.
    var mtbf = span(summary.mtbfSeconds);
    var since = span(summary.timeSinceLastIncidentSeconds);

    var day = text("section", "panel summary-card");
    day.appendChild(text("h2", null, "Last 24 hours"));
    var dayRow = text("div", "sumstat-row");
    dayRow.appendChild(
      statBlock(
        "Overall uptime",
        hasUptime ? uptime.toFixed(2) + "%" : "No data yet",
        null,
        !hasUptime
      )
    );
    dayRow.appendChild(
      statBlock(
        "Mean time between failures",
        mtbf || "Not enough data yet",
        null,
        !mtbf
      )
    );
    dayRow.appendChild(
      statBlock(
        "Since last incident",
        since || "No incidents recorded",
        null,
        !since
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
      setText(el.overall, "No sites monitored");
      el.overall.className = "overall overall-unknown";
    } else if (down === 0) {
      // Paused sites are counted separately: saying "all 7 operational" when
      // two of them are switched off is the miscount this replaces.
      setText(
        el.overall,
        "All " + active + " active sites operational" +
          (paused ? " · " + paused + " paused" : "")
      );
      el.overall.className = "overall overall-up";
    } else {
      setText(
        el.overall,
        down + " of " + active + " active sites down" +
          (paused ? " · " + paused + " paused" : "")
      );
      el.overall.className = "overall overall-down";
    }
  }

  // ------------------------------------------------------------------ toolbar
  function segButton(label, value, onPick) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "seg";
    button.setAttribute("data-value", value);
    button.appendChild(text("span", "seg-label", label));
    button.addEventListener("click", function () {
      onPick(value);
    });
    return button;
  }

  function syncSegGroup(group, active) {
    Object.keys(group).forEach(function (value) {
      var on = value === active;
      group[value].button.className = "seg" + (on ? " seg-on" : "");
      group[value].button.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function buildToolbar() {
    var nodes = { statusGroup: {}, densityGroup: {}, brandButtons: {} };

    var row = text("div", "toolbar-row");

    var search = document.createElement("input");
    search.type = "search";
    search.className = "toolbar-search";
    search.placeholder = "Search monitors…";
    search.setAttribute("aria-label", "Search monitors by name, URL or brand");
    search.value = filters.query;
    var debounce = null;
    search.addEventListener("input", function () {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(function () {
        filters.query = search.value;
        renderGrid();
      }, SEARCH_DEBOUNCE_MS);
    });
    row.appendChild(search);

    var statusWrap = text("div", "segmented");
    statusWrap.setAttribute("role", "group");
    statusWrap.setAttribute("aria-label", "Filter by status");
    [
      ["All", "all"],
      ["Up", "up"],
      ["Down", "down"],
      ["Paused", "paused"]
    ].forEach(function (pair) {
      var button = segButton(pair[0], pair[1], function (value) {
        filters.status = value;
        syncSegGroup(nodes.statusGroup, value);
        saveView();
        renderGrid();
      });
      var count = text("span", "seg-count", "");
      button.appendChild(count);
      nodes.statusGroup[pair[1]] = { button: button, count: count };
      statusWrap.appendChild(button);
    });
    row.appendChild(statusWrap);

    var densityWrap = text("div", "segmented");
    densityWrap.setAttribute("role", "group");
    densityWrap.setAttribute("aria-label", "Display density");
    [
      ["Cards", "cards"],
      ["List", "list"]
    ].forEach(function (pair) {
      var button = segButton(pair[0], pair[1], function (value) {
        filters.density = value;
        syncSegGroup(nodes.densityGroup, value);
        saveView();
        renderGrid();
      });
      nodes.densityGroup[pair[1]] = { button: button };
      densityWrap.appendChild(button);
    });
    row.appendChild(densityWrap);

    el.toolbar.appendChild(row);

    nodes.brandRow = text("div", "chip-row");
    nodes.brandRow.setAttribute("role", "group");
    nodes.brandRow.setAttribute("aria-label", "Filter by brand");
    nodes.brandRow.hidden = true;
    el.toolbar.appendChild(nodes.brandRow);

    nodes.brandKey = null;
    syncSegGroup(nodes.statusGroup, filters.status);
    syncSegGroup(nodes.densityGroup, filters.density);
    return nodes;
  }

  function syncBrandChips() {
    if (!toolbar || !toolbar.brandButtons) return;
    Object.keys(toolbar.brandButtons).forEach(function (value) {
      var on = value === filters.brand;
      var button = toolbar.brandButtons[value].button;
      button.className = "chip" + (on ? " chip-on" : "");
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function updateStatusCounts(summary) {
    if (!summary) return;
    var counts = {
      all: summary.totalMonitors,
      up: summary.upCount,
      down: summary.downCount,
      paused: summary.pausedCount
    };
    Object.keys(toolbar.statusGroup).forEach(function (value) {
      var entry = toolbar.statusGroup[value];
      var n = counts[value];
      setText(entry.count, n === undefined ? "" : String(n));
      // A status nobody has cannot be filtered to; say so rather than letting
      // someone click into a guaranteed-empty grid.
      entry.button.disabled = value !== "all" && !n;
      if (entry.button.disabled && filters.status === value) {
        filters.status = "all";
        syncSegGroup(toolbar.statusGroup, "all");
        saveView();
      }
    });
  }

  function updateBrandChips(sites) {
    var counts = {};
    var order = [];
    sites.forEach(function (site) {
      var brand = brandOf(site);
      if (counts[brand] === undefined) {
        counts[brand] = 0;
        order.push(brand);
      }
      counts[brand]++;
    });
    order.sort(function (a, b) {
      return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
    });

    // One brand (or none) is not a dimension worth a filter row.
    if (order.length < 2) {
      toolbar.brandRow.hidden = true;
      toolbar.brandKey = null;
      if (filters.brand !== "all") filters.brand = "all";
      return;
    }

    // Rebuild only when the set of brands actually changes, so a 20s poll
    // cannot yank a chip out from under a click.
    var key = order.join(String.fromCharCode(10));
    if (key !== toolbar.brandKey) {
      toolbar.brandKey = key;
      toolbar.brandButtons = {};
      toolbar.brandRow.innerHTML = "";

      var chip = function (label, value, count) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "chip";
        button.appendChild(text("span", null, label));
        if (count !== null) button.appendChild(text("span", "chip-count", count));
        button.addEventListener("click", function () {
          filters.brand = value;
          syncBrandChips();
          renderGrid();
        });
        toolbar.brandButtons[value] = { button: button };
        toolbar.brandRow.appendChild(button);
      };

      chip("All brands", "all", null);
      order.forEach(function (brand) {
        chip(brand, brand, counts[brand]);
      });

      if (!toolbar.brandButtons[filters.brand]) filters.brand = "all";
    }

    toolbar.brandRow.hidden = false;
    syncBrandChips();
  }

  function ensureToolbar(payload) {
    if (!el.toolbar) return;
    if (!toolbar) toolbar = buildToolbar();
    updateStatusCounts(payload.summary);
    updateBrandChips(payload.sites || []);
  }

  // ------------------------------------------------------------------ filters
  function filtersActive() {
    return (
      filters.query.trim() !== "" ||
      filters.status !== "all" ||
      filters.brand !== "all"
    );
  }

  function visibleSites(sites) {
    var q = filters.query.trim().toLowerCase();
    return sites.filter(function (site) {
      if (filters.status !== "all" && site.status !== filters.status) return false;
      if (filters.brand !== "all" && brandOf(site) !== filters.brand) return false;
      if (!q) return true;
      return (
        String(site.name || "").toLowerCase().indexOf(q) !== -1 ||
        String(site.url || "").toLowerCase().indexOf(q) !== -1 ||
        brandOf(site).toLowerCase().indexOf(q) !== -1
      );
    });
  }

  function clearFilters() {
    filters.query = "";
    filters.status = "all";
    filters.brand = "all";
    if (toolbar) {
      var search = el.toolbar.querySelector(".toolbar-search");
      if (search) search.value = "";
      syncSegGroup(toolbar.statusGroup, "all");
      syncBrandChips();
    }
    saveView();
    renderGrid();
  }

  /* "Nothing matches your filters" and "nothing is being monitored" are
     different problems with different fixes; the page used to show the same
     message for both. */
  function filterEmptyNode() {
    if (el.filterEmpty) return el.filterEmpty;
    if (!el.cards || !el.cards.parentNode) return null;

    var node = text("div", "filter-empty", null);
    node.hidden = true;
    node.appendChild(text("p", null, "No monitors match these filters."));
    var button = text("button", null, "Clear filters");
    button.type = "button";
    button.addEventListener("click", clearFilters);
    node.appendChild(button);

    el.cards.parentNode.insertBefore(node, el.cards.nextSibling);
    el.filterEmpty = node;
    return node;
  }

  function updateCounts(total, shown) {
    if (el.resultCount) {
      if (filtersActive() && total > 0) {
        el.resultCount.hidden = false;
        setText(
          el.resultCount,
          "Showing " + shown + " of " + total +
            (total === 1 ? " monitor" : " monitors")
        );
      } else {
        el.resultCount.hidden = true;
      }
    }

    var noneAtAll = total === 0;
    var filteredOut = total > 0 && shown === 0;
    if (el.empty) el.empty.hidden = !noneAtAll;
    var node = filterEmptyNode();
    if (node) node.hidden = !filteredOut;
  }

  // ------------------------------------------------------------------ grid
  function renderSkeleton() {
    if (!el.cards) return;
    el.cards.className = "cards";
    el.cards.setAttribute("aria-busy", "true");
    el.cards.innerHTML = "";
    for (var i = 0; i < SKELETON_CARDS; i++) {
      var card = text("div", "card card-skeleton", null);
      card.setAttribute("aria-hidden", "true");
      card.appendChild(text("span", "sk sk-title", null));
      card.appendChild(text("span", "sk sk-url", null));
      card.appendChild(text("span", "sk sk-bar", null));
      card.appendChild(text("span", "sk sk-foot", null));
      el.cards.appendChild(card);
    }
  }

  function renderGrid() {
    if (!el.cards) return;
    var sites = (lastPayload && lastPayload.sites) || [];
    var shown = visibleSites(sites);
    var list = filters.density === "list";

    // The old ring nodes are about to be thrown away with the cards; drop the
    // references too, or the ticker keeps writing to detached elements.
    rings = [];
    el.cards.className = list ? "monitor-list" : "cards";
    el.cards.innerHTML = "";

    if (list && shown.length) el.cards.appendChild(listHeader());
    shown.forEach(function (site) {
      el.cards.appendChild(
        list ? renderRow(site, lastOptions) : renderCard(site, lastOptions)
      );
    });

    updateCounts(sites.length, shown.length);
    tick();
  }

  function render(payload, options) {
    lastPayload = payload;
    lastOptions = options || {};
    generatedAt = payload.generatedAt;

    if (el.cards) el.cards.removeAttribute("aria-busy");
    ensureToolbar(payload);
    renderSummary(payload.summary);
    renderOverall(payload.summary, payload.sites || []);
    renderGrid();

    // Once per second, independent of the 20s poll, so the countdown moves
    // instead of jumping a third of a minute at a time.
    if (!ticker) ticker = setInterval(tick, TICK_MS);
  }

  function showError(message) {
    if (!el.error) return;
    el.error.textContent = message;
    el.error.hidden = false;
  }

  function setOverall(message, modifier) {
    if (!el.overall) return;
    setText(el.overall, message);
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

    loadView();
    renderSkeleton();

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
          if (el.error) el.error.hidden = true;
          render(payload, opts);
        })
        .catch(function (err) {
          if (err.unauthorized && onUnauthorized) {
            onUnauthorized();
            return;
          }
          if (el.cards) el.cards.removeAttribute("aria-busy");
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
