# Changelog

Silver Glider Events uses semantic versioning. `package.json` is the source of truth, and each production release receives a matching Git tag.

## 1.0.64

Released September 9, 2026.

### Added

* Added **Invite previous guests** to upcoming-event management, with a past-event picker, searchable review list, individual recipient controls, a live send count, and responsive desktop/mobile presentation.
* Added artwork-led, one-way invitation emails with per-recipient retry and delivery tracking plus host-specific unsubscribe links.

### Privacy & reliability

* Restricted invitations to confirmed primary RSVPs who explicitly opted into future emails from that host; named guests, cancelled RSVPs, host opt-outs, existing target attendees, and already-notified recipients are excluded server-side.
* Prevented duplicate sends between previous-guest invitations and the existing follower announcement, and limited each target event to one previous-guest invitation batch.
* Clarified RSVP consent copy to say that guests may be invited to future events from that host and can unsubscribe at any time.

## 1.0.63

Released September 8, 2026.

### Added

* Added an explicit **Save & notify** or **Save without email** decision when a published event's date, start time, or location changes in either organizer editor.
* Added the same notify-or-skip choice when cancelling an event, with delivery to every confirmed primary RSVP email regardless of ordinary reminder preferences.
* Added one-way event-update and cancellation emails with secure attendee links, calendar update/cancellation attachments, transactional recipient snapshots, retry tracking, and delivery status on the event management page.

### Improved

* Added one shared accessible confirmation experience: a centered desktop modal and mobile bottom sheet that clearly summarizes each changed detail and guest count.
* Gave calendar attachments stable event IDs and version sequences so future updates and cancellations can be recognized by calendar clients, while preserving all existing photo-request and follower-notification reply behavior.

## 1.0.62

Released September 8, 2026.

### Fixed

* Made **Duplicate event** provide an immediate progress state, prevent repeat requests, open the new draft directly in the editor, and recover with a visible error instead of appearing unresponsive.
* Added focused regression coverage for the duplicate-event dashboard interaction while retaining the existing API coverage for Flyer credits and Commerce-safe copies.

## 1.0.61

Released September 7, 2026.

### Documentation

* Updated the master handoff to match the current owner editor, unified Location flow, Flyer credits, background effects, RSVP profile linking, responsive guest previews, migrations, and 146-test suite.

### Operations

* Restored the GitHub repository backup by synchronizing the accumulated `main` history and release tags after verifying authenticated repository access.

## 1.0.60

Released September 7, 2026.

### Improved

* Added first-name labels beneath attendee avatars when one to five people are going, keeping small event guest lists more personal.
* Preserved the compact overlapping avatar preview for six or more attendees, with responsive spacing and truncation across Standard and Flyer pages on desktop and mobile.

## 1.0.59

Released September 7, 2026.

### Fixed

* Made signed-in RSVP forms reuse the saved account name and email so new guest-list entries reliably inherit the account's RSVP photo.
* Added a secure event-specific repair for existing RSVPs using a verified matching email or the private attendee token already owned by that browser, without allowing email-only profile claims.

## 1.0.58

Released September 7, 2026.

### Fixed

* Made the published-event owner editor detect and save detail changes inserted by browser or system writing tools, while preserving its existing live preview and Save/Cancel behavior.
* Preserved intentional description line breaks and paragraph spacing in both live previews and published Standard and Flyer pages.

### Improved

* Increased description readability over event artwork and softened the date and essential RSVP fields into restrained translucent-gray surfaces.

## 1.0.57

Released September 7, 2026.

### Added

* Added optional flyer designer name and Instagram attribution to Flyer creation and the published-event owner editor, with immediate reversible preview and subtle linked credit on Flyer public pages.
* Preserved designer credit when duplicating Flyer events while keeping Standard pages, cards, and emails unchanged.

## 1.0.56

Released September 7, 2026.

### Improved

* Made **Liquid Stardust** and **Color Static** loop continuously with a smooth end-to-start crossfade on published pages and in the owner preview.
* Grouped the Halloween effects first, placed **Liquid Stardust** and **Color Static** beside **TV Static**, and kept **Match Photo** last in both event editors.

## 1.0.55

Released September 7, 2026.

### Added

* Added **Liquid Stardust** and **Color Static** as optimized moving backgrounds in both event editors, published Standard and Flyer pages, Host Page cards, and email-safe poster fallbacks.
* Kept **Halloween** first in the Effects picker and **Match Photo** last, with the two new effects placed directly after Halloween.

## 1.0.54

Released September 7, 2026.

### Improved

* Renamed the adaptive **Default wall** effect to **Match Photo**, placed **Halloween** first in the Effects picker, and moved **Match Photo** to the final position in both event editors.

## 1.0.53

Released September 5, 2026.

### Added

* Added one unified **Location** search for venues and normal addresses in the Create/Edit dashboard and published-event owner editor, with an optional friendly name for address-only locations and a clear manual-entry fallback.

### Improved

* Made location edits preview immediately on the published event page while remaining reversible until **Save changes**.
* Kept existing event storage, Maps links, calendar files, and RSVP emails compatible while preventing address-only locations from displaying the same address twice.

## 1.0.52

Released September 5, 2026.

### Added

* Added **Default wall** as an explicit adaptive background that derives a dark, readable palette from the event image and previews it in both event editors.

### Improved

* Made Show guest list, Allow +1s, and Enable comments preview their real event-page sections immediately for the host while remaining private and reversible until Save changes is selected.

## 1.0.51

Released September 5, 2026.

### Fixed

* Matched the on-page gradient swatches to the dashboard colors and made gradient selections preview immediately instead of being hidden by the artwork-derived page palette.

## 1.0.50

Released September 5, 2026.

### Improved

* Matched the on-page appearance editor to the dashboard’s full-image and fill-space preview behavior, including automatic portrait and landscape defaults for newly selected photos.
* Replaced the purple owner edit button with a neutral charcoal treatment that fits the rest of the platform while retaining teal interaction cues.

## 1.0.49

Released September 5, 2026.

### Fixed

* Added the dashboard’s Google Places venue suggestions to the quick on-page editor, including automatic address and location metadata updates with a manual-entry fallback.

## 1.0.48

Released September 5, 2026.

### Fixed

* Corrected the quick editor’s guest-setting switch labels so moving a switch right clearly reads On and moving it left reads Off.

## 1.0.47

Released September 5, 2026.

### Improved

* Removed the optional End time control from the streamlined on-page event editor without changing existing event times or the full dashboard editor.

## 1.0.46

Released September 5, 2026.

### Fixed

* Made video backgrounds and animated TV static start immediately in the owner’s live appearance preview, while pausing and unloading previews after another background is selected.
* Kept motion-reduction, data-saving, and autoplay-fallback behavior intact during live previews.

## 1.0.45

Released September 5, 2026.

### Added

* Added an owner-only **Edit event** control directly to published Standard and Flyer pages.
* Added a responsive live editor with a right-side desktop rail and collapsible mobile bottom sheet for appearance, event details, and guest settings.
* Added reversible image, background, detail, and setting previews with explicit Save and Cancel actions, protected organizer-only updates, and RSVP-sensitive change warnings.

## 1.0.44

Released September 4, 2026.

### Fixed

* Reduced curated photo collections from four simultaneous Unsplash searches to one tuned request per pill while keeping up to 24 results.
* Stopped photo search from firing automatically during typing so requests occur only from a category selection, Enter, or the Search button.

## 1.0.43

Released September 4, 2026.

### Improved

* Replaced the Public visibility megaphone with a clearer globe icon.
* Reworked Guest Experience and Secret Show checkboxes into explicit, keyboard-accessible On/Off switches without changing their saved behavior.
* Replaced the Summer photo collection with Halloween and added a separate Fall collection, each using focused multi-query image results.

## 1.0.42

Released September 4, 2026.

### Added

* Added Halloween and The Last Guest as the first two event background effects, with responsive video loops and optimized poster fallbacks.
* Added matching background previews to the event editor, Host Page cards, and RSVP emails.

### Accessibility

* Preserved static poster imagery for reduced-motion preferences, data-saving mode, autoplay failures, and email clients.

## 1.0.41

Released September 4, 2026.

### Improved

* Tuned the guest-list fallback mix so a 17-person list gives aliens, pumpkins, Bowie-style singers, ninjas, and sunglasses two appearances each without clustering any character more than twice.

## 1.0.40

Released September 4, 2026.

### Fixed

* Balanced guest-list fallback avatars so every character appears once before any emoji repeats, preventing seasonal characters from clustering.

## 1.0.39

Released September 4, 2026.

### Improved

* Replaced the levitating-suit fallback with ninja, ghost, and Bowie-style singer characters in the seasonal attendee pool.

## 1.0.38

Released September 4, 2026.

### Improved

* Added pumpkin, alien, zombie, and levitating-suit characters to the seasonal guest-list fallback pool.

## 1.0.37

Released September 4, 2026.

### Improved

* Replaced the nerd-face guest-list fallback with a cowboy face while preserving deterministic attendee avatars and uploaded profile photos.

## 1.0.36

Released September 4, 2026.

### Improved

* Restored the simple in-page attendee expansion on phones while keeping the focused attendee modal on desktop.
* Increased attendee portrait sizes in the compact preview, mobile list, and desktop modal.
* Preserved responsive breakpoint transitions, accessible expanded states, and overflow-safe layouts in Standard and Flyer presentations.

## 1.0.35

Released September 4, 2026.

### Improved

* Replaced the full inline attendee grid with a compact overlapping avatar preview and a clear See everyone action.
* Added a responsive attendee modal with larger faces and names directly underneath.
* Preserved keyboard navigation, focus return, backdrop and Escape closing, and mobile overflow safety.

## 1.0.34

Released September 4, 2026.

### Fixed

* Linked historical email-only RSVPs to the current authenticated account so a newly added RSVP photo appears on older guest lists.

### Safety

* Historical linking is account-scoped and requires the existing signed session or a newly verified magic link.
* The server accepts no browser-supplied account ID, never overwrites an existing RSVP link, and leaves different-email attendees unchanged.

## 1.0.33

Released September 4, 2026.

### Improved

* Replaced guest-list pills with larger circular attendee portraits and centered names underneath.
* Added a balanced wrapping grid for Standard and Flyer event pages so real profile photos remain visible on desktop and mobile.
* Kept longer first names tidy without stretching or overflowing the guest-list card.

## 1.0.32

Released September 4, 2026.

### Added

* Added an optional personal RSVP photo in Settings, with immediate upload, change, and removal controls.
* Added compact attendee photos to public guest lists, with deterministic smiley and glasses emoji fallbacks.

### Safety

* Kept personal RSVP photos separate from Host Page logos and header artwork.
* Bound profile-photo changes to the authenticated session instead of accepting a browser-supplied user ID.
* Linked an RSVP to an account only when its email matches the currently verified session, while preserving anonymous and email-only RSVPs.

## 1.0.31

Released September 3, 2026.

### Improved

* Made guest-list, +1, and comment controls available to both public and private events.
* Reorganized those controls into Guest experience and kept Secret Show Mode in contextual Private event options.
* Added a restrained Silver Glider teal hover and focus halo to editable event fields across mouse, keyboard, and mobile input.

### Safety

* Switching a Secret Show to Public now disables Secret Show Mode before save, while the server continues to reject Secret Show on public events.

## 1.0.30

Released September 3, 2026.

### Improved

* Replaced the compact visibility pills with descriptive Public and Private link-only cards.
* Added quiet megaphone and crossed-eye icons so the visibility choices are easier to distinguish at a glance.
* Preserved the Silver Glider selected state, mobile stacking, keyboard focus, and accessible pressed-state behavior.

## 1.0.29

Released September 3, 2026.

### Improved

* Separated Admission into its own focused event-editor section with Free RSVP, External tickets, and Sell with Silver Glider choices.
* Kept ticket fields directly connected to External tickets while preserving all existing admission behavior.
* Moved category, capacity, and visibility into a clearly labeled Event settings section.

## 1.0.28

Released September 3, 2026.

### Improved

* Replaced ambiguous ticket-launch language with the explicit Silver Glider Tickets product name before and after a host requests notification.
* Matched the Super Admin preview and launch-email subject to the same product wording.

## 1.0.27

Released September 3, 2026.

### Added

* Added a one-click Notify me action beneath the upcoming Silver Glider ticketing option for signed-in hosts.
* Added a separate, reversible ticketing-interest list that does not reuse RSVP, follower, or general marketing consent.
* Added a Super Admin Ticketing workspace with audience counts, a launch-email preview, and a private test-send action.
* Added an idempotent one-time launch sender that unlocks only after the Commerce integration is configured.

### Safety

* Repeated opt-ins create only one interest record, removed hosts are excluded, failed sends remain retryable, and delivered launch messages cannot be sent twice.
* No production launch email is sent automatically; the final send requires Commerce to be enabled and an explicit Super Admin confirmation.

## 1.0.26

Released September 3, 2026.

### Improved

* Moved Sell tickets with Silver Glider to the third admission position while the Commerce connection is being completed.
* Replaced the overly faded unavailable treatment with a clear Coming soon badge that remains readable on desktop and mobile.
* Automatically removes the Coming soon status when the Commerce feature is enabled.

## 1.0.25

Released September 3, 2026.

### Added

* Added three explicit admission choices: Free RSVP, Sell tickets with Silver Glider, and External tickets.
* Added an optional Commerce event reference and a feature-gated Commerce API boundary for the future Silver Glider Tickets integration.
* Added a stable Get Tickets handoff route for Silver Glider ticketed events.

### Safety

* Existing Free RSVP and external-ticket events retain their current behavior and data.
* Commerce remains the source of truth for prices, inventory, availability, checkout, orders, and issued tickets; none of that logic was duplicated in Events.
* The Silver Glider ticketing option remains unavailable until the Commerce API is explicitly configured, and an unavailable handoff fails safely without exposing an RSVP form.

## 1.0.24

Released September 1, 2026.

### Improved

* Restored the venue address field directly beneath Venue so address autofill remains visible during event setup.
* Kept admission, ticket fields, and public or private visibility permanently visible in the event editor.
* Limited progressive disclosure to genuinely optional host, description, and Event Vibe content.

## 1.0.23

Released September 1, 2026.

### Improved

* Replaced RSVP actions on past events with a focused event-photo action when a public recap is available.
* Prevented new RSVP submissions after an event date has passed.
* Increased secondary-text contrast and strengthened keyboard focus visibility across the shared design system.
* Simplified the event editor by keeping title, date, time, and venue visible while progressively disclosing optional event and audience settings.
* Preserved saved optional settings by reopening the relevant editor sections automatically when an existing event is edited.

## 1.0.22

Released September 1, 2026.

### Improved

* Preserved the complete event artwork on desktop past-event management pages instead of forcing poster-shaped images into a landscape crop.
* Added a quiet, accessible control for opening the original artwork at full size.
* Kept the guest list directly beneath the artwork and preserved the existing mobile layout.

## 1.0.21

Released September 1, 2026.

### Improved

* Moved the guest list beneath the event artwork on desktop past-event management pages.
* Grouped attendee and guest emails beneath their names for a cleaner compact table.
* Preserved the existing mobile layout and ordering.

## 1.0.20

Released August 31, 2026.

### Improved

* Changed the private-event attendance heading to past tense after the event date, such as “17 people went.”
* Preserved the existing “are going” wording for upcoming events and correct singular grammar.

## 1.0.19

Released August 31, 2026.

### Improved

* Renamed the public event recap heading from “From the night” to the clearer “Event photos.”

## 1.0.18

Released August 31, 2026.

### Added

* Added explicit guest consent for public photo featuring during Collect Photos uploads.
* Added host curation controls for featuring up to eight consented photos on a past event page.
* Added a responsive “From the night” recap gallery to Standard and Flyer event pages.

### Safety

* Existing uploads remain private and cannot be featured without new consent.
* Contributor names stay private and are never rendered in the public recap.
* Recaps appear only for published past events with Collect Photos enabled.

## 1.0.17

Released August 31, 2026.

### Improved

* Shortened Collect Photos sharing links to a 22-character, 128-bit secure token under `/p/`.
* Automatically issues a short link for photo collections enabled before this release.
* Preserved every existing long Collect Photos link for backward compatibility.

## 1.0.16

Released August 31, 2026.

### Added

* Added an event-scoped Collect Photos Beta for published past events, controlled by Super Admin.
* Added a private, no-account photo uploader with bounded Cloudinary uploads and an optional contributor name.
* Added a host-only photo inbox with download and delete actions.
* Added a one-time photo request for confirmed guests who opted into event updates.

### Safety

* Kept the feature disabled by default and isolated to the specific event where it is enabled.
* Kept uploaded photos private to the event host, with unguessable links, upload limits, rate limiting, and no public gallery.
* Left RSVP, capacity, ticketing, event pages, confirmations, and reminders unchanged.

## 1.0.15

Released August 24, 2026.

### Added

* Completed responsive skeleton loading across The Line, Hosts, Feedback, and Invitations admin views.

### Improved

* Kept admin filters and search unavailable until their data finishes loading.
* Added consistent retry states when an admin data request fails.

## 1.0.14

Released August 24, 2026.

### Added

* Added responsive skeleton loading to Edit Event and Settings.

### Improved

* Kept edit, save, profile, and account actions unavailable until authenticated data finishes loading.
* Added clear recovery states when an event editor or organizer settings request fails.

## 1.0.13

Released August 24, 2026.

### Added

* Added responsive skeleton loading to My Events, Event Management, and Following.
* Added a shared, reduced-motion-safe skeleton style across authenticated app views.

### Improved

* Kept Event Management actions unavailable until owned event data finishes loading.
* Added clear recovery states when events, followed hosts, or guest lists cannot load.

## 1.0.12

Released August 24, 2026.

### Changed

* Refreshed the public landing page with clearer product language.
* Made the dashboard empty state a direct Create Event link.
* Added dashboard skeleton loading for event and overview data.
* Added the application version to the production health response.

### Fixed

* Removed the misleading button treatment from the dashboard empty state by making the whole panel interactive.
