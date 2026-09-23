let alleTankstellen = [];

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
        zeigeTankstellen(alleTankstellen);
    })
    .catch(fehler => {
        console.error("Fehler beim Laden:", fehler);

        document.getElementById("tankstellen-liste").innerHTML =
            "<p>Tankstellen konnten nicht geladen werden.</p>";
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
                            ${tankstelle.preise.diesel.toFixed(3)} €
                        </strong>
                    </div>

                    <div class="preis">
                        <span>Benzin</span>

                        <strong>
                            ${tankstelle.preise.benzin.toFixed(3)} €
                        </strong>
                    </div>

                </div>

                <p class="info">
                    ⭐ ${tankstelle.bewertung.durchschnittsbewertung}
                    (${tankstelle.bewertung.anzahlBewertungen} Bewertungen)
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
                tankstelle.kette.toLowerCase().includes(suchtext)
            );
        });

        zeigeTankstellen(ergebnis);
    });