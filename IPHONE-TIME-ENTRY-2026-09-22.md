# iPhone: izris in drsenje obrazca za vpis ur

Uporabnik poroča o neizrisanih poljih in utripanju med pomikom na iPhonu.
Točne različice iOS in načina odpiranja (Safari/PWA) nimamo. Fizičnega iPhona
v tem okolju ni; poročanega GPU utripanja zato ni mogoče zanesljivo reproducirati.

## Ugotovitev in omejen popravek

- Urejevalnik je prej pomikal sam native `dialog`, znotraj njega pa je bila
  sticky glava. Dolgi vpis ur dodatno razpre kilometrino, datum in izbirnik časa.
  Odstranjena je ta kombinacija slojev: glava je zunaj pomika, vsebina pa v
  navadnem `#todoDialogScroll`. Brez prisilnih transformacij/GPU hackov ali
  ponavljajočih časovnikov za repaint.
- Na širini 390 px je bilo neposredno izmerjeno horizontalno prelivanje:
  `dialog.clientWidth=337`, `scrollWidth=340`; grid otroci so bili široki 320 px
  namesto razpoložljivih 297 px. Grid in polja imajo zdaj dovoljeno krčenje;
  mobilni gumbi za datum so v svoji vrstici, da ostane celoten datum berljiv.
- Nova odprtja ponastavijo notranji pomik po `showModal()`, torej po tem,
  ko brskalnik odpre in lahko samodejno fokusira prejšnjo kontrolo.
- Skupni urejevalnik uporablja isto varno strukturo tudi za planiranje in
  material. Drugi dialogi, poslovna pravila, API, obračuni in baza niso spremenjeni.

## Preverjanje

`tests/e2e/time-entry-rendering.spec.cjs` testira oba delavska pogleda na
390 × 844, 844 × 390 in 320 × 568, dolg opis, dejanske klike na številčnici,
vnos/obnovo osnutka, validacijo stranke, zapis na izoliran testni strežnik,
novo odprtje in potrditev ničelne kilometrine. Preveri hit-testing polj,
odsotnost horizontalnega prelivanja in primerjavo screenshotov pred/po
celotnem pomiku. Testi ne nadomeščajo iOS tipkovnice, PWA ali GPU compositorja.

Ponovljiv ukaz za WebKit (zahteva `playwright install webkit`):

```sh
npx playwright test tests/e2e/time-entry-rendering.spec.cjs --browser=webkit
```

Pred objavo sta zahtevana tudi običajni `npm test` in `npm run test:e2e`,
strežniški PostgreSQL/restore/upgrade prehod ter obstoječa preverjena kopija.

## Povrnitev

Prejšnja produkcijska koda je `514fd4e`. Ker ni spremembe podatkovne sheme,
je povrnitev samo preklop kode z običajnim preverjenim deployment orodjem:
`sudo /usr/local/sbin/deploy-indus-ure 514fd4e`. Poslovne baze se ne obnavlja.
Fakture, Nginx in Google Calendar povezava niso predmet tega posega.

## Rezultat objave

Objavljeno `43c1994` dne 22. 9. 2026. Končna preverjanja: 266/266 testov,
53/53 Chromium E2E, 13/13 izbranih WebKit E2E ter 19/19 strežniških
PostgreSQL/restore/upgrade preverjanj (vključno s povrnitvijo na `514fd4e`).
Obstoječi backup se je uspešno zaključil ob 12:34:52 UTC, pred preklopom kode.
Po objavi: javni HTTP 200 vsebuje nov scroller, reset pomika in mobilni CSS;
health `ok`, Ure in Fakture aktivni, brez novih opozoril storitve Ure.
Vizualno preverjen lokalni obrazec; prijavljen produkcijski UI in fizični iPhone
nista bila preizkušena. Končna potrditev prenehanja utripanja na napravi ostaja
pri uporabniku. GitHub push ni izveden.
