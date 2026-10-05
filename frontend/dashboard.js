/* MuBWeM monitor-list rendering — plain JS, no build step.
 *
 * Drives the authenticated dashboard (app.js, GET /status). The response
 * shape is documented at the top of lambda/api/handler.py. renderStats and
 * renderIncidents are also exported for monitor.js, so a site reads the same
 * way on its detail page as it does on a card.
 *
 * Usage:
 *   MubwemDashboard.start({
 *     apiUrl: "https://.../status",
 *     headers: function () { return { Authorization: "Bearer ..." }; },  // optional
 *     onUnauthorized: function () { ... },                              // optional
 *     detailHref: function (siteId) { return "/monitor?site=" + siteId; }
 *   });
 *
 * detailHref makes each card a link through to its detail page.
 *
 * FILTERING
 *
 * The toolbar (search, status, density) filters the payload that has
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
  // How many consecutive failures the backend counts as an incident. Comes
  // from the payload, which gets it from the same env var the checker reads,
  // so the tooltip wording cannot drift from the rule that produced the bar.
  var failureThreshold = 3;

  var filters = { query: "", status: "all", density: "cards" };
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
    resultCount: document.getElementById("result-count")
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
     Not the search text (stale and confusing on return). Same rule as the API URL above —
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

  // EventBridge Scheduler cannot fire more often than once a minute, so a ring
  // counting down from less than that would run two cycles per real check and
  // look like it was working. This is a defensive floor for rows written
  // before the write path enforced it, not the source of truth - the real fix
  // is the value in DynamoDB, corrected through the edit form.
  var MIN_INTERVAL_SEC = 60;

  /* A site's own configured interval, which every /status route now returns.
     The global cadence is the fallback for a site whose row predates the
     field - it should not happen, but a ring counting the wrong number is
     worse than a ring counting an approximate one. */
  function intervalFor(site) {
    var own = Number(site && site.checkIntervalSec);
    return Math.max(own > 0 ? own : scheduleIntervalSec(), MIN_INTERVAL_SEC);
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
    // The status goes on the ring itself, not just on whatever contains it.
    // The stroke colour used to be selected as `.card-up .ring-progress`,
    // which silently depended on the ring living inside a card - a list row
    // carries `.monitor-row-up` instead, matched no rule, and rendered grey.
    var wrap = text("div", "ring ring-" + site.status, null);
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
    return value === "up" || value === "down" || value === "warn"
      ? value
      : "none";
  }

  /* A spoken summary of the bar, since the bar itself is pure colour and the
     per-cell title tooltips are invisible to a screen reader and to touch. */
  function bucketSummary(buckets) {
    var counts = { up: 0, warn: 0, down: 0, none: 0 };
    for (var i = 0; i < 24; i++) counts[bucketState(buckets[i])]++;

    var parts = [];
    function part(n, singular, plural) {
      if (n) parts.push(n + " " + (n === 1 ? singular : plural));
    }
    part(counts.down, "hour with an incident", "hours with incidents");
    part(counts.warn, "hour with an isolated failure", "hours with isolated failures");
    part(counts.up, "hour fully up", "hours fully up");
    part(counts.none, "hour with no checks", "hours with no checks");
    return "Last 24 hours: " + (parts.length ? parts.join(", ") : "no data");
  }

  /* "14:00–15:00" for bucket i, which covers the hour ending (24 - i - 1)
     hours before now. The buckets are rolling and anchored on the server's
     generatedAt, which is at most one poll old, so the client clock is close
     enough for a label. */
  function bucketWindow(index) {
    var end = new Date(Date.now() - (23 - index) * 3600000);
    var start = new Date(end.getTime() - 3600000);
    return (
      MubwemShell.formatTimeOfDay(start) + "–" + MubwemShell.formatTimeOfDay(end)
    );
  }

  function bucketExplanation(state, threshold) {
    if (state === "down") {
      return "recorded incident (" + threshold + "+ consecutive failures)";
    }
    if (state === "warn") {
      return "a check failed, but not enough in a row to reach the incident threshold - not counted as downtime";
    }
    if (state === "up") return "all checks succeeded";
    return "no checks recorded";
  }

  /* 24 bars, one per hour of the last 24 hours, oldest on the left.

     The buckets are computed server-side (hourly_buckets() in the API) over
     the same 24h of checks the uptime percentage uses, so the bar and the
     percentage under it always describe the same window. A bar is red if the
     hour was part of an incident, amber for an isolated failure (which does
     not lower the percentage), grey if no check was recorded at all. */
  function renderHourlyBar(site, large, threshold) {
    var buckets = site.hourlyBuckets || [];
    var limit = threshold || failureThreshold;
    var wrap = text("div", "hourbar" + (large ? " hourbar-large" : ""), null);
    wrap.setAttribute("role", "img");
    wrap.setAttribute("aria-label", bucketSummary(buckets));

    for (var i = 0; i < 24; i++) {
      var state = bucketState(buckets[i]);
      var bar = text("span", "hourbar-cell hourbar-" + state, null);
      bar.title =
        bucketWindow(i) + ": " + bucketExplanation(state, limit);
      wrap.appendChild(bar);
    }
    return wrap;
  }

  /* One line explaining what the three colours mean. Rendered once per page
     rather than under every card - twenty-four cards do not need twenty-four
     legends. */
  function renderLegend(threshold) {
    var limit = threshold || failureThreshold;
    var wrap = text("div", "bucket-legend", null);
    [
      ["down", "Incident (" + limit + "+ failures in a row)"],
      ["warn", "Isolated failure"],
      ["up", "Healthy"],
      ["none", "No data"]
    ].forEach(function (pair) {
      var item = text("span", "legend-item", null);
      item.appendChild(text("span", "legend-swatch hourbar-" + pair[0], null));
      item.appendChild(text("span", null, pair[1]));
      wrap.appendChild(item);
    });
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

      li.appendChild(
        text("span", "incident-when", MubwemShell.formatDateTime(inc.startedAt))
      );
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
    // One wrapper per label/value pair, so the grid places one item per stat.
    // A <div> grouping a <dt> and its <dd> is valid inside a <dl>.
    function stat(label, value) {
      var item = text("div", "stat");
      item.appendChild(text("dt", null, label));
      item.appendChild(text("dd", null, value));
      stats.appendChild(item);
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

    return card;
  }

  /* The compact density. Same data as a card, laid out
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
    var nodes = { statusGroup: {}, densityGroup: {} };

    var row = text("div", "toolbar-row");

    // Wrapped so the magnifier can sit inside the field. The icon comes from
    // nav.js's hand-written set - there is no icon font on this page.
    var searchWrap = text("div", "search-wrap", null);
    if (window.MubwemNav && MubwemNav.icon) {
      searchWrap.appendChild(MubwemNav.icon("search"));
    }

    var search = document.createElement("input");
    search.type = "search";
    search.className = "toolbar-search";
    search.placeholder = "Search monitors…";
    search.setAttribute("aria-label", "Search monitors by name or URL");
    search.value = filters.query;
    var debounce = null;
    search.addEventListener("input", function () {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(function () {
        filters.query = search.value;
        renderGrid();
      }, SEARCH_DEBOUNCE_MS);
    });
    searchWrap.appendChild(search);
    row.appendChild(searchWrap);

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

    syncSegGroup(nodes.statusGroup, filters.status);
    syncSegGroup(nodes.densityGroup, filters.density);
    return nodes;
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

  function ensureToolbar(payload) {
    if (!el.toolbar) return;
    if (!toolbar) toolbar = buildToolbar();
    updateStatusCounts(payload.summary);
  }

  // ------------------------------------------------------------------ filters
  function filtersActive() {
    return (
      filters.query.trim() !== "" ||
      filters.status !== "all"
    );
  }

  function visibleSites(sites) {
    var q = filters.query.trim().toLowerCase();
    return sites.filter(function (site) {
      if (filters.status !== "all" && site.status !== filters.status) return false;
      if (!q) return true;
      return (
        String(site.name || "").toLowerCase().indexOf(q) !== -1 ||
        String(site.url || "").toLowerCase().indexOf(q) !== -1
      );
    });
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

    // A filtered-to-zero grid is left empty; the result count above it
    // ("Showing 0 of 8 monitors") is the signal that a filter is hiding
    // everything. #empty is the different case - nothing monitored at all.
    if (el.empty) el.empty.hidden = total !== 0;
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

  /* Incidents that have not resolved, across every site in the payload. Feeds
     the unread-style badge on the Incidents nav item. */
  function openIncidentCount(payload) {
    var open = 0;
    (payload.sites || []).forEach(function (site) {
      (site.incidents || []).forEach(function (incident) {
        if (!incident.resolved) open++;
      });
    });
    return open;
  }

  function render(payload, options) {
    lastPayload = payload;
    lastOptions = options || {};
    generatedAt = payload.generatedAt;
    if (payload.failureThreshold > 0) failureThreshold = payload.failureThreshold;
    if (window.MubwemNav) MubwemNav.setIncidentCount(openIncidentCount(payload));

    var legendHost = document.getElementById("bucket-legend");
    if (legendHost) {
      legendHost.innerHTML = "";
      legendHost.appendChild(renderLegend(failureThreshold));
    }

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
    // Redraw from the payload already in hand - a zone change needs no request.
    MubwemShell.onTimeZoneChange(function () {
      if (lastPayload) render(lastPayload, lastOptions);
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
    renderLegend: renderLegend,
    renderIncidents: renderIncidents,
    renderStats: renderStats,
    relativeTime: relativeTime,
    duration: duration
  };
})();
