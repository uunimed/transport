const journey = {
  from: null, to: null, options: [], selected: null, layer: null,
  visible: false, request: 0, watch: null, gps: null, gpsPassed: -1,
  rows: [], refreshed: new Map(), lastRefresh: 0, refreshing: false
};

function initializeJourneyPlanner() {
  setupStopPicker('journeyFrom', 'journeyFromOptions', stop => changeJourneyEndpoint('from', stop));
  setupStopPicker('journeyTo', 'journeyToOptions', stop => changeJourneyEndpoint('to', stop));
  document.getElementById('journeyForm').addEventListener('submit', findJourneys);
  setInterval(() => {
    if (!journey.visible || !journey.selected || document.hidden) return;
    updateJourneyProgress();
    refreshJourneyTrips();
  }, 1000);
}

function changeJourneyEndpoint(endpoint, stop) {
  journey[endpoint] = stop;
  journey.request++;
  journey.options = [];
  endJourneyTracking();
  document.getElementById('journeyResults').replaceChildren();
  document.getElementById('journeyStatus').textContent = '';
  document.getElementById('journeyForm').querySelector('button[type=submit]').disabled = false;
}

function setJourneyVisible(visible) {
  journey.visible = visible;
  if (!visible) {
    if (journey.layer && map?.hasLayer(journey.layer)) map.removeLayer(journey.layer);
    stopJourneyLocation();
  } else if (journey.selected) {
    if (journey.layer && !map.hasLayer(journey.layer)) journey.layer.addTo(map);
    startJourneyLocation();
    updateJourneyProgress();
  }
}

async function findJourneys(event) {
  event.preventDefault();
  const status = document.getElementById('journeyStatus');
  const { from, to } = journey;
  if (!from || !to) {
    status.textContent = 'აირჩიე ორივე გაჩერება ძიების სიიდან.';
    return;
  }
  if (from.id === to.id) {
    status.textContent = 'აირჩიე განსხვავებული საწყისი და სამიზნე გაჩერებები.';
    return;
  }
  endJourneyTracking();
  journey.options = [];
  const request = ++journey.request;
  const button = event.currentTarget.querySelector('button[type=submit]');
  const results = document.getElementById('journeyResults');
  button.disabled = true;
  results.replaceChildren();
  status.textContent = 'მარშრუტები იძებნება…';

  function endpoint(stop) {
    const { latitude, longitude } = stop.location;
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? `${latitude},${longitude}` : stop.id;
  }
  const query = new URLSearchParams({
    fromPlace: endpoint(from), toPlace: endpoint(to), numItineraries: '4', maxItineraries: '6',
    detailedTransfers: 'true', directModes: 'WALK'
  });
  const response = await safeFetchJSON(`${TRANSITOUS_BASE}/api/v5/plan?${query}`, 12_000);
  if (request !== journey.request) return;
  button.disabled = false;
  if (!response || !Array.isArray(response.itineraries)) {
    status.textContent = 'მარშრუტების წყარო ამჟამად მიუწვდომელია.';
    return;
  }
  journey.options = [...response.itineraries, ...(Array.isArray(response.direct) ? response.direct : [])]
    .filter(option => Array.isArray(option.legs) && option.legs.length && !option.legs.some(leg => leg.cancelled))
    .sort((a, b) => Date.parse(a.endTime) - Date.parse(b.endTime) || a.transfers - b.transfers)
    .slice(0, 7);
  status.textContent = journey.options.length ? '' : 'მარშრუტი ვერ მოიძებნა.';
  journey.options.forEach((option, index) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'journey-card';
    const lines = option.legs.map(leg => leg.tripId ? journeyLine(leg) : 'ფეხით');
    card.innerHTML = `<span class="flex justify-between gap-2 text-sm font-bold">
      <span>${journeyTime(option.startTime)} → ${journeyTime(option.endTime)}</span>
      <span>${journeyMinutes(option.duration)}</span>
    </span>
    <span class="text-xs">${escapeHTML(lines.filter((line, index) => line !== lines[index - 1]).join(' · '))}</span>
    <span class="journey-muted text-[11px]">${journeyTransfers(option.transfers)}${index === 0 ? ' · ყველაზე ადრე მისვლა' : ''}</span>`;
    card.addEventListener('click', () => selectJourney(option));
    results.append(card);
  });
}

function journeyTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? displayTime.format(time) : '—';
}

function journeyMinutes(seconds) {
  return Number.isFinite(seconds) ? `${Math.max(0, Math.ceil(seconds / 60))} წთ` : '—';
}

function journeyTransfers(count) {
  return count > 0 ? `${count} გადაჯდომა` : 'გადაჯდომის გარეშე';
}

function journeyLine(leg) {
  return getLineStyle(leg.displayName || leg.routeShortName || leg.mode, leg.mode).formattedLabel;
}

function selectJourney(option) {
  endJourneyTracking();
  journey.selected = option;
  journey.layer = L.layerGroup().addTo(map);
  journey.lastRefresh = 0;
  document.getElementById('journeyResults').classList.add('hidden');
  document.getElementById('journeyForm').classList.add('hidden');
  renderSelectedJourney(true);
  startJourneyLocation();
  refreshJourneyTrips();
}

function endJourneyTracking() {
  stopJourneyLocation();
  if (journey.layer && map?.hasLayer(journey.layer)) map.removeLayer(journey.layer);
  journey.layer = null;
  journey.selected = null;
  journey.gps = null;
  journey.gpsPassed = -1;
  journey.rows = [];
  journey.refreshed.clear();
  journey.refreshing = false;
  document.getElementById('journeyDetails').classList.add('hidden');
  document.getElementById('journeyResults').classList.remove('hidden');
  document.getElementById('journeyForm').classList.remove('hidden');
}

function journeyPlaceName(place) {
  if (place?.name === 'START') return journey.from.name;
  if (place?.name === 'END') return journey.to.name;
  return place?.name || 'გაჩერება';
}

function journeyStops(leg) {
  const original = [leg.from, ...(leg.intermediateStops ?? []), leg.to].filter(Boolean);
  const live = journey.refreshed.get(leg.tripId);
  if (!live || live.cancelled) return original;
  const all = [live.from, ...(live.intermediateStops ?? []), live.to].filter(Boolean);
  const start = all.findIndex(stop => leg.from?.stopId && stop.stopId === leg.from.stopId);
  const end = all.findIndex((stop, index) => index > start && leg.to?.stopId && stop.stopId === leg.to.stopId);
  return start >= 0 && end > start ? all.slice(start, end + 1) : original;
}

function journeyLegGeometry(leg, stops) {
  const live = journey.refreshed.get(leg.tripId);
  if (live && !live.cancelled && stops.length > 1 && stops[0] !== leg.from) {
    const route = LiveTransit.routeProgress(live, stops.at(-1).stopId, Date.parse(stops.at(-1).arrival));
    const from = route.stops.indexOf(stops[0]);
    const to = route.stops.indexOf(stops.at(-1));
    if (from >= 0 && to > from) {
      const updated = route.points.slice(route.projected[from], route.projected[to] + 1);
      if (updated.length > 1) return updated;
    }
  }
  const coords = LiveTransit.decodePolyline(leg.legGeometry?.points, leg.legGeometry?.precision);
  return coords.length > 1 ? coords : stops.filter(stop => Number.isFinite(stop.lat) && Number.isFinite(stop.lon))
    .map(stop => [stop.lat, stop.lon]);
}

function renderSelectedJourney(fit = false) {
  const option = journey.selected;
  if (!option) return;
  const details = document.getElementById('journeyDetails');
  details.classList.remove('hidden');
  journey.layer.clearLayers();
  const bounds = L.latLngBounds();
  const rows = [];
  let previousTransit = null;
  let walkingBetween = 0;
  const legs = option.legs.map(leg => {
    const transit = Boolean(leg.tripId);
    const stops = journeyStops(leg);
    const live = journey.refreshed.get(leg.tripId);
    const cancelled = leg.cancelled || live?.cancelled || stops[0]?.cancelled || stops.at(-1)?.cancelled;
    const style = transit ? getLineStyle(leg.displayName || leg.mode, leg.mode) : null;
    const color = style?.bg ?? '#64748b';
    const geometry = journeyLegGeometry(leg, stops);
    if (geometry.length > 1) {
      L.polyline(geometry, { color: cancelled ? '#e05267' : color, weight: transit ? 6 : 4,
        opacity: .9, dashArray: transit && !cancelled ? null : '5 8' }).addTo(journey.layer);
      bounds.extend(geometry);
    }
    let start = stops[0]?.departure ?? leg.startTime;
    let end = stops.at(-1)?.arrival ?? leg.endTime;
    const walkingDelay = !transit && previousTransit
      ? Math.max(0, Date.parse(previousTransit.end) - Date.parse(start)) : 0;
    if (walkingDelay) {
      start = new Date(Date.parse(start) + walkingDelay).toISOString();
      end = new Date(Date.parse(end) + walkingDelay).toISOString();
    }
    let transfer = '';
    if (transit && previousTransit) {
      const seconds = (Date.parse(start) - Date.parse(previousTransit.end)) / 1000;
      const missed = seconds < walkingBetween;
      transfer = `<p class="journey-transfer">${missed ? 'გადაჯდომისთვის დრო შეიძლება არ ეყოს' :
        `გადაჯდომა · ${journeyMinutes(seconds)}${walkingBetween ? ` · ფეხით ${journeyMinutes(walkingBetween)}` : ''}`}</p>`;
    }
    if (transit) {
      previousTransit = { end };
      walkingBetween = 0;
    } else if (previousTransit) walkingBetween += Number(leg.duration) || 0;
    const timeline = stops.map((stop, index) => {
      const time = index === 0 ? start
        : index === stops.length - 1 ? end : (stop.arrival ?? stop.departure);
      const row = rows.length;
      rows.push({ time: Date.parse(time), lat: stop.lat, lon: stop.lon, skipped: Boolean(stop.cancelled || cancelled) });
      return `<li class="journey-step" data-journey-step="${row}">
        <div class="flex justify-between gap-2">
          <span>${escapeHTML(journeyPlaceName(stop))}</span>
          <time class="shrink-0">${stop.cancelled ? 'გამოტოვებულია' : journeyTime(time)}</time>
        </div>
        ${stop.track ? `<small class="journey-muted">ბაქანი ${escapeHTML(stop.track)}</small>` : ''}
      </li>`;
    }).join('');
    return `${transfer}<article class="journey-leg">
      <div class="flex justify-between gap-2 text-xs font-bold">
        <span style="--line-color:${color}" class="journey-leg-label">${style?.svg ?? ''} ${transit ? escapeHTML(journeyLine(leg)) : 'ფეხით'}</span>
        <span>${journeyTime(start)} → ${journeyTime(end)}</span>
      </div>
      ${cancelled ? '<p class="departure-chip error">მონაკვეთი გაუქმებულია ან გაჩერება გამოტოვებულია. ხელახლა მოძებნე მგზავრობა.</p>' : ''}
      ${transit && leg.headsign ? `<p class="journey-muted text-[11px]">${escapeHTML(leg.headsign)}</p>` : ''}
      ${renderAlerts(live?.alerts ?? leg.alerts)}
      <ol class="journey-stops mt-2 text-xs">${timeline}</ol>
    </article>`;
  }).join('');
  const previous = journey.rows[journey.gpsPassed];
  if (previous) {
    journey.gpsPassed = rows.findLastIndex(row => !row.skipped &&
      (row.lat === previous.lat && row.lon === previous.lon && Math.abs(row.time - previous.time) < 300_000));
  }
  journey.rows = rows;
  const departure = rows[0]?.time;
  const arrival = rows.at(-1)?.time;
  details.innerHTML = `<div class="journey-detail-header space-y-2">
    <div class="flex justify-between gap-2">
      <button type="button" class="journey-secondary" onclick="endJourneyTracking()">← ვარიანტები</button>
      <button type="button" class="journey-secondary" onclick="showJourneyLocation()">ჩემი მდებარეობა</button>
    </div>
    <p class="text-sm font-bold">${escapeHTML(journey.from.name)} → ${escapeHTML(journey.to.name)}</p>
    <p class="text-xs">${journeyTime(Number.isFinite(departure) ? new Date(departure).toISOString() : option.startTime)}
      → ${journeyTime(Number.isFinite(arrival) ? new Date(arrival).toISOString() : option.endTime)}
      · ${journeyMinutes((arrival - departure) / 1000)} · ${journeyTransfers(option.transfers)}</p>
    <p id="journeyProgressStatus" class="journey-muted text-[11px]"></p>
  </div>${legs}`;
  updateJourneyProgress();
  if (fit && bounds.isValid()) map.fitBounds(bounds, { padding: [45, 45], maxZoom: 16 });
}

function stopJourneyLocation() {
  if (journey.watch === null) return;
  navigator.geolocation.clearWatch(journey.watch);
  journey.watch = null;
}

function startJourneyLocation() {
  if (journey.watch !== null || !navigator.geolocation || !journey.visible || !journey.selected) return;
  journey.watch = navigator.geolocation.watchPosition(({ coords }) => {
    if (!journey.selected || !journey.visible) return;
    journey.gps = { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy, observed: Date.now() };
    renderUserLocation(coords);
    updateJourneyProgress();
  }, () => {
    journey.gps = null;
    stopJourneyLocation();
    updateJourneyProgress();
  }, { enableHighAccuracy: false, maximumAge: 15000, timeout: 15000 });
}

function showJourneyLocation() {
  if (journey.gps && Date.now() - journey.gps.observed < 45000) {
    map.fitBounds(locationAccuracy.getBounds(), { maxZoom: 16, padding: [35, 35] });
  } else {
    startJourneyLocation();
    locateUserDevice(true, true);
  }
}

function updateJourneyProgress() {
  const status = document.getElementById('journeyProgressStatus');
  if (!status) return;
  const now = Date.now();
  const gps = journey.gps;
  const recentGps = gps && now - gps.observed < 45000 && gps.accuracy <= 180;
  const radius = recentGps ? Math.max(35, Math.min(115, gps.accuracy)) : 0;
  if (recentGps) {
    let best = radius;
    let closest = journey.gpsPassed;
    journey.rows.forEach((row, index) => {
      if (row.skipped || index < journey.gpsPassed || row.time > now + 5 * 60_000 ||
          !Number.isFinite(row.lat) || !Number.isFinite(row.lon)) return;
      const distance = haversineMeters(gps.latitude, gps.longitude, row.lat, row.lon);
      if (distance <= best) { best = distance; closest = index; }
    });
    journey.gpsPassed = closest;
  }
  const passed = recentGps ? journey.gpsPassed : Math.max(journey.gpsPassed,
    journey.rows.findLastIndex(row => !row.skipped && row.time <= now));
  const next = journey.rows.findIndex((row, index) => index > passed && !row.skipped);
  for (const element of document.querySelectorAll('[data-journey-step]')) {
    const index = Number(element.dataset.journeyStep);
    element.classList.toggle('passed', index <= passed);
    element.classList.toggle('next', index === next);
    if (index === next) element.setAttribute('aria-current', 'step');
    else element.removeAttribute('aria-current');
  }
  status.textContent = next === -1
    ? (recentGps ? 'დანიშნულების ადგილი მიღწეულია.' : 'მგზავრობის სავარაუდო დრო დასრულდა.')
    : recentGps ? 'პროგრესი მოწყობილობის მდებარეობით' : 'პროგრესი მარშრუტის დროების მიხედვით';
  if (next === -1) stopJourneyLocation();
}

async function refreshJourneyTrips() {
  const option = journey.selected;
  const now = Date.now();
  if (!option || journey.refreshing || now - journey.lastRefresh < 60_000) return;
  const ids = [...new Set(option.legs.filter(leg => leg.tripId &&
    Date.parse(journeyStops(leg).at(-1)?.arrival ?? leg.endTime) >= now - 120_000).map(leg => leg.tripId))];
  if (!ids.length) return;
  journey.lastRefresh = now;
  journey.refreshing = true;
  const updates = await Promise.all(ids.map(async id => {
    const data = await safeFetchJSON(`${TRANSITOUS_BASE}/api/v5/trip?tripId=${encodeURIComponent(id)}`);
    return Array.isArray(data?.legs) ? data.legs.find(leg => leg.tripId === id) : null;
  }));
  if (journey.selected !== option) return;
  journey.refreshing = false;
  let changed = false;
  updates.filter(Boolean).forEach(leg => {
    const prior = journey.refreshed.get(leg.tripId);
    if (JSON.stringify(prior) !== JSON.stringify(leg)) {
      journey.refreshed.set(leg.tripId, leg);
      changed = true;
    }
  });
  if (changed) renderSelectedJourney();
}
