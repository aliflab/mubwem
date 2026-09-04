/* MuBWeM incidents page — a flat, cross-site incident list.
 *
 * KNOWN LIMITATION, deliberate for this pass.
 *
 * This page is built from the incident lists already embedded in the GET
 * /status response, which the API caps at the 5 most recent incidents per
 * site. So this is "the most recent incidents in the mix", not a full history:
 * a site with six outages yesterday contributes only its newest five, and
 * nothing older than that is reachable from here at all.
 *
 * A true history view needs a backend route that queries the Incidents table
 * across every site with pagination — an unbounded scan over a table that
 * grows forever, which is a real feature with real cost, not a tweak to this
 * page. It is on the roadmap in the README rather than smuggled in here.
 *
 * The filter is entirely client-side over what the payload already contains,
 * so it costs no extra request and adds no backend surface.
 */
(function () {
  "use strict";

  var API_URL = MubwemDashboard.resolveApiUrl("MUBWEM_API_URL", "mubwem.apiUrl");
  var POLL_MS = 60000;

  var el = {
    rows: document.getElementById("incident-rows"),
    empty: document.getElementById("incidents-empty"),
    filter: document.getElementById("site-filter"),
    updated: document.getElementById("updated"),
    overall: document.getElementById("overall"),
    scopeNote: document.getElementById("scope-note")
  };

  var incidents = [];
  var siteNames = [];

  function text(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = value;
    return node;
  }

  function collect(payload) {
    var sites = payload.sites || [];
    var out = [];
    var names = [];

    sites.forEach(function (site) {
      names.push(site.name);
      (site.incidents || []).forEach(function (incident) {
        out.push({
          siteId: site.siteId,
          siteName: site.name,
          startedAt: incident.startedAt,
          startedMs: Date.parse(incident.startedAt),
          durationSec: incident.durationSec,
          resolved: incident.resolved,
          triggerReason: incident.triggerReason || ""
        });
      });
    });

    // Newest first. NaN timestamps sort to the end rather than scrambling the
    // order around them.
    out.sort(function (a, b) {
      var left = isNaN(a.startedMs) ? -Infinity : a.startedMs;
      var right = isNaN(b.startedMs) ? -Infinity : b.startedMs;
      return right - left;
    });

    names.sort(function (a, b) {
      return String(a).toLowerCase() < String(b).toLowerCase() ? -1 : 1;
    });

    return { incidents: out, names: names };
  }

  function syncFilter(names) {
    if (String(names) === String(siteNames)) return;
    siteNames = names;

    var chosen = el.filter.value;
    el.filter.innerHTML = "";
    el.filter.appendChild(new Option("All monitors", ""));
    names.forEach(function (name) {
      el.filter.appendChild(new Option(name, name));
    });
    // Keep the current selection across a poll, unless that monitor is gone.
    el.filter.value = names.indexOf(chosen) === -1 ? "" : chosen;
  }

  function render() {
    var chosen = el.filter.value;
    var shown = chosen
      ? incidents.filter(function (i) {
          return i.siteName === chosen;
        })
      : incidents;

    el.rows.innerHTML = "";
    shown.forEach(function (incident) {
      var row = document.createElement("tr");
      if (!incident.resolved) row.className = "row-open";

      var siteCell = text("td", null, null);
      var link = document.createElement("a");
      link.href = "monitor.html?site=" + encodeURIComponent(incident.siteId);
      link.textContent = incident.siteName;
      siteCell.appendChild(link);
      row.appendChild(siteCell);

      var when = new Date(incident.startedAt);
      row.appendChild(
        text(
          "td",
          null,
          isNaN(when.getTime()) ? incident.startedAt : when.toLocaleString()
        )
      );

      row.appendChild(
        text(
          "td",
          incident.resolved ? null : "cell-open",
          incident.resolved
            ? MubwemShell.durationLabel(incident.durationSec)
            : "ongoing"
        )
      );

      row.appendChild(text("td", "cell-reason", incident.triggerReason));
      el.rows.appendChild(row);
    });

    if (shown.length === 0) {
      el.empty.hidden = false;
      el.empty.textContent = chosen
        ? "No incidents recorded for " + chosen + "."
        : "No incidents recorded.";
    } else {
      el.empty.hidden = true;
    }
  }

  function refresh() {
    return MubwemShell.apiFetch(API_URL)
      .then(function (payload) {
        MubwemShell.clearError();
        var collected = collect(payload);
        incidents = collected.incidents;
        syncFilter(collected.names);
        render();

        if (el.updated) {
          el.updated.textContent = MubwemDashboard.relativeTime(payload.generatedAt);
        }
        if (el.overall) {
          var open = incidents.filter(function (i) {
            return !i.resolved;
          }).length;
          el.overall.textContent = open
            ? open + " ongoing"
            : incidents.length + " recorded";
          el.overall.className = "overall overall-" + (open ? "down" : "up");
        }
        el.scopeNote.textContent =
          "Sourced from the dashboard feed, which carries the 5 most recent " +
          "incidents per monitor — so this is recent history, not a complete " +
          "log.";
      })
      .catch(function (err) {
        el.empty.hidden = true;
        MubwemShell.showError("Could not load incidents: " + err.message);
      });
  }

  MubwemShell.boot({
    page: "incidents",
    ready: function () {
      el.filter.addEventListener("change", render);
      refresh();
      setInterval(refresh, POLL_MS);
    }
  }).catch(function () {
    /* shell.js has already put the message on the page. */
  });
})();
