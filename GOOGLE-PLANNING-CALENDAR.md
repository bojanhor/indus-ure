# Google Koledar – enosmerno planiranje

## Obseg

Google in ICS uporabljata isti izbor kot spletni mesečni pogled planiranja.
Vključeni so datirani, neizbrisani, nearhivirani in neuvoženi dogodki.
Izključeni so `execution`, `meal`, `drive`, `purchase`, `material` in stari
`entries`: noben vpis opravljenih ur, malica, vožnja, nabava ali material.
Vključeni ostanejo celodnevni in večdnevni dogodki ter opravila »samo koledar«.
Dogodek brez datuma ostane v seznamu opravil, ne dobi izmišljenega termina.

Osebni koledar sledi delavčevemu pogledu (`syncUser || createdBy`), skupni
koledar združi dodelitve po `assignmentGroupId`. Pri premiku/dodelitvi/Undo
se Google posnetek ponovno uskladi. Urejanje iz Googla ne spreminja Ure.
Ko opravilo postane vpis ur, izgine iz koledarja planiranja, ne pa iz Ure.

Prenesejo se naslov, stranka, opis, izvajalci, status, termin, povezava v Ure.
Strukturirane finančne vrednosti, priponke, zgodovina in plačila se ne prenašajo.
Prosto besedilo opisa se prenese tako, kot je zapisano; ne gre za anonimizacijo.
Časovno območje je Europe/Ljubljana; celodnevni datum do je ekskluziven.

## Povezava in uporaba

Nastavitve in orodja → **Google Koledar — planiranje** (tudi Račun in profil).
Šef z e-naslovom `GOOGLE_DRIVE_OWNER_EMAIL` enkrat potrdi **Poveži Google Koledar**.
OAuth uporablja že nastavljeni Google odjemalec in `/api/google/callback`,
vendar ločeno stanje/žetone in nova, izrecno potrjena dovoljenja:

- `calendar.app.created`: samo aplikacijsko ustvarjeni koledarji in dogodki;
- `calendar.acls`: deljenje namenskih koledarjev;
- `calendar.calendarlist.readonly`: varno odkrivanje koledarja po prekinjenem ustvarjanju;
- `openid email`: preverjanje pravilnega lastniškega Google računa.

V istem Google Cloud projektu mora biti omogočen Google Calendar API in
navedeni obsegi na OAuth consent screen; veljajo Googlova pravila objave aplikacije.
Obstoječa Drive/Gmail povezava se ne zamenja in njenih žetonov ne uporabljamo
brez nove privolitve. OAuth odgovor je enkraten, časovno omejen in vezan na
začetnega šefa/sejo. Nadaljevanje je v istem zavihku, tudi v Android PWA.

Lastniški račun ustvari namenski skupni koledar in osebne koledarje delavcev
z Google e-naslovom. Delavci imajo `reader`, šefi še skupni pregled. Lastnik
ima Googlovo lastniško pravico urejanja; spremembe v Googlu se pri uskladitvi
vrnejo na stanje iz Ure. Dostopa do osebnih koledarjev ne uporabljamo.
Koledar ni javno deljen. Začetno povezavo »dodaj / odpri« uporabnik potrdi
v spletnem Google Koledarju, nato je na voljo tudi na telefonu.
Delavec brez e-naslova še vedno normalno deluje v Urah in skupnem koledarju.
Sprememba e-pošte/deaktivacija odstrani stare pravice na namenskem koledarju.

## Zanesljivost in meje

Ločeni moduli: `planning-calendar.js` (skupni izbor),
`google-planning-calendar.js` (projekcija, ponavljanje),
`calendar-sync-store.js` (operativno stanje), `calendar-http.js` (OAuth/API),
`editor/planning-calendar.js` (vmesnik).

Po uspešnem poslovnem zapisu se prenos razporedi z zamikom 1,5 s. V ozadju
je še 30-sekundni pregled, po 5 minutah tudi uskladitev z dejanskim Google
stanjem. To ni jamstvo časa prikaza na telefonu. Omejitve/izpad Googla imajo
trajni zapis napake in odložen ponovni poskus do 15 minut. Ne čakajo v
poslovni `mutationQueue` in ne vplivajo na potrditev shranjevanja opravila.

Trenutno stanje v Urah je trajna čakalna vrsta želenega rezultata; po restartu
se ponovno primerja s potrjenim Google stanjem. Deterministične identitete
dogodkov preprečujejo dvojni vnos po prekinjenem odgovoru. Generacije po
brisanjih omogočajo Undo kljub Google tombstone zapisom. Nejasen izid
ustvarjanja koledarja se najprej poišče, nikoli na slepo podvoji.
Sinhronizacija spreminja samo koledarje z natančno aplikacijsko oznako in
dogodke z aplikacijskimi zasebnimi identifikatorji. Tujih dogodkov ne briše.

Stanje in OAuth žetoni so v ločeni vrstici `indus_meta/planning_calendar_sync_v1`.
Ta ni del poslovnega posnetka, CAS, Undo, browser ZIP ali sanitiziranega recovery
izvoza. PostgreSQL advisory lock preprečuje vzporedni delovni proces.
Ločena povezava za status ne čaka med Google zahtevki. Kopije baz imajo
drugačno vezavo okolja in ne morejo objavljati v produkcijske koledarje.
Izolirani testi ne zaganjajo samodejne sinhronizacije.

## Izklop, povrnitev in obnova

Gumb **Začasno ustavi** ustavi bodoče prenose; že preneseni dogodki ostanejo.
Operativni izklop: `DISABLE_GOOGLE_CALENDAR_SYNC=true` in restart Ure.
Povrnitev na prejšnjo kodo ne spreminja poslovnih podatkov in ustavi novi
proces sinhronizacije. Namenski Google koledarji ostanejo v zadnjem stanju;
povrnitev kode ni samodejni izbris zunanjih podatkov.

Po recovery obnovi je potrebna ponovna OAuth povezava. Nato se že obstoječi
namenski koledarji poiščejo po aplikacijski oznaki in uskladijo. Ne spreminjaj
oznake v opisu koledarja. Pri nejasnem ustvarjanju brez najdenega koledarja
je potreben operativni pregled, da se ne ustvari duplikat.

## Preverjanje

`npm test`: projekcija, izključitev ur/materiala, dodelitve, časovni pas,
spremembe, brisanje in Undo, prekinitve, omejitve, zasebnost, vezava OAuth,
neodvisno operativno shranjevanje. `npm run test:e2e`: šef/delavec/mobilni
vmesnik in obstoječi obrazci. Obvezni PostgreSQL QA dodatno preverja
neodvisnost od poslovnih zapisov in advisory lock dveh povezav.
Za dejanski Google preizkus je potrebna potrjena službena OAuth povezava;
simulirani testi niso dokaz uspešnega prenosa na pravi Google račun.

## Objava 16. 9. 2026

- Objavljena koda: `066009b` (prejšnja produkcija `8b0141e`).
- 254 uspešnih strežniških testov; 43 uspešnih izoliranih brskalniških testov.
  Po dodatni ureditvi vrnitve iz OAuth še 3/3 ciljnih UI testov.
- Na točnem strežniškem kandidatu ponovljeni vsi strežniški testi in 18
  PostgreSQL/restore/upgrade preverjanj, tudi rollback na `8b0141e` in naprej.
- Arhiv kode SHA-256: `21302e344496d8a95f58e409368a95fc0adb78e1b0af28f4ffcbf9683e47f2f3`.
- Predobjavna kopija: `backup-20260916T100542Z-cd0f3771`, 188664162 bajtov.
  SHA-256: `f3ecb7d4fd02781f5ff6fc773316c474b82b084d1b61830699d9d64ff4439881`.
  Lokalni arhiv, Drive velikost/MD5, sveže branje in navodila za obnovo potrjeni.
- Ure in Fakture sta po objavi aktivni; Ure health HTTP 200, brez novih
  opozoril v systemd dnevniku. Fakture niso bile spreminjane.
- Lokalni vizualni pregled nastavitev uspešen. Produkcijski prijavni/Google
  preizkus je ob objavi ustavljen na zahtevi za izrecno potrditev računa in
  dovoljenj. Pravega prenosa v Google še ne označujemo kot preverjenega.

Končna varnostna dopolnitev je objavljena kot `8c5c593`: izklop v okolju
onemogoči tudi ročno/prisilno sprožen delovni proces. Na tej izdaji je
uspešnih vseh 255 strežniških, 43 brskalniških in 18 PostgreSQL preverjanj.
Arhiv kode: `c51c1cf31c8e2a1f4f160fab4724c183db132abef4ce029f32891cea79d267b7`.
Pred preklopom je preverjena še kopija `backup-20260916T101146Z-807f57cc`
(188703978 bajtov, SHA-256
`900febdbcc4536117c5cc23ac220c3bb14014e8d18a8ac3096fcc96e191fd908`).
Obe aplikaciji sta aktivni, Ure health je uspešen, novih opozoril ni.
Na voljo sta prejšnji izdaji `066009b` in predintegracijska `8b0141e`.
Google aktivacija ob zaključku še čaka na uporabnikovo potrditev računa in
dovoljenj; resnični dogodki še niso bili poslani Googlu.
