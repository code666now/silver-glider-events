-- Initial launch gallery. Admin changes persist; this migration runs once.
INSERT INTO homepage_photos (title, alt_text, image_url, width, height, sort_order)
VALUES
  ('Weekly SF Show Alert', 'Weekly San Francisco Show Alert poster with a red telephone and pointing hand on black.', '/images/homepage-photography/weekly-sf-show-alert.webp', 541, 680, 0),
  ('Live stage projections', 'A live band plays beneath colorful projections and mirror balls.', '/images/homepage-photography/live-stage-projections.webp', 510, 680, 1),
  ('Halloween party friends', 'Friends in Halloween costumes pose together at a party.', '/images/homepage-photography/halloween-party-friends.webp', 605, 680, 2),
  ('Birthday cake', 'A birthday cake with lit candles glows in a dark room.', '/images/homepage-photography/birthday-cake.webp', 510, 680, 3),
  ('Disco ball', 'A disco ball reflects bright red, pink, teal and gold lights in a dark room.', '/images/homepage-photography/disco-ball.webp', 512, 680, 4),
  ('OWA Dansby flyer', 'Black concert flyer with red lettering for OWA and Dansby.', '/images/homepage-photography/owa-dansby-flyer.webp', 485, 680, 5),
  ('HQDR at Make-Out Room', 'Bright Make-Out Room poster for Hit Me Harold, HQDR and Boyfriend Sushi Town, with a guitar in flight.', '/images/homepage-photography/hqdr-make-out-room.webp', 440, 680, 6);
