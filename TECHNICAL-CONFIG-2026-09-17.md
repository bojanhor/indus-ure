# Tehnične nastavitve in PDF priloge – 17. 9. 2026

## Uporaba

Šef: Nastavitve in orodja → Nastavitve obračuna in arhiva → Odpri tehnične nastavitve.
Obrazec s slovenskimi oznakami ureja isto datoteko kot strežnik:
`/var/lib/indus-ure/app-config.json`. Testno okolje uporablja DATA_DIR/app-config.json.

- PDF: privzeto 50 MiB (52.428.800 bajtov); UI zaradi dosedanje terminologije prikazuje MB.
- Datoteka vsebuje samo podprte operativne vrednosti: priloge, zgodovino, izvoze,
  časovne omejitve, urejevalnik, zaklepe, koledar in nadzor zdravja.
- Poslovne tarife, uporabniki, pravice, gesla, OAuth, baze, poti in URL-ji niso nastavljivi tu.
- Veljaven zapis se uveljavi v strežniku brez ponovnega zagona. Gumb tudi osveži
  brskalnik šefa; drugi odprti brskalniki prevzamejo UI vrednosti ob osvežitvi.
- Prejšnja različica napolni samo obrazec; sprememba potrebuje ponovno potrditev.
  Zmanjšanje hrambe izrecno opozori na morebitni trajni izbris pri rednem čiščenju.
- Zapis je atomaren, pravice datoteke 0600, strežniško preverjanje neznanih ključev,
  mej in povezanih omejitev. Revizija SHA-256 varuje pred izgubljeno sočasno spremembo.
  Tehnična konfiguracija ni poslovno dejanje Undo.
- Ročno urejanje: v nadzorovanem terminu z ustavljenim spletnim urejanjem. Validiraj z
  `validateConfig()` iz outputs/app-config.js in nato ponovno zaženi storitev.
  Neveljavna datoteka zavrne zagon; ne preklopi tiho na druge nastavitve.
- Privzete vrednosti so v outputs/app-config.defaults.json. Ob prvem zagonu
  se prej podprte okoljske omejitve slik/videov/nadzora prenesejo v config; nato velja file.
- Config je zunaj imenika izdaj in vključen v naslednje recovery varnostne kopije.
  Obnova: pregled, validacija, kopija v navedeno trajno pot, lastnik indus-ure, 0600.

## PDF pot in združljivost

POST /api/todos/pdf je prijavljen, CSRF-varovan binarni tok. Datoteka se preveri
po podpisu %PDF- in dejanski velikosti tudi brez Content-Length. Nedokončani/neveljavni
prenosi odstranijo začasno datoteko; po napaki pri zapisu metapodatkov se že objavljen
content-addressed objekt ne briše na slepo (sočasen prenos ga lahko že uporablja).
Baza in dogodek hranita le metapodatke in zasebni ID. JSON omejitve ostajajo majhne.

Povečanje velja tudi v skupnem izbirniku PDF prilog. Za velike PDF-je ne ustvarjamo
samodejno sličice pri odpiranju dogodka; sicer bi telefon spet bral cel dokument.
Prenos/ogled uporablja obstoječi prijavljeni endpoint in pravice. Ni nove javne povezave.

Skupni PDF izvoz ima privzeto 100 MiB, da 50 MiB priloga ne zapolni vsega prostora
pred dodajanjem poročila. Omejitve Gmaila ostajajo 5/8 MiB, ker so neodvisne.
Nginx ima že zgornjo omejitev 210 MiB; ni sprememb druge aplikacije ali proxy konfiguracije.

Znižanje omejitve ne izbriše ali skrije shranjenih prilog. Znižanje števila dovoljuje
shranjevanje zgodovinskega dogodka brez novih prilog, ne odreže obstoječih.

## Odstranjeno

Odstranjeni so začasna pot /api/todo-editor-diagnostics, meritve odpiranja/zaklepa,
Server-Timing in njihov prikaz. Ohranjen je običajni nadzor CPU/RAM/diska,
varnostnih kopij, opozoril in funkcionalni časovniki urejevalnika.

## Objava in povrnitev

Pred objavo: npm test, izolirani E2E, obvezni PostgreSQL/restore/upgrade prehod ter
preverjena offsite kopija. Ni nove poslovne sheme. Prejšnja produkcija d1590b7 zna
brati shranjene PDF metapodatke, ne zna pa novih nastavitev in pretočnega PDF uploada.
Pri povrnitvi se config ohrani, stara koda ga ignorira; vrnejo se stare omejitve in
samodejna izdelava predogleda. Če pozneje zvišamo število prilog nad 40, povrnitev
na stare izdaje z rezanjem seznama na 40 ni varna za urejanje teh dogodkov.

Nobene aktivacije Google Calendar OAuth ali GitHub push ni del te objave.
