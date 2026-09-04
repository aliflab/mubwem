/* MuBWeM dashboard — the authenticated monitor list.
 *
 * Signs in against the Cognito hosted UI (auth.js via shell.js), then polls
 * GET /status with the id token as a bearer token. Rendering lives in
 * dashboard.js, shared with the public status page.
 *
 * Cards link through to monitor.html rather than carrying their own stats and
 * incident list — that detail moved to the detail page.
 */
(function () {
  "use strict";

  var API_URL = MubwemDashboard.resolveApiUrl("MUBWEM_API_URL", "mubwem.apiUrl");

  MubwemDashboard.setOverall("Signing in…", "unknown");

  MubwemShell.boot({
    page: "dashboard",
    ready: function () {
      MubwemDashboard.start({
        apiUrl: API_URL,
        detailHref: function (siteId) {
          return "monitor.html?site=" + encodeURIComponent(siteId);
        },
        headers: function () {
          var token = MubwemAuth.getIdToken();
          // null tells the poller to stop and call onUnauthorized instead of
          // firing a request that is certain to be rejected.
          if (!token) return null;
          return { Authorization: "Bearer " + token };
        },
        onUnauthorized: function () {
          // Expired or revoked. The hosted UI session cookie normally makes
          // this round trip invisible.
          MubwemAuth.clearSession();
          MubwemAuth.login();
        }
      });
    }
  }).catch(function () {
    /* shell.js has already put the message on the page. */
  });
})();
