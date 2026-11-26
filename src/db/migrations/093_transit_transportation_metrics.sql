-- Extend the existing deduped ride aggregates. Capture only action kind,
-- never the destination, URL, route, IP address, or a raw guest identifier.
ALTER TABLE transit_ride_totals DROP CONSTRAINT transit_ride_totals_metric_check;
ALTER TABLE transit_ride_totals ADD CONSTRAINT transit_ride_totals_metric_check
  CHECK (metric IN ('page_open','route_selected','reminder_requested','reminder_sent',
    'email_link_open','text_link_open','repeat_open','bus_click','uber_click','lyft_click'));

ALTER TABLE transit_ride_samples DROP CONSTRAINT transit_ride_samples_metric_check;
ALTER TABLE transit_ride_samples ADD CONSTRAINT transit_ride_samples_metric_check
  CHECK (metric IN ('page_open','route_selected','reminder_requested','reminder_sent',
    'email_link_open','text_link_open','bus_click','uber_click','lyft_click'));

-- One bit on the existing expiring, unlinkable repeat row lets us count a
-- guest once across different shows without retaining the later event IDs.
ALTER TABLE transit_ride_repeat_subjects ADD COLUMN returned BOOLEAN NOT NULL DEFAULT false;
