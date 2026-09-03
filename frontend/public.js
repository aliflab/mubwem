/* MuBWeM public status page.
 *
 * Polls GET /public/status, which is unauthenticated and returns only the
 * sites flagged isPublic in the Sites table. No token, no login redirect,
 * nothing from auth.js — this page is meant to be handed out.
 */
(function () {
  "use strict";

  var API_URL = MubwemDashboard.resolveApiUrl(
    "MUBWEM_PUBLIC_API_URL",
    "mubwem.publicApiUrl"
  );

  MubwemDashboard.start({ apiUrl: API_URL });
})();
