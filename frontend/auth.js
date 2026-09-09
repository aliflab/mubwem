/* MuBWeM Cognito auth — authorization code grant with PKCE, no build step.
 *
 * The app client is public (no secret: a static page cannot keep one), so PKCE
 * is what stops an intercepted authorization code from being redeemed by
 * anyone else.
 *
 * The id token lives in sessionStorage only — never localStorage. This page
 * will eventually show real internal hostnames, and a localStorage token
 * survives every tab and outlives the browsing session, which turns any XSS
 * into a durable credential leak. sessionStorage dies with the tab; the cost
 * is re-authenticating when the tab is reopened, which the Cognito hosted-UI
 * session cookie usually makes invisible.
 *
 * No refresh token is stored at all. When the id token expires (1 hour), the
 * page bounces through the hosted UI again.
 */
window.MubwemAuth = (function () {
  "use strict";

  var TOKEN_KEY = "mubwem.idToken";
  var VERIFIER_KEY = "mubwem.pkceVerifier";
  var STATE_KEY = "mubwem.oauthState";

  // Treat a token expiring within this window as already expired, so a poll
  // cannot start with a valid token and arrive with a stale one.
  var EXPIRY_SKEW_MS = 60000;

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
    drop(TOKEN_KEY);
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
        scope: "openid email",
        redirect_uri: cfg.redirectUri,
        state: state,
        code_challenge: challenge,
        code_challenge_method: "S256"
      });
      window.location.assign(cfg.domain + "/oauth2/authorize?" + params);
    });
  }

  function logout() {
    var cfg = config();
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
        if (!tokens.id_token) throw new Error("no id token in the response");
        // Deliberately dropping refresh_token and access_token on the floor.
        store(TOKEN_KEY, tokens.id_token);
        drop(VERIFIER_KEY);
        drop(STATE_KEY);
        return tokens.id_token;
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
        clearSession();
        stripQuery();
        return Promise.reject(
          new Error("Sign-in state did not match — start again")
        );
      }
      return exchangeCode(code).then(function (token) {
        stripQuery();
        return token;
      });
    }

    var existing = getIdToken();
    if (existing) return Promise.resolve(existing);

    // No session: hand off to the hosted UI. This promise never settles,
    // because the page is navigating away.
    return login().then(function () {
      return new Promise(function () {});
    });
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
    getIdToken: getIdToken,
    claims: claims,
    groups: groups,
    inAnyGroup: inAnyGroup,
    clearSession: clearSession,
    isConfigured: isConfigured
  };
})();
