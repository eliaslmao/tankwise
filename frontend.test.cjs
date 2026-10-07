'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const stations = require('../tankstellen.json').tankstellen;
function setup() {
    class Element {
        constructor() { this.listeners = {}; this.dataset = {}; this.children = []; this.value = ''; this.textContent = ''; this.hidden = false; this.classList = { toggle() {} }; }
        addEventListener(event, fn) {
            const previous = this.listeners[event];
            this.listeners[event] = previous ? (...args) => { const result = previous(...args); const next = fn(...args); return next ?? result; } : fn;
        }
        removeAttribute() {}
        focus() {}
        scrollIntoView() {}
        contains(element) { return this.children.includes(element); }
        setAttribute() {}
        replaceChildren() { this.children = []; }
        append(child) { this.children.push(child); }
        querySelectorAll() { return this.children.filter(c => c.className === 'tankstelle'); }
    }
    const elements = new Map();
    const requests = [];
    const document = { getElementById: id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement: () => new Element() };
    const context = vm.createContext({ document, window: {}, console, AbortController, setInterval: () => 1,
        fetch: (url, options) => {
            if (url === './tankstellen.json') return Promise.resolve({ ok: true, json: async () => ({ tankstellen: stations }) });
            // Ignoriert Abort absichtlich: selbst verspätete Antworten müssen verworfen werden.
            return new Promise(resolve => requests.push({ url, options, resolve: data => resolve({ ok: true, json: async () => data }) }));
        } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../script.js'), 'utf8'), context);
    return { context, elements, requests, document };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('typing does not geocode; stale address search cannot replace newer candidates', async () => {
    const { context, elements, requests } = setup(); await tick();
    const input = elements.get('startadresse');
    input.value = 'Brünner Straße 57'; input.listeners.input();
    assert.equal(requests.length, 0);
    const oldSearch = elements.get('routen-form').listeners.submit({ preventDefault() {} });
    input.value = 'Prager Straße 32'; input.listeners.input();
    const newSearch = elements.get('routen-form').listeners.submit({ preventDefault() {} });
    requests[1].resolve({ candidates: [{ id: 'new', label: 'Neue Adresse' }] }); await newSearch;
    requests[0].resolve({ candidates: [{ id: 'old', label: 'Alte Adresse' }] }); await oldSearch;
    assert.equal(elements.get('adress-treffer').children[0].textContent, 'Neue Adresse');
    assert.equal(vm.runInContext('routenErgebnisse', context), null);
});

test('stale matrix cannot attach to edited address; display rounds only the output', async () => {
    const { context, elements, requests } = setup(); await tick();
    const input = elements.get('startadresse'); input.value = 'Brünner Straße 57';
    const search = elements.get('routen-form').listeners.submit({ preventDefault() {} });
    requests[0].resolve({ candidates: [{ id: 'a', label: 'Adresse A', latitude: 48.26, longitude: 16.4 }] }); await search;
    const routing = elements.get('adress-treffer').children[0].listeners.click();
    input.value = 'Adresse B'; input.listeners.input();
    requests[1].resolve({ start: { label: 'Adresse A' }, calculatedAt: new Date().toISOString(), byStationId: { 1: { distanceKm: 4.23456, durationSeconds: 478.123 } } });
    await routing;
    assert.equal(vm.runInContext('routenErgebnisse', context), null);
    assert.equal(elements.get('routen-status').textContent, '');
    vm.runInContext('routenPhase = "fertig"; routenErgebnisse = { byStationId: { 1: { distanceKm: 4.23456, durationSeconds: 478.123 }, 2: { distanceKm: null, durationSeconds: null } } };', context);
    assert.match(vm.runInContext('routeHtml(1)', context), /4,2 km · ca. 8 Min/);
    assert.match(vm.runInContext('routeHtml(2)', context), /Keine Route verfügbar/);
    assert.equal(vm.runInContext('routenErgebnisse.byStationId[1].distanceKm', context), 4.23456);
});

test('cost example yields 65.96 EUR and retains numeric unrounded state', async () => {
    const { context } = setup(); await tick();
    const result = vm.runInContext(`berechneKostenvergleich([{id: 1, preise: {benzin: 1.6}}], {byStationId: {1: {distanceKm: 5, durationSeconds: 240}}}, 'benzin', 40)`, context);
    const c = result.byStationId[1];
    for (const [field, expected] of Object.entries({roundTripKm: 10, travelFuelLiters: .6, travelFuelCost: .96, wearCost: 1, travelCost: 1.96, refuelCost: 64, totalCost: 65.96})) {
        assert.ok(Math.abs(c[field] - expected) < 1e-10, field);
    }
    assert.equal(c.estimatedRoundTrip, true);
    assert.equal(c.roundTripDurationSeconds, 480);
});

test('separate return distance and time take priority, missing prices/routes are excluded', async () => {
    const { context } = setup(); await tick();
    const result = vm.runInContext(`berechneKostenvergleich([
        {id: 1, preise: {benzin: 1.6}}, {id: 2, preise: {benzin: 0}}, {id: 3, preise: {benzin: 1.5}},
        {id: 4, preise: {benzin: null}}, {id: 5, preise: {benzin: -1}}, {id: 6, preise: {benzin: '1.60'}}
    ], {byStationId: {1: {distanceKm: 3, returnDistanceKm: 7, durationSeconds: 60, returnDurationSeconds: 120}, 2: {distanceKm: 0}}}, 'benzin', 40)`, context);
    assert.equal(result.rankedIds.join(','), '1');
    assert.equal(result.byStationId[1].roundTripKm, 10);
    assert.equal(result.byStationId[1].estimatedRoundTrip, false);
    assert.equal(result.byStationId[1].roundTripDurationSeconds, 180);
    assert.equal(result.byStationId[3].valid, false);
    const empty = vm.runInContext(`berechneKostenvergleich([{id:1, preise:{benzin:1.6}}], null, 'benzin', 40)`, context);
    assert.equal(empty.rankedIds.length, 0);
    assert.equal(empty.byStationId[1].totalCost, undefined);
});

test('slider and fuel recalculate order and reference without network calls', async () => {
    const { context, elements, requests } = setup(); await tick();
    vm.runInContext(`alleTankstellen = [{id: 1, name:'Nah', preise:{benzin:2, diesel:1.5}}, {id:2, name:'Fern', preise:{benzin:1.9, diesel:2}}];
        routenErgebnisse = {byStationId:{1:{distanceKm:1,durationSeconds:60},2:{distanceKm:10,durationSeconds:600}}}; routenPhase='fertig';`, context);
    const slider = elements.get('tankmenge-slider');
    slider.value = '1'; slider.listeners.input();
    assert.equal(vm.runInContext('kostenErgebnisse.rankedIds.join(",")', context), '1,2');
    slider.value = '100'; slider.listeners.input();
    assert.equal(vm.runInContext('kostenErgebnisse.rankedIds.join(",")', context), '2,1');
    assert.equal(elements.get('tankmenge-zahl').value, '100');
    assert.equal(vm.runInContext('kostenErgebnisse.referenceId', context), 1);
    assert.ok(vm.runInContext('kostenErgebnisse.byStationId[2].savings', context) > 0);
    const fuel = elements.get('kraftstoff'); fuel.value = 'diesel'; fuel.listeners.change();
    assert.equal(vm.runInContext('kostenErgebnisse.rankedIds.join(",")', context), '1,2');
    assert.equal(requests.length, 0);
    elements.get('suche').value = 'Fern'; elements.get('suche').listeners.input();
    assert.equal(vm.runInContext('kostenErgebnisse.referenceId', context), 1);
    elements.get('startadresse').listeners.input();
    assert.equal(vm.runInContext('kostenErgebnisse.rankedIds.length', context), 0);
    assert.equal(vm.runInContext('kostenErgebnisse.byStationId[1].totalCost', context), undefined);
});

test('direct liters input synchronizes slider and rejects invalid quantities', async () => {
    const { elements, context, requests } = setup(); await tick();
    const input = elements.get('tankmenge-zahl');
    input.value = '72'; input.listeners.input();
    assert.equal(elements.get('tankmenge-slider').value, '72');
    assert.equal(elements.get('tankmenge-wert').textContent, '72 Liter');
    for (const invalid of ['', '0', '101', '1.5', 'abc']) {
        input.value = invalid; input.listeners.input();
        assert.equal(vm.runInContext('selectedRefuelLiters', context), 72);
        assert.match(elements.get('tankmenge-fehler').textContent, /1 bis 100/);
        input.listeners.change(); assert.equal(input.value, '72');
    }
    assert.equal(requests.length, 0);
});

test('equal totals prefer the shorter round trip', async () => {
    const { context } = setup(); await tick();
    const first = vm.runInContext(`berechneKostenvergleich([{id:2,preise:{benzin:2}},{id:1,preise:{benzin:2}}], {byStationId:{1:{distanceKm:1},2:{distanceKm:1}}}, 'benzin', 40)`, context);
    assert.equal(first.rankedIds.join(','), '1,2');
    // Exakt gleiche Gesamtkosten: 1 l zu 2 EUR ohne Fahrt und 1 l zu 1.6 EUR mit Fahrt.
    const tie = vm.runInContext(`berechneKostenvergleich([{id:2,preise:{benzin:1.6}},{id:1,preise:{benzin:2}}], {byStationId:{1:{distanceKm:0},2:{distanceKm:(2-1.6)/(2*(.06*1.6+.1))}}}, 'benzin', 1)`, context);
    assert.equal(tie.byStationId[1].totalCost, tie.byStationId[2].totalCost);
    assert.equal(tie.rankedIds[0], 1);
});


test('local street suggestions have no house numbers and selection makes no API request', async () => {
    const { context, elements, requests } = setup(); await tick();
    const input = elements.get('startadresse');
    input.value = 'Brün'; input.listeners.input();
    const dropdown = elements.get('strassen-vorschlaege');
    assert.equal(dropdown.hidden, false);
    const option = dropdown.children.find(child => child.textContent === 'Brünner Straße');
    assert.ok(option);
    option.listeners.click();
    assert.equal(input.value, 'Brünner Straße');
    assert.equal(dropdown.hidden, true);
    assert.equal(requests.length, 0);
    input.value = 'Prag'; input.listeners.input();
    let prevented = false;
    input.listeners.keydown({ key: 'ArrowDown', preventDefault() { prevented = true; } });
    input.listeners.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(prevented, true);
    assert.equal(input.value, 'Prager Straße');
    input.value = 'xyzunbekannt'; input.listeners.input();
    assert.equal(dropdown.hidden, true);
    assert.equal(vm.runInContext('passendeStrassen("").length', context), 0);
    assert.equal(requests.length, 0);
});


test('rotating placeholders and house-number hints never change the submitted value', async () => {
    const { context, elements, requests } = setup(); await tick();
    const input = elements.get('startadresse');
    const first = input.placeholder;
    vm.runInContext('wechsleAdressBeispiel()', context);
    assert.notEqual(input.placeholder, first);
    assert.match(input.placeholder, /\d.*1210 Wien/);
    input.value = 'bRüNnEr sTrAßE'; input.listeners.input();
    assert.equal(elements.get('hausnummer-vorschlag').hidden, false);
    assert.equal(elements.get('hausnummer-beispiel').textContent, ' 420');
    assert.equal(input.value, 'bRüNnEr sTrAßE');
    const placeholder = input.placeholder;
    vm.runInContext('wechsleAdressBeispiel()', context);
    assert.equal(input.placeholder, placeholder);
    input.value += ' 57'; input.listeners.input();
    assert.equal(elements.get('hausnummer-vorschlag').hidden, true);
    vm.runInContext('waehleStrasse("Prager Straße")', context);
    assert.equal(elements.get('hausnummer-vorschlag').hidden, false);
    assert.equal(input.value, 'Prager Straße');
    assert.equal(requests.length, 0);
});


test('street spacing is ignored and house hints rotate every 1750ms without editing input', async () => {
    const { context, elements, requests } = setup(); await tick();
    assert.equal(vm.runInContext('VORSCHLAG_INTERVALL_MS', context), 1750);
    assert.ok(vm.runInContext('passendeStrassen("brünnerstr").includes("Brünner Straße")', context));
    const input = elements.get('startadresse');
    for (const value of ['BrünnerStraße', 'BRÜNNER   STRASSE', 'Brünner Straße']) {
        input.value = value; input.listeners.input();
        const hint = elements.get('hausnummer-beispiel');
        assert.equal(elements.get('hausnummer-vorschlag').hidden, false);
        const previous = hint.textContent;
        vm.runInContext('wechsleGrauenVorschlag()', context);
        assert.notEqual(hint.textContent, previous);
        assert.equal(input.value, value);
    }
    input.value = 'BrünnerStraße 57'; input.listeners.input();
    vm.runInContext('wechsleGrauenVorschlag()', context);
    assert.equal(elements.get('hausnummer-vorschlag').hidden, true);
    assert.equal(input.value, 'BrünnerStraße 57');
    assert.equal(requests.length, 0);
});

test('a confirmed unique address starts routing without a second click', async () => {
    const { elements, requests } = setup(); await tick();
    elements.get('startadresse').value = 'Knöfelgasse 7';
    const pending = elements.get('routen-form').listeners.submit({preventDefault(){}});
    requests[0].resolve({candidates:[{id:'verified',label:'Knöfelgasse 7',addressConfirmed:true,latitude:48.27,longitude:16.4}]});
    await tick();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, '/api/routes');
    assert.equal(elements.get('adress-auswahl').hidden, true);
    requests[1].resolve({start:{label:'Knöfelgasse 7'}, calculatedAt:new Date().toISOString(), byStationId:{}});
    await pending;
});

test('unconfirmed house numbers show an input error and do not request routes', async () => {
    const { elements, requests } = setup(); await tick();
    elements.get('startadresse').value = 'Knöfelgasse 9999';
    const pending = elements.get('routen-form').listeners.submit({preventDefault(){}});
    requests[0].resolve({candidates:[],message:'Hausnummer nicht gefunden.'});
    await pending;
    assert.equal(requests.length, 1);
    assert.equal(elements.get('adress-fehler').hidden, false);
    assert.equal(elements.get('adress-fehler').textContent, 'Hausnummer nicht gefunden.');
    elements.get('startadresse').listeners.input();
    assert.equal(elements.get('adress-fehler').hidden, true);
});
