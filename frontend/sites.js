/* MuBWeM monitor management — the site half of what used to be admin.html.
 *
 * Split out from user management so each gets its own nav entry and its own
 * page. The permission model is unchanged from the old admin.js: Admins and Editors
 * reach this page, only Admins see delete controls.
 *
 * Creating a monitor moved to add-monitor.html. The inline form that used to
 * sit under this table was replaced rather than kept alongside it: two ways to
 * create the same thing means two sets of validation to keep in step, and the
 * full page has room to explain the fields.
 *
 * ON THE ROLE CHECKS IN THIS FILE
 *
 * Reading `cognito:groups` to decide what to draw — not rendering delete
 * buttons for non-Admins, letting shell.js bounce a Viewer — is presentation.
 * It is not access control and must never be mistaken for it. The token lives
 * in the browser, so a determined user can edit any of it.
 *
 * The real enforcement is in lambda/admin/handler.py, which re-derives the
 * same claim from the JWT that API Gateway validated and refuses anything the
 * caller's groups do not allow. If this file drew every control for everyone,
 * the backend would still say no. The point of the checks here is only to
 * avoid offering someone a button that is going to fail.
 */
(function () {
  "use strict";

  var ADMIN_BASE = window.MUBWEM_ADMIN_API_URL || "";

  var el = {
    overall: document.getElementById("overall"),
    panel: document.getElementById("sites-panel"),
    rows: document.getElementById("sites-rows"),
    loading: document.getElementById("sites-loading")
  };

  // Display-only, per the note at the top of this file.
  var isAdmin = false;

  function text(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = value;
    return node;
  }

  function api(method, path, body) {
    return MubwemShell.apiFetch(ADMIN_BASE + path, {
      method: method,
      body: body
    });
  }

  function toggle(checked, onChange) {
    var wrap = text("label", "toggle", null);
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(checked);
    input.addEventListener("change", function () {
      input.disabled = true;
      onChange(input.checked).then(
        function () {
          input.disabled = false;
        },
        function (err) {
          // The write failed, so put the switch back where it was rather than
          // leaving the page claiming a state the table does not have.
          input.checked = !input.checked;
          input.disabled = false;
          MubwemShell.showError(err.message);
        }
      );
    });
    wrap.appendChild(input);
    wrap.appendChild(text("span", "toggle-track", null));
    return wrap;
  }

  function patchSite(siteId, fields) {
    MubwemShell.clearError();
    return api("PATCH", "/sites/" + encodeURIComponent(siteId), fields);
  }

  function renderRow(site) {
    var row = document.createElement("tr");

    var nameCell = text("td", null, null);
    var link = document.createElement("a");
    link.href = "monitor.html?site=" + encodeURIComponent(site.siteId);
    link.textContent = site.name || site.siteId;
    nameCell.appendChild(link);
    row.appendChild(nameCell);

    var urlCell = text("td", "cell-url", null);
    var urlLink = document.createElement("a");
    urlLink.href = site.url || "#";
    urlLink.textContent = site.url || "";
    urlLink.target = "_blank";
    urlLink.rel = "noopener noreferrer";
    urlLink.className = "card-url";
    urlCell.appendChild(urlLink);
    row.appendChild(urlCell);

    row.appendChild(text("td", null, site.brand || "Unassigned"));
    row.appendChild(text("td", null, (site.checkIntervalSec || 60) + "s"));

    var enabledCell = text("td", null, null);
    enabledCell.appendChild(
      toggle(site.enabled, function (value) {
        return patchSite(site.siteId, { enabled: value }).then(function () {
          MubwemShell.showNotice(
            site.name + " is now " + (value ? "enabled" : "paused") + "."
          );
        });
      })
    );
    row.appendChild(enabledCell);

    var actions = text("td", "cell-actions", null);
    // Admins only — matching what the backend will actually allow. An Editor
    // who needs a site to stop being checked turns Enabled off instead.
    if (isAdmin) {
      var remove = text("button", "danger", "Delete");
      remove.type = "button";
      remove.addEventListener("click", function () {
        remove.disabled = true;
        MubwemShell.clearError();
        api("DELETE", "/sites/" + encodeURIComponent(site.siteId))
          .then(function () {
            MubwemShell.showNotice("Deleted " + (site.name || site.siteId) + ".");
            load();
          })
          .catch(function (err) {
            remove.disabled = false;
            MubwemShell.showError(err.message);
          });
      });
      actions.appendChild(remove);
    }
    row.appendChild(actions);

    return row;
  }

  function load() {
    el.loading.hidden = false;
    el.loading.textContent = "Loading sites…";
    return api("GET", "/sites")
      .then(function (payload) {
        var sites = payload.sites || [];
        el.rows.innerHTML = "";
        sites.forEach(function (site) {
          el.rows.appendChild(renderRow(site));
        });
        el.loading.hidden = sites.length > 0;
        el.loading.textContent = "No sites yet — add one below.";
      })
      .catch(function (err) {
        el.loading.hidden = true;
        MubwemShell.showError("Could not load sites: " + err.message);
      });
  }

  MubwemShell.boot({
    page: "sites",
    requireGroups: ["Admins", "Editors"],
    ready: function () {
      isAdmin = MubwemAuth.inAnyGroup(["Admins"]);

      if (!ADMIN_BASE) {
        el.overall.textContent = "Not configured";
        el.overall.className = "overall overall-down";
        MubwemShell.showError(
          "No admin API URL configured. Deploy the stack — config.js is " +
            "generated with it."
        );
        return;
      }

      el.overall.textContent = isAdmin ? "Signed in as Admin" : "Signed in as Editor";
      el.overall.className = "overall overall-up";

      el.panel.hidden = false;
      // The add form lives on add-monitor.html now; this page links to it.
      load();
    }
  }).catch(function () {
    /* shell.js has already put the message on the page. */
  });
})();
