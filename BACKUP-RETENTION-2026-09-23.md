# Samodejna hramba recovery kopij

Uporabnik je potrdil eno lokalno kopijo na dan za zadnjih 7 dni in zadnje
3 kopije pred objavami, čiščenje šele po novi lokalno in na Drive preverjeni
kopiji. Obstoječa 90-dnevna hramba na Drive se ne spreminja.

Pred posegom: 49 arhivov, 7,61 GiB (imenik po `du` približno 7,7 GiB),
korenski disk 93 % zaseden, približno 2,1 GiB prostega prostora.

## Varnost in delovanje

- Koledarski dnevi so po Europe/Ljubljana, tudi ob prehodu na zimski čas.
- Kopije pred objavami imajo ločeno `.deployment.json` oznako. Nočni
  backup tako ne izrine pravega pre-deploy checkpointa.
- Nov deploy počaka na obstoječ backup, zahteva novega, preveri uspeh in
  SHA-256 ter ga označi pred preklopom izdaje. Ob naslednjem uspešnem
  backupu se presežno število checkpointov zniža na 3 (začasno so lahko 4).
- Vedno ostanejo vsaj 3 razpoložljive popolne kopije. Vse ohranjene se
  preverijo s SHA-256 pred prvim brisanjem; nova mora imeti tudi dokazila
  prenosa in preverjanja arhiva/kontrolne datoteke/navodil na Drive.
- Brišejo se samo prepoznani popolni arhivi ter njihove kontrolne datoteke
  in oznake neposredno v namenski backup mapi. Ročne kopije, podmape,
  nepopolne kopije, neznane datoteke in simbolne povezave se ne čistijo.
- Sočasne backupe prepreči PostgreSQL advisory lock; sočasno označevanje
  in čiščenje ločen datotečni zaklep; sočasne objave `flock`.
- Pokvarjene kontrolne datoteke, arhivi ali oznake ustavijo čiščenje.
  Ob napaki ostane obstoječe opozarjanje v aplikaciji/e-pošti.
- Ni novega schedulerja: uporablja se obstoječi dnevni systemd backup
  in backup pred objavo. Nova pravila se uporabijo ob vsakem uspešnem zagonu.

## Uvedba in povrnitev

Pred prvim čiščenjem je treba označiti tri potrjene pre-deploy kopije iz
22. 9. 2026: `20260922T123425Z` (izdaja `43c1994`), `20260922T124622Z`
(`80edb98`) in `20260922T125803Z` (`00dee4c`). Njihov uspeh je potrjen v
predhodnih zapisnikih objav; označevanje ponovno preveri lokalni SHA-256.
Objava tega popravka doda svoj novi pre-deploy checkpoint.

Objaviti je treba preverjeni kandidat in preverjeno različico root helperja
`/usr/local/sbin/deploy-indus-ure`; stari helper ohraniti za povrnitev.
Po objavi sprožiti običajni backup service. Ta ustvari in preveri svežo
kopijo ter izvede prvo čiščenje; zasebnih poverilnic se ne izpisuje.

Prejšnja produkcijska koda je `00dee4c`. Povrnitev kode ne potrebuje obnove
baze; očiščenih lokalnih arhivov ne vrne (na Drive ostanejo po obstoječem
90-dnevnem pravilu). Pred povrnitvijo stare backup kode brez oznak kopij
je treba obravnavati tudi root deploy helper in pravilo hrambe.
Fakture, Nginx, Google OAuth, poslovni podatki in GitHub push niso del posega.

## Preverjanje

11 novih testov pokriva koledarsko hrambo, DST, varnostni minimum, napačne
nastavitve, neveljavno/odsotno/staro dokazilo prenosa, idempotentnost,
pokvarjeno ohranjeno kopijo, checkpoint rotacijo, označevanje, sporne
zaklepe, oznake, simbolne povezave ter povezavo z deploy postopkom.
Windows ne omogoča navadnemu procesu ustvariti testnih simbolnih povezav;
ta test je tam izpuščen, na Linux kandidatu pa obvezen.
