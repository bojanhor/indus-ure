# Izbira stranke brez klika skozi seznam

## Vzrok in popravek

Izbirnik je izbral stranko in skril seznam že na `pointerdown`. Element pod
seznamom je bil tako razkrit še med isto gesto. Preizkus stare kode je
potrdil prezgodnje zapiranje med držanjem in izbiro tudi ob preklicani
gesti (`pointercancel`). Drsenje zato ni smelo uporabljati iste začetne
obdelave kot potrjena izbira.

Izbira zdaj poteka na `click`, po končanem pritisku. `mousedown` zgolj ohrani
fokus vnosa; dotik in drsenje nista preprečena. `focusout` zapre seznam le,
ko fokus zapusti celoten izbirnik; prejšnjega 120-ms časovnika ni več.
Po tipkovnični izbiri se fokus vrne v vnos pred končnim zaprtjem seznama.
Predlogi se med pritiskom ne pomanjšajo: preizkus roba širokega gumba je
pokazal, da je transformacija `scale(.94)` prestavila rob izpod kazalca in
preprečila pravilno izbiro.

Ni globalnega zaviranja klikov ali spremembe poslovnih podatkov. Naslednji
namerni klik na delavca mora še vedno delovati. Svinčnik za urejanje stranke
in tipkovnična izbira ostajata podprta.

## Preverjanje

Novi izolirani testi dejansko postavijo pritisk na predlog NAD kljukico
delavca in preverijo stanje vseh kljukic/radijskih gumbov pred in po izbiri.
Pokrivajo mobilno in namizno širino, držanje tipke miške, pravi dotik,
preklicano pointer gesto, pomikanje seznama, Enter na možnosti,
puščice/Enter v vnosu, izhod iz izbirnika in naslednji namerni klik na
delavca. Regresijski sklop preverja še svinčnik in ohranitev osnutka.
Testne stranke obstajajo samo v izolirani lokalni aplikaciji.

Interaktivni brskalnik je dodatno vizualno preveril izbiro testne stranke
brez obkljukanja delavcev. To ni fizični preizkus na iPhonu ali Androidu.

Končni rezultati: 268/268 programskih testov, 59/59 celotnega Chromium
sklopa in 9/9 ciljnih WebKit testov. Strežniški kandidat `00dee4c` je ponovno
prestal 268/268 testov ter vseh 19 PostgreSQL/restore/upgrade/rollback
preverjanj; preizkušena prejšnja izdaja je `80edb98`.

## Objava in povrnitev

Običajna varovana objava zahteva programske/brskalniške teste,
PostgreSQL/restore/upgrade/rollback QA ter uspešno zasebno recovery kopijo.
Podatkovne migracije ni. Prejšnja produkcijska izdaja je `80edb98`;
povrnitev samo kode ne zahteva obnove poslovne baze.
Fakture, Nginx, OAuth in GitHub push niso del posega.

Izdaja `00dee4c` je objavljena 22. 9. 2026. Predhodna recovery kopija je
uspešno končana ob 12:58:30 UTC (`Result=success`, `ExecMainStatus=0`).
Po preklopu sta obe storitvi aktivni, Ure health vrne `ok: true`, javni
naslov HTTP 200 in vse štiri preverjene spremembe izbirnika. V dnevniku
storitve po objavi ni opozoril. Ob preverjanju je na korenskem disku še
2,2 GiB prostega prostora (93 % zasedenost); čiščenje ni bilo del tega posega.
