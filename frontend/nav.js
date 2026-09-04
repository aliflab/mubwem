/* MuBWeM side navigation — shared by every authenticated page.
 *
 * Rendered into <nav id="sidenav"> after auth.js has resolved a session, so
 * the group-dependent items are decided with a token in hand.
 *
 * Usage:
 *   MubwemNav.render("dashboard");   // the current page's key
 *
 * ON THE VISIBILITY RULE
 *
 * "Team Members" is hidden from anyone who is not an Admin or an Editor, the
 * same rule the site-management link uses. That is presentation only, exactly
 * as in sites.js: the token lives in the browser and is under the user's
 * control. Every /admin/* route re-derives the caller's groups server-side in
 * lambda/admin/handler.py and refuses what they are not entitled to, and
 * team.js bounces a Viewer who navigates there directly. Hiding the link only
 * avoids offering someone a page that is going to turn them away.
 */
window.MubwemNav = (function () {
  "use strict";

  /* href is what the browser navigates to; groups, when present, is the set
     of Cognito groups that see the item at all. */
  var ITEMS = [
    { key: "dashboard", label: "Dashboard", href: "index.html" },
    { key: "incidents", label: "Incidents", href: "incidents.html" },
    {
      key: "sites",
      label: "Monitors",
      href: "sites.html",
      groups: ["Admins", "Editors"]
    },
    {
      key: "team",
      label: "Team Members",
      href: "team.html",
      groups: ["Admins", "Editors"]
    },
    { key: "settings", label: "Settings", href: "settings.html" },
    { key: "integrations", label: "Integrations & API", href: "integrations.html" }
  ];

  function icon(key) {
    // A small inline glyph per item — no icon font, no extra request.
    var glyphs = {
      dashboard: "▦",
      incidents: "⚠",
      sites: "◎",
      team: "◕",
      settings: "⚙",
      integrations: "⇄"
    };
    var span = document.createElement("span");
    span.className = "nav-icon";
    span.setAttribute("aria-hidden", "true");
    span.textContent = glyphs[key] || "•";
    return span;
  }

  function visible(item) {
    if (!item.groups) return true;
    // MubwemAuth may not be loaded on a page that does not sign in; in that
    // case a gated item is simply not shown.
    if (!window.MubwemAuth || !MubwemAuth.inAnyGroup) return false;
    return MubwemAuth.inAnyGroup(item.groups);
  }

  function render(currentKey) {
    var host = document.getElementById("sidenav");
    if (!host) return;

    host.innerHTML = "";

    var brand = document.createElement("a");
    brand.className = "nav-brand";
    brand.href = "index.html";
    var mark = document.createElement("span");
    mark.className = "brand-mark";
    mark.setAttribute("aria-hidden", "true");
    brand.appendChild(mark);
    var brandText = document.createElement("span");
    brandText.className = "nav-brand-text";
    brandText.textContent = "MuBWeM";
    brand.appendChild(brandText);
    host.appendChild(brand);

    var list = document.createElement("ul");
    list.className = "nav-list";

    ITEMS.filter(visible).forEach(function (item) {
      var li = document.createElement("li");
      var link = document.createElement("a");
      link.className = "nav-item" + (item.key === currentKey ? " nav-item-current" : "");
      link.href = item.href;
      if (item.key === currentKey) link.setAttribute("aria-current", "page");
      link.appendChild(icon(item.key));
      var label = document.createElement("span");
      label.textContent = item.label;
      link.appendChild(label);
      li.appendChild(link);
      list.appendChild(li);
    });

    host.appendChild(list);

    var foot = document.createElement("div");
    foot.className = "nav-foot";
    var publicLink = document.createElement("a");
    publicLink.href = "public.html";
    publicLink.textContent = "Public status page";
    foot.appendChild(publicLink);
    host.appendChild(foot);
  }

  return { render: render };
})();
