/* MuBWeM team members — the user half of what used to be admin.html.
 *
 * User management is Owners and Admins only. Owner accounts are the exception
 * within that: only an Owner can make someone an Owner, and an Owner's row can
 * be changed by that Owner alone, so for everyone else it is drawn read-only
 * with no actions. An Editor can reach this page (the nav links it, since the nav item is
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

  // Set in ready(). Decides whether Owner is offered as a role to assign.
  var isOwner = false;

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

  /* Whether a row is the signed-in user's own. The API's username is the
     Cognito username, which in this pool is the sub. */
  function isMe(user) {
    var claims = MubwemAuth.claims() || {};
    var mine = [claims.sub, claims["cognito:username"], claims.email]
      .filter(Boolean)
      .map(function (v) {
        return String(v).toLowerCase();
      });
    return mine.indexOf(String(user.username).toLowerCase()) !== -1;
  }

  function renderRow(user) {
    var row = document.createElement("tr");

    row.appendChild(text("td", null, user.email));

    // Someone else's Owner account: nobody but that Owner can change it, so
    // there is nothing to offer — a plain label, no actions.
    if (user.role === "Owner" && !isMe(user)) {
      row.appendChild(text("td", null, "Owner"));
      row.appendChild(
        text("td", null, user.enabled ? user.status || "—" : "DISABLED")
      );
      row.appendChild(
        text("td", "cell-actions cell-note", "Only this Owner can change it")
      );
      return row;
    }

    var roleCell = text("td", null, null);
    var select = document.createElement("select");
    select.className = "role-select";
    (isOwner
      ? ["Owner", "Admin", "Editor", "Viewer"]
      : ["Admin", "Editor", "Viewer"]
    ).forEach(function (role) {
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

    // Only for an invite that is still waiting to be used — once the user has
    // set their own password there is nothing to resend, and the API says so.
    if (user.enabled && user.status === "FORCE_CHANGE_PASSWORD") {
      var resend = text("button", "row-action", "Resend invite");
      resend.type = "button";
      resend.addEventListener("click", function () {
        resend.disabled = true;
        MubwemShell.clearError();
        api(
          "POST",
          "/users/" + encodeURIComponent(user.username) + "/resend"
        )
          .then(function () {
            MubwemShell.showNotice(
              "Sent " +
                user.email +
                " a new temporary password. The previous one no longer works."
            );
          })
          .catch(function (err) {
            MubwemShell.showError(err.message);
          })
          .then(function () {
            resend.disabled = false;
          });
      });
      actions.appendChild(resend);
    }

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
    requireGroups: ["Owners", "Admins", "Editors"],
    ready: function () {
      var isAdmin = MubwemAuth.inAnyGroup(["Owners", "Admins"]);

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

      isOwner = MubwemAuth.inAnyGroup(["Owners"]);
      el.overall.textContent = isOwner ? "Signed in as Owner" : "Signed in as Admin";
      el.overall.className = "overall overall-up";

      // The create form ships with an Owner option; only an Owner may use it.
      if (!isOwner) {
        var ownerOption = el.form.querySelector('option[value="Owner"]');
        if (ownerOption) ownerOption.parentNode.removeChild(ownerOption);
      }

      el.panel.hidden = false;
      el.form.addEventListener("submit", submit);
      load();
    }
  }).catch(function () {
    /* shell.js has already put the message on the page. */
  });
})();
