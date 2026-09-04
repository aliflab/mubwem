/* MuBWeM settings — a read-only view of deploy-time configuration.
 *
 * This is a stub on purpose. Nothing in this app can currently be configured
 * at runtime: the check cadence, the failure threshold, the retention window
 * and the region are all CDK context, baked in at deploy. So this page shows
 * what those values are and says plainly that it cannot change them, rather
 * than presenting inputs that would silently do nothing.
 *
 * Everything shown here comes from the deploy-generated config.js, which is
 * already public — it is served to any browser that loads the dashboard. No
 * secret is displayed and none is available to display.
 */
(function () {
  "use strict";

  var host = document.getElementById("config-list");

  var ROWS = [
    {
      label: "Check interval",
      value: function () {
        var secs = Number(window.MUBWEM_SCHEDULE_INTERVAL_SEC);
        return secs > 0 ? secs + " seconds" : null;
      },
      note: "How often the checker sweeps every enabled site."
    },
    {
      label: "Failure threshold",
      value: function () {
        var n = Number(window.MUBWEM_FAILURE_THRESHOLD);
        return n > 0 ? n + " consecutive failures" : null;
      },
      note: "How many checks in a row must fail before an incident opens and an alert is sent."
    },
    {
      label: "Request timeout",
      value: function () {
        var n = Number(window.MUBWEM_CHECK_TIMEOUT_SEC);
        return n > 0 ? n + " seconds" : null;
      },
      note: "A site that has not responded within this is counted as down."
    },
    {
      label: "Check retention",
      value: function () {
        var n = Number(window.MUBWEM_CHECKS_TTL_DAYS);
        return n > 0 ? n + " days" : null;
      },
      note: "Raw check rows expire on a DynamoDB TTL after this."
    },
    {
      label: "Check region",
      value: function () {
        return window.MUBWEM_CHECK_REGION || null;
      },
      note: "Every check runs from this one region, so it measures what users there experience."
    },
    {
      label: "Sign-in",
      value: function () {
        return window.MUBWEM_COGNITO_DOMAIN ? "Cognito hosted UI" : null;
      },
      note: "Self-signup is disabled; accounts are created from Team Members."
    }
  ];

  function render() {
    host.innerHTML = "";
    ROWS.forEach(function (row) {
      var value = null;
      try {
        value = row.value();
      } catch (e) {
        value = null;
      }

      var dt = document.createElement("dt");
      dt.textContent = row.label;

      var dd = document.createElement("dd");
      var strong = document.createElement("span");
      strong.className = "config-value";
      strong.textContent = value === null || value === undefined ? "—" : value;
      dd.appendChild(strong);
      var note = document.createElement("span");
      note.className = "config-note";
      note.textContent = row.note;
      dd.appendChild(note);

      host.appendChild(dt);
      host.appendChild(dd);
    });
  }

  MubwemShell.boot({
    page: "settings",
    ready: render
  }).catch(function () {
    /* shell.js has already put the message on the page. */
  });
})();
