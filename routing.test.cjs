'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRoutingService, isFloridsdorf, createScheduler } = require('../routing.cjs');
const { createServer } = require('../server.cjs');
const stations = require('../tankstellen.json').tankstellen;
const hit = (address = {}) => ({ lat: '48.265', lon: '16.402', display_name: 'Brünner Straße 57, Floridsdorf, Wien',
    address: { country_code: 'at', city: 'Wien', suburb: 'Floridsdorf', road: 'Brünner Straße', house_number: '57', ...address } });
const ok = data => ({ ok: true, json: async () => data });
const fixture = (overrides = {}) => createRoutingService({ stations, apiKey: 'TEST_ONLY_NOT_A_REAL_KEY', schedule: task => task(), ...overrides });

test('Floridsdorf requires returned district information, not postcode or query', () => {
    assert.equal(isFloridsdorf(hit()), true);
    assert.equal(isFloridsdorf(hit({ suburb: 'Großjedlersdorf', city_district: 'Floridsdorf' })), true);
    assert.equal(isFloridsdorf(hit({ suburb: undefined, postcode: '1210' })), false);
    assert.equal(isFloridsdorf(hit({ city_district: 'Donaustadt', postcode: '1210' })), false);
    assert.equal(isFloridsdorf(hit({ country_code: 'de' })), false);
    assert.equal(isFloridsdorf(hit({ city: 'Graz' })), false);
    assert.equal(isFloridsdorf(hit({ road: undefined })), false);
    assert.equal(isFloridsdorf({ ...hit(), lat: null }), false);
});

test('central scheduler spaces concurrent calls and recovers after failures', async () => {
    let clock = 0;
    const starts = [];
    const schedule = createScheduler({ now: () => clock, wait: async ms => { clock += ms; } });
    await Promise.allSettled([1, 2, 3].map(i => schedule(() => { starts.push(clock); if (i === 2) throw Error('test'); })));
    assert.deepEqual(starts, [0, 1100, 2200]);
});

test('geocoding caches and coalesces searches; supplies identity and address details', async () => {
    let count = 0;
    const service = fixture({ fetchImpl: async (url, options) => {
        count++;
        assert.match(options.headers['User-Agent'], /Floridsdorf-Tankstellen-Finder/);
        assert.equal(url.searchParams.get('addressdetails'), '1');
        return ok([hit(), { ...hit(), lat: '48.266', display_name: 'Zweiter Treffer' }, hit({ suburb: 'Donaustadt' })]);
    } });
    const [a, b] = await Promise.all([service.geocode('Brünner Straße 57'), service.geocode('Brünner Straße 57')]);
    assert.equal(a.candidates.length, 1);
    assert.deepEqual(a, b);
    assert.deepEqual(await service.geocode('  brünner   Straße 57  '), a);
    assert.equal(count, 1);
});

test('unclear district and no matches return understandable messages', async () => {
    for (const data of [[], [hit({ suburb: undefined, postcode: '1210' })]]) {
        const result = await fixture({ fetchImpl: async () => ok(data) }).geocode('Brünner Straße 57');
        assert.equal(result.candidates.length, 0);
        assert.ok(result.message.length > 30);
    }
});

test('all 23 stations share one driving-car request with lon/lat and both metrics', async () => {
    let calls = 0;
    const service = fixture({ fetchImpl: async (url, options) => {
        if (String(url).includes('nominatim')) return ok([hit()]);
        calls++;
        assert.equal(url, 'https://api.heigit.org/openrouteservice/v2/matrix/driving-car');
        assert.equal(options.headers.Authorization, 'TEST_ONLY_NOT_A_REAL_KEY');
        const body = JSON.parse(options.body);
        assert.equal(body.locations.length, 24);
        assert.deepEqual(body.locations[0], [16.402, 48.265]);
        assert.deepEqual(body.locations[1], [stations[0].koordinaten.longitude, stations[0].koordinaten.latitude]);
        assert.deepEqual(body.sources, ['0']);
        assert.equal(body.destinations.length, 23);
        assert.deepEqual(body.metrics, ['distance', 'duration']);
        assert.equal(body.units, 'km');
        return ok({ distances: [stations.map(() => 4.234567)], durations: [stations.map(() => 478.1234)] });
    } });
    const candidate = (await service.geocode('Brünner Straße 57')).candidates[0];
    const result = await service.routes(candidate.id);
    assert.equal(calls, 1);
    assert.equal(Object.keys(result.byStationId).length, 23);
    assert.deepEqual(result.byStationId[1], { distanceKm: 4.234567, durationSeconds: 478.1234 });
    assert.ok(result.calculatedAt);
    assert.equal(result.start.id, candidate.id);
    assert.equal(stations[0].distanceKm, undefined);
});

test('skipped invalid coordinates preserve ID mapping; null routes never become zero', async () => {
    const custom = [
        { id: 19, koordinaten: { latitude: 48.26, longitude: 16.4 } },
        { id: 3, koordinaten: { latitude: null, longitude: 16.4 } },
        { id: 87, koordinaten: { latitude: 48.27, longitude: 16.41 } },
        { id: 200, koordinaten: { latitude: 48.28, longitude: 16.42 } }
    ];
    const service = fixture({ stations: custom, fetchImpl: async url => String(url).includes('nominatim') ? ok([hit()]) :
        ok({ distances: [[0, null, 8.76543]], durations: [[0, null, 734.56]] }) });
    const id = (await service.geocode('Brünner Straße 57')).candidates[0].id;
    const { byStationId } = await service.routes(id);
    assert.deepEqual(byStationId[19], { distanceKm: 0, durationSeconds: 0 });
    assert.deepEqual(byStationId[3], { distanceKm: null, durationSeconds: null });
    assert.deepEqual(byStationId[87], { distanceKm: null, durationSeconds: null });
    assert.deepEqual(byStationId[200], { distanceKm: 8.76543, durationSeconds: 734.56 });
});

test('arbitrary client coordinates cannot bypass validated address selection', async () => {
    await assert.rejects(fixture().routes('untrusted'), /erneut suchen/);
});

test('missing key returns instructions without an ORS request', async () => {
    let calls = 0;
    const service = fixture({ apiKey: '', fetchImpl: async () => { calls++; return ok([hit()]); } });
    const id = (await service.geocode('Brünner Straße 57')).candidates[0].id;
    await assert.rejects(service.routes(id), /ORS_API_KEY/);
    assert.equal(calls, 1);
});

test('network failures and rate limits are translated; upstream bodies stay private', async () => {
    const network = fixture({ fetchImpl: async () => { throw new Error('SECRET'); } });
    await assert.rejects(network.geocode('Brünner Straße 57'), /nicht erreichbar/);
    const limited = fixture({ fetchImpl: async () => ({ ok: false, status: 429 }) });
    await assert.rejects(limited.geocode('Brünner Straße 57'), /API-Limit/);
    for (const status of [401, 403, 429, 500]) {
        const service = fixture({ fetchImpl: async url => String(url).includes('nominatim') ? ok([hit()]) : { ok: false, status } });
        const id = (await service.geocode('Brünner Straße 57')).candidates[0].id;
        await assert.rejects(service.routes(id), error => error.status >= 400 && !error.message.includes('TEST_ONLY'));
    }
});

test('malformed matrix fails without inventing routes', async () => {
    const service = fixture({ fetchImpl: async url => String(url).includes('nominatim') ? ok([hit()]) : ok({ distances: [[1]], durations: [[]] }) });
    const id = (await service.geocode('Brünner Straße 57')).candidates[0].id;
    await assert.rejects(service.routes(id), /unvollständige Matrix/);
});

test('HTTP serves only public files and rejects foreign origins', async t => {
    const server = createServer({ service: { geocode: async () => ({ candidates: [] }), routes: async () => ({}) } });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const file of ['/', '/index.html', '/style.css', '/script.js', '/tankstellen.json']) {
        assert.equal((await fetch(base + file)).status, 200, file);
    }
    for (const file of ['/.env', '/.env.example', '/server.cjs', '/routing.cjs', '/package.json', '/test/routing.test.cjs', '/%2eenv', '/..%2f.env']) {
        assert.equal((await fetch(base + file)).status, 404, file);
    }
    assert.equal((await fetch(base + '/api/routes', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(base + '/api/geocode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
});

test('ORS diagnostics distinguish status and provider cause without exposing response secrets', async () => {
    const { orsError } = require('../routing.cjs');
    const cases = [
        [401, { message: 'Unauthorized SECRET_KEY' }, /Authentifizierung/],
        [403, { error: 'Invalid API key or access to this API has been disallowed SECRET_KEY' }, /Zugriff verweigert/],
        [403, { error: 'Quota exceeded SECRET_KEY' }, /Kontingent.*erschöpft/],
        [429, { message: 'Rate limit exceeded SECRET_KEY' }, /kurzer Zeit/],
        [429, { error: { message: 'Daily quota exceeded SECRET_KEY' } }, /Kontingent.*erschöpft/],
        [404, {}, /Endpunkt/],
        [503, {}, /Serverstörung/]
    ];
    for (const [status, body, expected] of cases) {
        const error = await orsError({ status, json: async () => body });
        assert.match(error.message, expected);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.ok(!error.message.includes('SECRET_KEY'));
    }
    const error = await orsError({ status: 403, json: async () => { throw Error('Non-JSON'); } });
    assert.match(error.message, /Zugriff verweigert/);
});

test('whitespace in local API key is explained before sending credentials', async () => {
    let calls = 0;
    const service = fixture({ apiKey: 'TEST KEY', fetchImpl: async () => { calls++; return ok([hit()]); } });
    const id = (await service.geocode('Brünner Straße 57')).candidates[0].id;
    await assert.rejects(service.routes(id), /Leerzeichen oder Zeilenumbrüche/);
    assert.equal(calls, 1);
});

test('only exact street and house-number matches may start routing automatically', async () => {
    for (const address of [{house_number:undefined}, {house_number:'570'}, {road:'Andere Straße'}]) {
        const service = fixture({ fetchImpl: async () => ok([hit(address)]) });
        const result = await service.geocode('Brünner Straße 57');
        assert.equal(result.candidates.length, 0);
    }
    const service = fixture({fetchImpl:async () => ok([hit()])});
    const result = await service.geocode('BRÜNNERSTRASSE 57, 1210 Wien');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].addressConfirmed, true);
});


test('shops at the same house merge into one plain address, preferring the building', async () => {
    const shop = {...hit(), category:'shop', type:'mobile_phone', lat:'48.2651', display_name:'Handygeschäft, Brünner Straße 57'};
    const building = {...hit(), category:'building', type:'yes', display_name:'57, Brünner Straße, Wien'};
    const supermarket = {...hit(), category:'shop', type:'supermarket', lat:'48.2652', display_name:'Supermarkt'};
    const service = fixture({fetchImpl:async () => ok([shop, supermarket, building])});
    const result = await service.geocode('Brünner Straße 57');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].label, 'Brünner Straße 57, 1210 Wien');
    assert.equal(result.candidates[0].latitude, Number(building.lat));
    assert.equal(result.candidates[0].addressConfirmed, true);
    const fallback = await fixture({fetchImpl:async () => ok([shop, supermarket])}).geocode('Brünner Straße 57');
    assert.equal(fallback.candidates.length, 1);
    assert.equal(fallback.candidates[0].label, 'Brünner Straße 57, 1210 Wien');
});
