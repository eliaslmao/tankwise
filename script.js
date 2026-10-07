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
function adressFehler(text) {
    const feld = document.getElementById("adress-fehler");
    feld.textContent = text;
    feld.hidden = !text;
    adressInput.setAttribute("aria-invalid", String(Boolean(text)));
    if (text) {
        hausnummerVorschlag.hidden = true;
        routenStatus.textContent = "";
    }
}
function verwerfeAlteRouten() {
    adressFehler("");
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
        if (!data.candidates.length) { adressFehler(data.message || "Straße oder Hausnummer nicht gefunden. Bitte die Eingabe prüfen."); return; }
        if (data.candidates.length === 1 && data.candidates[0].addressConfirmed) {
            await berechneRouten(data.candidates[0], version);
            return;
        }
        // Nur bei mehreren möglichen Standorten ist noch eine Auswahl erforderlich.
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
    const zeit = k.roundTripDurationSeconds === null ? "Fahrzeit nicht verfügbar" : `ca. ${minutenGesamt} Min. für Hin- und Rückfahrt${k.estimatedDuration ? " (geschätzt)" : ""}`;
    return `${kopf}${beste ? '<p class="kosten-beste">Günstigste Option inklusive Fahrt</p>' : ''}
        <dl class="kosten-zeilen"><div><dt>Hin- und Rückstrecke${k.estimatedRoundTrip ? " (geschätzt)" : ""}</dt><dd>${k.roundTripKm.toLocaleString("de-AT", { maximumFractionDigits: 1 })} km</dd></div>
        <div><dt>Tankkosten (${selectedRefuelLiters} l)</dt><dd>${euro(k.refuelCost)}</dd></div>
        <div><dt>Fahrtkosten insgesamt</dt><dd>${euro(k.travelCost)}</dd></div>
        <div class="kosten-gesamt"><dt>Gesamtkosten</dt><dd>${euro(k.totalCost)}</dd></div></dl>
        <p class="kosten-hinweis">${zeit}</p>
        <p class="kosten-ersparnis">${vergleich}</p>`;
}
const fuelSelect = document.getElementById("kraftstoff");
const literSlider = document.getElementById("tankmenge-slider");
const literInput = document.getElementById("tankmenge-zahl");
const literOutput = document.getElementById("tankmenge-wert");
const literFehler = document.getElementById("tankmenge-fehler");
selectedFuel = document.getElementById("kraftstoff-diesel").checked ? "diesel" : "benzin";
fuelSelect.value = selectedFuel;
function setzeTankmenge(value) {
    selectedRefuelLiters = value;
    literSlider.value = String(value);
    literSlider.setAttribute("style", `--slider-fill: ${(value - 1) / 99 * 100}%`);
    literInput.value = String(value);
    literOutput.textContent = `${value} Liter`;
    literFehler.textContent = "";
    literInput.setAttribute("aria-invalid", "false");
}
setzeTankmenge(COST_MODEL.defaultRefuelLiters);
fuelSelect.addEventListener("change", event => {
    if (event?.target?.name === "kraftstoff") fuelSelect.value = event.target.value;
    if (!["benzin", "diesel"].includes(fuelSelect.value)) return;
    selectedFuel = fuelSelect.value;
    document.getElementById("kraftstoff-benzin").checked = selectedFuel === "benzin";
    document.getElementById("kraftstoff-diesel").checked = selectedFuel === "diesel";
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


// Lokaler Auszug ADRESSENOGD, GEB_BEZIRK=21; Stadt Wien – data.wien.gv.at.
// Stand 01.10.2026. Ausschließlich Straßennamen, keine Hausnummern oder Nutzeradressen.
const STRASSENNAMEN = [
  "Achardgasse",
  "Achengasse",
  "Ackerweg",
  "Aderklaaer Straße",
  "Adolf-Amadeo-Gasse",
  "Adolf-Loos-Gasse",
  "Adolf-Loos-Weg",
  "Adolf-Uthmann-Gasse",
  "Adrienne-Gessner-Gasse",
  "Aistgasse",
  "Albertisgasse",
  "Alfred-Huth-Gasse",
  "Alfred-Nobel-Straße",
  "Allißengasse",
  "Almgasse",
  "Alois-Appel-Hof",
  "Alois-Negrelli-Gasse",
  "Alpiltoweweg",
  "Alte Leopoldauer Schleife",
  "Alter Wiener Weg",
  "Am Bisamberg",
  "Am Bruckhaufen",
  "Am Hubertusdamm",
  "Am Häufel",
  "Am Nordbahndamm",
  "Am Nordwestbahnhof",
  "Am Rollerdamm",
  "Am Spitz",
  "Am Wasserpark",
  "Am oberen Kirchberg",
  "Ampèregasse",
  "Amselgasse",
  "Amtsstraße",
  "An der Schanze",
  "An der Töllerschanze",
  "An der oberen Alten Donau",
  "Andreas-Hofer-Straße",
  "Angelibad",
  "Angerer Straße",
  "Angyalföldstraße",
  "Anichweg",
  "Anna-Boschek-Platz",
  "Anton-Anderer-Platz",
  "Anton-Bosch-Gasse",
  "Anton-Böck-Gasse",
  "Anton-Dengler-Gasse",
  "Anton-Haberzeth-Gasse",
  "Anton-Kolig-Gasse",
  "Anton-Schall-Gasse",
  "Anton-Störck-Gasse",
  "Antonie-Lehr-Straße",
  "Arbeiterstrandbadstraße",
  "Arnimgasse",
  "Arnoldgasse",
  "Auckenthalergasse",
  "Audorfgasse",
  "Auerhahngasse",
  "Autokaderstraße",
  "Axel-Corti-Gasse",
  "Babitschgasse",
  "Bahndammweg",
  "Bahnhof Brünner Straße",
  "Bahnhof Floridsdorf",
  "Bahnhof Jedlersdorf",
  "Bahnhof Leopoldau",
  "Bahnhof Siemensstraße",
  "Bahnhof Strandbäder",
  "Bahnhof Strebersdorf",
  "Bahnhofplatz",
  "Bahnsteggasse",
  "Bahnwächterhaus",
  "Baldassgasse",
  "Balgavyweg",
  "Baumberggasse",
  "Baumergasse",
  "Beer-Hofmann-Gasse",
  "Beer-Hofmann-Weg",
  "Bellgasse",
  "Bentheimstraße",
  "Berglergasse",
  "Berlagasse",
  "Bernhard-Bolzano-Gasse",
  "Bernreiterplatz",
  "Bertlgasse",
  "Berzeliusgasse",
  "Berzeliusplatz",
  "Bessemerstraße",
  "Bieler Hof",
  "Birneckergasse",
  "Birnersteig",
  "Blechschmidtgasse",
  "Bodenstedtgasse",
  "Bonitzgasse",
  "Brachsengasse",
  "Breitenweg",
  "Brigittenauer Brücke",
  "Brixweg",
  "Broßmannplatz",
  "Bruckhaufner Hauptstraße",
  "Brunner-Lehenstein-Gasse",
  "Bründelgasse",
  "Brünner Straße",
  "Bubergasse",
  "Bunsengasse",
  "Bussardgasse",
  "Böhmgasse",
  "Börnsteingasse",
  "Büchnergasse",
  "Carabelligasse",
  "Carminweg",
  "Carrogasse",
  "Castlegasse",
  "Christian-Bucher-Gasse",
  "Claudia-Dietl-Platz",
  "Clessgasse",
  "Compars-Herrmann-Weg",
  "Conrad-Lötsch-Hof",
  "Cooperweg",
  "Cordobaplatz",
  "Coulombgasse",
  "Czeija-Nissl-Gasse",
  "Dachsensteig",
  "Dafertgasse",
  "Dag-Hammarskjöld-Hof",
  "Dahliengasse",
  "Dammäckergasse",
  "Danningerweg",
  "Dattlergasse",
  "Demmergasse",
  "Deublergasse",
  "Deutschweg",
  "Diamantgasse",
  "Diderotgasse",
  "Dietz-von-Weidenberg-Gasse",
  "Dirndlgasse",
  "Divischgasse",
  "Doderergasse",
  "Dolézalgasse",
  "Dominik-Hofmann-Halle",
  "Dominik-Wölfel-Gasse",
  "Don-Bosco-Weg",
  "Donaufelder Straße",
  "Donauinsel",
  "Donauinselplatz",
  "Donauturmstraße",
  "Donhofergasse",
  "Dopschstraße",
  "Dr.-Albert-Geßmann-Gasse",
  "Dr.-Nekowitsch-Straße",
  "Dr.-Skala-Straße",
  "Dragonerhäufel",
  "Dragoungasse",
  "Draugasse",
  "Drnekgasse",
  "Drygalskiweg",
  "Dunantgasse",
  "Dückegasse",
  "Ebereschengasse",
  "Edelsteingasse",
  "Edergasse",
  "Edi-Finger-Straße",
  "Edmund-Hawranek-Platz",
  "Egon-Friedell-Gasse",
  "Eichfeldergasse",
  "Einzingergasse",
  "Eipeldauer Straße",
  "Eisenheldgasse",
  "Elise-Richter-Weg",
  "Emmi-Freundlich-Gasse",
  "Empergergasse",
  "Engelhorngasse",
  "Entensteig",
  "Erbpostgasse",
  "Erna-Musik-Gasse",
  "Ernst-Kein-Gasse",
  "Ernst-Theumer-Hof",
  "Ernst-Vasovec-Gasse",
  "Eyblweg",
  "Fahrbachgasse",
  "Fallmerayerweg",
  "Familienbad Luckenschwemmgasse",
  "Familienbad Roda-Roda-Gasse",
  "Feistlgasse",
  "Feistritzgasse",
  "Feldlerchengasse",
  "Feldmausgasse",
  "Felix-Slavik-Straße",
  "Felmayergasse",
  "Ferchenbauergasse",
  "Ferdinand-Kaufmann-Platz",
  "Ferdinand-Käs-Gasse",
  "Ferdinand-Platzer-Gasse",
  "Ferdinand-Pölz-Gasse",
  "Fillenbaumgasse",
  "Fischottergasse",
  "Flandorferweg",
  "Florian-Ott-Gasse",
  "Florido Tower",
  "Floridsdorfer Aupark",
  "Floridsdorfer Bad",
  "Floridsdorfer Hauptstraße",
  "Floridsdorfer Markt",
  "Floridusgasse",
  "Franklinstraße",
  "Franz-Bretschneider-Hof",
  "Franz-Jonas-Platz",
  "Franz-Jonas-Schule",
  "Franz-Koch-Hof",
  "Franz-Petritsch-Hof",
  "Franz-Sebek-Straße",
  "Frauenschuhgasse",
  "Frauenstiftgasse",
  "Freiheitsplatz",
  "Freiligrathplatz",
  "Freytaggasse",
  "Friederike-Klauner-Gasse",
  "Friedhof Jedlesee",
  "Friedhof Leopoldau",
  "Friedhof Stammersdorf-Ort",
  "Friedhof Stammersdorf-Zentral",
  "Friedrich-Manhart-Straße",
  "Friedstraße",
  "Fritz-Kandl-Gasse",
  "Frohes-Schaffen-Weg",
  "Frömmlgasse",
  "Fuchsensteig",
  "Fultonstraße",
  "Funkgasse",
  "Fännergasse",
  "Föhrenweg",
  "Galvanigasse",
  "Garcia-Lorca-Hof",
  "Gaswerk Leopoldau",
  "Gaswerkstraße",
  "Gebauergasse",
  "Georg-Schicht-Platz",
  "Georgistraße",
  "Gerasdorfer Straße",
  "Gerichtsgasse",
  "Gerlosplatz",
  "Gernengasse",
  "Gerspergasse",
  "Gerstlgasse",
  "Giefinggasse",
  "Giseviusgasse",
  "Gitlbauergasse",
  "Glangasse",
  "Gleichsaustraße",
  "Gmündstraße",
  "Grabmayrgasse",
  "Gradingergasse",
  "Graedenergasse",
  "Graedenerweg",
  "Gregor-Ulbrich-Gasse",
  "Grellgasse",
  "Grenzweg",
  "Gretlgasse",
  "Großbauerstraße",
  "Großfeldstraße",
  "Großschopfplatz",
  "Gschweidlgasse",
  "Guschelbauergasse",
  "Gusengasse",
  "Göpfritzgasse",
  "Haberditzlgasse",
  "Habitzlgasse",
  "Hagenbrunner Straße",
  "Hahnemanngasse",
  "Haidschüttgasse",
  "Hanreitergasse",
  "Hans-Czermak-Gasse",
  "Hans-Kutra-Gasse",
  "Hans-Spitzy-Gasse",
  "Hanslgasse",
  "Hartwig-Balzen-Gasse",
  "Haspingerplatz",
  "Hassingergasse",
  "Hasswellgasse",
  "Hawlicekgasse",
  "Hayekgasse",
  "Hedwig-Lehnert-Hof",
  "Heeresspital",
  "Heidenreichsteinweg",
  "Heingasse",
  "Heinrich-Mitteis-Gasse",
  "Heinrich-von-Buol-Gasse",
  "Heinz-Nittel-Hof",
  "Helene-Richter-Gasse",
  "Helmholtzgasse",
  "Henri-Dunant-Schule",
  "Herbstweg",
  "Herchenhahngasse",
  "Heribert-Meisel-Gasse",
  "Hermann-Bahr-Straße",
  "Herrenholzgasse",
  "Hertha-Kräftner-Gasse",
  "Herzmanovsky-Orlando-Gasse",
  "Heuschreckengasse",
  "Hinaysgasse",
  "Hochbahngasse",
  "Hochfeldstraße",
  "Hofherr-Schrantz-Gasse",
  "Holetschekgasse",
  "Holteigasse",
  "Holzmanngasse",
  "Holzmeistergasse",
  "Hopfengasse",
  "Hoßplatz",
  "Hubertusgasse",
  "Hufgasse",
  "Hutterplatz",
  "Höbarthgasse",
  "Hühnersteig",
  "Ichagasse",
  "Ignaz-Köck-Straße",
  "Illgasse",
  "Immengasse",
  "In den Gabrissen",
  "In den kurzen Wiesthalen",
  "In der Schwarzlackenau",
  "In der goldenen Erden",
  "Inge-Konradi-Gasse",
  "Inwaldweg",
  "Irenäusgasse",
  "Iselgasse",
  "Ispergasse",
  "Jandagasse",
  "Jane-Tilden-Gasse",
  "Jara-Benes-Gasse",
  "Jeannie-Ebner-Weg",
  "Jedlersdorfer Platz",
  "Jedlersdorfer Straße",
  "Jedleseer Straße",
  "Jeneweingasse",
  "Jerusalemgasse",
  "Jiricekgasse",
  "Jochbergengasse",
  "Johann-Knoll-Gasse",
  "Johann-Laufner-Gasse",
  "Johann-Orth-Platz",
  "Johann-Orth-Weg",
  "Johann-Treixler-Gasse",
  "Johann-Weber-Straße",
  "Johannes-de-La-Salle-Gasse",
  "Josef-Baumann-Gasse",
  "Josef-Brazdovics-Straße",
  "Josef-Flandorfer-Straße",
  "Josef-Melichar-Gasse",
  "Josef-Ruston-Gasse",
  "Josef-Türk-Gasse",
  "Josef-Wakovsky-Gasse",
  "Josef-Zapf-Gasse",
  "Julius-Ficker-Straße",
  "Julius-Schlegel-Gasse",
  "Justgasse",
  "Jöchlingergrund",
  "Jürgenssenweg",
  "KLG Allissen",
  "KLG Alter Wiener 21",
  "KLG Am Graedenerweg",
  "KLG Am Mühlweg",
  "KLG Am Mühlweg-ÖBB",
  "KLG Am Stadlweg",
  "KLG An der Heingasse",
  "KLG An der Lebnergasse",
  "KLG An der Ruthnergasse",
  "KLG An der Strebersdorfer Straße",
  "KLG An der Thayagasse",
  "KLG An der Töllerschanze",
  "KLG Blumenfreunde",
  "KLG Breuer Siedlung",
  "KLG Dirnelwiese",
  "KLG Donaufelder Kleingärten",
  "KLG Eigengründe nördlich am Petzgrund",
  "KLG Frohes Schaffen",
  "KLG Gartenfreunde Jedlesee",
  "KLG Gisela",
  "KLG Groß Jedlersdorf",
  "KLG Gutfreund",
  "KLG Im Äugel",
  "KLG Im Äugl-Musteranlage",
  "KLG In den oberen Falkenbergen",
  "KLG Katharina Weiß",
  "KLG Kleiner Damm",
  "KLG Leopoldau (Gr.A)",
  "KLG Leopoldau (Gr.SCH)",
  "KLG Leopoldau (Gr.Ö)",
  "KLG Leopoldau Ladestelle",
  "KLG Leopoldau Werk 6",
  "KLG Mautner Markhof",
  "KLG Mitterhofergasse",
  "KLG Obstfreunde",
  "KLG Petzgrund",
  "KLG Pragerstraße",
  "KLG Satzingerweg",
  "KLG Seidlgrund",
  "KLG Semmelweis",
  "KLG Spitzweg",
  "KLG Stammersdorf Gruppe Süd",
  "KLG Stammersdorf Gruppe West",
  "KLG Transit",
  "KLG ÖBB Floridsdorf 2051 (Strandbäder)",
  "KLG ÖBB Floridsdorf 2051 (Unterer Bahnhof)",
  "KLG ÖBB Floridsdorf-Siemensstraße 2063",
  "KLG ÖBB Jedlersdorf 2055",
  "KLG ÖBB Jedlesee 2057",
  "KLG ÖBB Jedlesee-Werkstätte 2071",
  "KLG ÖBB Landwirtschaft (Gr.95)",
  "KLG ÖBB Schererstraße",
  "KLG Ödenburgerstraße",
  "KLG östlich Ruthnergasse 109",
  "Kaftangasse",
  "Kahlgasse",
  "Kainachgasse",
  "Kaingasse",
  "Kallbrunnergasse",
  "Kallusweg",
  "Kalsergasse",
  "Kammelweg",
  "Kannweg",
  "Kantnergasse",
  "Karl-Aschenbrenner-Gasse",
  "Karl-Benz-Weg",
  "Karl-Biedermann-Gasse",
  "Karl-Gramm-Gasse",
  "Karl-Heinz-Hof",
  "Karl-Humenberger-Gasse",
  "Karl-Lothringer-Straße",
  "Karl-Nieschlag-Gasse",
  "Karl-Schott-Gasse",
  "Karl-Schäfer-Straße",
  "Karl-Seitz-Hof",
  "Karl-Seitz-Platz",
  "Karl-Waldbrunner-Platz",
  "Kastnersiedlung",
  "Katharina-Scheiter-Gasse",
  "Katsushikastraße",
  "Kefedergrundgasse",
  "Kendegasse",
  "Kerpengasse",
  "Keynesgasse",
  "Kinzerplatz",
  "Kirchhoffgasse",
  "Kishonweg",
  "Klagergasse",
  "Kleinhausgasse",
  "Klemmweg",
  "Klingenbachgasse",
  "Klinik Floridsdorf",
  "Klugerhof",
  "Knaackgasse",
  "Knöfelgasse",
  "Kollarzgasse",
  "Koloniestraße",
  "Kommunikationsplatz",
  "Kormorangasse",
  "Koschakergasse",
  "Koschiergasse",
  "Kramreitergasse",
  "Kravoglgasse",
  "Kreuzfeldgasse",
  "Krottenhofgasse",
  "Kuenburggasse",
  "Kugelfanggasse",
  "Kuhschellenweg",
  "Kummergasse",
  "Königsteingasse",
  "Kürschnergasse",
  "Lafnitzgasse",
  "Lamarckgasse",
  "Lammaschgasse",
  "Langenzersdorfer Straße",
  "Langfeldgasse",
  "Lavantgasse",
  "Lazarsfeldgasse",
  "Lebnergasse",
  "Lehnertgasse",
  "Leopold-Ferstl-Gasse",
  "Leopold-Stroh-Sportanlage",
  "Leopoldauer Platz",
  "Leopoldauer Straße",
  "Leopoldauer-Haide-Gasse",
  "Leopoldine-Padaurek-Straße",
  "Leuchsweg",
  "Lhotskygasse",
  "Liebleitnergasse",
  "Lieleggweg",
  "Liesneckgasse",
  "Linke Nordbahngasse",
  "Lisseeweg",
  "Litschauweg",
  "Lohnergasse",
  "Lokomotivgasse",
  "Lorettoplatz",
  "Lormweg",
  "Loschmidtgasse",
  "Lottgasse",
  "Louis-Häfliger-Gasse",
  "Loulagasse",
  "Lovaraweg",
  "Luckenholzgasse",
  "Luckenschwemmgasse",
  "Lundenburger Gasse",
  "Luschingasse",
  "Maigasse",
  "Maisgasse",
  "Mallygasse",
  "Malvengasse",
  "Marco-Polo-Platz",
  "Margarete-Schütte-Lihotzky-Hof",
  "Marianne-und-Oskar-Pollak-Hof",
  "Marie-Lang-Weg",
  "Marinonigasse",
  "Marischkapromenade",
  "Marksteinergasse",
  "Martha-Steffy-Browne-Gasse",
  "Martin-Gaunersdorfer-Gasse",
  "Maschkangasse",
  "Matthias-Ernst-Pista-Gasse",
  "Matthias-Wagner-Gasse",
  "Matthäus-Jiszda-Straße",
  "Maulwurfgasse",
  "Max-Jellinek-Gasse",
  "Maximilian-Reich-Weg",
  "Maxwellgasse",
  "Mayerweckstraße",
  "Meistergasse",
  "Mengergasse",
  "Menzelstraße",
  "Meriangasse",
  "Meyerbeergasse",
  "Michael-Dietmann-Gasse",
  "Michael-Res'-Gasse",
  "Michtnergasse",
  "Mihatschgasse",
  "Miklosichgasse",
  "Milo-Dor-Weg",
  "Mitterhofergasse",
  "Mizzi-Günther-Weg",
  "Mondsteinstraße",
  "Morelligasse",
  "Morettigasse",
  "Moritz-Dreger-Gasse",
  "Morsegasse",
  "Mosheimergasse",
  "Motesiczkyweg",
  "Möllplatz",
  "Mörthgasse",
  "Mühlschüttelgasse",
  "Mühlweg",
  "Nekulagasse",
  "Neudorfergasse",
  "Neulandweg",
  "Neusatzgasse",
  "Nicole-Fontaine-Gasse",
  "Nikolsburger Gasse",
  "Norbert-Krebs-Gasse",
  "Nordbahnanlage",
  "Nordmanngasse",
  "Novigasse",
  "O'Brien-Gasse",
  "Obere Jungenberggasse",
  "Obergfellplatz",
  "Oberhummergasse",
  "Ocwirkgasse",
  "Oellacherweg",
  "Ohmgasse",
  "Opalgasse",
  "Orasteig",
  "Orelgasse",
  "Osergasse",
  "Oskar-Czeija-Gasse",
  "Oskar-Grissemann-Straße",
  "Oskar-Helmer-Hof",
  "Ostmarkgasse",
  "Oswald-Redlich-Straße",
  "Ottilie-Bondy-Promenade",
  "Otto-Beyschlag-Gasse",
  "Otto-Storch-Gasse",
  "Owengasse",
  "Pastorstraße",
  "Patriagasse",
  "Patrizigasse",
  "Paukerwerkstraße",
  "Paul-Grüninger-Schule",
  "Paul-Hopfner-Gasse",
  "Paul-Speiser-Hof",
  "Pavlicekgasse",
  "Peitlgasse",
  "Penkgasse",
  "Peter-Berner-Straße",
  "Peter-Kaiser-Gasse",
  "Petritschgasse",
  "Pfarrer-Matz-Gasse",
  "Pfarrer-Pasecker-Gasse",
  "Pfendlergasse",
  "Pichelwangergasse",
  "Pilzgasse",
  "Pinkagasse",
  "Pitkagasse",
  "Pius-Parsch-Platz",
  "Plankenbüchlergasse",
  "Platzergasse",
  "Prager Straße",
  "Pregartengasse",
  "Preßburger Gasse",
  "Prießnitzgasse",
  "Puffergasse",
  "Pulkaugasse",
  "Puschkingasse",
  "Puschmanngasse",
  "Quarzweg",
  "Rabnitzweg",
  "Ragwurzgasse",
  "Rappgasse",
  "Rasmussengasse",
  "Rathmayergasse",
  "Ratzenhofergasse",
  "Rautenkranzgasse",
  "Rechte Nordbahngasse",
  "Redlweg",
  "Regnerweg",
  "Rehgasse",
  "Reisgasse",
  "Richard-Neutra-Gasse",
  "Rieglgasse",
  "Rihosekgasse",
  "Ringelseegasse",
  "Rittingergasse",
  "Robert-Dienst-Gasse",
  "Robert-Lach-Gasse",
  "Roda-Roda-Gasse",
  "Roggegasse",
  "Roman-Felleis-Gasse",
  "Romaplatz",
  "Rosa-Wien-Gasse",
  "Rosannagasse",
  "Rosenblattgasse",
  "Rosenzeile",
  "Rubingasse",
  "Rudolf-Hitzinger-Hof",
  "Rudolf-Raschke-Gasse",
  "Rudolf-Schön-Weg",
  "Rudolf-Virchow-Straße",
  "Rudolf-Zöhrer-Weg",
  "Ruppweg",
  "Ruth-Brinkmann-Gasse",
  "Ruthnergasse",
  "Rußbergstraße",
  "Röllgasse",
  "SDL Donaufeld",
  "SDL Dragonerhäufel",
  "SDL Drnekweg",
  "SP-Union Landhaus",
  "Salamandergasse",
  "Salomongasse",
  "Salvigasse",
  "Sandauergasse",
  "Sandrockgasse",
  "Sandthalenstraße",
  "Sandtnergasse",
  "Satzingerweg",
  "Scheffelstraße",
  "Schenkendorfgasse",
  "Schererstraße",
  "Scheydgasse",
  "Schichtweg",
  "Schillgasse",
  "Schippergasse",
  "Schleidengasse",
  "Schleifgasse",
  "Schliemanngasse",
  "Schlimpweg",
  "Schlingerhof",
  "Schlossergasse",
  "Schloßhofer Straße",
  "Schnorrgasse",
  "Schotterfeldweg",
  "Schuchardtstraße",
  "Schulzgasse",
  "Schumpeterweg",
  "Schwaigergasse",
  "Schwanngasse",
  "Schwarzenauweg",
  "Schwarzer Weg",
  "Schwemmäckergasse",
  "Schönthalergasse",
  "Schöpfleuthnergasse",
  "Scottgasse",
  "Sebaldgasse",
  "Sebastian-Kohl-Gasse",
  "Selma-Steinmetz-Gasse",
  "Semmelweisgasse",
  "Senderstraße",
  "Seyringer Straße",
  "Shuttleworthstraße",
  "Siegfried-Marcus-Schule",
  "Siegfriedgasse",
  "Siemensplatz",
  "Siemensstraße",
  "Siemensweg",
  "Sildgasse",
  "Simmelgasse",
  "Simone-Veil-Gasse",
  "Sinawastingasse",
  "Sintiweg",
  "Skraupstraße",
  "Smaragdgasse",
  "Sommerweg",
  "Sonderadresse 21.Bezirk",
  "Sorgenthalgasse",
  "Sowinetzgasse",
  "Spanngasse",
  "Sperbergasse",
  "Spitzweg",
  "Sportplatz Donaufeld",
  "Sportplatz Nord Wien",
  "Sportplatz Wasserpark-WAT 21",
  "Sportweg",
  "Spundagasse",
  "Spöttlgasse",
  "St.-Michael-Gasse",
  "Staackmanngasse",
  "Stadlweg",
  "Stammersdorfer Kellergasse",
  "Stammersdorfer Straße",
  "Steidlgasse",
  "Steinamangergasse",
  "Steinbügelweg",
  "Steinheilgasse",
  "Stephensongasse",
  "Stooßgasse",
  "Stowassergasse",
  "Strandgasse",
  "Strebersdorfer Platz",
  "Strebersdorfer Straße",
  "Strohbogasse",
  "Stromkilometer",
  "Stryeckgasse",
  "Stöhrgasse",
  "Sumpfgasse",
  "Sölchgasse",
  "Tauschekgasse",
  "Tetmajergasse",
  "Thayagasse",
  "Theodor-Körner-Gasse",
  "Theumermarkt",
  "Thomagasse",
  "Tiefweg",
  "Tilakstraße",
  "Tomaschekstraße",
  "Tonfabrikgasse",
  "Topasplatz",
  "Trauzlgasse",
  "Triestinggasse",
  "Trillergasse",
  "Trisannagasse",
  "Tschaikowskygasse",
  "Tschechowgasse",
  "Tulzergasse",
  "Töllergasse",
  "Türkenbundweg",
  "Türkisgasse",
  "U-Bahn Station Aderklaaer Straße",
  "U-Bahn Station Großfeldsiedlung",
  "U-Bahn Station Leopoldau",
  "U-Bahn Station Neue Donau",
  "U-Bahn Station Zentrum Floridsdorf",
  "Uhlirzgasse",
  "Uhugasse",
  "Untere Jungenberggasse",
  "Untere Sätzen",
  "Verbindungsweg",
  "Veterinärplatz",
  "Viaduktbogen Thayagasse",
  "Viehtriftgasse",
  "Voglgasse",
  "Vohburggasse",
  "Voltagasse",
  "Voltelinistraße",
  "Wacholderweg",
  "Wagramer Straße",
  "Walkergasse",
  "Wallnerweg",
  "Waltenbergergasse",
  "Walter-Schwarzacher-Gasse",
  "Wankläckergasse",
  "Wannemachergasse",
  "Warhanekgasse",
  "Wassermanngasse",
  "Wasserpark",
  "Wedekindgasse",
  "Weilandgasse",
  "Weinlich-Amann-Gasse",
  "Weinsteiggasse",
  "Weisselgasse",
  "Weißenwolffgasse",
  "Weißingergasse",
  "Wenhartgasse",
  "Werndlgasse",
  "Werndlhof",
  "Wettsteingasse",
  "Wiener Gasse",
  "Wildbadgasse",
  "Wildgänsegasse",
  "Wildnergasse",
  "Wilhelm-Raab-Gasse",
  "Winkeläckerstraße",
  "Winkeläckerweg",
  "Winterweg",
  "Wohlfahrtsweg",
  "Wolfersgrünweg",
  "Wolfgang-Riese-Gasse",
  "Wolfsschanzengasse",
  "Wolsteingasse",
  "Yehudi-Menuhin-Weg",
  "Zallingergasse",
  "Zaunscherbgasse",
  "Zehdengasse",
  "Zeilingerweg",
  "Zelkinggasse",
  "Ziegelofenweg",
  "Znaimer Gasse",
  "Zukunftsweg",
  "Zwerchbreitelngasse",
  "Äugelgasse",
  "Ödenburger Straße",
  "Überfuhrstraße"
];
const strassenDropdown = document.getElementById("strassen-vorschlaege");
let strassenTreffer = [];
let aktiverStrassenIndex = -1;
function strassenSuchwert(text) {
    return normalisiere(text).replace(/\s+/g, "");
}
function passendeStrassen(eingabe) {
    const text = strassenSuchwert(eingabe);
    if (!text) return [];
    return STRASSENNAMEN.filter(name => strassenSuchwert(name).includes(text))
        .sort((a, b) => Number(strassenSuchwert(b).startsWith(text)) - Number(strassenSuchwert(a).startsWith(text)) || a.localeCompare(b, "de-AT"))
        .slice(0, 8);
}
function schliesseStrassenVorschlaege() {
    strassenDropdown.hidden = true;
    aktiverStrassenIndex = -1;
    adressInput.setAttribute("aria-expanded", "false");
    adressInput.removeAttribute("aria-activedescendant");
}
function waehleStrasse(name) {
    verwerfeAlteRouten();
    adressInput.value = name;
    aktualisiereHausnummerHinweis();
    adressInput.focus();
    schliesseStrassenVorschlaege();
}
function zeigeStrassenVorschlaege() {
    strassenTreffer = passendeStrassen(adressInput.value);
    strassenDropdown.replaceChildren();
    aktiverStrassenIndex = -1;
    adressInput.removeAttribute("aria-activedescendant");
    if (!strassenTreffer.length) { schliesseStrassenVorschlaege(); return; }
    strassenTreffer.forEach((name, index) => {
        const option = document.createElement("button");
        option.type = "button";
        option.id = `strassen-option-${index}`;
        option.className = "strassen-option";
        option.tabIndex = -1;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", "false");
        option.textContent = name;
        // Fokus bleibt im Eingabefeld, sodass auch ein Mausklick zuverlässig auswählt.
        option.addEventListener("mousedown", event => event.preventDefault());
        option.addEventListener("click", () => waehleStrasse(name));
        strassenDropdown.append(option);
    });
    strassenDropdown.hidden = false;
    adressInput.setAttribute("aria-expanded", "true");
}
adressInput.addEventListener("input", zeigeStrassenVorschlaege);
adressInput.addEventListener("focus", zeigeStrassenVorschlaege);
adressInput.addEventListener("blur", event => {
    if (!strassenDropdown.contains(event.relatedTarget)) schliesseStrassenVorschlaege();
});
adressInput.addEventListener("keydown", event => {
    if (event.key === "Escape") { schliesseStrassenVorschlaege(); return; }
    if (strassenDropdown.hidden) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const count = strassenTreffer.length;
        aktiverStrassenIndex = (aktiverStrassenIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
        Array.from(strassenDropdown.children).forEach((option, index) => {
            option.setAttribute("aria-selected", String(index === aktiverStrassenIndex));
        });
        const active = strassenDropdown.children[aktiverStrassenIndex];
        adressInput.setAttribute("aria-activedescendant", active.id);
        active.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && aktiverStrassenIndex >= 0) {
        event.preventDefault();
        waehleStrasse(strassenTreffer[aktiverStrassenIndex]);
    }
});
routenForm.addEventListener("submit", schliesseStrassenVorschlaege);


// Reale Beispieladressen aus dem vorhandenen Tankstellen-Datensatz.
const ADRESS_BEISPIELE = [
    ["Brünner Straße", "420"], ["Prager Straße", "138"],
    ["Wagramer Straße", "179"], ["Einzingergasse", "2"],
    ["Siemensstraße", "105b"], ["Shuttleworthstraße", "10"],
    ["Donaufelder Straße", "135"], ["Leopoldauer Straße", "40"]
];
const hausnummerVorschlag = document.getElementById("hausnummer-vorschlag");
const hausnummerPraefix = document.getElementById("hausnummer-praefix");
const hausnummerBeispiel = document.getElementById("hausnummer-beispiel");
const VORSCHLAG_INTERVALL_MS = 1750;
let letztesAdressBeispiel = -1;
let hinweisStrasse = null;
let hinweisNummer = null;
function wechsleAdressBeispiel() {
    if (adressInput.value || document.hidden) return;
    // Keine direkte Wiederholung der zuletzt gezeigten Adresse.
    let index = Math.floor(Math.random() * (ADRESS_BEISPIELE.length - 1));
    if (index >= letztesAdressBeispiel) index++;
    index %= ADRESS_BEISPIELE.length;
    letztesAdressBeispiel = index;
    const [strasse, nummer] = ADRESS_BEISPIELE[index];
    adressInput.placeholder = `${strasse} ${nummer}, 1210 Wien`;
}
function aktualisiereHausnummerHinweis(wechseln = false) {
    const wert = adressInput.value;
    const strasse = STRASSENNAMEN.find(name => strassenSuchwert(name) === strassenSuchwert(wert));
    hausnummerVorschlag.hidden = !strasse;
    if (!strasse) { hinweisStrasse = null; hinweisNummer = null; return; }
    // Nur ein visueller Eingabehinweis. Keine Übernahme in den Wert oder die API-Anfrage.
    const beispiel = ADRESS_BEISPIELE.find(([name]) => strassenSuchwert(name) === strassenSuchwert(strasse));
    if (hinweisStrasse !== strasse) {
        hinweisStrasse = strasse;
        hinweisNummer = beispiel ? beispiel[1] : "12";
    } else if (wechseln === true) {
        // Illustrative Hausnummern, keine bestätigten Adressen und keine automatische Übernahme.
        const nummern = ["2", "7", "12", "18", "24", "35"].filter(n => n !== hinweisNummer);
        hinweisNummer = nummern[Math.floor(Math.random() * nummern.length)];
    }
    hausnummerPraefix.textContent = wert;
    hausnummerBeispiel.textContent = `${/\s$/.test(wert) ? "" : " "}${hinweisNummer}`;
    hausnummerPraefix.parentElement?.scrollTo({ left: adressInput.scrollLeft || 0 });
}
adressInput.addEventListener("input", aktualisiereHausnummerHinweis);
adressInput.addEventListener("scroll", aktualisiereHausnummerHinweis);
wechsleAdressBeispiel();
function wechsleGrauenVorschlag() {
    if (document.hidden) return;
    if (!adressInput.value) wechsleAdressBeispiel();
    else aktualisiereHausnummerHinweis(true);
}
setInterval(wechsleGrauenVorschlag, VORSCHLAG_INTERVALL_MS);


// Erläuterung im Footer folgt denselben Parametern wie die Berechnung.
document.getElementById("modell-verbrauch").textContent = COST_MODEL.consumptionLitersPer100Km.toLocaleString("de-AT");
document.getElementById("modell-verschleiss").textContent = euro(COST_MODEL.wearCostPerKm);
