const { esc } = require('./public-html');
const { ADMISSION_TYPES, normalizeAdmissionType } = require('./admission');

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
  ['liquid-stardust', 'Liquid Stardust', 'effect'],
  ['color-static', 'Color Static', 'effect'],
  ['saloon', 'After Hours Saloon', 'effect'],
  ['adaptive', 'Match Photo', 'effect']
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
  const admissionType = normalizeAdmissionType(event.admission_type) || ADMISSION_TYPES.FREE_RSVP;
  return {
    id: event.id,
    slug: event.slug,
    presentationMode: event.presentation_mode === 'flyer' ? 'flyer' : 'standard',
    status: event.status,
    title: event.title,
    description: event.description || '',
    eventDate: event.event_date,
    startTime: event.start_time,
    endTime: event.end_time || '',
    venueName: event.venue_name,
    venueAddress: event.venue_address || '',
    venueCity: event.venue_city || '',
    venueState: event.venue_state || '',
    venueLatitude: event.venue_latitude ?? null,
    venueLongitude: event.venue_longitude ?? null,
    googlePlaceId: event.google_place_id || '',
    category: event.category || '',
    capacity: event.capacity,
    admissionType,
    ticketPrice: event.ticket_price == null ? null : Number(event.ticket_price),
    ticketUrl: event.ticket_url || '',
    commerceEventId: event.commerce_event_id || '',
    visibility: event.visibility === 'private' ? 'private' : 'public',
    showGuestList: event.show_guest_list === true,
    allowGuests: event.allow_guests === true,
    commentsEnabled: event.comments_enabled === true,
    secretShowEnabled: event.secret_show_enabled === true,
    backgroundTheme: event.background_theme || 'midnight',
    coverImageUrl: event.cover_image_url || '',
    flyerImageUrl: event.flyer_image_url || '',
    flyerDesignerName: event.flyer_designer_name || '',
    flyerDesignerInstagramHandle: event.flyer_designer_instagram_handle || '',
    coverFitMode: ['contain', 'cover'].includes(event.cover_fit_mode) ? event.cover_fit_mode : 'auto',
    coverCreditName: event.cover_credit_name || '',
    coverCreditLink: event.cover_credit_link || '',
    artworkAccentColor: event.artwork_accent_color || '',
    rsvpCount: Number(event.rsvp_count) || 0
  };
}

function renderOwnerEditor(event) {
  const data = JSON.stringify(ownerEventData(event)).replace(/</g, '\\u003c');
  const advancedHref = `/events/new?id=${encodeURIComponent(event.id)}&advanced=1`;
  const manageHref = `/events/${encodeURIComponent(event.id)}/manage`;
  const draftNotice = event.status === 'draft'
    ? '<div class="owner-draft-notice"><strong>Draft</strong><span>Only you can see this event.</span></div>'
    : '';
  return `<div class="owner-edit-root" id="owner-edit-root">
    <button class="owner-edit-trigger" id="owner-edit-trigger" type="button" aria-controls="owner-editor" aria-expanded="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>
      <span>Edit event</span>
    </button>

    <aside class="owner-editor" id="owner-editor" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="owner-editor-title">
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

      <form class="owner-editor-form" id="owner-editor-form" novalidate>
        ${draftNotice}
        <div class="owner-editor-tabs" role="tablist" aria-label="Event editing sections">
          <button type="button" role="tab" id="owner-tab-appearance" aria-controls="owner-panel-appearance" aria-selected="true" data-owner-tab="appearance">Appearance</button>
          <button type="button" role="tab" id="owner-tab-details" aria-controls="owner-panel-details" aria-selected="false" tabindex="-1" data-owner-tab="details">Details</button>
          <button type="button" role="tab" id="owner-tab-settings" aria-controls="owner-panel-settings" aria-selected="false" tabindex="-1" data-owner-tab="settings">Guest settings</button>
        </div>

        <div class="owner-mobile-subnav" id="owner-mobile-subnav" hidden>
          <button class="owner-mobile-back" id="owner-mobile-back" type="button" aria-label="Back to event settings">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <div>
            <span id="owner-mobile-view-eyebrow">Edit event</span>
            <strong id="owner-mobile-view-title" tabindex="-1"></strong>
          </div>
          <button class="owner-mobile-done" id="owner-mobile-done" type="button">Done</button>
        </div>
        <p class="owner-mobile-view-status" id="owner-mobile-view-status" role="alert" hidden></p>

        <div class="owner-editor-scroll">
          <section class="owner-mobile-hub" id="owner-mobile-hub" aria-labelledby="owner-mobile-hub-title" hidden>
            <div class="owner-mobile-hub-intro">
              <p>Event setup</p>
              <h3 id="owner-mobile-hub-title" tabindex="-1">Make it yours</h3>
              <span>Choose a section. Your changes stay private until you save.</span>
            </div>
            <div class="owner-mobile-hub-list">
              <button class="owner-mobile-hub-row" type="button" data-owner-mobile-view="appearance" aria-controls="owner-panel-appearance">
                <span class="owner-mobile-hub-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m5 18 5-5 3 3 2-2 4 4"/></svg></span>
                <span class="owner-mobile-hub-copy"><strong>Appearance</strong><small id="owner-mobile-summary-appearance"></small></span>
                <span class="owner-mobile-hub-arrow" aria-hidden="true">›</span>
              </button>
              <button class="owner-mobile-hub-row" type="button" data-owner-mobile-view="details" aria-controls="owner-panel-details">
                <span class="owner-mobile-hub-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4M16 3v4M4 10h16"/></svg></span>
                <span class="owner-mobile-hub-copy"><strong>Event details</strong><small id="owner-mobile-summary-details"></small></span>
                <span class="owner-mobile-hub-arrow" aria-hidden="true">›</span>
              </button>
              <button class="owner-mobile-hub-row" type="button" data-owner-mobile-view="access" aria-controls="owner-panel-settings">
                <span class="owner-mobile-hub-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 5h14v4a3 3 0 0 0 0 6v4H5v-4a3 3 0 0 0 0-6Z"/><path d="M13 8v8"/></svg></span>
                <span class="owner-mobile-hub-copy"><strong>RSVP &amp; access</strong><small id="owner-mobile-summary-access"></small></span>
                <span class="owner-mobile-hub-arrow" aria-hidden="true">›</span>
              </button>
              <button class="owner-mobile-hub-row" type="button" data-owner-mobile-view="guests" aria-controls="owner-panel-settings">
                <span class="owner-mobile-hub-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="9" cy="9" r="3"/><circle cx="17" cy="10" r="2"/><path d="M3.5 19c.5-3.3 2.3-5 5.5-5s5 1.7 5.5 5M14 15c3.8-.7 6 .7 6.5 4"/></svg></span>
                <span class="owner-mobile-hub-copy"><strong>Guest experience</strong><small id="owner-mobile-summary-guests"></small></span>
                <span class="owner-mobile-hub-arrow" aria-hidden="true">›</span>
              </button>
              <button class="owner-mobile-hub-row" type="button" data-owner-mobile-view="more" aria-controls="owner-panel-settings">
                <span class="owner-mobile-hub-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></span>
                <span class="owner-mobile-hub-copy"><strong>More tools</strong><small id="owner-mobile-summary-more">Manage guests, music, and advanced settings</small></span>
                <span class="owner-mobile-hub-arrow" aria-hidden="true">›</span>
              </button>
            </div>
          </section>

          <section class="owner-editor-panel" id="owner-panel-appearance" role="tabpanel" aria-labelledby="owner-tab-appearance" data-owner-panel="appearance">
            <div class="owner-section-intro"><h3>Appearance</h3><p>Try changes on the live page. They stay private until you save.</p></div>

            <fieldset class="owner-fit-field owner-presentation-field">
              <legend>Page style</legend>
              <div class="owner-segmented">
                <label><input type="radio" name="owner_presentation_mode" value="standard"><span>Standard</span></label>
                <label><input type="radio" name="owner_presentation_mode" value="flyer"><span>Flyer</span></label>
              </div>
              <small class="owner-field-help">Standard uses a cover image. Flyer centers your complete poster.</small>
            </fieldset>

            <div class="owner-image-card" id="owner-image-card" role="button" tabindex="0" aria-label="Upload a new event image">
              <img id="owner-image-preview" alt="Current event artwork">
              <span class="owner-image-empty" id="owner-image-empty">
                <b class="owner-image-plus" aria-hidden="true">+</b>
                <strong id="owner-image-empty-title">Add event image</strong>
                <small>Drop it here or choose a file</small>
              </span>
            </div>
            <input id="owner-image-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
            <div class="owner-image-actions">
              <button class="owner-action-button" id="owner-upload-image" type="button">Upload image</button>
              <button class="owner-action-button" id="owner-browse-photos" type="button">Browse free photos</button>
              <button class="owner-action-button owner-action-muted" id="owner-remove-image" type="button">Remove</button>
            </div>
            <p class="owner-inline-status" id="owner-upload-status" role="status"></p>

            <section class="owner-flyer-credit-fields" id="owner-flyer-credit-fields" aria-labelledby="owner-flyer-credit-title" hidden>
              <div class="owner-flyer-credit-heading">
                <h4 id="owner-flyer-credit-title">Who designed this flyer?</h4>
                <p>Give them a shoutout.</p>
              </div>
              <label class="owner-field"><span>Designer name <small>Optional</small></span><input class="owner-input" id="owner-flyer-designer-name" maxlength="120" autocomplete="name"></label>
              <label class="owner-field"><span>Instagram @handle <small>Optional</small></span><input class="owner-input" id="owner-flyer-designer-instagram" maxlength="500" autocomplete="off" placeholder="@artistname" aria-describedby="owner-flyer-designer-instagram-error"></label>
              <small class="owner-flyer-credit-error" id="owner-flyer-designer-instagram-error" role="status" aria-live="polite" hidden></small>
            </section>

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
                    <span>Match Photo</span>
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
            <div class="owner-field owner-location-picker">
              <label class="owner-field-label" for="owner-location-search">Location</label>
              <div class="owner-location-search-mode" id="owner-location-search-mode">
                <input class="owner-input" id="owner-location-search" autocomplete="off" aria-required="true" aria-describedby="owner-places-status" placeholder="Search venue or address">
                <button class="owner-location-mode-button" id="owner-location-manual-toggle" type="button">Enter manually</button>
              </div>
              <div class="owner-location-manual-mode" id="owner-location-manual-mode" hidden>
                <label for="owner-location-manual-address">Address</label>
                <div class="owner-location-manual-actions">
                  <input class="owner-input" id="owner-location-manual-address" autocomplete="street-address" placeholder="346 Corbett Ave, San Francisco">
                  <button class="owner-location-mode-button" id="owner-location-search-toggle" type="button">Search instead</button>
                </div>
              </div>
              <small class="owner-places-status" id="owner-places-status" role="status" aria-live="polite"></small>
              <div class="owner-location-selection" id="owner-location-selection" hidden>
                <span class="owner-location-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg></span>
                <span class="owner-location-copy"><strong id="owner-location-selection-name"></strong><small id="owner-location-selection-address"></small></span>
                <button class="owner-location-change" id="owner-location-change" type="button">Change</button>
              </div>
              <label class="owner-location-name-field" id="owner-location-name-field" for="owner-location-name" hidden>
                <span>Location name <small>Optional</small></span>
                <input class="owner-input" id="owner-location-name" maxlength="140" placeholder="Adrian’s place or Rooftop">
                <small>Add a friendly name for this address, or leave it blank.</small>
              </label>
            </div>
            <label class="owner-field"><span>Category</span>
              <select class="owner-input" id="owner-category">
                <option value="">Choose category</option><option>Music</option><option>Art</option><option>Market</option><option>Party</option><option>Community</option><option>Food &amp; Drink</option><option>Film</option><option>Other</option>
              </select>
            </label>
            <label class="owner-field"><span>Description <small>Optional</small></span><textarea class="owner-input owner-textarea" id="owner-description"></textarea></label>
          </section>

          <section class="owner-editor-panel" id="owner-panel-settings" role="tabpanel" aria-labelledby="owner-tab-settings" data-owner-panel="settings" hidden>
            <div class="owner-section-intro"><h3>Guest settings</h3><p>Control who can find the event and how guests participate.</p></div>
            <div class="owner-settings-group" data-owner-mobile-section="access">
              <fieldset class="owner-choice-field owner-admission-field">
                <legend>Admission</legend>
                <label class="owner-choice"><input type="radio" name="owner_admission" value="free_rsvp"><span><strong>Free RSVP</strong><small>Collect guest names and confirmations here.</small></span></label>
                <label class="owner-choice"><input type="radio" name="owner_admission" value="external_tickets"><span><strong>External tickets</strong><small>Send guests to another ticket link or sell at the door.</small></span></label>
                <label class="owner-choice"><input type="radio" name="owner_admission" value="silver_glider_tickets"${event.commerce_event_id ? '' : ' disabled'}><span><strong>Sell with Silver Glider</strong><small>${event.commerce_event_id ? 'Connected to Silver Glider Commerce.' : 'Coming soon'}</small></span></label>
              </fieldset>
              <div class="owner-admission-fields" id="owner-ticket-fields" hidden>
                <label class="owner-field"><span>Ticket price</span><input class="owner-input" id="owner-ticket-price" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="15"></label>
                <label class="owner-field"><span>Ticket link <small>Optional</small></span><input class="owner-input" id="owner-ticket-url" type="url" inputmode="url" placeholder="At the door, or paste https://..."></label>
              </div>
              <fieldset class="owner-choice-field">
                <legend>Visibility</legend>
                <label class="owner-choice"><input type="radio" name="owner_visibility" value="public"><span><strong>Public</strong><small>Visible on your Host Page and shareable.</small></span></label>
                <label class="owner-choice"><input type="radio" name="owner_visibility" value="private"><span><strong>Private link only</strong><small>Hidden from discovery. Anyone with the link can view it.</small></span></label>
              </fieldset>
              <p class="owner-secret-note" id="owner-secret-note" hidden>Secret Show is on. Disable it in Advanced settings before making this event public.</p>
              <label class="owner-field"><span>Capacity <small>Optional</small></span><input class="owner-input" id="owner-capacity" type="number" min="1" inputmode="numeric" placeholder="Unlimited"></label>
            </div>
            <div class="owner-settings-group" data-owner-mobile-section="guests">
              <div class="owner-switch-list">
                <label class="owner-switch-row"><span><strong>Show guest list</strong><small>Show attendee first names and avatars.</small></span><input id="owner-show-guests" type="checkbox" role="switch"><i aria-hidden="true"><b>On</b><b>Off</b></i></label>
                <label class="owner-switch-row"><span><strong>Allow +1s</strong><small>Let each RSVP bring one named guest.</small></span><input id="owner-allow-guests" type="checkbox" role="switch"><i aria-hidden="true"><b>On</b><b>Off</b></i></label>
                <label class="owner-switch-row"><span><strong>Enable comments</strong><small>Confirmed attendees can join the conversation.</small></span><input id="owner-comments" type="checkbox" role="switch"><i aria-hidden="true"><b>On</b><b>Off</b></i></label>
              </div>
              <div class="owner-rsvp-warning" id="owner-rsvp-warning" role="status" hidden></div>
            </div>
            <div class="owner-settings-group" data-owner-mobile-section="more">
              <p class="owner-mobile-more-copy">Jump to guest management or open the full advanced editor for music and additional options.</p>
              <div class="owner-editor-links">
                <a href="${esc(manageHref)}">Manage guests <span aria-hidden="true">→</span></a>
                <a href="${esc(advancedHref)}">Music &amp; advanced settings <span aria-hidden="true">→</span></a>
              </div>
            </div>
          </section>
        </div>

        <footer class="owner-editor-foot">
          <p id="owner-save-status" role="status">${event.status === 'draft' ? 'Ready to publish' : 'No unsaved changes'}</p>
          <div>
            <button class="owner-cancel" id="owner-editor-cancel" type="button">Cancel</button>
            <button class="owner-save" id="owner-editor-save" type="submit"${event.status === 'draft' ? '' : ' disabled'}>${event.status === 'draft' ? 'Publish event' : 'Save changes'}</button>
          </div>
        </footer>
      </form>
    </aside>
    <div class="owner-editor-toast" id="owner-editor-toast" role="status" aria-live="polite"></div>
    <script id="owner-event-data" type="application/json">${data}</script>
  </div>`;
}

module.exports = { renderOwnerEditor };
