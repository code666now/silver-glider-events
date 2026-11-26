-- Keep historical redirect opens, but give a visible planner visit its own
-- aggregate so past email prefetches never enter the new report.
ALTER TABLE transit_ride_totals DROP CONSTRAINT transit_ride_totals_metric_check;
ALTER TABLE transit_ride_totals ADD CONSTRAINT transit_ride_totals_metric_check
  CHECK (metric IN ('page_open','route_selected','reminder_requested','reminder_sent',
    'email_link_open','email_planner_open','text_link_open','repeat_open','bus_click','uber_click','lyft_click'));

ALTER TABLE transit_ride_samples DROP CONSTRAINT transit_ride_samples_metric_check;
ALTER TABLE transit_ride_samples ADD CONSTRAINT transit_ride_samples_metric_check
  CHECK (metric IN ('page_open','route_selected','reminder_requested','reminder_sent',
    'email_link_open','email_planner_open','text_link_open','bus_click','uber_click','lyft_click'));
