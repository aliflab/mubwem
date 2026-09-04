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

  // inlineDetails: the public page has no detail page to link a card to, so
  // the stats and incident list stay on the card itself. The dashboard sets
  // detailHref instead and moves that detail to monitor.html.
  MubwemDashboard.start({ apiUrl: API_URL, inlineDetails: true });
})();
