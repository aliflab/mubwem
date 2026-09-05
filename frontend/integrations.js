/* MuBWeM integrations & API — informational stub.
 *
 * There is nothing to integrate with yet: alerting is one SNS topic with one
 * email subscription, fixed at deploy time, and there are no webhooks, no API
 * keys and no third-party targets. So this page documents the routes that do
 * exist rather than offering toggles that would connect to nothing.
 *
 * Everything shown comes from the deploy-generated config.js, which is already
 * served to every browser that loads the dashboard. Both routes listed here
 * need a Cognito id token in an Authorization: Bearer header, so there is no
 * copy-and-run example — the API URLs and the Cognito client id are not
 * secrets, but nothing is reachable without a token.
 */
(function () {
  "use strict";

  var el = {
    endpoints: document.getElementById("endpoint-list")
  };

  function row(label, value, note) {
    var dt = document.createElement("dt");
    dt.textContent = label;

    var dd = document.createElement("dd");
    var code = document.createElement("code");
    code.className = "config-value";
    code.textContent = value || "—";
    dd.appendChild(code);
    var hint = document.createElement("span");
    hint.className = "config-note";
    hint.textContent = note;
    dd.appendChild(hint);

    el.endpoints.appendChild(dt);
    el.endpoints.appendChild(dd);
  }

  function render() {
    var statusUrl = window.MUBWEM_API_URL || "";
    var adminUrl = window.MUBWEM_ADMIN_API_URL || "";

    el.endpoints.innerHTML = "";
    row(
      "Status",
      statusUrl,
      "Every monitor. Requires a Cognito id token."
    );
    row(
      "Status detail",
      statusUrl ? statusUrl + "/{siteId}" : "",
      "One monitor, with its 24h check series and incident history."
    );
    row(
      "Admin",
      adminUrl ? adminUrl + "/{sites|users}" : "",
      "Requires a token and the right Cognito group. Not a machine API."
    );
  }

  MubwemShell.boot({
    page: "integrations",
    ready: function () {
      render();
    }
  }).catch(function () {
    /* shell.js has already put the message on the page. */
  });
})();
