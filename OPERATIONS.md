# INDUS Ure – obratovanje, varna objava in obnova

## Meje aplikacij in odgovornost

INDUS Ure in INDUS Fakture sta ločeni aplikaciji istega poslovnega lastnika
(Bojan Horvat). Skupna domena/prijava ne pomeni skupne poslovne baze ali
skupnega dovoljenja za spremembe kode. Poseg v Ure sam po sebi ne dovoljuje
posega v Fakture. Uporabnik je 15. 9. 2026 dovolil postopno razdelitev monolita
in povrnljivo objavo; obseg prve faze opisuje `MODULARIZATION-2026-09-15.md`,
zaključek dogovorjenih sklopov pa `MODULARIZATION-COMPLETE-2026-09-15.md`.

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
- Od 14. 10. 2026 se neprijavljen zunanji obisk samodejno preusmeri na Google.
  Po izrecni odjavi ali neuspešni/prekinjeni prijavi ostane ročni gumb, da ni
  zanke preusmeritev. Že prijavljen obisk ne zahteva dodatne poizvedbe o prijavi.
- Na dovoljenem LAN se brez posebnega URL parametra pokažeta Google in osebna
  prijava z e-pošto. `/api/auth/options` določi možnosti na strežniku;
  `/api/auth/lan-login` zahteva isti zaupanja vreden LAN proxy, JSON in isto
  spletno izhodišče. V produkciji je osebna prijava na voljo le prek HTTPS.
- Osebna gesla INDUS niso gesla za Gmail. Šef jih nastavi ali izklopi v
  **Nastavitve → Delavci → Geslo za prijavo v LAN**, po shranitvi e-pošte.
  Vsako geslo ima 12–128 znakov in lasten naključni salt/scrypt hash.
  Obstoječi uporabniki nimajo samodejno nastavljenih osebnih LAN-gesel.
  Stari zgodovinski hashi in podporno geslo se za osebno prijavo ne sprejmejo.
  Ponastavitev/izklop prekliče prejšnje osebne LAN-seje tega uporabnika;
  Google seje ohrani. Osebni hash se ne izvaža v uporabniški/recovery backup,
  poslovni Undo ali javne profile. Po obnovi sanitiziranega recovery paketa je
  treba osebna gesla nastaviti znova; uporabniška obnova obstoječa gesla ohrani.
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

Osebna prijava uporablja isti strežniški opt-in `LAN_SUPPORT_LOGIN_ENABLED`,
vendar ni odvisna od vrednosti skupnega podpornega gesla. Omejitev poskusov
upošteva dejanski LAN IP in račun, ne skupnega loopback naslova Nginxa.
Za omejitev velja 6 neuspelih poskusov v 10 minutah. Podporni URL ostaja ločen
in ga običajna prijavna stran ne ponuja. `X-Real-IP` mora Nginx vedno prepisati;
prihajajoči `X-Forwarded-For`, poljubno ime domene ali `?lan_support=1` niso dokaz LAN.

Povrnitev te spremembe: prejšnja izdaja `27ab379`; brez spremembe SQL sheme.
Novi `users.*.lanPasswordHash` in `sessions.*.authMethod` sta aditivna. Stara
izdaja osebne prijave ne izvaja, sicer pa podatke ohrani. Povrnitev kode sama
ne prekliče že izdanih sej; po potrebi jih je treba preklicati ločeno.

## Tehnična konfiguracija

### Ločeni vrsti prevoza in koledar (26. 10. 2026)

Nastavitve → Delavci → Obračun delavca ločijo:

- `commuteKmOneWay`: razdalja dom–podjetje v eno smer;
- `commuteKmRate`: EUR/km za prevoz do podjetja (razdalja × 2, enkrat na
  dan z upravičenim vpisom; brez malice ali dela od doma);
- `workerOwnVehicleKmRate`: EUR/km za službeno vožnjo do strank z lastnim
  vozilom; kilometri se še naprej vnesejo pri posameznem vpisu.

Dokler nova tarifa ni shranjena, podeduje dosedanjo učinkovito postavko
delavca. Shranitev obračunskih nastavitev jo zapiše samostojno, tudi če
starejši odjemalec pošlje samo drugo postavko. Nič je veljavna vrednost.
Stroški, ki se zaračunajo stranki, ostajajo neodvisni.

Predogled, dnevni razrez, povzetek in XLSX ločijo obe razdalji in zneska.
Novi obračuni shranijo obe postavki in zneska, zato poznejše spremembe
nastavitev ne spreminjajo shranjenih obračunov. Zgodovinski obračuni ohranijo
staro obliko in znesek; prikaz razdeli le informativni del prevoza. Morebitni
cent zaradi starega skupnega zaokroževanja ostane pri službenem prevozu.
Za ta primer XLSX vsebuje izrecno razliko zaokroževanja. SQL shema je ista.

Povrnitev kode pred uvedbo dveh postavk je varna samo pred nastankom novih
obračunov z ločenima tarifama. Stara koda teh polj ne razume in pri
normalizaciji lahko preračuna oba prevoza po stari skupni tarifi. Pozneje
je potreben združljiv popravek naprej oziroma povrnitev UI ob ohranitvi
novega obračunskega modula; ne slepo preklapljanje stare kode ali vračanje
celotne baze čez nove uporabniške vnose.

Odstranjeni so novi pikčasti ročaji za razvrščanje v mesečnem in dnevnem
koledarju. Shranjeni vrstni red in razvrščanje večdnevnih opravil po dolžini
ostajata; pridržanje za premik datuma/termina ter robni ročaji za ure ostanejo.
Nov obrazec ob mesečnem + ponuja Odsotnost z izbranim datumom. Prehod ne
ustvari vpisa ur in ohrani nedokončan osnutek opravila. Delavec izbira samo
svojo odsotnost, šef pa katerega koli delavca.

### Dovoljenja za vpis ur (25. 10. 2026)

Šef določi ciljne izvajalce v **Nastavitve → Delavci → Lahko vpisuje ure za**
in klikne Shrani pri posameznem delavcu. Izbrati je mogoče aktivne delavce,
vključno s sabo in zunanjimi izvajalci. Prazna izbira onemogoči vpis ur.
Posamezen vpis je še vedno samo za enega izvajalca; šef lahko vedno izbira vse.
To ne razširi dostopa do tujih opravil, obračunov ali odsotnosti. Delavec
odsotnost še naprej vpisuje samo zase, dodeljevanje sodelavcev planiranju pa
ostane ločeno od dovoljenj za vpis ur.

Brez izrecno shranjene nastavitve ostane dosedanje pravilo zase/zunanji.
Stara prezrta polja `timeEntryForIds` sama ne podelijo nobenih novih pravic:
upoštevajo se samo skupaj z `timeEntryPermissionsConfigured: true`, ki ga
postavi šefovski API. API preveri aktivne ID-je, hrani tudi prazen seznam,
ob odvzemu pa zavrne nove vpise in spreminjanje ur tudi iz zastarelega
obrazca, časovnice ter stare poti `/api/entries`. Normalni zapis profila
brez polja dovoljenj nastavitev ohrani. Audit vsebuje prejšnji in novi
učinkoviti seznam. Neaktivni/odstranjeni cilji ne ostanejo pooblaščeni.

Gre za aditivno polje uporabniškega JSON, brez spremembe SQL sheme in brez
spreminjanja obstoječih vpisov. Povrnitev kode na `0d8ee39` vrne prejšnje
fiksno pravilo zase/zunanji (torej novih omejitev ali razširitev ne upošteva).
Po povrnitvi in ponovni nadgradnji je treba dovoljenja pregledati, saj stara
normalizacija v seznam lahko ponovno doda uporabnika samega.

Objavljeno kot `41b524c`; prejšnja izdaja `0d8ee39` ostane za povrnitev.
Pred preklopom je uspešno preverjena kopija
`indus-ure-recovery-20261025T101655Z.tar.gz` (lokalni arhiv, Drive velikost/MD5,
sveže branje, navodila za obnovo, CSV; tudi vsa tri čiščenja uspešna).
Pravih dovoljenj ob objavi nismo spreminjali (`explicitlyConfigured: []`).

Končni prehodi: Windows 352 uspešnih enotskih/API testov in en namensko
preskočen; Linux 353/353. Chromium 115/115; Firefox 23 uspešnih in dva
namensko preskočena testa Chromiumovega dotika. PostgreSQL/obnova/nadgradnja/
povrnitev 39 preverjanj. Novi brskalniški test uporablja novo testno delavko
z osebno LAN prijavo: šef s kljukicami dodeli pravico, delavka prek obrazca
vpiše sodelavčeve ure, odvzem pa zavrne zastareli zapis in premik časovnice.
Preverjeni so tudi prazen seznam, neveljavni ID-ji, samo en izvajalec in
nespremenjena omejitev odsotnosti. Testi ne pomenijo testa na fizičnem telefonu.

Produkcijski bralni preizkus: vseh pet aktivnih kartic dovoljenj, delavčev
obrazec, odsotnost, odpiranje/zapiranje obstoječega opravila brez spremembe,
priloga HTTP 200 in obračunski pogled; brez poslovnih zapisov ali JS napak.
Storitev in backup timer aktivna, v preverjenem intervalu ni opozoril.
Opravljena točka odstranjena iz Google TODO po preverjanju objave.

Dnevni pogled (19. 10. 2026): kratek klik/dotik na dogodek odpre urejevalnik.
Premik časovnega ali celodnevnega dogodka se omogoči po 400 ms pridržanja
z miško, pisalom ali dotikom; črtkan okvir označi pripravljenost. Spust brez
premika še vedno odpre dogodek. Poteg pred pridržanjem samo pomika pogled.
Trajanje se spreminja samo prek desnih kontrol zgoraj/spodaj, ne prek
nevidnih robnih območij. Pri miški se ti kontroli odzoveta takoj, pri dotiku
po obstoječem pridržanju. Navaden kazalec ne kaže več rokice za vlečenje.
Regresijski prehod vključuje klike, počasne dotike, tresljaj, premik, resize,
prenos pointer capture, pinch in vrnitev iz urejevalnika v Chromiumu/Firefoxu.

Od 17. 9. 2026: `/var/lib/indus-ure/app-config.json`, šefovski obrazec v nastavitvah,
atomaren zapis in prejšnja različica. Podrobnosti, privzete omejitve, validacija ter
omejitve povrnitve: [TECHNICAL-CONFIG-2026-09-17.md](TECHNICAL-CONFIG-2026-09-17.md).

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
2. `npm test`, izolirani `npm run test:e2e` in `npm run test:e2e:firefox`.
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

### Berljivi izvozi v samodejni kopiji (19. 10. 2026)

Vsak zagon obstoječega `indus-ure-backup.service` (nočni in pred objavo)
v isti PostgreSQL transakciji kot dump izdela `dogodki.csv` in `vpisi-ur.csv`.
Oba sta v arhivu; manifest vsebuje število vrstic, velikost in SHA-256.
Po preverjenem nalaganju arhiva se posodobita tudi dve samostojni datoteki
v isti zasebni mapi Drive. ID in pravice ostanejo; dnevni CSV-ji se ne kopičijo.
Njuni namenski `appProperties.purpose` nista predmet redčenja recovery arhivov.
Vsak prenos se preveri s svežim branjem velikosti in MD5. Napaka CSV ustavi
backup pred čiščenjem in sproži obstoječe opozorilo; pri napaki generiranja
se prejšnja samostojna izvoza ne spreminjata. Prenosa dveh Drive datotek nista
atomarna: po prekinitvi primerjaj ID kopije in uporabi par iz istega arhiva.

CSV uporablja UTF-8 BOM, podpičje, dvojne narekovaje, decimalno vejico in
ohranjene večvrstične opise. Formuli podobno besedilo dobi varnostni apostrof.
Dogodki vsebujejo vse ohranjene skupne dogodke in stare koledarske vnose;
vpisi ur so ločeni po izvajalcu. Vključena sta arhiv in koš z oznako stanja.
Prazna številčna polja niso ničle. Vpisane ure so čas od–do, ne ponovni obračun
plače; ure za stranko so navedene enkrat na skupni dogodek. Priloge, celotna
zgodovina in potrjeni obračuni ostajajo v polnem recovery arhivu, ne v CSV.
Ročnih opomb ne vpisuj v avtomatski datoteki, ker ju naslednji backup zamenja.
Povrnitev kode na predhodno izdajo ustavi osveževanje CSV, že ustvarjeni
datoteki/arhivi ostanejo uporabni. Ni spremembe SQL sheme ali poslovnih podatkov.

Google koledar planiranja: pravila, nova dovoljenja, operativna vrsta,
začasna ustavitev in omejitve povrnitve so v `GOOGLE-PLANNING-CALENDAR.md`.
Stanje `indus_meta/planning_calendar_sync_v1` je ločeno od poslovnega CAS in
ni del sanitiziranega recovery izvoza; po obnovi se povezava ponovno potrdi.

- Recovery arhiv vsebuje `database.dump`, `sanitized-state.sql`, `media/`,
  `application/`, `app-config.json` (od 17. 9. 2026), `dogodki.csv` in
  `vpisi-ur.csv` (od 19. 10. 2026), `manifest.json` in generirani `RESTORE-INDUS-URE.txt`.
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

### Samodejna lokalna hramba recovery kopij (23. 9. 2026)

Po novi, lokalno in na Google Drive preverjeni kopiji se lokalno ohrani
zadnja kopija vsakega od zadnjih 7 koledarskih dni (Europe/Ljubljana) in
zadnje 3 označene kopije pred objavami. Prekrivanje šteje samo enkrat;
ob začetku obratovanja se vedno ohranijo vsaj 3 razpoložljive popolne kopije.
To ni trda omejitev velikosti arhivov. Nastavitvi v `/etc/indus-ure.env` sta
`BACKUP_LOCAL_RETENTION_DAYS=7` in `BACKUP_LOCAL_DEPLOYMENT_COPIES=3` (privzeto,
minimuma 7 in 3).

`deploy-indus-ure` po uspešnem pre-deploy backupu in pred preklopom kodo
kopije označi z `<archive>.deployment.json`. Ta vsebuje ime, SHA-256 in ciljno
izdajo, ne skrivnosti. Nova oznaka lahko do naslednjega uspešnega backupa
začasno poveča število zaščitenih kopij s 3 na 4. Takrat se presežna oznaka
odstrani skupaj z arhivom, razen če ga ohranja dnevno pravilo.

Čiščenje preveri SHA-256 vseh ohranjenih arhivov pred prvim brisanjem.
Dotakne se samo popolnih prepoznanih arhivov neposredno v `BACKUP_DIR`
ter njihovih kontrolnih datotek/oznak; ročne kopije, podmape, nepopolne
kopije in neznane datoteke ostanejo. Napačna kontrolna vsota, neveljavna
oznaka ali konflikt zaklepa ustavijo čiščenje in sprožijo ločeno opozorilo
čiščenja, ne razveljavijo že preverjene nove kopije. Dnevnik `indus_backup_runs.data.localRetention` vsebuje seznam
ohranjenih/odstranjenih kopij ter sproščene bajte.

Backup ima PostgreSQL advisory lock proti sočasnim zagonom, označevanje in
lokalno čiščenje pa skupni `.retention-lock`. Po nasilni prekinitvi lahko ta
mapa ostane: odstrani jo samo po preverjanju, da noben backup ali deploy
ne teče. Samodejnega nasilnega odstranjevanja zaklepa ni.

Za pregled brez brisanja uporabi `node scripts/backup-retention.js --inspect
<BACKUP_DIR>`; ločen nezaščiten ukaz za brisanje ne obstaja.
Stare preverjene kopije pred objavami se ob uvedbi lahko označijo z
`scripts/mark-backup-deployment.js --directory <BACKUP_DIR> --release <git-id>
--archive <točno-ime-arhiva>`. Tudi ta korak preveri SHA-256 in ničesar ne briše.

### Samodejno redčenje Google Drive kopij (23. 10. 2026)

Isti nočni backup (02:15–02:30 Europe/Ljubljana) po uspešni izdelavi in
preverjanju nove lokalne/oddaljene kopije ohrani **največ 7 popolnih kopij**:

- zadnjo kopijo za danes, včeraj in predvčeraj;
- po eno zadnjo kopijo iz vsakega od zadnjih 4 zaključenih tednov.

Tedni so ponedeljek–nedelja. Obdobja se določajo po lokalnem datumu Europe/Ljubljana, zato
prehod poletnega časa ne spremeni števila dnevnih kopij. To je periodična
rotacija 1–2–3 dni + 1–2–3–4 tedne, ne obljuba natančne starosti 7/14/28 dni
ob vsakem zagonu. Tretja tedenska kopija mora ostati, da lahko naslednji teden
postane četrta. Ob manjkajočem tednu je ta točka prazna. Ena datoteka lahko
pokriva dnevno in tedensko točko; zato je ob rednih zagonih v ponedeljek in
torek 6 paketov, ostale dni 7. Na začetku ali po izpadih
se ohranijo vsaj tri popolne kopije, če so na voljo. Datum v prihodnosti
ustavi celotno čiščenje, da napačna ura ne povzroči izgube podatkov.

Politika je `BACKUP_OFFSITE_RETENTION_MODE=daily3-weekly4-v1` (privzeto).
Stari `BACKUP_OFFSITE_RETENTION_DAYS` in `BACKUP_OFFSITE_DEPLOYMENT_COPIES`
se ne uporabljata več. **Dodatnih pred-objavnih kopij na Drivu ne hrani.**
Lokalno pravilo 7 dnevnih + 3 pred-objavne ostaja nespremenjeno.
Trajni izbris zahteva ločeno nastavitev `BACKUP_OFFSITE_DELETE_APPROVED=true`,
ki se omogoči samo po izrecnem dovoljenju lastnika. Brez nje je predogled
omogočen, dejansko čiščenje pa se ustavi z opozorilom. Splošna uporabnikova
preferenca `_Trash` ostaja veljavna za druge datoteke: premik v to mapo
ne sprosti prostora, zato je trajno brisanje kopij ločena izjema.
Lastnik je 23. 10. 2026 izrecno dovolil trajni izbris presežkov INDUS URE in
tedensko poravnavo pravila. To dovoljenje ne velja za Fakture ali druge datoteke.

Obravnava le lastne, aplikacijsko označene pare recovery arhiv + SHA-256
v namenski mapi. Nepopolne pare, ročne kopije, navodila in neznane datoteke
pusti nedotaknjene. Pred brisanjem preveri vse kontrolne datoteke in sveže
Drive metapodatke celotnega načrta. Napaka, spremenjen objekt ali neveljavna
zaščita ustavi čiščenje. Starega arhiva ne prenaša v celoti še enkrat:
lokalni SHA-256 in oddaljena velikost/MD5 sta preverjena ob nalaganju nove
kopije; pri starih preveri integriteto kontrolne datoteke in metapodatke.

Od 8. 10. 2026 primerjava namerno ignorira interno Drive polje `version`,
ki se lahko spremeni brez spremembe vsebine. Še vedno primerja ID, ime,
velikost, MD5, lastništvo, mapo, koš in aplikacijske/zaščitne oznake; pri
neujemanjih dnevnik navede spremenjena polja. Datum in velikost sama nista
dokaz integritete. Pred brisanjem se kandidati ponovno preverijo.

Izdelava kopije in čiščenje imata ločen rezultat: po uspešnem preverjanju
kopija ostane `status=success`, čiščenje pa ima `cleanupStatus=success`
ali `warning`, s podrobnostmi v `driveRetention` in `localRetention`.
Opozorilo `backup-cleanup-failed` (»Kopija je uspela; čiščenje kopij ni
uspelo«) aplikacijski nadzor prikaže in pošlje po že nastavljeni poti.
Neuspešno Drive čiščenje preskoči lokalno brisanje. Dejanska napaka izdelave,
nalaganja ali preverjanja nove kopije ostaja kritična `backup-failed` in
neuspešen izhod storitve. Prejšnjih neprebranih napak uspešen zagon ne briše.

Lokalne pred-objavne oznake obstoječih parov po preverjanju SHA-256 prepiše v zasebne Drive
`appProperties` arhiva (`deploymentRelease`, `deploymentSha256`). Objavni
postopek mora pred preklopom izdaje potrditi tudi to oddaljeno oznako za
točno zahtevano novo kopijo. Stare lokalne oznake lahko po novem preživijo
izbris oddaljenega para in ne smejo ustaviti naslednje kopije. Oddaljena
oznaka je evidenca izvora, ne izjema od največ sedmih arhivov. Obnova stare
kode tega pravila nima nujno; po rollbacku preveri politiko kopij. Stari
backup pred to spremembo lahko zahteva že izbrisane oddaljene pred-objavne
kopije; pri povrnitvi aplikacije je treba ohraniti novo backup orodje oziroma
ponovno uskladiti njegov postopek, ne slepo zagnati starega čiščenja.

Pregled brez sprememb (tudi brez zapisovanja Drive oznak):
`sudo node --env-file=/etc/indus-ure.env /opt/indus-ure/current/scripts/backup-indus-ure.js --inspect-retention`.
Samostojen nezaščiten ukaz za brisanje ne obstaja. Za dejansko čiščenje
zaženi običajni `indus-ure-backup.service`; ta najprej ustvari novo kopijo.
Drive čiščenje in označevanje uporabljata isti PostgreSQL advisory lock in
lokalni `.retention-lock`. Rezultat in delni napredek ob napaki sta zapisana
v `indus_backup_runs.data.driveRetention` (imena, sproščeni bajti, pravilo).
Po izrecnem dovoljenju in zgornji nastavitvi se arhivi trajno izbrišejo,
ne prestavijo v plačljiv koš. Rollback kode jih ne obnovi; ohranjene dnevne
in periodične kopije ostanejo na voljo. Berljiva `dogodki.csv` in
`vpisi-ur.csv` ter navodila za obnovo niso kandidati čiščenja.
Po brisanju se vsak izbrisani ID preveri z odgovorom Drive 404, ohranjeni
pari pa ponovno z velikostjo, MD5, lokacijo in lastništvom.

#### Preverjena objava in prvo čiščenje, 23. 10. 2026

Objavljena koda: `d879d4a` (prejšnja izdaja `d2079b6`). Pred preklopom je
uspela kopija `indus-ure-recovery-20261023T124044Z.tar.gz`. Nato sta bili
vključeni zgoraj navedeni nastavitvi za novo politiko in izrecno odobren
trajni izbris. Zasebna kopija prejšnjih nastavitev je ostala na strežniku
kot `/etc/indus-ure.env.before-weekly-retention-20261023` z dovoljenji 0600.

Redni servis je ustvaril in preveril novo kopijo
`indus-ure-recovery-20261023T124234Z.tar.gz`. Zaključil je ob 12:47:33 UTC
z `status=success`, `cleanupStatus=success` ter uspešnima Drive in lokalno
hrambo. Nova rutina je trajno odstranila 86 parov arhiv/kontrolna datoteka
in sprostila **10.881.349.996 bajtov**. Ohranila je sedem parov,
**1.420.643.370 bajtov**, z datumi 23., 22., 21., 18., 11. in 4. oktober
ter 27. september. Ponovni `--inspect-retention` je potrdil sedem
ohranjenih parov, nič kandidatov za izbris in tri izvzete datoteke.
Neodvisen pregled mape Drive je potrdil 17 datotek: sedem parov,
nespremenjena ID-ja obeh posodobljenih CSV-izvozov in navodila za obnovo.
Celotna mapa ob preverjanju: 1.421.143.039 bajtov.

Preverjanja: 345 uspešnih enotskih testov in en namensko preskočen;
končni celotni Chromium prehod 112/112; Firefox 19 uspešnih in en
preskočen test dotika; 32 PostgreSQL/API/restore/upgrade/rollback preverjanj.
Prvi Chromium prehod je imel en prehoden timeout pri javni Google prijavi
(111/112); sledilo je 9/9 ponovitev prijavnih testov in čist celotni
112/112 prehod, brez spremembe prijavne kode. Vzrok tega posameznega
timeouta ni dokazan. Rotacija kopij ima tudi 760-dnevno simulacijo,
preizkuse časovnega pasu, izpadov in varovalk pred izbrisom.

Produkcijski brskalniški preizkus je potrdil prijavo, odpiranje in zapiranje
obstoječega opravila brez spremembe njegovih podatkov, prilogo HTTP 200 in
obračunski pogled; brez poslovnih zapisov ali JavaScript napak. Storitev
je zdrava, brez opozoril v preverjenem intervalu. Časovnik ostaja vključen;
naslednji zagon ob preverjanju je 24. 10. ob 02:17:09 po lokalnem času.

### Mediji aplikacije

Brisanje metapodatkov je transakcijsko. `save()` po COMMIT ne briše fizične
datoteke: drug zapis jo lahko medtem znova uporabi. Običajno datoteko varuje
že content-addressed ključ; Undo dodatno zadrži potrebne metapodatke.
Po preverjeni recovery kopiji se izvede `scripts/media-cleanup.js`.
Čisti samo starejše od 24 ur, nepovezane datoteke s kanoničnim 64-hex
imenom v `media/objects` in `media/thumbnails`. Ne dotika se `.uploads`,
neznanih imen, simbolnih ali trdih povezav, drugih projektov ali Drive datotek.
Koš, zgodovina, Undo, čakajoča nalaganja in vse ostale shranjene reference
zaščitijo datoteko. Metapodatki zgodovinskih prilog se prav tako ohranijo.

Vsi spletni uploadi, ZIP izvoz/obnova in `PostgresStore.save()` uporabljajo
skupni advisory zaklep `indus-ure-media-lifecycle-v1`. GC poskusi izključni
zaklep (nikoli ne čaka), nato zaklene `storage_revision`, ponovno prebere
reference in preveri datoteke. Če poteka nalaganje/zapis, se čiščenje odloži
do naslednje kopije. Drugi recovery backupi so izključeni z obstoječim
`indus-ure-recovery-backup` zaklepom. Zunanji vzdrževalni zapisovalci morajo
uporabljati isti protokol ali ustavljeno aplikacijo in backup časovnik.
Obnova prilog iz recovery paketa uporablja isti vrstni red zaklepov in
poveča revizijo baze, da zastarel posnetek ne prepiše obnovitve.

GC zahteva svežo preverjeno lokalno in Drive kopijo ter oba CSV-izvoza.
Izid je v `indus_backup_runs.data.mediaCleanup` (candidates, removed,
freedBytes, skipped). Napaka čiščenja ne spremeni uspešne kopije v neuspešno,
ampak ustvari opozorilo. Prva kopija pred čiščenjem še vsebuje odstranjene
datoteke; manjša je naslednja. Fizični izbris ni povrnjen z rollbackom kode;
datoteke ostanejo v preverjeni predhodni kopiji do njene redne rotacije.

Pregled 7. 10. 2026: čiščenje koša/arhiva periodično odstrani metapodatke
nepreklicno izbrisanih dogodkov. Stare aplikacijsko upravljane Drive priloge
poskusi izbrisati pred izbrisom dogodka; ob napaki obdrži dogodek za ponovni
poskus. Zunanjih povezav ne briše. Splošnega iskanja osirotelih Drive datotek
ali fizičnih datotek `media/objects` in `media/thumbnails` takrat ni bilo. Zato take
datoteke ostajajo tudi v naslednjih celovitih recovery kopijah. Pred
uvedbo fizičnega čiščenja je potreben ločen, usklajen GC z zaščito vseh
referenc, zgodovine/Undo in nalaganj v teku; zgolj brisanje po ID dogodka
ni varno.

#### Objava TODO in avtomatskega GC, 24. 10. 2026

Produkcija: `0d8ee39`, prejšnja izdaja `d879d4a`. GitHub `origin/main`
vsebuje izvorno kodo. Pred preklopom je bila ustvarjena in preverjena kopija
`indus-ure-recovery-20261024T090302Z.tar.gz`. Urejeno:

- odstranjen samo gumb Odsotnost ob mesečnem naslovu;
- delavec v odsotnosti vidi svoje ime, ne izbire drugega delavca; šef ima izbiro;
- dnevna kljukica je aktivna tudi brez sprememb in takrat zapre pogled;
  med dejanskim shranjevanjem prepreči podvojeno oddajo; X ostane aktiven;
- enodnevna opravila brez ure se ročno razvrščajo zgoraj, večdnevna pa spodaj
  od krajših proti daljšim; mesečne povezane pasice ostanejo poravnane;
- vrstni red je skupen mesečnemu/dnevnemu pogledu in vsem udeležencem;
  kratek dotik ročaja odpre opravilo, pridržanje in vlečenje razvršča;
- zgoraj opisano samodejno fizično čiščenje lokalnih prilog.

Preverjanja na končni kodi: Windows 352 uspešnih enotskih testov + 1 namensko
preskočen; na strežniku 353/353; Chromium 114/114; Firefox 22 uspešnih + 2
preskočena testa, ki zahtevata Chromiumov dispatcher dotika. 36 dejanskih
PostgreSQL/API/restore/upgrade/rollback preverjanj. Nova testna primera
preverita tudi držani dotik in miško, ne le programskega klika. Prvi razvojni
prehod je odkril prestrezanje dotika z novim ročajem; popravljeno in ponovljeno
v celotnem prehodu. En prehoden Playwrightov »file data stream« error ni bil
ponovljen v čistem končnem prehodu; ne šteje kot uspešen prvi prehod.

Produkcijski preizkus: šef in Ibro, odsotnost, prazna dnevna kljukica,
odpiranje/zapiranje obstoječega opravila brez spremembe, priloga HTTP 200,
obračunski pogled; nič poslovnih zapisov in nič JS napak. Ponovljeno tudi
po GC. Storitev aktivna, backup timer vključen, brez opozoril v pregledanem
intervalu po objavi. Testi ne pomenijo preizkusa na fizičnem iPhonu.

Prvi novi backup `indus-ure-recovery-20261024T090419Z.tar.gz` je uspel z vsemi
preveritvami in `cleanupStatus=success`. GC je odstranil 26 starih
nepovezanih datotek, **9.245.135 bajtov**. Predhodni dry-run je pokazal iste
količine. Drive še naprej hrani sedem paketov po obstoječem pravilu.

Neodvisna kontrola po GC: 80 vrstic metapodatkov, 116 lokalnih poti;
114 datotek obstaja. **Dve manjkajoči poti sta stara težava iste fotografije**:
`objects/0d9cf0dde3c45dbc70955e3481836d2fa75c3807ad9ba514fe281dc5f9840bac.jpg`
in enako ime v `thumbnails/`. Metapodatki navajajo JPEG 998.155 bajtov,
ustvarjen 1. 9. 2026 ob 13:23:04 UTC. Trenutne reference so na opravilu
»Elektro omara Tržič - Montaža teren« in treh vpisih 1.–2. 9. 2026:
`a4f739d8-5e36-49fa-9adc-9427f7532104`,
`661ed8c5-a1c4-4e62-9c7d-e9c8b6726f20`,
`acfb2ddf-f018-4a0c-b652-c4ee289080ca`,
`57e76d14-e885-4f40-8343-1cccf3c1dc17`.
Obe poti manjkata tudi v kopiji **pred današnjo objavo** in v vseh lokalnih
recovery arhivih 18.–24. 10.; današnji GC ni vzrok. Povezave/metapodatki niso
odstranjeni. Za iskanje starejšega izvora je dodana ločena odprta točka v
Google TODO, objavljene stare točke pa so odstranjene. Starejših Drive
arhivov v tem posegu nismo prenašali ali pregledovali.
