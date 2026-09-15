# INDUS Ure – obratovanje, varna objava in obnova

## Meje aplikacij in odgovornost

INDUS Ure in INDUS Fakture sta ločeni aplikaciji istega poslovnega lastnika
(Bojan Horvat). Skupna domena/prijava ne pomeni skupne poslovne baze ali
skupnega dovoljenja za spremembe kode. Poseg v Ure sam po sebi ne dovoljuje
posega v Fakture. Uporabnik je 15. 9. 2026 dovolil postopno razdelitev monolita
in povrnljivo objavo; obseg prve faze opisuje `MODULARIZATION-2026-09-15.md`.

| | Ure | Fakture |
|---|---|---|
| URL | `https://ure.indus.si/` | `https://ure.indus.si/fakture/` |
| Proces | `indus-ure.service`, loopback 8123 | `indus-fakture.service`, loopback 8130 |
| Baza | `indus_ure` | `indus_fakture` |
| Izdaje | `/opt/indus-ure/releases/` | `/opt/indus-fakture/releases/` |
| Aktivna izdaja | `/opt/indus-ure/current` | `/opt/indus-fakture/current` |
| Skrivnosti | `/etc/indus-ure.env`, root-only | `/etc/indus-fakture.env`, root-only |
| Objava | `scripts/deploy.ps1` in `deploy-indus-ure` | ločen `verify:preproduction`, PostgreSQL QA in `deploy-indus-fakture` |

Ure repozitorij: `https://github.com/bojanhor/indus-ure.git`. V Windows je
delovna kopija v `work/indus-ure`. Fakture imajo svoj repozitorij/direktorij,
testne dokaze in pravila; ta navodila jih ne nadomeščajo.

## Google prijava in produkcijska LAN podpora

- Običajna prijava je Google OAuth. Delavec brez povezane Google prijave
  lahko obstaja v evidenci; to mu samo po sebi ne omogoči spletnega dostopa.
- Ločena podporna prijava z izbiro uporabnika in geslom obstaja tudi v
  produkciji, če je `LAN_SUPPORT_LOGIN_ENABLED=true` in je podporno geslo
  dolgo najmanj 24 znakov. Skrivnost ostane samo v okoljski datoteki.
- Zahteva mora priti prek lokalnega Nginx proxyja, ki prepiše `X-Real-IP`
  z dejanskim naslovom odjemalca. Koda sprejme le omrežje `192.168.50.*`;
  `TEST_LOCAL_NETWORK` mora biti natančno `192.168.50.`. Node ostane vezan na
  `127.0.0.1`, port 8123 ne sme biti javno dostopen.
- Vstop: `https://ure.indus.si/?lan_support=1` iz dovoljenega omrežja.
  Spreminjanje parametra URL ne obide preverjanja omrežja, gesla ali CSRF.
- `/api/test-login` je skupna pot za ločeno testno prijavo in ozko LAN
  podporo. `INDUS_URE_TEST_MODE=true` sam v produkciji ne deluje.
- Po šestih neuspelih poskusih je prijava začasno omejena. Seje uporabljajo
  HttpOnly/Secure/SameSite cookie in CSRF. Ob izključitvi podpore preveri
  tudi preklic že ustvarjenih podpornih sej; sprememba zastavice sama ne
  pomeni preklica obstoječega piškotka.

## Pravila shranjevanja in sočasnosti

- HTTP branje ne shranjuje normalizacije. Združljivostna normalizacija
  ostane samo v pomnilniku; obstojna normalizacija teče pred odprtjem HTTP
  porta v `migratePostgresNormalization()`.
  Življenjski cikel shrambe in predpomnilnik posamezne zahteve sta v
  `outputs/storage.js`; relacijski mehanizem ostaja v `outputs/postgres-store.js`.
- `PostgresStore.load()` uporabi eno transakcijo `REPEATABLE READ READ ONLY`.
  Vseh dvanajst skupin podatkov zato pripada istemu trenutku.
- `save()` sprejme samo isti objekt, ki ga je vrnil `load()` tega store-a.
  Revizijo hrani zasebno; ne zaupamo reviziji iz zahtevka ali kopiranega JSON.
- V transakciji zaklene `indus_meta/storage_revision`, primerja izvorno
  revizijo in ob neskladju zavrne celoten zapis z `STALE_SNAPSHOT` / HTTP 409.
  To je varovalo celotnega poslovnega posnetka: tudi neodvisna zunanja
  sprememba lahko zahteva svež preizkus/ponovitev. Ne združujemo obračunov
  na slepo in ne ponavljamo zunanjih pošiljanj avtomatično.
- V bazo se zapišejo samo spremenjene entitete. Brisanje obravnava samo ID-je,
  ki so bili v izvorni različici in so iz nove namerno odstranjeni. Ni več
  množičnega `DELETE ... NOT IN` nad posnetkom ali upsertov nespremenjenih vrstic.
- Prijava prebere samo ustrezno sejo/uporabnika; poslovna mutacija ponovno
  uporabi en zahtevi pripadajoč posnetek. Priloga prebere samo svoje povezave
  na opravila, dolgove in začasno nalaganje ter ohrani iste dostopne pravice.
- Splošni obračunski pogledi še lahko potrebujejo celoten poslovni posnetek.
  To ni popolna pretvorba vseh poti na neposredne SQL poizvedbe ali delitev
  monolita. Glavni odstranjeni stroški so ponovljena branja in nespremenjeni zapisi.

### Zunanje skripte

Uporabi `PostgresStore` iz **trenutne** izdaje: `load()`, spremeni vrnjeni
objekt, `save()`. Ob konfliktu ustavi operacijo, ponovno preberi podatke ter
ponovno preveri namen spremembe. Ne kopiraj starega rezultata na novo prebran
objekt, da bi obšel revizijo. Ne uporabljaj knjižnice iz stare izdaje ali
neposrednih `UPDATE/DELETE` na poslovnih tabelah med uporabo aplikacije.
Revizijska zaščita ne more zaščititi pred administratorjem, ki jo obide.

## Obvezni postopek objave Ure

1. Čisto commitano stanje, pregled diff-a in brez sprememb tujih projektov.
2. `npm test` in izolirani `npm run test:e2e`.
3. `scripts/deploy.ps1 -IdentityFile <zasebni-kljuc>`: objava commita v Git,
   prenos arhiva in preverjanje SHA-256, priprava točno te izdaje.
4. `run-indus-ure-postgres-qa <revizija>` je obvezen tudi pri ročni objavi:
   ponovi strežniške teste, ustvari zasebne začasne baze/vlogo, preveri
   sočasne zapise dveh povezav in HTTP sej, vzporeden zapis zunanje skripte,
   nespremenjene vrstice, pravice prilog in dejanski recovery format.
   Obnovi dump in recovery kopijo, preveri zgoščene vrednosti vseh poslovnih
   tabel ter testne datoteke. Nadgradnjo preveri še na ločeni kopiji produkcije.
   Na tej kopiji preveri tudi branje in zapis s trenutno objavljeno kodo ter
   ponovni prehod na kandidata. Produkcijska baza pri tem ni cilj zapisovanja.
   Ob uspehu shrani root-owned dokaz za točno vsebino kandidata v
   `/var/lib/indus-ure/qa/<revizija>.*`. Začasne baze/vloga/datoteke se odstranijo.
5. `deploy-indus-ure` zahteva ustrezen dokaz in skladno vsebino kandidata,
   pred preklopom počaka na uspešen recovery backup, nato preklopi izdajo.
   Preveri systemd in HTTP health; neuspešen zagon vrne prejšnjo kodo.
6. Po objavi preveri prijavo, odpiranje opravila, prilogo in obračunski pogled
   v brskalniku brez spreminjanja poslovnih podatkov; preveri dnevnike.

PostgreSQL/restore prehoda ni mogoče izključiti s `SkipTests`. Brskalniški
testi so izolirani, ne ciljajo javne aplikacije. Produkcijski zapisni test
ali pošiljanje prave e-pošte zahtevata posebej določen varen testni primer.

## Obnova in povrnitev

- Recovery arhiv vsebuje `database.dump`, `sanitized-state.sql`, `media/`,
  `application/`, `manifest.json` in generirani `RESTORE-INDUS-URE.txt`.
  Dump in očiščeni uporabniki/nastavitve uporabljajo isti izvoženi PG posnetek.
- Ohranita se poslovna baza in mediji; OAuth žetoni, gesla, seje, ICS žetoni
  in `/etc/indus-ure.env` so izključeni. Skrivnosti potrebujejo ločeno varno kopijo.
- Pred obnovo preveri SHA-256 arhiva, seznam datotek in manifest. Najprej
  obnovi v ločeno bazo/mapo, preveri število vrstic, reference in medijske hashe.
- Obnova v pravo bazo je destruktiven poseg: zahteva izrecno izbiro kopije,
  dodatni dump trenutnega stanja in ustavitev aplikacije ter zunanjih skript.
  Uporabi natančna navodila znotraj izbranega arhiva. Nikoli ne obnovi
  samo kode iz časa pred relacijsko migracijo nad novo poslovno bazo.
- Rollback na izdajo brez CAS varovala ponovno uvede tveganje sočasnih
  prepisov. Tak rollback je samo nadzorovan izhod v sili ob ustavljenih
  zapisovalcih; ni običajen način nadaljnje uporabe aplikacije.
- Po obnovi zamenjaj/povrni okoljske skrivnosti, po potrebi omogoči ozko LAN
  podporo, ponovno poveži Google, ustvari nove ICS povezave in preveri backup.

## Datoteke po brisanju

Brisanje metapodatkov je transakcijsko. `save()` po COMMIT ne briše fizične
datoteke: drug zapis jo lahko medtem znova uporabi. Običajno datoteko varuje
že content-addressed ključ; Undo dodatno zadrži potrebne metapodatke.
Nepovezane fizične datoteke zato lahko ostanejo do ločenega vzdrževalnega
čiščenja. Pri čiščenju je treba ustaviti vse zapisovalce in nalaganja, narediti
kopijo ter dokazati, da ključ ni v metapodatkih, začasnih nalaganjih ali Undo.
Samodejno fizično čiščenje ni vključeno v ta poseg.
