/* MuBWeM account — the signed-in user's own profile, email and password.
 *
 * Nothing here goes through the MuBWeM API. Every call is one of Cognito's
 * user-facing actions (GetUser, UpdateUserAttributes, ChangePassword, ...),
 * made from the browser by MubwemAuth.userApi() with the user's access token.
 * That token only ever reaches the account it was issued to, so there is no
 * route to authorize and no admin permission involved: an Admin editing
 * someone else does that on the Team Members page, through /admin/users.
 *
 * EMAIL CHANGES
 *
 * The user pool keeps the original address until the new one is verified
 * (keepOriginal in mubwem_stack.py). Requesting a change only sends a code to
 * the new address; the user keeps signing in with the old one until the code
 * is entered here. A typo therefore costs nothing - without keepOriginal it
 * would replace the sign-in address with one nobody can receive mail at.
 *
 * The id token's email and name claims are fixed when it is issued, so after
 * a change the page trades the refresh token for a new one. Other pages pick
 * the new claims up from that same stored token.
 */
(function () {
  "use strict";

  /* Cognito exception names worth a sentence of our own. Anything else falls
     back to Cognito's message, which is usually readable enough. */
  var MESSAGES = {
    InvalidPasswordException:
      "That password does not meet the policy: at least 8 characters, with an uppercase letter, a lowercase letter and a digit.",
    AliasExistsException: "That email address already belongs to another user.",
    CodeMismatchException: "That code is not right. Check the latest email and try again.",
    ExpiredCodeException: "That code has expired. Send a new one.",
    LimitExceededException: "Too many attempts. Wait a few minutes and try again.",
    TooManyRequestsException: "Too many attempts. Wait a few minutes and try again.",
    CodeDeliveryFailureException: "Cognito could not send the code to that address."
  };

  function describe(err, context) {
    if (err && err.code === "NotAuthorizedException" && context === "password") {
      return "Your current password is not right.";
    }
    return (err && MESSAGES[err.code]) || (err && err.message) || "Something went wrong.";
  }

  /* Disables the button while the promise runs, and reports a failure in the
     page's error strip. Resolves to the promise's value, or undefined when it
     failed - callers act only on success. */
  function busy(button, promise, context) {
    MubwemShell.clearError();
    button.disabled = true;
    return promise.then(
      function (value) {
        button.disabled = false;
        return value;
      },
      function (err) {
        button.disabled = false;
        MubwemShell.showError(describe(err, context));
        return undefined;
      }
    );
  }

  /* Same three-part layout as the Settings page, so the two read alike. */
  function controlRow(name, note, control) {
    var row = document.createElement("div");
    row.className = "setting-row setting-row-control";

    var left = document.createElement("div");
    left.appendChild(MubwemShell.text("div", "setting-name", name));
    left.appendChild(MubwemShell.text("p", "setting-note", note));
    row.appendChild(left);

    var field = document.createElement("div");
    field.className = "field";
    field.appendChild(control);
    row.appendChild(field);

    return row;
  }

  var fieldCount = 0;

  function input(label, type, autocomplete) {
    var wrap = document.createElement("div");
    wrap.className = "field";
    var id = "account-field-" + ++fieldCount;
    var labelNode = MubwemShell.text("label", null, label);
    labelNode.htmlFor = id;
    var node = document.createElement("input");
    node.id = id;
    node.type = type;
    if (autocomplete) node.autocomplete = autocomplete;
    wrap.appendChild(labelNode);
    wrap.appendChild(node);
    return { wrap: wrap, input: node };
  }

  function button(label, primary) {
    var node = document.createElement("button");
    node.type = primary ? "submit" : "button";
    if (primary) node.className = "primary";
    node.textContent = label;
    return node;
  }

  function attribute(user, name) {
    var list = (user && user.UserAttributes) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].Name === name) return list[i].Value;
    }
    return "";
  }

  /* New claims into the id token, then into the session strip. A failed
     refresh is not worth an error: the change itself has been saved, and the
     next scheduled refresh will catch up. */
  function refreshClaims() {
    return MubwemAuth.refresh().then(
      function () {
        MubwemShell.setSignedInAs(MubwemAuth.claims());
      },
      function () {}
    );
  }

  // ------------------------------------------------------------ profile
  function renderProfile(user) {
    var host = document.getElementById("profile");
    var form = document.createElement("form");
    form.className = "account-form";

    var name = input("Display name", "text", "name");
    name.input.maxLength = 100;
    name.input.value = attribute(user, "name");
    form.appendChild(name.wrap);

    var save = button("Save name", true);
    var actions = document.createElement("div");
    actions.className = "account-actions";
    actions.appendChild(save);
    form.appendChild(actions);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var value = name.input.value.trim();
      // An empty field means "no name", which is a delete in Cognito - an
      // attribute cannot be set to the empty string.
      var call = value
        ? MubwemAuth.userApi("UpdateUserAttributes", {
            UserAttributes: [{ Name: "name", Value: value }]
          })
        : MubwemAuth.userApi("DeleteUserAttributes", { UserAttributeNames: ["name"] });

      busy(save, call.then(function () { return true; })).then(function (ok) {
        if (!ok) return;
        name.input.value = value;
        // Straight away from what was saved; refreshClaims() then confirms
        // it from a new id token, which every other page reads.
        MubwemShell.setSignedInAs({ name: value, email: MubwemAuth.claims().email });
        refreshClaims();
        MubwemShell.showNotice(value ? "Display name saved." : "Display name removed.");
      });
    });

    host.appendChild(
      controlRow(
        "Display name",
        "How you would like to be addressed. Optional; your email address is what you sign in with.",
        form
      )
    );
  }

  // -------------------------------------------------------------- email
  function renderEmail(user) {
    var host = document.getElementById("email");
    var currentEmail = attribute(user, "email");
    var pendingEmail = "";

    var control = document.createElement("div");
    control.className = "account-form";

    var current = MubwemShell.text("div", "account-current", currentEmail || "—");
    control.appendChild(current);

    // Step one: ask for the new address.
    var requestForm = document.createElement("form");
    requestForm.className = "account-form";
    var next = input("New email address", "email", "email");
    next.input.required = true;
    requestForm.appendChild(next.wrap);
    var send = button("Send verification code", true);
    var requestActions = document.createElement("div");
    requestActions.className = "account-actions";
    requestActions.appendChild(send);
    requestForm.appendChild(requestActions);
    control.appendChild(requestForm);

    // Step two: the code from the new address.
    var verifyForm = document.createElement("form");
    verifyForm.className = "account-form";
    verifyForm.hidden = true;
    var sentTo = MubwemShell.text("p", "setting-note", "");
    verifyForm.appendChild(sentTo);
    var code = input("Verification code", "text", "one-time-code");
    code.input.inputMode = "numeric";
    code.input.required = true;
    verifyForm.appendChild(code.wrap);
    var verify = button("Verify", true);
    var resend = button("Resend code", false);
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "link-button";
    cancel.textContent = "Cancel";
    var verifyActions = document.createElement("div");
    verifyActions.className = "account-actions";
    verifyActions.appendChild(verify);
    verifyActions.appendChild(resend);
    verifyActions.appendChild(cancel);
    verifyForm.appendChild(verifyActions);
    control.appendChild(verifyForm);

    function showStep(verifying) {
      requestForm.hidden = verifying;
      verifyForm.hidden = !verifying;
      if (verifying) {
        sentTo.textContent =
          "Enter the code sent to " + pendingEmail +
          ". You keep signing in as " + currentEmail + " until it is verified.";
        code.input.value = "";
        code.input.focus();
      }
    }

    function requestCode(trigger) {
      return busy(
        trigger,
        MubwemAuth.userApi("UpdateUserAttributes", {
          UserAttributes: [{ Name: "email", Value: pendingEmail }]
        }).then(function () { return true; })
      );
    }

    requestForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var value = next.input.value.trim();
      if (!value) return;
      if (value.toLowerCase() === String(currentEmail).toLowerCase()) {
        MubwemShell.showError("That is already your email address.");
        return;
      }
      pendingEmail = value;
      requestCode(send).then(function (ok) {
        if (ok) showStep(true);
      });
    });

    resend.addEventListener("click", function () {
      // Repeating the update is what re-sends: it targets the pending address,
      // where GetUserAttributeVerificationCode would aim at the current one.
      requestCode(resend).then(function (ok) {
        if (ok) MubwemShell.showNotice("A new code is on its way to " + pendingEmail + ".");
      });
    });

    cancel.addEventListener("click", function () {
      // Nothing to undo in Cognito: the pending address is never applied
      // without its code, and the code simply expires.
      pendingEmail = "";
      next.input.value = "";
      MubwemShell.clearError();
      showStep(false);
    });

    verifyForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var value = code.input.value.trim();
      if (!value) return;
      busy(
        verify,
        MubwemAuth.userApi("VerifyUserAttribute", {
          AttributeName: "email",
          Code: value
        }).then(function () { return true; })
      ).then(function (ok) {
        if (!ok) return;
        currentEmail = pendingEmail;
        current.textContent = currentEmail;
        pendingEmail = "";
        next.input.value = "";
        showStep(false);
        refreshClaims();
        MubwemShell.showNotice("Email changed. Sign in as " + currentEmail + " from now on.");
      });
    });

    host.appendChild(
      controlRow(
        "Sign-in email",
        "A code is sent to the new address to prove it is yours. Nothing changes until that code is entered.",
        control
      )
    );
  }

  // ----------------------------------------------------------- password
  /* Mirrors the user pool's password policy in mubwem_stack.py, so an obvious
     miss is caught before the round trip. Cognito still enforces it. */
  function policyProblem(password) {
    if (password.length < 8) return "The new password needs at least 8 characters.";
    if (!/[a-z]/.test(password)) return "The new password needs a lowercase letter.";
    if (!/[A-Z]/.test(password)) return "The new password needs an uppercase letter.";
    if (!/[0-9]/.test(password)) return "The new password needs a digit.";
    return null;
  }

  function renderPassword(claims) {
    var host = document.getElementById("password");
    var form = document.createElement("form");
    form.className = "account-form";

    // Lets a password manager file the new password under the right account.
    var username = document.createElement("input");
    username.type = "email";
    username.autocomplete = "username";
    username.value = claims.email || "";
    username.hidden = true;
    username.tabIndex = -1;
    form.appendChild(username);

    var currentPw = input("Current password", "password", "current-password");
    var newPw = input("New password", "password", "new-password");
    var confirmPw = input("Confirm new password", "password", "new-password");
    [currentPw, newPw, confirmPw].forEach(function (f) {
      f.input.required = true;
      form.appendChild(f.wrap);
    });

    var save = button("Change password", true);
    var actions = document.createElement("div");
    actions.className = "account-actions";
    actions.appendChild(save);
    form.appendChild(actions);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      MubwemShell.clearError();
      var proposed = newPw.input.value;
      var problem = policyProblem(proposed);
      if (!problem && proposed !== confirmPw.input.value) {
        problem = "The new passwords do not match.";
      }
      if (!problem && proposed === currentPw.input.value) {
        problem = "The new password is the same as the current one.";
      }
      if (problem) {
        MubwemShell.showError(problem);
        return;
      }

      busy(
        save,
        MubwemAuth.userApi("ChangePassword", {
          PreviousPassword: currentPw.input.value,
          ProposedPassword: proposed
        }).then(function () { return true; }),
        "password"
      ).then(function (ok) {
        if (!ok) return;
        currentPw.input.value = "";
        newPw.input.value = "";
        confirmPw.input.value = "";
        MubwemShell.showNotice("Password changed.");
      });
    });

    host.appendChild(
      controlRow(
        "Change password",
        "Your current password is needed to set a new one. Sessions already signed in elsewhere stay signed in; use Sign out all devices below to end them.",
        form
      )
    );
  }

  // ------------------------------------------------------------ sign-in
  /* WebAuthn's authenticatorAttachment: "platform" is built into the device
     (or synced by its password manager), "cross-platform" is something you
     carry - a security key, or a phone used by scanning a QR code. */
  var ATTACHMENT = {
    platform: "Built into a device",
    "cross-platform": "Security key or phone"
  };

  // How the browser reached the authenticator when it was registered.
  var TRANSPORT = {
    internal: "this device",
    hybrid: "phone via QR code",
    usb: "USB",
    nfc: "NFC",
    ble: "Bluetooth",
    "smart-card": "smart card"
  };

  /* One line per passkey: Cognito's friendly name (usually the password
     manager or browser that made it - "iCloud Keychain", "Windows Hello"),
     what kind of authenticator it is, and when it was added. */
  function passkeyItem(cred) {
    var item = document.createElement("li");
    item.className = "passkey-item";
    item.appendChild(
      MubwemShell.text("div", "passkey-name", cred.FriendlyCredentialName || "Unnamed passkey")
    );

    var kind = ATTACHMENT[cred.AuthenticatorAttachment] || "Passkey";
    var via = (cred.AuthenticatorTransports || [])
      .map(function (t) { return TRANSPORT[t] || t; })
      .join(", ");
    item.appendChild(
      MubwemShell.text("div", "passkey-meta", via ? kind + " · " + via : kind)
    );

    // CreatedAt arrives as epoch seconds.
    var added = Number(cred.CreatedAt) > 0
      ? "Added " + MubwemShell.formatDateTime(new Date(Number(cred.CreatedAt) * 1000))
      : "Added at an unknown time";
    item.appendChild(MubwemShell.text("div", "passkey-meta", added));
    return item;
  }

  /* Every page of this user's registered passkeys. Rarely more than one page,
     but a user with a phone, a laptop and a security key per office adds up. */
  function listPasskeys() {
    var all = [];
    function page(token) {
      var params = { MaxResults: 20 };
      if (token) params.NextToken = token;
      return MubwemAuth.userApi("ListWebAuthnCredentials", params).then(function (res) {
        all = all.concat(res.Credentials || []);
        return res.NextToken ? page(res.NextToken) : all;
      });
    }
    return page(null);
  }

  /* The registration itself happens on Cognito's managed login page, which
     returns here when done - and this list is read fresh on that return, so a
     new passkey shows up straight away. Cognito holds the public key and the
     details shown here; the device holds the rest. */
  function renderPasskey(host) {
    var control = document.createElement("div");
    control.className = "account-form";

    var list = document.createElement("ul");
    list.className = "passkey-list";
    list.hidden = true;
    control.appendChild(list);

    var status = MubwemShell.text("p", "setting-note", "Loading your passkeys…");
    control.appendChild(status);

    var add = button("Add a passkey", false);
    add.className = "primary";
    add.addEventListener("click", function () {
      add.disabled = true;
      MubwemAuth.addPasskey();
    });
    var actions = document.createElement("div");
    actions.className = "account-actions";
    actions.appendChild(add);
    control.appendChild(actions);

    listPasskeys().then(
      function (creds) {
        if (!creds.length) {
          status.textContent = "No passkeys yet. You sign in with your password.";
          return;
        }
        status.hidden = true;
        add.textContent = "Add another passkey";
        creds.forEach(function (cred) {
          list.appendChild(passkeyItem(cred));
        });
        list.hidden = false;
      },
      function (err) {
        // Not worth the page's error strip: adding a passkey still works.
        status.textContent = "Could not load your passkeys: " + describe(err);
      }
    );

    host.appendChild(
      controlRow(
        "Passkey",
        "Sign in with Face ID, Touch ID, Windows Hello or your phone instead " +
          "of typing a password. A passkey belongs to the device or password " +
          "manager that creates it, so add one on each device you use. Your " +
          "password keeps working as a fallback.",
        control
      )
    );
  }

  /* GlobalSignOut revokes every refresh token this account holds, this tab's
     included, so the page signs out straight after. An id token already
     issued to another browser stays valid until it expires - up to an hour -
     because the API's JWT authorizer checks the signature, not revocation.
     Two clicks rather than a confirm() dialog, which nothing else here uses. */
  function renderGlobalSignOut(host) {
    var out = button("Sign out all devices", false);
    out.className = "danger";
    var armed = null;

    function disarm() {
      if (armed) clearTimeout(armed);
      armed = null;
      out.textContent = "Sign out all devices";
    }

    out.addEventListener("click", function () {
      if (!armed) {
        out.textContent = "Click again to confirm";
        armed = setTimeout(disarm, 5000);
        return;
      }
      disarm();
      busy(
        out,
        MubwemAuth.userApi("GlobalSignOut", {}).then(function () { return true; })
      ).then(function (ok) {
        if (ok) MubwemAuth.logout();
      });
    });

    host.appendChild(
      controlRow(
        "Sign out all devices",
        "Ends every session for this account, including this one. Other " +
          "browsers stop renewing at once, though one may keep working for up " +
          "to an hour on the sign-in it already has.",
        out
      )
    );
  }

  function render(claims) {
    var signin = document.getElementById("signin");
    renderPasskey(signin);
    renderGlobalSignOut(signin);
    renderPassword(claims);

    // Profile and email are prefilled from Cognito rather than the id token,
    // which may predate a change made in another tab.
    MubwemAuth.userApi("GetUser", {})
      .then(function (user) {
        renderProfile(user);
        renderEmail(user);
      })
      .catch(function (err) {
        MubwemShell.showError("Could not load your account: " + describe(err));
      });
  }

  MubwemShell.boot({
    page: "account",
    ready: render
  }).catch(function () {
    /* shell.js has already put the message on the page. */
  });
})();
