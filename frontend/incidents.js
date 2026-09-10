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
    scopeNote: document.getElementById("scope-note"),
    exportBtn: document.getElementById("export-csv")
  };

  var incidents = [];
  var siteNames = [];

  var QUOTE = String.fromCharCode(34);
  var CRLF = String.fromCharCode(13) + String.fromCharCode(10);
  var BOM = String.fromCharCode(0xfeff);

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
      link.href = "/monitor?site=" + encodeURIComponent(incident.siteId);
      link.textContent = incident.siteName;
      siteCell.appendChild(link);
      row.appendChild(siteCell);

      // Two states only. The design reference showed an "Acknowledged"
      // middle state; this app has no such concept - an incident is open
      // until the checker sees a success - so inventing one here would
      // describe a workflow that does not exist.
      var statusCell = text("td", null, null);
      statusCell.appendChild(
        text(
          "span",
          "badge " + (incident.resolved ? "badge-up" : "badge-down"),
          incident.resolved ? "RESOLVED" : "ONGOING"
        )
      );
      row.appendChild(statusCell);

      row.appendChild(
        text("td", null, MubwemShell.formatDateTime(incident.startedAt))
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

  /* ------------------------------------------------------------ CSV export
     Real, not a stub: the rows are already in memory, so the file is built
     and downloaded here with no backend call and no new endpoint.

     Quoting follows RFC 4180 - every field is quoted and an embedded quote is
     doubled. That matters because triggerReason is free text straight from
     the checker ("3 consecutive failures - URLError: timed out"), and an
     unquoted comma in it would silently shift every later column. */
  function csvCell(value) {
    var str = value === null || value === undefined ? "" : String(value);
    return QUOTE + str.split(QUOTE).join(QUOTE + QUOTE) + QUOTE;
  }

  function buildCsv(rows) {
    var lines = [
      ["Monitor", "Status", "Started", "Duration (s)", "Trigger"]
        .map(csvCell)
        .join(",")
    ];
    rows.forEach(function (incident) {
      lines.push(
        [
          incident.siteName,
          incident.resolved ? "Resolved" : "Ongoing",
          // Offset-bearing ISO in the display timezone, so the file agrees
          // with the table it was exported from. Still machine-readable -
          // a spreadsheet parses "+10:00" the same way it parses "Z".
          MubwemShell.formatIsoInZone(incident.startedAt),
          // Blank rather than 0 for an incident still running: a duration of
          // zero would read as "it lasted no time at all".
          incident.resolved && incident.durationSec !== null &&
            incident.durationSec !== undefined
            ? incident.durationSec
            : "",
          incident.triggerReason
        ]
          .map(csvCell)
          .join(",")
      );
    });
    // CRLF and a UTF-8 BOM so Excel opens it as UTF-8 rather than mangling
    // any non-ASCII in a monitor name.
    return BOM + lines.join(CRLF) + CRLF;
  }

  function exportCsv() {
    var chosen = el.filter.value;
    var rows = chosen
      ? incidents.filter(function (i) {
          return i.siteName === chosen;
        })
      : incidents;

    if (!rows.length) {
      MubwemShell.showError("Nothing to export - no incidents are listed.");
      return;
    }

    // Filename stays UTC whatever the display zone is, so downloaded files
    // keep sorting chronologically in a directory listing.
    var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    var name =
      "mubwem-incidents-" +
      (chosen ? chosen.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" : "") +
      stamp +
      ".csv";

    var blob = new Blob([buildCsv(rows)], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Let the download start before the blob is released.
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);

    MubwemShell.showNotice(
      "Exported " + rows.length + (rows.length === 1 ? " incident" : " incidents") +
        " to " + name + "."
    );
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
        var open = incidents.filter(function (i) {
          return !i.resolved;
        }).length;
        if (window.MubwemNav) MubwemNav.setIncidentCount(open);
        if (el.overall) {
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
      if (el.exportBtn) el.exportBtn.addEventListener("click", exportCsv);
      MubwemShell.onTimeZoneChange(render);
      refresh();
      setInterval(refresh, POLL_MS);
    }
  }).catch(function () {
    /* shell.js has already put the message on the page. */
  });
})();
