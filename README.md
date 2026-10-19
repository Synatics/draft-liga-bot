# Draft-Liga-Bot

Ein selbst gehosteter Discord-Bot für Pokémon-Draft-Ligen. Er veröffentlicht Match-Ergebnisse mit Spoilern, ordnet sie einer Season und einem Spieltag zu und stellt gespeicherte Replay-Links über eine Suche per Direktnachricht bereit.

Der Bot verwendet Node.js, CommonJS und discord.js 14. Liga-Einstellungen und Replay-Metadaten liegen in lokalen JSON-Dateien. Eine externe Datenbank oder ein HTTP-Server ist nicht erforderlich; die Verbindung zu Discord läuft über den Gateway und die REST-API.

## Funktionen

- **Ergebnisse melden:** `/report` öffnet ein Modal mit Dropdowns für Spieltag, Gewinner und Verlierer sowie Eingabefeldern für Score und Replay-Link.
- **Teilnehmer aus einer Rolle:** Die Auswahl verwendet aktuelle Servermitglieder mit einer konfigurierten Rolle. Bots werden ausgeschlossen, Namen alphabetisch sortiert und Personen intern über Discord-IDs zugeordnet.
- **Spoiler im Ergebnispost:** Season und Spieltag erscheinen über dem Match-Titel. Gewinner, Verlierer und Score sind verborgen; die Reihenfolge der Namen im Titel wird unabhängig vom Gewinner zufällig gewählt.
- **Automatische Spieltage:** Eine Season wird einmal mit Startmontag und Anzahl der Spieltage eingerichtet. Der aktuelle Spieltag folgt dem Kalender in `Europe/Berlin`.
- **Replay-Suche:** `/suchen` filtert nach Season, Spieler und optional Spieltag. Die Treffer kommen als normale DMs mit Spieltag, Teilnehmern und Replay-Link.
- **Dauerhafte Speicherung:** Konfiguration und Archiv bleiben bei Neustarts erhalten, sofern das Datenverzeichnis auf persistentem Speicher liegt.
- **Automatische Backups:** Der Bot sichert beide Datendateien täglich und bewahrt die letzten 14 Sicherungen auf. Ein Terminal-Befehl ermöglicht zusätzliche manuelle Sicherungen.
- **Duplikatschutz:** Wiederholte und gleichzeitige Meldungen desselben Matches erzeugen keinen weiteren öffentlichen Post. Veröffentlichte Nachrichten werden im Archiv referenziert.
- **Reports korrigieren und löschen:** Die beiden gespeicherten Match-Teilnehmer und Personen mit „Server verwalten“ können einen Ergebnispost über sein Nachrichtenmenü bearbeiten oder nach privater Bestätigung entfernen. Die Suche wird dabei mit aktualisiert.

## Voraussetzungen

- **[Node.js 24 LTS](https://nodejs.org/en/download)** und das mitgelieferte npm. Den Release-Status dokumentiert das [Node.js-Projekt](https://nodejs.org/en/about/previous-releases).
- Git zum Klonen des Repositories.
- Eine eigene Discord-Anwendung mit Bot-Token und Zugang zu einem Discord-Server für die Installation.
- Mindestens zwei menschliche Liga-Teilnehmer mit einer gemeinsamen Teilnehmerrolle.
- Ein beschreibbares, für dauerhaften Betrieb persistentes Datenverzeichnis.

Die aktuelle Teilnehmerkonfiguration enthält **eine Rollen-ID pro Bot-Instanz**. Die Einrichtung ist deshalb auf einen Liga-Server pro Instanz ausgelegt. Einstellungen und Archiv sind intern zusätzlich nach Server-ID getrennt.

Die unterstützte Node.js-Reihe ist in `package.json` mit `engines.node: "24.x"` und in [`.nvmrc`](.nvmrc) mit `24` festgelegt. Dadurch bleiben neuere Minor- und Patch-Versionen innerhalb von Node.js 24 möglich. [`.npmrc`](.npmrc) aktiviert `engine-strict`, sodass npm die Installation mit einer unpassenden Node.js-Version abbricht. Diese Dateien installieren oder aktivieren lokal keine Node.js-Version automatisch; auch `npm start` wechselt die Laufzeit nicht selbst.

## Installation

### 1. Discord-Anwendung erstellen und installieren

Im [Discord Developer Portal](https://discord.com/developers/applications) eine Anwendung anlegen und konfigurieren:

1. Unter **General Information** die **Application ID** kopieren. Sie wird später als `CLIENT_ID` verwendet.
2. Unter **Bot** ein Bot-Token erstellen bzw. über **Reset Token** erzeugen. Dieses Token wird als `DISCORD_TOKEN` hinterlegt. Es ist weder der Client Secret noch der Public Key.
3. Unter **Bot → Privileged Gateway Intents** den **Server Members Intent** aktivieren. Der Bot fordert `Guilds` und `GuildMembers` an. Message Content Intent und Presence Intent werden nicht benötigt.
4. Unter **Installation** den Kontext **Guild Install** aktivieren und für die Serverinstallation die Scopes **`bot`** und **`applications.commands`** auswählen.
5. Dem Bot die unten aufgeführten Kanalrechte geben und ihn über den Installationslink dem gewünschten Server hinzufügen.

Der Bot wird als Server-App installiert. Eine reine Installation zum persönlichen Account ersetzt diese Serverinstallation nicht. Ein Interactions Endpoint oder eine öffentliche URL muss für dieses Projekt nicht eingerichtet werden.

| Bot-Berechtigung | Verwendung |
| --- | --- |
| View Channel / Kanal anzeigen | Zugriff auf den Kanal für Ergebnisposts |
| Send Messages / Nachrichten senden | Ergebnisposts veröffentlichen |
| Embed Links / Links einbetten | Ergebnis als Embed anzeigen |
| Read Message History / Nachrichtenverlauf anzeigen | Vorhandene Ergebnisposts für Korrekturen und Löschungen laden |
| Send Messages in Threads / Nachrichten in Threads senden | Zusätzlich erforderlich, wenn Ergebnisse in Threads gepostet werden sollen |

Die Rechte müssen auch in den konkreten Kanälen erlaubt sein; Kanal-Overrides können die Serverrechte überschreiben. Administrator- und Rollenverwaltungsrechte benötigt der Bot nicht. Er liest die Teilnehmerrolle, weist sie aber niemandem selbst zu.

Weiterführend: [Discord-App einrichten](https://docs.discord.com/developers/quick-start/getting-started), [Gateway Intents](https://docs.discord.com/developers/events/gateway#privileged-intents), [Discord-Berechtigungen](https://docs.discord.com/developers/topics/permissions).

### 2. Teilnehmerrolle vorbereiten

1. Auf dem Liga-Server eine Rolle wie **Liga-Teilnehmer** anlegen oder eine bestehende verwenden.
2. Diese Rolle allen Personen geben, die im Ergebnisformular auswählbar sein sollen. Die Rolle `@everyone` ist dafür nicht geeignet.
3. In Discord unter **Benutzereinstellungen → Erweitert** den Entwicklermodus aktivieren.
4. Auf die Rolle rechtsklicken und **Rollen-ID kopieren** auswählen. Diese ID wird als `PARTICIPANT_ROLE_ID` hinterlegt; nicht den Rollennamen eintragen.
5. Optional die Server-Spitznamen auf die gewünschten Liga-Namen setzen. Ohne Spitznamen verwendet der Bot den Discord-Anzeigenamen.

Die Auswahl unterstützt **2 bis 25 Teilnehmer**. Bei identischen Namen ergänzt das Formular den Accountnamen zur Unterscheidung. Rollen- und Namensänderungen werden über die Mitgliederereignisse übernommen. Für eine neue Season reicht es, Personen zur bestehenden Rolle hinzuzufügen oder sie zu entfernen; eine Namensliste im Code gibt es nicht.

### 3. Repository klonen und Abhängigkeiten installieren

```sh
git clone https://github.com/Synatics/draft-liga-bot.git
cd draft-liga-bot
```

Vor der Installation Node.js 24 aktivieren. Mit einem bereits eingerichteten [NVM for Windows](https://github.com/coreybutler/nvm-windows) oder [nvm unter Linux/macOS](https://github.com/nvm-sh/nvm) geht das so:

```sh
nvm install 24
nvm use 24
```

Unter Linux/macOS lesen auch `nvm install` und `nvm use` ohne Versionsangabe die `.nvmrc`. Ohne Versionsmanager eine aktuelle Node.js-24-Version über die offizielle Downloadseite installieren. Danach im Terminal prüfen, dass `node --version` mit `v24.` beginnt, und die Abhängigkeiten installieren:

```sh
node --version
npm ci
```

`npm ci` installiert die im Lockfile festgelegten Abhängigkeiten.

### 4. Umgebungsvariablen konfigurieren

Die Datei [`.env.example`](.env.example) im Projektverzeichnis nach `.env` kopieren.

**Windows / PowerShell:**

```powershell
Copy-Item .env.example .env
```

**Linux / macOS:**

```sh
cp .env.example .env
```

Anschließend die Platzhalter in `.env` ersetzen:

```dotenv
DISCORD_TOKEN=dein-bot-token
CLIENT_ID=deine-application-id
PARTICIPANT_ROLE_ID=deine-teilnehmerrollen-id

# Optional: anderer Datenordner
# DATA_DIR=./data
```

| Variable | Pflicht | Beschreibung |
| --- | --- | --- |
| `DISCORD_TOKEN` | Ja | Bot-Token der eigenen Discord-Anwendung |
| `CLIENT_ID` | Ja | Application ID derselben Anwendung; muss zum Token passen |
| `PARTICIPANT_ROLE_ID` | Ja | ID der Teilnehmerrolle auf dem Liga-Server; wird für `/report` verwendet |
| `DATA_DIR` | Nein | Verzeichnis für beide JSON-Dateien; relative Pfade beziehen sich auf das Arbeitsverzeichnis des Prozesses |
| `RAILWAY_VOLUME_MOUNT_PATH` | Automatisch auf Railway | Von Railway gesetzter Mount-Pfad des verbundenen Volumes |
| `RAILWAY_ENVIRONMENT_ID` | Automatisch auf Railway | Aktiviert die Prüfung, dass ein Railway-Volume vorhanden ist und `DATA_DIR` darin liegt |

Vom Hosting gesetzte Umgebungsvariablen können anstelle einer `.env` verwendet werden. Token und echte `.env`-Dateien gehören nicht ins Repository. `.env` und `data/` sind bereits von Git ausgeschlossen.

### 5. Bot starten

```sh
npm start
```

Der Start erfolgt über `node index.js` mit einer festen Reihenfolge:

1. `DISCORD_TOKEN`, `CLIENT_ID` und `PARTICIPANT_ROLE_ID` auf fehlende bzw. ungültige Werte prüfen. Die IDs müssen aus 17 bis 20 Ziffern bestehen; Beispielwerte werden abgewiesen. Führende und folgende Leerzeichen werden bei diesen drei Werten entfernt. Das Token darf keine Leerzeichen innerhalb des Werts enthalten. Eine ausdrücklich gesetzte, aber leere `DATA_DIR` ist ebenfalls ein Fehler.
2. Den Datenpfad einschließlich Railway-Volume prüfen. Eine eigene temporäre Datei testet Schreiben, Umbenennen und Entfernen, ohne vorhandene Datendateien umzuschreiben.
3. Die gespeicherten Liga-Einstellungen und das Replay-Archiv laden und validieren. Bei einer frischen Installation wird ein leeres Archiv angelegt; eine Season muss zu diesem Zeitpunkt noch nicht eingerichtet sein.
4. Die Slash-Befehle bei Discord registrieren. Bei einem Fehler erfolgt keine Gateway-Anmeldung.
5. Mit Discord verbinden und auf `ClientReady` warten. Beim Ready-Ereignis beginnt der Mitgliederabruf für die Teilnehmerauswahl.
6. Die automatischen Backups starten.

Ein erfolgreicher Start protokolliert diese Meldungen:

```text
✅ Konfiguration und Datenspeicher geprüft.
✅ Discord-Befehle registriert: /report, /liga, /suchen, „Report korrigieren“, „Report löschen“, /report-entfernen
✅ Bot ist mit Discord verbunden.
```

Bei einem Startfehler erscheint eine verständliche Meldung mit `Bot-Start abgebrochen`, und der Prozess endet mit **Exit-Code 1**. Registrierung und Anmeldung haben zusammen ein Zeitlimit von **60 Sekunden**. Beim Abbruch wird der Client geschlossen; dafür wartet der Bot höchstens weitere fünf Sekunden. Ein fehlgeschlagener Start bleibt damit nicht als scheinbar funktionsfähiger Bot-Prozess laufen. Die Startfehler-Ausgabe enthält keine Token-Werte, rohen Discord-Fehlerobjekte oder Request-Daten.

Die lokale Prüfung eines Tokens betrifft fehlende Werte, den Beispielwert und Leerzeichen; ob es gültig ist und zur `CLIENT_ID` gehört, prüft Discord bei der Registrierung bzw. Anmeldung. Ob die Teilnehmerrolle auf einem konkreten Server existiert, wird weiterhin bei `/report` geprüft. Ein formal gültiger Rollenwert allein bestätigt deshalb noch nicht die korrekte Serverkonfiguration.

Eine noch nicht eingerichtete Season, ein fehlgeschlagenes Backup oder ein gescheiterter Mitgliederabruf sind keine fatalen Startfehler. Die Season lässt sich mit `/liga season` einrichten; Mitgliederabrufe und Backups können erneut versucht werden. Während der erste Mitgliederabruf läuft, bittet `/report` um einen erneuten Aufruf. Nach dem Laden öffnet sich das Formular ohne zusätzlichen Mitgliederabruf.

Alle Anwendungsbefehle werden bei jedem Start **global für die Anwendung registriert**. Dabei ersetzt der Bot die globale Befehlsliste dieser Anwendung durch `/report`, `/liga`, `/suchen`, `/report-entfernen` und die beiden Nachrichtenaktionen „Report korrigieren“ und „Report löschen“. Für dieses Projekt sollte daher eine eigene Discord-Anwendung verwendet werden. Ein separates Deploy-Commands-Skript ist nicht nötig.

### 6. Erste Season einrichten

Auf dem Liga-Server den Slash-Befehl auswählen und seine Optionen ausfüllen:

```text
/liga season nummer:4 spieltage:9 startdatum:19.10.2026
```

Dieses Beispiel richtet Season 4 mit neun Spieltagen ab Montag, dem 19.10.2026, ein. Vor dem ersten `/report` muss die Season eingerichtet sein.

Danach ein Match mit `/report` melden und dessen Replay mit `/suchen` abrufen. Ein Neustart darf die Season-Einstellungen und Suchtreffer nicht entfernen.

## Befehle

Alle Befehle werden **in einem Serverkanal** ausgeführt. `/suchen` liefert seine Treffer anschließend per DM; es wird nicht in der DM gestartet. Die folgenden Beispiele zeigen die Optionen eines Slash-Befehls. Eine als normale Chatnachricht eingefügte Beispielzeile führt ihn nicht aus.

| Befehl | Zweck | Zugriffsanforderung |
| --- | --- | --- |
| `/report` | Ergebnisformular öffnen und im aktuellen Kanal posten | Anwendungsbefehle im Kanal verwenden dürfen; eingerichtete Season und Teilnehmerrolle |
| `/liga season` | Season einrichten oder Konfiguration korrigieren | Server verwalten (`ManageGuild`) |
| `/liga status` | Aktuelle Season, Spieltag und Startdatum anzeigen | Server verwalten (`ManageGuild`) |
| `/suchen` | Gespeicherte Replays eines Spielers per DM abrufen | Anwendungsbefehle verwenden dürfen; lesbare Ergebnis-Kanäle und zustellbare DMs |
| Nachrichtenaktion „Report korrigieren“ | Vorhandenen Ergebnispost und Suchtreffer korrigieren | Einer der beiden gespeicherten Match-Teilnehmer oder Server verwalten; Zugriff auf den Ergebniskanal |
| Nachrichtenaktion „Report löschen“ | Ergebnispost und Archiv-Eintrag nach Bestätigung löschen | Dieselben Anforderungen wie bei Korrekturen |
| `/report-entfernen season:… name:… spieltag:…` | Gespeicherten Report finden und nach Bestätigung entfernen; Spieltag optional | Dieselben Anforderungen; funktioniert auch bei bereits gelöschtem Post |

Der Aufruf von `/report` oder `/suchen` ist im Code nicht auf Personen mit Teilnehmerrolle beschränkt. Die Rolle bestimmt, welche Personen als Spieler für ein neues Match ausgewählt werden können. Zusätzliche Einschränkungen lassen sich über Discord-Kanal- und Integrationsrechte konfigurieren.

### `/report`

Das Modal enthält fünf Pflichtfelder:

| Feld | Verhalten |
| --- | --- |
| Spieltag | Aktueller Spieltag vorausgewählt; jeder Spieltag der konfigurierten Season auswählbar |
| Gewinner | Dropdown mit menschlichen Mitgliedern der Teilnehmerrolle |
| Verlierer | Dieselbe Teilnehmerauswahl; muss eine andere Person sein |
| Ergebnis | Freitext, z. B. `2-0`, maximal 100 Zeichen; kein festes Score-Format erzwungen |
| Replay Link | Ein gültiger `http://`- oder `https://`-Link, maximal 1024 Zeichen nach URL-Normalisierung |

Der Link muss keine bestimmte Replay-Domain verwenden. Der Bot prüft URL-Format und Länge, ruft das Replay aber nicht ab und verifiziert weder dessen Inhalt noch den angegebenen Score.

Beim Absenden werden die ausgewählten Mitglieder erneut geladen und auf Serverzugehörigkeit, Teilnehmerrolle und Bot-Status geprüft. Ein Formular aus einer inzwischen gewechselten Season wird abgewiesen. Der ausgewählte Spieltag bleibt auch bei Nachholspielen erhalten.

Der Ergebnispost wird im **Kanal des Befehlsaufrufs** veröffentlicht. Die Bestätigung ist nur für die meldende Person sichtbar. Die öffentliche Nachricht enthält Season, Spieltag, beide Namen und Replay-Link; Gewinner, Verlierer und Score sind mit Discord-Spoilern markiert.

Wurde dasselbe Match bereits veröffentlicht, erhält die meldende Person stattdessen einen Link zum bestehenden Ergebnispost. Während eines laufenden Versands erscheint ein entsprechender Hinweis. Ein anderer Score oder vertauschte Gewinner- und Verliererauswahl umgehen den Duplikatschutz nicht.

### Reports korrigieren und entfernen

**Korrigieren:** Den Ergebnispost rechtsklicken bzw. auf Mobilgeräten gedrückt halten und unter **Apps** die Aktion **Report korrigieren** auswählen. Die Bezeichnung bzw. Platzierung des Nachrichtenmenüs kann je nach Discord-Client abweichen. Die Bearbeitung erfolgt in zwei Schritten:

1. Eine nur für die bearbeitende Person sichtbare Nachricht zeigt den bisherigen Post sowie getrennte **Dropdowns für Season und Spieltag**. Die bisherigen Werte sind vorausgewählt. Die Season-Liste entsteht aus dem Archiv dieses Servers und der aktuellen Liga-Einstellung. Sie zeigt bis zu 24 Seasons; über **Andere Season …** lässt sich jede Season-Nummer von 1–9999 eingeben. Eine neue Season erfordert keine Codeänderung. Für die aktuell eingerichtete Season stehen nur deren konfigurierte Spieltage zur Auswahl, für andere Seasons die Spieltage 1–25. Beim Wechsel in eine kürzere Season wird ein zu hoher Spieltag auf deren letzten Spieltag gesetzt.
2. **Weiter: Ergebnis bearbeiten** öffnet das vorausgefüllte Formular mit den Dropdowns für Gewinner und Verlierer, dem Score und dem Replay-Link. Season und Spieltag stehen zur Kontrolle im Formulartitel.

Erst das Absenden dieses Formulars speichert die Korrektur. Die Auswahl der Dropdowns und **Abbrechen** verändern weder den Ergebnispost noch das Archiv. Die globale Liga-Konfiguration bleibt bei einer Report-Korrektur unverändert. Beim Absenden werden die gewählten Werte und die aktuelle Spieltaggrenze erneut geprüft.

Die bisherigen Teilnehmer bleiben für historische Korrekturen auswählbar, auch ohne aktuelle Teilnehmerrolle oder Servermitgliedschaft. Zusätzliche Personen stammen aus der Teilnehmerrolle und werden beim Absenden erneut geprüft. Gespeicherte Namen bleiben für bereits beteiligte Personen erhalten. Bei identischen gespeicherten Namen muss die Zuordnung von Gewinner und Verlierer erneut ausgewählt werden; der Bot rät nicht. Das Formular unterstützt insgesamt höchstens 25 Teilnehmer.

Nach dem Absenden wird **derselbe Post** bearbeitet. Sein Nachrichtenlink bleibt erhalten, Spoiler und Erwähnungsschutz bleiben aktiv, und `/suchen` verwendet die korrigierten Angaben. Ein zweiter Ergebnispost entsteht dabei nicht. Existiert für die neuen Angaben schon ein anderer Report, wird die Korrektur abgewiesen.

**Löschen:** Am Ergebnispost unter **Apps → Report löschen** die private Rückfrage mit **Ja, Report löschen** bestätigen oder mit **Abbrechen** schließen. Erst die Bestätigung entfernt den öffentlichen Post und seinen Archiv-Eintrag. Das Match erscheint danach nicht mehr in neuen Suchen und kann bei Bedarf neu gemeldet werden.

**Ohne vorhandenen Discord-Post:** `/report-entfernen` durchsucht das Archiv nach Season und Spieler. Ein Nachrichtenlink ist dafür nicht nötig. Mit dem optionalen Spieltag lässt sich die Auswahl eingrenzen:

```text
/report-entfernen season:4 name:Jan
/report-entfernen season:4 name:Jan spieltag:3
```

Die Namensvorschläge stammen aus den gespeicherten Reports dieser Season. Frühere Namen und Teilnehmer ohne aktuelle Rolle bleiben auffindbar; bei identischen Namen muss ein eindeutiger Vorschlag ausgewählt werden. Ergebnisse und Vorschläge berücksichtigen nur Reports, die die aufrufende Person verwalten darf und deren Ergebniskanal sie lesen kann. Die Mitgliedschaft in privaten Threads wird erneut geprüft.

Bei genau einem Treffer erscheint direkt die private Bestätigung. Bei mehreren Treffern zeigt ein Dropdown Spieltag, beide Teilnehmer und den Replay-Link; Listen mit mehr als 25 Treffern haben Seiten. Nach der Auswahl zeigt die Bestätigung nochmals Season, Spieltag, Teilnehmer, Replay-Link und Kanal. Erst **Ja, Report löschen** entfernt genau diesen Report. Existiert der öffentliche Post noch, wird er ebenfalls gelöscht; andernfalls wird nur das Archiv bereinigt. Eine inzwischen geänderte Auswahl muss erneut geöffnet werden.

Die Aktion funktioniert für bestätigte Veröffentlichungen mit intern gespeicherter Nachrichten-ID, die der Bot selbst verwendet. Die aufrufende Person muss diese ID weder kennen noch eingeben. Ältere Archiveinträge ohne diese Verknüpfung und Meldungen mit unklarem ursprünglichem Versandstatus werden nicht automatisch zugeordnet. Die Suche setzt keine aktuell eingerichtete Season voraus und verändert vor der Bestätigung keine Daten.

**Zugriff:** Berechtigt sind die im Archiv gespeicherten beiden Match-Teilnehmer sowie Personen mit `ManageGuild` / Server verwalten. Eine zusätzliche Rolle ist nicht erforderlich. Die Berechtigung wird beim Öffnen und beim Absenden bzw. Bestätigen erneut geprüft. Zusätzlich muss die Person den Ergebniskanal und Nachrichtenverlauf lesen dürfen; bei privaten Threads prüft der Bot vor der Änderung die aktuelle Mitgliedschaft oder `ManageThreads`. Der Bot bearbeitet und löscht nur eigene Posts und benötigt dafür kein Recht zum Verwalten fremder Nachrichten.

Ein Formular oder eine Bestätigung kann nur von der Person verwendet werden, die es geöffnet hat. Wurde der Report zwischenzeitlich geändert, muss die Aktion erneut geöffnet werden. Bereits verschickte Such-DMs und vorhandene Backups werden durch Korrekturen oder Löschungen nicht nachträglich verändert.

### `/liga season` und `/liga status`

```text
/liga season nummer:4 spieltage:9 startdatum:19.10.2026
/liga status
```

| Option von `/liga season` | Werte |
| --- | --- |
| `nummer` | Ganze Zahl von 1 bis 9999 |
| `spieltage` | Ganze Zahl von 1 bis 25 |
| `startdatum` | Reales Kalenderdatum als `TT.MM.JJJJ` oder `JJJJ-MM-TT`; muss ein Montag sein |

Die Konfiguration gilt pro Discord-Server und wird sofort gespeichert. `/liga season` kann auch zur Korrektur von Startdatum oder Spieltaganzahl erneut ausgeführt werden. Bestehende Archiv-Einträge und Discord-Posts werden dadurch nicht verändert. Für eine neue Season eine neue Season-Nummer verwenden.

**Berechnung des Spieltags:**

- Startmontag bis Sonntag: Spieltag 1; ab dem nächsten Montag: Spieltag 2 usw.
- Maßgeblich ist `Europe/Berlin`, unabhängig von der Zeitzone des Hostsystems.
- Kalenderwochen werden anhand von lokalen Kalenderdaten berechnet; die Sommerzeitumstellung verschiebt den Wochenwechsel nicht.
- Der Spieltag wird beim Öffnen des Formulars bzw. bei `/liga status` berechnet. Ein wöchentlicher Hintergrundjob ist nicht nötig.
- Vor dem Start wird Spieltag 1 vorausgewählt, nach Season-Ende der letzte Spieltag.
- Der Bot startet keine nächste Season selbstständig. Diese wird einmal per `/liga season` eingerichtet.

Ältere Einstellungsdateien mit manuellem `currentMatchday` bleiben lesbar. Einmal `/liga season` mit Startdatum ausführen, um diese auf die Wochenberechnung umzustellen.

### `/suchen`

```text
/suchen season:4 name:Jan
/suchen season:4 name:Jan spieltag:3
```

| Option | Pflicht | Verhalten |
| --- | --- | --- |
| `season` | Ja | Season-Nummer von 1 bis 9999 |
| `name` | Ja | Spieler aus den Autocomplete-Vorschlägen auswählen; ein eindeutig zuordenbarer gespeicherter Name funktioniert ebenfalls |
| `spieltag` | Nein | Ganze Zahl von 1 bis 25; ohne Angabe werden alle passenden Spieltage berücksichtigt |

Zuerst die Season eintragen. Die Namensvorschläge stammen ausschließlich aus gespeicherten Matches dieser Season und benötigen keine aktuelle Teilnehmerrolle. Die Suche verwendet Discord-IDs und berücksichtigt Namens-Snapshots aus den gespeicherten Matches. Bei mehrdeutigen Namen muss ein Vorschlag ausgewählt werden.

Es werden nur Archiv-Einträge desselben Servers aus für die suchende Person lesbaren Kanälen berücksichtigt. Erforderlich sind `ViewChannel` und `ReadMessageHistory`. Bei privaten Threads berücksichtigt der Bot zusätzlich bekannte Thread-Mitgliedschaften oder `ManageThreads`; nicht im Cache verfügbare Kanäle werden ausgelassen.

Die Treffer sind nach Spieltag aufsteigend sortiert und werden in diesem Layout per DM gesendet:

```text
Spieltag 3 · Jan vs. Max
https://replay.pokemonshowdown.com/...
```

Spieltag und Paarung werden in Discord fett dargestellt. Gewinner und Score gehören nicht zur Suchausgabe. Nachrichten werden an Discords Grenze von 2000 Zeichen aufgeteilt; Linkvorschauen und Erwähnungen sind deaktiviert.

Im Kanal erscheint ausschließlich eine ephemere Bestätigung oder Fehlermeldung. Für die Zustellung müssen DMs erlaubt sein; außerdem darf der Bot nicht blockiert sein. Bei teilweise fehlgeschlagenem Versand zeigt die Rückmeldung die Zahl bereits zugestellter Nachrichten an. Ohne Treffer wird keine DM verschickt.

Versendete DMs bleiben ein Snapshot der jeweiligen Suche. Neue Reports aktualisieren alte DMs nicht automatisch.

## Datenspeicherung und Betrieb

### Speicherort und Datenmodell

Die Auswahl des Datenverzeichnisses erfolgt in dieser Reihenfolge:

1. `DATA_DIR`, falls gesetzt.
2. `RAILWAY_VOLUME_MOUNT_PATH`, falls gesetzt.
3. `data/` im Projektverzeichnis.

| Datei | Inhalt |
| --- | --- |
| `league-settings.json` | Formatversion 1; Objekt `guilds`, das pro Server-ID `season`, `matchdays` und `startDate` enthält |
| `matches.json` | Formatversion 1; Array `matches` mit den gespeicherten Replay-Metadaten |

Ein Match enthält `guildId`, `channelId`, `season`, `matchday`, zwei `players` mit jeweils `id` und `name` sowie `link`. Die Spieler werden in einer stabilen Reihenfolge nach ID gespeichert, ohne Gewinner und Verlierer zu kennzeichnen. Abgeschlossene Archiv-Einträge enthalten keinen Score.

Abgeschlossene Korrekturen ergänzen einen Zähler `revision`, damit veraltete Formulare erkannt werden. Während einer laufenden Korrektur bzw. Löschung enthält der Eintrag außerdem vorübergehend `change`: die Art der Änderung und bei einer Korrektur die gewünschten Metadaten sowie das vollständig formatierte Embed. Dieses vorübergehende Embed enthält auch Gewinner, Verlierer und Score, damit ein unterbrochener Versuch idempotent am selben Discord-Post wiederholt werden kann. Nach erfolgreichem Abschluss wird `change` entfernt. Ein währenddessen erstelltes Backup kann diese vorübergehenden Daten bis zu seiner regulären Entfernung weiterhin enthalten. Die Suche gibt ausschließlich Teilnehmer, Spieltag und Replay-Link aus.

Neue Einträge enthalten zusätzlich eine zufällige, 24 Zeichen lange hexadezimale `id` und das Objekt `publication`. Darin werden `status` und bei bestätigter Veröffentlichung die Discord-`messageId` gespeichert. Die Formatversion bleibt 1; bestehende Einträge ohne diese Metadaten bleiben lesbar und durchsuchbar. Sie werden beim Laden nicht umgeschrieben und nicht erneut automatisch veröffentlicht, da ihr bisheriger Versandstatus unbekannt ist.

Die Dateien werden beim Start eingelesen und im Arbeitsspeicher gehalten. Änderungen werden synchron in eine temporäre Datei geschrieben, die anschließend per Rename die bisherige JSON-Datei ersetzt. Beschädigte vorhandene Dateien führen zu einem Fehler statt zu einem stillen Zurücksetzen. Beim ersten Start wird ein leeres Replay-Archiv angelegt, wodurch auch die Schreibbarkeit des Verzeichnisses geprüft wird.

### Verhalten beim Melden und bei Fehlern

1. Eingaben, ausgewählte Mitglieder und Season-Zuordnung werden geprüft.
2. Vorhandene Einträge mit derselben Server-ID, Kanal-ID, Season, Spieltag, denselben beiden Spieler-IDs und demselben normalisierten Replay-Link werden erkannt.
3. Ein neues Match wird mit dem Status `pending` gespeichert. Bereits veröffentlichte, laufende oder ältere Einträge ohne Versandstatus werden nicht erneut gesendet.
4. Vor dem Discord-Aufruf wird der Status `sending` dauerhaft gespeichert. Eine zusätzliche Sperre pro Match verhindert parallele Versandversuche im selben Prozess.
5. Nach erfolgreicher Discord-Antwort werden Status `published` und Nachrichten-ID gespeichert.
6. Die meldende Person bekommt eine private Rückmeldung.

| Veröffentlichungsstatus | Bedeutung |
| --- | --- |
| `pending` | Noch kein Versand gestartet oder Discord hat den Versuch eindeutig abgelehnt; erneuter Versuch möglich |
| `sending` | Versand läuft oder sein Ausgang ist nach Abbruch, Netzwerkfehler oder Speicherfehler unklar; kein automatischer erneuter Versand |
| `published` | Discord hat den Post bestätigt und dessen Nachrichten-ID wurde gespeichert; weitere Meldungen verweisen auf den vorhandenen Post |

Schlägt das Speichern vor dem Versand fehl, wird kein öffentlicher Ergebnispost gesendet. Bei einer eindeutigen Discord-Ablehnung mit HTTP-Status 4xx, ausgenommen 408, wird der Eintrag wieder auf `pending` gesetzt. Nach Beheben der Ursache kann `/report` erneut abgesendet werden. Der Suchtreffer bleibt in beiden Fällen erhalten.

Bei einem Timeout, einer unterbrochenen Verbindung oder einem Serverfehler könnte Discord den Post bereits angelegt haben. Auch ein Absturz zwischen Versand und Speicherung der Nachrichten-ID lässt sich nicht sicher von einem fehlgeschlagenen Versand unterscheiden. Deshalb bleibt `sending` gespeichert und der Bot blockiert weitere Versuche auch nach einem Neustart, statt einen doppelten Post zu riskieren. Die private Rückmeldung erklärt diesen Fall. Dasselbe gilt, wenn nach einer eindeutigen Ablehnung der Status nicht zurückgespeichert werden konnte.

Zusätzlich nutzt der Discord-Aufruf die Match-ID als `nonce` mit `enforceNonce`. Discord kann dadurch wiederholte API-Aufrufe innerhalb der letzten Minuten derselben Nachricht zuordnen. Der dauerhafte Schutz nach Neustarts beruht auf dem gespeicherten Status, nicht auf dieser zeitlich begrenzten API-Funktion. Siehe [Create Message](https://docs.discord.com/developers/resources/message#create-message).

Ein gespeicherter Treffer ist weiterhin unabhängig vom Versandstatus über `/suchen` auffindbar. Bereits vorhandene doppelte Discord-Posts werden durch das Update nicht gelöscht.

### Laufende Korrekturen und Löschungen

Eine Änderung wird vor dem ersten Discord-Aufruf dauerhaft im Archiv vorgemerkt. Gleichzeitig ausgeführte Änderungen desselben Reports werden gesperrt. Bei Korrekturen schützt der Duplikatschutz währenddessen sowohl die bisherigen als auch die gewünschten Match-Angaben. Der Archiv-Eintrag für die Suche wechselt erst nach erfolgreicher Discord-Antwort auf die neuen Angaben bzw. wird erst dann entfernt.

Schlägt die Speicherung der Vormerkung fehl, erfolgt keine Änderung in Discord. Eine eindeutige Ablehnung eines frisch begonnenen Versuchs hebt die Vormerkung wieder auf, sofern der Datenspeicher dies zulässt. Bei unklarem Netzwerkergebnis oder fehlgeschlagener abschließender Speicherung bleibt sie erhalten, auch nach einem Neustart. Die private Rückmeldung erklärt den Fehler. Der Bot erstellt dabei keinen Ersatzpost und wiederholt Änderungen nicht im Hintergrund.

Zum Fortsetzen einer vorgemerkten Korrektur erneut **Report korrigieren** am bestehenden Post öffnen. Der Bot schließt zuerst die bisherige Änderung ab; für weitere Änderungen die Aktion danach erneut öffnen. Eine vorgemerkte Löschung wird durch **Report löschen** und erneutes Bestätigen bzw. über `/report-entfernen` abgeschlossen. Ist der Post bereits entfernt, gilt dessen Fehlen für die Löschung als Erfolg. Eine bestätigte Löschung kann auch eine noch ungeklärte Korrektur desselben Posts ersetzen.

Falls die Rechte oder der Datenspeicher weiterhin fehlen, bleibt die Vormerkung erhalten. Sie wird bei einem fehlgeschlagenen Wiederholungsversuch nicht verworfen, weil der frühere Versuch bereits in Discord angekommen sein könnte. Bei älteren Reports ohne bekannte Nachrichten-ID bleibt die bisherige manuelle Prüfung erforderlich.

### Unklaren Versandstatus manuell prüfen

Dieser Sonderfall erfordert eine Prüfung durch die Person, die den Bot betreibt:

1. Den Bot stoppen und eine Sicherung von `matches.json` anlegen.
2. Den betroffenen Eintrag über Season, Spieltag, Teilnehmer und Replay-Link zuordnen und im betreffenden Discord-Kanal prüfen, ob der Ergebnispost vorhanden ist.
3. Ist der Post vorhanden, dessen Nachrichten-ID in `publication.messageId` eintragen und `publication.status` auf `published` setzen.
4. Ist sicher kein Post vorhanden, `publication` auf `{ "status": "pending" }` setzen und die vorhandene Match-`id` beibehalten. Danach darf der Report erneut abgesendet werden.
5. Den Bot wieder starten.

Bei alten Einträgen ohne Veröffentlichungsmetadaten kann der Bot keinen vorhandenen Post-Link ermitteln; ein automatisches Einlesen alter Discord-Nachrichten findet nicht statt. Soll ein solcher Eintrag nach manueller Prüfung freigegeben oder einem vorhandenen Post zugeordnet werden, muss zusätzlich eine neue `id` eingetragen werden. Eine passende ID lässt sich mit folgendem Befehl erzeugen:

```sh
node -e "console.log(require('node:crypto').randomBytes(12).toString('hex'))"
```

Anschließend `publication` wie oben beschrieben auf `pending` bzw. `published` mit `messageId` setzen. Diese Änderung ebenfalls nur bei gestopptem Bot und nach Sicherung vornehmen.

### Grenzen und Betriebshinweise

- Das Archiv enthält nur Reports, die der Bot über `/report` gespeichert hat. Es gibt keinen Import alter Discord-Nachrichten.
- Neue Seasons löschen keine früheren Matches. Auch die Suche nach abgeschlossenen Seasons bleibt verfügbar.
- Nur die Bot-Aktionen zum Korrigieren und Löschen halten Discord-Post und Archiv gemeinsam aktuell. Manuelles Löschen in Discord entfernt den Archiv-Eintrag nicht; `/report-entfernen` kann ihn über Season und Spieler finden und bereinigen.
- Für jede Installation sind höchstens 25 Teilnehmer und 25 Spieltage pro Season vorgesehen.
- Eine Bot-Instanz muss dauerhaft laufen, damit die Befehle beantwortet werden. Der Code stellt keinen HTTP-Endpunkt für eine Webseite oder einen Healthcheck bereit.
- **Nur eine laufende Instanz pro gemeinsamem Datenverzeichnis betreiben.** Es gibt keine Dateisperren oder Synchronisation zwischen mehreren Prozessen.
- Für gleichzeitige Entwicklungs- und Produktivtests getrennte Discord-Anwendungen, Tokens und Datenverzeichnisse verwenden. Zwei Prozesse mit demselben Bot können dieselben Interaktionen verarbeiten und ihre globalen Befehlslisten gegenseitig überschreiben.

### Backups und Wiederherstellung

#### Automatische Sicherungen

Der Bot prüft beim Start und anschließend stündlich, ob für den aktuellen **UTC-Kalendertag** bereits eine vollständige, lesbare Sicherung existiert. Falls nicht, erstellt er eine. Voraussetzung ist, dass beide Datendateien existieren; bei einer frischen Installation zuerst `/liga season` einrichten. Danach erfolgt die erste Sicherung spätestens bei der nächsten stündlichen Prüfung oder beim nächsten Start.

Die Kopien liegen unter `backups/` im selben Datenverzeichnis wie die Originaldateien. Auf Railway mit dem Mount-Pfad `/data` sieht das beispielsweise so aus:

```text
/data/
  league-settings.json
  matches.json
  backups/
    backup-2026-10-19T08-00-00-000Z-<zufällige-id>/
      league-settings.json
      matches.json
```

Jede Sicherung enthält nur diese beiden JSON-Dateien, einschließlich Match-IDs und Veröffentlichungsstatus. Bot-Token, `.env`, Quellcode und versendete Discord-Nachrichten werden nicht gesichert. Die Originaldateien werden vor dem Kopieren mit denselben Prüfungen wie beim Bot-Start validiert. Das Lesen und Schreiben erfolgt synchron im laufenden Bot-Prozess, sodass kein Report die Dateien zwischen den beiden Lesezugriffen ändern kann.

Erst nach vollständigem Schreiben wird der temporäre Ordner per Rename als fertiges Backup freigegeben. Danach werden die ältesten Sicherungen entfernt, bis **14 Kopien** übrig sind. Manuell ausgelöste Sicherungen zählen dazu. Unbekannte Ordner, zusätzliche Dateien und symbolische Links werden nicht automatisch gelöscht; beim Aufräumen können deshalb mehr Kopien übrig bleiben. Abgebrochene temporäre Ordner gelten nicht als Sicherungen.

Bei einem Backup-Fehler bleiben vorhandene Sicherungen und die laufenden Bot-Funktionen erhalten. Der Fehler erscheint im Terminal; die nächste stündliche Prüfung versucht es erneut. Bei fehlendem Speicherplatz oder wiederholten Fehlern den Datenordner kontrollieren. Die Sicherung wird nicht automatisch wiederhergestellt.

#### Zusätzliche manuelle Sicherung

Für eine zusätzliche Sicherung, etwa vor einem Update oder einer Datenkorrektur, **den Bot stoppen** und im Projektverzeichnis ausführen:

```sh
npm run backup
```

Der Befehl verwendet dieselbe `.env` und Datenpfad-Auswahl wie `npm start`, erstellt auch bei vorhandenem Tagesbackup eine neue Kopie und gibt deren Pfad aus. Er startet keinen Discord-Client und benötigt keine Discord-Verbindung. Bei ungültigen oder fehlenden Dateien endet er mit Exit-Code 1 und entfernt keine älteren Sicherungen. Ein fehlgeschlagenes Aufräumen wird als Warnung ausgegeben; die neue Kopie bleibt gültig.

Der Befehl muss dort laufen, wo die tatsächlichen Daten liegen. Ein lokales `npm run backup` sichert lokale Dateien und hat keinen Zugriff auf das Railway-Volume. Für eine konsistente Sicherung mit einem separaten Prozess darf währenddessen kein Bot in dieselben Dateien schreiben.

#### Dateien wiederherstellen

1. Den Bot stoppen und die aktuellen Datendateien, soweit noch vorhanden, außerhalb des Backup-Ordners separat aufbewahren.
2. Einen vollständigen Backup-Ordner anhand des Zeitstempels auswählen. **Beide** JSON-Dateien aus genau dieser Sicherung verwenden.
3. Dessen `league-settings.json` und `matches.json` in das aktive Datenverzeichnis kopieren und die dortigen Dateien ersetzen. Auf Railway ist dies standardmäßig `/data`, lokal `data/`; bei `DATA_DIR` dessen tatsächlichen Pfad verwenden.
4. Den Bot starten und `/liga status` sowie `/suchen` prüfen. Ist eine Sicherung ungültig, weist der Bot sie beim Laden zurück.

Eine Wiederherstellung setzt Season-Einstellungen, Archiv und gespeicherten Versandstatus auf den Zeitpunkt der Sicherung zurück. Neuere Reports fehlen danach im Archiv. Bereits veröffentlichte Discord-Posts und versendete DMs bleiben erhalten. Vor dem erneuten Melden jüngerer Matches den Ergebniskanal prüfen: Für Posts nach dem Sicherungszeitpunkt kann der zurückgesetzte Duplikatschutz keinen vorhandenen Post erkennen. Gesicherte Einträge mit dem Status `sending` weiterhin wie unter „Unklaren Versandstatus manuell prüfen“ behandeln.

#### Zusätzlich Railway-Backups aktivieren

Die eingebauten Kopien schützen vor beschädigten oder versehentlich geänderten Datendateien. Da sie im selben Datenverzeichnis liegen, schützen sie **nicht vor dem Verlust oder Löschen des gesamten Volumes**. Dafür zusätzlich eine Sicherung außerhalb des laufenden Volumes vorsehen, z. B. Railway-Volume-Backups und gelegentliche Downloads auf einen anderen Speicher.

Im Railway-Service unter **Backups** einen täglichen und optional zusätzlich einen wöchentlichen bzw. monatlichen Zeitplan aktivieren. Railway bietet dort auch manuelle Sicherungen und die Wiederherstellung über **Restore** an. Die Wiederherstellung wird als Änderung vorbereitet und erst nach Prüfung mit **Deploy** angewendet. Der Bot-Code schaltet diese Hosting-Funktion nicht selbst ein. Die aktuelle Aufbewahrung, Grenzen und Kosten stehen in der [Railway-Dokumentation zu Volume-Backups](https://docs.railway.com/volumes/backups). Railway weist darauf hin, dass ein Wipe des Volumes auch dessen Plattform-Backups löscht; eine separat heruntergeladene Kopie schützt zusätzlich vor diesem Fall.

## Deployment auf Railway

Der Bot läuft als dauerhafter Node.js-Service. Ein öffentliches Domain-Mapping ist für den Discord-Gateway-Betrieb nicht nötig.

1. Dieses Repository forken oder eine eigene Kopie auf GitHub anlegen.
2. In Railway einen Service aus diesem GitHub-Repository erstellen und den gewünschten Deployment-Branch auswählen.
3. Den Builder **Railpack** mit Node.js-Erkennung verwenden. Er liest `engines.node` aus `package.json` und wählt eine Node.js-24-Version. Für eine manuelle Installation `npm ci` und als Start Command **`npm start`** konfigurieren.
4. Unter **Variables** die Werte für `DISCORD_TOKEN`, `CLIENT_ID` und `PARTICIPANT_ROLE_ID` der eigenen Discord-Anwendung hinterlegen.
5. Im Projekt ein **Volume** hinzufügen, mit dem Bot-Service verbinden und den **Mount Path auf `/data`** setzen.
6. Den Service deployen und in den Logs Discord-Verbindung und Befehlsregistrierung prüfen.
7. Auf dem Discord-Server einmal `/liga season` ausführen und danach Report, Suche sowie einen Neustart testen.

Die Variable `RAILPACK_NODE_VERSION` hat Vorrang vor der Versionsangabe im Repository. Falls sie bereits gesetzt ist, entfernen oder ebenfalls auf `24` setzen. Nach dem nächsten Deployment in den Build-Logs prüfen, dass Node.js 24 verwendet wird. Details zur Auswahl stehen in der [Railpack-Dokumentation für Node.js](https://railpack.com/languages/node). Ein bereits laufendes Deployment wechselt seine Node.js-Version erst mit einem neuen Build.

Railway setzt `RAILWAY_VOLUME_MOUNT_PATH` und `RAILWAY_ENVIRONMENT_ID` selbst. Diese Variablen nicht von Hand mit Platzhaltern befüllen. Ohne eigene `DATA_DIR`-Variable verwendet der Bot automatisch das Volume und speichert dort:

```text
/data/league-settings.json
/data/matches.json
```

Falls `DATA_DIR` gesetzt wird, muss das auf Railway ein Pfad **innerhalb des zugeordneten Volumes** sein, z. B. `/data/bot`. Ein aus der lokalen `.env` übernommenes `DATA_DIR=./data` kann außerhalb des Volumes liegen und sollte dort entsprechend angepasst oder weggelassen werden.

Wenn Railway erkannt wird, aber kein Volume konfiguriert ist oder `DATA_DIR` außerhalb liegt, beendet sich der Bot mit einer Fehlermeldung. Das Volume ist erst zur Laufzeit verfügbar: Der Bot wird über den Start Command gestartet, nicht als Build- oder Pre-Deploy-Schritt.

Den Service mit einer Instanz betreiben und die zusätzlichen Railway-Backups wie oben beschrieben aktivieren. Die eingebauten täglichen Kopien landen automatisch unter `/data/backups/` bzw. im gewählten `DATA_DIR`. Lokaler Testbetrieb und Railway besitzen getrennte Dateien; eine lokal eingerichtete Season wird nicht automatisch nach Railway übertragen.

Weitere Informationen: [Railway Volumes](https://docs.railway.com/volumes) und [Volume-Backups](https://docs.railway.com/volumes/backups).

## Entwicklung und Tests

```sh
npm ci
npm test
```

Die Tests verwenden den integrierten Node.js-Test-Runner `node:test`, echte discord.js-Komponenten, simulierte Discord-Interaktionen und temporäre Dateien. Sie brauchen weder Bot-Token noch Discord-Verbindung und versenden keine Nachrichten.

Abgedeckt werden unter anderem Startprüfungen und Abbruch bei Konfigurations-, Speicher- oder Discord-Fehlern, Zeitlimits und tokenfreie Startmeldungen, Teilnehmerauswahl und Rollenänderungen, Spoilerformatierung, Season-Wechsel, Kalender- und Sommerzeitgrenzen, persistente Speicherung, Fehler beim Schreiben, doppelte und gleichzeitige Reports, Korrekturen und bestätigte Löschungen samt Berechtigungen und Neustarts, ältere Archivdateien, tägliche Backups, Aufbewahrung und Wiederherstellung, Zugriffsfilter der Suche und vollständiger bzw. fehlgeschlagener DM-Versand.

| Datei | Aufgabe |
| --- | --- |
| [`index.js`](index.js) | Umgebungsvariablen laden, Client starten, Befehle registrieren und Interaktionen verteilen |
| [`startup.js`](startup.js) | Konfiguration und Datenspeicher prüfen, Discord-Start koordinieren und bei Startfehlern beenden |
| [`reports.js`](reports.js) | Teilnehmerauswahl, Modal, Validierung und Ergebnis-Embed |
| [`report-publisher.js`](report-publisher.js) | Persistenter Duplikatschutz und Versand von Ergebnisposts |
| [`report-management.js`](report-management.js) | Nachrichtenaktionen, Korrekturformular, Löschbestätigung und Zugriffsprüfung |
| [`report-manager.js`](report-manager.js) | Dauerhafte Vormerkung und Wiederholung von Änderungen am bestehenden Ergebnispost |
| [`league-commands.js`](league-commands.js) | `/liga`-Definition und Verarbeitung |
| [`league-settings.js`](league-settings.js) | Season-Konfiguration, Kalenderberechnung und Datenpfad |
| [`match-store.js`](match-store.js) | Replay-Archiv, URL-Validierung und Duplikaterkennung |
| [`data-backups.js`](data-backups.js) | Tägliche Sicherungen, Aufbewahrung und Zeitsteuerung |
| [`backup.js`](backup.js) | Zusätzliche manuelle Sicherung über `npm run backup` |
| [`search-commands.js`](search-commands.js) | `/suchen`, Autocomplete, Zugriffsprüfung und DM-Versand |
| `*.test.js` | Modul- und Integrationstests |

## Fehlerbehebung

| Problem | Prüfen / Lösung |
| --- | --- |
| `npm ci` meldet `EBADENGINE` oder eine nicht unterstützte Node.js-Version | Mit `node --version` die aktive Laufzeit prüfen und Node.js 24 aktivieren; auf Railway zusätzlich eine abweichende `RAILPACK_NODE_VERSION` korrigieren |
| Bot beendet sich direkt mit `Bot-Start abgebrochen` | Genannte Variable oder Datendatei korrigieren; bei automatischen Railway-Neustarts die erste Startfehlermeldung in den Logs prüfen |
| Discord-Start wird nach 60 Sekunden abgebrochen | Netzwerkzugriff zu Discord und Zugangsdaten prüfen; bei erfolgreicher Registrierung, aber fehlender Verbindung zusätzlich Server Members Intent kontrollieren |
| Ein Slash-Befehl fehlt | Registrierungsmeldung im Terminal prüfen; Discord mit Strg+R bzw. im Browser mit F5 neu laden; richtigen Server und richtige Bot-Anwendung prüfen |
| Registrierung schlägt fehl | `CLIENT_ID` muss zum `DISCORD_TOKEN` gehören; Token und Netzwerkzugriff prüfen; der Bot bricht den Start ab und meldet sich erst nach erfolgreicher Registrierung an |
| Nur `/liga` fehlt | Account benötigt Server verwalten; zusätzlich Discord-Integrationsrechte prüfen |
| Normale Mitglieder können keine Befehle verwenden | Anwendungsbefehle im jeweiligen Kanal und die Freigaben unter Servereinstellungen → Integrationen prüfen |
| Bot startet mit einem Intent-Fehler | Server Members Intent im Developer Portal aktivieren |
| Teilnehmerliste wird noch geladen | Initialen Mitgliederabruf abwarten und `/report` erneut ausführen |
| Teilnehmerrolle wird nicht gefunden | Rollen-ID statt Rollenname verwenden; Rolle muss auf diesem Server existieren und darf nicht `@everyone` sein |
| Ein Spieler fehlt im Formular | Teilnehmerrolle, Anzahl von 2 bis 25 menschlichen Teilnehmern und Serverzugehörigkeit prüfen |
| Season ist nicht eingerichtet | `/liga season` auf demselben Server und in derselben Bot-Umgebung ausführen |
| Keine Suchvorschläge oder Treffer | Erst Season eingeben; es müssen archivierte Reports dieser Season existieren; Zugriff auf Ergebniskanal und Nachrichtenverlauf prüfen |
| Suchergebnisse können nicht als DM zugestellt werden | DMs von Servermitgliedern erlauben, Blockierung des Bots prüfen und Suche erneut ausführen |
| Ergebnispost scheitert | Kanalrechte des Bots prüfen, insbesondere Kanal anzeigen, Nachrichten senden und Links einbetten; gespeichertes Replay bleibt im Archiv |
| Railway meldet einen fehlenden oder ungültigen Datenpfad | Volume mit dem richtigen Service verbinden; `DATA_DIR` weglassen oder auf einen Unterordner des Mount-Pfads setzen |
| Vorhandene JSON-Datei kann nicht gelesen werden | Bot stoppen, Fehlermeldung und Datei prüfen bzw. Backup wiederherstellen; die Datei wird absichtlich nicht automatisch überschrieben |
| Datensicherung schlägt fehl | Nach einer frischen Installation zuerst `/liga season` einrichten; ansonsten beide Datendateien, Schreibrechte, freien Speicher und den Backup-Ordner prüfen; vorhandene Sicherungen bleiben erhalten |
| Alte Sicherung konnte nicht entfernt werden | Dateirechte und unerwartete Dateien im genannten Ordner prüfen; die neue Sicherung ist angelegt, der Speicherbedarf kann aber weiter wachsen |
| Report wird als bereits veröffentlicht erkannt | Bestehenden Post über den angebotenen Link öffnen; erneutes Absenden desselben Matches erstellt keinen zweiten Post |
| Report meldet einen unklaren Versandstatus | Kanal und Archiv wie unter „Unklaren Versandstatus manuell prüfen“ kontrollieren; ein Neustart hebt die Sperre absichtlich nicht auf |
| Alter Report wird nicht erneut gepostet | Bestands-Einträge haben keinen Veröffentlichungsstatus und werden vorsichtshalber nicht erneut gesendet |
| Trotzdem doppelte Ergebnisposts | Prüfen, ob eine ältere Bot-Version läuft, Angaben wie Kanal oder Spieltag abweichen oder mehrere Prozesse mit demselben Token bzw. Datenverzeichnis laufen |
| Korrektur oder Löschung meldet einen unterbrochenen Versuch | Kanalrechte und Datenspeicher prüfen; die betreffende Aktion erneut am Ergebnispost öffnen bzw. bei fehlendem Post `/report-entfernen` mit Season, Spieler und optional Spieltag verwenden |
| Nachrichtenaktion kann den Report nicht zuordnen | Es muss ein eigener Ergebnispost mit gespeicherter Nachrichten-ID sein; Bestands-Einträge ohne diese Verknüpfung weiterhin manuell prüfen |
