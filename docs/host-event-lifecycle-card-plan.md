# Host Event Lifecycle Card Plan

Status: Implemented in release 1.0.152 on September 30, 2026.

Photo collection is explicitly deferred and is not part of this milestone.

## Goal

Turn the host's event-management card into one lifecycle-aware assistant. It should help fill the room before the event, confirm what actually happened on event day, and help the host create the next event afterward.

The implementation should extend the existing event-management UI and actions. It must not create duplicate editors, sharing flows, reminder systems, photo galleries, or event-creation flows.

## Lifecycle states

### 1. Upcoming event, no audience yet

- Keep Share event link, Download QR code, and Invite Familiar Faces.
- If the host has no followers, show Copy and share your Host Page instead of an empty follower action.
- Explain that guests who request a text reminder will appear once they opt in.

### 2. Upcoming event, reminder ready

- Show the number of guests who requested a text reminder.
- Show the host's available credit balance and estimated reminder cost.
- Show the event-local send date.

### 3. Upcoming event, insufficient text credits

- Show the real number of text opt-ins.
- Offer one clear Add credits action.
- Explain that the existing free email reminder remains the fallback.

### 4. Upcoming event, follower outreach

- When followers exist, show Update N followers and reuse the existing follower-email flow.
- When no followers exist, show Copy and share your Host Page.

### 5. Event day

- Use the event's timezone to switch the status to Tonight.
- Replace the long promotion toolbox with Last call and the reminder delivery receipt.
- Reminder counts must come from actual sent message records, split by text and email. Do not display planned recipient counts as successful deliveries.

### 6. Day after / ended

- Show RSVP and new-follower results.
- Reuse the existing event creation flow for Plan your next event.
- Make the prior event's guests available through the existing Familiar Faces flow once the next event exists.

## Deferred roadmap: photo collection

Photo collection will remain in its existing Photos workspace for now. It must not be added to the lifecycle card in this milestone.

The current privacy and product rules to preserve for a later integration are:

- Collect Photos is an event-level beta flag that is off by default.
- A Super Admin can currently enable it only for an individual published past event.
- The host then gets a Photos workspace in event management.
- The host may copy a private upload link or send one photo-request email to confirmed RSVPs who opted into event updates.
- The guest upload page requires no account. It accepts up to five JPG, PNG, or WebP images per upload, with a 5 MB limit per image.
- Uploaded photos are private to the host by default.
- A guest must explicitly allow public featuring. The checkbox is not preselected.
- The host may review, download, delete, and feature eligible photos.
- At most eight consented photos may be featured on the public event page.
- Private photos must never be placed in a public gallery automatically.

When the beta has proven useful and no longer depends on per-event Super Admin enablement, consider one small conditional day-after row such as `7 photos received → Review`. Do not add a large gallery or multiple photo controls to the lifecycle card.

## Data and architecture

- Build one card shell with derived lifecycle states rather than separate screens.
- Calculate dates using the event timezone, including DST boundaries.
- Reuse existing RSVP, returning-guest, follower, SMS opt-in, credit, and message-log records.
- Use actual `message_log` sent records for reminder delivery counts.
- Keep canceled, draft, archived, missing-end-time, zero-RSVP, failed-delivery, and inactive-host states explicit.

## Verification

- Unit-test every lifecycle state and each boundary around the event-local day.
- Test zero/exact/insufficient credit balances.
- Test planned recipients versus actual successful text and email sends.
- Test every CTA using the existing destination flows.
- Visually verify mobile and desktop layouts, long event titles, empty data, loading, and error states.
- Confirm that the existing photo-collection behavior is unchanged.
- Run the complete existing test suite before deployment.
