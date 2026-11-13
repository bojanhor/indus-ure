# INDUS URE

INDUS URE je skupna spletna aplikacija za opravila, ure, obračune, stranke,
kilometrino, material in priloge za Bojana in delavce.

**Za razvijalca ob prevzemu ali težavi:** začni s [priročnikom za diagnostiko](docs/RAZVIJALSKI-PRIROCNIK.md).
V njem so zemljevid kode, varen lokalni preizkus in prvi koraki pri težavah s portalom, obračuni, prilogami ali kopijami.
Za objavo ali obnovo uporabi [operativna navodila](OPERATIONS.md).

## Trenutna zasnova

- **PostgreSQL** je glavna baza. Stranke, opravila, dodelitve, vnosi ur,
  obračuni in seje so shranjeni v relacijskih tabelah.
- **Priloge** so datoteke na strežniku v `/var/lib/indus-ure/media`; v bazi so
  le metapodatki in varnostni hash.
- **Google** omogoča prijavo, dokumente/preglednice, Gmail poročila/osnutke in
  Drive recovery kopije. [Google Koledar za planiranje](GOOGLE-PLANNING-CALENDAR.md)
  enosmerno prikazuje planirane dogodke v namenskih koledarjih. Vpisi opravljenih ur se ne prenašajo;
  urejanje v Googlu ne spreminja evidence v Urah. **ICS** je ločen bralni vir.
- **Prijava znotraj LAN** lahko poleg Googla ponudi osebno geslo INDUS.
  Ločena podporna prijava ni običajna prijava delavca. Pogoji so v [OPERATIONS.md](OPERATIONS.md).
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
npm ci
npm start
```

Odpri `http://127.0.0.1:8123`. Brez `DATABASE_URL` razvojni zagon uporabi
lokalno JSON datoteko; produkcija brez PostgreSQL namenoma ne zažene.

## Preverjanje

```bash
npm test
npm run test:e2e
npm run test:e2e:firefox
```

Pred prvim brskalniškim testom namesti pogona z `npx playwright install chromium firefox`.
Objava zahteva tudi Firefoxov regresijski preizkus odpiranja dnevnega koledarja
(dotik, miška, Nazaj in ohranitev položaja); testni podatki so izolirani od produkcije.

Testi med drugim pokrivajo dostopne vloge, stranke, planiranje, obračune,
priloge, varne seje, PWA in varnostne kopije.

Vsaka upravljana objava zahteva tudi izoliran PostgreSQL prehod: sočasni seji,
konflikt zunanje skripte, ciljne zapise, dostop do prilog, dejansko obnovo
recovery paketa in migracijo zasebnega klona produkcije. Produkcijska baza se
pri QA samo prebere. Brez dokazila za točno vsebino izdaje preklop ni dovoljen.
