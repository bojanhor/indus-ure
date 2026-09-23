# Google Koledar – aktivacija 23. 9. 2026

## Vzrok in omejen popravek

Prijava in soglasje sta uspela. Neposreden pregled vseh treh namenskih
koledarjev je pokazal dve Googlovi lastniški pravici: povezani človeški račun
in tehnično identiteto koledarja (njegov lastni ID
`…@group.calendar.google.com`). Prejšnja kontrola je drugo pravico napačno
zavrnila kot dodatnega lastnika; dogodki zato še niso bili preneseni.

Izjema velja samo za pravico `owner`, obseg `user` in popolnoma isti ID
trenutnega namenskega sekundarnega koledarja. Poleg nje mora biti potrjena
lastniška pravica povezanega človeškega računa. Drug človek, drug koledar,
skupina ali domena niso izjema. Vse strani ACL se preverijo pred kakršnimkoli
spreminjanjem pravic. Pravice dejanskih dodatnih lastnikov ostanejo varovane.

Prvi dejanski preizkus po objavi `712d982` je potrdil prenos, vendar je
stroga primerjava projekcije odkrila še Googlovo preimenovanje časovnega
pasa `Europe/Ljubljana` v njegov IANA cilj `Europe/Belgrade`. Primerjava
izenači samo ta dva identifikatorja; odhodni podatki ostanejo Ljubljana.
Drugi časovni pasovi in dejanske spremembe ur se še vedno zaznajo.
S tem se prepreči ponavljajoče posodabljanje nespremenjenih dogodkov.
Regresijski test vključuje zimski/poletni čas ter dejansko spremembo ure.
IANA vir: https://www.iana.org/time-zones/releases

OAuth dovoljenja, izbor poslovnih dogodkov in obstoječi ID-ji koledarjev se
ne spreminjajo. Ni migracije poslovne baze. Povrnitev kode na `9696a69`
vrne prejšnjo kontrolo (in njeno napako); že preneseni dogodki ostanejo v
Googlu. Ob potrebi se prenos lahko izklopi v nastavitvah aplikacije.

## Preverjanje pred objavo

- Ciljni strežniški nabor: 27/27, vključno z realno obliko dvojne lastniške
  pravice, zlonamernimi/dodatnimi lastniki in večstranskim ACL.
- Celoten lokalni nabor: 285 uspešnih, ena pričakovana Windows symlink
  izpustitev, brez napak.
- Brskalniški nabor Google planiranja: 3/3 (dostop šefa/delavca, mobilni
  prikaz in varnost meja uporabnikov).

Objavo varuje obstoječi sveži preverjeni recovery backup in obvezni
PostgreSQL/restore/upgrade/rollback prehod. Po objavi sledi dejanski pregled
Google projekcije ter ustvarjanje, sprememba in odstranitev jasno označenega
začasnega testnega dogodka; rezultati se dopišejo po preverjanju.

## Končni rezultat

Objavljena končna izdaja `7f00768` (predhodni ACL popravek `712d982`, izvorna
produkcija `9696a69`). Točna končna izdaja je na Linuxu prestala vseh 287
testov in 20 PostgreSQL/restore/upgrade/rollback preverjanj. Ciljni nabor
Google planiranja ima 28 uspešnih testov. Pred vsako objavo je narejena
preverjena zaščitena kopija; zadnja je
`indus-ure-recovery-20260923T035942Z.tar.gz`, končana ob 04:00:11 UTC.
Vseh pet preverjanj arhiva/Drive/navodil je uspešnih.

Dejanski Google preizkus je bil uspešen:

- Skupni koledar: 12 dogodkov, Bojan: 11, Ibro: 1.
- Vsi ključi in vsebine dogodkov se ujemajo s trenutno projekcijo aplikacije;
  ni podvojenih ključev, vpisov ur ali materiala.
- Začasni test se je pojavil samo v skupnem in Bojanovem koledarju (2 zapisa).
  Sprememba naslova, ure in statusa je posodobila ista ID-ja (2 posodobitvi).
  Odstranitev je izbrisala oba (2 izbrisa); neposredno branje potrdi izbris.
- Ponovni prisilni prenos brez sprememb: 0 zapisov v Google dogodke.
- Pravice preverjene za vse koledarje: povezani lastnik in Googlova
  tehnična identiteta; ostali predvideni prejemniki imajo izključno branje.
- Test je uporabljal sveže bralne posnetke in začasno projekcijo v pomnilniku,
  obstoječi svetovalni zaklep pa je preprečil vzporedni sinhronizator.
  Ni klical shranjevanja poslovne baze, ustvarjal dejanskih opravil ali
  spreminjal ur/obračunov. Poslovna aplikacija je ostala dostopna.
- Končni status: omogočeno, 0 napak, prazno sporočilo napake, zadnji uspeh
  23. 9. 2026 ob 04:00:44 UTC. Obe aplikaciji aktivni, health uspešen,
  javna stran HTTP 200, brez opozoril Ure v zadnjih petih minutah.

Zaključena aktivacija je odstranjena iz skupnega Google TODO z varovalom
revizije. Vsebina od »TOLE ŠE PUSTI PRI MIRU« naprej (vključno z novimi
uporabnikovimi dopolnitvami in obema slikama) ostaja ohranjena.

Za prikaz v svojem Googlu uporabnik v nastavitvah aplikacije odpre
»Google Koledar — planiranje« in pri želenem koledarju »dodaj / odpri«.
Google prijave ni treba ponavljati. GitHub ni bil posodobljen.
