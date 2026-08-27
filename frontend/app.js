/* MuBWeM dashboard — plain JS, no build step.
 *
 * Consumes GET /status (shape documented at the top of lambda/api/handler.py)
 * and re-renders a card per site every POLL_MS.
 */
(function () {
  "use strict";

  var POLL_MS = 20000;

  // Deploy-time config.js sets window.MUBWEM_API_URL. For local development,
  // append ?api=https://... once and it is remembered in localStorage.
  function resolveApiUrl() {
    var fromQuery = new URLSearchParams(window.location.search).get("api");
    if (fromQuery) {
      try {
        localStorage.setItem("mubwem.apiUrl", fromQuery);
      } catch (e) {
        /* private browsing — fine, it just will not persist */
      }
      return fromQuery;
    }
    if (window.MUBWEM_API_URL) return window.MUBWEM_API_URL;
    try {
      return localStorage.getItem("mubwem.apiUrl");
    } catch (e) {
      return null;
    }
  }

  var API_URL = resolveApiUrl();

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
    head.appendChild(
      text("span", "badge badge-" + site.status, site.status.toUpperCase())
    );
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
      el.overall.textContent =
        down + " of " + sites.length + " sites down";
      el.overall.className = "overall overall-down";
    }
  }

  function render(payload) {
    var sites = payload.sites || [];
    el.cards.innerHTML = "";
    sites.forEach(function (site) {
      el.cards.appendChild(renderCard(site));
    });
    el.empty.hidden = sites.length > 0;
    el.updated.textContent = relativeTime(payload.generatedAt);
    renderOverall(sites);
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
  }

  // ----------------------------------------------------------------- polling
  function refresh() {
    if (!API_URL) {
      showError(
        "No API URL configured. Deploy the stack (config.js is generated for you) " +
          "or open this page with ?api=https://your-api-url/status"
      );
      return;
    }

    fetch(API_URL, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("API returned HTTP " + res.status);
        return res.json();
      })
      .then(function (payload) {
        el.error.hidden = true;
        render(payload);
      })
      .catch(function (err) {
        showError("Could not load status: " + err.message);
      });
  }

  refresh();
  setInterval(refresh, POLL_MS);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh();
  });
})();
