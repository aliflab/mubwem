/* MuBWeM — Create New Monitor, as a full page.
 *
 * Submits to the existing POST /admin/sites. No new endpoint, no backend
 * change: this is the same request sites.html's inline form used to make, on
 * a page with room to explain each field.
 *
 * The design reference put an "Advanced Options" box here offering keyword
 * monitoring, SSL certificate validation and custom HTTP headers. None of
 * those exist in the checker — it issues a plain HTTPS GET and grades the
 * status code — so that box is not built. Not disabled, not collapsed: absent.
 * A form field that quietly does nothing is worse than no field.
 *
 * ON THE ROLE CHECK
 *
 * requireGroups keeps a Viewer off this page, which is routing, not access
 * control. lambda/admin/handler.py re-derives the caller's groups from the JWT
 * and refuses a POST from anyone outside Admins/Editors regardless of what
 * this page rendered.
 */
(function () {
  "use strict";

  var ADMIN_BASE = window.MUBWEM_ADMIN_API_URL || "";
  var MIN_INTERVAL_SEC = 60;

  var el = {
    overall: document.getElementById("overall"),
    panel: document.getElementById("form-panel"),
    form: document.getElementById("add-form"),
    checks: document.getElementById("m-checks"),
    submit: document.getElementById("m-submit")
  };

  /* The same track-and-thumb switch the Monitors table and the edit form use,
     so the control means one thing everywhere. */
  function toggleField(label, hint, name, checked) {
    var wrap = document.createElement("label");
    wrap.className = "switch-field";

    var toggle = document.createElement("span");
    toggle.className = "toggle";
    var input = document.createElement("input");
    input.type = "checkbox";
    input.name = name;
    input.checked = Boolean(checked);
    toggle.appendChild(input);
    var track = document.createElement("span");
    track.className = "toggle-track";
    toggle.appendChild(track);
    wrap.appendChild(toggle);

    var textWrap = document.createElement("span");
    textWrap.className = "switch-text";
    var title = document.createElement("span");
    title.className = "switch-title";
    title.textContent = label;
    var sub = document.createElement("span");
    sub.className = "switch-hint";
    sub.textContent = hint;
    textWrap.appendChild(title);
    textWrap.appendChild(sub);
    wrap.appendChild(textWrap);

    el.checks.appendChild(wrap);
  }

  function submit(event) {
    event.preventDefault();
    MubwemShell.clearError();

    var form = el.form;
    var body = {
      name: form.elements.name.value.trim(),
      url: form.elements.url.value.trim(),
      checkIntervalSec: Number(form.elements.checkIntervalSec.value) || MIN_INTERVAL_SEC,
      enabled: form.elements.enabled.checked,
      isPublic: form.elements.isPublic.checked
    };
    var brand = form.elements.brand.value.trim();
    if (brand) body.brand = brand;

    if (!body.name) {
      MubwemShell.showError("A name is required.");
      return;
    }
    if (body.url.indexOf("https://") !== 0) {
      MubwemShell.showError("URL must start with https://");
      return;
    }
    // Mirrors the server's floor. The input's min="60" blocks the spinner, but
    // a typed value still reaches here, and a message beats a 400 round trip.
    if (body.checkIntervalSec < MIN_INTERVAL_SEC) {
      MubwemShell.showError(
        "Check interval must be at least 60 seconds — the scheduler cannot " +
          "check more often than once a minute."
      );
      return;
    }

    el.submit.disabled = true;
    MubwemShell.apiFetch(ADMIN_BASE + "/sites", { method: "POST", body: body })
      .then(function (payload) {
        // Straight to the new monitor's own page: the next thing anyone wants
        // after creating one is to look at it.
        var id = payload && payload.site && payload.site.siteId;
        if (id) {
          window.location.href = "monitor.html?site=" + encodeURIComponent(id);
          return;
        }
        window.location.href = "sites.html";
      })
      .catch(function (err) {
        el.submit.disabled = false;
        MubwemShell.showError(err.message);
      });
  }

  MubwemShell.boot({
    page: "sites",
    requireGroups: ["Admins", "Editors"],
    ready: function () {
      if (!ADMIN_BASE) {
        el.overall.textContent = "Not configured";
        el.overall.className = "overall overall-down";
        MubwemShell.showError(
          "No admin API URL configured. Deploy the stack — config.js is " +
            "generated with it."
        );
        return;
      }

      el.overall.textContent = MubwemAuth.inAnyGroup(["Admins"])
        ? "Signed in as Admin"
        : "Signed in as Editor";
      el.overall.className = "overall overall-up";

      // Both default to off. Turning a monitor on, and putting it on the
      // public page, are separate deliberate acts.
      toggleField(
        "Enabled",
        "Start checking this monitor every minute right away.",
        "enabled",
        false
      );
      toggleField(
        "Public status page",
        "Show it on public.html, which needs no sign-in.",
        "isPublic",
        false
      );

      el.panel.hidden = false;
      el.form.addEventListener("submit", submit);
    }
  }).catch(function () {
    /* shell.js has already put the message on the page. */
  });
})();
