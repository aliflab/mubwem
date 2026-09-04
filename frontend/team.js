/* MuBWeM team members — the user half of what used to be admin.html.
 *
 * The permission model is unchanged from the old admin.js: user management is Admins
 * only. An Editor can reach this page (the nav links it, since the nav item is
 * shared with monitor management) but sees an explanatory note instead of the
 * table — no request is made on their behalf, and /admin/users would refuse
 * them if one were.
 *
 * ON THE ROLE CHECKS IN THIS FILE
 *
 * Reading `cognito:groups` to decide what to render is presentation, not
 * access control. The token lives in the browser and is under the user's
 * control. Every /admin/users call is authorized server-side in
 * lambda/admin/handler.py against the JWT's own groups claim; if this file
 * rendered the whole table for a Viewer, the fetch behind it would still come
 * back 403.
 */
(function () {
  "use strict";

  var ADMIN_BASE = window.MUBWEM_ADMIN_API_URL || "";

  var el = {
    overall: document.getElementById("overall"),
    editorNote: document.getElementById("editor-note"),
    panel: document.getElementById("users-panel"),
    rows: document.getElementById("users-rows"),
    loading: document.getElementById("users-loading"),
    form: document.getElementById("user-form")
  };

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

  function renderRow(user) {
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
      MubwemShell.clearError();
      api("PATCH", "/users/" + encodeURIComponent(user.username), {
        role: select.value
      })
        .then(function () {
          user.role = select.value;
          MubwemShell.showNotice(user.email + " is now a " + select.value + ".");
        })
        .catch(function (err) {
          // Covers the backend's last-admin guard, among other refusals: put
          // the dropdown back rather than leaving it showing a role that was
          // never applied.
          select.value = previous;
          MubwemShell.showError(err.message);
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
      MubwemShell.clearError();
      api("DELETE", "/users/" + encodeURIComponent(user.username))
        .then(function () {
          MubwemShell.showNotice("Removed " + user.email + ".");
          load();
        })
        .catch(function (err) {
          remove.disabled = false;
          MubwemShell.showError(err.message);
        });
    });
    actions.appendChild(remove);
    row.appendChild(actions);

    return row;
  }

  function load() {
    el.loading.hidden = false;
    el.loading.textContent = "Loading users…";
    return api("GET", "/users")
      .then(function (payload) {
        var users = payload.users || [];
        el.rows.innerHTML = "";
        users.forEach(function (user) {
          el.rows.appendChild(renderRow(user));
        });
        el.loading.hidden = users.length > 0;
      })
      .catch(function (err) {
        el.loading.hidden = true;
        MubwemShell.showError("Could not load users: " + err.message);
      });
  }

  function submit(event) {
    event.preventDefault();
    MubwemShell.clearError();

    var form = el.form;
    var button = form.querySelector("button[type=submit]");
    var body = {
      email: form.elements.email.value.trim(),
      role: form.elements.role.value
    };

    button.disabled = true;
    api("POST", "/users", body)
      .then(function (payload) {
        form.reset();
        MubwemShell.showNotice(
          "Created " +
            payload.user.email +
            " as " +
            payload.user.role +
            ". Cognito has emailed them a temporary password."
        );
        return load();
      })
      .catch(function (err) {
        MubwemShell.showError(err.message);
      })
      .then(function () {
        button.disabled = false;
      });
  }

  MubwemShell.boot({
    page: "team",
    // Editors get in far enough to be told why there is nothing here; a Viewer
    // is redirected to the dashboard, same as everywhere else.
    requireGroups: ["Admins", "Editors"],
    ready: function () {
      var isAdmin = MubwemAuth.inAnyGroup(["Admins"]);

      if (!isAdmin) {
        el.editorNote.hidden = false;
        el.overall.textContent = "Signed in as Editor";
        el.overall.className = "overall overall-unknown";
        return;
      }

      if (!ADMIN_BASE) {
        el.overall.textContent = "Not configured";
        el.overall.className = "overall overall-down";
        MubwemShell.showError(
          "No admin API URL configured. Deploy the stack — config.js is " +
            "generated with it."
        );
        return;
      }

      el.overall.textContent = "Signed in as Admin";
      el.overall.className = "overall overall-up";

      el.panel.hidden = false;
      el.form.addEventListener("submit", submit);
      load();
    }
  }).catch(function () {
    /* shell.js has already put the message on the page. */
  });
})();
