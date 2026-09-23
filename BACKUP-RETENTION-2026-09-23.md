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

## Rezultat

Objavljena je izdaja `cc81854`. Lokalno: 278 uspešnih programskih testov,
1 zgoraj pojasnjen preskok, 0 napak; 59/59 brskalniških testov. Na Linux
kandidatu: 279/279 testov, brez preskokov, ter vseh 19 PostgreSQL,
restore, upgrade in rollback preverjanj.

Pred namestitvijo je bil stari root deploy helper preverjeno enak tistemu
v izdaji `00dee4c` in ohranjen kot
`/usr/local/sbin/deploy-indus-ure.before-retention-20260923`.
Trije prej navedeni pre-deploy arhivi so dobili preverjene oznake.
Objava je ustvarila in zaščitila novo kopijo `20260923T025945Z`.

Po objavi je običajna backup storitev ustvarila `20260923T030023Z` in jo
uspešno preverila lokalno ter na Drive. Končala je 23. 9. ob 03:00:52 UTC,
`Result=success`, `ExecMainStatus=0`; vsa dokazila preverjanja so `true`.
Čiščenje je nato odstranilo 42 lokalnih arhivov s spremljajočimi datotekami
in sprostilo 6,37 GiB. Ostalo je 9 arhivov oziroma 1,59 GiB, kar ustreza
7 dnevnim točkam in 3 checkpointom z enim prekrivanjem. Ročne kopije niso
bile spreminjane. Ponovni read-only pregled nima kandidatov za brisanje
ali nepopolnih/ignoriranih arhivov.

Na korenskem disku je po preverjanju približno 11 GiB prostega (62 %
zasedenost). Pred našim čiščenjem se je vmes prosto stanje spremenilo
z 2,1 na 5,2 GiB izven tega posega; celotne razlike ne pripisujemo čiščenju.
Naš sproščeni obseg je izmerjen v `indus_backup_runs.data.localRetention`.

Ure in Fakture sta aktivni, Ure health vrne `ok: true`, javna aplikacija
HTTP 200. Dnevnik Ure/backup po posegu nima opozoril. Dnevni backup timer
ostaja aktiven; naslednji predvideni zagon je 24. 9. 2026 okoli 02:19 po
lokalnem času. Google Drive pravilo 90 dni je nespremenjeno.
