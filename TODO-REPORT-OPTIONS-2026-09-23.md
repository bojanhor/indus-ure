# TODO: izbori, povezave in prikaz poročil

Obseg: pet točk iz skupnega TODO, preverjenega 23. 9. 2026. Uporabnik je
odstranil prejšnjo oznako »TOLE ŠE PUSTI PRI MIRU« in dopolnil material.

## Spremembe

- Paketna prestavitev označenih vpisov uporablja oblikovan iskalnik strank:
  naziv/vzdevek, tipkovnica, dotik, urejanje obstoječe stranke, stabilen ID in
  možnost adhoc naziva. Uporablja obstoječo omejitev predlogov iz app-config.
  Izbira se zgodi ob končanem kliku, ne pointerdown; potrditveni korak ostaja.
  Urejevalnik opravila fokusira lupino takoj ob odprtju, ne šele ob naslednjem
  izrisu, zato hitremu vnosu ne odvzame fokusa in ne zapre predlogov.
- Mesečni in dnevni koledar imata usklajen izbor več izvajalcev s kljukicami.
  `null` pomeni vse (tudi prihodnje izvajalce), `[]` nikogar; skupni dogodek se
  prikaže enkrat, če ustreza katerikoli izbrani izvajalec. Izbor je shranjen
  po prijavljenem uporabniku, star enojni izbor se pretvori. Delavčev pogled
  in dovoljenja se ne spreminjajo. Ne-shranjene spremembe časovnice še vedno
  blokirajo menjavo filtra.
- Novi zasebni modul contact-links prepozna HTTP(S)/www povezave, e-pošto,
  slovenske telefonske številke in mednarodne številke z `+`. Uporablja
  native `tel:`, `mailto:` in varne spletne povezave. Datumi, zneski in
  osemmestne davčne številke niso povezave. HTML se ubeži.
  V besedilnih prikazih so podatki klikljivi, ob vnosnih poljih so ločene
  bližnjice, da kliki v besedilo ostanejo namenjeni urejanju. Native kopiranje
  s pridržanjem/desnim klikom ni prestreženo. Povezave niso del oznake polja.
- Gumb Nastavitve PDF odpre štiri kljukice: naziv, vzdevek, ure in datumi
  vpisov. Privzeto so vključene. Izbor je v lokalnem kontekstu uporabnika;
  pri obeh izključenih imenih ni vrstice Izvajalec. Izključene ure odstranijo
  tudi seštevek ur, ne prevoza; ure ostajajo obračunske ure stranke.
  Nastavitve veljajo za neposredni PDF, download ticket in Gmail osnutek.
  PDF deljenje posameznega dogodka ostaja nespremenjeno.
- Material v obračunu stranke je urejevalna, samorazširljiva večvrstična
  vsebina enako kot opis; tudi prazen material se lahko dopolni. Obstoječa
  šefovska API pot ohrani potrjene zaklepe, urejevalne zaklepe, baseUpdatedAt,
  zgodovino in Undo. Delavčevi časi se ne spreminjajo.

## Preverjanje in objava

Testi pokrijejo vseh 16 kombinacij PDF z branjem dejansko generiranega PDF-ja,
material/pravice/konflikte/Undo, povezave in HTML ubežanje, izbor izvajalcev,
ohranitev nastavitev po osvežitvi in po kontekstu ter pošiljanje možnosti na
PDF/Gmail API. Vsi poslovni zapisni testi tečejo izključno na izoliranih
testnih podatkih. PDF-ja z vključenimi/izključenimi možnostmi sta vizualno
pregledana po renderiranju s Popplerjem.

Pred objavo: celotni npm in Chromium E2E, ciljni WebKit, nato obvezni Linux
in PostgreSQL/restore/upgrade/rollback testi točno pripravljene izdaje ter
preverjen recovery backup. Končne rezultate in izdajo dopolnimo po objavi.

Povrnitev ne zahteva migracije podatkov: z obstoječim postopkom se lahko
vrne prejšnja izdaja 54d07c2. Nastavitve prikaza so lokalne, vsebina materiala
uporablja že obstoječe polje in Undo. Fakture in nginx niso del tega posega.
