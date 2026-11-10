(function enhanceLegalReview() {
  'use strict';

  const form = document.getElementById('legal-review-form');
  const checkbox = document.getElementById('legal-review-accepted');
  const submit = document.getElementById('legal-review-submit');
  if (!form || !checkbox || !submit) return;

  const label = submit.querySelector('[data-legal-review-submit-label]');
  const spinner = submit.querySelector('.legal-review-spinner');
  const status = document.getElementById('legal-review-status');
  const error = document.getElementById('legal-review-error');
  let submitting = false;

  function updateButton() {
    submit.disabled = submitting || !checkbox.checked;
  }

  function resetPendingState() {
    submitting = false;
    form.removeAttribute('aria-busy');
    submit.removeAttribute('aria-busy');
    if (label) label.textContent = 'Agree and continue';
    if (spinner) spinner.hidden = true;
    if (status) status.textContent = '';
    updateButton();
  }

  checkbox.addEventListener('change', updateButton);
  form.addEventListener('submit', function (event) {
    if (submitting || !checkbox.checked) {
      event.preventDefault();
      if (!submitting) checkbox.focus();
      return;
    }

    // Keep the checkbox enabled so native form submission includes agreement.
    // Only the server can record acceptance and continue to the saved destination.
    submitting = true;
    form.setAttribute('aria-busy', 'true');
    submit.setAttribute('aria-busy', 'true');
    if (label) label.textContent = 'Saving…';
    if (spinner) spinner.hidden = false;
    if (status) status.textContent = 'Saving your agreement.';
    updateButton();
  });

  // Check recorded agreement when Safari restores an old review screen. Use an
  // explicit GET rather than reload(), which could replay a failed form POST.
  window.addEventListener('pageshow', function (event) {
    resetPendingState();
    if (event.persisted) {
      const destination = form.querySelector('[name="next"]')?.value || '/';
      window.location.replace('/account/review?next=' + encodeURIComponent(destination));
    }
  });
  resetPendingState();
  if (error && !error.hidden && error.textContent.trim()) error.focus();
})();
