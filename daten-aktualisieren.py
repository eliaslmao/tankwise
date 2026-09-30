"""
Holt aktuelle Tankstellen und Spritpreise für Wien vom
Spritpreisrechner der E-Control und schreibt sie in tankstellen.json.

Aufruf:  python3 daten-aktualisieren.py
"""

import json
import time
import urllib.request
from datetime import datetime

API = "https://api.e-control.at/sprit/1.0/search/gas-stations/by-address"

# Raster über Wien: die API liefert pro Punkt nur die 10 nächsten Tankstellen
LAT_WERTE = [48.13, 48.16, 48.19, 48.22, 48.25, 48.28, 48.31]
LON_WERTE = [16.20, 16.26, 16.32, 16.38, 16.44, 16.50, 16.56]

SORTEN = {"DIE": "diesel", "SUP": "benzin"}

KETTEN = ["OMV", "BP", "Shell", "Eni", "JET", "Avanti", "Turmöl", "SOCAR",
          "Genol", "Diskont", "IQ", "Lagerhaus", "Stroh", "A1", "MMM", "Rumpold"]

TAGE = {"MO": "montag", "DI": "dienstag", "MI": "mittwoch", "DO": "donnerstag",
        "FR": "freitag", "SA": "samstag", "SO": "sonntag", "FE": "feiertag"}


def abfragen(lat, lon, sorte):
    url = f"{API}?latitude={lat}&longitude={lon}&fuelType={sorte}&includeClosed=true"
    with urllib.request.urlopen(url, timeout=20) as antwort:
        return json.load(antwort)


def kette_erkennen(name):
    for kette in KETTEN:
        if kette.lower() in name.lower():
            return kette
    return "Sonstige"


def oeffnungszeiten(eintraege):
    ergebnis = {}
    for e in eintraege:
        if e["from"] == "00:00" and e["to"] == "24:00":
            zeit = "24h"
        elif e["from"] == e["to"]:
            zeit = "geschlossen"
        else:
            zeit = f'{e["from"]}-{e["to"]}'
        ergebnis[TAGE.get(e["day"], e["day"].lower())] = zeit
    return ergebnis


def ausstattung(text):
    # Die E-Control liefert Zusatzangebote nur als Freitext
    text = (text or "").lower()
    return {
        "waschbox": "wasch" in text or "wäsch" in text,
        "wc": "wc" in text or "toilette" in text,
        "staubsauger": "sauger" in text,
        "luftpumpe": "luft" in text or "reifendruck" in text,
    }


def main():
    tankstellen = {}

    for sorte, feld in SORTEN.items():
        for lat in LAT_WERTE:
            for lon in LON_WERTE:
                for s in abfragen(lat, lon, sorte):
                    ort = s["location"]
                    if not ort.get("postalCode", "").startswith("1"):
                        continue  # nur Wien (PLZ 1xxx)

                    if s["id"] not in tankstellen:
                        angebot = s.get("offerInformation", {})
                        zahlung = s.get("paymentMethods", {})
                        tankstellen[s["id"]] = {
                            "id": s["id"],
                            "name": s["name"].strip(),
                            "kette": kette_erkennen(s["name"]),
                            "adresse": f'{ort["address"]}, {ort["postalCode"]} {ort["city"]}',
                            "koordinaten": {
                                "latitude": ort["latitude"],
                                "longitude": ort["longitude"]
                            },
                            "preise": {"diesel": None, "benzin": None},
                            "oeffnungszeiten": oeffnungszeiten(s.get("openingHours", [])),
                            "geoeffnet": s.get("open", False),
                            "zahlungsmittel": {
                                "debit": zahlung.get("debitCard", False),
                                "kreditkarte": zahlung.get("creditCard", False),
                                "barzahlung": zahlung.get("cash", False)
                            },
                            "tankautomat": angebot.get("unattended", False),
                            "bemannt": not angebot.get("unattended", False),
                            "ausstattung": ausstattung(s.get("otherServiceOffers"))
                        }

                    for preis in s.get("prices", []):
                        if preis["fuelType"] == sorte:
                            tankstellen[s["id"]]["preise"][feld] = preis["amount"]

                time.sleep(0.3)  # Server schonen

    # Tankstellen ohne gemeldeten Preis (meist gerade geschlossen) weglassen
    tankstellen = {i: t for i, t in tankstellen.items()
                   if t["preise"]["diesel"] or t["preise"]["benzin"]}

    daten = {
        "quelle": "E-Control Spritpreisrechner (spritpreisrechner.at)",
        "stand": datetime.now().strftime("%d.%m.%Y %H:%M"),
        "tankstellen": sorted(tankstellen.values(), key=lambda t: t["name"])
    }

    with open("tankstellen.json", "w", encoding="utf-8") as datei:
        json.dump(daten, datei, ensure_ascii=False, indent=2)

    print(f"{len(tankstellen)} Tankstellen mit Preis gespeichert.")


if __name__ == "__main__":
    main()
