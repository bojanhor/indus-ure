# Zaključek dogovorjene razdelitve monolita (točka 4)

Nadaljevanje po uporabnikovi zahtevi, naj se točka izvede do konca in objavi
z možnostjo povrnitve. Osnova kode: `0a0677c`; predhodna produkcijska izdaja:
`64ad819`. Prvo fazo in njena dokazila ohranja `MODULARIZATION-2026-09-15.md`.
Poseg ne vključuje Faktur, Google People, novih obračunskih pravil ali
spreminjanja mobilnega načina prenosa PDF.

## Zaključen obseg

- Shranjevanje: obstoječa `storage.js` in `postgres-store.js`; CAS, ciljni
  zapisi in transakcije ostanejo nespremenjeni.
- Obračuni: `payroll-rules.js`, novi `settlement-service.js` in
  `report-service.js`; potrditve, plačila, zaklepi, arhiviranje, obstoječi
  popravki, izvozi PDF/XLSX in poročila imajo lastne module.
- Undo: `undo-service.js` vsebuje dnevnik, dovoljene popravke posnetkov in
  HTTP obdelavo. Skupna mutacijska vrsta in sistemska blokada ostajata v
  isti strežniški orkestraciji kot prej.
- Priloge: `attachment-model.js` in `attachment-transfer.js`; lastništvo,
  avtentikacija poti, sprejem tokov, obdelava slik, začasne datoteke,
  objava metapodatkov in prenos niso več v glavnem strežniku.
- Urejevalnik: `editor/task-form.js`, `task-dialog.js`, `task-save.js`,
  `drafts.js`, `edit-locks.js` in že obstoječi `time-entry.js` pokrivajo
  odpiranje, validacijo, shranjevanje, osnutke, predajo zaklepa in čas.
- Urejanje in nalaganje medijev: `editor/media-preview.js`, `media-upload.js`
  in `media-codec.js` vključujejo tudi obdelavo klikov in potez.
- Pregledi obračunov in zgodovina: `editor/worker-billing.js`,
  `client-billing.js` in `undo-history.js` vključujejo prikaz in akcije.

Dogovorjena točka 4 s tem zajema vse štiri zahtevane sklope. To ni prepis
celotne aplikacije: prijava, nastavitve delavcev, koledar in splošna navigacija
ostajajo v vstopnih datotekah. Njihova morebitna nadaljnja delitev je drugo
vzdrževalno delo, ne nedokončan del te točke.

## Pogodbe in varnost selitve

- 493 dodatnih funkcij je izločenih. Njihova sintaktična drevesa so enaka
  izvirnikom po razrešitvi izrecno podanih odvisnosti. Poslovna pravila niso
  bila prilagojena zaradi modularizacije.
- Pomožne funkcije, ki jih drugi sklopi ne potrebujejo, ostanejo zasebne.
  Javni vmesniki in odvisnosti so popisani v `outputs/module-manifest.json`.
- Moduli ne uvažajo vstopnega strežnika nazaj. Povratni klici se povežejo
  leno; skupne časovnike, zastavice in konfiguracijo povežejo izrecni
  `moduleValues` getterji/setterji. S tem ni kopij zastarelega stanja.
- Tovarniške funkcije ob sestavi ne izvajajo I/O ali posegov v DOM.
  Registracija dogodkov ostane v prvotnem vrstnem redu.
- HTTP moduli vrnejo `true` za obdelano zahtevo in `false` za neujemanje.
  Avtentikacija, obravnava napak, serializacija zapisov in HTTP statusi se
  ohranijo; ne dodajamo vzporedne poti mimo mutacijske vrste.
- Vnaprej določeni browser moduli se sestavijo v isto CSP-nonce skripto.
  Ni novih zahtevkov ob prvem odpiranju, poljubnega vključevanja datotek,
  eval ali nove javne poti do strežniške kode.
- Shema baze, poslovni podatki, ID-ji in API pogodbe so nespremenjeni.

Med preverjanjem je bila popravljena manjkajoča povezava do `IMAGE_SIGNATURES`
iz prve faze. Preverjanje izhodnih JPEG slik zdaj uporablja skupni validator;
nov regresijski test preveri tudi neveljaven izhod in neuspešen zapis.

## Preverjanje kandidata

- 234 lokalnih enotskih/strežniških testov, od tega 19 novih modulskih testov.
- Izolirani brskalniški prehod: 40 testov urejevalnika, osnutkov, prilog,
  vrtenja fotografij, obračunov, Undo, PDF/XLSX in pravic.
- Testne bralne poti preverjajo dejanske nove datoteke; obstoječi API testi
  še vedno zaganjajo pravi strežnik. Varnostne trditve niso odstranjene.
- Pred produkcijo je obvezen še PostgreSQL/restore/upgrade/rollback prehod
  na strežniku in uspešna preverjena recovery kopija.

## Povrnitev kode

Obdrži `/opt/indus-ure/releases/64ad819` in njegovo root-only QA dokazilo.
Ob potrebi na strežniku uporabi:

```sh
sudo /usr/local/sbin/deploy-indus-ure 64ad819
```

Postopek najprej preveri izdajo in naredi svežo varnostno kopijo, nato
preklopi kodo in preveri zagon. Ne obnavlja stare baze ali prilog, zato
poznejši uporabniški vpisi ostanejo. Ne obidi neuspele varnostne kopije.
Za povrnitev ne uporabljaj skupnega `deploy.ps1`, ne posegaj v Fakture
in ne odstranjuj predhodne izdaje.

Dokazila dejanske objave, končni health pregled in vizualni pregled se
dopolnijo po uspešnem zaključku produkcijskega postopka.
