(function thankYouCreditsModule(root, factory) {
  const moduleApi = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = moduleApi;
  if (root) root.SgeThankYouCredits = moduleApi;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createThankYouCreditsModule() {
  const MAX_CREDITS = 3;

  function normalizeRows(value) {
    return Array.isArray(value) ? value.slice(0, MAX_CREDITS).map(person => ({
      name: String(person?.name || ''),
      role: String(person?.role || ''),
      instagramHandle: String(person?.instagramHandle || '')
    })) : [];
  }

  function instagramHandle(value) {
    let raw = String(value || '').trim();
    if (!raw) return { value: null, error: null };
    if (raw.length > 500) return { value: null, error: 'Use an Instagram handle or profile link, up to 500 characters.' };
    let handle = raw;
    try {
      if (raw.includes('/') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
        const url = new URL(raw);
        const authority = raw.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)?.[1] || '';
        const parts = url.pathname.split('/').filter(Boolean);
        if (!['http:', 'https:'].includes(url.protocol) || url.hostname.toLowerCase().replace(/^www\./, '') !== 'instagram.com'
          || url.username || url.password || url.port || /:\d+$/.test(authority) || parts.length !== 1) throw new Error('profile');
        handle = decodeURIComponent(parts[0]);
      } else handle = raw.replace(/^@/, '');
    } catch (_) { return { value: null, error: 'Enter an Instagram handle like @yourcrew or their Instagram profile link.' }; }
    handle = handle.trim().toLowerCase();
    if (handle.length > 30 || !/^[a-z0-9._]+$/.test(handle) || handle.startsWith('.') || handle.endsWith('.') || handle.includes('..')
      || /^(?:p|reel|reels|tv|stories|explore|accounts|direct)$/.test(handle)) {
      return { value: null, error: 'Enter an Instagram handle like @yourcrew or their Instagram profile link.' };
    }
    return { value: handle, error: null };
  }

  function validateRows(value) {
    if (!Array.isArray(value) || value.length > MAX_CREDITS) {
      return { valid: false, credits: [], errors: [{ index: -1, field: 'name', message: 'Add up to three people.' }] };
    }
    const errors = [];
    const credits = [];
    value.forEach((person, index) => {
      const rawName = String(person?.name || '').trim();
      const rawRole = String(person?.role || '').trim();
      const rawInstagram = String(person?.instagramHandle || '').trim();
      if (!rawName && !rawRole && !rawInstagram) return;
      const name = rawName.replace(/\s+/g, ' ');
      const role = rawRole.replace(/\s+/g, ' ');
      if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(rawName)) {
        errors.push({ index, field: 'name', message: name ? 'Keep this name to 100 characters or fewer.' : 'Add their name, or remove this person.' });
      }
      if (role.length > 80 || /[\u0000-\u001f\u007f]/.test(rawRole)) {
        errors.push({ index, field: 'role', message: 'Keep the role to 80 characters or fewer.' });
      }
      const instagram = instagramHandle(rawInstagram);
      if (instagram.error) errors.push({ index, field: 'instagramHandle', message: instagram.error });
      credits.push({ name, role, instagramHandle: instagram.value });
    });
    return { valid: errors.length === 0, credits, errors };
  }

  function create({ onChange } = {}) {
    if (typeof document === 'undefined') return null;
    const details = document.getElementById('post-event-credits');
    const list = document.getElementById('post-event-credits-list');
    const add = document.getElementById('post-event-credit-add');
    const limit = document.getElementById('post-event-credit-limit');
    const error = document.getElementById('post-event-credits-error');
    if (!details || !list || !add) return null;
    let rows = [];
    let nextId = 0;
    let hydrated = false;
    let disabled = false;

    function changed() {
      error.hidden = true;
      error.textContent = '';
      for (const input of list.querySelectorAll('input')) input.setCustomValidity('');
      onChange?.();
    }

    function updateLimit() {
      add.disabled = disabled || rows.length >= MAX_CREDITS;
      limit.hidden = rows.length < MAX_CREDITS;
    }

    function render({ focusLast = false } = {}) {
      list.replaceChildren();
      rows.forEach((row, index) => {
        const card = document.createElement('div');
        card.className = 'post-event-credit-row';
        card.dataset.creditRow = '';
        const heading = document.createElement('div');
        heading.className = 'post-event-credit-heading';
        const title = document.createElement('strong');
        title.textContent = `Person ${index + 1}`;
        const remove = document.createElement('button');
        remove.className = 'post-event-credit-remove';
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.disabled = disabled;
        remove.setAttribute('aria-label', `Remove ${row.name || `person ${index + 1}`}`);
        remove.addEventListener('click', () => {
          rows = rows.filter(candidate => candidate.id !== row.id);
          render();
          changed();
          const target = list.querySelector(`[data-credit-row]:nth-child(${Math.min(index + 1, rows.length)}) input`) || add;
          target?.focus({ preventScroll: true });
        });
        heading.append(title, remove);
        card.append(heading);
        const fields = [
          { key: 'name', label: 'Name', max: 100, placeholder: 'Their name or artist name' },
          { key: 'role', label: 'Role · optional', max: 80, placeholder: 'DJ, bartender, photographer…' },
          { key: 'instagramHandle', label: 'Instagram · optional', max: 500, placeholder: '@handle or Instagram profile link' }
        ];
        for (const field of fields) {
          const label = document.createElement('label');
          label.className = `post-event-field post-event-credit-field is-${field.key}`;
          const span = document.createElement('span');
          span.textContent = field.label;
          const input = document.createElement('input');
          input.className = 'sg-input';
          input.type = 'text';
          input.id = `post-event-credit-${row.id}-${field.key}`;
          input.dataset.creditField = field.key;
          input.autocomplete = 'off';
          input.maxLength = field.max;
          input.placeholder = field.placeholder;
          input.value = row[field.key];
          input.disabled = disabled;
          if (field.key === 'instagramHandle') { input.autocapitalize = 'none'; input.spellcheck = false; }
          label.htmlFor = input.id;
          input.addEventListener('input', () => {
            row[field.key] = input.value;
            remove.setAttribute('aria-label', `Remove ${row.name || `person ${index + 1}`}`);
            changed();
          });
          label.append(span, input);
          card.append(label);
        }
        list.append(card);
      });
      updateLimit();
      if (focusLast) list.lastElementChild?.querySelector('input')?.focus();
    }

    add.addEventListener('click', () => {
      if (disabled || rows.length >= MAX_CREDITS) return;
      rows.push({ id: ++nextId, name: '', role: '', instagramHandle: '' });
      details.open = true;
      render({ focusLast: true });
      changed();
    });

    return {
      setRows(value) {
        rows = normalizeRows(value).map(row => ({ ...row, id: ++nextId }));
        if (!hydrated) details.open = rows.length > 0;
        hydrated = true;
        render();
      },
      rawRows() { return rows.map(({ name, role, instagramHandle }) => ({ name, role, instagramHandle })); },
      read({ reportErrors = false } = {}) {
        const result = validateRows(rows);
        for (const input of list.querySelectorAll('input')) input.setCustomValidity('');
        error.hidden = result.valid;
        error.textContent = result.valid ? '' : result.errors[0].message;
        if (!result.valid && reportErrors) {
          details.open = true;
          const first = result.errors[0];
          const row = rows[first.index];
          const input = row ? document.getElementById(`post-event-credit-${row.id}-${first.field}`) : null;
          if (input) {
            input.setCustomValidity(first.message);
            input.focus();
            input.reportValidity();
          } else add.focus();
        }
        return result;
      },
      setDisabled(value) {
        disabled = Boolean(value);
        for (const control of list.querySelectorAll('input,button')) control.disabled = disabled;
        updateLimit();
      }
    };
  }

  return { MAX_CREDITS, normalizeRows, instagramHandle, validateRows, create };
});
