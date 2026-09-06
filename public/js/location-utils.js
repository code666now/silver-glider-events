(function exposeLocationUtils(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SGLocation = api;
})(typeof window !== 'undefined' ? window : globalThis, function createLocationUtils() {
  'use strict';

  const BUSINESS_TYPES = new Set(['establishment', 'point_of_interest']);

  function clean(value) {
    return String(value || '').trim();
  }

  function normalizedText(value) {
    return clean(value)
      .toLocaleLowerCase('en-US')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function isAddressFallback(venueName, venueAddress) {
    const name = normalizedText(venueName);
    const address = normalizedText(venueAddress);
    if (!name || !address) return false;
    return name === address || address.startsWith(`${name} `);
  }

  function isAddressOnlyPlace(place) {
    const types = new Set((place?.types || []).map(type => String(type).toLowerCase()));
    return ![...BUSINESS_TYPES].some(type => types.has(type));
  }

  function addressFallback(address, placeName = '') {
    const name = clean(placeName);
    const fullAddress = clean(address);
    if (name && normalizedText(fullAddress).startsWith(normalizedText(name))) return name.slice(0, 140);
    return (fullAddress.split(',')[0] || fullAddress || name).trim().slice(0, 140);
  }

  function recordForPlace(place, { locationName = '' } = {}) {
    const address = clean(place?.formatted_address);
    const addressOnly = isAddressOnlyPlace(place);
    const suppliedName = clean(locationName);
    const placeName = clean(place?.name);
    return {
      addressOnly,
      venueAddress: address,
      venueName: addressOnly
        ? (suppliedName || addressFallback(address, placeName))
        : (placeName || suppliedName || addressFallback(address))
    };
  }

  function displayParts(venueName, venueAddress) {
    const name = clean(venueName);
    const address = clean(venueAddress);
    if (address && (!name || isAddressFallback(name, address))) {
      return { name: address, address: '' };
    }
    return { name: name || address, address: name ? address : '' };
  }

  function locationQuery(venueName, venueAddress) {
    const name = clean(venueName);
    const address = clean(venueAddress);
    if (!address) return name;
    if (!name || isAddressFallback(name, address)) return address;
    return `${name}, ${address}`;
  }

  return {
    addressFallback,
    clean,
    displayParts,
    isAddressFallback,
    isAddressOnlyPlace,
    locationQuery,
    normalizedText,
    recordForPlace
  };
});
