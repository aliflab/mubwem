/* MuBWeM admin panel — user and site management, plain JS, no build step.
 *
 * Signs in through auth.js exactly as the dashboard does, then talks to the
 * /admin/* routes with the id token as a bearer token.
 *
 * ON THE ROLE CHECKS IN THIS FILE
 *
 * Everything here that reads `cognito:groups` — hiding the user-management
 * section from Editors, not drawing delete buttons for non-Admins, bouncing a
 * Viewer back to the dashboard — is presentation. It is not access control
 * and must never be mistaken for it. The token lives in the browser, so a
 * determined user can edit any of it.
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
    error: document.getElementById("error"),
    notice: document.getElementById("notice"),
    overall: document.getElementById("overall"),
    signedInAs: document.getElementById("signed-in-as"),
    logout: document.getElementById("logout"),
    sitesPanel: document.getElementById("sites-panel"),
    sitesRows: document.getElementById("sites-rows"),
    sitesLoading: document.getElementById("sites-loading"),
    siteForm: document.getElementById("site-form"),
    usersPanel: document.getElementById("users-panel"),
    usersRows: document.getElementById("users-rows"),
    usersLoading: document.getElementById("users-loading"),
    userForm: document.getElementById("user-form")
  };

  // Display-only, per the note at the top of this file.
  var isAdmin = false;
  var noticeTimer = null;

  // ------------------------------------------------------------------ helpers
  function text(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = value;
    return node;
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
  }

  function clearError() {
    el.error.hidden = true;
  }

  function showNotice(message) {
    el.notice.textContent = message;
    el.notice.hidden = false;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () {
      el.notice.hidden = true;
    }, 6000);
  }

  /* One fetch wrapper for every admin call.
   *
   * A 403 here is the backend's group check refusing the request, which is
   * the authoritative answer — the frontend's own idea of the caller's role
   * is only ever a guess about what that answer will be. */
  function api(method, path, body) {
    var token = MubwemAuth.getIdToken();
    if (!token) {
      MubwemAuth.clearSession();
      MubwemAuth.login();
      return Promise.reject(new Error("signing in again"));
    }

    var options = {
      method: method,
      cache: "no-store",
      headers: { Authorization: "Bearer " + token }
    };
    if (body !== undefined) {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    return fetch(ADMIN_BASE + path, options).then(function (res) {
      if (res.status === 401) {
        MubwemAuth.clearSession();
        MubwemAuth.login();
        throw new Error("signing in again");
      }
      return res.json().then(
        function (payload) {
          if (!res.ok) {
            throw new Error(
              (payload && payload.error) || "HTTP " + res.status
            );
          }
          return payload;
        },
        function () {
          throw new Error("HTTP " + res.status);
        }
      );
    });
  }

  function toggle(checked, disabled, onChange) {
    var wrap = text("label", "toggle", null);
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(checked);
    input.disabled = Boolean(disabled);
    input.addEventListener("change", function () {
      input.disabled = true;
      onChange(input.checked).then(
        function () {
          input.disabled = Boolean(disabled);
        },
        function (err) {
          // The write failed, so put the switch back where it was rather than
          // leaving the page claiming a state the table does not have.
          input.checked = !input.checked;
          input.disabled = Boolean(disabled);
          showError(err.message);
        }
      );
    });
    wrap.appendChild(input);
    wrap.appendChild(text("span", "toggle-track", null));
    return wrap;
  }

  // -------------------------------------------------------------------- sites
  function patchSite(siteId, fields) {
    clearError();
    return api("PATCH", "/sites/" + encodeURIComponent(siteId), fields);
  }

  function renderSiteRow(site) {
    var row = document.createElement("tr");

    row.appendChild(text("td", null, site.name || site.siteId));

    var urlCell = text("td", "cell-url", null);
    var link = document.createElement("a");
    link.href = site.url || "#";
    link.textContent = site.url || "";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "card-url";
    urlCell.appendChild(link);
    row.appendChild(urlCell);

    row.appendChild(text("td", null, site.brand || "Unassigned"));
    row.appendChild(
      text("td", null, (site.checkIntervalSec || 60) + "s")
    );

    var enabledCell = text("td", null, null);
    enabledCell.appendChild(
      toggle(site.enabled, false, function (value) {
        return patchSite(site.siteId, { enabled: value }).then(function () {
          showNotice(
            site.name + " is now " + (value ? "enabled" : "disabled") + "."
          );
        });
      })
    );
    row.appendChild(enabledCell);

    var publicCell = text("td", null, null);
    publicCell.appendChild(
      toggle(site.isPublic, false, function (value) {
        return patchSite(site.siteId, { isPublic: value }).then(function () {
          showNotice(
            site.name +
              " is now " +
              (value ? "on the public status page" : "private") +
              "."
          );
        });
      })
    );
    row.appendChild(publicCell);

    var actions = text("td", "cell-actions", null);
    // Admins only — matching what the backend will actually allow. An Editor
    // who needs a site to stop being checked turns Enabled off instead.
    if (isAdmin) {
      var remove = text("button", "danger", "Delete");
      remove.type = "button";
      remove.addEventListener("click", function () {
        remove.disabled = true;
        clearError();
        api("DELETE", "/sites/" + encodeURIComponent(site.siteId))
          .then(function () {
            showNotice("Deleted " + (site.name || site.siteId) + ".");
            loadSites();
          })
          .catch(function (err) {
            remove.disabled = false;
            showError(err.message);
          });
      });
      actions.appendChild(remove);
    }
    row.appendChild(actions);

    return row;
  }

  function loadSites() {
    el.sitesLoading.hidden = false;
    el.sitesLoading.textContent = "Loading sites…";
    return api("GET", "/sites")
      .then(function (payload) {
        var sites = payload.sites || [];
        el.sitesRows.innerHTML = "";
        sites.forEach(function (site) {
          el.sitesRows.appendChild(renderSiteRow(site));
        });
        el.sitesLoading.hidden = sites.length > 0;
        el.sitesLoading.textContent = "No sites yet — add one below.";
      })
      .catch(function (err) {
        el.sitesLoading.hidden = true;
        showError("Could not load sites: " + err.message);
      });
  }

  function submitSite(event) {
    event.preventDefault();
    clearError();

    var form = el.siteForm;
    var button = form.querySelector("button[type=submit]");
    var body = {
      name: form.elements.name.value.trim(),
      url: form.elements.url.value.trim(),
      checkIntervalSec: Number(form.elements.checkIntervalSec.value) || 60
    };
    var brand = form.elements.brand.value.trim();
    if (brand) body.brand = brand;

    if (body.url.indexOf("https://") !== 0) {
      showError("URL must start with https://");
      return;
    }

    button.disabled = true;
    api("POST", "/sites", body)
      .then(function (payload) {
        form.reset();
        form.elements.checkIntervalSec.value = 60;
        showNotice(
          "Added " +
            payload.site.name +
            ". It starts disabled and private — flip the switches when ready."
        );
        return loadSites();
      })
      .catch(function (err) {
        showError(err.message);
      })
      .then(function () {
        button.disabled = false;
      });
  }

  // -------------------------------------------------------------------- users
  function renderUserRow(user) {
    var row = document.createElement("tr");

    row.appendChild(text("td", null, user.email));

    var roleCell = text("td", null, null);
    var select = document.createElement("select");
    select.className = "role-select";
    ["Admin", "Editor", "Viewer"].forEach(function (role) {
      var option = document.createElement("option");
      option.value = role;
      option.textContent = role;
      if (user.role === role) option.selected = true;
      select.appendChild(option);
    });
    if (!user.role) {
      // A user with no group at all — the bootstrap state, before anyone has
      // been assigned a role.
      var none = document.createElement("option");
      none.value = "";
      none.textContent = "— none —";
      none.selected = true;
      select.insertBefore(none, select.firstChild);
    }
    select.addEventListener("change", function () {
      if (!select.value) return;
      var previous = user.role || "";
      select.disabled = true;
      clearError();
      api("PATCH", "/users/" + encodeURIComponent(user.username), {
        role: select.value
      })
        .then(function () {
          user.role = select.value;
          showNotice(user.email + " is now a " + select.value + ".");
        })
        .catch(function (err) {
          select.value = previous;
          showError(err.message);
        })
        .then(function () {
          select.disabled = false;
        });
    });
    roleCell.appendChild(select);
    row.appendChild(roleCell);

    row.appendChild(
      text("td", null, user.enabled ? user.status || "—" : "DISABLED")
    );

    var actions = text("td", "cell-actions", null);
    var remove = text("button", "danger", "Remove");
    remove.type = "button";
    remove.addEventListener("click", function () {
      remove.disabled = true;
      clearError();
      api("DELETE", "/users/" + encodeURIComponent(user.username))
        .then(function () {
          showNotice("Removed " + user.email + ".");
          loadUsers();
        })
        .catch(function (err) {
          remove.disabled = false;
          showError(err.message);
        });
    });
    actions.appendChild(remove);
    row.appendChild(actions);

    return row;
  }

  function loadUsers() {
    el.usersLoading.hidden = false;
    el.usersLoading.textContent = "Loading users…";
    return api("GET", "/users")
      .then(function (payload) {
        var users = payload.users || [];
        el.usersRows.innerHTML = "";
        users.forEach(function (user) {
          el.usersRows.appendChild(renderUserRow(user));
        });
        el.usersLoading.hidden = users.length > 0;
      })
      .catch(function (err) {
        el.usersLoading.hidden = true;
        showError("Could not load users: " + err.message);
      });
  }

  function submitUser(event) {
    event.preventDefault();
    clearError();

    var form = el.userForm;
    var button = form.querySelector("button[type=submit]");
    var body = {
      email: form.elements.email.value.trim(),
      role: form.elements.role.value
    };

    button.disabled = true;
    api("POST", "/users", body)
      .then(function (payload) {
        form.reset();
        showNotice(
          "Created " +
            payload.user.email +
            " as " +
            payload.user.role +
            ". Cognito has emailed them a temporary password."
        );
        return loadUsers();
      })
      .catch(function (err) {
        showError(err.message);
      })
      .then(function () {
        button.disabled = false;
      });
  }

  // ------------------------------------------------------------------ startup
  if (el.logout) {
    el.logout.addEventListener("click", function (event) {
      event.preventDefault();
      MubwemAuth.logout();
    });
  }

  MubwemAuth.init()
    .then(function () {
      var email = MubwemAuth.claims().email;
      if (email) el.signedInAs.textContent = email;
      el.logout.hidden = false;

      isAdmin = MubwemAuth.inAnyGroup(["Admins"]);
      var canEditSites = isAdmin || MubwemAuth.inAnyGroup(["Editors"]);

      if (!canEditSites) {
        // A Viewer has nothing to do on this page. Sending them back is a
        // courtesy: the routes below would refuse them anyway.
        window.location.replace("index.html");
        return;
      }

      if (!ADMIN_BASE) {
        el.overall.textContent = "Not configured";
        el.overall.className = "overall overall-down";
        showError(
          "No admin API URL configured. Deploy the stack — config.js is " +
            "generated with it."
        );
        return;
      }

      el.overall.textContent = isAdmin ? "Signed in as Admin" : "Signed in as Editor";
      el.overall.className = "overall overall-up";

      el.sitesPanel.hidden = false;
      el.siteForm.addEventListener("submit", submitSite);
      loadSites();

      if (isAdmin) {
        // Not merely hidden for an Editor — never rendered, never fetched.
        el.usersPanel.hidden = false;
        el.userForm.addEventListener("submit", submitUser);
        loadUsers();
      }
    })
    .catch(function (err) {
      el.overall.textContent = "Not signed in";
      el.overall.className = "overall overall-down";
      showError(err.message);
    });
})();
