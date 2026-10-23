**Draft Liga Bot 2.0 – Patch Notes**

Mit Version 2.0 wird aus dem Ergebnis-Bot ein Begleiter für die ganze Season: einfacher melden, Replays wiederfinden und Fehler direkt korrigieren.

**Neu**

- Season und Runde stehen direkt über dem Matchtitel.
- Der Wochenplan wechselt automatisch montags um 00:00 Uhr deutscher Zeit zur nächsten Runde.
- Unterstützung für Playoffs, Hin- und Rückrunde sowie eine optionale Redraft-Woche.
- `/suchen` findet Replays nach Season und Spieler. Auf Wunsch lässt sich die Suche auf einen Spieltag oder eine Playoff-Runde eingrenzen. Die Treffer kommen per DM.
- Mit **Bearbeiten** und **Löschen** unter dem Ergebnispost lassen sich Reports korrigieren oder nach Bestätigung entfernen.
- `/liga log` liefert das Änderungsprotokoll einer Season als Datei per DM: Wer hat wann was geändert?
- `/liga status` zeigt die aktuelle Season und Runde.

**Geändert**

- Gewinner und Verlierer werden aus einer Namensliste ausgewählt. Die Liste folgt der Teilnehmerrolle und den Anzeigenamen auf dem Server.
- Die aktuelle Runde ist beim Melden vorausgewählt. Nachholspiele können einer anderen Runde zugeordnet werden.
- Seasons werden über geführte Formulare mit Vorschau eingerichtet.
- Ergebnisse und Änderungen werden dauerhaft gespeichert und täglich gesichert.

**Entfernt**

- Das manuelle Eintippen der Spielernamen im Report.
- Emojis in Bot-Nachrichten und Buttons.

**Fehlerbehebungen**

- Korrekturen aktualisieren Ergebnispost und Replay-Suche gemeinsam.
- Gleichnamige Spieler und Sonderzeichen werden zuverlässig verarbeitet.
- Doppelte Meldungen desselben Matches werden abgefangen.
- Rollen- und Zugriffsprüfungen berücksichtigen entzogene Berechtigungen.

Gewinner, Verlierer und Score bleiben im Ergebnispost hinter Spoilern verborgen.

---

**Bot 2.0 – Kurzanleitung für Teilnehmer**

Starte die Befehle auf dem Liga-Server über die Slash-Auswahl. Bei Spielernamen einen passenden Vorschlag auswählen.

**Ergebnis melden**

`/report`
Runde, Gewinner und Verlierer auswählen, Ergebnis wie `2-0` und Replay-Link eintragen, absenden. Der Post erscheint im verwendeten Kanal. Die Season wird automatisch zugeordnet; für Nachholspiele einfach die passende Runde wählen.

**Fehler korrigieren**

Unter deinem Ergebnispost auf **Bearbeiten** klicken. Runde, Spieler, Ergebnis oder Link anpassen und absenden. Der vorhandene Post und sein Suchtreffer werden aktualisiert. Die Season bleibt erhalten.

Du kannst selbst gemeldete Reports bearbeiten, solange du die Teilnehmerrolle hast. Die Ligaverwaltung kann alle Reports bearbeiten und als einzige löschen.

**Replays finden**

`/suchen season:4 name:Jan`
Alle gespeicherten Replays von Jan aus Season 4.

`/suchen season:4 name:Jan spieltag:3`
Nur Spieltag 3. Für Playoffs stattdessen das optionale Feld `runde` verwenden und z. B. **Playoffs · Halbfinale** auswählen. `spieltag` und `runde` nicht gemeinsam verwenden.

Season und Name sind Pflicht. Die DM enthält Runde, beide Teilnehmer und Replay-Link, ohne Score oder Gewinnerangabe.

**Aktuelle Runde ansehen**

`/liga status`
Zeigt die aktuelle Season und Runde, gegebenenfalls die Redraft-Woche.

**Änderungen nachlesen**

`/liga log season:4`
Schickt dir das Änderungsprotokoll dieser Season als Datei per DM. Die Season muss angegeben werden. Die Datei enthält auch Gewinner und Ergebnisse.

**Gut zu wissen**

- Für diese Funktionen brauchst du die Teilnehmer- oder Ligaverwaltungsrolle.
- Suche und Logs berücksichtigen deinen Kanalzugriff. Ältere Discord-Posts werden nicht automatisch ins Archiv übernommen.
- Erlaube DMs von Servermitgliedern. Bereits zugestellte DMs und Dateien bleiben erhalten, werden später aber nicht automatisch aktualisiert. Bei Bedarf neu abrufen.

---

**Bot 2.0 – Kurzanleitung für die Ligaverwaltung**

Die folgenden Aktionen benötigen die Ligaverwaltungsrolle.

**Season einrichten oder ändern**

`/liga season`

1. Season-Nummer, reguläre Spieltage insgesamt, Startdatum und Format eingeben. Das Startdatum muss ein Montag sein, z. B. `26.10.2026`.
2. Je nach Format über **Weiter** Redraft und Playoff-Start wählen.
3. Wochenplan prüfen und **Season speichern**. Erst dann wird gespeichert; Abbrechen oder Schließen übernimmt nichts.

**Die Formate**

- **Liga ohne Playoffs:** Nur reguläre Spieltage.
- **Liga mit Playoffs:** Reguläre Spieltage plus Achtelfinale, Viertelfinale, Halbfinale oder direkt Finale. Alle Folgerunden bis zum Finale werden ergänzt.
- **Hin- und Rückrunde ohne Playoffs:** Eine gerade Gesamtzahl eingeben. `18` bedeutet neun Hin- und neun Rückrundenspieltage; die Nummerierung läuft durch.

Bei neuer Einrichtung: Redraft **Nein**, Playoffs ab **Halbfinale**. Die Spielpaarungen legt die Liga selbst fest.

**Redraft und Wochenwechsel**

**Redraft: Ja** fügt eine spielfreie Woche vor den Playoffs oder zwischen Hin- und Rückrunde ein. Jede Runde und die Pause dauern Montag bis Sonntag. Der Wechsel erfolgt automatisch montags um 00:00 Uhr deutscher Zeit.

Beispiel: Woche 9 ist Spieltag 9, Woche 10 Redraft, Woche 11 Halbfinale, Woche 12 Finale. Während Redraft bleiben Nachholspiele durch ausdrückliche Rundenauswahl möglich.

**Eine Einstellung war falsch?**

`/liga season` erneut öffnen und die Nummer beibehalten. Vorhandene Werte sind vorausgefüllt. Für eine neue Season eine neue Nummer wählen. Planänderungen ändern bereits gepostete Reports nicht rückwirkend.

**Reports löschen und Archiv bereinigen**

**Löschen** unter dem Post drücken und bestätigen.

Fehlt der Post bereits:
`/report-entfernen season:4 name:Jan`
Optional `spieltag` oder `runde` ergänzen. Bei mehreren Treffern den richtigen auswählen und bestätigen. Ein Nachrichtenlink ist nicht nötig. Das Änderungsprotokoll bleibt erhalten.
