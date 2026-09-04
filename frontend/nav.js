/* MuBWeM side navigation — shared by every authenticated page.
 *
 * Rendered into <nav id="sidenav"> after auth.js has resolved a session, so
 * the group-dependent items are decided with a token in hand.
 *
 * Usage:
 *   MubwemNav.render("dashboard");        // the current page's key
 *   MubwemNav.setIncidentCount(2);        // badge on Incidents; 0 hides it
 *
 * ICONS
 *
 * Hand-written inline SVG, drawn on a 24x24 grid with a 2px stroke in
 * currentColor. No icon font and no Iconify runtime: the design reference
 * used Iconify's CDN, which is exactly the kind of dependency this project
 * does not take. Inline paths cost one extra function here and nothing at
 * runtime.
 *
 * ON THE VISIBILITY RULE
 *
 * "Monitors" and "Team Members" are hidden from anyone who is not an Admin or
 * an Editor. That is presentation only, exactly as in sites.js: the token
 * lives in the browser and is under the user's control. Every /admin/* route
 * re-derives the caller's groups server-side in lambda/admin/handler.py and
 * refuses what they are not entitled to, and team.js bounces a Viewer who
 * navigates there directly. Hiding the link only avoids offering someone a
 * page that is going to turn them away.
 */
window.MubwemNav = (function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";

  /* Path data only — every icon shares the same frame and stroke treatment. */
  var ICONS = {
    logo: ["M3 12h4l3 8 4-16 3 8h4"],
    dashboard: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M14 14h7v7h-7z", "M3 14h7v7H3z"],
    incidents: [
      "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
      "M12 9v4",
      "M12 17h.01"
    ],
    sites: ["M22 12h-4l-3 9L9 3l-3 9H2"],
    team: [
      "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2",
      "M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
      "M23 21v-2a4 4 0 0 0-3-3.87",
      "M16 3.13a4 4 0 0 1 0 7.75"
    ],
    settings: [
      "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
      "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
    ],
    integrations: [
      "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
      "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
    ],
    search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.35-4.35"],
    plus: ["M12 5v14", "M5 12h14"],
    download: [
      "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
      "M7 10l5 5 5-5",
      "M12 15V3"
    ],
    mail: [
      "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
      "M22 6l-10 7L2 6"
    ],
    slack: [
      "M9 3a2 2 0 0 0 0 4h2V5a2 2 0 0 0-2-2z",
      "M15 21a2 2 0 0 0 0-4h-2v2a2 2 0 0 0 2 2z",
      "M21 9a2 2 0 0 0-4 0v2h2a2 2 0 0 0 2-2z",
      "M3 15a2 2 0 0 0 4 0v-2H5a2 2 0 0 0-2 2z"
    ],
    bulb: [
      "M9 18h6",
      "M10 22h4",
      "M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"
    ],
    edit: [
      "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
      "M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"
    ]
  };

  /* Builds one icon. Kept public so the toolbar, buttons and stub pages can
     use the same set without a second copy of the path data. */
  function icon(name, size) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    if (size) {
      svg.setAttribute("width", size);
      svg.setAttribute("height", size);
    }
    (ICONS[name] || []).forEach(function (d) {
      var path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    });
    return svg;
  }

  /* Primary navigation, then a visually separated utility group at the foot.
     `groups`, when present, is the set of Cognito groups that see the item. */
  var PRIMARY = [
    { key: "dashboard", label: "Dashboard", href: "index.html" },
    { key: "incidents", label: "Incidents", href: "incidents.html", badge: true },
    { key: "sites", label: "Monitors", href: "sites.html", groups: ["Admins", "Editors"] },
    { key: "team", label: "Team Members", href: "team.html", groups: ["Admins", "Editors"] }
  ];

  var UTILITY = [
    { key: "settings", label: "Settings", href: "settings.html" },
    { key: "integrations", label: "Integrations & API", href: "integrations.html" }
  ];

  var badgeNode = null;
  var pendingCount = 0;

  function visible(item) {
    if (!item.groups) return true;
    // MubwemAuth may not be loaded on a page that does not sign in; a gated
    // item is simply not shown there.
    if (!window.MubwemAuth || !MubwemAuth.inAnyGroup) return false;
    return MubwemAuth.inAnyGroup(item.groups);
  }

  function navItem(item, currentKey) {
    var link = document.createElement("a");
    link.className = "nav-item" + (item.key === currentKey ? " nav-item-current" : "");
    link.href = item.href;
    if (item.key === currentKey) link.setAttribute("aria-current", "page");

    var glyph = document.createElement("span");
    glyph.className = "nav-icon";
    glyph.appendChild(icon(item.key));
    link.appendChild(glyph);

    var label = document.createElement("span");
    label.className = "nav-label";
    label.textContent = item.label;
    link.appendChild(label);

    if (item.badge) {
      badgeNode = document.createElement("span");
      badgeNode.className = "nav-badge";
      badgeNode.hidden = true;
      link.appendChild(badgeNode);
    }

    return link;
  }

  /* Count of incidents that have not resolved. Hidden at zero rather than
     shown as "0" - a badge reading zero is noise. */
  function setIncidentCount(count) {
    pendingCount = Number(count) > 0 ? Number(count) : 0;
    if (!badgeNode) return;
    badgeNode.hidden = pendingCount === 0;
    badgeNode.textContent = String(pendingCount);
    badgeNode.setAttribute(
      "aria-label",
      pendingCount + (pendingCount === 1 ? " ongoing incident" : " ongoing incidents")
    );
  }

  function render(currentKey) {
    var host = document.getElementById("sidenav");
    if (!host) return;

    host.innerHTML = "";
    badgeNode = null;

    // ------------------------------------------------------------ logo block
    var brand = document.createElement("a");
    brand.className = "nav-brand";
    brand.href = "index.html";

    var mark = document.createElement("span");
    mark.className = "brand-mark";
    mark.appendChild(icon("logo"));
    brand.appendChild(mark);

    var words = document.createElement("span");
    var name = document.createElement("span");
    name.className = "nav-brand-text";
    name.textContent = "MuBWeM";
    var sub = document.createElement("span");
    sub.className = "nav-brand-sub";
    sub.textContent = "Multi-Brand Monitor";
    words.appendChild(name);
    words.appendChild(sub);
    brand.appendChild(words);
    host.appendChild(brand);

    // -------------------------------------------------------- primary items
    var list = document.createElement("ul");
    list.className = "nav-list";
    PRIMARY.filter(visible).forEach(function (item) {
      var li = document.createElement("li");
      li.appendChild(navItem(item, currentKey));
      list.appendChild(li);
    });
    host.appendChild(list);

    // ------------------------------------------------------- utility group
    var utility = document.createElement("div");
    utility.className = "nav-utility";
    UTILITY.filter(visible).forEach(function (item) {
      utility.appendChild(navItem(item, currentKey));
    });

    var foot = document.createElement("div");
    foot.className = "nav-foot";
    var publicLink = document.createElement("a");
    publicLink.href = "public.html";
    publicLink.textContent = "Public status page";
    foot.appendChild(publicLink);
    utility.appendChild(foot);

    host.appendChild(utility);

    // A count set before the nav existed still lands.
    setIncidentCount(pendingCount);
  }

  return { render: render, setIncidentCount: setIncidentCount, icon: icon };
})();
