let alleTankstellen = [];


// Karte von Wien erstellen
const wienKarte = L.map("karte").setView([48.2082, 16.3738], 12);

// Kartenbilder von basemap.at (offizielle Grundkarte Österreichs, frei nutzbar)
L.tileLayer("https://mapsneu.wien.gv.at/basemap/geolandbasemap/normal/google3857/{z}/{y}/{x}.png", {
    maxZoom: 19,
    attribution: 'Datenquelle: <a href="https://basemap.at">basemap.at</a>'
}).addTo(wienKarte);

// Ebene für alle Pinnadeln (kann bei der Suche geleert werden).
// Nahe Pinnadeln werden zu einer Gruppe mit dem günstigsten Dieselpreis zusammengefasst.
const pinEbene = L.markerClusterGroup({
    maxClusterRadius: 70,
    iconCreateFunction: function(gruppe) {

        const dieselPreise = gruppe.getAllChildMarkers()
            .map(pin => pin.tankstelle.preise.diesel)
            .filter(preis => preis !== null);

        let text = "";

        if (dieselPreise.length > 0) {
            text = `D ab ${Math.min(...dieselPreise).toFixed(3)} €`;
        }

        return L.divIcon({
            className: "pin-gruppe",
            html: `<div><strong>${gruppe.getChildCount()}</strong><span>${text}</span></div>`,
            iconSize: null
        });
    }
}).addTo(wienKarte);


// Preis schön formatieren, fehlender Preis wird als "–" angezeigt
function preisText(preis) {
    if (preis === null) {
        return "–";
    }

    return preis.toFixed(3) + " €";
}

// JSON-Datei laden
fetch("./tankstellen.json")
    .then(response => {
        if (!response.ok) {
            throw new Error("JSON-Datei konnte nicht geladen werden");
        }

        return response.json();
    })
    .then(daten => {
        console.log("Geladene Daten:", daten);

        alleTankstellen = daten.tankstellen;

        document.getElementById("stand").textContent =
            `${alleTankstellen.length} Tankstellen · Preise vom ${daten.stand} · Quelle: ${daten.quelle}`;

        zeigeTankstellen(alleTankstellen);
        zeigePinnadeln(alleTankstellen);
    })
    .catch(fehler => {
        console.error("Fehler beim Laden:", fehler);

        let meldung = "<p>Tankstellen konnten nicht geladen werden.</p>";

        // Direkt als Datei geöffnet: der Browser blockiert fetch()
        if (location.protocol === "file:") {
            meldung += "<p>Bitte die Seite über einen lokalen Server öffnen, z. B. mit <code>python3 -m http.server</code> und dann http://localhost:8000</p>";
        }

        document.getElementById("tankstellen-liste").innerHTML = meldung;
    });


// Tankstellen anzeigen
function zeigeTankstellen(tankstellen) {

    const liste = document.getElementById("tankstellen-liste");

    liste.innerHTML = "";

    tankstellen.forEach(tankstelle => {

        let ausstattung = "";

        if (tankstelle.ausstattung.waschbox) {
            ausstattung += `<span class="badge">🚗 Waschbox</span>`;
        }

        if (tankstelle.ausstattung.wc) {
            ausstattung += `<span class="badge">🚻 WC</span>`;
        }

        if (tankstelle.ausstattung.staubsauger) {
            ausstattung += `<span class="badge">🧹 Staubsauger</span>`;
        }

        if (tankstelle.ausstattung.luftpumpe) {
            ausstattung += `<span class="badge">💨 Luftpumpe</span>`;
        }

        const karte = `
            <div class="tankstelle">

                <div class="tankstelle-header">
                    <h3>${tankstelle.name}</h3>

                    <span class="kette">
                        ${tankstelle.kette}
                    </span>
                </div>

                <div class="preise">

                    <div class="preis">
                        <span>Diesel</span>

                        <strong>
                            ${preisText(tankstelle.preise.diesel)}
                        </strong>
                    </div>

                    <div class="preis">
                        <span>Benzin</span>

                        <strong>
                            ${preisText(tankstelle.preise.benzin)}
                        </strong>
                    </div>

                </div>

                <p class="info">
                    📍 ${tankstelle.adresse}
                </p>

                <p class="info">
                    🕒 ${tankstelle.geoeffnet ? "Jetzt geöffnet" : "Derzeit geschlossen"}
                </p>

                <p class="info">
                    👤 Bemannt:
                    ${tankstelle.bemannt ? "Ja" : "Nein"}
                </p>

                <p class="info">
                    ⛽ Tankautomat:
                    ${tankstelle.tankautomat ? "Ja" : "Nein"}
                </p>

                <div class="ausstattung">
                    ${ausstattung}
                </div>

            </div>
        `;

        liste.innerHTML += karte;
    });
}


// Suchfunktion
document
    .getElementById("suche")
    .addEventListener("input", function() {

        const suchtext = this.value.toLowerCase();

        const ergebnis = alleTankstellen.filter(tankstelle => {
            return (
                tankstelle.name.toLowerCase().includes(suchtext) ||
                tankstelle.kette.toLowerCase().includes(suchtext) ||
                tankstelle.adresse.toLowerCase().includes(suchtext)
            );
        });

        zeigeTankstellen(ergebnis);
        zeigePinnadeln(ergebnis);
    });


// Pinnadeln mit Preisen auf der Karte anzeigen
function zeigePinnadeln(tankstellen) {

    pinEbene.clearLayers();

    tankstellen.forEach(tankstelle => {

        const position = [
            tankstelle.koordinaten.latitude,
            tankstelle.koordinaten.longitude
        ];

        // Pinnadel mit Preisschild
        const pin = L.divIcon({
            className: "pin",
            html: `
                <div class="pin-schild">
                    <span>D ${preisText(tankstelle.preise.diesel)}</span>
                    <span>B ${preisText(tankstelle.preise.benzin)}</span>
                </div>
            `,
            iconSize: null,
            iconAnchor: [45, 48]
        });

        const marker = L.marker(position, { icon: pin })
            .bindPopup(`
                <strong>${tankstelle.name}</strong><br>
                ${tankstelle.adresse}<br>
                Diesel: ${preisText(tankstelle.preise.diesel)}<br>
                Benzin: ${preisText(tankstelle.preise.benzin)}
            `);

        // Tankstelle am Pin merken, damit die Gruppe den günstigsten Preis findet
        marker.tankstelle = tankstelle;

        pinEbene.addLayer(marker);
    });
}