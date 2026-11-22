/* Shared confirmation / alert modal for the Watch Together UI. */
(function () {
  'use strict';

  function root() {
    let el = document.getElementById('modalRoot');
    if (!el) {
      el = document.createElement('div');
      el.id = 'modalRoot';
      document.body.appendChild(el);
    }
    return el;
  }

  function open(options, withCancel) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';

      const box = document.createElement('div');
      box.className = 'modal-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');

      const h = document.createElement('h3');
      h.className = 'modal-title';
      h.textContent = options.title || 'Please confirm';

      const p = document.createElement('p');
      p.className = 'modal-message';
      p.textContent = options.message || '';

      const actions = document.createElement('div');
      actions.className = 'modal-actions';

      function finish(value) {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(value);
      }

      if (withCancel) {
        const cancel = document.createElement('button');
        cancel.className = 'btn';
        cancel.textContent = options.cancelText || 'Cancel';
        cancel.addEventListener('click', () => finish(false));
        actions.appendChild(cancel);
      }

      const ok = document.createElement('button');
      ok.className = 'btn ' + (options.danger ? 'btn-danger' : 'btn-primary');
      ok.textContent = options.confirmText || (withCancel ? 'Confirm' : 'OK');
      ok.addEventListener('click', () => finish(true));
      actions.appendChild(ok);

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      }
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });

      box.append(h, p, actions);
      overlay.appendChild(box);
      root().appendChild(overlay);
      (withCancel ? (actions.querySelector('.btn')) : ok).focus();
    });
  }

  function prompt(options) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const h = document.createElement('h3');
      h.className = 'modal-title';
      h.textContent = options.title || 'Enter a value';
      const p = document.createElement('p');
      p.className = 'modal-message';
      p.textContent = options.message || '';
      const input = document.createElement('input');
      input.type = options.inputType || 'text';
      input.className = 'modal-input';
      input.placeholder = options.placeholder || '';
      input.value = options.value || '';
      const err = document.createElement('div');
      err.className = 'modal-error';
      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.textContent = 'Cancel';
      const ok = document.createElement('button');
      ok.className = 'btn btn-primary';
      ok.textContent = options.confirmText || 'Continue';
      function finish(value) {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(value);
      }
      cancel.addEventListener('click', () => finish(null));
      ok.addEventListener('click', () => finish(input.value.trim() || null));
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); finish(null); }
        if (e.key === 'Enter') { e.preventDefault(); ok.click(); }
      }
      document.addEventListener('keydown', onKey);
      actions.append(cancel, ok);
      box.append(h, p, input, err, actions);
      overlay.appendChild(box);
      root().appendChild(overlay);
      input.focus();
    });
  }

  window.AppModal = {
    confirm(options) { return open(options || {}, true); },
    alert(options) { return open(options || {}, false); },
    prompt,
  };
})();
