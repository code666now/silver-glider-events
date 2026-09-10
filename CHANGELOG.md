# Changelog

Silver Glider Events uses semantic versioning. `package.json` is the source of truth, and each production release receives a matching Git tag.

## 1.0.81

Released September 10, 2026.

### Fixed

* Restored the Silver Glider logo on the landing page and the Calendar, Maps, Manage RSVP, and Music icons in transactional email by ensuring PNG assets are included in Railway uploads.
* Made production health checks fail when any critical logo or email icon is missing or invalid, preventing an otherwise healthy-looking deployment from silently shipping broken images again.

### Operations

* Rooted direct Railway uploads at this application directory so the unrelated parent workspace ignore rules cannot strip deployable images.

## 1.0.80

Released September 10, 2026.

### Changed

* Restored the existing playful attendee emoji palette as the Familiar Faces fallback until a guest adds a photo.
* Derives each fallback from the guest's server-side identity signal, so the emoji stays consistent across event pages and refreshes without exposing their email.
* Keeps verified uploaded photos first and initials only as a defensive fallback; invitation, RSVP, consent, CSV, and guest data behavior are unchanged.

## 1.0.79

Released September 10, 2026.

### Added

* Replaced the event-management guest table with **Familiar Faces**, showing reusable verified photos or fallback avatars, guest names, and only the honest `RSVP’d` and `Invited` states while preserving search and CSV export.
* Added a source-first invitation flow from an old event: select individual people or all eligible faces, choose one of the host’s upcoming events, review the audience, and send one artwork-led email with one **RSVP** action.
* Added a lightweight authenticated **Add your photo** page and an optional secondary photo prompt in RSVP confirmation emails when the guest does not already have a saved photo.

### Security & reliability

* Reuses the verified account behind magic-link sessions for photos across events, never exposes raw identity IDs, never attaches photos through unverified RSVP email alone, and makes photo links single-use.
* Rechecks host ownership, future-email consent, opt-outs, target RSVPs, and prior invitations at send time. Recipient-level database deduplication allows separate reviewed groups without emailing the same person twice for one event.
* Leaves RSVP requirements, public guest lists, CSV data, ticketing, Stripe, Twilio consent, SMS pricing, and reminder copy unchanged. The optional photo link stays email-only so it does not add paid SMS segments.

## 1.0.78

Released September 10, 2026.

### Added

* Added an off-by-default **Day-before reminder** setting to event creation and editing. When enabled, the public RSVP form offers a separate unchecked phone opt-in only for that event.
* Added a clear management state that shows the current opted-in guest count, estimated credit cost, available balance, and an **Add funds** path only when funds are actually needed.
* Added automatic 4 PM event-local fulfillment on the day before the event, with one private per-recipient link that restores the guest's existing event access without creating an account.

### Security & reliability

* Reserves the complete event reminder cost atomically before queueing, never partially sends an underfunded audience, rechecks current consent, deduplicates phone numbers, and prevents duplicate batches.
* Keeps all existing events opted out, excludes Secret Shows, expires one-tap links, preserves STOP handling and never-accepted-message refunds, and leaves email reminders, ticket commerce, Stripe pack pricing, and RSVP identity unchanged.

## 1.0.77

Released September 10, 2026.

### Changed

* Clarified the SMS-credit purchase copy around adding texting funds, reaching guests, and choosing a one-time text pack.
* Marked the existing middle SMS-credit pack as recommended without changing pack sizes, prices, checkout logic, or payment behavior.

## 1.0.76

Released September 10, 2026.

### Changed

* Replaced the embedded PayPal/Venmo SMS-credit modal with one direct handoff to Stripe-hosted Checkout while preserving the fixed 300/$20, 500/$35, and 1,000/$60 packs.
* Kept SMS-credit funds isolated through dedicated Stripe credentials and Price IDs; ticket commerce remains a separate service and source of truth.

### Security & reliability

* Creates Checkout Sessions only on the authenticated server, maps each pack to an allowlisted Stripe Price, and returns only a validated Stripe-hosted URL to the browser.
* Credits the existing host wallet only after a signature-verified `checkout.session.completed` webhook is re-fetched and confirmed paid, complete, correctly priced, and matched to its host purchase.
* Makes Stripe event and Checkout Session retries idempotent in the existing atomic SMS ledger. Historical PayPal records, refund handling, and rollback endpoints remain intact without appearing in the current UI.

## 1.0.75

Released September 9, 2026.

### Changed

* Added accessible, milestone-based percentage progress while PayPal and Venmo payment options initialize, then removes the loading treatment as soon as the buttons are ready.
* Updated the fixed server-priced SMS credit packs to 300 credits for $20, 500 credits for $35, and 1,000 credits for $60.

## 1.0.74

Released September 9, 2026.

### Changed

* Rebuilt Settings as three focused destinations for Account, Messaging, and Host page, with a persistent desktop rail and a compact mobile section index.
* Replaced nested dashboard cards with calm settings rows, hairline dividers, dirty-state actions, and a dedicated desktop account menu for Settings and sign out.
* Simplified SMS credit purchase into balance, pack selection with per-credit pricing, one Continue action, a focused PayPal or Venmo payment sheet, and a unified activity history.
* Reorganized Host page editing into Basics, Links, and Images while preserving separate RSVP-photo and Host-page artwork responsibilities.

### Reliability

* Added protected direct routes for every Settings destination, kept account-name edits isolated from Host page data, deferred the payment SDK until the payment sheet opens, and verified the redesign at phone, tablet, and desktop breakpoints.

## 1.0.73

Released September 9, 2026.

### Fixed

* Marked PayPal and Venmo SMS-credit purchases as no-shipping digital checkouts so neither wallet asks hosts for a delivery address.
* Bound the server-created order to the wallet selected in Host Settings while continuing to enforce fixed server-side pack pricing and automatic credit fulfillment.

## 1.0.72

Released September 9, 2026.

### Changed

* Hid the event-management SMS action when the current event has no confirmed SMS-opted-in RSVPs, removing an unusable zero-audience row without leaving a layout gap.
* Progressively reveals **Add text notification** after the first eligible subscriber and shows the current subscriber count, availability window, paid credit requirement, and review prompt.
* Keeps the action visible after a batch is created so hosts retain its queued, delivery, failure, and refund status.

## 1.0.71

Released September 9, 2026.

### Added

* Added the first paid host lifecycle SMS action: on the day before a published, non-Secret event, hosts can review an exact server-generated reminder, its opted-in recipients, segment count, credit cost, and remaining balance before explicitly confirming the send.
* Added queued Twilio Messaging Service delivery with per-recipient retries, status callbacks, delivery auditing, and platform-wide RSVP consent removal when a guest texts STOP.

### Security & reliability

* Required purchased host credits for every promoter send, reserved them atomically before delivery, prevented duplicate tomorrow batches, and provided no free allowance, admin bypass, audience override, or free-form message field.
* Rechecked consent immediately before each send, deduplicated shared phone numbers, refunded only requests Twilio never accepted, masked recipient numbers in the browser, and kept Twilio credentials and full destinations server-side.
* Added full PostgreSQL flow coverage and responsive desktop/mobile verification. The complete 185-test suite passes.

## 1.0.70

Released September 9, 2026.

### Changed

* Made the RSVP host-update permissions explicitly channel-specific: guests now choose independently between text updates and email invitations.
* Replaced the generic email invitation label with the actual host name and gave both unchecked consent choices the same clear heading-and-disclosure hierarchy in Standard and Flyer presentations.
* Kept the current-event email reminder separate and left all existing consent storage, audience eligibility, and sending behavior unchanged.

## 1.0.69

Released September 9, 2026.

### Added

* Added a separate, unchecked SMS consent choice beside the existing optional RSVP phone field in both Standard and Flyer presentations.
* Recorded normalized E.164 destinations with the consent timestamp, source, copy version, exact disclosure, and future opt-out state without broadening email or Follow Host permission.
* Added a read-only Text alerts audience preview to event management showing how many confirmed primary RSVPs are eligible for a future SMS send.

### Privacy & reliability

* Kept phone collection alone ineligible for SMS, required a valid phone only when SMS consent is selected, excluded cancelled and opted-out RSVPs, and added end-to-end database coverage plus responsive mobile/desktop QA. No SMS is sent and no credits are deducted in this release.

## 1.0.68

Released September 9, 2026.

### Fixed

* Completed approved PayPal and Venmo SMS-credit orders with PayPal's required JSON capture request so successful sandbox checkouts can credit the host wallet.
* Removed the tall-desktop sticky account card that could overlap the SMS-credit wallet while scrolling Settings.
* Added regression coverage for the capture request contract and non-overlapping Settings layout.

## 1.0.67

Released September 9, 2026.

### Fixed

* Restored the Settings page by correcting the PayPal loader syntax error that prevented its browser script from starting and left the loading skeleton visible.
* Added regression coverage that compiles every Settings inline script before release.

## 1.0.66

Released September 9, 2026.

### Added

* Added an admin-gated SMS credit wallet to Host Settings with fixed one-time packs of 300 credits for $20, 1,000 for $50, and 5,000 for $200.
* Added PayPal Checkout with eligible Venmo presentation, server-created and server-captured orders, host-owned balances, and recent credit activity.

### Security & reliability

* Kept pack pricing authoritative on the server, isolated SMS credit payments from ticket commerce, and made capture fulfillment atomic and idempotent.
* Added verified PayPal webhooks, an immutable transaction ledger, proportional refund and reversal handling, sanitized provider errors, checkout rate limits, and backward-compatible nullable/additive database storage.
* Kept sandbox checkout visible only to super-admins until the verified webhook is configured and a real sandbox purchase is approved for testing. The complete 173-test suite and responsive desktop/mobile QA pass.

## 1.0.65

Released September 9, 2026.

### Added

* Added the Go 1 server-side Twilio transport, sending through the configured Messaging Service without a hard-coded sender number and returning only the message SID, initial status, and normalized recipient.
* Added an admin-only, explicitly confirmed and rate-limited test endpoint that can send the fixed Silver Glider proof message to one supplied E.164 destination.

### Security & reliability

* Kept all Twilio credentials and message construction on the server, normalized common US phone formatting, required explicit country codes for international destinations, and sanitized provider errors before logging or returning them.
* Added mocked transport and live HTTP route coverage without introducing a promoter-facing composer, credit system, scheduled SMS, audience selection, database migration, or changes to RSVP and email behavior.

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
