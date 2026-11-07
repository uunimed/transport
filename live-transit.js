(function (root) {
  const MAX_POSITION_AGE_MS = 90_000;

  function mapTrips(segments, now = Date.now()) {
    const trips = new Map();
    for (const segment of segments) {
      if (segment.realTime !== true || segment.cancelled ||
          Date.parse(segment.departure) > now || Date.parse(segment.arrival) < now) continue;
      for (const trip of segment.trips ?? []) {
        if (!trip.tripId || trip.cancelled) continue;
        trips.set(trip.tripId, {
          tripId: trip.tripId,
          line: { name: trip.displayName || segment.mode, product: segment.mode },
          direction: segment.to?.name || ''
        });
      }
    }
    return trips;
  }

  function departures(items) {
    return items.flatMap(item => {
      const place = item.place ?? {};
      const cancelled = item.tripCancelled === true;
      const skipped = !cancelled && (item.cancelled === true || place.cancelled === true);
      const hasLiveTime = item.realTime === true &&
        !['NO_RT_DATA', 'INCONSISTENT_RT'].includes(place.departureTimestampReason);
      const platformChanged = place.track && place.scheduledTrack && place.track !== place.scheduledTrack;
      if (!item.tripId || !(cancelled || skipped || hasLiveTime || platformChanged)) return [];
      const when = hasLiveTime ? place.departure : null;
      const delay = (Date.parse(when) - Date.parse(place.scheduledDeparture)) / 1000;
      return [{
        tripId: item.tripId,
        line: { name: item.displayName || item.routeShortName || item.mode, product: item.mode },
        direction: item.headsign || item.tripTo?.name || '',
        when,
        delay,
        platform: place.track,
        platformChanged,
        cancelled,
        skipped,
        alerts: place.alerts
      }];
    });
  }

  function decodePolyline(points, precision = 5) {
    if (typeof points !== 'string' || !Number.isInteger(precision) || precision < 0 || precision > 7) return [];
    const coords = [];
    const scale = 10 ** precision;
    let lat = 0, lng = 0, offset = 0;
    function delta() {
      let value = 0, shift = 0;
      while (offset < points.length && shift <= 30) {
        const byte = points.charCodeAt(offset++) - 63;
        if (byte < 0 || byte > 63) break;
        value += (byte & 31) * 2 ** shift;
        if (byte < 32) return value % 2 ? -(value + 1) / 2 : value / 2;
        shift += 5;
      }
      return NaN;
    }
    while (offset < points.length) {
      lat += delta();
      lng += delta();
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat / scale) > 90 || Math.abs(lng / scale) > 180) return [];
      coords.push([lat / scale, lng / scale]);
    }
    return coords;
  }

  function vehiclePositions(items, now = Date.now()) {
    const positions = new Map();
    for (const item of items) {
      const { tripId, lat, lon, timestamp } = item;
      const observedAt = Date.parse(timestamp);
      if (!tripId || !Number.isFinite(lat) || !Number.isFinite(lon) ||
          Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
          !Number.isFinite(observedAt) || observedAt > now || now - observedAt > MAX_POSITION_AGE_MS) continue;
      if (observedAt > (positions.get(tripId)?.observedAt ?? 0)) {
        positions.set(tripId, { lat, lng: lon, observedAt });
      }
    }
    return positions;
  }

  const api = { mapTrips, departures, decodePolyline, vehiclePositions, MAX_POSITION_AGE_MS };
  if (typeof module === 'object') module.exports = api;
  else root.LiveTransit = api;
})(globalThis);
