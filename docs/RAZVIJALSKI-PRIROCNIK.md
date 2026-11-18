# INDUS Ure: priročnik za razvijalca ob incidentu

Če se je težava zgodila v produkciji, najprej zabeleži **lokalni čas, vlogo in pogled, dejanje ter pričakovani in dejanski rezultat**. Pri opravilu dodaj ID, če je na voljo; pri obračunu tudi datum dela, izvajalca in čas od–do. Naslov opravila in ime stranke nista enolična. Pri mobilni težavi dodaj še brskalnik, napravo in ali se je aplikacija odprla prek ikone. Za prijavo napake ne potrebuješ gesla, piškotka ali celotne povezave iz e-pošte.

## Prvih pet minut

1. **Določi obseg.** Je prizadeta ena naprava, en uporabnik, en vpis ali vsi? Ure so na `https://ure.indus.si/`; pot `/fakture/` je druga aplikacija z drugo bazo. Pri izpadu ne spreminjaj skupnega proxyja na podlagi napake ene naprave.
2. **Loči javni dostop od stanja aplikacije.** Na prizadeti napravi odpri **[javni health](https://ure.indus.si/api/health)**. Na Ubuntu strežniku so spodnji ukazi samo bralni. Primerjaj čas napake z dnevnikom; pred deljenjem izpisa odstrani osebne podatke in prijavne podatke.

   ```bash
   readlink -f /opt/indus-ure/current
   systemctl is-active indus-ure.service postgresql.service nginx.service
   curl -fsS --max-time 5 http://127.0.0.1:8123/api/health
   journalctl -u indus-ure.service --since '15 minutes ago' --no-pager
   ```

   V produkciji `{"ok":true}` pomeni, da sta se odzvala Node in PostgreSQL (`SELECT 1`). Ne potrjuje prijave, nalaganja obrazca, prilog ali dostopa do Googla. Če lokalni health uspe, javni pa ne, preveri DNS, HTTPS in Nginx. Če uspeta oba, ponovi točen uporabniški korak in preveri prvo neuspešno omrežno zahtevo ali napako v konzoli.
3. **Ohrani dokaze.** Pri okvari ene naprave primerjaj običajni in zasebni zavihek. Ne briši podatkov spletnega mesta, IndexedDB ali aplikacije: na terenu so lahko v njej edini izvodi neshranjenih ur ali slik. Spremembe najprej ponovi na sintetičnih podatkih.

## Lokalna ponovitev

Iz korena tega repozitorija, v razvojnem okolju **brez produkcijskih poverilnic**, namesti odvisnosti iz zaklenjenih različic (`npm ci`). Zahteva projekta za Node je v [package.json](../package.json). Na Windows po potrebi uporabi `npm.cmd` in `npx.cmd`.

| Namen | Ukaz |
|---|---|
| Ročni pregled obrazcev | `node scripts/serve-todo-qa.js` izpiše lokalni URL z začasnimi opravili. Testna prijava je v [testnem pripomočku](../tests/e2e/test-app.cjs). Končaj s Ctrl+C. |
| Enotski in API testi | `npm test` |
| Brskalniki (namestitev prvič) | `npx playwright install chromium firefox` |
| Ponovitev samo težave z zagonom | `npm run test:e2e -- startup-recovery.spec.cjs` |
| Celoten Chromium in izbrane regresije v Firefoxu | `npm run test:e2e`, nato `npm run test:e2e:firefox` |

Brskalniški pripomoček zažene lasten proces na naključnem loopback portu, z začasno datotečno shrambo in brez povezave na produkcijski PostgreSQL. Pri napakah so sledi v `test-results/`. Uspešen test nad JSON ni dokaz za sočasnost PostgreSQL; emulacija telefona ni preizkus na fizični napravi. Za težave s shrambo ali objavo uporabi [izolirani PostgreSQL QA](../scripts/server/run-indus-ure-postgres-qa); nikoli ne nastavi testne baze na `indus_ure`.

## Kje v kodi iskati

Koda, ki se izvaja, je v **`outputs/`**. Strežnik sestavi HTML in vključi lokalne module urejevalnika prek [app-shell.js](../outputs/app-shell.js); spreminjaj izvorni modul, ne kopije HTML, ki jo je prejel brskalnik.

Če se vedenje razlikuje med lokalno in produkcijsko izdajo, primerjaj tudi **učinkovite nastavitve**: [privzete vrednosti](../outputs/app-config.defaults.json) lahko v produkciji prepiše `/var/lib/indus-ure/app-config.json`. Za dovoljene nastavitve in šefovski urejevalnik glej [tehnično konfiguracijo](../TECHNICAL-CONFIG-2026-09-17.md). To ni datoteka z gesli; strežniškega okolja ne kopiraj v razvojni projekt.

| Težava | Začni tukaj |
|---|---|
| Prijava, dostop, inicializacija ali zastoj portala | [server.js](../outputs/server.js), [lan-auth.js](../outputs/lan-auth.js), [index.html](../outputs/index.html), [service-worker.js](../outputs/service-worker.js); [test zataknjenega zagona](../tests/e2e/startup-recovery.spec.cjs) |
| Odpiranje, izginuli osnutek, spor pri shranjevanju | [task-dialog.js](../outputs/editor/task-dialog.js), [drafts.js](../outputs/editor/drafts.js), [task-save.js](../outputs/editor/task-save.js), [edit-locks.js](../outputs/editor/edit-locks.js) |
| Napačne ure, urna postavka ali kilometri | [obrazec vpisa](../outputs/editor/time-entry.js), [pravila obračuna](../outputs/payroll-rules.js), [prevoz](../outputs/payroll-travel.js), [regresija privzete postavke](../tests/e2e/payroll-entry-rate.spec.cjs) |
| Obračun stranke ali Undo | [UI obračuna](../outputs/editor/client-billing.js), [potrditev in preklic](../outputs/settlement-service.js), [Undo na strežniku](../outputs/undo-service.js), [UI zgodovine](../outputs/editor/undo-history.js) |
| Manjkajoča priloga | [nalaganje v brskalniku](../outputs/editor/media-upload.js), [prenos na strežniku](../outputs/attachment-transfer.js), [pravila čiščenja](../scripts/media-cleanup.js) |
| Dogodek ni v zunanjem koledarju | [izbor planiranja](../outputs/planning-calendar.js), [Google prenos](../outputs/google-planning-calendar.js), [pravila za Google in ICS](../GOOGLE-PLANNING-CALENDAR.md) |
| Zapis ne ostane, dve napravi kažeta različno stanje | [življenjski cikel shrambe](../outputs/storage.js), [PostgreSQL](../outputs/postgres-store.js), [testi sočasnosti in obnove](../scripts/postgres-integration.js) |

## Kako preveriti obračun in Undo

Od ločitve zaklepov 18. 11. 2026 je potrjen obračun stranke združljiv z
urejanjem delavčevih še neobračunanih kilometrov in postavke. Nasprotno,
potrjen obračun delavca ne zaklene ločenih ur/kilometrov za stranko.
Skupni podatki ostanejo zaklenjeni. Preveri `todo.settlementEdit` v svežem
odgovoru API in [pravila delnega zapisa](../OPERATIONS.md#ločeni-obračunski-zaklepi-18-11-2026);
ne odklepaj celotnega obrazca ali popravljaj že potrjenih posnetkov.

- **Loči dogodek od dodelitve.** `indus_tasks.id` je skupen dogodek; `indus_task_assignments.id` pripada posamezni dodelitvi, `task_id` jo poveže z dogodkom. V API je `todo.id` ID dodelitve, obračun za stranko pa uporablja `assignmentGroupId || id`. Ne združuj dveh vpisov samo zato, ker imata isti naslov.
- **Kljukica »Potrdi samo ta vpis«** in skupinski gumb oba pošljeta `POST /api/client-bills`. Posamična kljukica pošlje en ID dogodka. Potrditev ustvari obračun stranke, ne obračuna delavca. V meniju Undo je besedilo potrditve poimenovano po **stranki**, ne po opravilu ali izvajalcu. Dve enaki vrstici v kratkem času zato nista dokaz podvojitve ali manjkajočega zapisa.
- **Če uporabnik meni, da potrditve ni:** v šefovskem pogledu ponovno odpri Undo (svež `GET /api/undo-journal`). Primerjaj čas potrditve in čas vpisa ločeno. Za bralno preverbo v bazi primerjaj `indus_client_bills.id`, `data.eventIds` in `data.lines` z ID-jem v `indus_meta` → ključ `application` → `undoJournal[].patch.arrays.clientBills.changes[].id`. Ne izvažaj celotnega zapisa `application`. Zgodovina je omejena (`history.undoActions`, privzeto 20); po njej se razveljavlja od zadnjega dejanja nazaj.
- **Če je napačen samo en obračun:** v **Obračun strank → Prikaži obračunano** odpri stranko, preveri izvajalca in interval, nato **Prekliči obračun stranki**. Preklic velja za *celoten izbrani obračun*: pri paketnem obračunu to lahko pomeni več dogodkov. Če je neposredno plačilo že vključeno v obračun delavca, aplikacija preklic zavrne. Ne razveljavljaj pravilnih vmesnih dejanj in ne spreminjaj statusov neposredno v SQL.
- **Če je vprašljiva plača:** loči delavčevo privzeto postavko, ročno postavko na konkretnem vpisu (tudi 0 je veljavna) in že potrjeni obračun. Prevoz dom–podjetje, službena pot z lastnim vozilom in kilometri, zaračunani stranki, so tri različne postavke.

## Priloge in varnostne kopije

- **Manjkajoča slika:** najprej loči štiri stanja: čakajoča v lokalni vrsti, naložena na strežnik, povezana s shranjenim dogodkom in dejansko berljiva. Preveri isti ID dogodka in pravice, nato referenco priloge, metapodatke ter original in predogled. Koš ni trajni izbris. Ročno brisanje datotek ali zagon čiščenja ni diagnostični korak.
- **Rdeče opozorilo o kopiji:** loči čas obvestila od časa dejanskega zagona. Preveri `systemctl list-timers --all indus-ure-backup.timer`, `systemctl show indus-ure-backup.service -p Result` in `journalctl -u indus-ure-backup.service --since yesterday --no-pager`. Pri `getaddrinfo EAI_AGAIN` pri Googlu preveri DNS na strežniku; to samo po sebi ne dokazuje okvare baze ali preklica OAuth. Lokalni arhiv še ni uspešna kopija na Drive: preveri rezultat istega zagona, velikost, kontrolne vsote in ponovno branje iz Drive.
- **Če aplikacije ni mogoče zagnati:** za branje poslovnih evidenc sta v recovery paketu in v zasebni recovery mapi Drive `dogodki.csv` in `vpisi-ur.csv`. Primerjaj ID kopije obeh izvozov. CSV ni polna obnova: ne vsebuje samih slik ali celotne zgodovine. Za obnovo sledi `RESTORE-INDUS-URE.txt` iz izbranega arhiva; najprej v prazno, ločeno bazo in medijsko mapo.

## Pred posegom v produkcijo

Pri incidentu raje uporabi aplikacijski bralni pogled ali namensko SQL poizvedbo v transakciji `READ ONLY`. Branje ne sme shranjevati normalizacije. Shramba pri zapisu preverja revizijo celotnega posnetka; ob `409 STALE_SNAPSHOT` ponovno preberi stanje in preveri namen spremembe. Slepo ponavljanje finančnega dejanja ali neposreden SQL zapis lahko obide sledljivost in zaščito pred prepisom.

Za objavo veljajo [QA, predhodna kopija in preklop izdaje](../OPERATIONS.md#obvezni-postopek-objave-ure). Povrnitev kode in obnova podatkov sta različni odločitvi: stare kopije nikoli ne obnavljaj čez nove vpise za odpravo ene napačne potrditve. V predaji zabeleži prizadeto izdajo, ponovitev, test in kaj je bilo dejansko spremenjeno. Če se spremeni ukaz ali poslovno pravilo, popravi tudi ta priročnik; rezultate posameznih objav vodi v [OPERATIONS.md](../OPERATIONS.md).
