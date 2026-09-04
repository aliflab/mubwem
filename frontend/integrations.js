/* MuBWeM integrations & API — informational stub.
 *
 * There is nothing to integrate with yet: alerting is one SNS topic with one
 * email subscription, fixed at deploy time, and there are no webhooks, no API
 * keys and no third-party targets. So this page documents the routes that do
 * exist rather than offering toggles that would connect to nothing.
 *
 * Everything shown comes from the deploy-generated config.js, which is already
 * served to every browser that loads the dashboard. The API URLs and the
 * Cognito client id are public by design for a public OAuth client — see the
 * README's "What this still does not do".
 */
(function () {
  "use strict";

  var el = {
    endpoints: document.getElementById("endpoint-list"),
    curl: document.getElementById("curl-example"),
    copy: document.getElementById("copy-curl")
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
    var privateUrl = window.MUBWEM_API_URL || "";
    var publicUrl = window.MUBWEM_PUBLIC_API_URL || "";
    var adminUrl = window.MUBWEM_ADMIN_API_URL || "";

    el.endpoints.innerHTML = "";
    row(
      "Authenticated status",
      privateUrl,
      "Every monitor. Requires a Cognito id token."
    );
    row(
      "Authenticated detail",
      privateUrl ? privateUrl + "/{siteId}" : "",
      "One monitor, with its 24h check series and incident history."
    );
    row(
      "Public status",
      publicUrl,
      "Only monitors flagged public. No credentials."
    );
    row(
      "Public detail",
      publicUrl ? publicUrl + "/{siteId}" : "",
      "One public monitor. Returns 404 for anything not flagged public."
    );
    row(
      "Admin",
      adminUrl ? adminUrl + "/{sites|users}" : "",
      "Requires a token and the right Cognito group. Not a machine API."
    );

    el.curl.textContent = publicUrl
      ? "curl -s " + publicUrl + " | jq ."
      : "No public API URL configured — deploy the stack.";
  }

  MubwemShell.boot({
    page: "integrations",
    ready: function () {
      render();
      el.copy.addEventListener("click", function () {
        var textToCopy = el.curl.textContent;
        // navigator.clipboard is unavailable on insecure origins; fall back to
        // selecting the block so the user can copy it themselves rather than
        // failing silently.
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(textToCopy).then(
            function () {
              MubwemShell.showNotice("Copied.");
            },
            function () {
              MubwemShell.showNotice("Could not copy — select the text instead.");
            }
          );
          return;
        }
        var range = document.createRange();
        range.selectNodeContents(el.curl);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        MubwemShell.showNotice("Selected — press Ctrl/Cmd+C to copy.");
      });
    }
  }).catch(function () {
    /* shell.js has already put the message on the page. */
  });
})();
