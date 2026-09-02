# Changelog

Silver Glider Events uses semantic versioning. `package.json` is the source of truth, and each production release receives a matching Git tag.

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
