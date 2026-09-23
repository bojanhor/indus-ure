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
