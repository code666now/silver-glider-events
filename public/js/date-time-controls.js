(function dateTimeControlsModule(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SGEDateTimeControls = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDateTimeControlsModule() {
  'use strict';
  const DEFAULT_TIME_ZONE = 'America/Los_Angeles';
  const attached = new WeakMap();

  function validTimeZone(value) {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: value || DEFAULT_TIME_ZONE }).resolvedOptions().timeZone; }
    catch (_) { return DEFAULT_TIME_ZONE; }
  }

  function localDate(timeZone = DEFAULT_TIME_ZONE, now = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: validTimeZone(timeZone), calendar: 'iso8601', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(now));
    const value = type => parts.find(part => part.type === type)?.value || '';
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  function timeZoneName(timeZone = DEFAULT_TIME_ZONE, now = Date.now()) {
    const zone = validTimeZone(timeZone);
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' })
        .formatToParts(new Date(now)).find(part => part.type === 'timeZoneName')?.value || zone.replace(/_/g, ' ');
    } catch (_) { return zone.replace(/_/g, ' '); }
  }

  function attach({ dateInput, timeInput, dateButton, timeButton, todayButton, timeZoneLabel,
    timeZone = DEFAULT_TIME_ZONE, minToday = false, now = Date.now } = {}) {
    const inputs = [dateInput, timeInput].filter(Boolean);
    if (!inputs.length) return null;
    const existing = inputs.map(input => attached.get(input)).find(Boolean);
    if (existing) return existing;
    const zone = validTimeZone(timeZone);
    const readNow = typeof now === 'function' ? now : () => now;
    const listeners = [];
    const snapshots = [];
    const invalidAttempted = new WeakSet();
    const wrappers = inputs.map(input => input.closest?.('.sge-datetime-control') || input.parentElement).filter(Boolean);
    const classes = ['is-enhanced', 'is-filled', 'is-invalid', 'is-disabled', 'is-readonly'];
    const wrapperClasses = wrappers.map(wrapper => ({ wrapper, original: classes.map(name => wrapper.classList.contains(name)) }));
    const initialMin = dateInput?.getAttribute('min') ?? null;
    let writtenMin = null;
    let destroyed = false;

    function listen(target, type, listener) {
      if (!target?.addEventListener) return;
      target.addEventListener(type, listener);
      listeners.push(() => target.removeEventListener(type, listener));
    }

    function snapshot(element, attributes = []) {
      if (!element) return;
      snapshots.push({ element, hidden: element.hidden, disabled: element.disabled,
        attributes: attributes.map(name => [name, element.getAttribute(name)]) });
    }

    function dateBoundary(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : ''; }
    function blocked(input) { return !input || input.disabled || input.readOnly; }
    function today() { return localDate(zone, readNow()); }

    function updateMinimum(value = today()) {
      if (!dateInput || !minToday) return;
      const current = dateBoundary(dateInput.min);
      const next = current && current > value ? current : value;
      if (dateInput.min !== next) { dateInput.min = next; writtenMin = next; }
    }

    function todayAllowed(value = today()) {
      if (blocked(dateInput)) return false;
      const minimum = dateBoundary(dateInput.min);
      const maximum = dateBoundary(dateInput.max);
      return (!minimum || value >= minimum) && (!maximum || value <= maximum);
    }

    function sync() {
      if (destroyed) return;
      const currentToday = today();
      updateMinimum(currentToday);
      [[dateInput, dateButton], [timeInput, timeButton]].forEach(([input, button]) => {
        if (!input) return;
        const wrapper = input.closest?.('.sge-datetime-control') || input.parentElement;
        if (wrapper) {
          const invalid = input.getAttribute('aria-invalid') === 'true'
            || (invalidAttempted.has(input) && input.validity?.valid === false);
          wrapper.classList.add('is-enhanced');
          wrapper.classList.toggle('is-filled', Boolean(input.value));
          wrapper.classList.toggle('is-invalid', invalid);
          wrapper.classList.toggle('is-disabled', Boolean(input.disabled));
          wrapper.classList.toggle('is-readonly', Boolean(input.readOnly));
        }
        if (button) button.disabled = blocked(input);
      });
      if (todayButton) {
        todayButton.disabled = !todayAllowed(currentToday);
        todayButton.setAttribute('aria-pressed', String(Boolean(dateInput?.value && dateInput.value === currentToday)));
      }
      if (timeZoneLabel) {
        timeZoneLabel.textContent = timeZoneName(zone, readNow());
        timeZoneLabel.setAttribute('title', zone);
      }
    }

    function open(input, button) {
      if (destroyed || blocked(input)) return;
      sync(); // Refresh today's minimum before an event left open overnight.
      try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); }
      if (typeof input.showPicker === 'function') {
        try { input.showPicker(); return; } catch (_) { /* Native access below stays available. */ }
      }
      // Older Safari may only open on a true tap of the native indicator.
      // Do not leave a synthetic-click overlay in front of that fallback.
      if (button) button.hidden = true;
      try { input.click(); } catch (_) { /* Focusing still preserves keyboard entry. */ }
    }

    function setToday() {
      if (destroyed) return;
      const value = today();
      updateMinimum(value);
      if (!todayAllowed(value)) { sync(); return; }
      if (dateInput.value !== value) {
        dateInput.value = value;
        const EventConstructor = dateInput.ownerDocument?.defaultView?.Event || globalThis.Event;
        dateInput.dispatchEvent(new EventConstructor('input', { bubbles: true }));
        dateInput.dispatchEvent(new EventConstructor('change', { bubbles: true }));
      }
      sync(); // Today never reads or changes the independent time input.
    }

    function restoreAttribute(element, name, value) {
      if (value === null) element.removeAttribute(name);
      else element.setAttribute(name, value);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.forEach(remove => remove());
      for (const { element, hidden, disabled, attributes } of snapshots) {
        if (hidden !== undefined) element.hidden = hidden;
        if (disabled !== undefined) element.disabled = disabled;
        attributes.forEach(([name, value]) => restoreAttribute(element, name, value));
      }
      wrapperClasses.forEach(({ wrapper, original }) => classes.forEach((name, index) => wrapper.classList.toggle(name, original[index])));
      if (dateInput && writtenMin !== null && dateInput.min === writtenMin) restoreAttribute(dateInput, 'min', initialMin);
      inputs.forEach(input => attached.delete(input));
    }

    [[dateInput, dateButton, 'Choose date'], [timeInput, timeButton, 'Choose time']].forEach(([input, button, fallbackLabel]) => {
      if (!input) return;
      ['input', 'change', 'focus', 'blur'].forEach(type => listen(input, type, sync));
      listen(input, 'invalid', () => { invalidAttempted.add(input); sync(); });
      if (!button) return;
      snapshot(button, ['type', 'aria-label', 'aria-controls']);
      button.type = 'button';
      button.hidden = typeof input.showPicker !== 'function';
      if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', fallbackLabel);
      if (input.id) button.setAttribute('aria-controls', input.id);
      listen(button, 'click', event => { event.preventDefault(); open(input, button); });
    });
    if (todayButton && dateInput) {
      snapshot(todayButton, ['type', 'aria-pressed']);
      todayButton.type = 'button';
      todayButton.hidden = false;
      listen(todayButton, 'click', event => { event.preventDefault(); setToday(); });
    }
    if (timeZoneLabel) snapshot(timeZoneLabel, ['title']);
    const control = { sync, destroy };
    inputs.forEach(input => attached.set(input, control));
    sync();
    return control;
  }

  return { DEFAULT_TIME_ZONE, localDate, timeZoneName, attach };
});
