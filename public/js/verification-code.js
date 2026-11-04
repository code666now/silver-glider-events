(function verificationCodeModule(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SgeVerificationCode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createVerificationCodeModule() {
  'use strict';
  const LENGTH = 6;
  const attached = new WeakMap();
  const states = new Set(['idle', 'checking', 'success', 'error', 'sending']);
  const digits = value => String(value || '').replace(/\D/g, '').slice(0, LENGTH);

  function selection(value, start, end) {
    const count = digits(value).length;
    const from = Math.min(count, Math.max(0, Number(start) || 0));
    const to = Math.min(count, Math.max(from, Number(end) || 0));
    return { start: from, end: to, active: Math.min(from, LENGTH - 1), atEnd: from === LENGTH };
  }

  function attach({ input, container, button, status, error } = {}) {
    if (!input || !container || !button || !input.ownerDocument?.createElement) return null;
    if (attached.has(input)) return attached.get(input);
    const documentRoot = input.ownerDocument;
    const original = {
      readOnly: input.readOnly,
      invalid: input.getAttribute('aria-invalid'),
      buttonDisabled: button.disabled,
      buttonBusy: button.getAttribute('aria-busy'),
      buttonChildren: Array.from(button.childNodes),
      containerState: container.getAttribute('data-verification-state'),
      buttonState: button.getAttribute('data-verification-state')
    };
    const visual = documentRoot.createElement('div');
    visual.className = 'sg-verification-cells';
    visual.setAttribute('aria-hidden', 'true');
    const cells = Array.from({ length: LENGTH }, () => {
      const cell = documentRoot.createElement('span');
      cell.className = 'sg-verification-cell';
      cell.setAttribute('aria-hidden', 'true');
      const digit = documentRoot.createElement('span');
      digit.className = 'sg-verification-digit';
      cell.append(digit);
      visual.append(cell);
      return { cell, digit };
    });
    const icon = documentRoot.createElement('span');
    icon.className = 'sg-verification-button-icon';
    icon.setAttribute('aria-hidden', 'true');
    const label = documentRoot.createElement('span');
    label.className = 'sg-verification-button-label';
    const defaultLabel = button.textContent.trim() || 'Continue';
    label.textContent = defaultLabel;
    button.replaceChildren(icon, label);
    container.append(visual);
    container.classList.add('sg-verification-code');
    input.classList.add('sg-verification-native');
    button.classList.add('sg-verification-button');
    error?.classList.add('sg-verification-error');
    let state = 'idle';
    let disabledOverride = null;
    let lastValue = '';
    let destroyed = false;
    const listeners = [];

    function listen(target, name, handler) {
      target.addEventListener(name, handler);
      listeners.push(() => target.removeEventListener(name, handler));
    }

    function text(element, value) {
      if (element && element.textContent !== value) element.textContent = value;
    }

    function sync() {
      if (destroyed) return;
      const value = digits(input.value);
      const focused = documentRoot.activeElement === input;
      const range = selection(value, input.selectionStart, input.selectionEnd);
      container.classList.toggle('is-focused', focused);
      cells.forEach(({ cell, digit }, index) => {
        const next = value[index] || '';
        if (digit.textContent !== next) {
          text(digit, next);
          cell.classList.remove('is-entering');
          if (next && next !== lastValue[index]) {
            // Restart only this changed digit, not the whole row or selection.
            void digit.offsetWidth;
            cell.classList.add('is-entering');
          }
        }
        cell.classList.toggle('is-filled', Boolean(next));
        cell.classList.toggle('is-selected', focused && range.end > range.start && index >= range.start && index < range.end);
        cell.classList.toggle('is-active', focused && !input.readOnly && range.start === range.end && index === range.active);
        cell.classList.toggle('is-at-end', range.atEnd && index === LENGTH - 1);
      });
      lastValue = value;
      const busy = state === 'checking' || state === 'sending';
      button.disabled = busy || state === 'success' || disabledOverride === true || value.length !== LENGTH;
      button.setAttribute('aria-busy', String(busy));
      // A complete native input may scroll to its invisible trailing glyph. The
      // visible caret/selection lives in the cells, so keep the full row fixed.
      input.scrollLeft = 0;
    }

    function normalizeInput(event) {
      if (!event?.isComposing) {
        const value = String(input.value || '');
        const normalized = digits(value);
        if (value !== normalized) {
          const caret = digits(value.slice(0, input.selectionStart ?? value.length)).length;
          input.value = normalized;
          input.setSelectionRange?.(caret, caret);
        }
      }
      sync();
    }

    function paste(event) {
      if (input.readOnly || input.disabled || !event.clipboardData?.getData) return;
      const pasted = String(event.clipboardData.getData('text/plain') || event.clipboardData.getData('text') || '').replace(/\D/g, '');
      if (pasted.length !== LENGTH) return; // Partial paste keeps native editing.
      event.preventDefault();
      event.stopPropagation(); // Do not also run the delegated email paste helper.
      input.value = pasted;
      input.setSelectionRange?.(LENGTH, LENGTH);
      const EventConstructor = documentRoot.defaultView?.Event || globalThis.Event;
      input.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    }

    function placeCaret(event) {
      if (input.readOnly || input.disabled || !Number.isFinite(event.clientX) || event.detail > 1 || event.shiftKey) return;
      if (input.selectionStart !== input.selectionEnd) { sync(); return; } // Keep native drag/word selection.
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const position = Math.min(digits(input.value).length, Math.max(0, Math.floor((event.clientX - rect.left) / (rect.width / LENGTH))));
      input.setSelectionRange?.(position, position);
      sync();
    }

    function setState(next, options = {}) {
      if (destroyed || !states.has(next)) return;
      state = next;
      disabledOverride = typeof options.disabled === 'boolean' ? options.disabled : null;
      container.setAttribute('data-verification-state', state);
      button.setAttribute('data-verification-state', state);
      input.readOnly = original.readOnly || ['checking', 'sending', 'success'].includes(state);
      input.setAttribute('aria-invalid', String(state === 'error'));
      text(label, options.label === undefined ? defaultLabel : String(options.label));
      if (state === 'error') {
        text(status, '');
        if (options.message !== undefined) text(error, String(options.message));
      } else {
        text(error, '');
        if (options.message !== undefined) text(status, String(options.message));
        else if (state === 'idle') text(status, '');
      }
      sync();
    }

    function reset() {
      if (destroyed) return;
      input.value = '';
      input.setSelectionRange?.(0, 0);
      text(error, '');
      text(status, '');
      setState('idle');
    }

    function restoreAttribute(element, name, value) {
      if (value === null) element.removeAttribute(name);
      else element.setAttribute(name, value);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.forEach(remove => remove());
      visual.remove();
      container.classList.remove('sg-verification-code', 'is-focused');
      input.classList.remove('sg-verification-native');
      button.classList.remove('sg-verification-button');
      error?.classList.remove('sg-verification-error');
      button.replaceChildren(...original.buttonChildren);
      input.readOnly = original.readOnly;
      button.disabled = original.buttonDisabled;
      restoreAttribute(input, 'aria-invalid', original.invalid);
      restoreAttribute(button, 'aria-busy', original.buttonBusy);
      restoreAttribute(container, 'data-verification-state', original.containerState);
      restoreAttribute(button, 'data-verification-state', original.buttonState);
      attached.delete(input);
    }

    listen(input, 'input', normalizeInput);
    listen(input, 'change', normalizeInput);
    listen(input, 'paste', paste);
    ['focus', 'blur', 'select', 'keyup', 'pointerup'].forEach(name => listen(input, name, sync));
    listen(input, 'click', placeCaret);
    listen(documentRoot, 'selectionchange', () => { if (documentRoot.activeElement === input) sync(); });
    const control = { sync, setState, reset, destroy };
    attached.set(input, control);
    setState('idle');
    return control;
  }

  function createResend(button, options = {}) {
    if (!button) return null;
    const now = options.now || Date.now;
    const schedule = options.setTimeout || globalThis.setTimeout;
    const cancel = options.clearTimeout || globalThis.clearTimeout;
    const readyLabel = options.label || 'Send a new code';
    const countdownLabel = options.countdownLabel || 'Resend';
    let deadline = 0;
    let timer = null;
    let sending = false;
    let sendingLabel = 'Sending a new code…';
    let destroyed = false;
    const getRemaining = () => Math.max(0, deadline - now());

    function clearTimer() {
      if (timer !== null) cancel(timer);
      timer = null;
    }

    function render() {
      if (destroyed) return;
      clearTimer();
      const remaining = getRemaining();
      const seconds = Math.ceil(remaining / 1000);
      const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      button.disabled = sending || remaining > 0;
      button.setAttribute('aria-busy', String(sending));
      button.setAttribute('data-resend-state', sending ? 'sending' : remaining > 0 ? 'cooldown' : 'ready');
      button.textContent = sending ? sendingLabel : remaining > 0 ? `${countdownLabel} in ${countdown}` : readyLabel;
      if (remaining > 0) timer = schedule(render, Math.min(1000, remaining));
    }

    function start(milliseconds = 30000) {
      if (destroyed) return;
      deadline = now() + Math.max(0, Number(milliseconds) || 0);
      sending = false;
      render();
    }

    function stop() {
      if (destroyed) return;
      deadline = 0;
      sending = false;
      render();
    }

    function setSending(value, { label } = {}) {
      if (destroyed) return;
      sending = Boolean(value);
      if (label) sendingLabel = String(label);
      render(); // Clearing sending never shortens an existing server deadline.
    }

    function destroy() { destroyed = true; clearTimer(); }
    render();
    return { start, stop, setSending, getRemaining, destroy };
  }

  return { LENGTH, digits, selection, attach, createResend };
});
