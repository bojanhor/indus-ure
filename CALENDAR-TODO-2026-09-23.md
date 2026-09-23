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

Bo dopolnjeno po objavi in preverjanju produkcije.
