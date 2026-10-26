/* MuBWeM notification bell — shared by every authenticated page.
 *
 * A bell in the page header, its unread count, a dropdown of the last 90 days
 * of incident notifications, and a toast that pops up the moment a new
 * incident appears. Started by shell.js once a session exists:
 *
 *   MubwemNotifications.start();
 *
 * WHERE THE DATA COMES FROM
 *
 * GET /notifications (lambda/api/handler.py). The checker writes one row per
 * incident open and close; rows expire after the retention window, which the
 * response reports as `retentionDays`. Muting alert email does not mute these.
 *
 * "IMMEDIATELY"
 *
 * The checker sweeps once a minute and this polls every POLL_MS, so a new
 * incident reaches the page within about half a minute of being opened -
 * there is no push channel. A poll also runs whenever the tab becomes visible
 * again. With the browser's permission, a desktop notification is shown too
 * while the tab is in the background.
 *
 * READ STATE
 *
 * Per browser, in localStorage: the newest id the viewer has seen, and the
 * newest id already toasted. Ids sort by time, so "unread" is a string
 * comparison. Nothing about read state is stored server-side; a second device
 * starts with everything unread. Losing storage costs a badge, never data.
 */
window.MubwemNotifications = (function () {
  "use strict";

  var POLL_MS = 30000;
  var PAGE_SIZE = 50;
  // On a browser that has never toasted, only incidents this recent pop up.
  // Anything older is in the dropdown; replaying a week of toasts is noise.
  var FIRST_RUN_TOAST_WINDOW_MS = 15 * 60 * 1000;
  var RESOLVED_TOAST_MS = 8000;

  var SEEN_KEY = "mubwem.notifications.seenId";
  var TOASTED_KEY = "mubwem.notifications.toastedId";

  var state = {
    url: null,
    items: [],          // newest first, deduplicated by id
    nextBefore: null,
    retentionDays: 90,
    loadedOnce: false,
    open: false,
    timer: null
  };

  var nodes = {};

  // ---------------------------------------------------------------- storage
  function load(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch (e) {
      return "";
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* private browsing - read state lasts for this page only */
    }
  }

  // Fallbacks for when localStorage is unavailable, so a page still behaves.
  var memory = {};

  function seenId() {
    return load(SEEN_KEY) || memory[SEEN_KEY] || "";
  }

  function setMarker(key, value) {
    memory[key] = value;
    save(key, value);
  }

  // ---------------------------------------------------------------- helpers
  function el(tag, className, value) {
    return MubwemShell.text(tag, className, value);
  }

  function resolveUrl() {
    if (window.MUBWEM_NOTIFICATIONS_URL) return window.MUBWEM_NOTIFICATIONS_URL;
    // Local development: ?api=<.../status> is all a page is given, and the
    // notifications route sits beside it on the same API.
    var status = MubwemShell.resolveApiUrl("MUBWEM_API_URL", "mubwem.apiUrl");
    return status ? status.replace(/\/status\/?$/, "") + "/notifications" : null;
  }

  function isDown(item) {
    return item.kind === "incident_opened";
  }

  function title(item) {
    return isDown(item) ? item.siteName + " is down" : item.siteName + " recovered";
  }

  function detail(item) {
    if (isDown(item)) return item.reason || "Incident opened";
    var after = "After " + MubwemShell.durationLabel(item.durationSec);
    return item.reason ? after + " — " + item.reason : after;
  }

  function monitorHref(item) {
    return "/monitor?site=" + encodeURIComponent(item.siteId);
  }

  function unreadCount() {
    var seen = seenId();
    var count = 0;
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id > seen) count++;
    }
    return count;
  }

  /* Merge a page into state.items, newest first, without duplicates. Returns
     the items that were not there before. */
  function merge(incoming) {
    var known = Object.create(null);
    state.items.forEach(function (item) {
      known[item.id] = true;
    });
    var added = incoming.filter(function (item) {
      return item && item.id && !known[item.id];
    });
    state.items = state.items.concat(added).sort(function (a, b) {
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    return added;
  }

  // ------------------------------------------------------------------ bell
  function buildBell() {
    var meta = document.querySelector(".topbar .meta");
    if (!meta) return false;

    var wrap = el("div", "notif", null);

    var bell = document.createElement("button");
    bell.type = "button";
    bell.className = "notif-bell";
    bell.setAttribute("aria-haspopup", "true");
    bell.setAttribute("aria-expanded", "false");
    bell.setAttribute("aria-controls", "notif-panel");
    bell.appendChild(MubwemNav.icon("bell"));
    var badge = el("span", "notif-badge", null);
    badge.hidden = true;
    bell.appendChild(badge);
    wrap.appendChild(bell);

    var panel = el("div", "notif-panel", null);
    panel.id = "notif-panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Notifications");

    var head = el("div", "notif-head", null);
    head.appendChild(el("h2", null, "Notifications"));
    var markRead = document.createElement("button");
    markRead.type = "button";
    markRead.className = "link-button";
    markRead.textContent = "Mark all read";
    markRead.addEventListener("click", markAllRead);
    head.appendChild(markRead);
    panel.appendChild(head);

    var desktop = document.createElement("button");
    desktop.type = "button";
    desktop.className = "notif-desktop";
    desktop.textContent = "Enable desktop alerts";
    desktop.hidden = true;
    desktop.addEventListener("click", askDesktopPermission);
    panel.appendChild(desktop);

    var list = el("ul", "notif-list", null);
    panel.appendChild(list);

    var empty = el("p", "notif-empty", "Loading…");
    panel.appendChild(empty);

    var more = document.createElement("button");
    more.type = "button";
    more.className = "notif-more";
    more.textContent = "Load older";
    more.hidden = true;
    more.addEventListener("click", loadOlder);
    panel.appendChild(more);

    var foot = el("p", "notif-foot", null);
    panel.appendChild(foot);

    wrap.appendChild(panel);

    // Between the divider and the identity block, so the session strip keeps
    // its place at the far right.
    var session = meta.querySelector(".session");
    meta.insertBefore(wrap, session || null);

    bell.addEventListener("click", function () {
      setOpen(!state.open);
    });
    document.addEventListener("click", function (event) {
      if (state.open && !wrap.contains(event.target)) setOpen(false);
    });
    document.addEventListener("keydown", function (event) {
      if (state.open && event.key === "Escape") {
        setOpen(false);
        bell.focus();
      }
    });

    nodes = {
      wrap: wrap,
      bell: bell,
      badge: badge,
      panel: panel,
      list: list,
      empty: empty,
      more: more,
      foot: foot,
      desktop: desktop,
      markRead: markRead
    };
    return true;
  }

  function setOpen(open) {
    state.open = open;
    nodes.panel.hidden = !open;
    nodes.bell.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      renderList();
      // Opening the panel is reading it. The highlight on unread rows stays
      // for as long as it is open, because renderList ran first.
      markAllRead();
    }
  }

  function markAllRead() {
    if (state.items.length) setMarker(SEEN_KEY, state.items[0].id);
    renderBadge();
  }

  function renderBadge() {
    if (!nodes.badge) return;
    var count = unreadCount();
    nodes.badge.hidden = count === 0;
    nodes.badge.textContent = count > 99 ? "99+" : String(count);
    nodes.bell.setAttribute(
      "aria-label",
      count ? "Notifications, " + count + " unread" : "Notifications"
    );
    // Red while anything unread is an incident opening; neutral otherwise.
    var seen = seenId();
    var alarming = state.items.some(function (item) {
      return item.id > seen && isDown(item);
    });
    nodes.badge.className = "notif-badge" + (alarming ? " notif-badge-down" : "");
    nodes.markRead.disabled = count === 0;
  }

  function renderList() {
    var list = nodes.list;
    var seen = seenId();
    list.innerHTML = "";

    state.items.forEach(function (item) {
      var li = el("li", "notif-item" + (item.id > seen ? " notif-unread" : ""), null);
      var link = document.createElement("a");
      link.href = monitorHref(item);
      link.className = "notif-link";

      link.appendChild(
        el("span", "notif-dot " + (isDown(item) ? "notif-dot-down" : "notif-dot-up"), null)
      );
      var body = el("span", "notif-body", null);
      body.appendChild(el("span", "notif-title", title(item)));
      body.appendChild(el("span", "notif-detail", detail(item)));
      var when = el("time", "notif-time", MubwemShell.relativeTime(item.createdAt));
      when.dateTime = item.createdAt || "";
      when.title = MubwemShell.formatDateTime(item.createdAt);
      body.appendChild(when);
      link.appendChild(body);

      li.appendChild(link);
      list.appendChild(li);
    });

    nodes.empty.hidden = state.items.length > 0;
    nodes.empty.textContent = state.loadedOnce
      ? "No incidents in the last " + state.retentionDays + " days."
      : "Loading…";
    nodes.more.hidden = !state.nextBefore;
    nodes.foot.textContent =
      "Notifications are kept for " + state.retentionDays + " days.";
    nodes.desktop.hidden = !("Notification" in window) || Notification.permission !== "default";
  }

  // ---------------------------------------------------------------- toasts
  function toastHost() {
    if (nodes.toasts) return nodes.toasts;
    var host = el("div", "notif-toasts", null);
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
    nodes.toasts = host;
    return host;
  }

  function toast(item) {
    var card = el("div", "notif-toast " + (isDown(item) ? "notif-toast-down" : "notif-toast-up"), null);
    if (isDown(item)) card.setAttribute("role", "alert");

    var link = document.createElement("a");
    link.href = monitorHref(item);
    link.className = "notif-toast-link";
    link.appendChild(el("strong", null, title(item)));
    link.appendChild(el("span", null, detail(item)));
    card.appendChild(link);

    var close = document.createElement("button");
    close.type = "button";
    close.className = "notif-toast-close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    close.addEventListener("click", function () {
      card.remove();
    });
    card.appendChild(close);

    toastHost().appendChild(card);

    // An outage stays on screen until someone dismisses it; a recovery is
    // good news and gets out of the way by itself.
    if (!isDown(item)) {
      setTimeout(function () {
        card.remove();
      }, RESOLVED_TOAST_MS);
    }
  }

  function desktopNotify(item) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (!document.hidden) return; // the toast already has the viewer's attention
    try {
      var n = new Notification(title(item), { body: detail(item), tag: item.id });
      n.onclick = function () {
        window.focus();
        window.location.href = monitorHref(item);
        n.close();
      };
    } catch (e) {
      /* some browsers only allow this from a service worker - toast suffices */
    }
  }

  function askDesktopPermission() {
    if (!("Notification" in window)) return;
    var asked = Notification.requestPermission(function () {
      renderList();
    });
    if (asked && asked.then) asked.then(renderList);
  }

  /* Pop up whatever is newer than the last thing this browser toasted. */
  function announce(fresh) {
    var marker = load(TOASTED_KEY) || memory[TOASTED_KEY] || "";
    var cutoff = "";
    if (!marker) {
      cutoff = new Date(Date.now() - FIRST_RUN_TOAST_WINDOW_MS).toISOString();
      // Same window for the badge: a first visit should not open on "50
      // unread". Older history is still in the dropdown, just not flagged.
      if (!seenId()) {
        for (var i = 0; i < state.items.length; i++) {
          if (state.items[i].createdAt < cutoff) {
            setMarker(SEEN_KEY, state.items[i].id);
            break;
          }
        }
      }
    }

    fresh
      .filter(function (item) {
        return marker ? item.id > marker : item.createdAt >= cutoff;
      })
      .reverse() // oldest first, so the newest ends up on top of the stack
      .forEach(function (item) {
        toast(item);
        desktopNotify(item);
      });

    if (state.items.length && state.items[0].id > marker) {
      setMarker(TOASTED_KEY, state.items[0].id);
    }
  }

  // --------------------------------------------------------------- polling
  function poll() {
    if (!state.url) return Promise.resolve();
    return MubwemShell.apiFetch(state.url + "?limit=" + PAGE_SIZE)
      .then(function (payload) {
        if (payload.retentionDays) state.retentionDays = payload.retentionDays;
        var added = merge(payload.notifications || []);
        if (!state.loadedOnce) state.nextBefore = payload.nextBefore || null;
        state.loadedOnce = true;
        announce(added);
        renderBadge();
        if (state.open) renderList();
      })
      .catch(function () {
        /* The bell is secondary on every page. A failed poll must not put an
           error banner over the page's own content; the next one retries. */
      });
  }

  function loadOlder() {
    if (!state.nextBefore) return;
    nodes.more.disabled = true;
    var url =
      state.url + "?limit=" + PAGE_SIZE + "&before=" + encodeURIComponent(state.nextBefore);
    MubwemShell.apiFetch(url)
      .then(function (payload) {
        merge(payload.notifications || []);
        state.nextBefore = payload.nextBefore || null;
        renderList();
      })
      .catch(function () {
        /* leave the button for another try */
      })
      .then(function () {
        nodes.more.disabled = false;
      });
  }

  function start() {
    if (state.timer) return;
    state.url = resolveUrl();
    if (!state.url || !buildBell()) return;
    renderBadge();

    poll();
    state.timer = setInterval(function () {
      if (!document.hidden || ("Notification" in window && Notification.permission === "granted")) {
        poll();
      }
    }, POLL_MS);

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) poll();
    });

    // Read in another tab: clear the badge here too.
    window.addEventListener("storage", function (event) {
      if (!event || event.key === null || event.key === SEEN_KEY) renderBadge();
    });
  }

  return { start: start };
})();
