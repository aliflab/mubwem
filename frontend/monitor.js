/* MuBWeM monitor detail page.
 *
 * Reads ?site=<siteId> and calls GET /status/{siteId}, which returns the site
 * metadata, the hourly buckets, a 24h response-time series and up to 50
 * incidents in one document.
 *
 * The edit form is rendered only for Admins and Editors — the same rule the
 * site-management page uses, and the same caveat: it is presentation, not
 * access control. PATCH /admin/sites/{siteId} re-derives the caller's groups
 * server-side in lambda/admin/handler.py and refuses an Editor-less caller
 * regardless of what this page drew. A Viewer gets the page with no edit
 * control at all rather than a greyed-out one, because a disabled button is
 * an invitation to wonder what it would have done.
 */
(function () {
  "use strict";

  var STATUS_URL = MubwemDashboard.resolveApiUrl("MUBWEM_API_URL", "mubwem.apiUrl");
  var ADMIN_BASE = window.MUBWEM_ADMIN_API_URL || "";
  var SITE_KEY = "mubwem.lastSite";

  var el = {
    name: document.getElementById("site-name"),
    brand: document.getElementById("site-brand"),
    badge: document.getElementById("site-badge"),
    url: document.getElementById("site-url"),
    overview: document.getElementById("overview"),
    hourbarHost: document.getElementById("hourbar-host"),
    hourbarFoot: document.getElementById("hourbar-foot"),
    stats: document.getElementById("detail-stats"),
    editToggle: document.getElementById("edit-toggle"),
    editPanel: document.getElementById("edit-panel"),
    chartPanel: document.getElementById("chart-panel"),
    chartHint: document.getElementById("chart-hint"),
    canvas: document.getElementById("response-chart"),
    incidentsPanel: document.getElementById("incidents-panel"),
    incidentsHost: document.getElementById("incidents-host"),
    updated: document.getElementById("updated"),
    overall: document.getElementById("overall")
  };

  var chart = null;
  var canEdit = false;
  var current = null;

  /* Cognito appends ?code=... to the redirect URI, which wipes our own ?site=
     off the URL on a sign-in round trip. Remember it so the page can still
     tell which monitor it is showing when it comes back. */
  function siteId() {
    var fromQuery = new URLSearchParams(window.location.search).get("site");
    if (fromQuery) {
      try {
        sessionStorage.setItem(SITE_KEY, fromQuery);
      } catch (e) {
        /* private browsing — the round trip just loses the selection */
      }
      return fromQuery;
    }
    try {
      return sessionStorage.getItem(SITE_KEY);
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------ render
  function renderOverview(site) {
    document.title = "MuBWeM — " + site.name;
    el.name.textContent = site.name;
    el.brand.textContent = site.brand || "";

    el.badge.textContent = site.status.toUpperCase();
    el.badge.className = "badge badge-" + site.status;

    el.url.textContent = site.url || "";
    el.url.href = site.url || "#";

    el.hourbarHost.innerHTML = "";
    el.hourbarHost.appendChild(MubwemDashboard.renderHourlyBar(site, true));

    el.hourbarFoot.innerHTML = "";
    var foot = document.createElement("div");
    foot.className = "hourbar-foot";
    function span(cls, value) {
      var node = document.createElement("span");
      node.className = cls;
      node.textContent = value;
      return node;
    }
    foot.appendChild(span("hourbar-scale", "24h ago"));
    foot.appendChild(
      span(
        "hourbar-pct",
        site.uptime24h === null || site.uptime24h === undefined
          ? "No data"
          : site.uptime24h.toFixed(2) + "% uptime"
      )
    );
    foot.appendChild(span("hourbar-scale", "now"));
    el.hourbarFoot.appendChild(foot);

    // The four stats that used to sit on the dashboard card.
    el.stats.innerHTML = "";
    var stats = MubwemDashboard.renderStats(site);
    while (stats.firstChild) el.stats.appendChild(stats.firstChild);

    el.overview.hidden = false;

    if (el.overall) {
      el.overall.textContent =
        site.status === "paused" ? "Paused" : site.status.toUpperCase();
      el.overall.className = "overall overall-" +
        (site.status === "up" ? "up" : site.status === "down" ? "down" : "unknown");
    }
  }

  function renderIncidents(site) {
    el.incidentsHost.innerHTML = "";
    el.incidentsHost.appendChild(MubwemDashboard.renderIncidents(site));
    el.incidentsPanel.hidden = false;
  }

  function renderChart(site) {
    var points = (site.checks || []).filter(function (c) {
      return c.responseTimeMs !== null && c.responseTimeMs !== undefined;
    });

    if (typeof Chart === "undefined") {
      el.chartHint.textContent =
        "The charting library could not be loaded, so the graph is unavailable.";
      el.chartPanel.hidden = false;
      return;
    }

    if (points.length === 0) {
      el.chartHint.textContent =
        "No response times recorded in the last 24 hours.";
      el.chartPanel.hidden = false;
      return;
    }

    var total = (site.checks || []).length;
    el.chartHint.textContent =
      total +
      " sampled point" +
      (total === 1 ? "" : "s") +
      " across the window. The series is thinned server-side at a regular " +
      "interval, so it always spans the full 24 hours.";

    var data = points.map(function (c) {
      return { x: Date.parse(c.checkedAt), y: c.responseTimeMs };
    });

    if (chart) chart.destroy();
    chart = new Chart(el.canvas.getContext("2d"), {
      type: "line",
      data: {
        datasets: [
          {
            label: "Response time (ms)",
            data: data,
            borderColor: "#2563eb",
            backgroundColor: "rgba(37, 99, 235, 0.12)",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.25,
            fill: true
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: "nearest", intersect: false },
        scales: {
          // A linear scale over epoch milliseconds, not Chart.js's time
          // scale: the time scale needs a separate date-adapter library, and
          // a tick callback does the same job here with no second dependency.
          x: {
            type: "linear",
            ticks: {
              maxTicksLimit: 8,
              callback: function (value) {
                return new Date(value).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit"
                });
              }
            },
            grid: { display: false }
          },
          y: {
            beginAtZero: true,
            title: { display: true, text: "ms" }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) {
                return new Date(items[0].parsed.x).toLocaleString();
              },
              label: function (item) {
                return item.parsed.y + " ms";
              }
            }
          }
        }
      }
    });

    el.chartPanel.hidden = false;
  }

  // -------------------------------------------------------------- edit form
  function buildEditForm(site) {
    el.editPanel.innerHTML = "";

    var heading = document.createElement("h2");
    heading.textContent = "Edit monitor";
    el.editPanel.appendChild(heading);

    var form = document.createElement("form");
    form.className = "form-grid";
    form.autocomplete = "off";

    function field(label, name, type, value, extra, help) {
      var wrap = document.createElement("div");
      wrap.className = "field";
      var lab = document.createElement("label");
      lab.textContent = label;
      lab.htmlFor = "edit-" + name;
      var input = document.createElement("input");
      input.id = "edit-" + name;
      input.name = name;
      input.type = type;
      input.value = value === null || value === undefined ? "" : value;
      Object.keys(extra || {}).forEach(function (key) {
        input.setAttribute(key, extra[key]);
      });
      wrap.appendChild(lab);
      wrap.appendChild(input);
      if (help) {
        var note = document.createElement("small");
        note.className = "field-help";
        note.id = "edit-" + name + "-help";
        note.textContent = help;
        input.setAttribute("aria-describedby", note.id);
        wrap.appendChild(note);
      }
      form.appendChild(wrap);
      return input;
    }

    field("Name", "name", "text", site.name, { required: "required" });
    field("URL", "url", "url", site.url, { required: "required" });
    field("Brand", "brand", "text", site.brand || "");
    field(
      "Check interval (s)",
      "checkIntervalSec",
      "number",
      site.checkIntervalSec || 60,
      { min: "60", max: "86400", step: "10" },
      "60s minimum — the scheduler cannot check more often."
    );

    // One row for both switches. Giving each its own .field cell dropped them
    // into whatever grid tracks the text inputs left over, which is how
    // "Public status page" ended up alone, three lines tall and nowhere near
    // its own checkbox.
    var checks = document.createElement("div");
    checks.className = "form-checks";

    function checkbox(label, name, checked) {
      var lab = document.createElement("label");
      lab.className = "check-label";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.name = name;
      input.checked = Boolean(checked);
      lab.appendChild(input);
      // The gap between box and text is CSS now, not a leading space.
      lab.appendChild(document.createTextNode(label));
      checks.appendChild(lab);
    }

    checkbox("Enabled", "enabled", site.enabled);
    checkbox("Public status page", "isPublic", site.isPublic);
    form.appendChild(checks);

    var actions = document.createElement("div");
    actions.className = "form-actions";
    var save = document.createElement("button");
    save.type = "submit";
    save.className = "primary";
    save.textContent = "Save changes";
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", function () {
      el.editPanel.hidden = true;
    });
    actions.appendChild(save);
    actions.appendChild(cancel);
    form.appendChild(actions);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      MubwemShell.clearError();

      var body = {
        name: form.elements.name.value.trim(),
        url: form.elements.url.value.trim(),
        brand: form.elements.brand.value.trim(),
        checkIntervalSec: Number(form.elements.checkIntervalSec.value) || 60,
        enabled: form.elements.enabled.checked,
        isPublic: form.elements.isPublic.checked
      };
      if (!body.brand) delete body.brand;

      if (body.url.indexOf("https://") !== 0) {
        MubwemShell.showError("URL must start with https://");
        return;
      }

      // Mirrors the server's floor in lambda/admin/handler.py. A site already
      // holding a sub-60 value will show it here, so this also catches an
      // unchanged save of a legacy row and tells the user why.
      if (body.checkIntervalSec < 60) {
        MubwemShell.showError(
          "Check interval must be at least 60 seconds — the scheduler " +
            "cannot check more often than once a minute."
        );
        return;
      }

      save.disabled = true;
      MubwemShell.apiFetch(
        ADMIN_BASE + "/sites/" + encodeURIComponent(site.siteId),
        { method: "PATCH", body: body }
      )
        .then(function () {
          MubwemShell.showNotice("Saved.");
          el.editPanel.hidden = true;
          return load();
        })
        .catch(function (err) {
          MubwemShell.showError(err.message);
        })
        .then(function () {
          save.disabled = false;
        });
    });

    el.editPanel.appendChild(form);
  }

  // ------------------------------------------------------------------- load
  function load() {
    var id = siteId();
    if (!id) {
      MubwemShell.showError(
        "No monitor selected. Pick one from the dashboard."
      );
      return Promise.resolve();
    }

    return MubwemShell.apiFetch(STATUS_URL + "/" + encodeURIComponent(id))
      .then(function (payload) {
        current = payload.site;
        MubwemShell.clearError();
        if (el.updated) {
          el.updated.textContent = MubwemDashboard.relativeTime(payload.generatedAt);
        }
        renderOverview(current);
        renderChart(current);
        renderIncidents(current);
        if (canEdit) {
          el.editToggle.hidden = false;
          buildEditForm(current);
        }
      })
      .catch(function (err) {
        if (err.status === 404) {
          MubwemShell.showError("No such monitor, or it is no longer available.");
          return;
        }
        MubwemShell.showError("Could not load this monitor: " + err.message);
      });
  }

  MubwemShell.boot({
    page: "dashboard",
    ready: function () {
      canEdit = MubwemAuth.inAnyGroup(["Admins", "Editors"]);
      if (canEdit && el.editToggle) {
        el.editToggle.addEventListener("click", function () {
          el.editPanel.hidden = !el.editPanel.hidden;
        });
      }
      load();
    }
  }).catch(function () {
    /* shell.js has already put the message on the page. */
  });
})();
