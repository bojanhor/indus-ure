# TODO: izbori, povezave in prikaz poročil

Obseg: sedem točk iz skupnega TODO, preverjenega 23. 9. 2026. Uporabnik je
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
- Dopolnitvi med delom: spodnji seštevek PDF loči obračunske ure po vidnih
  oznakah izvajalcev (skrije jih, če so skrite ure ali obe imeni). Naziv in
  vzdevek se lahko uredita neposredno ob posameznem vpisu ur; prazno polje
  povrne privzeto vrednost. To sta lastnosti dogodka `reportWorkerTitle` in
  `reportWorkerName`, ne sprememba identitete ali nastavitev delavca.
  Veljajo potrjeni zaklepi, CAS, zgodovina in Undo; deljenje samega dogodka
  ostaja nespremenjeno. Več izvajalcev je pri novem/urejenem vpisu ur zavrnjenih
  tudi na API. Bralni pregled produkcije: 246 execution dogodkov, noben z več
  izvajalci. Za morebitno staro skupno plansko postavko se uporabi skupna
  oznaka in skupni znesek ur enkrat, brez izmišljene razdelitve. Enake vidne
  oznake izvajalcev v seštevku se združijo.

## Preverjanje in objava

Testi pokrijejo vseh 16 kombinacij PDF z branjem dejansko generiranega PDF-ja,
material/pravice/konflikte/Undo, povezave in HTML ubežanje, izbor izvajalcev,
ohranitev nastavitev po osvežitvi in po kontekstu ter pošiljanje možnosti na
PDF/Gmail API. Vsi poslovni zapisni testi tečejo izključno na izoliranih
testnih podatkih. PDF-ja z vključenimi/izključenimi možnostmi sta vizualno
pregledana po renderiranju s Popplerjem.

Objavljeno 23. 9. 2026: `f3b166c` (GitHub main in produkcija).

- Windows npm: 289 uspešnih, 1 pričakovano preskočen symlink test, 0 napak.
- Linux npm na kandidatu: 290/290.
- Chromium: 68/68; ciljni WebKit: 8/8. Ročno vizualno preverjeni izbirnik,
  PDF nastavitve, mobilni polji naziv/vzdevek ter izris PDF s seštevki.
- PostgreSQL: 18 kontrol, dump restore, dejanski sanitizirani recovery,
  nadgradnja produkcijske kopije ter rollback/ponovni prehod so uspešni.
  Dokazi: `/var/lib/indus-ure/qa/f3b166c.*`.
- Pre-deploy backup `indus-ure-recovery-20260923T111635Z.tar.gz`:
  191.667.076 bajtov, uspešno lokalno in Drive preverjanje, zaščitena oznaka
  pred objavo. Objava je izvedena prek `deploy-indus-ure`.
- Po objavi javni HTTP 200, health OK, obe aplikaciji active, brez novih
  opozoril storitve Ure. Javno dostavljena lupina vsebuje vse nove funkcije.
  Produkcijski testni brskalnik ni imel prijavljene seje in LAN obrazec ni
  bil ponujen; poslovni UI testi so zato opravljeni v izolirani aplikaciji.
- Google TODO je po ponovnem preverjanju revizije očiščen vseh sedmih
  dokončanih točk, branje po zapisu potrjuje prazen dokument.

Med preverjanjem povrnitve smo odstranili dodajanje praznih novih polj v
stare revizijske posnetke: obstoječa zgodovina se zato ne prepisuje zgolj
zaradi objave. Prikazni preglasitvi se v revizijo vključita šele, ko obstajata.

Povrnitev ne zahteva migracije podatkov: z obstoječim postopkom se lahko
vrne prejšnja izdaja 54d07c2. Nastavitve prikaza so lokalne, vsebina materiala
uporablja že obstoječe polje in Undo. Fakture in nginx niso del tega posega.
