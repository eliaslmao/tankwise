# Tankstellen finder – lokal starten

Die bestehende Karte, die 23 Tankstellen, Preise, Pins und Suchfunktion bleiben erhalten. Zusätzlich kannst du eine Startadresse in Floridsdorf auswählen und die Autostrecken zu allen Tankstellen berechnen.

## 1. Node.js vorbereiten

Du benötigst **Node.js ab Version 22** mit npm. Falls `node --version` oder `npm --version` nicht funktioniert, installiere Node.js von https://nodejs.org/ und öffne das Terminal danach neu.

## 2. Lokalen Schlüssel eintragen

Im Terminal:

```sh
cd "$HOME/Desktop/Tankstellen app"
cp -n .env.example .env
```

Öffne nun die Datei `.env` in VS Code (versteckte Dateien werden dort im Explorer angezeigt). Ersetze ausschließlich den Platzhalter auf dieser Zeile durch deinen persönlichen openrouteservice-Schlüssel:

```dotenv
ORS_API_KEY=DEIN_OPENROUTESERVICE_SCHLUESSEL
```

Deinen Schlüssel erhältst du in deinem Konto bei https://openrouteservice.org/. Er gehört ausschließlich in deine lokale `.env`, nicht in `script.js`, die JSON-Datei oder einen Chat. `.gitignore` schließt `.env` und weitere lokale Umgebungsdateien aus.

## 3. App starten

Im selben Terminal und Ordner:

```sh
npm start
```

Öffne **http://localhost:3000**. Lass das Terminal offen. Zum Beenden: **Strg+C**. Nach Änderungen an `.env` den Server beenden und erneut `npm start` ausführen.

Es gibt **keine zusätzlichen npm-Abhängigkeiten**; `npm install` ist nicht erforderlich. Nicht per Doppelklick, Python-Dateiserver oder VS Code Live Server starten: Diese bieten die Backend-Funktionen nicht und können private Projektdateien ausliefern. Der alte Python-Vorschau-Server wurde beendet. Der neue Node-Server stellt ausschließlich `index.html`, `style.css`, `script.js` und `tankstellen.json` bereit (einschließlich `/` als Startseite). `.env`, Tests, README und Backend-Dateien sind über HTTP nicht abrufbar.

Wenn Port 3000 belegt ist, ändere `PORT=3000` in `.env`, etwa auf `PORT=3001`. Öffne dann http://localhost:3001. Der Server lauscht nur lokal auf 127.0.0.1.

## Bedienung

1. Eine Straßenadresse eingeben, z. B. **Brünner Straße 57, 1210 Wien**.
2. **Entfernungen berechnen** anklicken. Es gibt keine Adressanfragen beim Tippen.
3. Den passenden Treffer auswählen. Auch ein einzelner Treffer wird zur Bestätigung gezeigt. Ohne gefundene Hausnummer wird ausdrücklich auf einen Startpunkt auf der Straße hingewiesen.
4. Der blaue Start-Pin erscheint. Jede Tankstelle zeigt ihre Straßenentfernung und die geschätzte Fahrzeit, z. B. **4,2 km · ca. 8 Min.** Die vorhandene Tankstellensuche filtert weiterhin Liste und Pins.

Die Fahrzeiten enthalten **keinen Echtzeitverkehr**. Für nicht erreichbare Ziele oder ungültige Zielkoordinaten steht **Keine Route verfügbar**. Eine tatsächliche berechnete 0-km-Route bleibt von einer fehlenden Route unterscheidbar.

Schon beim Ändern der Startadresse verschwinden bisherige Routen und Start-Pin. Verspätete Antworten alter Anfragen werden durch eine Suchversion verworfen, zusätzlich werden laufende Browseranfragen abgebrochen.

## Daten und Backend

- `server.cjs`: HTTP-Server, lokale `.env`, explizite Freigabeliste öffentlicher Dateien, JSON-Endpunkte und Zugriffsschutz.
- `routing.cjs`: Adressvalidierung, Nominatim-Warteschlange und Cache, ORS-Matrix und Zuordnung nach IDs.
- `POST /api/geocode` mit `{ "query": "Brünner Straße 57, 1210 Wien" }` liefert bestätigte Floridsdorfer Treffer mit temporären IDs.
- `POST /api/routes` mit `{ "candidateId": "…" }` verwendet ausschließlich einen serverseitig bestätigten Startpunkt. Frei übergebene Start- oder Zielkoordinaten werden nicht verwendet.
- Die Matrix nutzt `driving-car`, `[longitude, latitude]`, `sources: ["0"]`, beide Metriken und `units: "km"`. Die Dauer bleibt in Sekunden. Die vorhandenen 23 Ziele werden in einer gemeinsamen Anfrage verarbeitet. Bei künftig mehr als 50 gültigen Zielen wird konservativ in Pakete geteilt.
- `routenErgebnisse` in `script.js` enthält `{ start, calculatedAt, byStationId }`. Jeder Eintrag in `byStationId` enthält `distanceKm` und `durationSeconds` als ungerundete Zahlen oder jeweils `null`. Rundung erfolgt ausschließlich in `routeHtml`. `tankstellen.json` wird nicht mit Routendaten überschrieben.
- Daten liegen im Arbeitsspeicher. Keine Datenbank, keine dauerhafte Speicherung von Startadressen oder Routenergebnissen.

## Nominatim-Regeln und Quellen

**Für den öffentlichen Dienst gelten die [Nominatim-Nutzungsbedingungen](https://operations.osmfoundation.org/policies/nominatim/): höchstens eine Anfrage pro Sekunde insgesamt für die App, kein Autocomplete, identifizierender User-Agent und Quellenangabe.** Die Suche ist auf diese App und vom Nutzer ausgelöste Adresssuchen beschränkt.

Die gemeinsame serielle Warteschlange hält mindestens 1,1 Sekunden Abstand zwischen Anfrage-Starts. Gleichzeitige identische Suchanfragen werden zusammengeführt. Suchergebnisse einschließlich erfolgloser Suchen werden für bis zu 24 Stunden im Arbeitsspeicher gecacht (maximal 500 Suchbegriffe). Der Cache endet beim Serverneustart. Fehler führen nicht zu automatischen Wiederholungen.

**Nur eine Backend-Instanz betreiben.** Mehrere Serverprozesse benötigen einen gemeinsam genutzten Cache und Rate-Limiter, damit das Gesamtlimit gewahrt bleibt. Für größeren oder öffentlichen Betrieb muss diese lokale Architektur entsprechend angepasst werden. Über `NOMINATIM_URL` lässt sich der Anbieter ohne Frontend-Änderung umstellen. `NOMINATIM_USER_AGENT` enthält die App-Kennung; für öffentlichen Betrieb eine eigene Kontakt-URL ergänzen. Keine Namen oder vertraulichen Angaben in die Adresssuche eingeben.

Die Bezirksprüfung wertet die zurückgegebenen Länder-, Orts- und Bezirksfelder aus (`country_code`, `city` usw. und `city_district`/`borough`/`suburb`). Postleitzahl und geografisches Suchfenster allein erlauben keinen Treffer. Fehlende oder widersprüchliche Bezirksangaben werden abgelehnt und verständlich gemeldet.

- [Nominatim-Suchparameter](https://nominatim.org/release-docs/latest/api/Search/)
- [openrouteservice-Matrix: Einheiten und Indizes](https://giscience.github.io/openrouteservice/api-reference/endpoints/matrix/)
- [ORS-Limits](https://openrouteservice.org/restrictions/): derzeit 3500 Quelle-Ziel-Paare ohne dynamische Argumente; 1 × 23 passt hinein. Zusätzlich gelten die Limits deines ORS-Kontos.
- Karten und Adressdaten: © OpenStreetMap-Mitwirkende. Routing: openrouteservice / OpenStreetMap. Quellen sind auch in der Oberfläche verlinkt.

## Prüfen

```sh
npm test
```

Die automatisierten Tests benötigen keinen Schlüssel und kontaktieren keine externen Dienste. Sie prüfen Bezirksvalidierung, Cache, parallele Adresssuche und Rate-Limit, Matrix-Anfrage für alle 23 Ziele, ID-Zuordnung bei fehlenden Koordinaten, Null-Routen, Fehlerfälle, den Schutz privater Dateien sowie verspätete Frontend-Antworten und Rundung.

Bei der Umsetzung: 14 Tests erfolgreich. Eine echte Nominatim-Suche der öffentlichen Beispieladresse wurde geprüft. **Der echte ORS-Matrix-Test wurde nach der Endpoint-Korrektur ausgeführt: HTTP 403, Zugriffsverweigerung laut Anbieterantwort; keine gemeldete Kontingentüberschreitung. Die Schlüsselfreigabe für die Matrix-API muss im HeiGIT-Konto geprüft werden.** Ein visueller Browser-Test war in der Arbeitsumgebung mangels verbundenem Browser nicht möglich.


## API-Adresse und Fehlerdiagnose

Die Matrix-Anfrage verwendet `https://api.heigit.org/openrouteservice/v2/matrix/driving-car`. `ORS_API_KEY` bleibt im serverseitigen `Authorization`-Header. Nach Backend-Änderungen den Server mit Strg+C beenden und `npm start` erneut ausführen.

Bei Anbieterfehlern wird der tatsächliche HTTP-Status angezeigt. Die JSON-Fehlerantwort wird intern ausgewertet: explizite Quotenmeldungen ergeben eine Kontingentmeldung, kurzfristige Limits eine Warteaufforderung, 401 eine Authentifizierungsmeldung, 403 eine Zugriffsverweigerung, 404 einen Endpunktfehler und 5xx eine Anbieterstörung. Ein 403 allein beweist keine Kontingentüberschreitung. Rohantworten und Zugangsdaten werden weder ausgegeben noch protokolliert.

## Kostenvergleich

Direkt unter der Startadresse stehen Benzin/Diesel und eine synchronisierte Tankmenge von 1–100 Litern. Standard: Benzin und 40 Liter. Änderungen rechnen ausschließlich lokal mit vorhandenen Routen, ohne zusätzliche API-Anfragen.

Die Modellparameter stehen ganz oben in **script.js**, in `COST_MODEL`:

- `consumptionLitersPer100Km: 6`
- `wearCostPerKm: 0.10`
- `defaultRefuelLiters: 40`

Die Preise in `tankstellen.json` sind bereits Euro pro Liter. Gesamtkosten = Tankbetrag + Fahrtverbrauch zum Zielpreis + Verschleiß. Die Verschleißannahme enthält Reifen, kilometerabhängige Wartung und Wertverlust, aber keine Spritkosten. Es werden keine weiteren Fahrzeugpauschalen oder Zeitkosten addiert.

Aktuell wird für Hin- und Rückfahrt die doppelte Hinfahrt verwendet und ausdrücklich als Schätzung gekennzeichnet. Optionale `returnDistanceKm` und `returnDurationSeconds` in den Routeneinträgen werden bevorzugt, wenn später verfügbar. `kostenErgebnisse` enthält die ungerundeten numerischen Ergebnisse nach Tankstellen-ID, Ranking und Referenz-ID getrennt von den Stammdaten. Fehlende Preise oder Routen ergeben kein vollständiges Kostenergebnis.

Die Referenz ist die nächstgelegene geeignete Tankstelle aus allen Daten, unabhängig vom Suchfilter. Die Rangfolge folgt den Gesamtkosten, bei Gleichstand der kürzeren Hin- und Rückstrecke. Fahrzeiten bleiben Schätzungen ohne Echtzeitverkehr.

Kostenprüfung: Das vorgegebene Beispiel ergibt 0,6 l Fahrtverbrauch, 0,96 EUR Fahrtsprit, 1,00 EUR Verschleiß, 1,96 EUR Fahrtkosten und **65,96 EUR Gesamtkosten**. Die sieben Frontend-Tests prüfen außerdem Mengenvalidierung, separate Rückstrecken, ungültige Daten, Rangfolge, Referenz, Adresswechsel und Änderungen ohne Netzwerkanfragen.

Für diese Frontend-Erweiterung genügt ein Neuladen der Browserseite; ein Serverneustart ist nicht erforderlich. Ein visueller Browsertest war nicht verfügbar.

## Direkter Start nach Adressprüfung

Ein einzelner Treffer startet die Routenberechnung jetzt automatisch, wenn Nominatim Straße und Hausnummer exakt bestätigt und der Treffer in Floridsdorf liegt. Groß-/Kleinschreibung und Leerzeichen werden beim Vergleich ignoriert. Ein bloßer Straßentreffer oder eine abweichende Hausnummer wird nicht als Ersatz verwendet. Nicht bestätigte Adressen führen zu einer Fehlermeldung am Eingabefeld. Mehrere mögliche bestätigte Standorte erfordern weiterhin eine Auswahl, damit kein beliebiger Startpunkt verwendet wird.

Nach dieser Änderung an `routing.cjs` ist ein Serverneustart erforderlich: Strg+C, dann `npm start`. Danach Browserseite neu laden.
