/* MuBWeM Cognito auth — authorization code grant with PKCE, no build step.
 *
 * The app client is public (no secret: a static page cannot keep one), so PKCE
 * is what stops an intercepted authorization code from being redeemed by
 * anyone else.
 *
 * The id token and the refresh token live in sessionStorage only — never
 * localStorage. This page will eventually show real internal hostnames, and a
 * localStorage token survives every tab and outlives the browsing session,
 * which turns any XSS into a durable credential leak. sessionStorage dies with
 * the tab; the cost is signing in again when the tab is reopened.
 *
 * The id token lasts an hour. A few minutes before it expires the refresh
 * token (30 days) is traded for a new one in the background, so an open tab
 * stays signed in without ever visiting the hosted UI. The hosted UI's own
 * session cookie lasts only about an hour, so without this an idle dashboard
 * would land on the sign-in form. Logout revokes the refresh token.
 *
 * The access token is kept in memory only, never in storage. The Account page
 * needs it for Cognito's self-service calls (change password, change email);
 * nothing else does. A reloaded page has none, and getAccessToken() mints one
 * from the refresh token - which is already in sessionStorage and can do that
 * anyway, so holding the access token adds no exposure.
 */
window.MubwemAuth = (function () {
  "use strict";

  var TOKEN_KEY = "mubwem.idToken";
  var REFRESH_KEY = "mubwem.refreshToken";
  var VERIFIER_KEY = "mubwem.pkceVerifier";
  var STATE_KEY = "mubwem.oauthState";
  // Set while init() retries a sign-in whose state did not match.
  var RETRY_KEY = "mubwem.stateRetry";

  // Treat a token expiring within this window as already expired, so a poll
  // cannot start with a valid token and arrive with a stale one.
  var EXPIRY_SKEW_MS = 60000;

  // How long before expiry the background refresh fires. Comfortably more
  // than the skew above, so a poll never sees the token lapse first.
  var REFRESH_AHEAD_MS = 5 * 60000;

  var refreshTimer = null;
  // One refresh at a time: parallel callers share the request in flight.
  var refreshing = null;
  // In memory only - see the header.
  var accessToken = null;

  /* Which registered callback URL this page uses.

     Every authenticated page is its own callback, so signing in from
     /incidents returns there rather than dumping the user on the
     dashboard. The value has to match a callback URL in the app client
     character for character, which is why the candidates come from the
     deploy-generated config and this only ever *selects* one - it never
     invents a URL. Anything unrecognised falls back to the dashboard root,
     which is always registered.

     Note the query string is deliberately not part of it: Cognito appends its
     own ?code=, so a page carrying state in the query (/monitor?site=...)
     has to remember that itself. */
  function redirectUri() {
    var here = window.location.origin + (window.location.pathname || "");
    var known = window.MUBWEM_REDIRECT_URIS;
    if (Object.prototype.toString.call(known) === "[object Array]") {
      for (var i = 0; i < known.length; i++) {
        if (known[i] === here) return known[i];
      }
    }
    return window.MUBWEM_REDIRECT_URI || window.location.origin + "/";
  }

  function config() {
    return {
      domain: (window.MUBWEM_COGNITO_DOMAIN || "").replace(/\/+$/, ""),
      clientId: window.MUBWEM_COGNITO_CLIENT_ID || "",
      redirectUri: redirectUri()
    };
  }

  function isConfigured() {
    var cfg = config();
    return Boolean(cfg.domain && cfg.clientId);
  }

  // ------------------------------------------------------------ storage
  function store(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (e) {
      /* private browsing — the flow still works, it just will not survive a
         reload */
    }
  }

  function read(key) {
    try {
      return sessionStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function drop(key) {
    try {
      sessionStorage.removeItem(key);
    } catch (e) {
      /* nothing to do */
    }
  }

  function clearSession() {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    accessToken = null;
    drop(TOKEN_KEY);
    drop(REFRESH_KEY);
    drop(VERIFIER_KEY);
    drop(STATE_KEY);
  }

  // --------------------------------------------------------------- PKCE
  function base64Url(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function randomToken(byteLength) {
    var bytes = new Uint8Array(byteLength);
    window.crypto.getRandomValues(bytes);
    return base64Url(bytes);
  }

  function codeChallenge(verifier) {
    var data = new TextEncoder().encode(verifier);
    return window.crypto.subtle.digest("SHA-256", data).then(function (digest) {
      return base64Url(new Uint8Array(digest));
    });
  }

  // -------------------------------------------------------------- tokens
  function decodeExpiry(idToken) {
    try {
      var payload = idToken.split(".")[1];
      var json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
      var claims = JSON.parse(json);
      return typeof claims.exp === "number" ? claims.exp * 1000 : 0;
    } catch (e) {
      return 0;
    }
  }

  function getIdToken() {
    var token = read(TOKEN_KEY);
    if (!token) return null;
    if (decodeExpiry(token) - EXPIRY_SKEW_MS <= Date.now()) {
      drop(TOKEN_KEY);
      return null;
    }
    return token;
  }

  function claims() {
    var token = getIdToken();
    if (!token) return {};
    try {
      var payload = token.split(".")[1];
      return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    } catch (e) {
      return {};
    }
  }

  /* Keep the id token, and the refresh token when the response carries one,
     then schedule the next background refresh. The access token is held in
     memory, never stored. */
  function storeTokens(tokens) {
    if (!tokens.id_token) throw new Error("no id token in the response");
    store(TOKEN_KEY, tokens.id_token);
    if (tokens.refresh_token) store(REFRESH_KEY, tokens.refresh_token);
    if (tokens.access_token) accessToken = tokens.access_token;
    scheduleRefresh();
    return tokens.id_token;
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    var token = read(TOKEN_KEY);
    if (!token || !read(REFRESH_KEY)) return;
    var delay = decodeExpiry(token) - REFRESH_AHEAD_MS - Date.now();
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      // A failure here is not fatal: the next poll finds no token and
      // reauthenticate() takes it from there.
      refresh().catch(function () {});
    }, Math.max(delay, 0));
  }

  /* Trade the refresh token for a new id token. Rejects when there is no
     refresh token or Cognito refuses it (expired after 30 days, or revoked). */
  function refresh() {
    if (refreshing) return refreshing;
    var cfg = config();
    var refreshToken = read(REFRESH_KEY);
    if (!refreshToken || !isConfigured()) {
      return Promise.reject(new Error("no refresh token"));
    }

    var body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cfg.clientId,
      refresh_token: refreshToken
    });

    refreshing = fetch(cfg.domain + "/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString()
    })
      .then(function (res) {
        if (!res.ok) {
          // 400 invalid_grant: the refresh token is dead, so forget it. Any
          // other failure (network, 5xx) leaves it for the next attempt.
          if (res.status === 400) drop(REFRESH_KEY);
          throw new Error("token refresh returned HTTP " + res.status);
        }
        return res.json();
      })
      .then(storeTokens)
      .then(
        function (token) {
          refreshing = null;
          return token;
        },
        function (err) {
          refreshing = null;
          throw err;
        }
      );
    return refreshing;
  }

  /* The id token is gone or was rejected: refresh silently if possible,
     otherwise send the user through the hosted UI. */
  function reauthenticate() {
    return refresh().catch(function () {
      clearSession();
      return login().then(function () {
        return new Promise(function () {});
      });
    });
  }

  // Background tabs throttle timers, so a timer due while the tab was hidden
  // may not have fired yet. Catch up as soon as the tab is looked at.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden || !read(REFRESH_KEY)) return;
    var token = read(TOKEN_KEY);
    if (!token || decodeExpiry(token) - REFRESH_AHEAD_MS <= Date.now()) {
      refresh().catch(function () {});
    }
  });

  // ------------------------------------------------------------ redirects
  function login() {
    var cfg = config();
    if (!isConfigured()) {
      return Promise.reject(new Error("Cognito is not configured"));
    }

    var verifier = randomToken(32);
    var state = randomToken(16);
    store(VERIFIER_KEY, verifier);
    store(STATE_KEY, state);

    return codeChallenge(verifier).then(function (challenge) {
      var params = new URLSearchParams({
        client_id: cfg.clientId,
        response_type: "code",
        // aws.cognito.signin.user.admin is what lets the managed login's
        // /passkeys/add page act for this user. It only ever lands in the
        // access token, which exchangeCode() discards.
        scope: "openid email aws.cognito.signin.user.admin",
        redirect_uri: cfg.redirectUri,
        state: state,
        code_challenge: challenge,
        code_challenge_method: "S256"
      });
      window.location.assign(cfg.domain + "/oauth2/authorize?" + params);
    });
  }

  /* Hand off to the managed login's passkey registration page. It relies on
     the managed-login session cookie from the sign-in that got us here, and
     returns to this page when done - so the redirect URI is this page's
     registered callback, exactly as login() uses. Cognito appends no code on
     this return, so init() just finds the existing token. */
  function addPasskey() {
    var cfg = config();
    if (!isConfigured()) return;
    var params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri
    });
    window.location.assign(cfg.domain + "/passkeys/add?" + params);
  }

  // --------------------------------------------------------- self-service
  /* Resolves to a usable access token, minting one from the refresh token
     when memory has none (any reload) or it is about to expire. */
  function getAccessToken() {
    if (accessToken && decodeExpiry(accessToken) - EXPIRY_SKEW_MS > Date.now()) {
      return Promise.resolve(accessToken);
    }
    accessToken = null;
    return refresh().then(function () {
      if (!accessToken) throw new Error("no access token in the response");
      return accessToken;
    });
  }

  /* The user pool's region. config.js carries it; a config.js from before it
     did still names the region in the managed-login domain
     (<prefix>.auth.<region>.amazoncognito.com). */
  function region() {
    if (window.MUBWEM_COGNITO_REGION) return window.MUBWEM_COGNITO_REGION;
    var match = /\.auth\.([a-z0-9-]+)\.amazoncognito\.com/.exec(config().domain);
    return match ? match[1] : "";
  }

  /* One of Cognito's user-facing API actions - GetUser, ChangePassword,
     UpdateUserAttributes and the like - called directly from the browser.
     They need no AWS credentials: the access token is the authorization, and
     it only ever reaches the account it was issued to.

     Rejects with an Error whose `code` is Cognito's exception name
     ("NotAuthorizedException"), so callers can word their own messages. */
  function userApi(action, params) {
    var where = region();
    if (!where) return Promise.reject(new Error("Cognito region is not configured"));

    return getAccessToken().then(function (token) {
      var body = { AccessToken: token };
      for (var key in params || {}) {
        if (Object.prototype.hasOwnProperty.call(params, key)) body[key] = params[key];
      }
      return fetch("https://cognito-idp." + where + ".amazonaws.com/", {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": "AWSCognitoIdentityProviderService." + action
        },
        body: JSON.stringify(body)
      }).then(function (res) {
        return res.text().then(function (text) {
          var payload = {};
          try {
            payload = text ? JSON.parse(text) : {};
          } catch (e) {
            payload = {};
          }
          if (!res.ok) {
            // __type is "NotAuthorizedException", sometimes namespaced with
            // a "...#" prefix.
            var type = String(payload.__type || "").split("#").pop();
            var err = new Error(
              payload.message || payload.Message || type || "HTTP " + res.status
            );
            err.code = type;
            err.status = res.status;
            throw err;
          }
          return payload;
        });
      });
    });
  }

  function logout() {
    var cfg = config();
    var refreshToken = read(REFRESH_KEY);
    if (refreshToken && isConfigured()) {
      // Best effort. keepalive lets the request outlive the navigation below;
      // if it fails anyway the token still dies with the tab.
      try {
        fetch(cfg.domain + "/oauth2/revoke", {
          method: "POST",
          keepalive: true,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: refreshToken,
            client_id: cfg.clientId
          }).toString()
        }).catch(function () {});
      } catch (e) {
        /* nothing to do */
      }
    }
    clearSession();
    if (!isConfigured()) {
      window.location.reload();
      return;
    }
    var params = new URLSearchParams({
      client_id: cfg.clientId,
      // Always back to the dashboard root, never to whichever authenticated
      // page we happen to be on: landing somewhere that immediately redirects
      // to the hosted UI is not a logout.
      logout_uri:
        window.MUBWEM_REDIRECT_URI || window.location.origin + "/"
    });
    window.location.assign(cfg.domain + "/logout?" + params);
  }

  function stripQuery() {
    if (window.history && window.history.replaceState) {
      window.history.replaceState(
        {},
        document.title,
        window.location.pathname + window.location.hash
      );
    }
  }

  function exchangeCode(code) {
    var cfg = config();
    var verifier = read(VERIFIER_KEY);
    if (!verifier) {
      return Promise.reject(
        new Error("Login could not be completed — start again")
      );
    }

    var body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      code: code,
      redirect_uri: cfg.redirectUri,
      code_verifier: verifier
    });

    return fetch(cfg.domain + "/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString()
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error("token endpoint returned HTTP " + res.status);
        }
        return res.json();
      })
      .then(function (tokens) {
        // The API takes the id token and the refresh token renews it. The
        // access token stays in memory for the Account page's Cognito calls.
        var idToken = storeTokens(tokens);
        drop(VERIFIER_KEY);
        drop(STATE_KEY);
        return idToken;
      });
  }

  /* Resolves to an id token, or rejects with a message worth showing.
     Redirects to the hosted UI (and never resolves) when there is no session. */
  function init() {
    if (!isConfigured()) {
      return Promise.reject(
        new Error(
          "Cognito is not configured. Deploy the stack — config.js is " +
            "generated with the login details."
        )
      );
    }

    var params = new URLSearchParams(window.location.search);

    if (params.get("error")) {
      var description =
        params.get("error_description") || params.get("error");
      clearSession();
      stripQuery();
      return Promise.reject(new Error("Sign-in failed: " + description));
    }

    var code = params.get("code");
    if (code) {
      var expected = read(STATE_KEY);
      if (!expected || params.get("state") !== expected) {
        // A code this tab never asked for: the hosted UI was opened directly
        // (the CognitoLoginUrl output, a bookmark, a stale tab) or from another
        // tab. Never redeem it - that is the CSRF check - but the hosted UI's
        // session cookie is now set, so a fresh login() returns straight here
        // without asking for the password again. Once only: if storage is
        // broken the state can never match, and that must not loop.
        clearSession();
        stripQuery();
        if (!read(RETRY_KEY)) {
          store(RETRY_KEY, "1");
          if (read(RETRY_KEY)) {
            return login().then(function () {
              return new Promise(function () {});
            });
          }
        }
        drop(RETRY_KEY);
        return Promise.reject(
          new Error("Sign-in state did not match — start again")
        );
      }
      drop(RETRY_KEY);
      return exchangeCode(code).then(function (token) {
        stripQuery();
        return token;
      });
    }

    var existing = getIdToken();
    if (existing) {
      // A reloaded page lost its timer; set it up again.
      scheduleRefresh();
      return Promise.resolve(existing);
    }

    // No usable id token. Try the refresh token first, so a reload after the
    // hour is up stays silent; failing that, hand off to the hosted UI. That
    // promise never settles, because the page is navigating away.
    return reauthenticate();
  }

  /* The caller's Cognito groups, read from the id token.

     This is for deciding which controls to draw and nothing else. It is not a
     security boundary: the token is in the browser, so anything here is under
     the user's control. Every /admin/* route re-derives the same claim
     server-side in lambda/admin/handler.py and enforces it there. Hiding a
     button the backend would refuse anyway is a courtesy, not a check. */
  function groups() {
    var value = claims()["cognito:groups"];
    if (Object.prototype.toString.call(value) === "[object Array]") {
      return value.slice();
    }
    if (typeof value === "string" && value) {
      return value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map(function (g) {
          return g.trim();
        })
        .filter(Boolean);
    }
    return [];
  }

  function inAnyGroup(names) {
    var mine = groups();
    for (var i = 0; i < names.length; i++) {
      if (mine.indexOf(names[i]) !== -1) return true;
    }
    return false;
  }

  return {
    init: init,
    login: login,
    logout: logout,
    reauthenticate: reauthenticate,
    refresh: refresh,
    addPasskey: addPasskey,
    getIdToken: getIdToken,
    getAccessToken: getAccessToken,
    userApi: userApi,
    claims: claims,
    groups: groups,
    inAnyGroup: inAnyGroup,
    clearSession: clearSession,
    isConfigured: isConfigured
  };
})();
