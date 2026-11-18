const EventBackgrounds = require('../../public/js/event-backgrounds');

const ALWAYS_AVAILABLE_KEYS = Object.freeze(['adaptive', 'midnight', 'plaster']);
const UNAVAILABLE_MESSAGE = 'This background is no longer available. Choose another background and try again.';

function backgroundState(option, row) {
  const alwaysAvailable = ALWAYS_AVAILABLE_KEYS.includes(option.key);
  return { ...option, active: alwaysAvailable || row?.active === true, alwaysAvailable };
}

async function listBackgroundAvailability(db) {
  const { rows } = await db.query(
    'SELECT background_key, active FROM event_background_availability WHERE background_key=ANY($1::text[])',
    [EventBackgrounds.keys]
  );
  const byKey = new Map(rows.map(row => [row.background_key, row]));
  const backgrounds = EventBackgrounds.options.map(option => backgroundState(option, byKey.get(option.key)));
  return { backgrounds, activeKeys: backgrounds.filter(option => option.active).map(option => option.key) };
}

// Call inside the event write transaction. The share lock serializes a new
// selection against deactivation; unchanged saved choices never become invalid.
async function backgroundSelectionAllowed(db, key, currentKey = null) {
  if (!EventBackgrounds.keys.includes(key)) return false;
  if (key === currentKey || ALWAYS_AVAILABLE_KEYS.includes(key)) return true;
  const { rows } = await db.query(
    'SELECT active FROM event_background_availability WHERE background_key=$1 FOR SHARE', [key]
  );
  return rows[0]?.active === true;
}

module.exports = {
  ALWAYS_AVAILABLE_KEYS,
  UNAVAILABLE_MESSAGE,
  backgroundState,
  listBackgroundAvailability,
  backgroundSelectionAllowed
};
