# INDUS URE

INDUS URE je skupna spletna aplikacija za opravila, ure, obračune, stranke,
kilometrino, material in priloge za Bojana in delavce.

## Trenutna zasnova

- **PostgreSQL** je glavna baza. Stranke, opravila, dodelitve, vnosi ur,
  obračuni in seje so shranjeni v relacijskih tabelah.
- **Priloge** so datoteke na strežniku v `/var/lib/indus-ure/media`; v bazi so
  le metapodatki in varnostni hash.
- **Google** omogoča prijavo, ustvarjanje Dokumentov/Preglednic v Bojanovi mapi,
  Gmail poročila/osnutke in Drive recovery kopije. Sinhronizacije evidence ur
  z Google Sheets in Google Calendar ni več.
- **LAN prijava** je ločena, izrecno omogočena servisna možnost; pogoji in
  omejitve so opisani v [OPERATIONS.md](OPERATIONS.md).
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

Aktualni postopek objave, CAS zaščita, ločitev Ure/Fakture in obnova so v
[OPERATIONS.md](OPERATIONS.md). Prva namestitev je v [DEPLOY-UBUNTU.md](DEPLOY-UBUNTU.md).

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
npm run test:e2e
```

Testi preverijo sintakso, dostopne vloge, lokalno identiteto strank, odstranitev
Sheets/Calendar poti, varne seje, PWA in backup poti.
- Video priloge se pretočno shranijo zasebno na strežnik, skupaj z drugimi prilogami. Drive se za priloge ne uporablja.

Vsaka upravljana objava zahteva tudi izoliran PostgreSQL prehod: sočasni seji,
konflikt zunanje skripte, ciljne zapise, dostop do prilog, dejansko obnovo
recovery paketa in migracijo zasebnega klona produkcije. Produkcijska baza se
pri QA samo prebere. Brez dokazila za točno vsebino izdaje preklop ni dovoljen.
