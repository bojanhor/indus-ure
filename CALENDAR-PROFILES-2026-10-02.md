# Profili izvajalcev na karticah koledarja

Objavljena izdaja: `4d2f628`; prejšnja produkcijska izdaja: `f3b166c`.

Pred preklopom je postopek uspešno preveril lokalno in oddaljeno recovery kopijo
`indus-ure-recovery-20261002T104657Z.tar.gz` (201.642.678 bajtov) ter jo označil
kot zaščiteno kopijo za to izdajo. Povrnitev kode na `f3b166c` ne zahteva sprememb
poslovnih podatkov; združljivost je preveril obvezni rollback/forward test.
Po objavi: aktivna izdaja `4d2f628`, HTTP health OK, javno servirana nova funkcija
koledarja, obe storitvi aktivni, brez opozoril v dnevniku Ure po preklopu.

## Obseg

- Mesečna kartica: profilna slika/začetnica in ime izvajalca levo, čas desno.
- Skupna opravila v šefovskem pogledu prikažejo vsakega izvajalca posebej.
  Delavski pogled ohranja obstoječo projekcijo dodelitev in dostopne pravice.
- Brez profilne slike oziroma ob napaki slike ostane začetnica imena.
- Samodejni napis `NUJNO` je odstranjen iz naslovov kartic mesečnega koledarja,
  rdeča pasica in opis nujnosti za bralnike zaslona ostajata.
- Profil je dodan tudi začetku/naslovu večdnevnih pasic. Nadaljevanja ostajajo
  neprekinjena, brez podvajanja naslovov na vsakem dnevu.
- Oznake sprememb in obračunov ostanejo. Klik na profil odpre isti urejevalnik.
- Dostava materiala ne dobi izvajalca samo zato, ker ima ustvarjalca.
- Ni sprememb poslovnih podatkov, API-jev, pravil obračunov ali odvisnosti.

## Preverjanje

- Windows: 289 uspešnih strežniških testov, 1 pričakovan preskok symlink testa.
- Linux: 290/290; PostgreSQL 18 preverjanj, dump restore 1, recovery restore 1,
  nadgradnja in rollback/forward na izolirani kopiji produkcije 2.
- Chromium: 69/69; dodatni ciljni WebKit test: 1/1.
- Ročni pregled v brskalniku: ustvarjanje testnega skupnega nujnega opravila,
  odpiranje s kartice, prikaz pri običajni in mobilni širini.
- Preverjene slike in začetnice, dolga imena, en/več izvajalcev, brez ure,
  večdnevni dogodek, material, rdeča oznaka, ohranjene pravice in mobilni prelomi.
- Dokazi: `test-results/calendar-profile-e2e-final.log`,
  `test-results/calendar-profile-server-final-retry.log`,
  `test-results/calendar-profile-webkit.log` (lokalni testni artefakti).

## Operativne opombe

Med drugo pripravo se je napolnil RAM-disk `/tmp`. Odstranjena je bila samo
odvečna, v tej nalogi ustvarjena mapa `/tmp/indus-ure-1b9ad9a-deploy`, po
preverjanju poti in aktivne izdaje. Ponovljeni testi so uspeli. Podatkovni
disk je imel 8,2 GB prostega prostora; aplikacija je ostala odzivna.

Namestitev nespremenjenih zaklenjenih odvisnosti je javila 2 opozorili ravni
high. V tem UI posegu ni bilo posodobitev knjižnic ali nove ocene dosegljivosti
teh ranljivosti; opozorilo samo po sebi ne dokazuje izkoristljivosti.
