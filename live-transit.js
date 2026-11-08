(function (root) {
  const MAX_POSITION_AGE_MS = 90_000;
  const berlinClock = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });

  function berlinLocal(time) {
    const parts = Object.fromEntries(berlinClock.formatToParts(time).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  }

  function berlinInstant(local) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return NaN;
    const utc = Date.parse(local + 'Z');
    if (!Number.isFinite(utc)) return NaN;
    return [120, 60].map(minutes => utc - minutes * 60_000)
      .find(time => berlinLocal(time) === local) ?? NaN;
  }

  function nextBerlinDay(time) {
    const day = berlinLocal(time).slice(0, 10);
    const next = new Date(Date.parse(day + 'T00:00Z') + 86_400_000).toISOString().slice(0, 10);
    return { day, next, midnight: berlinInstant(next + 'T00:00') };
  }

  function pathDistances(points) {
    const distances = [0];
    for (let i = 1; i < points.length; i++) {
      const [lat, lng] = points[i];
      const [previousLat, previousLng] = points[i - 1];
      const longitudeScale = Math.cos((lat + previousLat) * Math.PI / 360);
      distances.push(distances[i - 1] + Math.hypot(lat - previousLat, (lng - previousLng) * longitudeScale));
    }
    return distances;
  }

  function mapTrips(segments, now = Date.now()) {
    const trips = new Map();
    for (const segment of segments) {
      const departure = Date.parse(segment.departure);
      const arrival = Date.parse(segment.arrival);
      if (segment.realTime !== true || segment.cancelled ||
          !Number.isFinite(departure) || !Number.isFinite(arrival) ||
          departure > now + 120_000 || arrival < now - 180_000 || departure > arrival) continue;

      const points = decodePolyline(segment.polyline);
      const distances = pathDistances(points);
      const leg = { departure, arrival, points, distances, from: segment.from, to: segment.to };
      for (const trip of segment.trips ?? []) {
        if (!trip.tripId || trip.cancelled) continue;
        if (!trips.has(trip.tripId)) {
          trips.set(trip.tripId, {
            tripId: trip.tripId,
            line: { name: trip.displayName || segment.mode, product: segment.mode },
            direction: segment.to?.name || '',
            legs: []
          });
        }
        trips.get(trip.tripId).legs.push(leg);
      }
    }
    for (const trip of trips.values()) trip.legs.sort((a, b) => a.departure - b.departure);
    return trips;
  }

  function estimatedPosition(trip, now = Date.now()) {
    const next = trip.legs.findIndex(leg => leg.departure > now);
    const index = next < 0 ? trip.legs.length - 1 : next - 1;
    const previous = trip.legs[index];
    const upcoming = trip.legs[next];
    if (!previous) return null;
    if (now >= previous.arrival) {
      const sameStop = upcoming && (previous.to?.stopId
        ? previous.to.stopId === upcoming.from?.stopId
        : previous.to?.name && previous.to.name === upcoming.from?.name);
      if (sameStop &&
          Number.isFinite(previous.to?.lat) && Number.isFinite(previous.to?.lon)) {
        return { lat: previous.to.lat, lng: previous.to.lon, from: previous.to, to: upcoming?.to, stopped: true };
      }
      return null;
    }
    const leg = previous;
    if (!leg.points.length) return null;
    const { arrival, points, distances } = leg;
    const departure = leg.departure;
    const progress = arrival > departure ? (now - departure) / (arrival - departure) : 0;
    const target = progress * distances.at(-1);
    if (!target) return { lat: points[0][0], lng: points[0][1], from: leg.from, to: leg.to };

    const end = distances.findIndex(distance => distance >= target);
    const fraction = (target - distances[end - 1]) / (distances[end] - distances[end - 1]);
    const [fromLat, fromLng] = points[end - 1];
    const [toLat, toLng] = points[end];
    return {
      lat: fromLat + fraction * (toLat - fromLat),
      lng: fromLng + fraction * (toLng - fromLng),
      from: leg.from, to: leg.to
    };
  }

  function platformLabel(...places) {
    const label = value => String(value ?? '').trim();
    const internal = /^(?:[TB][NSEW]|TW|TO|BW|BO)$/i;
    for (const place of places) {
      if (!place) continue;
      const track = label(place.track);
      if (track && !internal.test(track)) return track.replace(/^(?:Bahnsteig|Steig|Gleis|Gl\.)\s+/i, '');
      const description = label(place.description).match(/\b(?:Bahnsteig(?:\s+Gleis)?|Steig|Gleis|Gl\.)\s+(\d+[a-z]?)$/i);
      if (description) return description[1];
      const scheduled = label(place.scheduledTrack);
      if (scheduled && !internal.test(scheduled)) return scheduled.replace(/^(?:Bahnsteig|Steig|Gleis|Gl\.)\s+/i, '');
    }
    return '';
  }

  function departures(items, includeScheduled = false) {
    return items.flatMap(item => {
      const place = item.place ?? {};
      const cancelled = item.tripCancelled === true;
      const skipped = !cancelled && (item.cancelled === true || place.cancelled === true);
      const arrivalOnly = item.arrivalOnly === true;
      const eventTime = arrivalOnly ? place.arrival : place.departure;
      const scheduledTime = arrivalOnly ? place.scheduledArrival : place.scheduledDeparture;
      const reason = arrivalOnly ? place.arrivalTimestampReason : place.departureTimestampReason;
      const hasLiveDeparture = item.realTime === true && hasLiveTime(reason) && Number.isFinite(Date.parse(eventTime));
      const platformChanged = place.track && place.scheduledTrack && place.track !== place.scheduledTrack;
      const planned = includeScheduled && !cancelled && !skipped &&
        Number.isFinite(Date.parse(scheduledTime ?? eventTime));
      if (!item.tripId || !(cancelled || skipped || hasLiveDeparture || platformChanged || planned)) return [];
      const scheduledOnly = Boolean(planned && !hasLiveDeparture && !platformChanged);
      const when = hasLiveDeparture ? eventTime : scheduledTime ?? eventTime;
      const delay = hasLiveDeparture ? (Date.parse(when) - Date.parse(scheduledTime)) / 1000 : NaN;
      return [{
        tripId: item.tripId,
        line: { name: item.displayName || item.routeShortName || item.mode, product: item.mode },
        direction: item.headsign || item.tripTo?.name || '',
        when,
        scheduledWhen: scheduledTime,
        scheduledOnly,
        arrivalOnly,
        arrival: scheduledOnly ? (place.scheduledArrival ?? place.arrival) : place.arrival,
        firstStop: Boolean(place.stopId && item.tripFrom?.stopId === place.stopId),
        arrivalLive: !scheduledOnly && hasLiveTime(place.arrivalTimestampReason),
        arrivalObserved: place.arrivalTimestampReason === 'OBSERVED',
        departureObserved: place.departureTimestampReason === 'OBSERVED',
        stopId: place.stopId,
        delay,
        platform: platformLabel(place),
        platformChanged,
        cancelled,
        skipped,
        alerts: place.alerts
      }];
    });
  }

  function departureAtStop(dep, position, now) {
    if (dep.cancelled || dep.skipped || dep.arrivalOnly) return false;
    const atPlatform = position?.from?.stopId === dep.stopId && Boolean(dep.stopId);
    const departure = Date.parse(dep.when);
    const arrival = Date.parse(dep.arrival);
    if (dep.departureObserved && departure <= now) return false;
    if (position?.stopId === dep.stopId && position.observedAt && typeof position.stopped === 'boolean') return position.stopped;
    return Boolean(atPlatform && position.stopped && (!Number.isFinite(departure) || now < departure) ||
      !dep.scheduledOnly && dep.arrivalLive && arrival <= now && now < departure);
  }

  function confirmedAtStop(dep, position, now) {
    if (dep.cancelled || dep.skipped || dep.arrivalOnly || dep.departureObserved && Date.parse(dep.when) <= now) return false;
    if (position?.stopId === dep.stopId && position.observedAt && typeof position.stopped === 'boolean') return position.stopped;
    const arrival = Date.parse(dep.arrival);
    return Boolean(dep.arrivalObserved && arrival <= now && (departureAtStop(dep, position, now) ||
      now - arrival <= MAX_POSITION_AGE_MS && (!position || position.stopped && position.from?.stopId === dep.stopId)));
  }

  function isPlannedDeparture(dep, now, today = berlinLocal(now).slice(0, 10)) {
    const departure = Date.parse(dep.when ?? dep.scheduledWhen);
    return Number.isFinite(departure) && departure > now &&
      (departure - now > 12 * 60 * 60_000 || berlinLocal(departure).slice(0, 10) > today);
  }

  function boardArrival(dep, trip, position, now) {
    const approach = trip?.legs.find(leg => leg.to?.stopId === dep.stopId && leg.arrival >= now - 8000);
    const arrival = Date.parse(dep.arrival ?? dep.when);
    if (position && !position.stopped) return !dep.scheduledOnly && Number.isFinite(arrival) && (arrival >= now || !approach)
      ? arrival : approach?.arrival ?? arrival;
    if (dep.scheduledOnly || !position && dep.firstStop && !dep.arrivalLive) return NaN;
    if (position?.stopped) {
      const lastArrival = trip?.legs.findLast(leg => leg.to?.stopId === position.from?.stopId && leg.arrival <= now)?.arrival;
      const first = !lastArrival && trip?.legs[0]?.from?.stopId === position.from?.stopId;
      if (first || Number.isFinite(lastArrival) && now - lastArrival > 60_000) return NaN;
    }
    return arrival;
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

  function routeProgress(leg, targetId, targetTime) {
    const stops = leg.routeStops ?? [leg.from, ...(leg.intermediateStops ?? []), leg.to].filter(Boolean);
    const points = leg.routePoints ?? decodePolyline(leg.legGeometry?.points, leg.legGeometry?.precision);
    const matching = stops.map((stop, index) => ({ stop, index }))
      .filter(({ stop }) => targetId && (stop.stopId === targetId || stop.parentId === targetId));
    const target = matching.reduce((best, item) => {
      if (!best) return item;
      const difference = stop => Math.abs(Date.parse(stop.departure ?? stop.arrival) - targetTime);
      return difference(item.stop) < difference(best.stop) ? item : best;
    }, null)?.index ?? -1;
    const projected = [];
    let start = 0;
    for (const stop of stops) {
      let best = start;
      let distance = Infinity;
      for (let i = start; i < points.length; i++) {
        const d = (points[i][0] - stop.lat) ** 2 + (points[i][1] - stop.lon) ** 2;
        if (d < distance) {
          best = i;
          distance = d;
          if (d < 1e-11) break;
        }
      }
      projected.push(best);
      start = best;
    }
    return { stops, points, projected, target, distances: pathDistances(points) };
  }

  function hasLiveTime(reason) {
    return ['OBSERVED', 'PREDICTED', 'PROPAGATED'].includes(reason);
  }

  function positionOnRoute(route, now) {
    const { stops, points, projected } = route;
    let fromIndex = -1;
    for (let index = 0; index < stops.length; index++) {
      const stop = stops[index];
      if (stop.cancelled) continue;
      const arrival = Date.parse(stop.arrival);
      const departure = Date.parse(stop.departure);
      if (hasLiveTime(stop.arrivalTimestampReason) && hasLiveTime(stop.departureTimestampReason) &&
          arrival <= now && now < departure) {
        if (Number.isFinite(stop.lat) && Number.isFinite(stop.lon)) return {
          lat: stop.lat, lng: stop.lon, from: stop,
          to: stops.slice(index + 1).find(next => !next.cancelled), stopped: true
        };
      }
      if (fromIndex >= 0 && points.length) {
        const from = stops[fromIndex];
        const start = Date.parse(from.departure);
        if (hasLiveTime(from.departureTimestampReason) && hasLiveTime(stop.arrivalTimestampReason) &&
            start <= now && now < arrival) {
          const section = points.slice(projected[fromIndex], projected[index] + 1);
          const distances = pathDistances(section);
          return estimatedPosition({ legs: [{ departure: start, arrival, from, to: stop, points: section, distances }] }, now);
        }
      }
      fromIndex = index;
    }
    return null;
  }

  function remainingRoute(route, position, currentStop, minimumProgress = 0) {
    const { points, projected, distances, target } = route;
    if (!points.length || target < 0) return null;
    const limit = projected[target];
    if (currentStop >= target) return { points: [], meters: 0, progress: distances[limit] };
    if (!position) return null;
    const start = projected[Math.max(0, currentStop)];
    const next = route.stops.findIndex((stop, index) => index > currentStop && !stop.cancelled);
    const end = Math.min(limit, projected[next] ?? limit);
    let progress = distances[start];
    let best = Infinity;
    const scale = Math.cos(position.lat * Math.PI / 180);
    for (let i = start; i < end; i++) {
      const [lat, lng] = points[i];
      const dx = (points[i + 1][1] - lng) * scale;
      const dy = points[i + 1][0] - lat;
      const squared = dx * dx + dy * dy;
      if (!squared) continue;
      const x = (position.lng - lng) * scale;
      const y = position.lat - lat;
      const fraction = Math.min(1, Math.max(0, (x * dx + y * dy) / squared));
      const error = (x - dx * fraction) ** 2 + (y - dy * fraction) ** 2;
      if (error < best) {
        best = error;
        progress = distances[i] + fraction * (distances[i + 1] - distances[i]);
      }
    }
    progress = Math.min(distances[limit], Math.max(progress, minimumProgress));
    const meters = (distances[limit] - progress) * 111195;
    if (!meters) return { points: [], meters, progress };
    const after = distances.findIndex(distance => distance > progress);
    const a = points[after - 1];
    const b = points[after];
    const fraction = (progress - distances[after - 1]) / (distances[after] - distances[after - 1]);
    const onRoute = [a[0] + fraction * (b[0] - a[0]), a[1] + fraction * (b[1] - a[1])];
    return { points: [onRoute, ...points.slice(after, limit + 1)], meters, progress };
  }

  function throughService(legs, id) {
    const index = legs.findIndex(leg => leg.tripId === id);
    if (index < 0) return null;
    let first = index;
    let last = index;
    while (first > 0 && legs[first].interlineWithPreviousLeg) first--;
    while (last + 1 < legs.length && legs[last + 1].interlineWithPreviousLeg) last++;
    const service = legs.slice(first, last + 1);
    const base = legs[index];
    if (service.length === 1) return { ...base, service };
    const routeStops = [];
    const routePoints = [];
    for (const leg of service) {
      const points = decodePolyline(leg.legGeometry?.points, leg.legGeometry?.precision);
      routePoints.push(...points);
      const stops = [leg.from, ...(leg.intermediateStops ?? []), leg.to].filter(Boolean);
      const previous = routeStops.at(-1);
      const next = stops[0];
      if (previous?.stopId && previous.stopId === next?.stopId) {
        routeStops[routeStops.length - 1] = { ...previous, departure: next.departure,
          departureTimestampReason: next.departureTimestampReason,
          lineChange: leg.displayName || leg.routeShortName };
        stops.shift();
      } else if (next && previous) {
        stops[0] = { ...next, lineChange: leg.displayName || leg.routeShortName };
      }
      routeStops.push(...stops);
    }
    return { ...base, service, routeStops, routePoints, to: service.at(-1).to,
      realTime: service.some(leg => leg.realTime), cancelled: base.cancelled };
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
        positions.set(tripId, { lat, lng: lon, observedAt,
          ...(typeof item.stopped === 'boolean' && item.stopId
            ? { stopped: item.stopped, stopId: item.stopId } : {}) });
      }
    }
    return positions;
  }

  const api = { berlinLocal, berlinInstant, nextBerlinDay, hasLiveTime, positionOnRoute, routeProgress, remainingRoute, throughService, mapTrips, estimatedPosition, platformLabel, departures, departureAtStop, confirmedAtStop, isPlannedDeparture, boardArrival, decodePolyline, vehiclePositions, MAX_POSITION_AGE_MS };
  if (typeof module === 'object') module.exports = api;
  else root.LiveTransit = api;
})(globalThis);
