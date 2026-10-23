# Draft Liga Ergebnisse Bot

Ein selbst gehosteter Discord-Bot für Pokémon-Draft-Ligen. Ergebnisse bleiben hinter Spoilern, Replays lassen sich nach Season und Spieler suchen, und Änderungen sind über eine Logdatei nachvollziehbar. Die Oberfläche ist deutsch.

## Funktionen

- `/report`: Modal mit Runde, Gewinner, Verlierer, Score und Replay-Link. Die Spieler stammen aus den Server-Anzeigenamen einer konfigurierten Teilnehmerrolle.
- Automatischer Seasonplan: Liga, Liga mit Playoffs oder Hin-/Rückrunde, jeweils mit optionaler Redraft-Woche zwischen Spielphasen. Der Wochenwechsel erfolgt montags um 00:00 Uhr in `Europe/Berlin`, einschließlich Sommerzeitwechseln.
- Ergebnisposts mit Season und Runde, Spoilern für Gewinner/Verlierer/Score und zufälliger Reihenfolge der Namen im Titel.
- **Bearbeiten** und **Löschen** als Buttons direkt unter dem Ergebnispost. Keine zusätzlichen Rechtsklick-/Apps-Aktionen.
- `/suchen`: Replay-Links mit Runde und Teilnehmern als normale, dauerhaft sichtbare DMs.
- `/liga log season:…`: Lesbares Änderungsprotokoll genau einer Season als `.txt`-Datei per DM. Die Season ist verpflichtend.
- `/report-entfernen`: Archivbereinigung auch bei bereits gelöschtem Discord-Post, ohne Nachrichtenlink.
- SQLite für Einstellungen, Reports, Melder, Ergebnisse, Versandvormerkungen und Änderungshistorie. Bestehende JSON-Daten werden einmalig übernommen.
- Tägliche Datenbanksicherungen mit 14 Kopien sowie zusätzliche manuelle Backups.

## Voraussetzungen

- **Node.js 24 LTS** und npm. `package.json`, `.nvmrc` und `.npmrc` legen die Reihe 24 fest. `engine-strict` verhindert eine Installation mit unpassender Version; `npm start` wechselt die Laufzeit nicht automatisch.
- Eine eigene Discord-Anwendung mit Bot und einem Server für die Installation.
- Dauerhafter Speicher; auf Railway ist ein Volume erforderlich.
- Eine laufende Bot-Instanz pro Datenverzeichnis.

SQLite verwendet das eingebaute Modul `node:sqlite`. Ein zusätzlicher Datenbankdienst, ein SQLite-CLI-Programm oder native npm-Erweiterungen sind nicht erforderlich. [Node.js SQLite](https://nodejs.org/api/sqlite.html)

## Discord einrichten

1. Im [Developer Portal](https://discord.com/developers/applications) eine Anwendung mit Bot anlegen und Token sowie Application-ID notieren.
2. Unter **Bot → Privileged Gateway Intents** den **Server Members Intent** aktivieren. Der Bot verwendet `Guilds` und `GuildMembers`; Message Content Intent ist nicht erforderlich.
3. Die Anwendung mit den Scopes **`bot`** und **`applications.commands`** auf dem Server installieren.
4. Eine bestehende Teilnehmerrolle auswählen und ihre ID kopieren. Dafür unter **Erweitert** den Entwicklermodus aktivieren.
5. Optional eine separate Rolle für die Ligaverwaltung anlegen und deren ID kopieren.

Der Bot benötigt in Ergebniskanälen **Kanal anzeigen**, **Nachrichten senden**, **Links einbetten** und **Nachrichtenverlauf anzeigen**. Bei Threads sind Zugriff und die passenden Thread-Senderechte nötig. Administrator, Rollenverwaltung und das Verwalten fremder Nachrichten werden nicht benötigt. Kanal-Overrides gelten zusätzlich. [Discord-Berechtigungen](https://docs.discord.com/developers/topics/permissions)

Die **Ligaverwaltungsrolle** benötigt keine besonderen Serverrechte. Ihre Mitglieder brauchen Zugriff auf die Ergebniskanäle und deren Verlauf sowie die Freigabe für Anwendungsbefehle. Der Bot erkennt die Rolle anhand ihrer ID. Sie muss von der Teilnehmerrolle verschieden sein. „Server verwalten“ bzw. Administrator ist ebenfalls eine Verwaltungsfreigabe.

## Installation und Konfiguration

```powershell
git clone https://github.com/Synatics/draft-liga-bot.git
cd draft-liga-bot
git switch codex/verbesserungen
```

Node.js 24 aktivieren. Mit eingerichtetem NVM for Windows beispielsweise:

```powershell
nvm install 24
nvm use 24
node --version
npm ci
Copy-Item .env.example .env
```

Unter Linux/macOS entsprechend `cp .env.example .env` verwenden. Anschließend die Werte in `.env` setzen:

```dotenv
DISCORD_TOKEN=dein-bot-token
CLIENT_ID=deine-application-id
PARTICIPANT_ROLE_ID=deine-teilnehmerrollen-id
LEAGUE_MANAGER_ROLE_ID=deine-ligaverwaltungsrollen-id
# DATA_DIR=./data
```

| Variable                    | Bedeutung                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`             | Pflichtwert: Bot-Token ohne `Bot`-Präfix                                                  |
| `CLIENT_ID`                 | Pflichtwert: Application-ID desselben Bots                                                |
| `PARTICIPANT_ROLE_ID`       | Pflichtwert: Rolle für Spielernamen, Reports, das Bearbeiten eigener Reports und Logabruf |
| `LEAGUE_MANAGER_ROLE_ID`    | Optional: separate Verwaltungsrolle; ohne Wert verwalten nur Serververwalter die Liga     |
| `DATA_DIR`                  | Optional: Datenverzeichnis; lokal standardmäßig `./data`, auf Railway der Volume-Mount    |
| `RAILWAY_VOLUME_MOUNT_PATH` | Von Railway bereitgestellter Mount-Pfad                                                   |
| `RAILWAY_ENVIRONMENT_ID`    | Aktiviert die Railway-Volume-Prüfung                                                      |

Discord-IDs müssen 17–20 Ziffern haben. Ein gesetzter, ungültiger Rollenwert verhindert den Start. `.env`, Datenbank und Backups gehören nicht ins Repository.

```powershell
npm start
```

Beim Start werden Konfiguration, Schreibzugriff, SQLite und gegebenenfalls die JSON-Übernahme geprüft. Danach registriert der Bot `/report`, `/liga`, `/suchen` und `/report-entfernen` **global für diese Anwendung**. Dabei werden die früheren Rechtsklick-Aktionen entfernt. Registrierung und Anmeldung haben zusammen ein Zeitlimit von 60 Sekunden. Startfehler führen zu Exit-Code 1; Token und rohe Discord-Request-Daten werden nicht als Startfehlermeldung ausgegeben.

Die Registrierung ersetzt die globale Befehlsliste dieser Anwendung; dafür eine eigene Discord-Anwendung verwenden. Ein separates Deploy-Commands-Skript ist nicht nötig. Bei veralteten Optionen Discord mit Strg+R bzw. im Browser mit F5 neu laden.

## Berechtigungen im Bot

| Aktion                         | Freigabe                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `/report`                      | Aktuelle Teilnehmerrolle, Ligaverwaltungsrolle oder Serververwalter                                               |
| `/suchen`                      | Anwendungsbefehle im Kanal verwenden dürfen; zusätzliche Kanal-/Integrationsregeln sind in Discord konfigurierbar |
| Report bearbeiten              | Gespeicherte meldende Person mit aktueller Teilnehmerrolle, Ligaverwaltungsrolle oder Serververwalter             |
| Report löschen                 | Ligaverwaltungsrolle oder Serververwalter                                                                         |
| `/report-entfernen`            | Ligaverwaltungsrolle oder Serververwalter                                                                         |
| `/liga season`, `/liga status` | Ligaverwaltungsrolle oder Serververwalter                                                                         |
| `/liga log season:…`           | Aktuelle Teilnehmerrolle, Ligaverwaltungsrolle oder Serververwalter                                               |

Die andere am Match beteiligte Person bekommt dadurch keine Bearbeitungsrechte. Die Melder-ID wird bei der ersten Meldung gespeichert und bleibt bei Korrekturen erhalten. Ein erneut gemeldetes Duplikat überträgt diese Zuordnung nicht.

Die Buttons sind für alle gleich sichtbar. Der Bot prüft die Rechte beim Öffnen und vor der endgültigen Änderung erneut. Vor dem Erstellen, Speichern bzw. Löschen lädt er die handelnde Person frisch; entzogene Rollen werden berücksichtigt. Die Verwaltungsfreigabe stammt ausschließlich aus den Rollen bzw. Serverrechten dieses Mitglieds; ältere Berechtigungen aus einem bereits geöffneten Formular werden nicht als Ersatz verwendet. Zusätzlich sind beim Bearbeiten und Löschen Kanal- und Verlaufszugriff erforderlich. Bei privaten Threads wird die aktuelle Mitgliedschaft oder `ManageThreads` geprüft. Veraltete Formulare und Bestätigungen werden abgewiesen.

`/liga` ist als Gruppe für Teilnehmer sichtbar, damit sie `log` verwenden können. Die Verwaltungs-Unterbefehle werden im Bot gesondert gesperrt. Discord-Integrationsregeln dürfen nicht die gesamte Gruppe ausschließlich auf Admins beschränken, wenn Teilnehmer das Protokoll abrufen sollen.

## Befehle und Bedienung

Alle Slash-Befehle werden auf dem Liga-Server gestartet. Beispiele zeigen ausgewählte Befehle mit ausgefüllten Optionen; eine als normale Chatnachricht eingefügte Zeile führt keinen Befehl aus.

### Season einrichten

```text
/liga season
/liga status
```

`/liga season` hat keine zusätzlichen Slash-Parameter mehr. Der geführte Dialog ist privat:

1. **Grunddaten:** Season-Nummer, reguläre Spieltage insgesamt, Startdatum und Format auswählen. Bei einer bestehenden Season sind die gespeicherten Werte vorausgefüllt. Nummer beibehalten zum Korrigieren, eine neue Nummer für eine neue Season verwenden.
2. **Weitere Einstellungen:** Für Playoffs und Hin-/Rückrunde öffnet der private **Weiter**-Button ein zweites Modal. Dort Redraft als **Ja/Nein** wählen; beim Playoff-Format zusätzlich die erste Playoff-Runde festlegen. Eine reine Liga benötigt nur das erste Modal.
3. **Plan prüfen:** Eine private Vorschau zeigt alle Kalenderwochen einschließlich Redraft und Playoffs. **Grunddaten ändern** und **Weitere Einstellungen ändern** führen zurück zu den vorausgefüllten Formularen. Erst **Season speichern** übernimmt den gesamten Plan. **Abbrechen** und das Schließen eines Modals speichern nichts.

Das zweite Modal wird über einen Button geöffnet, weil Discord auf eine Modal-Absendung nicht direkt mit einem weiteren Modal antworten lässt. [Discord Interaction Responses](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-response-object-interaction-callback-type)

Bei einer frischen Einrichtung sind Season 1, neun reguläre Spieltage und **Liga ohne Playoffs** vorbelegt; das Startdatum muss eingegeben werden. Redraft ist zunächst **Nein**, Playoffs beginnen zunächst mit dem **Halbfinale**. Bei einer Korrektur werden vorhandene Werte übernommen, einschließlich Redraft und Playoff-Start. Ein Wechsel zu einem Format ohne diese Optionen entfernt sie ausdrücklich im neuen Entwurf; die Vorschau zeigt das Ergebnis vor dem Speichern.

Das Startdatum muss ein Montag sein; `TT.MM.JJJJ` und `JJJJ-MM-TT` werden akzeptiert. Jede spielbare Runde und die optionale Redraft-Pause dauern eine Woche, jeweils Montag bis Sonntag in `Europe/Berlin`. Der Wochenwechsel folgt dem Kalender und braucht keinen wöchentlichen Eingriff. Neustarts, Offline-Zeiten und Sommerzeit ändern daran nichts.

**Format** bietet **Liga ohne Playoffs**, **Liga mit Playoffs** und **Hin- und Rückrunde ohne Playoffs**. Die Spieltagszahl zählt ausschließlich reguläre Spieltage, bei Hin-/Rückrunde beide Hälften zusammen: `18` bedeutet neun Hin- und neun Rückrundenspieltage. Dafür ist eine gerade Gesamtzahl erforderlich; die Nummerierung läuft von 1 bis 18 durch.

**Erste Playoff-Runde** bietet Achtelfinale, Viertelfinale, Halbfinale oder Finale. Alle folgenden Runden bis zum Finale werden ergänzt. Es werden Rundenbezeichnungen und Termine verwaltet, kein automatischer Turnierbaum oder eine Qualifikation anhand von Ergebnissen.

**Redraft: Ja** fügt eine Pause vor den Playoffs oder zwischen Hin- und Rückrunde ein. Bei neun regulären Spieltagen, Redraft und Halbfinale liegen Spieltag 9 in Woche 9, Redraft in Woche 10, Halbfinale in Woche 11 und Finale in Woche 12. Bei 18 Hin-/Rückrundenspieltagen liegen die Pause ebenfalls in Woche 10 und Spieltag 10 in Woche 11.

Das Dropdown unterstützt höchstens 25 **spielbare** Runden insgesamt; Playoffs zählen dazu, die Redraft-Pause nicht. Ungültige Kombinationen werden vor dem Speichern abgewiesen. `/liga status` zeigt die aktuelle Runde beziehungsweise Redraft und die nächste Runde an. Vor Beginn ist die erste Runde vorausgewählt, nach dem Ende die letzte; der Status weist auf den noch ausstehenden Start beziehungsweise das Ende hin.

Eine erneute Einrichtung ändert vorhandene Posts nicht. Neue Reports speichern ihre Rundenbezeichnung unabhängig vom aktiven Plan. Beim Seasonwechsel bleiben vorherige Einstellungen für historische Korrekturen erhalten. Ein während der Eingabe geänderter Rundenplan macht betroffene Formulare ungültig; sie müssen erneut geöffnet werden.

Einrichtungsentwürfe sind an Server und Person gebunden und liegen bis zu 30 Minuten nur im Arbeitsspeicher. Ein neuer `/liga season`-Aufruf derselben Person auf demselben Server ersetzt ihren vorherigen Entwurf. Nach einem Bot-Neustart den Dialog erneut öffnen; gespeicherte Einstellungen bleiben erhalten. Vor dem Speichern wird die Verwaltungsberechtigung frisch geladen und die ursprüngliche Konfiguration auf zwischenzeitliche Änderungen geprüft. Eine ältere Vorschau überschreibt keine neueren Einstellungen anderer Verwalter. Bei Speicherfehlern bleiben die bisherigen Einstellungen erhalten; die Bestätigung kann nach Behebung erneut versucht werden.

### Ergebnis melden

`/report` öffnet das Modal mit weiterhin fünf Feldern. Das Dropdown **Runde** enthält reguläre Spieltage, gegebenenfalls mit Hin-/Rückrunde, sowie die konfigurierten Playoff-Runden. Die aktuelle Runde ist vorausgewählt; andere Runden bleiben für Nachholspiele auswählbar. Redraft ist keine meldbare Runde. In der Redraft-Woche ist keine Runde vorausgewählt; für Nachholspiele die zugehörige Runde ausdrücklich auswählen. Die beiden Spieler-Dropdowns enthalten 2–25 menschliche Mitglieder der Teilnehmerrolle, sortiert nach Server-Anzeigename. Namensgleichheiten bleiben durch Discord-IDs unterscheidbar.

Beim Absenden werden Mitglieder, Rolle und Bot-Status erneut geprüft. Ein Formular einer inzwischen gewechselten Season wird abgewiesen. Scores müssen 1–100 Zeichen lang sein; Replay-Links müssen HTTP-/HTTPS-Adressen mit höchstens 1024 Zeichen sein. Das Replay wird nicht extern abgerufen oder inhaltlich geprüft.

Der Post erscheint im Aufrufkanal, die Bestätigung ist privat. Die kleine Kopfzeile zeigt beispielsweise `Season 5 · Playoffs · Halbfinale` oder `Season 6 · Rückrunde · Spieltag 10`; darunter steht der Matchtitel mit beiden Namen. Erwähnungen sind deaktiviert und Namen bzw. Scores werden für die Spoilerdarstellung escaped. Der Duplikatschlüssel enthält Server, Kanal, Season, Runden-ID, beide Spieler-IDs und normalisierten Replay-Link. Ein anderer Score oder vertauschter Gewinner erzeugt keinen weiteren Post; veröffentlichte Duplikate verweisen auf die bestehende Nachricht.

### Bearbeiten und löschen

**Bearbeiten** unter dem Post öffnet direkt das vorausgefüllte Modal mit Runde, Gewinner, Verlierer, Score und Replay-Link. Die Season bleibt die des Reports und steht im Titel. Das Dropdown verwendet auch nach einem Seasonwechsel den ursprünglichen Seasonplan. Wechsel zwischen Ligaspieltag und Playoffs aktualisieren Post, Archiv und Log zusammen; bei Playoffs wird keine künstliche Spieltagsnummer gespeichert. Bereits gespeicherte Rundenmetadaten bleiben bei einer reinen Ergebniskorrektur erhalten, auch wenn die Seasonkonfiguration später geändert wurde. Bei alten Reports ohne historischen Plan stehen bis zu 25 reguläre Spieltage zur Verfügung; für eine noch bekannte Season gilt deren Grenze. Wurde ein bisheriger alter Spieltag durch eine Verkürzung ungültig, muss ein gültiger Wert ausdrücklich ausgewählt werden.

Erst das Absenden ändert denselben Discord-Post und seinen Suchtreffer. Nachrichten-ID und Melder bleiben erhalten. Schließen bzw. Abbrechen verändert keine Daten. Historische Teilnehmer bleiben auswählbar, auch ohne aktuelle Rolle oder Servermitgliedschaft; neu hinzugefügte Teilnehmer benötigen die Teilnehmerrolle. Bei gleichen gespeicherten Namen wird der ursprüngliche Gewinner nicht geraten.

**Löschen** zeigt eine private Bestätigung mit Season, Runde, Teilnehmern, Replay-Link und Kanal. Erst **Ja, Report löschen** entfernt Post und Suchtreffer. Der Logeintrag einschließlich ursprünglicher Runde bleibt erhalten.

Die Buttons enthalten feste Report-IDs und benötigen keine kurzlebigen Collector; sie funktionieren nach Neustarts weiter. Vorhandene, im Archiv eindeutig verknüpfte Posts erhalten beim Start nach Möglichkeit ebenfalls Buttons. Fremde Nachrichten und Webhook-Posts werden nicht verändert. Bereits gelöschte Posts bleiben zur Archivbereinigung gespeichert.

### Bereits gelöschten Post im Archiv bereinigen

```text
/report-entfernen season:4 name:Jan
/report-entfernen season:4 name:Jan spieltag:3
/report-entfernen season:5 name:Jan runde:semifinal
```

Ein Nachrichtenlink ist nicht nötig. Der optionale Filter `runde` bietet Vorschläge wie **Playoffs · Halbfinale** oder **Rückrunde · Spieltag 10**. `spieltag` bleibt als Alternative für reguläre Spieltage verfügbar; beide Filter gleichzeitig werden abgewiesen. Ein einzelner Treffer öffnet die private Bestätigung. Mehrere Treffer werden per Dropdown mit Runde, Teilnehmern und Replay-Link ausgewählt; ab 26 Treffern gibt es Seiten, die den Rundenfilter beibehalten. Immer nur ein Report wird nach Bestätigung entfernt. Fehlt die Discord-Nachricht bereits, bereinigt der Bot nur das Archiv und protokolliert die Löschung.

### Replays suchen

```text
/suchen season:4 name:Jan
/suchen season:4 name:Jan spieltag:3
/suchen season:5 name:Jan runde:semifinal
```

Season und Name sind Pflichtfelder. `runde` filtert optional nach einer konkreten Liga- oder Playoff-Runde, `spieltag` alternativ nach einem regulären Spieltag. Ohne Rundenfilter erscheinen alle Replays einschließlich Playoffs. Vorschläge stammen aus dem Archiv, einschließlich früherer Namen und ehemaliger Teilnehmer. Bei identischen Namen einen eindeutigen Vorschlag auswählen. Die Ausgabe enthält ausschließlich Runde, Teilnehmer und Replay-Link.

Treffer kommen als normale DMs. Gesperrte DMs oder teilweise fehlgeschlagener Versand werden privat erklärt. Ergebnisse und Vorschläge berücksichtigen lesbare Ergebniskanäle. Die Suche nutzt den SQLite-Index für Server und Season und benötigt keine aktive Season.

### Änderungsprotokoll anfordern

```text
/liga log season:4
```

**Die Season ist verpflichtend.** Es gibt keinen Standardabruf aller Seasons. Alle aktuellen Teilnehmer sowie Verwaltung und Serververwalter dürfen das Protokoll dieser Season anfordern; ihre Rollen werden erneut geladen.

Die DM enthält eine `.txt`-Datei mit Erstellungen, Änderungen, Löschungen und gegebenenfalls der JSON-Übernahme. Einträge zeigen Person/Discord-ID, Datum/Uhrzeit in `Europe/Berlin`, Report-/Nachrichten-ID und Vorher-/Nachher-Werte. Größere Exporte werden in vollständige UTF-8-Dateien aufgeteilt. Eingaben mit Zeilenumbrüchen werden escaped, damit sie keine zusätzlichen Logzeilen vortäuschen.

Teilnehmer erhalten nur Einträge aus lesbaren Kanälen; private Thread-Mitgliedschaften werden frisch geprüft. Die Verwaltung kann auch Historie bereits entfernter Kanäle einsehen. Fehlende Einträge oder gesperrte DMs werden privat gemeldet; Protokollinhalte erscheinen nicht als öffentliche Fehlermeldung.

Zugestellte Such-DMs und Logdateien sind Momentaufnahmen und werden nach einer Korrektur nicht rückwirkend verändert. Für den aktuellen Stand erneut abrufen. Das Protokoll hat im Bot keine Bearbeiten-/Löschen-Funktion. Wer direkten Dateizugriff auf den Server hat, besitzt weiterhin technische Kontrolle über die Datenbank.

## Speicherung und JSON-Übernahme

Die aktive Datei ist **`liga.sqlite`** im Datenverzeichnis:

| Tabelle        | Inhalt                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------- |
| `settings`     | Aktuelle Liga-Konfiguration pro Server und frühere Seasonpläne unter `history[season]`    |
| `reports`      | Suchmetadaten, Melder, Ergebnis, Versandstatus, Nachrichten-ID und vorgemerkte Änderungen |
| `audit_events` | Eigenständige Vorher-/Nachher-Protokolle, unabhängig vom Fortbestand des Reports          |
| `metadata`     | Initialisierungsmarker; `application_id` und `user_version` kennzeichnen das Dateiformat  |

Das Protokoll enthält bewusst auch Gewinner und Score. Die beschriebene Rollenfreigabe gilt daher für den Abruf. Bot-Tokens werden nicht in SQLite gespeichert.

Die Tabellenstruktur bleibt gleich. Neue Einstellungen ergänzen `format`, `redraft`, gegebenenfalls `playoffsFrom` und den geordneten Wochenplan `rounds`; frühere Pläne werden ohne verschachtelte Historien in derselben Settings-Zeile aufbewahrt. Reports speichern eine geprüfte `round`-Momentaufnahme mit fester ID. Nur Ligaspiele haben zusätzlich `matchday`; Playoffs tragen ihre eigene Runde, Pausen werden nie als Report gespeichert. Alte Datensätze mit ausschließlich `matchday` sowie bestehende Änderungsvormerkungen bleiben lesbar. Backups enthalten auch die historischen Pläne.

Beim ersten Start ohne initialisierte Datenbank werden vorhandene `league-settings.json` und `matches.json` geprüft. Eine zusätzliche Kopie entsteht unter `migration-json-…/`. Einstellungen, IDs, Versandvormerkungen und unterbrochene Änderungen werden transaktional übernommen. Die Originaldateien bleiben unverändert und werden danach nicht mehr als aktiver Speicher eingelesen.

Die Übernahme erfindet keine früheren Melder, Scores oder Änderungen. Solche Angaben bleiben unbekannt. Im Log steht der Übernahmezeitpunkt, nicht ein behaupteter ursprünglicher Reportzeitpunkt. Reports ohne bekannten Melder können nur von der Verwaltung bearbeitet werden. Einträge ohne Nachrichten-ID bleiben suchbar, können aber nicht automatisch einem Post zugeordnet werden. Es gibt keinen Import der gesamten Discord-Nachrichtenhistorie.

Beschädigte Dateien und unbekannte Datenbankversionen verhindern den Start; sie werden nicht durch leere Daten ersetzt. Eine initialisierte Datenbank wird nicht aus veralteten JSON-Dateien überschrieben. **`liga.sqlite` nicht zum Zurücksetzen löschen**, wenn daneben alte JSON-Dateien liegen; sonst könnte deren alter Stand erneut importiert werden.

### Unterbrochene Vorgänge

Vor dem öffentlichen Versand wird der Zustand dauerhaft reserviert. Gleichzeitige Meldungen desselben Matches werden gesperrt. Ein Timeout oder unklarer Netzwerkausgang führt auch nach Neustarts nicht automatisch zu einem erneuten Post. Eine eindeutige Discord-Ablehnung lässt einen neuen Versuch zu.

Bearbeitungen und Löschungen werden vor dem Discord-Aufruf vorgemerkt. Nach erfolgreicher Discord-Antwort werden Report und endgültiger Logeintrag gemeinsam in einer SQLite-Transaktion aktualisiert. Schlägt das Logschreiben fehl, rollt diese Transaktion zurück; die Vormerkung bleibt erhalten. Discord selbst gehört nicht zur Datenbanktransaktion.

Zum Fortsetzen einer vorgemerkten Korrektur erneut **Bearbeiten** drücken. Der Bot schließt zuerst den gespeicherten Versuch ab. Eine Löschung wird mit **Löschen** und erneuter Bestätigung oder `/report-entfernen` abgeschlossen. Bereits entfernte Nachrichten zählen dabei als Erfolg. Eine bestätigte Löschung kann eine ungeklärte Korrektur ersetzen. Die ursprünglich erfasste handelnde Person bleibt bei Wiederholungen im Log erhalten.

Bei unklarer Erstveröffentlichung den Kanal und die Datenbank nach Sicherung bei angehaltenem Bot prüfen. Eine manuelle Statuskorrektur erfordert eine eindeutige Zuordnung der Discord-Nachricht. Änderungen an alten JSON-Dateien beeinflussen SQLite nicht.

## Backups und Wiederherstellung

Beim Start und anschließend stündlich prüft der Bot, ob für den aktuellen UTC-Kalendertag eine gültige Sicherung vorliegt. Unter `sqlite-backups/backup-…/liga.sqlite` bleiben die letzten **14 Kopien** erhalten. `VACUUM INTO` erstellt einen konsistenten Snapshot; erst nach Prüfung und Veröffentlichung der Kopie werden ältere, eindeutig erkannte Sicherungen entfernt. Ordner mit fremden Dateien werden beibehalten und gemeldet. [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html)

Gesichert werden Einstellungen, Reports, Vormerkungen und die komplette Historie. Alte JSON-Backups unter `backups/` sowie die Kopien vor der Migration bleiben als Rückfallebene erhalten und werden von der SQLite-Rotation nicht gelöscht. Auch eine noch nicht konfigurierte Datenbank lässt sich sichern.

```powershell
npm run backup
```

Die manuelle Sicherung verwendet denselben Datenpfad wie der Bot und benötigt kein Discord-Login. Ohne SQLite-Datei kann sie weiterhin alte JSON-Dateien sichern. Vor manueller Wartung den Bot anhalten; integrierte automatische SQLite-Backups sind im laufenden Betrieb konsistent.

Wiederherstellung:

1. Bot bzw. Railway-Deployment stoppen.
2. Die aktuelle Datenbank separat sichern, auch wenn sie beschädigt erscheint.
3. Eine geprüfte `liga.sqlite` aus dem gewünschten Sicherungsordner nach `DATA_DIR/liga.sqlite` zurückspielen.
4. Bot starten und `/liga status`, Replay-Suche und Logabruf prüfen.

Immer die gesamte Datenbank zurückspielen; keine einzelnen Report- und Logtabellen mischen. Ein älterer Backup-Stand kann von neueren Discord-Nachrichten abweichen. Backups auf demselben Volume schützen nicht vor dessen Verlust; eine externe Kopie oder zusätzliche Railway-Volume-Backups bleiben sinnvoll.

## Railway

1. Gewünschten GitHub-Branch verbinden und **eine Instanz** betreiben.
2. Volume mit Mount Path `/data` hinzufügen.
3. Token, Application-ID, Teilnehmerrollen-ID und optional Verwaltungsrollen-ID als Variablen setzen.
4. Node.js 24 verwenden; eine abweichende `RAILPACK_NODE_VERSION` entfernen oder auf `24` setzen.
5. Installation mit `npm ci`, Start mit `npm start`.

Der Volume-Mount wird automatisch verwendet. Ein expliziter `DATA_DIR` muss innerhalb des Volumes liegen. Ohne Volume oder bei einem Pfad außerhalb davon bricht der Start auf Railway ab. Migration und Backups erfolgen zur Laufzeit, nicht im Build oder Pre-Deploy.

Lokale Einstellungen und Daten werden nicht automatisch zu Railway übertragen. Bei parallelem Test- und Produktivbetrieb eine separate Discord-Anwendung mit eigenem Token und Datenverzeichnis verwenden. Zwei Prozesse derselben Anwendung teilen sonst Interaktionen und Befehlsregistrierungen.

[Railway Volumes](https://docs.railway.com/volumes), [Railway-Backups](https://docs.railway.com/volumes/backups), [Railpack Node.js](https://railpack.com/languages/node)

## Entwicklung

```powershell
npm ci
npm run check
```

`npm run check` führt Lint-Prüfung, Formatprüfung und Tests nacheinander aus. Einzeln sind sie über `npm run lint`, `npm run format:check` und `npm test` verfügbar. `npm run format` formatiert die Projektdateien automatisch; es startet den Bot nicht.

Die [ESLint-Konfiguration](https://eslint.org/docs/latest/use/configure/configuration-files) verwendet empfohlene JavaScript-Regeln für Node.js/CommonJS sowie `no-var`, `prefer-const` und strikte Vergleiche (mit erlaubten Null-/Undefined-Prüfungen über `== null`). [Prettier](https://prettier.io/docs/install) sorgt für einheitliche Formatierung. Beide Werkzeuge sind als fest versionierte Entwicklungsabhängigkeiten installiert; für den laufenden Bot werden sie nicht benötigt. `.editorconfig` und `.gitattributes` legen UTF-8, zwei Leerzeichen und LF-Zeilenenden fest. Lokale Daten, Zugangsdaten und generierte Dateien werden von den Werkzeugen ausgeschlossen.

Tests verwenden temporäre Verzeichnisse, echte SQLite-Transaktionen und simulierte Discord-Interaktionen. Sie lesen keine produktiven Tokens und senden keine echten Nachrichten. Abgedeckt sind Übernahme/Wiederanlauf, atomare Report-/Log-Speicherung, Backups/Wiederherstellung, Button-Zuordnung, Melder- und Rollenrechte, Rechteentzug, Pflicht-Season, DMs, UTF-8-Export, Spoiler, Duplikate, Kalender-/Sommerzeitgrenzen sowie Fehlerdiagnosen ohne Zugangsdaten.

Beim Erstellen und Korrigieren gilt dieselbe Score-Prüfung: 1 bis 100 Zeichen und mindestens ein Zeichen, das kein Leerraum ist. Ungültige Eingaben führen zu einer privaten Rückmeldung, bevor ein Post oder Archiv-/Logeintrag verändert wird.

| Dateien                                                          | Aufgabe                                                                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `index.js`                                                       | CLI-Einstieg: `.env` laden, Bot starten und bei Startfehlern mit Exit-Code 1 beenden                       |
| `bot.js`                                                         | Separat aufrufbarer Start, Discord-Client, Teilnehmer-Cache und automatische Backups                       |
| `startup.js`                                                     | Startprüfung, Befehlsregistrierung, Anmeldung und Ressourcenfreigabe bei Startfehlern                      |
| `interactions.js`                                                | Befehlsliste, Routing von Interaktionen und gemeinsame Fehlerantworten                                     |
| `database.js`                                                    | SQLite-Schema, JSON-Übernahme, Transaktionen und Audit-Abfragen                                            |
| `match-store.js`, `league-settings.js`                           | Validierung und Speicherlogik; JSON-Kompatibilität für Übernahme/alte Backups                              |
| `json-storage.js`                                                | Gemeinsames atomisches Schreiben einzelner JSON-Dokumente und Bereinigung eigener temporärer Dateien       |
| `data-types.js`                                                  | Gemeinsame JSDoc-Datenstrukturen für Spieler, Reports, Season-Einstellungen und Änderungslog               |
| `season-rounds.js`                                               | Rundenplan, Playoff-Stufen, Rundenbezeichnungen, Auswahlprüfung und Rundenfilter                           |
| `season-setup.js`                                                | Private Einrichtungsdialoge, Vorausfüllung, Vorschau, Berechtigungs- und Konfliktprüfung vor dem Speichern |
| `permissions.js`                                                 | Gemeinsame Rollenprüfung und handelnde Person                                                              |
| `diagnostics.js`                                                 | Einheitliche Fehlerdiagnosen mit Fehlercodes, Ursachen und geprüften Kontextfeldern                        |
| `report-handler.js`, `reports.js`, `report-publisher.js`         | Report-Verarbeitung, Formular, Spoiler und persistenter Versandstatus                                      |
| `report-buttons.js`, `report-management.js`, `report-manager.js` | Buttons, Zugriffsprüfung, Korrekturen und Löschungen                                                       |
| `league-commands.js`, `audit-commands.js`                        | Verwaltung und Logdatei per DM                                                                             |
| `search-commands.js`                                             | Replay-Suche                                                                                               |
| `database-backups.js`, `data-backups.js`, `backup.js`            | SQLite- und ältere JSON-Sicherungen                                                                        |

Die Module lassen sich ohne automatischen Bot-Start importieren. Erst der CLI-Aufruf von `index.js` lädt `.env` und ruft `startBot()` aus `bot.js` auf. `startBot()` kann für Tests eine eigene Umgebung, einen Logger und Erzeuger für Discord-Clients erhalten; die Tests verwenden dabei die tatsächliche Verarbeitung mit simuliertem Discord und temporärer SQLite-Datenbank. Der Quelltext des Einstiegspunkts muss dafür nicht in einer separaten JavaScript-Umgebung nachgebildet werden.

Nach erfolgreichem Start gibt `startBot()` Client, Datenspeicher und Backup-Timer an den Aufrufer zurück. Bei einem Startfehler schließt es seine bereits geöffneten Ressourcen und reicht den Fehler weiter. Die Entscheidung, den Prozess mit einem Fehlercode zu beenden, liegt beim CLI-Einstieg. `npm start`, die Befehle und die Konfiguration bleiben gleich.

Die Speicher-Schnittstellen verwenden die JSDoc-Typen aus `data-types.js`. Ein Spieler besteht aus der dauerhaften Discord-ID und einem gespeicherten Anzeigenamen. Ein Match enthält Server, Kanal, Season, Runde, zwei Teilnehmer und Replay-Link; Melder, Ergebnis, Versandstatus und laufende Änderungen ergänzen den Report. Die Reihenfolge der gespeicherten Teilnehmer sagt nichts über Gewinner oder Verlierer aus. Season-Einstellungen enthalten Nummer, Anzahl der regulären Spieltage, Startdatum und gegebenenfalls den Wochenplan; die aktuelle Runde wird beim Lesen berechnet. Ältere manuelle Einstellungen und Reports mit ausschließlich einem numerischen Spieltag bleiben lesbar. Die Typbeschreibungen unterstützen den Editor; die Laufzeitvalidierung bleibt in den Speichermodulen.

Beide Speicher aktualisieren ihren Zustand erst nach erfolgreichem Schreiben. SQLite speichert Report und zugehörigen Logeintrag weiterhin in derselben Transaktion. Die JSON-Kompatibilität verwendet eine gemeinsame Hilfsfunktion: Sie schreibt in eine exklusiv angelegte temporäre Datei im Zielordner und ersetzt danach die Zieldatei per Umbenennung. Bei Fehlern bleibt der vorherige Stand erhalten; die Bereinigung entfernt nur die selbst angelegte temporäre Datei. Schlägt auch die Bereinigung fehl, bleiben beide Fehlerursachen für die Diagnose verfügbar. Datenformat und Konfiguration ändern sich dadurch nicht.

## Technische Fehlerprotokolle

Technische Fehler erscheinen im Terminal beziehungsweise in den Laufzeit-Logs des Railway-Services. Jede Meldung besteht aus einer festen Beschreibung und einem JSON-Objekt mit UTC-Zeitstempel, Vorgang (`operation`) und Fehlerursachen (`causes`). Soweit verfügbar kommen Server-, Kanal-, Nutzer-, Nachrichten- und Report-ID sowie Season und Spieltag hinzu. Dafür sind keine zusätzlichen Umgebungsvariablen oder Logdateien erforderlich.

Speicher- und Discord-Fehler behalten ihre ursprüngliche Ursache über `Error.cause`. Dadurch ist beispielsweise bei einer fehlgeschlagenen Reportänderung erkennbar, ob Discord die Änderung abgelehnt hat oder danach die Speicherung gescheitert ist. Scheitert zusätzlich ein Datenbank-Rollback, werden beide Ursachen ausgewertet. Eine technische Ursache wird auch dann protokolliert, wenn der Nutzer eine verständliche Fehlermeldung erhält. Normale Eingabefehler und fehlende Rollen erzeugen keine technischen Fehlereinträge.

| Diagnose                          | Bedeutung                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `EACCES`, `EPERM`                 | Dateirechte oder Dateisperren prüfen                                          |
| `ENOSPC`, `EDQUOT`                | Datenträger voll oder Speicherquote ausgeschöpft                              |
| `SQLITE_READONLY`                 | Schreibzugriff auf die Datenbank fehlt                                        |
| `SQLITE_FULL`                     | SQLite kann wegen eines Speicher- oder Datenbanklimits nicht weiter schreiben |
| `SQLITE_BUSY`, `SQLITE_LOCKED`    | Ein anderer Zugriff blockiert die Datenbank                                   |
| `SQLITE_CORRUPT`, `SQLITE_NOTADB` | Datenbankdatei beschädigt oder kein lesbares SQLite-Format                    |
| Discord-Code `50013` / HTTP `403` | Discord-Berechtigungen fehlen                                                 |

SQLite-Diagnosen enthalten neben `ERR_SQLITE_ERROR` den numerischen SQLite-Code und, soweit zugeordnet, dessen Namen. Auch erweiterte Codes werden ihrer Hauptkategorie zugeordnet. [SQLite-Fehlercodes](https://www.sqlite.org/rescode.html)

Es werden ausschließlich ausgewählte Fehlercodes, Typen und geprüfte Kontextfelder ausgegeben. Rohe Fehlertexte und Stacks, Request-Bodys, Header, Dateiinhalte, Replay-URLs und Ergebnisse werden nicht in die technischen Fehlermeldungen übernommen. Unbekannte Fehler bleiben als Fehlertyp sichtbar, ohne möglicherweise vertrauliche Freitexte auszugeben. Die Anzahl verketteter Ursachen ist begrenzt.

Das ist unabhängig vom fachlichen Änderungsprotokoll in SQLite: `/liga log season:…` liefert weiterhin die Report-Historie per DM, nicht diese technischen Fehlerdiagnosen.

## Fehlerbehebung

| Problem                                            | Prüfen                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `EBADENGINE` oder fehlendes `node:sqlite`          | Node.js 24 aktivieren und `npm ci` ausführen                                             |
| Datenbank-/Übernahmefehler beim Start              | Datenbank, JSON-Dateien, Schreibrechte und Speicher prüfen; keinen leeren Ersatz anlegen |
| Fehlender Intent                                   | Server Members Intent im Developer Portal aktivieren                                     |
| Veraltete Rechtsklick-Aktionen oder Slash-Optionen | Bot neu starten, Discord mit Strg+R/F5 neu laden, richtige Anwendung prüfen              |
| Ligaverwaltung erhält keine Freigabe               | Rollen-ID, Zuweisung und Kanal-/Integrationsrechte prüfen                                |
| Teilnehmer sieht `/liga log` nicht                 | Nicht die ganze `/liga`-Gruppe auf Admins beschränken; Anwendungsbefehle freigeben       |
| Bearbeiten wird abgelehnt                          | Es zählt der gespeicherte Melder; alte Melder können unbekannt sein                      |
| Älterer Post hat keine Buttons                     | Bestätigte Nachrichten-ID im Archiv und Zugriff auf den Post erforderlich                |
| Post manuell gelöscht                              | Verwaltung nutzt `/report-entfernen` mit Season und Spieler                              |
| DM bleibt aus                                      | DMs von Servermitgliedern erlauben und Bot-Blockierung prüfen                            |
| Unterbrochene Änderung                             | Speicher/Kanalrechte prüfen und denselben Vorgang erneut bestätigen                      |
| Ältere DM zeigt alte Werte                         | Neue Suche bzw. neues Protokoll anfordern                                                |
