(function (root) {
  const MAX_POSITION_AGE_MS = 90_000;
  const MAP_TRIP_WINDOW_MS = 5 * 60_000;
  const FALLBACK_DWELL_MS = 12_000;
  const modeledSpeedKmh = { TRAM: 65, BUS: 75, SUBURBAN: 120, REGIONAL_RAIL: 180 };
  const modeledLegs = new WeakMap();
  const routeTrips = new WeakMap();
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
          departure > now + MAP_TRIP_WINDOW_MS || arrival < now - MAP_TRIP_WINDOW_MS || departure > arrival) continue;

      const points = decodePolyline(segment.polyline);
      const leg = { departure, arrival, points, distances: pathDistances(points), from: segment.from, to: segment.to };
      for (const trip of segment.trips ?? []) {
        if (!trip.tripId || trip.cancelled) continue;
        if (!trips.has(trip.tripId)) {
          trips.set(trip.tripId, {
            tripId: trip.tripId,
            line: { name: trip.displayName || segment.mode, product: segment.mode },
            direction: segment.to?.name || '',
            fetchedAt: now,
            legs: []
          });
        }
        trips.get(trip.tripId).legs.push(leg);
      }
    }
    for (const trip of trips.values()) trip.legs.sort((a, b) => a.departure - b.departure);
    return trips;
  }

  function mergeMapTrips(previous, segments, now = Date.now()) {
    const fresh = mapTrips(segments, now);
    const cancelled = new Set();
    for (const segment of segments) {
      for (const trip of segment.trips ?? []) {
        if (trip.cancelled) cancelled.add(trip.tripId);
      }
    }
    for (const id of cancelled) fresh.delete(id);
    for (const [id, trip] of previous) {
      if (!fresh.has(id) && !cancelled.has(id) && now - trip.fetchedAt <= MAX_POSITION_AGE_MS) {
        fresh.set(id, trip);
      }
    }
    return fresh;
  }

  const operatorModes = { Tram: 'TRAM', CityBus: 'BUS', RegionalBus: 'BUS', IntercityBus: 'BUS', PlusBus: 'BUS',
    SuburbanRailway: 'SUBURBAN', Train: 'REGIONAL_RAIL' };
  const operatorName = value => String(value ?? '').toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]/gu, '');
  const operatorDirection = value => operatorName(String(value ?? '')
    .replace(/^Chemnitz,\s*/i, '').replace(/,\s*(?:Bahnhof|Bf\.?)\s*$/i, '').replace(/\bHbf\b/gi, 'Hauptbahnhof'));
  const operatorTime = value => Number(String(value ?? '').match(/^\/Date\((\d+)/)?.[1] ?? NaN);
  const chemnitzStationId = value => String(value ?? '').match(/(?:^|_)de:14511:(\d+)(?=[:_]|$)/i)?.[1];

  function vmsDepartures(data) {
    if (data?.Status?.Code !== 'Ok' || !Array.isArray(data.Departures)) return [];
    return data.Departures.flatMap(row => {
      const scheduled = operatorTime(row.ScheduledTime), predicted = operatorTime(row.RealTime);
      if (!row.LineName || !operatorModes[row.Mot] || !Number.isFinite(scheduled)) return [];
      const cancelled = row.State === 'Cancelled';
      return [{ id: row.Id, line: row.LineName, mode: operatorModes[row.Mot], direction: row.Direction,
        scheduled, predicted, platform: row.Platform?.Name, cancelled }];
    });
  }

  function vmsBoardEvents(events, official, stop, includeUnmatched = true) {
    if (!official.length) return events;
    const station = chemnitzStationId(stop.id);
    const key = row => JSON.stringify([station, row.id, row.line, row.direction, row.scheduled, row.platform]);
    const matches = events.map(event => {
      const place = event.place;
      if (event.arrivalOnly) return null;
      const line = operatorName(event.displayName || event.routeShortName);
      const direction = operatorDirection(event.headsign || event.tripTo?.name);
      const scheduled = Date.parse(place?.scheduledDeparture ?? place?.departure);
      const match = official.filter(row => operatorName(row.line) === line &&
        row.mode === event.mode && row.scheduled === scheduled &&
        direction && operatorDirection(row.direction) === direction);
      return match.length === 1 ? match[0] : null;
    });
    const counts = new Map();
    for (const row of matches) if (row) counts.set(row, (counts.get(row) ?? 0) + 1);
    const used = new Set();
    const platform = operatorName(stop.platformLabel ?? platformLabel({ track: stop.platform }));
    const horizons = new Map();
    for (const row of official) {
      const [first, last] = horizons.get(row.mode) ?? [Infinity, -Infinity];
      horizons.set(row.mode, [Math.min(first, row.scheduled), Math.max(last, row.scheduled)]);
    }
    const apply = (event, row) => {
      const observed = event.place.departureTimestampReason === 'OBSERVED';
      const forecast = Number.isFinite(row.predicted);
      return { ...event, operatorKey: key(row), tripCancelled: event.tripCancelled || row.cancelled,
        realTime: event.realTime || forecast, operatorForecast: forecast && !observed, place: {
          ...event.place, track: row.platform || event.place.track,
          ...(forecast && !observed ? { departure: new Date(row.predicted).toISOString(), departureTimestampReason: 'PREDICTED' } : {})
        } };
    };
    const result = events.flatMap((event, index) => {
      const row = matches[index];
      if (row && counts.get(row) === 1) {
        if (stop.platformOnly && platform && row.platform && platform !== operatorName(row.platform)) return [];
        used.add(key(row));
        return [apply(event, row)];
      }
      const [first, last] = horizons.get(event.mode) ?? [];
      const when = Date.parse(event.place?.scheduledDeparture ?? event.place?.departure);
      return stop.platformOnly || event.arrivalOnly || event.tripCancelled || event.cancelled ||
        !event.headsign && !event.tripTo?.name || !(when >= first && when <= last) ? [event] : [];
    });
    if (!includeUnmatched) return result;
    for (const row of official) {
      const id = key(row);
      if (used.has(id) || stop.platformOnly && (!platform || platform !== operatorName(row.platform))) continue;
      used.add(id);
      const scheduledDeparture = new Date(row.scheduled).toISOString();
      result.push(apply({ tripId: 'vms:' + id, operatorOnly: true, mode: row.mode,
        displayName: row.line, headsign: row.direction, place: {
          stopId: stop.id, departure: scheduledDeparture, scheduledDeparture, departureTimestampReason: 'NO_RT_DATA'
        } }, row));
    }
    return result;
  }

  function applyVmsMapTimes(segments, stations, now = Date.now()) {
    const corrections = new Map();
    const stationCorrections = new Map();
    const localModes = new Set(['TRAM', 'BUS', 'SUBURBAN', 'REGIONAL_RAIL']);
    for (const [stationId, rows] of stations) {
      for (const row of rows) {
        if (row.cancelled || !localModes.has(row.mode) || !Number.isFinite(row.predicted)) continue;
        const ids = new Set();
        for (const segment of segments) {
          if (segment.mode !== row.mode || chemnitzStationId(segment.from?.stopId) !== stationId ||
              Date.parse(segment.scheduledDeparture ?? segment.departure) !== row.scheduled) continue;
          for (const trip of segment.trips ?? []) {
            if (!trip.cancelled && operatorName(trip.displayName) === operatorName(row.line)) ids.add(trip.tripId);
          }
        }
        const competing = rows.filter(candidate => candidate.mode === row.mode && candidate.line === row.line &&
          candidate.scheduled === row.scheduled);
        if (ids.size !== 1 || competing.length !== 1) continue;
        const [id] = ids;
        if (!stationCorrections.has(id)) stationCorrections.set(id, new Map());
        stationCorrections.get(id).set(row.scheduled, row);
        if (!corrections.has(id) || Math.abs(corrections.get(id).predicted - now) > Math.abs(row.predicted - now)) {
          corrections.set(id, row);
        }
      }
    }
    const transitous = new Map();
    for (const segment of segments) {
      if (!segment.realTime || segment.cancelled || segment.mode !== 'TRAM') continue;
      const scheduled = Date.parse(segment.scheduledDeparture), predicted = Date.parse(segment.departure);
      if (!Number.isFinite(scheduled) || !Number.isFinite(predicted)) continue;
      for (const trip of segment.trips ?? []) {
        if (trip.cancelled || corrections.has(trip.tripId)) continue;
        const previous = transitous.get(trip.tripId);
        if (!previous || Math.abs(predicted - now) < Math.abs(previous.predicted - now)) {
          transitous.set(trip.tripId, { scheduled, predicted });
        }
      }
    }
    for (const [id, correction] of transitous) corrections.set(id, correction);
    if (!corrections.size) return segments;
    return segments.flatMap(segment => {
      if (segment.cancelled || !localModes.has(segment.mode)) return [segment];
      const unchanged = [], adjusted = [];
      for (const trip of segment.trips ?? []) {
        const departure = Date.parse(segment.scheduledDeparture ?? segment.departure);
        const arrival = Date.parse(segment.scheduledArrival ?? segment.arrival);
        const direct = stationCorrections.get(trip.tripId)?.get(departure);
        const correction = direct ?? (stationCorrections.has(trip.tripId) || !segment.realTime ? corrections.get(trip.tripId) : null);
        if (!correction || trip.cancelled || !Number.isFinite(departure) || !Number.isFinite(arrival)) {
          unchanged.push(trip);
          continue;
        }
        const delay = correction.predicted - correction.scheduled;
        adjusted.push({ ...segment, trips: [trip], realTime: true,
          departure: segment.from?.departureTimestampReason === 'OBSERVED' ? segment.departure : new Date(departure + delay).toISOString(),
          arrival: segment.to?.arrivalTimestampReason === 'OBSERVED' ? segment.arrival : new Date(arrival + delay).toISOString() });
      }
      return unchanged.length ? [{ ...segment, trips: unchanged }, ...adjusted] : adjusted;
    });
  }

  function dwellEnd(arrival, departure, nextArrival, observedDeparture) {
    if (observedDeparture || departure !== arrival || !(nextArrival > departure)) return departure;
    return departure + Math.min(FALLBACK_DWELL_MS, (nextArrival - departure) / 4);
  }

  function mapLegStart(leg, incoming) {
    if (!leg.from?.stopId || leg.from.stopId !== incoming?.to?.stopId ||
        leg.from.cancelled || incoming.to.cancelled) return leg.departure;
    return dwellEnd(incoming.arrival, leg.departure, leg.arrival, leg.from.departureTimestampReason === 'OBSERVED');
  }

  function estimatedPosition(trip, now = Date.now()) {
    const legs = positionLegs(trip);
    const next = legs.findIndex((leg, index) => mapLegStart(leg, legs[index - 1]) > now);
    const index = next < 0 ? legs.length - 1 : next - 1;
    const previous = legs[index];
    const upcoming = legs[next];
    if (!previous) return null;
    if (now >= previous.arrival) {
      const sameStop = upcoming && (previous.to?.stopId
        ? previous.to.stopId === upcoming.from?.stopId
        : previous.to?.name && previous.to.name === upcoming.from?.name);
      const knownDeparture = Date.parse(previous.to?.departure ?? previous.to?.scheduledDeparture);
      const holdUntil = knownDeparture > previous.arrival ? knownDeparture
        : previous.to?.departureTimestampReason === 'OBSERVED' ? previous.arrival : previous.arrival + FALLBACK_DWELL_MS;
      const noOutgoingHold = !upcoming && now < holdUntil;
      if ((sameStop || noOutgoingHold) && !previous.to?.cancelled && !upcoming?.from?.cancelled &&
          Number.isFinite(previous.to?.lat) && Number.isFinite(previous.to?.lon)) {
        return { lat: previous.to.lat, lng: previous.to.lon, from: previous.to, to: upcoming?.to, stopped: true,
          stoppedSince: previous.arrival, stoppedUntil: sameStop ? mapLegStart(upcoming, previous) : holdUntil };
      }
      return null;
    }
    const leg = previous;
    const { arrival, points, distances } = leg;
    const departure = mapLegStart(leg, legs[index - 1]);
    const length = distances.at(-1);
    if (!(length > 0) || arrival <= departure) return null;
    const target = (now - departure) / (arrival - departure) * length;
    const end = distances.findIndex(distance => distance > target);
    if (end < 1) return null;
    const fraction = (target - distances[end - 1]) / (distances[end] - distances[end - 1]);
    const [fromLat, fromLng] = points[end - 1];
    const [toLat, toLng] = points[end];
    return {
      lat: fromLat + fraction * (toLat - fromLat),
      lng: fromLng + fraction * (toLng - fromLng),
      from: leg.from, to: leg.to
    };
  }

  function positionLegs(trip) {
    const speed = modeledSpeedKmh[trip.line?.product];
    if (!speed) return trip.legs;
    if (modeledLegs.has(trip)) return modeledLegs.get(trip);
    const legs = [];
    for (const leg of trip.legs) {
      const previous = legs.at(-1);
      const contiguous = previous?.to?.stopId && previous.to.stopId === leg.from?.stopId;
      const observedDeparture = leg.from?.departureTimestampReason === 'OBSERVED';
      const observedArrival = leg.to?.arrivalTimestampReason === 'OBSERVED';
      const departure = contiguous && !observedDeparture && !observedArrival
        ? Math.max(leg.departure, previous.arrival) : leg.departure;
      const adjusted = { ...leg, departure };
      if (!observedArrival) {
        const meters = (leg.distances.at(-1) ?? 0) * 111195;
        const duration = meters / (speed / 3.6) * 1000;
        if (contiguous && !leg.from.cancelled && !previous.to.cancelled) {
          adjusted.departure = dwellEnd(previous.arrival, departure, Math.max(leg.arrival, departure + duration), observedDeparture);
        }
        adjusted.arrival = Math.max(leg.arrival, adjusted.departure + duration);
      }
      legs.push(adjusted);
    }
    modeledLegs.set(trip, legs);
    return legs;
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
        operatorForecast: item.operatorForecast === true,
        operatorKey: item.operatorKey,
        operatorOnly: item.operatorOnly === true,
        arrivalOnly,
        arrival: hasLiveTime(place.arrivalTimestampReason) ? place.arrival : (place.scheduledArrival ?? place.arrival),
        scheduledArrival: place.scheduledArrival,
        departure: place.departure,
        arrivalLive: hasLiveTime(place.arrivalTimestampReason),
        arrivalObserved: place.arrivalTimestampReason === 'OBSERVED',
        departureObserved: place.departureTimestampReason === 'OBSERVED',
        stopId: place.stopId,
        delay,
        arrivalDelay: hasLiveTime(place.arrivalTimestampReason)
          ? (Date.parse(place.arrival) - Date.parse(place.scheduledArrival)) / 1000 : NaN,
        platform: platformLabel(place),
        platformChanged,
        cancelled,
        skipped,
        alerts: place.alerts
      }];
    });
  }

  function stopStatus(dep, position, now) {
    const departure = Date.parse(dep.departure ?? (dep.arrivalOnly ? undefined : dep.when));
    if (dep.cancelled || dep.skipped || dep.departureObserved && departure <= now) return null;
    if (dep.stopId && position?.stopId === dep.stopId && position.stopped === true &&
        position.observedAt <= now && now - position.observedAt <= MAX_POSITION_AGE_MS) return 'confirmed';
    const arrival = Date.parse(dep.arrival);
    if (dep.arrivalObserved && arrival <= now && now - arrival <= 30_000) return 'arrived';
    return null;
  }

  function isPlannedDeparture(dep, now, today = berlinLocal(now).slice(0, 10)) {
    const departure = Date.parse(dep.when ?? dep.scheduledWhen);
    return Number.isFinite(departure) && departure > now &&
      (departure - now > 12 * 60 * 60_000 || berlinLocal(departure).slice(0, 10) > today);
  }

  function boardArrival(dep) {
    return dep.arrivalLive ? Date.parse(dep.arrival) : NaN;
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
    return { stops, points, projected, target, distances: pathDistances(points), mode: leg.mode };
  }

  function hasLiveTime(reason) {
    return ['OBSERVED', 'PREDICTED', 'PROPAGATED'].includes(reason);
  }

  function routeWithOperatorTime(route, event) {
    const target = route.stops[route.target];
    if (!event?.operatorForecast || !target || target.departureTimestampReason === 'OBSERVED') return route;
    const delta = Date.parse(event.when) - Date.parse(target.departure ?? target.scheduledDeparture);
    if (!Number.isFinite(delta) || delta === 0) return route;
    return { ...route, stops: route.stops.map(stop => {
      const adjusted = { ...stop };
      for (const [time, scheduled] of [['arrival', 'scheduledArrival'], ['departure', 'scheduledDeparture']]) {
        const value = Date.parse(stop[time] ?? stop[scheduled]);
        if (stop[time + 'TimestampReason'] !== 'OBSERVED' && Number.isFinite(value)) {
          adjusted[time] = new Date(value + delta).toISOString();
        }
      }
      return adjusted;
    }) };
  }

  function positionOnRoute(route, now) {
    let trip = routeTrips.get(route);
    if (!trip) {
      const { stops, points, projected } = route;
      const legs = [];
      let previous = -1;
      stops.forEach((stop, index) => {
        if (stop.cancelled) return;
        if (previous >= 0) {
          const from = stops[previous];
          const departure = Date.parse(from.departure ?? from.scheduledDeparture);
          const arrival = Date.parse(stop.arrival ?? stop.scheduledArrival);
          if (Number.isFinite(departure) && Number.isFinite(arrival)) {
            const section = points.slice(projected[previous], projected[index] + 1);
            legs.push({ departure, arrival, from, to: stop, points: section, distances: pathDistances(section) });
          }
        }
        previous = index;
      });
      trip = { legs, line: { product: route.mode } };
      routeTrips.set(route, trip);
    }
    const first = trip.legs[0];
    const arrival = Date.parse(first?.from.arrival ?? first?.from.scheduledArrival);
    if (first && arrival <= now && now < first.departure && Number.isFinite(first.from.lat) && Number.isFinite(first.from.lon)) {
      return { lat: first.from.lat, lng: first.from.lon, from: first.from, to: first.to,
        stopped: true, stoppedSince: arrival, stoppedUntil: first.departure };
    }
    return estimatedPosition(trip, now);
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

  const api = { berlinLocal, berlinInstant, nextBerlinDay, hasLiveTime, positionOnRoute, routeProgress, routeWithOperatorTime, remainingRoute, throughService, mapTrips, mergeMapTrips, vmsDepartures, vmsBoardEvents, applyVmsMapTimes, chemnitzStationId, estimatedPosition, platformLabel, departures, stopStatus, isPlannedDeparture, boardArrival, decodePolyline, vehiclePositions, MAX_POSITION_AGE_MS, MAP_TRIP_WINDOW_MS };
  if (typeof module === 'object') module.exports = api;
  else root.LiveTransit = api;
})(globalThis);
