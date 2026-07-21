# INDUS URE

INDUS URE je skupna spletna aplikacija za opravila, ure, obračune, stranke,
kilometrino, material in priloge za Bojana in delavce.

## Trenutna zasnova

- **PostgreSQL** je glavna baza. Stranke, opravila, dodelitve, vnosi ur,
  obračuni in seje so shranjeni v relacijskih tabelah.
- **Priloge** so datoteke na strežniku v `/var/lib/indus-ure/media`; v bazi so
  le metapodatki in varnostni hash.
- **Google** se uporablja samo za prijavo in za Google Dokumente/Preglednice v
  Bojanovi mapi. Google Sheets in Google Calendar sinhronizacije ni več.
- **ICS** ostane bralna povezava za telefone; aplikacija nikoli ne ureja
  dogodkov v uporabnikovem Google koledarju.
- Prijava uporablja **HttpOnly/Secure cookie**, zaščito CSRF in strogi CSP.
- Aplikacija je namestljiva kot **PWA**. Brez povezave pokaže zadnji varen
  prikaz do izteka seje (največ sedem dni) in v vrsti obdrži spremembe
  opravil, ur in novih prilog. Že obstoječih prilog ne kopiči v telefon.

## Varnostne kopije

V meniju šef vidi dva ločena mehanizma:

- **Prenesi varnostno kopijo (ZIP)**: ročna, prenosljiva kopija podatkov in
  prilog. Ne vsebuje OAuth žetonov, gesel ali strežniških skrivnosti.
- **Nočni recovery backup**: PostgreSQL, priloge, koda aplikacije in hitra navodila v preverjenem paketu na Google Drive. Paket nima OAuth žetona, sej, hashov gesel ali strežniških skrivnosti.

Podrobna namestitev, migracija in obnova so v
[DEPLOY-UBUNTU.md](DEPLOY-UBUNTU.md).

## Lokalni zagon

```bash
npm install
npm start
```

Odpri `http://127.0.0.1:8123`. Brez `DATABASE_URL` razvojni zagon uporabi
lokalno JSON datoteko; produkcija brez PostgreSQL namenoma ne zažene.

## Preverjanje

```bash
npm test
```

Testi preverijo sintakso, dostopne vloge, lokalno identiteto strank, odstranitev
Sheets/Calendar poti, varne seje, PWA in backup poti.
- Video priloge se pretočno shranijo v Google Drive in so v poročilu le kot povezave.

Ob vsaki objavi se dodatno izvede produkcijski video smoke test: prek pravega
API-ja naloži majhen testni video, preveri mapo, lastništvo in deljenje z
povezavo, nato pa testno datoteko in začasno sejo odstrani. Za izreden
diagnostični preklop je na voljo SkipVideoSmoke.
