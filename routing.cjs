'use strict';
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

class AppError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
const clean = value => String(value ?? '').trim().toLocaleLowerCase('de-AT');
function validCoordinates(latitude, longitude) {
    return Number.isFinite(latitude) && Number.isFinite(longitude)
        && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}
// Nur die tatsächlich angefragte Straße UND Hausnummer gelten als bestätigt.
function matchesRequestedAddress(hit, query) {
    const addressPart = query.split(',')[0].trim().replace(/\s+(?:1210\s+)?Wien$/i, '');
    const parts = addressPart.match(/^(.+?)\s*(\d+[a-zA-Z]?(?:\s*[-/]\s*\d+[a-zA-Z]?)?)$/);
    if (!parts || !hit.address?.house_number) return false;
    const normalize = value => String(value).toLocaleLowerCase('de-AT').replace(/ß/g, 'ss')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '');
    return normalize(parts[1]) === normalize(hit.address.road)
        && normalize(parts[2]) === normalize(hit.address.house_number);
}

function isFloridsdorf(hit) {
    const a = hit.address ?? {};
    // Postleitzahl und Bounding-Box sind ausdrücklich kein Bezirksnachweis.
    const vienna = [a.city, a.town, a.municipality, a.state].some(v => /^(wien|vienna)$/i.test(v ?? ''));
    const districts = [a.city_district, a.borough, a.suburb].map(clean).filter(Boolean);
    const districtMatch = v => /^(floridsdorf|21\.?\s*(bezirk|gemeindebezirk)(\s*[-–:(]\s*floridsdorf\)?)?)$/.test(v);
    // Ein ausdrücklich anderer city_district/borough darf nicht durch suburb überschrieben werden.
    const explicit = [a.city_district, a.borough].map(clean).filter(Boolean);
    return clean(a.country_code) === 'at' && vienna
        && districts.some(districtMatch) && explicit.every(districtMatch)
        && typeof a.road === 'string' && a.road.trim().length > 0
        && validCoordinates(Number(hit.lat), Number(hit.lon))
        && typeof hit.lat === 'string' && hit.lat.trim() !== ''
        && typeof hit.lon === 'string' && hit.lon.trim() !== '';
}

// Ein gemeinsamer serieller Scheduler für alle Browser und alle Suchanfragen.
function createScheduler({ interval = 1100, now = Date.now, wait = sleep } = {}) {
    let tail = Promise.resolve();
    let nextStart = 0;
    let pending = 0;
    return task => {
        if (pending >= 30) return Promise.reject(new AppError(429, 'Zu viele Adresssuchen. Bitte kurz warten.'));
        pending++;
        const result = tail.then(async () => {
            const delay = Math.max(0, nextStart - now());
            if (delay) await wait(delay);
            nextStart = now() + interval;
            return task();
        });
        tail = result.catch(() => {}).finally(() => { pending--; });
        return result;
    };
}

// Anbieterantworten nur intern auswerten. Keine Rohantwort oder Zugangsdaten ausgeben.
async function orsError(response) {
    let body;
    try { body = await response.json(); } catch { body = null; }
    const detail = [body?.error?.message, typeof body?.error === 'string' ? body.error : '', body?.message, body?.detail]
        .filter(value => typeof value === 'string').join(' ').toLowerCase();
    const prefix = `openrouteservice (HTTP ${response.status})`;
    if (/quota|daily limit|monthly limit|credits? exhausted|quotaexceeded/.test(detail)) {
        return new AppError(429, `${prefix}: Das API-Kontingent ist laut Anbieter erschöpft. Bitte das Kontingent im HeiGIT-Konto prüfen und dessen Rücksetzung abwarten.`);
    }
    if (response.status === 429 || /rate limit|too many requests|throttl/.test(detail)) {
        return new AppError(429, `${prefix}: Zu viele Anfragen in kurzer Zeit. Bitte warten und erneut versuchen.`);
    }
    if (response.status === 401) {
        return new AppError(503, `${prefix}: Die Authentifizierung ist fehlgeschlagen. Bitte ORS_API_KEY in der lokalen .env prüfen und den Server neu starten.`);
    }
    if (response.status === 403) {
        // Manche Gateways nennen Schlüssel und Berechtigung gemeinsam. Keine eindeutige Ursache erfinden.
        return new AppError(503, `${prefix}: Zugriff verweigert. Bitte die Gültigkeit des Schlüssels und die Freigabe für die Matrix-API im HeiGIT-Konto prüfen. Die Anbieterantwort bestätigt keine Kontingentüberschreitung.`);
    }
    if (response.status === 404) return new AppError(502, `${prefix}: Der Matrix-Endpunkt wurde nicht gefunden. Bitte die API-Adresse im Backend prüfen.`);
    if (response.status >= 500) return new AppError(502, `${prefix}: Der Anbieter meldet eine Serverstörung. Bitte später erneut versuchen.`);
    return new AppError(502, `${prefix}: Der Anbieter hat die Matrix-Anfrage abgelehnt. Bitte Startadresse und Zielkoordinaten prüfen.`);
}

async function upstreamJson(fetchImpl, url, options, service) {
    try {
        const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(20000) });
        if (!response.ok) {
            if (service === 'openrouteservice') throw await orsError(response);
            if (response.status === 429) throw new AppError(429, `${service}: API-Limit erreicht. Bitte später erneut versuchen.`);
            throw new AppError(502, `${service} konnte die Anfrage nicht verarbeiten. Bitte später erneut versuchen oder eine andere Startadresse wählen.`);
        }
        return await response.json();
    } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(502, `${service} ist gerade nicht erreichbar oder hat ungültige Daten geliefert. Bitte Internetverbindung prüfen und erneut versuchen.`);
    }
}

function createRoutingService({ stations, apiKey = '', fetchImpl = fetch,
    nominatimUrl = 'https://nominatim.openstreetmap.org/search',
    userAgent = 'Floridsdorf-Tankstellen-Finder/1.0 (local school project)',
    schedule = createScheduler(), now = Date.now } = {}) {
    const cache = new Map();
    const inFlight = new Map();
    const candidates = new Map();
    const ttl = 24 * 60 * 60 * 1000;
    let routeBusy = false;
    function prune() {
        for (const [key, value] of cache) if (value.expires <= now()) cache.delete(key);
        for (const [key, value] of candidates) if (value.expires <= now()) candidates.delete(key);
        while (cache.size > 500) cache.delete(cache.keys().next().value);
        while (candidates.size > 5000) candidates.delete(candidates.keys().next().value);
    }
    async function geocode(query) {
        if (typeof query !== 'string' || query.trim().length < 5 || query.length > 200) {
            throw new AppError(400, 'Bitte eine Straße mit Hausnummer und Wien eingeben, z. B. Brünner Straße 57, 1210 Wien.');
        }
        query = query.trim().replace(/\s+/g, ' ');
        const key = clean(query);
        prune();
        if (cache.has(key)) return cache.get(key).result;
        if (inFlight.has(key)) return inFlight.get(key);
        const job = schedule(async () => {
            const url = new URL(nominatimUrl);
            for (const [key, value] of Object.entries({ q: query, format: 'jsonv2', addressdetails: '1',
                countrycodes: 'at', limit: '10', 'accept-language': 'de', viewbox: '16.30,48.36,16.52,48.20', bounded: '1' })) {
                url.searchParams.set(key, value);
            }
            const data = await upstreamJson(fetchImpl, url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } }, 'Nominatim');
            if (!Array.isArray(data)) throw new AppError(502, 'Die Adresssuche hat ungültige Daten geliefert.');
            // Eine Hausadresse kann als Gebäude und zusätzlich als mehrere Geschäfte vorkommen.
            // Allgemeine Adress-/Gebäudepunkte zuerst; ansonsten den ersten bestätigten POI verwenden.
            const addressRank = hit => {
                if (['house', 'building', 'residential'].includes(hit.type) || hit.class === 'building' || hit.category === 'building') return 0;
                if (hit.addresstype === 'house') return 1;
                return 2;
            };
            const normalizeAddress = text => String(text).toLocaleLowerCase('de-AT').replace(/ß/g, 'ss').replace(/\s+/g, '');
            const seen = new Set();
            const matches = data.filter(isFloridsdorf).filter(hit => matchesRequestedAddress(hit, query))
                .sort((a, b) => addressRank(a) - addressRank(b)).filter(hit => {
                    const identity = `${normalizeAddress(hit.address.road)}|${normalizeAddress(hit.address.house_number)}`;
                    if (seen.has(identity)) return false;
                    seen.add(identity); return true;
                }).map(hit => {
                const candidate = { id: randomUUID(), label: `${hit.address.road} ${hit.address.house_number}, 1210 Wien`,
                    latitude: Number(hit.lat), longitude: Number(hit.lon),
                    addressConfirmed: true };
                candidates.set(candidate.id, { candidate, expires: now() + ttl });
                return candidate;
            });
            const result = { candidates: matches, message: matches.length ? '' :
                (data.length ? 'Straße und Hausnummer konnten in Floridsdorf nicht bestätigt werden. Bitte beide Angaben prüfen.' :
                    'Keine passende Adresse gefunden. Bitte Straße, Hausnummer und Wien prüfen.') };
            cache.set(key, { result, expires: now() + ttl });
            prune();
            return result;
        });
        inFlight.set(key, job);
        try { return await job; } finally { inFlight.delete(key); }
    }
    async function routes(candidateId) {
        prune();
        const start = candidates.get(candidateId)?.candidate;
        if (!start) throw new AppError(400, 'Bitte die Startadresse erneut suchen und einen bestätigten Treffer auswählen.');
        if (!apiKey.trim() || apiKey === 'DEIN_OPENROUTESERVICE_SCHLUESSEL') {
            throw new AppError(503, 'Der openrouteservice-Schlüssel fehlt. Trage ORS_API_KEY in der lokalen .env-Datei ein und starte den Server neu.');
        }
        if (/\s/.test(apiKey)) {
            throw new AppError(503, 'ORS_API_KEY enthält Leerzeichen oder Zeilenumbrüche. Bitte den vollständigen API-Schlüssel im HeiGIT-Dashboard erneut kopieren, den Wert in .env ersetzen und den Server neu starten.');
        }
        if (routeBusy) throw new AppError(429, 'Eine Routenberechnung läuft bereits. Bitte kurz warten und erneut versuchen.');
        routeBusy = true;
        try {
            const valid = stations.filter(t => validCoordinates(t.koordinaten?.latitude, t.koordinaten?.longitude));
            // Null bleibt Null: fehlende Koordinaten und unerreichbare Ziele sind keine 0-km-Routen.
            const byStationId = Object.fromEntries(stations.map(t => [t.id, { distanceKm: null, durationSeconds: null }]));
            // Aktuelles ORS-Limit: 3500 Quelle-Ziel-Paare, ohne dynamische Argumente.
            // Konservative 50 Ziele je Paket; alle 23 vorhandenen Ziele gehen gemeinsam raus.
            for (let offset = 0; offset < valid.length; offset += 50) {
                const batch = valid.slice(offset, offset + 50);
                const body = { locations: [[start.longitude, start.latitude], ...batch.map(t => [t.koordinaten.longitude, t.koordinaten.latitude])],
                    sources: ['0'], destinations: batch.map((_, index) => String(index + 1)), metrics: ['distance', 'duration'], units: 'km' };
                const data = await upstreamJson(fetchImpl, 'https://api.heigit.org/openrouteservice/v2/matrix/driving-car', {
                    method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
                }, 'openrouteservice');
                if (!Array.isArray(data.distances?.[0]) || !Array.isArray(data.durations?.[0])
                    || data.distances[0].length !== batch.length || data.durations[0].length !== batch.length) {
                    throw new AppError(502, 'openrouteservice hat eine unvollständige Matrix geliefert. Bitte erneut versuchen.');
                }
                batch.forEach((station, index) => {
                    const distanceKm = data.distances[0][index];
                    const durationSeconds = data.durations[0][index];
                    if (Number.isFinite(distanceKm) && distanceKm >= 0 && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
                        byStationId[station.id] = { distanceKm, durationSeconds };
                    }
                });
            }
            return { start: { ...start }, calculatedAt: new Date(now()).toISOString(), byStationId };
        } finally { routeBusy = false; }
    }
    return { geocode, routes };
}
module.exports = { orsError, AppError, validCoordinates, isFloridsdorf, createScheduler, createRoutingService };
