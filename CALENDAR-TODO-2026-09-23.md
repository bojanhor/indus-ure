# Koledar – TODO 23. 9. 2026

## Obseg

- Šefovski koledar ima ob kljukici »Prikazuj tudi zaključene« izbor izvajalca.
  Privzeto pokaže vse, vključuje tudi delavce brez prijave (zunanje izvajalce).
  Enak, sinhroniziran izbor je tudi na vrhu dnevnega pregleda; ob neshranjenih
  spremembah časovnice filter opozori in počaka na shranitev ali preklic.
  Filter velja za mesečni prikaz, dnevni pregled in označevanje dopustov.
  Skupni dogodek ostane prikazan enkrat in je viden pri vsakem svojem izvajalcu.
  Izbira se lokalno ohrani po osvežitvi; ne omejuje delavskih pogledov,
  obračunov, seznama opravil ali Google projekcije koledarja.
- Pri dogodkih v šefovskem mesečnem prikazu je izvajalec ob času; v dnevnem
  prikazu je pred imenom stranke. Dolga/skupna imena se prelomijo v novo vrstico.
- »Datum od« in »Datum do« v urejevalniku kažeta tričrkovni dan v tednu.
  Oznaki sledita ročnim spremembam, gumbom za premik datuma, praznjenju datuma
  in zaklepu vpisa ur na isti dan. Izračun uporablja lokalni datum, ne UTC.
- Dnevni gumb preklaplja med 15-urnim in 24-urnim pogledom; napis kaže naslednji
  pogled (»24h« oziroma »15h«). Celoten dan se prilega tudi nižjemu mobilnemu
  pogledu. Odstotek povečave je odstranjen; gumba imata ikoni lupe z minus/plus.

## Preverjanje in varnost

Nova brskalniška testa preverjata zunanjo osebo brez prijave, skupno opravilo,
vpis ur, preklop na delavski pogled, osvežitev in trajanje izbire, pravice
delavca, časovni pas/prehod na zimski čas, gumbe datumov in mobilno orodno vrstico.
Preverjanje poteka na izoliranih testnih podatkih, tudi v WebKitu.

Sprememba ne uvaja migracije in ne spreminja poslovnih zapisov. Povrnitev na
prejšnjo izdajo `48cd3e7` vrne prejšnji prikaz; nov lokalni ključ filtra starejša
izdaja ignorira. Objavo varuje obstoječi preverjeni recovery backup in
PostgreSQL/restore/upgrade/rollback prehod.

Google Koledar ni aktiviran: ločena odprta TODO točka zahteva prijavo uporabnika,
soglasje in dejanski preizkus prenosa, spremembe ter odstranitve dogodka.

## Rezultat objave

Objavljena izdaja `9696a69`, prejšnja produkcija `48cd3e7`.

Končni preizkusi: 280/280 strežniških testov na Linuxu, celotni brskalniški
nabor 63/63; po zadnjem popravku širine izbornega polja še ciljna Chromium
2/2 in WebKit 2/2. PostgreSQL, restore, upgrade in rollback: 20/20.
Ročno preverjen filter ter preklop 15h/24h tudi v vgrajenem brskalniku,
pregledane mobilne slike obeh brskalnikov.

Preverjena predobjavna kopija `indus-ure-recovery-20260923T033603Z.tar.gz`,
končana 23. 9. 2026 ob 03:36:31 UTC. Vseh pet preverjanj arhiva in Google Drive
je uspešnih, kopija ima zaščiteno predobjavno oznako.

Po objavi: aktivna izdaja pravilna, Ure in Fakture aktivni, health `ok: true`,
javna stran HTTP 200 z obema filtroma in oznakama dni, brez starega odstotka
povečave in brez opozoril v dnevniku Ure. Poslovni podatki in Google OAuth
niso bili spreminjani. GitHub ni bil posodobljen.

Med pripravo je zmanjkalo prostora v omejenem `/tmp` (glavni disk je imel
11 GB prostih). Odstranjeni sta bili izključno lastni neobjavljeni
pripravljalni mapi, kandidat je bil ponovno sveže pripravljen in preverjen.
Po objavi je `/tmp` na 48 %. Prva različica novega testa je uporabljala napačen
gumb za zapiranje modalnega obvestila in ni čakala na prehod zavihka;
test je popravljen. Posamični starejši test direktnega branja testne JSON
datoteke ter test predlogov strank sta ob ponovitvi uspela; končni celotni
nabor ni imel napak. Produkcija uporablja PostgreSQL.

Po preverjeni objavi je iz skupnega Google TODO odstranjenih šest opravljenih
točk z njihovimi štirimi referenčnimi slikami. Odprta aktivacija Google
Koledarja in nova uporabnikova sekcija »TOLE ŠE PUSTI PRI MIRU« s celotno
vsebino od tam navzdol sta ohranjeni. Uporabnik je izrecno potrdil mejo.
Brisanje je uporabljalo preverjeno revizijo dokumenta; ponovni odčitek je
potrdil nespremenjeno vsebino obeh ohranjenih delov.
