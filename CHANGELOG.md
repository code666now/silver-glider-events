# Changelog

Silver Glider Events uses semantic versioning. `package.json` is the source of truth, and each production release receives a matching Git tag.

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
