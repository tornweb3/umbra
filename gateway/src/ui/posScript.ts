// The till, served at /assets/pos.js.
//
// The only page in the gateway that genuinely needs client-side script: a
// cashier types an amount, and the screen has to follow a payment that is
// arriving. It still holds no merchant data in its markup, so the HTML is
// identical for every device and the token never leaves localStorage.
export const POS_JS = String.raw`(function () {
  "use strict";
  var TOKEN_KEY = "umbra_pos_token";
  var OPEN_KEY = "umbra_pos_charge";
  var token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { token = null; }

  var el = function (id) { return document.getElementById(id); };
  var screens = { enrol: el("needs-enrol"), keypad: el("keypad"), charge: el("charge") };
  var device = null;
  var amount = "";
  var current = null;
  var poll = null;
  var offline = false;

  function show(name) {
    for (var key in screens) if (screens[key]) screens[key].hidden = key !== name;
  }

  function setOffline(state) {
    offline = state;
    var banner = el("offline");
    if (banner) banner.hidden = !state;
  }

  function api(path, options) {
    options = options || {};
    options.headers = options.headers || {};
    options.headers["Authorization"] = "Bearer " + token;
    if (options.body) options.headers["Content-Type"] = "application/json";
    return fetch(path, options).then(function (res) {
      setOffline(false);
      if (res.status === 401) {
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        show("enrol");
        throw new Error("revoked");
      }
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : "that did not work");
        return body;
      });
    }).catch(function (e) {
      // A failed request here means the till cannot verify anything, and the
      // screen must say so rather than guess.
      if (e.message !== "revoked") setOffline(true);
      throw e;
    });
  }

  // ---- keypad -------------------------------------------------------------

  function renderAmount() {
    var display = el("amount");
    if (display) display.textContent = amount === "" ? "0" : amount;
    var button = el("charge-button");
    if (button) button.disabled = !(parseFloat(amount) > 0);
  }

  function press(key) {
    if (key === "clear") amount = "";
    else if (key === "back") amount = amount.slice(0, -1);
    else if (key === ".") { if (amount.indexOf(".") < 0) amount = (amount || "0") + "."; }
    else {
      var next = amount + key;
      // Two decimal places for fiat, twelve for XMR.
      var limit = device && device.currency === "XMR" ? 12 : 2;
      var dot = next.indexOf(".");
      if (dot >= 0 && next.length - dot - 1 > limit) return;
      if (next.replace(".", "").length > 12) return;
      amount = next;
    }
    renderAmount();
  }

  // ---- a charge -----------------------------------------------------------

  function statusText(charge) {
    if (charge.accepted_at) return "Accepted by you";
    if (charge.status === "confirmed") return "Paid and confirmed";
    if (charge.status === "detected") return charge.accept_zeroconf ? "Paid" : "Seen, waiting for confirmations";
    if (charge.status === "expired") return "Expired";
    return "Waiting for payment";
  }

  function settled(charge) {
    if (charge.accepted_at) return true;
    if (charge.status === "confirmed") return true;
    if (charge.status === "detected" && charge.accept_zeroconf) return true;
    return false;
  }

  function renderCharge(charge) {
    current = charge;
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(charge)); } catch (e) {}
    show("charge");
    el("charge-amount").textContent = charge.display_amount;
    el("charge-xmr").textContent = charge.amount_xmr + " XMR";
    var qr = el("charge-qr");
    if (charge.qr) { qr.src = charge.qr; qr.hidden = false; }
    el("charge-status").textContent = statusText(charge);
    el("charge-status").className = "status " + (settled(charge) ? "confirmed" : charge.status);
    el("charge-received").textContent =
      charge.amount_received_xmr && charge.amount_received_xmr !== "0"
        ? "Received " + charge.amount_received_xmr + " XMR"
        : "";
    el("customer-link").href = charge.customer_url;
    el("receipt-link").href = charge.receipt_url;

    var short = parseFloat(charge.amount_xmr) - parseFloat(charge.amount_received_xmr || "0");
    var isShort = parseFloat(charge.amount_received_xmr || "0") > 0 && short > 0 && !settled(charge);
    el("shortfall").hidden = !isShort;
    if (isShort) el("short-amount").textContent = short.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
    el("settled-actions").hidden = !settled(charge);
    el("open-actions").hidden = settled(charge);

    if (poll) clearTimeout(poll);
    if (!settled(charge) && charge.status !== "expired") poll = setTimeout(refresh, 2000);
  }

  function refresh() {
    if (!current) return;
    api("/pos/api/charges/" + current.id)
      .then(renderCharge)
      .catch(function () { poll = setTimeout(refresh, 5000); });
  }

  function charge() {
    var value = amount;
    if (!(parseFloat(value) > 0)) return;
    el("charge-button").disabled = true;
    api("/pos/api/charges", { method: "POST", body: JSON.stringify({ amount: value }) })
      .then(function (created) { amount = ""; renderAmount(); renderCharge(created); })
      .catch(function (e) { alert(e.message); })
      .then(function () { el("charge-button").disabled = false; });
  }

  function act(path, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    api("/pos/api/charges/" + current.id + path, { method: "POST" })
      .then(renderCharge)
      .catch(function (e) { alert(e.message); });
  }

  function newSale() {
    current = null;
    try { localStorage.removeItem(OPEN_KEY); } catch (e) {}
    if (poll) clearTimeout(poll);
    amount = "";
    renderAmount();
    show("keypad");
  }

  // ---- wiring -------------------------------------------------------------

  function start() {
    if (!token) { show("enrol"); return; }
    api("/pos/api/device")
      .then(function (d) {
        device = d;
        el("device-label").textContent = d.label;
        el("currency").textContent = d.currency;
        el("zeroconf-note").textContent =
          Number(d.zeroconf_limit) > 0
            ? "Accepting unconfirmed payments up to " + d.zeroconf_limit + " " + d.zeroconf_currency
            : "Every payment waits for confirmations";
        var open = null;
        try { open = JSON.parse(localStorage.getItem(OPEN_KEY) || "null"); } catch (e) {}
        if (open && open.id) {
          // Resume rather than lose the sale: a reload or a dead battery
          // mid-payment is otherwise an unresolvable dispute.
          current = open;
          renderCharge(open);
          refresh();
        } else {
          renderAmount();
          show("keypad");
        }
      })
      .catch(function () { /* the offline banner is already up */ });
  }

  document.addEventListener("click", function (event) {
    var key = event.target.getAttribute && event.target.getAttribute("data-key");
    if (key) { press(key); return; }
    var action = event.target.getAttribute && event.target.getAttribute("data-action");
    if (!action) return;
    if (action === "charge") charge();
    else if (action === "new") newSale();
    else if (action === "cancel") act("/cancel", "Cancel this charge?");
    else if (action === "accept") act("/accept", "Mark this as paid even though less arrived?");
    else if (action === "remainder") act("/remainder");
  });

  window.addEventListener("online", function () { setOffline(false); if (current) refresh(); });
  window.addEventListener("offline", function () { setOffline(true); });

  start();
})();
`;

/** The enrolment page: the code arrives in the fragment, which never leaves the browser. */
export const POS_ENROL_JS = String.raw`(function () {
  "use strict";
  var out = document.getElementById("enrol-status");
  var code = (window.location.hash || "").replace(/^#/, "");
  if (!code) { out.textContent = "That link is incomplete. Scan the code again from the console."; return; }
  // Strip it from the URL bar so a shoulder-surfer or a screenshot does not
  // carry a usable credential.
  try { history.replaceState(null, "", window.location.pathname); } catch (e) {}
  out.textContent = "Enrolling...";
  fetch("/pos/api/enrol", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code }),
  })
    .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
    .then(function (r) {
      if (!r.ok) { out.textContent = r.body.error || "That code is not usable."; return; }
      try { localStorage.setItem("umbra_pos_token", r.body.token); } catch (e) {
        out.textContent = "This browser will not store the till's credential. Check its privacy settings.";
        return;
      }
      out.textContent = "Enrolled as " + r.body.device.label + ". Opening the till...";
      window.location.href = "/pos";
    })
    .catch(function () { out.textContent = "Could not reach the gateway. Check the connection and try again."; });
})();
`;
