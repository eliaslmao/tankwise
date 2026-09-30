// Zentrale Modellparameter: Verschleiß enthält ausdrücklich keine Spritkosten.
const COST_MODEL = Object.freeze({
    consumptionLitersPer100Km: 6,
    wearCostPerKm: 0.10,
    defaultRefuelLiters: 40
});
let selectedFuel = "benzin";
let selectedRefuelLiters = COST_MODEL.defaultRefuelLiters;
// Numerische, ungerundete Vergleichswerte getrennt von JSON und Routen.
let kostenErgebnisse = { byStationId: {}, rankedIds: [], referenceId: null };

let alleTankstellen = [];
let karte;
let markerGruppe;
let aktiveId = null;
// Getrennt von den unveränderten JSON-Stammdaten, ausschließlich ungerundete API-Werte.
let routenErgebnisse = null; // { start: {latitude, longitude, label}, calculatedAt, byStationId }
let startMarker = null;
let routenVersion = 0;
let routenAbbruch = null;
let routenPhase = "leer";
const markerNachId = new Map();
const liste = document.getElementById("tankstellen-liste");
const suche = document.getElementById("suche");
const reset = document.getElementById("alle-anzeigen");
const kartenStatus = document.getElementById("karten-status");

function kartenHinweis(text) {
    kartenStatus.textContent = text;
    kartenStatus.hidden = !text;
}
function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, zeichen => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[zeichen]);
}
function preis(wert) {
    return typeof wert === "number" && Number.isFinite(wert)
        ? `${wert.toLocaleString("de-AT", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} €`
        : "Keine Angabe";
}
function preiseHtml(t) {
    return `<span class="preise"><span class="preis"><span>Diesel</span><strong>${preis(t.preise?.diesel)}</strong></span><span class="preis"><span>Benzin</span><strong>${preis(t.preise?.benzin)}</strong></span></span>`;
}
function hatKoordinaten(t) {
    return Number.isFinite(t.koordinaten?.latitude) && Number.isFinite(t.koordinaten?.longitude);
}
function initialisiereKarte() {
    if (!window.L) {
        kartenHinweis("Die Karte konnte nicht geladen werden. Bitte prüfe deine Internetverbindung und lade die Seite neu. Die Tankstellen findest du in der Liste.");
        return;
    }
    karte = L.map("karte", { zoomControl: false }).setView([48.281, 16.419], 13);
    L.control.zoom({ position: "bottomright", zoomInTitle: "Vergrößern", zoomOutTitle: "Verkleinern" }).addTo(karte);
    const kacheln = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(karte);
    let kachelFehler = false;
    kacheln.on("loading", () => { kachelFehler = false; });
    kacheln.on("tileerror", () => {
        kachelFehler = true;
        kartenHinweis("Ein Teil der Hintergrundkarte konnte nicht geladen werden. Bitte prüfe deine Internetverbindung.");
    });
    kacheln.on("load", () => { if (!kachelFehler) kartenHinweis(""); });
    markerGruppe = L.featureGroup().addTo(karte);
}
function markiereTankstelle(id, zurListeScrollen = false) {
    aktiveId = id;
    liste.querySelectorAll(".tankstelle").forEach(element => {
        const aktiv = Number(element.dataset.id) === id;
        element.classList.toggle("aktiv", aktiv);
        element.setAttribute("aria-current", String(aktiv));
        // Nur die Liste scrollen, damit die Karte auf dem Handy sichtbar bleibt.
        if (aktiv && zurListeScrollen) liste.scrollTop = element.offsetTop - 8;
    });
    markerNachId.forEach((marker, markerId) => {
        marker.getElement()?.classList.toggle("ausgewaehlt", markerId === id);
        marker.setZIndexOffset(markerId === id ? 1000 : 0);
    });
}
function zeigeTankstellen(tankstellen, ausschnittAnpassen = false) {
    kostenErgebnisse = berechneKostenvergleich(alleTankstellen, routenErgebnisse, selectedFuel, selectedRefuelLiters);
    const reihenfolge = new Map(kostenErgebnisse.rankedIds.map((id, index) => [id, index]));
    tankstellen = [...tankstellen].sort((a, b) => (reihenfolge.get(a.id) ?? Infinity) - (reihenfolge.get(b.id) ?? Infinity));
    liste.replaceChildren();
    markerGruppe?.clearLayers();
    markerNachId.clear();
    document.getElementById("anzahl").textContent = `${tankstellen.length} von ${alleTankstellen.length}`;
    if (!tankstellen.length) {
        const leer = document.createElement("p");
        leer.className = "hinweis";
        leer.textContent = "Keine Tankstelle gefunden. Versuche einen anderen Namen oder eine andere Straße.";
        liste.append(leer);
    }
    tankstellen.forEach(t => {
        const element = document.createElement("article");
        const auswahl = document.createElement("button");
        auswahl.type = "button";
        auswahl.className = "station-auswahl";
        element.className = "tankstelle";
        element.dataset.id = t.id;
        auswahl.setAttribute("aria-label", `${t.name}, ${t.adresse ?? ""}, auf der Karte anzeigen`);
        auswahl.innerHTML = `<span class="tankstelle-header"><span class="nummer">${escapeHtml(t.id)}</span><span class="tankstelle-name">${escapeHtml(t.name)}</span></span><span class="adresse">${escapeHtml(t.adresse ?? "Adresse nicht hinterlegt")}</span>${preiseHtml(t)}${routeHtml(t.id)}`;
        element.append(auswahl);
        const vergleich = document.createElement("div");
        vergleich.innerHTML = kostenHtml(t.id);
        element.append(vergleich);
        liste.append(element);
        if (karte && hatKoordinaten(t)) {
            const marker = L.marker([t.koordinaten.latitude, t.koordinaten.longitude], {
                title: t.name, alt: `${t.id}: ${t.name}`,
                icon: L.divIcon({ className: "tank-pin", html: `<span>${escapeHtml(t.id)}</span>`, iconSize: [30, 36], iconAnchor: [15, 36], popupAnchor: [0, -32] })
            }).bindPopup(`<h3>${escapeHtml(t.name)}</h3><p>${escapeHtml(t.adresse)}</p>${preiseHtml(t)}${routeHtml(t.id)}${kostenHtml(t.id)}<small>Gespeicherte Preise · pro Liter · keine Live-Preise</small>`, { maxWidth: 280 });
            marker.on("popupopen", () => markiereTankstelle(t.id, true));
            markerGruppe.addLayer(marker);
            markerNachId.set(t.id, marker);
        }
        auswahl.addEventListener("click", () => {
            markiereTankstelle(t.id);
            const marker = markerNachId.get(t.id);
            if (marker) {
                document.getElementById("karte").scrollIntoView({ block: "nearest", behavior: "smooth" });
                karte.setView(marker.getLatLng(), 16);
                marker.openPopup();
            }
        });
    });
    markiereTankstelle(aktiveId);
    if (ausschnittAnpassen && markerNachId.size) {
        karte.fitBounds(startMarker ? markerGruppe.getBounds().extend(startMarker.getLatLng()) : markerGruppe.getBounds(), { paddingTopLeft: [40, 90], paddingBottomRight: [40, 55], maxZoom: 15 });
    }
}
function normalisiere(text) {
    return String(text ?? "").toLocaleLowerCase("de-AT").replace(/ß/g, "ss").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
suche.addEventListener("input", () => {
    const suchtext = normalisiere(suche.value.trim());
    zeigeTankstellen(alleTankstellen.filter(t => normalisiere(`${t.name} ${t.kette} ${t.adresse}`).includes(suchtext)), true);
});
reset.addEventListener("click", () => {
    suche.value = "";
    aktiveId = null;
    zeigeTankstellen(alleTankstellen, true);
});
initialisiereKarte();
fetch("./tankstellen.json")
    .then(response => {
        if (!response.ok) throw new Error("Tankstellendaten konnten nicht geladen werden.");
        return response.json();
    })
    .then(daten => {
        if (!Array.isArray(daten.tankstellen)) throw new Error("Ungültige Tankstellendaten.");
        alleTankstellen = daten.tankstellen;
        zeigeTankstellen(alleTankstellen, true);
        reset.disabled = !karte;
    })
    .catch(fehler => {
        console.error(fehler);
        document.getElementById("anzahl").textContent = "Ladefehler";
        liste.innerHTML = '<p class="hinweis">Tankstellen konnten nicht geladen werden. Starte das Node.js-Backend mit npm start und öffne http://localhost:3000 und lade die Seite erneut.</p>';
    });


const adressInput = document.getElementById("startadresse");
const routenForm = document.getElementById("routen-form");
const berechnenButton = document.getElementById("berechnen");
const routenStatus = document.getElementById("routen-status");
const adressAuswahl = document.getElementById("adress-auswahl");
const adressTreffer = document.getElementById("adress-treffer");

function routeHtml(id) {
    if (routenPhase === "laedt") return '<span class="route-info">Fahrstrecke wird berechnet …</span>';
    if (!routenErgebnisse) return "";
    const route = routenErgebnisse.byStationId[id];
    if (!route || !Number.isFinite(route.distanceKm) || !Number.isFinite(route.durationSeconds)) {
        return '<span class="route-info route-fehlt">Keine Route verfügbar</span>';
    }
    const km = route.distanceKm.toLocaleString("de-AT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const minuten = route.durationSeconds > 0 && route.durationSeconds < 60 ? "< 1" : String(Math.round(route.durationSeconds / 60));
    return `<span class="route-info">Hinfahrt: ${km} km · ca. ${escapeHtml(minuten)} Min.</span>`;
}
function aktualisiereRoutenAnzeige(ausschnitt = false) {
    const suchtext = normalisiere(suche.value.trim());
    zeigeTankstellen(alleTankstellen.filter(t => normalisiere(`${t.name} ${t.kette} ${t.adresse}`).includes(suchtext)), ausschnitt);
}
function ladeZustand(aktiv) {
    berechnenButton.disabled = aktiv;
    berechnenButton.textContent = aktiv ? "Bitte warten …" : "Entfernungen berechnen";
    routenForm.setAttribute("aria-busy", String(aktiv));
}
function verwerfeAlteRouten() {
    routenVersion++;
    routenAbbruch?.abort();
    routenAbbruch = new AbortController();
    routenErgebnisse = null;
    routenPhase = "leer";
    if (startMarker) { startMarker.remove(); startMarker = null; }
    adressAuswahl.hidden = true;
    adressTreffer.replaceChildren();
    routenStatus.textContent = "";
    ladeZustand(false);
    aktualisiereRoutenAnzeige();
    return routenVersion;
}
async function apiPost(url, body, signal) {
    let response;
    try {
        response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    } catch (error) {
        if (error.name === "AbortError") throw error;
        throw new Error("Das Backend ist nicht erreichbar. Bitte npm start ausführen und die App unter http://localhost:3000 öffnen.");
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error("Ungültige Serverantwort. Bitte die App über das Node.js-Backend öffnen, nicht über Live Server."); }
    if (!response.ok) throw new Error(data.error || "Die Anfrage ist fehlgeschlagen. Bitte erneut versuchen.");
    return data;
}
async function berechneRouten(kandidat, version) {
    if (version !== routenVersion) return;
    adressAuswahl.hidden = true;
    routenPhase = "laedt";
    ladeZustand(true);
    routenStatus.textContent = `Autostrecken ab ${kandidat.label} werden berechnet …`;
    if (karte) {
        startMarker = L.marker([kandidat.latitude, kandidat.longitude], {
            title: "Gewählter Startpunkt", alt: "Startadresse",
            icon: L.divIcon({ className: "start-pin", html: "<span>Start</span>", iconSize: [50, 32], iconAnchor: [25, 32] })
        }).addTo(karte).bindPopup(`<strong>Startadresse</strong><br>${escapeHtml(kandidat.label)}`);
    }
    aktualisiereRoutenAnzeige(true);
    try {
        const ergebnis = await apiPost("/api/routes", { candidateId: kandidat.id }, routenAbbruch.signal);
        if (version !== routenVersion) return;
        routenErgebnisse = ergebnis;
        routenPhase = "fertig";
        const anzahl = Object.values(ergebnis.byStationId).filter(r => Number.isFinite(r.distanceKm) && Number.isFinite(r.durationSeconds)).length;
        routenStatus.textContent = `${anzahl} von ${alleTankstellen.length} Autostrecken ab ${ergebnis.start.label} berechnet. Stand: ${new Date(ergebnis.calculatedAt).toLocaleTimeString("de-AT")}. Fahrzeiten geschätzt, ohne Echtzeitverkehr.`;
    } catch (error) {
        if (version !== routenVersion || error.name === "AbortError") return;
        routenPhase = "fehler";
        routenStatus.textContent = error.message;
    } finally {
        if (version === routenVersion) { ladeZustand(false); aktualisiereRoutenAnzeige(); }
    }
}
// Eingaben löschen alte Zuordnungen, lösen aber keine Geocoding-Anfrage aus.
adressInput.addEventListener("input", verwerfeAlteRouten);
routenForm.addEventListener("submit", async event => {
    event.preventDefault();
    const version = verwerfeAlteRouten();
    ladeZustand(true);
    routenStatus.textContent = "Adresse wird gesucht und die Bezirkszuordnung geprüft …";
    try {
        const data = await apiPost("/api/geocode", { query: adressInput.value.trim() }, routenAbbruch.signal);
        if (version !== routenVersion) return;
        if (!data.candidates.length) { routenStatus.textContent = data.message; return; }
        // Auch einzelne Treffer bestätigen lassen: Hausnummer und Startpunkt bleiben überprüfbar.
        routenStatus.textContent = `${data.candidates.length} passende Adresse(n) in Floridsdorf gefunden. Bitte auswählen.`;
        adressAuswahl.hidden = false;
        data.candidates.forEach(kandidat => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "adress-kandidat";
            button.textContent = kandidat.label + (kandidat.note ? ` — ${kandidat.note}` : "");
            button.addEventListener("click", () => berechneRouten(kandidat, version));
            adressTreffer.append(button);
        });
    } catch (error) {
        if (version === routenVersion && error.name !== "AbortError") routenStatus.textContent = error.message;
    } finally {
        if (version === routenVersion) ladeZustand(false);
    }
});


function berechneKostenvergleich(stations, routes, fuel, liters) {
    const byStationId = {};
    const valid = [];
    const nonnegative = n => Number.isFinite(n) && n >= 0;
    for (const station of stations) {
        // JSON preise.benzin/diesel sind EUR/L (z. B. 1.929), nicht Cent/L.
        const fuelPricePerLiter = station.preise?.[fuel];
        const route = routes?.byStationId?.[station.id];
        let reason = "";
        if (!Number.isFinite(fuelPricePerLiter) || fuelPricePerLiter <= 0) reason = "Kein gültiger Preis für die gewählte Kraftstoffart.";
        else if (!Number.isInteger(liters) || liters < 1 || liters > 100) reason = "Bitte 1 bis 100 ganze Liter eingeben.";
        else if (!routes) reason = "Für Gesamtkosten bitte zuerst eine Startadresse auswählen und die Fahrstrecken berechnen.";
        else if (!route || !nonnegative(route.distanceKm)) reason = "Keine Route verfügbar – kein Kostenvergleich möglich.";
        else if (route.returnDistanceKm !== undefined && !nonnegative(route.returnDistanceKm)) reason = "Keine Rückroute verfügbar – kein Kostenvergleich möglich.";
        if (reason) { byStationId[station.id] = { valid: false, reason, fuelPricePerLiter: Number.isFinite(fuelPricePerLiter) && fuelPricePerLiter > 0 ? fuelPricePerLiter : null }; continue; }
        // Optionale separate Rückstrecke wird bevorzugt; derzeit liefert das Backend nur die Hinfahrt.
        const estimatedRoundTrip = route.returnDistanceKm === undefined;
        const roundTripKm = route.distanceKm + (estimatedRoundTrip ? route.distanceKm : route.returnDistanceKm);
        const travelFuelLiters = roundTripKm * COST_MODEL.consumptionLitersPer100Km / 100;
        const travelFuelCost = travelFuelLiters * fuelPricePerLiter;
        const wearCost = roundTripKm * COST_MODEL.wearCostPerKm;
        const travelCost = travelFuelCost + wearCost;
        const refuelCost = liters * fuelPricePerLiter;
        const estimatedDuration = route.returnDurationSeconds === undefined;
        const roundTripDurationSeconds = nonnegative(route.durationSeconds)
            && (estimatedDuration || nonnegative(route.returnDurationSeconds))
            ? route.durationSeconds + (estimatedDuration ? route.durationSeconds : route.returnDurationSeconds) : null;
        const entry = { id: station.id, valid: true, fuelPricePerLiter, outboundKm: route.distanceKm,
            roundTripKm, estimatedRoundTrip, roundTripDurationSeconds, estimatedDuration,
            travelFuelLiters, travelFuelCost, wearCost, travelCost, refuelCost, totalCost: refuelCost + travelCost };
        byStationId[station.id] = entry;
        valid.push(entry);
    }
    const reference = [...valid].sort((a, b) => a.outboundKm - b.outboundKm || String(a.id).localeCompare(String(b.id)))[0];
    valid.sort((a, b) => a.totalCost - b.totalCost || a.roundTripKm - b.roundTripKm || String(a.id).localeCompare(String(b.id)));
    for (const entry of valid) entry.savings = reference.totalCost - entry.totalCost;
    return { fuel, refuelLiters: liters, start: routes?.start ?? null, calculatedAt: routes?.calculatedAt ?? null,
        byStationId, rankedIds: valid.map(entry => entry.id), referenceId: reference?.id ?? null };
}
function euro(value) {
    return value.toLocaleString("de-AT", { style: "currency", currency: "EUR" });
}
function kostenHtml(id) {
    const k = kostenErgebnisse.byStationId[id];
    if (!k) return "";
    const fuelLabel = selectedFuel === "diesel" ? "Diesel" : "Benzin";
    const literpreis = k.fuelPricePerLiter === null ? "Keine Angabe" : `${preis(k.fuelPricePerLiter)}/l`;
    const kopf = `<p class="kosten-literpreis">${fuelLabel}: <strong>${literpreis}</strong></p>`;
    if (!k.valid) return `${kopf}<p class="kosten-hinweis">${escapeHtml(k.reason)}</p>`;
    const beste = kostenErgebnisse.rankedIds[0] === id;
    const referenz = kostenErgebnisse.referenceId === id;
    let vergleich;
    if (referenz) vergleich = "Referenz: nächstgelegene Tankstelle";
    else if (k.savings > 0) vergleich = `${euro(k.savings)} günstiger als die nächstgelegene Tankstelle`;
    else if (k.savings < 0) vergleich = `${euro(-k.savings)} teurer als die nächstgelegene Tankstelle`;
    else vergleich = "Gleiche Gesamtkosten wie die nächstgelegene Tankstelle";
    const minutenGesamt = k.roundTripDurationSeconds > 0 && k.roundTripDurationSeconds < 60 ? "&lt; 1" : Math.round(k.roundTripDurationSeconds / 60);
    const zeit = k.roundTripDurationSeconds === null ? "Fahrzeit nicht verfügbar" : `ca. ${minutenGesamt} Min. für Hin- und Rückfahrt${k.estimatedDuration ? " (geschätzt: doppelte Hinfahrt)" : " (ohne Echtzeitverkehr)"}`;
    return `${kopf}${beste ? '<p class="kosten-beste">Günstigste Option inklusive Fahrt</p>' : ''}
        <dl class="kosten-zeilen"><div><dt>Hin- und Rückstrecke</dt><dd>${k.roundTripKm.toLocaleString("de-AT", { maximumFractionDigits: 1 })} km</dd></div>
        <div><dt>Tankkosten (${selectedRefuelLiters} l)</dt><dd>${euro(k.refuelCost)}</dd></div>
        <div><dt>Fahrtkosten insgesamt</dt><dd>${euro(k.travelCost)}</dd></div>
        <div class="kosten-gesamt"><dt>Gesamtkosten</dt><dd>${euro(k.totalCost)}</dd></div></dl>
        <p class="kosten-hinweis">${k.estimatedRoundTrip ? 'Hin- und Rückweg geschätzt · doppelte Hinfahrt. Rückwege können wegen Einbahnstraßen abweichen.' : 'Hin- und Rückweg getrennt berechnet.'} ${zeit}</p>
        <p class="kosten-ersparnis">${vergleich}</p>
        <details class="kosten-details"><summary>Fahrtkosten im Detail</summary><p>Fahrtverbrauch: ${k.travelFuelLiters.toLocaleString("de-AT", { maximumFractionDigits: 3 })} l<br>Sprit: ${euro(k.travelFuelCost)}<br>Verschleiß: ${euro(k.wearCost)}</p></details>`;
}
const fuelSelect = document.getElementById("kraftstoff");
const literSlider = document.getElementById("tankmenge-slider");
const literInput = document.getElementById("tankmenge-zahl");
const literOutput = document.getElementById("tankmenge-wert");
const literFehler = document.getElementById("tankmenge-fehler");
selectedFuel = ["benzin", "diesel"].includes(fuelSelect.value) ? fuelSelect.value : "benzin";
fuelSelect.value = selectedFuel;
function setzeTankmenge(value) {
    selectedRefuelLiters = value;
    literSlider.value = String(value);
    literInput.value = String(value);
    literOutput.textContent = `${value} Liter`;
    literFehler.textContent = "";
    literInput.setAttribute("aria-invalid", "false");
}
setzeTankmenge(COST_MODEL.defaultRefuelLiters);
fuelSelect.addEventListener("change", () => {
    if (!["benzin", "diesel"].includes(fuelSelect.value)) return;
    selectedFuel = fuelSelect.value;
    aktualisiereRoutenAnzeige();
});
literSlider.addEventListener("input", () => {
    setzeTankmenge(Number(literSlider.value));
    aktualisiereRoutenAnzeige();
});
literInput.addEventListener("input", () => {
    const value = Number(literInput.value);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
        literFehler.textContent = `Bitte 1 bis 100 ganze Liter eingeben. Der Vergleich verwendet weiterhin ${selectedRefuelLiters} Liter.`;
        literInput.setAttribute("aria-invalid", "true");
        return;
    }
    setzeTankmenge(value);
    aktualisiereRoutenAnzeige();
});
literInput.addEventListener("change", () => {
    if (!Number.isInteger(Number(literInput.value)) || Number(literInput.value) < 1 || Number(literInput.value) > 100) setzeTankmenge(selectedRefuelLiters);
});
