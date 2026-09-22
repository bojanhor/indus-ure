# Vpis ur iz obstoječega opravila

Uporabnik je naročil vpis ur pri smiselnih statusih obstoječih opravil.
Izrecno je potrdil, da »Poračunaj« ostane brez te možnosti.

## Pravila

Omogočeno: Čaka, V teku, Razno/Interno, Naroči-projekt, Naroči Avto,
Naroči Sklad., Dodaj v avto, Vrni in Vrne naj.

Izključeno: Poračunaj, Zapisek, Material in časovni vpisi Zaključeno,
Malica, Vožnja ter Nabava. Neznani statusi niso dovoljen izvor.
Enak izrecni seznam velja za ikono, spodnji gumb in validacijo strežnika;
regresijski test preverja ujemanje seznamov. Pravice do opravila, izvajalca,
zaklepi in preverjanje stranke ostajajo nespremenjeni.

Vpis ur nastane kot ločen zapis s `sourceProjectTodoId` in zgodovinskim
naslovom izvora. Ne pretvori izvornega opravila v vpis ur in samodejno ne
spremeni njegovega statusa, naročenosti, opisa, materiala ali datuma.
Obstoječe vprašanje po shranjevanju ostaja: opravilo obdržati ali zaključiti.

## Dodatna napaka, dokazana pri testu iste poti

`openHoursTodoFromCurrent()` je po `dialog.close()` čakal samo `setTimeout(0)`.
Dejanski `close` dogodek se je lahko zgodil za ponovnim odprtjem obrazca in
izbrisal novi `todoHoursSourceId` (ter stanje priponk). Test dejanskega klika
in POST je pokazal prazen `sourceProjectTodoId` že pri statusu Čaka.
Prehod zdaj čaka dejanski `close` dogodek, preden pripravi novi obrazec.

## Preverjanje in objava

Novi brskalniški scenariji za vseh devet statusov preverijo zgornji in spodnji
gumb, realni POST, povezavo, izvajalca, stranko in nespremenjen izvor;
izključene statuse preverijo ločeno. Mobilna in namizna širina, Chromium
in WebKit; osnovni testi preverjajo še tuja in izbrisana opravila.

Objava zahteva običajne teste, PostgreSQL/restore/upgrade prehod in preverjeno
varnostno kopijo. Podatkovne migracije ni. Povrnitev kode na prejšnjo izdajo
`43c1994` znova skrije nove statuse, že shranjene povezave pa ostanejo veljavne:
strežnik pri urejanju obstoječega vpisa ohrani zgodovinski izvor ne glede na
njegov trenutni status. Poslovne baze se ob povrnitvi ne obnavlja.
Fakture, Nginx, aktivacija Google Calendar in GitHub push niso del posega.

Lokalni končni rezultat: 268/268 programskih testov, 56/56 celotnega
Chromium brskalniškega sklopa in 5/5 ciljnih WebKit preizkusov (statusi ter
regresija prikaza vnosa ur na ozkem zaslonu). V interaktivnem testnem
brskalniku je bil vizualno preverjen omogočen gumb pri Naroči-projekt.
Preizkusi so uporabljali izolirane sintetične podatke, ne poslovne baze.
