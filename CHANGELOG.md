# Changelog

Silver Glider Events uses semantic versioning. `package.json` is the source of truth, and each production release receives a matching Git tag.

## 1.0.113

Released September 18, 2026. Built and deployed by Codex.

### Improved

* My Events now opens the explicitly linked Going or Hosting tab, remembers the person’s last manual choice, and keeps events on their calendar date instead of shifting them across days through UTC parsing.
* Signed-in phone pages move Feedback, Privacy, and Terms into the app menu where available, while focused creation and editing flows keep an accessible support footer. Feedback returns keyboard focus to the control that opened it.
* Standard phone event pages keep cover art within the viewport and add the event’s short date and time beside the docked RSVP action. Flyer presentation remains unchanged.
* The phone Manage Event hub now leads with attendance context and a direct Share event action. Past-event counts accurately describe guests who RSVP’d going.
* App icons and browser metadata now cover favicon, Apple touch, 192px, 512px, theme color, and install metadata across views.

### Reliability

* My Events ignores stale asynchronous responses after a tab change, and release checks now cover tab precedence, date boundaries, mobile support access, focus restoration, icon dimensions, and web-manifest behavior.

### Compatibility

* Desktop workspaces, Flyer layout, backend contracts, permissions, event and RSVP data, emails, reminders, and public-page viewport behavior remain unchanged. No database migration is required.

## 1.0.112

Released September 18, 2026. Built and deployed by Codex.

### Improved

* Phone browser Back and forward navigation now move naturally through Quick Create steps, advanced editor tasks, published-event editing, Manage Event areas, preview/photo selection, and Host Page Settings before leaving the workflow.
* Quick Create restores an unfinished form and the current step within the same browser session, then clears that recovery state after a successful event creation.
* Published-event editing now labels section completion **Review changes** and returns to the summary hub, where the final **Save changes** or **Publish event** action remains explicit.

### Accessibility and feedback

* Public event, RSVP confirmation, Host Page, photo, Maps, footer, and utility controls now maintain at least a 44px phone touch target without changing their visual hierarchy.
* Settings save success and error messages remain visible directly above the phone action dock and continue to announce through the existing live status region.

### Compatibility

* Desktop layouts, backend logic, permissions, event and RSVP data, uploaded assets, and email/reminder behavior are unchanged. No database migration is required.

## 1.0.111

Released September 18, 2026. Built and deployed by Codex.

### Improved

* Mobile organizer pages now share a calmer title hierarchy: compact 18px navigation, 28–30px page titles, 21px section/dialog titles, and 15px supporting copy. Repeated navigation titles, eyebrows, and page headings were removed across creation, editing, Settings, authentication, RSVP management, photo tools, and confirmation utilities.
* **Edit event** is now the first prominent action in the phone Manage Event hub. **More** is renamed **Event actions**, and its focused screen exposes Duplicate, Cancel, and Delete directly without a second disclosure.

### Accessibility and compatibility

* Focus moves into the active Event actions region, semantic headings remain available to assistive technology, and touch targets retain the established phone geometry. Public event and Flyer hero typography, desktop workspaces, backend behavior, permissions, and event data are unchanged.

## 1.0.110

Released September 17, 2026. Built and deployed by Codex.

### Improved

* Phone creation and editing now share a consistent 60px control system across Quick Create, the complete event editor, and the published-page owner editor. Date, time, location, Save, and Done controls retain matching geometry in iPhone Safari, including narrow and short viewports.
* Mobile labels and helper copy are more readable, event task cards use steadier proportions, and artwork controls stack cleanly so **Remove** never appears as a stranded half-width action.
* **Sell with Silver Glider** remains unavailable and labeled **Coming soon**, but its existing one-tap waitlist now lives in the same coherent card instead of appearing as a duplicate feature. Connected Commerce events and the existing waitlist endpoint, success state, and account-email behavior are unchanged.

### Compatibility

* The layout refinements stay below the established 880px mobile breakpoint. Desktop composition, event data, permissions, RSVP behavior, and ticketing backend logic are unchanged.

## 1.0.109

Released September 17, 2026. Built and deployed by Codex.

### Fixed

* Empty Date and Start Time controls in the phone Quick Create flow now retain the same 60px height as the Location field in iPhone Safari. The correction is isolated to phone-sized native date/time controls; desktop and event data flow are unchanged.

## 1.0.108

Released September 17, 2026. Built and deployed by Codex.

### Improved

* Phone-sized organizer surfaces now behave like a focused mobile app instead of a compressed desktop workspace. Quick Create uses three essential steps; Create/Edit, the live owner editor, event management, Settings, My Events, Following, Add Photo, and RSVP management use consistent full-screen hierarchy, large stacked choices, safe-area-aware actions, and thumb-friendly spacing.
* Admission, Visibility, and Capacity are separate decisions on phones. Visibility presents Public, Private link only, and Secret Show as peer choices; Secret Show clearly explains that it is private and protected by a six-character code while retaining the existing privacy and automatic-text restrictions.
* Appearance keeps flyer upload, designer credit, and effects in focused tasks. Event-management and host-page settings use summary hubs that open one area at a time, and small keyboard-open viewports retain usable form space and a reachable primary action.
* **Sell with Silver Glider** now offers the authenticated one-tap **Join the waitlist** action in both event editors. Success is confirmed in place with the host's account email, and a quiet leave action reverses the existing idempotent Commerce-interest record without making the event draft dirty.
* New drafts now receive an unguessable link from the start, so switching a draft to Private or Secret Show never leaves it with a readable public-style URL; directly published public events keep readable links.

### Accessibility and compatibility

* RSVP name and email labels are explicitly associated with their fields, mobile Feedback controls no longer cover settings or event-management actions, Admission and Visibility choices keep accessible group names, ticket-waitlist confirmations preserve keyboard focus, and toast notifications remain announced and clear of persistent actions.
* The mobile presentation remains scoped below 880px. Desktop keeps the established editor rail, multi-column workspaces, management layout, data flow, permissions, and backend behavior.

## 1.0.107

Released September 16, 2026. Built and deployed by Codex.

### Improved

* Create and Edit Event now use a phone-first task flow instead of compressing the complete desktop workspace into one long screen. Hosts move through focused Basics, Appearance, RSVP & access, Guest experience, Description & vibe, and Reminders views, with live summaries in a compact event hub.
* The published-page owner editor uses the same mobile pattern: quick-create drafts receive a short guided sequence, while returning hosts can jump directly between focused editing tasks and preview the public event before saving.
* Mobile validation opens the task containing the problem, focuses the existing field or alert, and keeps the original single submit control and server validation. Fixed headers, safe-area-aware actions, and keyboard-height handling keep navigation reachable on small screens.

### Compatibility and safety

* The redesign is scoped below the existing 880px breakpoint. Desktop retains its two-column create/edit workspace and 420px live-editor rail; tablet and guest-facing event layouts are unchanged.
* No event fields, permissions, RSVP behavior, authentication, email, reminder, ticketing, or messaging logic changed. Existing controls are reorganized on mobile rather than duplicated, and unsaved edits still require confirmation before closing.

## 1.0.106

Released September 16, 2026. Built and deployed by Codex.

### Fixed

* Create Event and the mobile live editor now render touch-focused inputs at 16px, preventing iPhone Safari from magnifying the page and clipping the form or primary action.
* Native date and time controls can shrink cleanly within their responsive grid without creating horizontal overflow.

### Accessibility and safety

* Pinch-to-zoom remains available; the fix does not use `maximum-scale` or `user-scalable` restrictions. Desktop input sizing and the existing four-field creation journey remain unchanged.
* This presentation-only release does not change authentication, events or guest data, RSVP, Follow Host, invitations, emails, reminders, ticketing, or messaging.

## 1.0.105

Released September 16, 2026. Built and deployed by Codex.

### Added

* **Create your event** now offers a mobile-first phone entry: Twilio Verify confirms the number, then a separate email code binds a new phone to the existing Silver Glider identity without passwords or duplicate accounts.
* A verified returning creator can use the same phone flow to open a normal 30-day session; the existing email sign-in remains available throughout and continues to be the recovery path.

### Safety

* Phone-first entry is limited to the high-intent creator journey. RSVP, Follow Host, invitation, photo, ticketing, and public browsing flows retain their current lightweight behavior.
* Authentication phones remain separate from RSVP and Follow text consent. Twilio Verify handles every authentication code, keeping login independent from lifecycle and marketing sender pools and their STOP state.
* Phone challenges are browser-bound, expiring, one-use, rate-limited, and recheck the active credential before issuing a session. Administrators remain email-only, identity collisions never auto-merge, and **Sign out of all devices** revokes phone sign-in.

## 1.0.104

Released September 16, 2026. Built and deployed by Codex.

### Improved

* The homepage now leads with the personality-forward promise **“You have a personality. Your events should too.”** in both the visible hero and browser title.

### Safety

* This copy-only release does not change event pages, host or guest data, authentication, invitations, confirmations, reminders, ticketing, or messaging behavior.

## 1.0.103

Released September 16, 2026. Built and deployed by Codex.

### Improved

* Sharing a Host Page Follow link keeps the native share sheet on touch devices and opens a consistent Silver Glider share menu on desktop with Email, Pinterest, Facebook, X, and Copy link.
* Desktop browsers no longer report that sharing is unavailable when their Web Share implementation cannot open the expected picker.

### Accessibility and safety

* The desktop menu is a labeled modal dialog with keyboard focus management, Escape and backdrop dismissal, large action targets, and focus restoration to the Share button.
* Every destination receives the same host-scoped Follow URL; Copy link retains a safe clipboard fallback and sharing does not change Follow, RSVP, or text consent.

## 1.0.102

Released September 16, 2026. Built and deployed by Codex.

### Added

* A Host Page now has one shareable **Follow** link. Following always includes new-event email updates; when that host owns texting credits, the same flow progressively offers a separate unchecked phone opt-in for text updates.
* The Host Page keeps the relationship visible as **Following · Email on** with either **Texts on** or **Add texts**, so text consent is not a disappearing one-time prompt.
* Public-event management now previews the exact eligible follower email audience, optional text audience, segment-based credit cost, and current balance before the host approves one standardized new-event update.

### Safety

* Email and SMS consent are stored separately with source, version, timestamp, and disclosure copy. Existing followers are not silently enrolled, phone numbers are normalized, and only currently consented followers can receive paid texts.
* Follower texts reuse the existing credit ledger, audited batches, delivery records, and Twilio STOP handling. Unfollowing suppresses both Follow updates and older RSVP-based host marketing.
* RSVP, Familiar Faces invitations, event-specific day-before reminders, pricing, ticketing, and existing automatic email re-invites are unchanged. There is no separate text-only signup link or bulk Familiar Faces text campaign.

## 1.0.101

Released September 16, 2026. Built and deployed by Codex.

### Improved

* RSVP confirmations and Familiar Faces invitations again inherit the event artwork's saved accent across the label, host identity, supporting links, confirmation state, and primary action.
* Older events and events using only a built-in atmosphere now receive a matching safe email accent instead of reverting to generic teal. Halloween and Sunset use warm orange, while the other available atmospheres use their corresponding accessible color family.

### Safety

* The simplified one-action confirmation email, personal RSVP link, dark email-safe layout, and contrast-aware button text remain unchanged. Stored artwork accents always take precedence over atmosphere fallbacks.

## 1.0.100

Released September 16, 2026. Built and deployed by Codex.

### Added

* A completed RSVP now opens an immediate confirmation dialog on desktop and a bottom sheet on mobile, without navigating away from the event. It shows the answer, event, host, date, time, location, personal calendar action, and an in-place answer editor.
* Reopening a personal RSVP or Familiar Faces invitation link with an existing answer opens the same confirmation experience on any device. Closing it returns to a compact **View RSVP** status card.

### Changed

* RSVP confirmation emails are now a lightweight backup: event artwork and identity remain, while one **View or change RSVP** action returns to the personal on-page confirmation instead of duplicating all event controls in email.

### Safety

* Fresh RSVP responses expose only that newly created RSVP's existing opaque manage token. Personal event responses use private, no-store caching and do not change account, host, ticketing, SMS, or RSVP identity rules.

## 1.0.99

Released September 15, 2026. Built and deployed by Codex.

### Improved

* Personal **Invite your people** links now recognize their recipient directly from the event-scoped URL token on any device, without depending on a remembered-browser cookie.
* A personal link with an existing RSVP opens in the guest's current **Going** or **Not going** state. An unanswered invitation keeps the existing lightweight Name + Email RSVP flow.
* Confirmation-email and SMS event links now carry their existing RSVP authorization into the event URL so the guest's answer remains visible across browsers.

### Safety

* Familiar Faces invitation tokens remain opaque, hashed at rest, event-scoped, and revocable. They no longer expire, and simply opening one never creates or changes an RSVP.
* Forwarded invitation links cannot attach a different submitted email to the original recipient's identity. Host authentication, global account sessions, RSVP management, comments, ticketing, and messaging behavior remain separate and unchanged.

## 1.0.98

Released September 15, 2026. Built and deployed by Codex.

### Added

* **My Events** now opens on a guest-focused **Going** view while preserving the complete organizer workspace under **Hosting**.
* Signed-in guests can select their own avatar on an event page to replace or remove their reusable RSVP photo. Other guests' avatars remain private and inert.

### Improved

* RSVP photos up to 20 MB are resized proportionally and optimized in the browser before the existing secure upload, with Cloudinary retaining the final avatar transformation.
* The confirmation-email photo flow now keeps the event in context, offers an immediate way back, and returns automatically after a successful upload. Skipping also returns to the event.

### Safety

* Event-aware photo return details are shown only when the authenticated identity owns an RSVP for that event. Email-only matches and arbitrary event query strings do not expose event details or grant edit access.
* Existing RSVP forms, confirmation behavior, Familiar Faces identity links, Host Pages, ticketing, SMS, and event data remain unchanged.

## 1.0.97

Released September 15, 2026. Built and deployed by Codex.

### Improved

* The empty Flyer artwork area is now a large, accessible upload target with a clear plus icon and **Add your flyer** guidance.
* Desktop hosts can drag and drop a flyer directly onto the artwork area. Clicking, tapping, and keyboard activation continue to use the existing protected image upload flow.

## 1.0.96

Released September 15, 2026. Built and deployed by Codex.

### Added

* New events now begin with four essentials—title, date, time, and location—then open immediately as an owner-only draft on the real event page.
* The live event editor now controls Standard or Flyer presentation and admission alongside appearance, essential details, visibility, and guest settings. Hosts can preview every change in context before saving or publishing.
* Draft owners get an explicit **Publish event** action. Draft pages remain private, unindexed, and unavailable to guests until that action succeeds.

### Changed

* **Edit** from event management and the legacy edit URL now reopen the live event editor. The full form remains available as **Music & advanced settings** for optional capabilities that have not yet moved into the live surface.
* The advanced form no longer uses the persistent Publish/Save dock. It keeps one ordinary end-of-form submit control, avoiding the mobile and short-desktop obstruction that the dock introduced.

### Safety

* Publishing revalidates the event inside a database transaction, including Flyer artwork, admission details, Commerce linkage, and Secret Show consistency. Existing published events, RSVPs, guest identities, emails, reminders, assets, and database schema are unchanged.

## 1.0.95

Released September 15, 2026. Built and deployed by Codex.

### Fixed

* On mobile, the persistent Publish/Save control now releases into normal document flow at the true end of the form. **Private event options** remain fully visible and tappable instead of being covered by the dock.
* Scrolling back into the form restores the sticky control, while the end state continues to clear the fixed **Feedback** bubble.

## 1.0.94

Released September 15, 2026. Built and deployed by Codex.

### Added

* Create and Edit Event now keep their existing single publish/save control reachable while hosts work through the form. The dock stays inside the Event Information column on large desktops and clears the fixed **Feedback** bubble on phones.
* The dock explains which four core details are still needed, then shifts to the primary treatment as soon as title, date, time, and the existing validated location are complete.

### Improved

* Short desktop windows and mobile keyboard-height layouts automatically return the dock to normal document flow so it cannot crowd essential fields.
* Incomplete submissions still use the browser and existing location validation, while Flyer artwork, Secret Show codes, admission details, and all publish behavior retain their existing safeguards.

## 1.0.93

Released September 15, 2026. Built and deployed by Codex.

### Fixed

* On phones, the fixed **Feedback** bubble no longer overlaps the Create Event cover-image actions. The page reserves mobile-only clearance beneath **Choose image** and **Browse free photos**, keeping both labels visible and both tap targets usable.

## 1.0.92

Released September 15, 2026. Built and deployed by Codex.

### Added

* Event Vibe artist photos can now be dropped directly onto a large upload area on desktop or selected normally on any device. The uploaded state shows an uncropped preview with clear **Replace** and **Remove** actions.

### Changed

* Event Vibe photos now show the complete image on public Standard and Flyer pages. Portrait and landscape photos share a consistent frame with a subtle blurred fill instead of being cropped.
* Artist name, photo, and music/video link controls use one consistent full-width vertical layout on desktop and mobile.
* Familiar Faces invitation emails now inherit the event artwork accent used by RSVP confirmations. Both event-focused emails lead with the event and place the quiet Silver Glider logo and name in the footer.

### Security & reliability

* Drag-and-drop files receive the same type, size, authenticated upload, managed-asset, and server validation as files selected through the picker. No RSVP, invitation, authentication, data, payment, or messaging behavior changed.

## 1.0.91

Released September 14, 2026. Built and deployed by Codex.

### Added

* **Event Vibe artist photos.** Each artist can now have a managed photo, a supported music/video link, or both. A photo sits above Spotify, SoundCloud, Bandcamp, and other audio embeds; for YouTube it becomes a poster that loads the video only after the guest presses play.
* Hosts can progressively add up to three artist entries. The second entry is revealed only after **Add another artist**, and **Add a third artist** appears only after the second entry is present.

### Changed

* Multi-artist Event Vibe tabs now switch the complete artist presentation—name, photo, and player—while keeping only one video or audio embed active at a time. Existing one- and two-link events retain their current presentation.

### Security & reliability

* Event Vibe photo uploads require organizer authentication, use the existing managed Cloudinary pipeline, and are validated as managed assets before being stored. The additive migration uses nullable columns and event duplication preserves all three artist entries.

## 1.0.90

Released September 14, 2026. Built by Claude Code (PR #6), reviewed and deployed by Codex.

### Fixed

* **Create your event** on the home page now lands in the event builder after sign-in instead of the dashboard. The flow is unchanged: it still goes through the normal sign-in screen, and already signed-in hosts go straight there.
* A bookmarked or typed `/events/123` (without `/manage`) now opens that event's manage page instead of showing "Cannot GET". Signed-out visitors still go to sign-in, and non-numeric addresses still 404.

### Changed

* The middle texting pack in Settings → Messaging is labeled **Most popular** instead of **Recommended**. Pricing and packs are unchanged.

## 1.0.89

Released September 10, 2026. Built and deployed by Codex.

### Added

* A returning RSVP guest can now follow a host without retyping their email. **Follow** offers **Continue as [name]**, sends the existing browser-bound verification code to the remembered email, and automatically completes the follow after the code is accepted.

### Changed

* Successfully typing the existing RSVP identity-verification code now establishes the normal 30-day Silver Glider account session in addition to the remembered guest session. The first RSVP remains the same lightweight **Name + Email → RSVP** flow with no verification step, and later authenticated follows and creator actions can be completed without another code while the session remains valid.

### Security

* The remembered-email Follow flow resolves the email from the signed guest-session cookie and resolves the host from its public slug; neither identity nor follow target is trusted from editable client data.
* Personal RSVP/invitation links, text-reminder links, and Add Photo access retain their event- or feature-limited scopes and do not create a global account session.

## 1.0.88

Released September 10, 2026. Built by Claude Code (PR #5), deployed by Codex.

### Fixed

* Opening **View event** from an RSVP confirmation email (or the manage link, or a text-reminder link) now shows the guest’s answer — **✓ You’re going** with **Change my answer** — instead of a plain RSVP button. The link proves that one RSVP, so it counts for that event only.
* “You’re already on the list” is no longer a dead end in a browser that doesn’t know the guest: it offers **Manage my RSVP here**, sends a 6-digit code, and after the code the page shows the RSVP and remembers the guest.
* **Not [name]? RSVP as yourself** also forgets a personal link’s access for that event, so a shared browser stops showing the last person’s RSVP.

## 1.0.87

Released September 10, 2026. Built by Claude Code (PR #4), deployed by Codex.

### Added

* **Invite your people.** On an upcoming event, Familiar Faces now shows everyone who RSVP’d to your past events as faces, right under the people already connected to the event. Each person appears once, labeled with where you know them from (“Birthday Bash” or “3 of your events”), regulars first. Tap faces to select, review “Invite N people to [event]?”, and send, without leaving the event.
* The Familiar Faces search box searches both grids at once (names and emails; emails are never shown on cards). A dropdown narrows the list to one past event. Large lists load 48 at a time with **Show more**.
* Named +1s appear as “[friend]’s +1” with a **Share link** button that copies the event link. They are never emailed, because they never gave you their email.

### Changed

* Replaces the one-time “Invite Familiar Faces” popup, which showed one past event at a time, pre-selected everyone, and could only be used once per event. The Promote panel’s **Invite Familiar Faces** row now jumps to the new section. You can invite more people any time.
* Nothing is pre-selected. Unsubscribed people are hidden with a count; people already RSVP’d, declined, or invited to this event are not offered again.
* On past events, cards that can’t be selected now say why (“Unsubscribed” or “No email”), and +1 cards say whose +1 they were.
* Sticky selection bars sit above the Feedback bubble, which used to cover their send button.

### Security & reliability

* Eligibility is rechecked on send: confirmed primary RSVPs from the host’s own past published events, never other hosts’ guests, never unsubscribed people or +1s. Each invitation still names the past event the person came to (one batch per source event). Reuses existing tables; no migration.

## 1.0.86

Released September 10, 2026. Built by Claude Code (PR #3), deployed by Codex.

### Added

* Guests are invited to host right after they RSVP: a quiet **Host your own event →** link on the RSVP success card, on the returning guest’s **✓ You’re going** card, and in the footer of RSVP confirmation emails (Standard and Flyer). It goes through sign-in straight to **Create Event**, and a remembered guest sees **Continue as [name]**, so there is nothing to retype.

## 1.0.85

Released September 10, 2026. Built by Claude Code (PRs #1 and #2), deployed by Codex.

### Added

* Every sign-in email now carries a 6-digit code next to the link. People can finish on the page where they asked (Luma-style), which fixes sign-ins that landed inside the Gmail or Instagram in-app browser; the link still works on any device. The code is in the subject line so it can be read from a notification.
* The Host Page follow modal accepts the same code.
* Returning guests who can’t prove an RSVP is theirs (a new device, or rejoining after cancelling) confirm with a 6-digit code inline on the event page, then their action completes. This replaces the “open your personal invitation or confirmation email” dead end.
* **Sign out of all devices** in Account settings.
* Hosts now see **Can’t make it** in Familiar Faces for guests who declined or cancelled.

### Changed

* An answered returning guest sees a clear status (**✓ You’re going** or **You can’t make it**) with **Change my answer**, instead of two buttons that looked the same before and after answering. The greeting no longer uses the 👋.
* **Not [name]? RSVP as yourself** now opens a blank RSVP form.
* “Already on the list” says truthfully whether the confirmation email was re-sent.
* The admin Hosts list shows people who signed in or host events; RSVP-only guest identities are counted separately.

### Security & reliability

* Opening a sign-in link shows a **Continue** page and never uses the link up, so email security scanners can no longer turn real sign-ins into “expired”. Already-signed-in people who open an old link go straight to the app.
* Sessions can be revoked server-side (`organizers.sessions_valid_after`). Signing out now also forgets the remembered guest, so a shared laptop stops greeting the last person.
* A personal invitation link verifies the guest for its own event only; a forwarded invitation can no longer act as that guest on other events.
* The **Add your photo** link in RSVP confirmations is photo-only. It previously signed the recipient in for 7 days, which exposed a host’s dashboard if they forwarded their own RSVP confirmation.
* Re-confirming a cancelled RSVP requires proof of the email before overwriting its name, phone, or text consent.
* Sign-in link tokens are stored hashed; codes are bound to the requesting browser and lock after five wrong tries; the Continue POST is protected against login CSRF.
* Rate limits key on the proxy-resolved client IP instead of the spoofable first `X-Forwarded-For` entry.
* Integration tests now wait for background confirmation emails before each database reset, fixing an intermittent deadlock that predates this release (first logged September 4).
* Migration `037_sign_in_codes_and_session_revocation.sql` is additive except for hashing stored link tokens (outstanding links keep working) and scoping verification of existing invitation-link guest sessions.

## 1.0.84

Released September 10, 2026.

### Added

* First-time RSVPs now quietly establish a reusable guest identity and secure returning-browser session without adding a signup step, password, or privileged account access.
* Recognized guests see a personalized **Hi [name] 👋** card on future event pages with polished one-tap **I’m going** and **I’m not going** choices instead of re-entering their name and email.
* Familiar Faces invitations now open through individual opaque links that recognize the intended guest while waiting for an explicit RSVP choice.
* Recognized guests who choose **Create an event** can continue as the same identity through the existing email magic-link verification flow.

### Security & reliability

* Stores only hashed guest-session and invitation tokens, scopes unverified browser sessions to RSVPs they created, masks remembered email addresses, and provides an explicit shared-device escape through **Not [name]?**.
* Keeps first-time RSVP fields, magic-link authentication, RSVP email behavior, SMS consent and pricing, Familiar Faces eligibility, ticketing, Stripe, and event privacy rules unchanged.

## 1.0.83

Released September 10, 2026.

### Changed

* Confirmed primary RSVPs can now be selected as Familiar Faces for a direct invitation to another published event without requiring the separate host-update opt-in.
* Renamed the upcoming-event action to **Invite Familiar Faces** and clarified that unsubscribed guests, named +1s, existing attendees, and already-invited recipients remain excluded.
* Reframed the optional RSVP email checkbox as broader host updates, keeping it independent from direct event invitations and from event-specific SMS consent.
* Direct invitation emails now explain which previous event connected the guest to the host and retain a host-specific unsubscribe action.

### Security & reliability

* Preserved server-side ownership checks, past/upcoming event boundaries, Secret Show exclusions, recipient caps, opt-outs, and per-destination recipient deduplication.
* Left all phone collection, SMS opt-in, STOP/HELP behavior, texting credits, Stripe, ticketing, RSVP mechanics, and named +1 handling unchanged.

## 1.0.82

Released September 10, 2026.

### Fixed

* Prevented Chrome's desktop native share popover from remaining stranded over a public event page when moving from **Share** to **Add to calendar**.
* Desktop **Share** now copies the event link directly, while touch devices keep native sharing and temporarily guard calendar navigation until the share sheet closes.

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
