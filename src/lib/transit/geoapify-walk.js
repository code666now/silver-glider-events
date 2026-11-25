'use strict';

const ROUTE_MATRIX_URL = 'https://api.geoapify.com/v1/routematrix';
const GEOAPIFY_MAX_WALK_TARGETS = 40;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_SNAP_METERS = 60;
const GEOAPIFY_WALK_ATTRIBUTION = Object.freeze({
  label: 'Walking estimates powered by Geoapify',
  url: 'https://www.geoapify.com/',
  dataLabel: '© OpenStreetMap contributors',
  dataUrl: 'https://www.openstreetmap.org/copyright'
});

class GeoapifyWalkingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GeoapifyWalkingError';
    this.code = code;
  }
}

const badResponse = () => new GeoapifyWalkingError('GEOAPIFY_BAD_RESPONSE', 'Invalid walking matrix response.');

function isPoint(point) {
  return Number.isFinite(point?.lat) && Math.abs(point.lat) <= 90 &&
    Number.isFinite(point?.lon) && Math.abs(point.lon) <= 180;
}

function pointFromArray(coords) {
  if (!Array.isArray(coords) || coords.length !== 2) return null;
  const point = { lon: coords[0], lat: coords[1] };
  return isPoint(point) ? point : null;
}

function metersBetween(a, b) {
  const rad = Math.PI / 180;
  const halfArc = Math.sin((a.lat - b.lat) * rad / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((a.lon - b.lon) * rad / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, halfArc)));
}

function verifiedSnap(waypoint, input) {
  const echoed = pointFromArray(waypoint?.original_location);
  const snapped = pointFromArray(waypoint?.location);
  // A successful route can nevertheless start at a different street when a
  // pin snaps to a distant path. Do not use that time for a boarding cutoff.
  return Boolean(echoed && snapped && metersBetween(echoed, input) <= 2 && metersBetween(snapped, input) <= MAX_SNAP_METERS);
}

async function readBoundedJson(response) {
  const length = Number(response.headers.get('content-length'));
  if (!response.body || length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw badResponse();
  }
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw badResponse();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw badResponse();
  }
}

function extractWalks(data, origin, targets) {
  const matrix = data?.sources_to_targets;
  const row = matrix?.[0];
  if (!Array.isArray(matrix) || matrix.length !== 1 || !Array.isArray(row) || row.length !== targets.length ||
      !Array.isArray(data.sources) || data.sources.length !== 1 ||
      !Array.isArray(data.targets) || data.targets.length !== targets.length ||
      (data.mode !== undefined && data.mode !== 'walk')) throw badResponse();

  const sourceVerified = verifiedSnap(data.sources[0], origin);
  const seen = new Set();
  const walked = Array(targets.length).fill(null);
  for (const cell of row) {
    const index = cell?.target_index;
    if (cell?.source_index !== 0 || !Number.isInteger(index) || index < 0 || index >= targets.length || seen.has(index)) {
      throw badResponse();
    }
    seen.add(index);
    if (!sourceVerified || !verifiedSnap(data.targets[index], targets[index]) ||
        cell.fallback || cell.error || (cell.mode !== undefined && cell.mode !== 'walk') ||
        !Number.isFinite(cell.time) || cell.time <= 0 || cell.time > 86_400 ||
        !Number.isFinite(cell.distance) || cell.distance <= 0) continue;
    walked[index] = Math.ceil(cell.time);
  }
  return walked;
}

function createGeoapifyWalking({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const key = typeof env.GEOAPIFY_API_KEY === 'string' ? env.GEOAPIFY_API_KEY.trim() : '';
  return {
    configured: !!key,
    async matrix(origin, targets) {
      if (!isPoint(origin) || !Array.isArray(targets) || targets.length > GEOAPIFY_MAX_WALK_TARGETS ||
          Array.from(targets).some(point => !isPoint(point))) {
        throw new GeoapifyWalkingError('GEOAPIFY_INVALID_LOCATIONS', 'Invalid walking matrix locations.');
      }
      if (targets.length === 0) return [];
      if (!key) throw new GeoapifyWalkingError('GEOAPIFY_UNCONFIGURED', 'Walking matrix provider is not configured.');

      const url = new URL(ROUTE_MATRIX_URL);
      url.searchParams.set('apiKey', key);
      const waypoint = ({ lon, lat }) => ({ location: [lon, lat] });
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ mode: 'walk', sources: [waypoint(origin)], targets: targets.map(waypoint) }),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (response.status === 429) throw new GeoapifyWalkingError('GEOAPIFY_RATE_LIMITED', 'Walking matrix rate limit reached.');
          throw new GeoapifyWalkingError('GEOAPIFY_UNAVAILABLE', 'Walking matrix provider unavailable.');
        }
        return extractWalks(await readBoundedJson(response), origin, targets);
      } catch (error) {
        if (error instanceof GeoapifyWalkingError) throw error;
        // Upstream errors can include the authenticated URL or request body.
        throw new GeoapifyWalkingError('GEOAPIFY_UNAVAILABLE', 'Walking matrix provider unavailable.');
      }
    }
  };
}

module.exports = { createGeoapifyWalking, GEOAPIFY_MAX_WALK_TARGETS, GEOAPIFY_WALK_ATTRIBUTION };
