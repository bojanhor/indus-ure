# Obvezna stranka pri vpisu ur – 15. 9. 2026

Zahteva: preprečiti shranjevanje vpisov ur brez stranke in uporabniku
izpisati obstoječe primere. Brez samodejnih popravkov zgodovinskih podatkov.

## Sprememba

- `execution`, `drive` in `purchase` zahtevajo stranko. Malica ostane brez nje.
- Obrazec opozori in fokusira polje pred potrditvami, zapiranjem in samodejno
  dodelitvijo prvega prostega časovnega termina. Osnutek ostane odprt.
- API varovalo velja za ustvarjanje, urejanje, pretvorbo opravila v vpis ur
  ter premik časa/datuma. ID mora po razrešitvi pripadati obstoječi stranki.
- Vpis vzdevka in obstoječe ustvarjanje ad-hoc stranke ostajata dovoljena.
- Navadna načrtovana opravila lahko ostanejo brez stranke. Branje, Undo in
  zgodovinska normalizacija niso spremenjeni; ni migracije podatkov.
- Mobilni PDF prenos in druge odprte TODO točke niso del tega posega.

## Pregled produkcije pred objavo

Bralni SQL pregled je našel 6 zaključenih vpisov brez stranke, vsi Ibro,
skupaj 13 ur. Vseh 6 je arhiviranih. Med njimi so štiri julijske Korekcije,
vpis za posodobitev aplikacije 24. 7. in Studi frekvencer 19. 8.
Ni dodatnih takih starih `indus_entries` in ni osirotelih referenc na stranke.
Malice so iz tega seznama izključene.

## Preverjanje

- `npm test`: 206/206 uspešno.
- `npm run test:e2e`: 40/40 uspešno.
- Novi API testi preverjajo šefa in delavca, prazno/belo besedilo, lažen ID,
  ad-hoc stranko, zavrnjeno brisanje stranke brez spremembe podatkov,
  pretvorbo opravila in izjemo za malico.
- Štirje novi UI preizkusi pokrijejo Ibra in Bojana, širini 390/1280 px,
  izpolnjen in prazen čas; opozorilo, fokus, odprt modal in nič POST zapisov.
  Posnetka ozkega in širokega pogleda sta vizualno pregledana.
- Obstoječi testi časovnih pravil so dobili stranko v testnih podatkih;
  njihove časovne trditve niso bile oslabljene.
- PostgreSQL QA vsebuje dodatni primer zavrnitve za obe vlogi z dokazom,
  da se opravila in stranke ob zavrnitvi ne spremenijo. Izvedba in varnostna
  kopija sta obvezni pred preklopom produkcije.

## Objava

- Objavljena izdaja: `07f7690` (15. 9. 2026).
- PostgreSQL QA: 12 preverjanj + 3 preverjanja obnove/nadgradnje uspešna;
  na kandidatu ponovno uspešnih vseh 206 strežniških testov.
- Pred preklopom uspešna zasebna recovery kopija
  `backup-20260915T120233Z-0f19adc1`, 188.239.783 bajtov;
  localArchive, driveSize, driveMd5, freshDriveRead in restoreInstructions
  potrjeni. SHA-256:
  `779cbdf3ed33511dcd086915de89bc241bebc7f6f1f1a1198dffc84c2b8ad3d3`.
- Produkcija: health OK, Ure in Fakture aktivni, brez opozoril ob zagonu.
- Ročni brskalniški preizkus na objavljeni različici: »Shrani in zapri«
  pri vpisu brez stranke pokaže opozorilo in pusti obrazec odprt. Osnutek je
  nato zavržen z X; bralni SQL je potrdil 0 ustvarjenih testnih dogodkov.
- Ponovni pregled je potrdil istih 6 arhiviranih vpisov brez stranke;
  ni dodatnih vpisov z nazivom stranke, a brez njene reference.
- Objava je preklopila samo Ure; ni sprememb konfiguracije Faktur ali Nginxa
  in ni obnove ali popravljanja zgodovinskih poslovnih podatkov.
