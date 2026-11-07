const journey = {
  from: null, to: null, options: [], selected: null, layer: null,
  visible: false, request: 0, watch: null, gps: null, gpsPassed: -1,
  rows: [], originRequest: 0, query: null, cursor: null, refreshed: new Map(), lastRefresh: 0, refreshing: false
};

function initializeJourneyPlanner() {
  setupStopPicker('journeyFrom', 'journeyFromOptions', stop => changeJourneyEndpoint('from', stop));
  setupStopPicker('journeyTo', 'journeyToOptions', stop => changeJourneyEndpoint('to', stop));
  document.getElementById('journeyForm').addEventListener('submit', findJourneys);
  document.getElementById('journeyForm').querySelector('button[type=submit]').disabled = false;
  setInterval(() => {
    if (!journey.visible || !journey.selected || document.hidden) return;
    updateJourneyProgress();
    refreshJourneyTrips();
  }, 1000);
}

function changeJourneyEndpoint(endpoint, stop) {
  if (endpoint === 'from') journey.originRequest++;
  journey[endpoint] = stop;
  journey.query = null;
  journey.cursor = null;
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
  updateMapFocus();
}

function useJourneyOriginLocation() {
  if (!navigator.geolocation) {
    showToast('მდებარეობა მიუწვდომელია.');
    return;
  }
  const input = document.getElementById('journeyFrom');
  const button = document.getElementById('journeyUseLocation');
  const request = ++journey.originRequest;
  button.disabled = true;
  const done = () => { button.disabled = false; };
  showToast('მუშავდება');
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    done();
    if (request !== journey.originRequest) return;
    const { latitude, longitude } = coords;
    input.value = 'მდებარეობა';
    document.getElementById('journeyFromOptions').classList.add('hidden');
    changeJourneyEndpoint('from', { id: null, name: 'მდებარეობა', location: { latitude, longitude } });
    renderUserLocation(coords);
    map.fitBounds(locationAccuracy.getBounds(), { maxZoom: 16, padding: [35, 35] });
  }, () => {
    done();
    if (request === journey.originRequest) showToast('შეამოწმე ნებართვები');
  }, { enableHighAccuracy: false, maximumAge: 15000, timeout: 12000 });
}

async function findJourneys(event) {
  event.preventDefault();
  const status = document.getElementById('journeyStatus');
  const { from, to } = journey;
  if (!from || !to) {
    status.textContent = 'აირჩიე საწყისი და სამიზნე.';
    return;
  }
  const a = from.location, b = to.location;
  if ((from.id && from.id === to.id) || (a.latitude === b.latitude && a.longitude === b.longitude)) {
    status.textContent = 'საწყისი და საბოლოო დანიშნულება არ შეიძლება იყოს ერთი მაჩვენებელი';
    return;
  }
  endJourneyTracking();
  journey.options = [];
  const request = ++journey.request;
  const button = event.currentTarget.querySelector('button[type=submit]');
  button.disabled = true;
  document.getElementById('journeyResults').replaceChildren();
  status.textContent = 'იძებნება';

  function endpoint(stop) {
    const { latitude, longitude } = stop.location;
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? `${latitude},${longitude}` : stop.id;
  }
  const base = new URLSearchParams({
    fromPlace: endpoint(from), toPlace: endpoint(to), time: new Date().toISOString()
  });
  const transit = new URLSearchParams(base);
  Object.entries({ transitModes: 'TRANSIT', directModes: '', searchWindow: '5400',
    numItineraries: '12', detailedTransfers: 'true', joinInterlinedLegs: 'false' })
    .forEach(([name, value]) => transit.set(name, value));
  const walking = new URLSearchParams(base);
  walking.set('transitModes', '');
  walking.set('directModes', 'WALK');
  walking.set('maxDirectTime', '3600');
  journey.query = transit;
  const [routes, footpaths] = await Promise.all([
    safeFetchJSON(`${TRANSITOUS_BASE}/api/v5/plan?${transit}`, 15_000),
    safeFetchJSON(`${TRANSITOUS_BASE}/api/v5/plan?${walking}`, 15_000)
  ]);
  if (request !== journey.request) return;
  button.disabled = false;
  journey.cursor = routes?.nextPageCursor ?? null;
  mergeJourneyOptions([...(routes?.itineraries ?? []), ...(footpaths?.direct ?? [])]);
  renderJourneyOptions();
  status.textContent = journey.options.length ? '' : routes && footpaths
    ? 'მარშრუტი ვერ მოიძებნა.' : 'მარშრუტების წყარო ამჟამად მიუწვდომელია.';
}

function mergeJourneyOptions(options) {
  const unique = new Map();
  for (const option of [...journey.options, ...options]) {
    if (!Array.isArray(option.legs) || !option.legs.length || option.legs.some(leg => leg.cancelled)) continue;
    const key = JSON.stringify([option.startTime, option.endTime,
      option.legs.map(leg => [leg.tripId, leg.mode, leg.from?.stopId, leg.to?.stopId])]);
    unique.set(key, option);
  }
  journey.options = [...unique.values()].sort((a, b) =>
    Date.parse(a.endTime) - Date.parse(b.endTime) || a.transfers - b.transfers);
}

const transferArrow = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h6a6 6 0 0 1 6 6v6m-4-4 4 4 4-4"/></svg>';
const backArrow = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 12H4m7-7-7 7 7 7"/></svg>';

function renderJourneyOptions() {
  const results = document.getElementById('journeyResults');
  results.replaceChildren();
  journey.options.forEach((option, index) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'journey-card';
    const lines = option.legs.map(leg => leg.tripId ? journeyLine(leg) : 'ფეხით');
    const steps = lines.filter((line, index) => line !== lines[index - 1])
      .map(line => `<span>${escapeHTML(line)}</span>`).join(transferArrow);
    card.innerHTML = `<span class="flex justify-between gap-2 text-sm font-bold">
      <span>${journeyTimeRange(option.startTime, option.endTime)}</span>
      <span>${journeyMinutes(option.duration)}</span>
    </span>
    <span class="journey-result-legs text-xs">${steps}</span>
    <span class="journey-muted text-[11px]">${journeyTransfers(option.transfers)}${index === 0 ? ' · საუკეთესო' : ''}</span>`;
    card.addEventListener('click', () => selectJourney(option));
    results.append(card);
  });
  if (journey.cursor) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'journey-secondary';
    more.textContent = 'მეტი ვარიანტი';
    more.addEventListener('click', () => loadMoreJourneys(more));
    results.append(more);
  }
}

async function loadMoreJourneys(button) {
  const cursor = journey.cursor;
  if (!cursor || !journey.query) return;
  const request = journey.request;
  const query = new URLSearchParams(journey.query);
  query.set('pageCursor', cursor);
  button.disabled = true;
  button.textContent = 'იძებნება';
  const data = await safeFetchJSON(`${TRANSITOUS_BASE}/api/v5/plan?${query}`, 15_000);
  if (request !== journey.request) return;
  if (!Array.isArray(data?.itineraries)) {
    button.disabled = false;
    button.textContent = 'სცადე ხელახლა';
    return;
  }
  journey.cursor = data.nextPageCursor !== cursor ? data.nextPageCursor : null;
  mergeJourneyOptions(data.itineraries);
  renderJourneyOptions();
}

function journeyTimeRange(start, end) {
  return `<span class="journey-time-range">${journeyTime(start)} ${directionArrow} ${journeyTime(end)}</span>`;
}

function journeyTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? displayTime.format(time) : waitingMarkup;
}

function journeyMinutes(seconds) {
  return Number.isFinite(seconds) ? `${Math.max(0, Math.ceil(seconds / 60))} წთ` : waitingMarkup;
}

function journeyTransfers(count) {
  return count > 0 ? `${count} გადაჯდომა` : 'პირდაპირი';
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
  updateMapFocus();
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

function walkConnection(from, to, seconds, meters, readyAt, nextLeg, estimated = false, indexes = []) {
  const nextStop = nextLeg ? journeyStops(nextLeg)[0] : null;
  const departure = Date.parse(nextStop?.departure ?? nextLeg?.startTime);
  const arrival = Date.parse(nextStop?.arrival ?? nextStop?.departure ?? nextLeg?.startTime);
  const spare = (departure - Date.parse(readyAt)) / 1000;
  const wait = !nextLeg ? '' : `<p class="walk-eta" data-transfer-departure="${departure}"
    data-transfer-arrival="${arrival}">${waitingMarkup}</p>
    <p>გასვლა ${journeyTime(nextStop?.departure ?? nextLeg.startTime)}</p>
    <p>${!Number.isFinite(spare) ? waitingMarkup : spare < 0
      ? 'გადასაჯდომად დრო არ კმარა' : `ფეხით მისვლის შემდეგ გასვლამდე ${journeyMinutes(spare)}`}</p>`;
  return `<div class="walk-link">
    <strong>ფეხით</strong>
    <div class="walk-from" ${indexes[0] === undefined ? '' : `data-journey-step="${indexes[0]}"`}>${escapeHTML(journeyPlaceName(from))}</div>
    <div class="walk-info"><p>მანძილი · ${estimated ? 'დაახლ. ' : ''}${Number.isFinite(meters) ? Math.round(meters) + ' მ' : waitingMarkup}</p>
    <p>დრო · ${Number.isFinite(seconds) ? journeyMinutes(seconds) : waitingMarkup}</p>${wait}</div>
    ${transferArrow}
    <div class="walk-to" ${indexes[1] === undefined ? '' : `data-journey-step="${indexes[1]}"`}>${escapeHTML(journeyPlaceName(to))}</div>
  </div>`;
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
  let walked = false;
  const legs = option.legs.map((leg, legIndex) => {
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
    if (transit && leg.interlineWithPreviousLeg && previousTransit) {
      transfer = `<div class="journey-transfer-card through-line">${directionArrow}<div>
        <strong>ხაზის ცვლილება · ${escapeHTML(journeyLine(previousTransit.leg))} ${directionArrow} ${escapeHTML(journeyLine(leg))}</strong>
        <p>იმავე ტრანსპორტში რჩები</p>
      </div></div>`;
    } else if (transit && previousTransit && !walked) {
      const origin = previousTransit.stop;
      const destination = stops[0];
      const sameStop = origin?.stopId && origin.stopId === destination?.stopId;
      const coords = [origin?.lat, origin?.lon, destination?.lat, destination?.lon];
      const meters = sameStop ? 0 : coords.every(Number.isFinite) ? haversineMeters(...coords) : NaN;
      const seconds = Math.ceil(meters / 1.25);
      const ready = Date.parse(previousTransit.end) + seconds * 1000;
      transfer = `<div class="journey-transfer-card"><strong>გადაჯდომა · ${escapeHTML(journeyLine(leg))}</strong>
        ${walkConnection(origin, destination, seconds, meters,
          Number.isFinite(ready) ? new Date(ready).toISOString() : null, leg, !sameStop)}</div>`;
    }
    const nextLeg = !transit ? option.legs.slice(legIndex + 1).find(item => item.tripId) : null;
    const walkMeters = !transit ? (Number.isFinite(leg.distance) ? leg.distance : geometry.slice(1).reduce(
      (sum, point, index) => sum + haversineMeters(...geometry[index], ...point), 0)) : 0;
    const walkDetails = !transit ? walkConnection(stops[0], stops.at(-1), Number(leg.duration),
      walkMeters, end, nextLeg, false, [rows.length, rows.length + stops.length - 1]) : '';
    if (transit) {
      previousTransit = { end, stop: stops.at(-1), leg };
      walked = false;
    } else walked = true;
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
        <span>${journeyTimeRange(start, end)}</span>
      </div>
      ${cancelled ? '<p class="departure-chip error">მონაკვეთი გაუქმებულია ან გაჩერება გამოტოვებულია. ხელახლა მოძებნე მგზავრობა.</p>' : ''}
      ${transit && leg.headsign ? `<p class="journey-muted text-[11px]">${escapeHTML(leg.headsign)}</p>` : ''}
      ${renderAlerts(live?.alerts ?? leg.alerts)}
      ${transit ? `<ol class="journey-stops mt-2 text-xs">${timeline}</ol>`
        : `<div class="journey-walk-segment">${walkDetails}</div>`}
    </article>`;
  }).join('');
  const previous = journey.rows[journey.gpsPassed];
  if (previous) {
    journey.gpsPassed = rows.findLastIndex(row => !row.skipped &&
      (row.lat === previous.lat && row.lon === previous.lon && Math.abs(row.time - previous.time) < 300_000));
  }
  journey.rows = rows;
  for (const row of [rows[0], rows.at(-1)]) {
    if (!Number.isFinite(row?.lat) || !Number.isFinite(row?.lon)) continue;
    L.circleMarker([row.lat, row.lon], { radius: 6, color: '#fff', weight: 2,
      fillColor: '#0284c7', fillOpacity: 1 }).addTo(journey.layer);
  }
  updateMapFocus();
  const departure = rows[0]?.time;
  const arrival = rows.at(-1)?.time;
  details.innerHTML = `<div class="journey-detail-header space-y-2">
    <div class="flex justify-between gap-2">
      <button type="button" class="journey-secondary" onclick="endJourneyTracking()" aria-label="ვარიანტები">${backArrow}</button>
      <button type="button" class="journey-secondary" onclick="showJourneyLocation()">მდებარეობა</button>
    </div>
    <p class="text-sm font-bold">${escapeHTML(journey.from.name)} → ${escapeHTML(journey.to.name)}</p>
    <p class="text-xs journey-summary">${journeyTimeRange(
      Number.isFinite(departure) ? new Date(departure).toISOString() : option.startTime,
      Number.isFinite(arrival) ? new Date(arrival).toISOString() : option.endTime)}
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
    : recentGps ? '' : 'პროგრესი მარშრუტის დროების მიხედვით';
  for (const item of document.querySelectorAll('[data-transfer-departure]')) {
    const departure = Number(item.dataset.transferDeparture);
    const arrival = Number(item.dataset.transferArrival);
    item.classList.toggle('waiting-text', !Number.isFinite(departure));
    item.textContent = !Number.isFinite(departure) ? waitingText : departure <= now ? 'რეისი გასულია' :
      arrival < departure && arrival <= now ? 'ჩასხდომის დროა' :
      arrival < departure ? `მოსვლამდე ${journeyMinutes((arrival - now) / 1000)}` :
      `გასვლამდე ${journeyMinutes((departure - now) / 1000)}`;
  }
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
    const data = await safeFetchJSON(`${TRANSITOUS_BASE}/api/v5/trip?tripId=${encodeURIComponent(id)}&joinInterlinedLegs=false`);
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
