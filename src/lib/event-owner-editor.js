const { esc } = require('./public-html');

const THEMES = [
  ['midnight', 'Midnight', 'gradient'],
  ['aurora', 'Aurora', 'gradient'],
  ['sunset', 'Sunset', 'gradient'],
  ['ocean', 'Ocean', 'gradient'],
  ['halloween', 'Halloween', 'effect'],
  ['last-guest', 'The Last Guest', 'effect'],
  ['disco', 'Disco', 'effect'],
  ['fog', 'Fog', 'effect'],
  ['paper', 'Kraft paper', 'effect'],
  ['static', 'TV static', 'effect'],
  ['saloon', 'After Hours Saloon', 'effect']
];

function themeButtons(kind) {
  return THEMES.filter(([, , group]) => group === kind).map(([key, label]) => (
    `<button class="owner-theme" type="button" data-owner-theme="${key}" aria-pressed="false">
      <span class="owner-theme-preview owner-theme-${key}" aria-hidden="true"></span>
      <span>${label}</span>
    </button>`
  )).join('');
}

function ownerEventData(event) {
  return {
    id: event.id,
    slug: event.slug,
    presentationMode: event.presentation_mode === 'flyer' ? 'flyer' : 'standard',
    title: event.title,
    description: event.description || '',
    eventDate: event.event_date,
    startTime: event.start_time,
    endTime: event.end_time || '',
    venueName: event.venue_name,
    venueAddress: event.venue_address || '',
    category: event.category || '',
    capacity: event.capacity,
    visibility: event.visibility === 'private' ? 'private' : 'public',
    showGuestList: event.show_guest_list === true,
    allowGuests: event.allow_guests === true,
    commentsEnabled: event.comments_enabled === true,
    secretShowEnabled: event.secret_show_enabled === true,
    backgroundTheme: event.background_theme || 'midnight',
    coverImageUrl: event.cover_image_url || '',
    flyerImageUrl: event.flyer_image_url || '',
    coverFitMode: ['contain', 'cover'].includes(event.cover_fit_mode) ? event.cover_fit_mode : 'auto',
    coverCreditName: event.cover_credit_name || '',
    coverCreditLink: event.cover_credit_link || '',
    artworkAccentColor: event.artwork_accent_color || '',
    rsvpCount: Number(event.total_attendance) || 0
  };
}

function renderOwnerEditor(event) {
  const data = JSON.stringify(ownerEventData(event)).replace(/</g, '\\u003c');
  const advancedHref = `/events/${encodeURIComponent(event.id)}/edit`;
  const manageHref = `/events/${encodeURIComponent(event.id)}/manage`;
  return `<div class="owner-edit-root" id="owner-edit-root">
    <button class="owner-edit-trigger" id="owner-edit-trigger" type="button" aria-controls="owner-editor" aria-expanded="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>
      <span>Edit event</span>
    </button>

    <aside class="owner-editor" id="owner-editor" role="dialog" aria-hidden="true" aria-labelledby="owner-editor-title">
      <header class="owner-editor-head">
        <div>
          <p>Host tools</p>
          <h2 id="owner-editor-title">Edit event</h2>
        </div>
        <div class="owner-editor-head-actions">
          <button class="owner-editor-peek" id="owner-editor-peek" type="button" aria-expanded="true">Preview</button>
          <button class="owner-editor-close" id="owner-editor-close" type="button" aria-label="Close event editor">×</button>
        </div>
      </header>

      <form class="owner-editor-form" id="owner-editor-form">
        <div class="owner-editor-tabs" role="tablist" aria-label="Event editing sections">
          <button type="button" role="tab" id="owner-tab-appearance" aria-controls="owner-panel-appearance" aria-selected="true" data-owner-tab="appearance">Appearance</button>
          <button type="button" role="tab" id="owner-tab-details" aria-controls="owner-panel-details" aria-selected="false" tabindex="-1" data-owner-tab="details">Details</button>
          <button type="button" role="tab" id="owner-tab-settings" aria-controls="owner-panel-settings" aria-selected="false" tabindex="-1" data-owner-tab="settings">Guest settings</button>
        </div>

        <div class="owner-editor-scroll">
          <section class="owner-editor-panel" id="owner-panel-appearance" role="tabpanel" aria-labelledby="owner-tab-appearance" data-owner-panel="appearance">
            <div class="owner-section-intro"><h3>Appearance</h3><p>Try changes on the live page. They stay private until you save.</p></div>

            <div class="owner-image-card" id="owner-image-card" role="button" tabindex="0" aria-label="Upload a new event image">
              <img id="owner-image-preview" alt="Current event artwork">
              <span id="owner-image-empty">No event image</span>
            </div>
            <input id="owner-image-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
            <div class="owner-image-actions">
              <button class="owner-action-button" id="owner-upload-image" type="button">Upload image</button>
              <button class="owner-action-button" id="owner-browse-photos" type="button">Browse free photos</button>
              <button class="owner-action-button owner-action-muted" id="owner-remove-image" type="button">Remove</button>
            </div>
            <p class="owner-inline-status" id="owner-upload-status" role="status"></p>

            <fieldset class="owner-fit-field" id="owner-fit-field">
              <legend>Phone image fit</legend>
              <div class="owner-segmented">
                <label><input type="radio" name="owner_cover_fit" value="contain"><span>Show full image</span></label>
                <label><input type="radio" name="owner_cover_fit" value="cover"><span>Fill the space</span></label>
              </div>
            </fieldset>

            <div class="owner-photo-browser" id="owner-photo-browser" hidden>
              <div class="owner-subview-head">
                <button id="owner-photo-back" type="button">← Appearance</button>
                <strong>Free photos</strong>
              </div>
              <div class="owner-photo-search">
                <input class="owner-input" id="owner-photo-query" type="search" placeholder="Search free photos" aria-label="Search free photos">
                <button id="owner-photo-search" type="button">Search</button>
              </div>
              <div class="owner-photo-categories" id="owner-photo-categories" aria-label="Photo collections"></div>
              <p class="owner-photo-status" id="owner-photo-status" role="status"></p>
              <div class="owner-photo-grid" id="owner-photo-grid"></div>
              <button class="owner-load-more" id="owner-photo-more" type="button" hidden>Load more</button>
              <p class="owner-photo-credit-note">Photos via Unsplash. Photographer credit appears on the event page.</p>
            </div>

            <div class="owner-theme-picker" id="owner-theme-picker">
              <div class="owner-theme-group owner-gradient-group">
                <h4>Gradients</h4>
                <div class="owner-theme-grid">${themeButtons('gradient')}</div>
              </div>
              <div class="owner-theme-group">
                <h4>Effects</h4>
                <div class="owner-theme-grid">
                  <button class="owner-theme owner-flyer-default" type="button" data-owner-theme="midnight" aria-pressed="false" hidden>
                    <span class="owner-theme-preview owner-theme-plaster" aria-hidden="true"></span>
                    <span>Default wall</span>
                  </button>
                  ${themeButtons('effect')}
                </div>
              </div>
            </div>
          </section>

          <section class="owner-editor-panel" id="owner-panel-details" role="tabpanel" aria-labelledby="owner-tab-details" data-owner-panel="details" hidden>
            <div class="owner-section-intro"><h3>Event details</h3><p>Edit the essentials while seeing the page update beside you.</p></div>
            <label class="owner-field"><span>Title</span><input class="owner-input" id="owner-title" maxlength="140" required></label>
            <div class="owner-field-row">
              <label class="owner-field"><span>Date</span><input class="owner-input" id="owner-date" type="date" required></label>
              <label class="owner-field"><span>Start time</span><input class="owner-input" id="owner-start-time" type="time" required></label>
            </div>
            <label class="owner-field"><span>Venue</span><input class="owner-input" id="owner-venue" maxlength="140" required></label>
            <label class="owner-field"><span>Address <small>Optional</small></span><input class="owner-input" id="owner-address"></label>
            <label class="owner-field"><span>Category</span>
              <select class="owner-input" id="owner-category">
                <option value="">Choose category</option><option>Music</option><option>Art</option><option>Market</option><option>Party</option><option>Community</option><option>Food &amp; Drink</option><option>Film</option><option>Other</option>
              </select>
            </label>
            <label class="owner-field"><span>Description <small>Optional</small></span><textarea class="owner-input owner-textarea" id="owner-description"></textarea></label>
          </section>

          <section class="owner-editor-panel" id="owner-panel-settings" role="tabpanel" aria-labelledby="owner-tab-settings" data-owner-panel="settings" hidden>
            <div class="owner-section-intro"><h3>Guest settings</h3><p>Control who can find the event and how guests participate.</p></div>
            <fieldset class="owner-choice-field">
              <legend>Visibility</legend>
              <label class="owner-choice"><input type="radio" name="owner_visibility" value="public"><span><strong>Public</strong><small>Visible on your Host Page and shareable.</small></span></label>
              <label class="owner-choice"><input type="radio" name="owner_visibility" value="private"><span><strong>Private link only</strong><small>Hidden from discovery. Anyone with the link can view it.</small></span></label>
            </fieldset>
            <p class="owner-secret-note" id="owner-secret-note" hidden>Secret Show is on. Disable it in Advanced settings before making this event public.</p>
            <label class="owner-field"><span>Capacity <small>Optional</small></span><input class="owner-input" id="owner-capacity" type="number" min="1" inputmode="numeric" placeholder="Unlimited"></label>
            <div class="owner-switch-list">
              <label class="owner-switch-row"><span><strong>Show guest list</strong><small>Show attendee first names and avatars.</small></span><input id="owner-show-guests" type="checkbox" role="switch"><i aria-hidden="true"><b>On</b><b>Off</b></i></label>
              <label class="owner-switch-row"><span><strong>Allow +1s</strong><small>Let each RSVP bring one named guest.</small></span><input id="owner-allow-guests" type="checkbox" role="switch"><i aria-hidden="true"><b>On</b><b>Off</b></i></label>
              <label class="owner-switch-row"><span><strong>Enable comments</strong><small>Confirmed attendees can join the conversation.</small></span><input id="owner-comments" type="checkbox" role="switch"><i aria-hidden="true"><b>On</b><b>Off</b></i></label>
            </div>
            <div class="owner-rsvp-warning" id="owner-rsvp-warning" role="status" hidden></div>
            <div class="owner-editor-links">
              <a href="${esc(manageHref)}">Manage guests <span aria-hidden="true">→</span></a>
              <a href="${esc(advancedHref)}">Admission, music &amp; advanced settings <span aria-hidden="true">→</span></a>
            </div>
          </section>
        </div>

        <footer class="owner-editor-foot">
          <p id="owner-save-status" role="status">No unsaved changes</p>
          <div>
            <button class="owner-cancel" id="owner-editor-cancel" type="button">Cancel</button>
            <button class="owner-save" id="owner-editor-save" type="submit" disabled>Save changes</button>
          </div>
        </footer>
      </form>
    </aside>
    <div class="owner-editor-toast" id="owner-editor-toast" role="status" aria-live="polite"></div>
    <script id="owner-event-data" type="application/json">${data}</script>
  </div>`;
}

module.exports = { renderOwnerEditor };
