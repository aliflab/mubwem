/* MuBWeM settings — a mostly read-only view of deploy-time configuration.
 *
 * Almost nothing in this app can be configured at runtime: the check cadence,
 * the failure threshold, the retention window and the region are all CDK
 * context, baked in at deploy. So this page shows what those values are with
 * the inputs disabled, rather than presenting controls that would silently do
 * nothing.
 *
 * Everything shown comes from the deploy-generated config.js, which is already
 * public — it is served to any browser that loads the dashboard. No secret is
 * displayed and none is available to display.
 *
 * There are two exceptions. The display timezone is a genuine control because
 * it is genuinely local: it decides how this browser renders timestamps and
 * nothing more. Every check, incident and alert email is still recorded in
 * UTC, and the sort-key format on the wire is untouched. The deployment sets
 * the default via displayTimezone; this only overrides it for the viewer.
 *
 * The other is the alert-email mute on the Email channel row. That one is
 * deployment-wide and stored server-side (GET/PATCH /admin/settings), and
 * only Admins and Editors see the switch - see renderEmail().
 *
 * The design reference carried a "PRO MULTI-BRAND" plan block with an Upgrade
 * Plan button. There is no billing, no plan and no subscription anywhere in
 * this system, so that block is not built here at all — not hidden, not
 * disabled, absent.
 */
(function () {
  "use strict";

  function num(value, fallback) {
    var n = Number(value);
    return n > 0 ? n : fallback;
  }

  /* One read-only row: name + note on the left, a disabled input on the right
     showing the value the deployment is actually running with. */
  function settingRow(name, note, value, unit) {
    var row = document.createElement("div");
    row.className = "setting-row";

    var left = document.createElement("div");
    var title = document.createElement("div");
    title.className = "setting-name";
    title.textContent = name;
    var hint = document.createElement("p");
    hint.className = "setting-note";
    hint.textContent = note;
    left.appendChild(title);
    left.appendChild(hint);
    row.appendChild(left);

    var field = document.createElement("div");
    field.className = "field";
    var input = document.createElement("input");
    input.type = "text";
    input.disabled = true;
    input.readOnly = true;
    input.value = value === null || value === undefined ? "—" : String(value) + (unit || "");
    input.setAttribute("aria-label", name);
    field.appendChild(input);
    row.appendChild(field);

    return row;
  }

  /* One channel. state is "active", "muted", "off" (not configured) or null
     - unknown, so no badge at all rather than a guess. Returns handles so the
     Email row can be updated in place once its live state has loaded. */
  function channelRow(iconName, name, detail, state) {
    var row = document.createElement("div");
    row.className = "channel-row" + (state === "off" ? " channel-off" : "");

    var glyph = document.createElement("span");
    glyph.className = "channel-icon";
    if (window.MubwemNav && MubwemNav.icon) glyph.appendChild(MubwemNav.icon(iconName));
    row.appendChild(glyph);

    var text = document.createElement("div");
    text.className = "channel-text";
    var title = document.createElement("div");
    title.className = "channel-name";
    title.textContent = name;
    var sub = document.createElement("div");
    sub.className = "channel-detail";
    sub.textContent = detail;
    text.appendChild(title);
    text.appendChild(sub);
    row.appendChild(text);

    var control = document.createElement("div");
    control.className = "channel-control";
    row.appendChild(control);

    var badge = document.createElement("span");
    row.appendChild(badge);

    function setState(next) {
      badge.hidden = !next;
      if (!next) return;
      badge.className = "badge " + (next === "active" ? "badge-up" : "badge-paused");
      badge.textContent =
        next === "active" ? "ACTIVE" : next === "muted" ? "MUTED" : "NOT CONFIGURED";
    }
    setState(state);

    return { row: row, detail: sub, control: control, setState: setState };
  }

  var EMAIL_DETAIL =
    "One SES recipient, set at deploy time via alertEmail, with an SNS topic as the fallback.";

  /* The Email row, with the deployment-wide mute switch for Admins and
     Editors. The state lives in the Settings table, which the checker reads
     at the start of every sweep, so a change takes effect within a minute.
     Muting stops every alert email - SES and the SNS fallback alike - but
     incidents still open and close and still show on the dashboard.

     Viewers cannot read /admin/*, so for them the row makes no claim about
     whether email is on: no badge beats a badge that might be wrong. */
  function renderEmail(host) {
    var email = channelRow("mail", "Email", EMAIL_DETAIL, null);
    host.appendChild(email.row);

    var adminBase = window.MUBWEM_ADMIN_API_URL || "";
    if (!MubwemAuth.inAnyGroup(["Admins", "Editors"])) {
      email.detail.textContent =
        EMAIL_DETAIL + " Admins and Editors can mute alert email.";
      return;
    }
    if (!adminBase) {
      email.detail.textContent =
        EMAIL_DETAIL + " Muting needs the admin API URL from config.js, which is missing.";
      return;
    }

    function apply(settings) {
      var on = settings.emailAlertsEnabled !== false;
      email.setState(on ? "active" : "muted");
      var note = on
        ? EMAIL_DETAIL
        : "Muted - incidents still open and close, but no alert email is sent by SES or SNS.";
      if (settings.updatedAt) {
        note +=
          " Last changed " +
          (settings.updatedBy ? "by " + settings.updatedBy + ", " : "") +
          MubwemShell.relativeTime(settings.updatedAt) +
          ".";
      }
      email.detail.textContent = note;
    }

    MubwemShell.apiFetch(adminBase + "/settings")
      .then(function (settings) {
        apply(settings);
        email.control.appendChild(
          MubwemShell.toggle(
            settings.emailAlertsEnabled !== false,
            function (on) {
              MubwemShell.clearError();
              return MubwemShell.apiFetch(adminBase + "/settings", {
                method: "PATCH",
                body: { emailAlertsEnabled: on }
              }).then(apply);
            },
            "Email alerts"
          )
        );
      })
      .catch(function (err) {
        MubwemShell.showError(
          "Could not load notification settings: " + err.message
        );
      });
  }

  /* Like settingRow, but the right-hand side is a live control the caller
     built. Same three-part layout so an enabled row does not look bolted on
     next to the read-only ones. */
  function controlRow(name, note, control) {
    var row = document.createElement("div");
    row.className = "setting-row setting-row-control";

    var left = document.createElement("div");
    var title = document.createElement("div");
    title.className = "setting-name";
    title.textContent = name;
    var hint = document.createElement("p");
    hint.className = "setting-note";
    hint.textContent = note;
    left.appendChild(title);
    left.appendChild(hint);
    row.appendChild(left);

    var field = document.createElement("div");
    field.className = "field";
    field.appendChild(control);
    row.appendChild(field);

    return row;
  }

  function option(value, label) {
    var opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    return opt;
  }

  /* Fallback list for browsers without Intl.supportedValuesOf (pre-2022
     Safari, mainly). Deliberately short - it is a fallback, not a catalogue,
     and the deployment default is appended to it separately so the configured
     zone is always selectable whatever the browser knows. */
  var FALLBACK_ZONES = [
    "Africa/Johannesburg", "America/Chicago", "America/Denver",
    "America/Los_Angeles", "America/New_York", "America/Sao_Paulo",
    "Asia/Dubai", "Asia/Kolkata", "Asia/Shanghai", "Asia/Singapore",
    "Asia/Tokyo", "Australia/Brisbane", "Australia/Melbourne",
    "Australia/Perth", "Australia/Sydney", "Europe/Berlin", "Europe/London",
    "Europe/Madrid", "Europe/Paris", "Pacific/Auckland"
  ];

  function allZones() {
    var zones = [];
    try {
      if (typeof Intl.supportedValuesOf === "function") {
        zones = Intl.supportedValuesOf("timeZone").slice();
      }
    } catch (e) {
      zones = [];
    }
    if (!zones.length) zones = FALLBACK_ZONES.slice();

    // Whatever the deployment configured must always be pickable, even if this
    // browser's zone database has never heard of it.
    var configured = window.MUBWEM_DISPLAY_TIMEZONE;
    if (configured && configured !== "UTC" && zones.indexOf(configured) === -1) {
      zones.push(configured);
    }
    return zones.sort();
  }

  /* One optgroup per region - "Australia/Sydney" under "Australia". A flat
     list of 400-odd zones is unusable; the region prefix is already there. */
  function zoneSelect() {
    var select = document.createElement("select");
    select.id = "timezone";
    select.setAttribute("aria-label", "Display timezone");

    select.appendChild(
      option("auto", "Browser local — " + browserZone())
    );
    select.appendChild(option("UTC", "UTC"));

    var groups = {};
    allZones().forEach(function (zone) {
      if (zone === "UTC") return;
      var slash = zone.indexOf("/");
      var region = slash === -1 ? "Other" : zone.slice(0, slash);
      if (!groups[region]) {
        var group = document.createElement("optgroup");
        group.label = region.split("_").join(" ");
        groups[region] = group;
        select.appendChild(group);
      }
      groups[region].appendChild(option(zone, zone.split("_").join(" ")));
    });

    // The stored preference, or the deploy default when nothing is stored.
    // Falls back to "auto" if neither is an option this browser offers.
    var current = MubwemShell.timeZone();
    select.value = current;
    if (select.value !== current) select.value = "auto";

    return select;
  }

  function browserZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
    } catch (e) {
      return "unknown";
    }
  }

  function renderDisplay() {
    var host = document.getElementById("display");
    var select = zoneSelect();

    // A live example, so the effect of a change is visible here rather than
    // only after navigating to another page.
    var sample = document.createElement("p");
    sample.className = "setting-note setting-sample";

    var reset = document.createElement("button");
    reset.type = "button";
    reset.className = "link-button";
    reset.textContent = "Reset to deployment default";

    function refresh() {
      sample.textContent =
        "Times now display as " + MubwemShell.formatDateTime(new Date()) + ".";
      var stored = MubwemShell.timeZone();
      reset.hidden = !window.MUBWEM_DISPLAY_TIMEZONE ||
        stored === window.MUBWEM_DISPLAY_TIMEZONE;
    }

    select.addEventListener("change", function () {
      MubwemShell.setTimeZone(select.value);
      refresh();
    });

    reset.addEventListener("click", function () {
      MubwemShell.resetTimeZone();
      select.value = MubwemShell.timeZone();
      refresh();
    });

    var control = document.createElement("div");
    control.appendChild(select);
    control.appendChild(sample);
    control.appendChild(reset);

    host.appendChild(
      controlRow(
        "Display timezone",
        "Which zone timestamps are rendered in across the dashboard, the " +
          "monitor charts and the incidents CSV export. Saved in this browser " +
          "only — it does not follow you to another device, and it changes " +
          "nothing about what is recorded.",
        control
      )
    );

    refresh();
  }

  function render() {
    renderDisplay();

    var interval = num(window.MUBWEM_SCHEDULE_INTERVAL_SEC, 60);
    var threshold = num(window.MUBWEM_FAILURE_THRESHOLD, 3);
    var timeout = num(window.MUBWEM_CHECK_TIMEOUT_SEC, null);
    var ttl = num(window.MUBWEM_CHECKS_TTL_DAYS, null);
    var region = window.MUBWEM_CHECK_REGION || null;

    var intervals = document.getElementById("intervals");
    intervals.appendChild(
      settingRow(
        "Check interval",
        "How often the checker sweeps every enabled monitor. One minute is the floor EventBridge Scheduler supports, and it is enforced when a monitor is saved.",
        interval, " seconds"
      )
    );
    intervals.appendChild(
      settingRow(
        "Minimum per-monitor interval",
        "A monitor cannot be saved with anything shorter. Below this the countdown ring would run more than one cycle per real check.",
        60, " seconds"
      )
    );
    intervals.appendChild(
      settingRow(
        "Request timeout",
        "A monitor that has not responded within this is recorded as down.",
        timeout, timeout === null ? "" : " seconds"
      )
    );
    intervals.appendChild(
      settingRow(
        "Check region",
        "Every check runs from this one region, so it measures what users there experience.",
        region
      )
    );

    var thresholds = document.getElementById("thresholds");
    thresholds.appendChild(
      settingRow(
        "Failure threshold",
        "How many checks must fail in a row before an incident opens, the monitor shows as down and an alert is sent. A shorter run is an isolated failure: an amber hour on the status bars, and not counted against uptime.",
        threshold, " consecutive failures"
      )
    );
    thresholds.appendChild(
      settingRow(
        "Check retention",
        "Raw check rows expire on a DynamoDB TTL after this. The 24-hour uptime figure is computed from them on every read.",
        ttl, ttl === null ? "" : " days"
      )
    );

    var channels = document.getElementById("channels");
    renderEmail(channels);
    // Kept visible and explicitly unconfigured, exactly as the reference
    // shows its own Slack row. Naming something that does not exist is only
    // dishonest if it claims to work.
    channels.appendChild(
      channelRow("slack", "Slack", "No webhook support exists in this deployment.", "off").row
    );
  }

  MubwemShell.boot({
    page: "settings",
    ready: render
  }).catch(function () {
    /* shell.js has already put the message on the page. */
  });
})();
