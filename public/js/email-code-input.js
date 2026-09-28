(function emailCodeInput() {
  'use strict';

  const selector = '[data-email-code]';
  const installedDocuments = new WeakSet();

  function digits(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function isEmailCodeInput(target) {
    return Boolean(target && typeof target.matches === 'function' && target.matches(selector));
  }

  function dispatchInput(input) {
    const EventConstructor = input.ownerDocument?.defaultView?.Event || globalThis.Event;
    if (typeof input.dispatchEvent !== 'function' || typeof EventConstructor !== 'function') return;
    input.dispatchEvent(new EventConstructor('input', { bubbles:true }));
  }

  function handlePaste(event) {
    const input = event?.target;
    if (!isEmailCodeInput(input) || typeof event.clipboardData?.getData !== 'function') return false;
    const pastedDigits = digits(event.clipboardData.getData('text/plain') || event.clipboardData.getData('text'));
    if (pastedDigits.length !== 6) return false;
    event.preventDefault();
    input.value = pastedDigits;
    dispatchInput(input);
    return true;
  }

  function handleInput(event) {
    const input = event?.target;
    if (!isEmailCodeInput(input)) return false;
    const normalized = digits(input.value).slice(0, 6);
    if (input.value === normalized) return false;
    input.value = normalized;
    return true;
  }

  function install(documentRoot) {
    if (!documentRoot || typeof documentRoot.addEventListener !== 'function' || installedDocuments.has(documentRoot)) return;
    installedDocuments.add(documentRoot);
    documentRoot.addEventListener('paste', handlePaste);
    documentRoot.addEventListener('input', handleInput);
  }

  const api = { digits, handleInput, handlePaste, install, selector };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') install(document);
})();
