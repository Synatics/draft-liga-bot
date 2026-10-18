# Pokémon-Liga-Ergebnisse

Mit `/report` öffnet sich ein Formular mit Dropdowns für Spieltag, Gewinner und Verlierer.
Die Auswahl enthält alle menschlichen Mitglieder mit der konfigurierten
Teilnehmerrolle, alphabetisch nach ihrem Server-Spitznamen sortiert. Diese Namen
erscheinen auch im Match-Titel. Ohne Server-Spitznamen wird der Discord-Anzeigename
verwendet. Gewinner, Verlierer und Ergebnis bleiben im veröffentlichten Post hinter
Spoilern verborgen; die Reihenfolge der Namen im Titel verrät den Gewinner nicht.
Season und Spieltag stehen als kleine Kopfzeile direkt im Embed über dem Match-Titel,
beispielsweise **Season 3 · Spieltag 7** über **🏆 Liga Match: Max vs. Jan**.
Es gibt keine zusätzliche Textzeile außerhalb des Kastens. Zum Finden von Replays
gibt es den eigenen Befehl `/suchen`, unabhängig von Discords Nachrichtensuche.

## Einmalige Einrichtung

1. Eine Rolle wie **Liga-Teilnehmer** anlegen oder eine bestehende Rolle verwenden.
   Diese Rolle den Spielern geben, die in der Auswahl erscheinen sollen.
2. Die Server-Spitznamen der Spieler auf die gewünschten Liga-Namen setzen,
   beispielsweise **Max** und **Jan**.
3. Im [Discord Developer Portal](https://discord.com/developers/applications)
   die Bot-Anwendung öffnen und unter **Bot → Privileged Gateway Intents**
   den **Server Members Intent** aktivieren. Der Bot benötigt keine Administratorrechte
   und muss die Teilnehmerrolle nicht selbst besitzen oder verwalten können.
4. Eine `.env` anhand von `.env.example` anlegen oder die bestehende `.env` ergänzen:

   ```dotenv
   DISCORD_TOKEN=dein-bot-token
   CLIENT_ID=deine-application-id
   PARTICIPANT_ROLE_ID=deine-teilnehmerrollen-id
   ```

   Zum Kopieren der Rollen-ID in Discord unter **Benutzereinstellungen → Erweitert**
   den Entwicklermodus aktivieren. Danach auf die Teilnehmerrolle rechtsklicken
   und **Rollen-ID kopieren** auswählen.
5. Mit `npm ci` die Abhängigkeiten installieren und mit `npm start` den Bot starten.

Für eine neue Season dieselbe Rolle weiterverwenden: Rolle hinzufügen oder entfernen
genügt, der Bot übernimmt die Änderung automatisch beim nächsten Öffnen des Formulars.
Auch geänderte Server-Spitznamen werden automatisch übernommen. Es gibt keine eigene
Namensliste im Code. Beim Start lädt der Bot die Mitgliederliste einmal; bis dieser
Vorgang abgeschlossen ist, bittet `/report` kurz um einen erneuten Versuch.

Ein Formular unterstützt zwischen 2 und 25 Teilnehmern. Bei identischen Anzeigenamen
zeigt das Dropdown zusätzlich den Accountnamen an. Intern wird immer die Discord-ID
verwendet. Beim Absenden prüft der Bot erneut, ob beide ausgewählten Personen noch
die Teilnehmerrolle haben. Dieselbe Person kann nicht gegen sich selbst antreten.

## Season und Spieltag direkt in Discord einstellen

Die Ligaleitung braucht für `/liga` die Discord-Berechtigung **Server verwalten**.
Die Befehle werden zusätzlich beim Ausführen auf diese Berechtigung geprüft.
Rückmeldungen zur Konfiguration sind nur für die ausführende Person sichtbar.

| Befehl | Wirkung |
| --- | --- |
| `/liga season nummer:3 spieltage:9 startdatum:19.10.2026` | Season 3 mit 9 wöchentlichen Spieltagen ab diesem Montag einrichten |
| `/liga status` | Aktuelle Einstellungen anzeigen |

Beim Einrichten der Season einmal die Nummer, die Anzahl der Spieltage und das
Startdatum von Spieltag 1 angeben. Das Startdatum muss ein **Montag** sein und kann
als `TT.MM.JJJJ` oder `JJJJ-MM-TT` eingegeben werden. Der Start kann auch in der
Vergangenheit liegen, wenn die Season bereits läuft.

Ein Spieltag dauert jeweils von **Montag 00:00 Uhr bis Sonntagabend**. Beim nächsten
Montag um 00:00 Uhr deutscher Zeit (`Europe/Berlin`) ist automatisch der nächste
Spieltag vorausgewählt. Sommer- und Winterzeit werden berücksichtigt. Der Bot
berechnet den Spieltag beim Öffnen des Formulars und bei `/liga status` aus dem
Startdatum. Daher stimmt er auch nach einem Neustart oder mehreren Wochen offline.
Es sind keine wöchentlichen Befehle nötig.

Vor dem Start wird Spieltag 1 vorausgewählt; nach dem letzten Spieltag bleibt die
Vorauswahl beim letzten Spieltag. Eine neue Season beginnt erst, wenn die Ligaleitung
sie mit `/liga season` einrichtet. Auch ein falsches Startdatum kann durch erneutes
Ausführen dieses Befehls korrigiert werden. Die Season kann eine Nummer von 1 bis
9999 haben, die Anzahl der Spieltage liegt zwischen 1 und 25.

Die Spieler verwenden weiterhin nur `/report`. Die aktive Season steht im
Formulartitel; der aktuelle Spieltag ist schon ausgewählt. Für Nachholspiele können
die Spieler einen anderen Spieltag auswählen. Ergebnis und Replay-Link werden wie
bisher eingetragen. Wenn während eines offenen Formulars die Season wechselt, bittet
der Bot beim Absenden um ein neues Formular, damit das Match nicht der falschen Season
zugeordnet wird. Bereits gepostete Ergebnisse werden durch Konfigurationsänderungen
nicht verändert.

Nach dem Update den Bot neu starten, damit auch `/liga` bei Discord registriert wird.
Vor der ersten Verwendung von `/report` einmal `/liga season` mit Startdatum ausführen.
Alle späteren Änderungen wirken sofort ohne Neustart und ohne Codeänderung.

Bereits gespeicherte Einstellungen ohne Startdatum bleiben lesbar. Um die Wochenautomatik
dafür zu aktivieren, `/liga season` einmal mit der bisherigen Season, der Anzahl der
Spieltage und dem tatsächlichen Startmontag ausführen. Der bisherige Befehl
`/liga spieltag` wird durch die automatische Berechnung ersetzt.

### Wenn `/liga` nicht in Discord erscheint

Beim Start zeigt das Terminal getrennt an, ob der Bot verbunden ist und ob die
Slash-Befehle registriert wurden. Die Erfolgsmeldung für die Befehle lautet:

```text
✅ Slash-Befehle bei Discord registriert: /report, /liga, /suchen
```

Nur eine Discord-Verbindung genügt noch nicht, wenn die Registrierung fehlschlägt.
In diesem Fall erscheint eine eigene Fehlermeldung im Terminal. `CLIENT_ID` muss zur
Bot-Anwendung des verwendeten `DISCORD_TOKEN` gehören.

Den Befehl in einem Serverkanal mit einem Account verwenden, der **Server verwalten**
oder **Administrator** hat. Ohne die nötigen Rechte blendet Discord `/liga` aus.
Erscheint der Befehl trotz erfolgreicher Registrierung nicht, Discord mit **Strg+R**
neu laden (im Browser mit **F5**). Dann nur `/liga` von Hand eintippen und den
gewünschten Befehl in der Auswahl anklicken. Anschließend die angebotenen Felder
ausfüllen. Eine eingefügte Beispielzeile allein ist noch kein ausgeführter Slash-Befehl.

## Replays suchen

| Befehl | Wirkung |
| --- | --- |
| `/suchen season:4 name:Jan` | Alle gespeicherten Replays von Jan aus Season 4 |
| `/suchen season:4 name:Jan spieltag:3` | Nur Jans Replays vom dritten Spieltag der Season 4 |

Zuerst die Season eingeben, dann beim Feld **name** einen der automatisch angebotenen
Spieler auswählen. Die Vorschläge kommen aus den gespeicherten Matches dieser Season;
eine zusätzliche Namensliste oder eine aktuelle Teilnehmerrolle sind nicht nötig.
Intern erfolgt die Zuordnung über die Discord-ID. Bei Namensänderungen bleiben frühere
Namen als Suchbegriffe erhalten. Bei gleichen Namen unterscheidet die Auswahl die
Teilnehmer anhand ihrer IDs; eine frei eingetippte mehrdeutige Eingabe wird nicht geraten.

Die Treffer kommen als **normale Direktnachricht vom Bot** und bleiben im DM-Verlauf
erhalten. Das Layout enthält pro Treffer den Spieltag, beide Teilnehmer und den
Replay-Link. Gewinner und Ergebnis werden nicht angezeigt. Bei vielen Treffern
verteilt der Bot die vollständige Liste auf mehrere DMs. Linkvorschauen und
Erwähnungen sind deaktiviert. Im Serverkanal erscheint nur eine private Bestätigung
(ephemer), wie viele Replays verschickt wurden. Es werden nur Matches desselben
Servers aus Kanälen angezeigt, in denen die suchende Person Nachrichten und Verlauf
lesen darf.

Damit die Zustellung klappt, Direktnachrichten von Servermitgliedern für den
Liga-Server erlauben und den Bot nicht blockieren. Wenn Discord die DM ablehnt,
erklärt der Bot das privat im Kanal. Scheitert der Versand nach einigen Nachrichten,
zeigt die Rückmeldung an, wie viele Nachrichten zugestellt wurden. Ohne Treffer
bleibt es bei einer privaten Rückmeldung im Kanal; es wird keine DM verschickt.
Eine DM enthält den Stand zum Suchzeitpunkt. Neue Reports ergänzen bestehende DMs
nicht automatisch; eine erneute Suche verschickt eine neue Liste.

Jeder neue `/report` wird automatisch im Archiv erfasst. Vorhandene Discord-Nachrichten
werden nicht nachträglich eingelesen. Die Suche funktioniert auch für abgeschlossene
Seasons und für Personen, die inzwischen keine Teilnehmerrolle mehr haben.
Die Teilnehmerrolle ist weiterhin nur für die Auswahl im Ergebnisformular erforderlich.

Nach dem Neustart zunächst einen neuen Report mit einem gültigen `https://`- oder
`http://`-Replay-Link absenden. Danach `/suchen` für dessen Season und Spieler testen.
Ein weiterer Neustart darf die Treffer nicht entfernen.

## Einstellungen und Replays dauerhaft speichern

Lokal speichert der Bot die Konfiguration in `data/league-settings.json` und das
Replay-Archiv in `data/matches.json`. Der Ordner ist von Git ausgeschlossen. Optional
kann `DATA_DIR` einen anderen Datenordner angeben. Einstellungen und Matches sind pro
Discord-Server getrennt und werden nach einem Neustart wieder geladen. Für das Archiv
werden nur Server, Kanal, Season, Spieltag, beide Teilnehmer mit ID und Name sowie
der Replay-Link gespeichert; Gewinner und Score bleiben im Discord-Ergebnispost.

Auf **Railway** dem Bot-Service einmalig ein
[Volume](https://docs.railway.com/volumes) zuordnen:

1. Das Railway-Projekt und die Umgebung des Bots öffnen.
2. Im freien Bereich der Projektansicht rechtsklicken und ein **Volume** hinzufügen.
3. Als verbundenen Service den bestehenden **Bot-Service** auswählen.
4. Den **Mount Path auf `/data`** setzen und die Änderung anwenden.
5. Beim geplanten Start der neuen Season den aktualisierten Bot deployen und die
   Season mit `/liga season` einstellen.

Railway setzt `RAILWAY_VOLUME_MOUNT_PATH` automatisch; der Bot nutzt diesen Pfad für
`league-settings.json` und `matches.json`. Eine zusätzliche Variable ist dafür nicht nötig. Falls
`DATA_DIR` verwendet wird, muss der Pfad innerhalb dieses Volumes liegen. Ohne Volume
startet der Bot auf Railway mit einer entsprechenden Fehlermeldung nicht, damit die
gespeicherten Einstellungen und Replays bei einem Deployment nicht verloren gehen.

Beim ersten Start wird ein leeres Archiv im Datenordner angelegt und dessen
Schreibbarkeit geprüft. Reports werden vor dem öffentlichen Post gespeichert.
Bei einem Speicherfehler erscheint eine private Fehlermeldung und es wird kein
Ergebnis gepostet. Falls nur das Posten bei Discord fehlschlägt, bleibt das Replay
für `/suchen` erhalten und der Bot erklärt den Fehler. Ein erneutes Melden desselben
Replays mit derselben Season, Spieltag, Kanal und Teilnehmern erzeugt keinen doppelten
Suchtreffer. Neue Seasons löschen keine früheren Replays.

Railway-Volume und Dateien bleiben bei Neustarts und Deployments erhalten. Für eine
zusätzliche Sicherung kann beim Volume ein Backup eingerichtet werden. Der Bot ist
für eine laufende Instanz ausgelegt, die auf diese Dateien zugreift.

Lokale Tests und Railway verwenden getrennte Datenordner. Die erste Einrichtung der
Season erfolgt daher einmal pro Umgebung. Für spätere Seasons reichen die Discord-Befehle.

## Lokale Prüfung

```sh
npm test
```

Die Tests verwenden die echten Discord-Komponenten, nachgebildete Serverdaten und
temporäre Dateien für die Prüfung der Speicherung. Sie benötigen keinen Bot-Token
und veröffentlichen keine Discord-Nachrichten.
