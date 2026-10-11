// Browser scripts, served from /assets so no page needs an inline <script>.
//
// Inline scripts are how an XSS gets in: JSON.stringify does not escape
// "</script>", so one merchant-controlled string interpolated into a script
// block ends the block and runs whatever follows. Everything these need
// arrives through data- attributes, which the escaper does cover.

export const CHECKOUT_JS = `(function () {
  var root = document.getElementById('invoice');
  if (!root) return;
  var id = root.getAttribute('data-invoice-id');
  var expiresAt = new Date(root.getAttribute('data-expires-at'));
  var statusEl = document.getElementById('status');
  var countdownEl = document.getElementById('countdown');
  var status = root.getAttribute('data-status');

  function settled(s) { return s === 'confirmed' || s === 'expired'; }

  function tick() {
    if (!countdownEl) return;
    if (settled(status)) { countdownEl.textContent = ''; return; }
    var ms = expiresAt.getTime() - Date.now();
    countdownEl.textContent = ms > 0
      ? 'Expires in ' + Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's'
      : 'Invoice expired';
    setTimeout(tick, 1000);
  }

  function poll() {
    fetch('/api/invoices/' + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) return null;
      return r.json();
    }).then(function (j) {
      if (j) {
        status = j.status;
        if (statusEl) {
          statusEl.textContent = j.status +
            (j.status === 'detected' || j.status === 'confirmed' ? ' (' + j.confirmations + ' conf)' : '');
          statusEl.className = 'status ' + j.status;
        }
        if (settled(status)) return;
      }
      setTimeout(poll, 10000);
    }).catch(function () {
      setTimeout(poll, 10000);
    });
  }

  tick();
  poll();
})();
`;
