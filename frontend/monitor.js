/* MuBWeM monitor detail page.
 *
 * Reads ?site=<siteId> and calls GET /status/{siteId}, which returns the site
 * metadata, the hourly buckets, a 24h response-time series and up to 50
 * incidents in one document.
 *
 * The edit form carries the same "Detect name" convenience as the Add Monitor
 * page, implemented once in shell.js: it reads a suggestion off the site's own
 * page via POST /admin/sites/preview.
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
  var generatedAt = null;
  var failureThreshold = 3;

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

  /* Capture it now, for the side effect, before anything can navigate away.
     The alert email links straight here, so the reader is usually signed out:
     MubwemShell.boot() below hands off to MubwemAuth.init(), which redirects
     to the hosted UI without ever returning. Reading ?site= only inside
     load() would be too late - by the time load() runs the URL is
     /monitor?code=... and the site id is gone. */
  siteId();

  // ------------------------------------------------------------------ render
  function renderOverview(site) {
    document.title = "MuBWeM — " + site.name;
    el.name.textContent = site.name;

    el.badge.textContent = site.status.toUpperCase();
    el.badge.className = "badge badge-" + site.status;

    el.url.textContent = site.url || "";
    el.url.href = site.url || "#";

    el.hourbarHost.innerHTML = "";
    el.hourbarHost.appendChild(
      MubwemDashboard.renderHourlyBar(site, true, failureThreshold)
    );

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
    // The legend sits directly under the large bar here; the dashboard renders
    // it once for the whole page instead.
    el.hourbarFoot.appendChild(MubwemDashboard.renderLegend(failureThreshold));

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

  var HOUR_MS = 3600 * 1000;
  var WINDOW_MS = 24 * HOUR_MS;
  // Hours between labelled x-axis ticks.
  var TICK_EVERY_HOURS = 3;

  function cssVar(name, fallback) {
    var value = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return value || fallback;
  }

  /* Whole-hour tick positions across [min, max] whose wall-clock hour in the
     display zone is a multiple of TICK_EVERY_HOURS, so the labels read 00:00,
     03:00, 06:00 in whatever zone the viewer picked rather than drifting with
     the moment the page loaded. */
  function hourTicks(min, max) {
    var ticks = [];
    for (var t = Math.ceil(min / HOUR_MS) * HOUR_MS; t <= max; t += HOUR_MS) {
      var hour = parseInt(MubwemShell.formatTimeOfDay(t), 10);
      if (!isNaN(hour) && hour % TICK_EVERY_HOURS === 0) ticks.push({ value: t });
    }
    return ticks;
  }

  // A dashed horizontal reference line at the window's average, labelled at
  // the right edge. A plugin rather than a dataset so it never competes with
  // real checks for the tooltip.
  var averageLinePlugin = {
    id: "averageLine",
    afterDatasetsDraw: function (c, args, opts) {
      if (opts.value === null || opts.value === undefined) return;
      var area = c.chartArea;
      var y = c.scales.y.getPixelForValue(opts.value);
      if (y < area.top || y > area.bottom) return;
      var ctx = c.ctx;
      ctx.save();
      ctx.strokeStyle = opts.color;
      ctx.fillStyle = opts.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(area.left, y);
      ctx.lineTo(area.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "11px Inter, system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillText("avg " + Math.round(opts.value) + " ms", area.right - 4, y - 3);
      ctx.restore();
    }
  };

  function renderChart(site, generatedAt) {
    var checks = site.checks || [];
    var points = checks.filter(function (c) {
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

    var data = points.map(function (c) {
      return { x: Date.parse(c.checkedAt), y: c.responseTimeMs };
    });

    // Failed checks get their own red markers. One with no response at all
    // (timeout, DNS, TLS) has no time to plot, so it sits on the baseline.
    var failures = checks
      .filter(function (c) { return !c.isUp; })
      .map(function (c) {
        var hasTime = c.responseTimeMs !== null && c.responseTimeMs !== undefined;
        return {
          x: Date.parse(c.checkedAt),
          y: hasTime ? c.responseTimeMs : 0,
          noResponse: !hasTime
        };
      });

    var sorted = data.map(function (p) { return p.y; }).sort(function (a, b) {
      return a - b;
    });
    var sum = sorted.reduce(function (acc, v) { return acc + v; }, 0);
    var avg = sum / sorted.length;
    var p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];

    el.chartHint.textContent =
      "Min " + sorted[0] + " ms · Avg " + Math.round(avg) + " ms · p95 " + p95 +
      " ms · Max " + sorted[sorted.length - 1] + " ms, over " + checks.length +
      " sampled check" + (checks.length === 1 ? "" : "s") +
      (failures.length
        ? ", " + failures.length + " failed (red)"
        : "") +
      ". The series is thinned server-side at a regular interval, so it " +
      "always spans the full 24 hours.";

    // Pin the axis to the whole window, not just the span that has data, so
    // a site added two hours ago reads as "two hours of history".
    var windowEnd = Date.parse(generatedAt);
    if (isNaN(windowEnd)) windowEnd = data[data.length - 1].x;
    var windowStart = windowEnd - WINDOW_MS;

    var textColor = cssVar("--muted", "#94a3b8");
    var gridColor = cssVar("--border-soft", "#24334a");
    var downColor = cssVar("--down", "#ef4444");
    var axisTitle = {
      display: true,
      color: cssVar("--text-dim", "#cbd5e1"),
      font: { size: 12, weight: "600" }
    };

    if (chart) chart.destroy();
    chart = new Chart(el.canvas.getContext("2d"), {
      type: "line",
      data: {
        datasets: [
          {
            label: "Response time",
            data: data,
            borderColor: "#2563eb",
            backgroundColor: "rgba(37, 99, 235, 0.12)",
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.25,
            fill: true,
            order: 2
          },
          {
            label: "Failed check",
            data: failures,
            showLine: false,
            pointRadius: 3.5,
            pointHoverRadius: 5,
            pointBackgroundColor: downColor,
            pointBorderColor: downColor,
            borderColor: downColor,
            backgroundColor: downColor,
            order: 1
          }
        ]
      },
      plugins: [averageLinePlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        scales: {
          // A linear scale over epoch milliseconds, not Chart.js's time
          // scale: the time scale needs a separate date-adapter library, and
          // a tick callback does the same job here with no second dependency.
          x: {
            type: "linear",
            min: windowStart,
            max: windowEnd,
            afterBuildTicks: function (axis) {
              axis.ticks = hourTicks(windowStart, windowEnd);
            },
            ticks: {
              color: textColor,
              callback: function (value) {
                return MubwemShell.formatTimeOfDay(value);
              }
            },
            grid: { color: gridColor },
            border: { color: gridColor },
            title: Object.assign(
              { text: "Time (" + MubwemShell.zoneLabel() + ")" },
              axisTitle
            )
          },
          y: {
            beginAtZero: true,
            ticks: { color: textColor },
            grid: { color: gridColor },
            border: { color: gridColor },
            title: Object.assign({ text: "Response time (ms)" }, axisTitle)
          }
        },
        plugins: {
          averageLine: { value: avg, color: textColor },
          legend: {
            // Only worth a legend once there is a second series to tell apart.
            display: failures.length > 0,
            labels: {
              color: textColor,
              usePointStyle: true,
              boxHeight: 6,
              // `order` puts the failure markers on top; keep the legend in
              // dataset order regardless.
              sort: function (a, b) { return a.datasetIndex - b.datasetIndex; }
            }
          },
          tooltip: {
            callbacks: {
              title: function (items) {
                return MubwemShell.formatDateTime(items[0].parsed.x);
              },
              label: function (item) {
                if (item.datasetIndex === 1) {
                  return item.raw.noResponse
                    ? "Failed — no response"
                    : "Failed — " + item.parsed.y + " ms";
                }
                return "Response time: " + item.parsed.y + " ms";
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

    function field(label, name, type, value, extra, help, action) {
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
      if (action) {
        // The input and its button share a row; the button is decoration on
        // the field, not a second field.
        var row = document.createElement("div");
        row.className = "input-with-action";
        row.appendChild(input);
        row.appendChild(action);
        wrap.appendChild(row);
      } else {
        wrap.appendChild(input);
      }
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

    var nameInput = field("Name", "name", "text", site.name, {
      required: "required"
    });

    var detectButton = document.createElement("button");
    detectButton.type = "button";
    detectButton.className = "secondary";
    detectButton.textContent = "Detect name";
    var urlInput = field(
      "URL",
      "url",
      "url",
      site.url,
      { required: "required" },
      null,
      detectButton
    );

    // Sits under the URL field, where the button that drives it is.
    var detectStatus = document.createElement("small");
    detectStatus.className = "detect-status";
    detectStatus.id = "edit-detect-status";
    detectStatus.setAttribute("role", "status");
    detectStatus.setAttribute("aria-live", "polite");
    detectStatus.hidden = true;
    urlInput.parentNode.appendChild(detectStatus);

    field(
      "Check interval (s)",
      "checkIntervalSec",
      "number",
      site.checkIntervalSec || 60,
      { min: "60", max: "86400", step: "10" },
      "60s minimum — the scheduler cannot check more often."
    );

    // Its own row, outside the grid that tracks the text inputs — a switch
    // dropped into a leftover grid cell lands three lines tall and nowhere
    // near its own label.
    var checks = document.createElement("div");
    checks.className = "form-checks";

    /* A track-and-thumb switch, the same one the Monitors table uses, rather
       than a bare checkbox. The <input> keeps its name so
       form.elements.enabled still reads it. */
    function toggleField(label, hint, name, checked) {
      var wrap = document.createElement("label");
      wrap.className = "switch-field";

      var toggle = document.createElement("span");
      toggle.className = "toggle";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.name = name;
      input.checked = Boolean(checked);
      toggle.appendChild(input);
      var track = document.createElement("span");
      track.className = "toggle-track";
      toggle.appendChild(track);
      wrap.appendChild(toggle);

      var textWrap = document.createElement("span");
      textWrap.className = "switch-text";
      var title = document.createElement("span");
      title.className = "switch-title";
      title.textContent = label;
      var sub = document.createElement("span");
      sub.className = "switch-hint";
      sub.textContent = hint;
      textWrap.appendChild(title);
      textWrap.appendChild(sub);
      wrap.appendChild(textWrap);

      checks.appendChild(wrap);
    }

    toggleField(
      "Enabled",
      "The checker sweeps this monitor every minute.",
      "enabled",
      site.enabled
    );
    form.appendChild(checks);

    // Wired from shell.js so this form and the Add Monitor page behave the
    // same way. It never blocks a save: if detection fails, the name is
    // still typed by hand.
    MubwemShell.attachNameDetection({
      urlInput: urlInput,
      nameInput: nameInput,
      button: detectButton,
      status: detectStatus,
      adminBase: ADMIN_BASE
    });

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
        checkIntervalSec: Number(form.elements.checkIntervalSec.value) || 60,
        enabled: form.elements.enabled.checked
      };

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
        generatedAt = payload.generatedAt;
        if (payload.failureThreshold > 0) failureThreshold = payload.failureThreshold;
        MubwemShell.clearError();
        if (el.updated) {
          el.updated.textContent = MubwemDashboard.relativeTime(payload.generatedAt);
        }
        renderOverview(current);
        renderChart(current, generatedAt);
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
      // Redraw the monitor already loaded, including the Chart.js axis and
      // tooltips, without re-fetching it.
      MubwemShell.onTimeZoneChange(function () {
        if (!current) return;
        renderOverview(current);
        renderChart(current, generatedAt);
        renderIncidents(current);
      });
      load();
    }
  }).catch(function () {
    /* shell.js has already put the message on the page. */
  });
})();
