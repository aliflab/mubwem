/* MuBWeM dashboard — the authenticated view.
 *
 * Signs in against the Cognito hosted UI (auth.js), then polls GET /status
 * with the id token as a bearer token. Rendering lives in dashboard.js, shared
 * with the public status page.
 */
(function () {
  "use strict";

  var API_URL = MubwemDashboard.resolveApiUrl("MUBWEM_API_URL", "mubwem.apiUrl");

  var logoutLink = document.getElementById("logout");
  var signedInAs = document.getElementById("signed-in-as");
  var adminLink = document.getElementById("admin-link");

  function showSignedIn() {
    var email = MubwemAuth.claims().email;
    if (signedInAs && email) signedInAs.textContent = email;
    if (logoutLink) logoutLink.hidden = false;
    // Offer the admin panel only to roles that can use it. This is a UI
    // convenience, not a check - admin.js bounces a Viewer who navigates
    // there anyway, and every /admin route enforces the group server-side.
    if (adminLink && MubwemAuth.inAnyGroup(["Admins", "Editors"])) {
      adminLink.hidden = false;
    }
  }

  if (logoutLink) {
    logoutLink.addEventListener("click", function (event) {
      event.preventDefault();
      MubwemAuth.logout();
    });
  }

  MubwemDashboard.setOverall("Signing in…", "unknown");

  MubwemAuth.init()
    .then(function () {
      showSignedIn();
      MubwemDashboard.start({
        apiUrl: API_URL,
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
    })
    .catch(function (err) {
      MubwemDashboard.setOverall("Not signed in", "down");
      MubwemDashboard.showError(err.message);
    });
})();
