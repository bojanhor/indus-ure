# Postopna razdelitev monolita – prva povrnljiva faza

Uporabnik je 15. 9. 2026 dovolil doslej odloženo točko 4 in objavo z možnostjo
povrnitve. Osnova delovne kopije: `5b1d396`; predhodna produkcijska koda:
`07f7690`. Ta poseg ne vključuje drugih TODO funkcij ali mobilnega PDF prenosa.

## Izvedeni obseg

| Modul | Odgovornost | Izločene funkcije |
|---|---|---:|
| `outputs/payroll-rules.js` | Obdobja, vrstice, malica, dnevni prevoz, seštevki in posnetki obračunov | 22 |
| `outputs/storage.js` | JSON/PG dostop, življenjski cikel povezav, predpomnilnik zahteve, normalizacijska migracija | 13 |
| `outputs/attachment-model.js` | Formati, omejitve, identiteta, začasno lastništvo in metapodatki prilog | 17 |
| `outputs/editor/time-entry.js` | Ura/minuta, trajanje, zapomnjena ura in neodvisne ure za stranko | 17 |

Moduli imajo izrecno podane odvisnosti in ne uvažajo `server.js` nazaj.
Strežnik ohrani HTTP usmerjanje, avtentikacijo, mutacijsko vrsto in orkestracijo.
`outputs/postgres-store.js`, shema baze, API poti, pravice in oblikovanje
poslovnih podatkov so nespremenjeni. To ni popolna razdelitev celotne aplikacije:
urejevalnik dogodkov, potrjevanje obračunov, Undo in omrežni tokovi prilog še
ostajajo kandidati za naslednje majhne, ločeno preverjene korake.

## Uporabniški vmesnik in zmogljivost

`outputs/app-shell.js` vstavi znani lokalni modul urejevalnika v obstoječo
inline skripto pred dodajanjem CSP nonce. Dodatnega omrežnega zahtevka, dinamičnega
uvoza ali čakanja ob prvem kliku ni. Dovoljen je natanko en vnaprej določen
marker; ni poljubnega vključevanja datotek. Izvorne datoteke niso nove javne poti.
Napaka sestavljanja vrne HTTP 500 in se zabeleži. Dostop do lokalne shrambe
ostane len in znotraj obstoječe obravnave napak.

## Preverjanje

- Primerjava izločene kode z `5b1d396`: vseh 69 funkcij dobesedno ohranja
  izvorno telo (ob poenotenih koncih vrstic); PostgreSQL mehanizem je nespremenjen.
- 215 lokalnih strežniških/enotskih testov uspe, od tega 9 novih testov modulov.
- 40 izoliranih Playwright testov uspe: ure, prikaz, vloge, priponke, poročila,
  PDF, obračuni, Undo, hitro odpiranje in zavrnitev ur brez stranke.
- Testni strežniki so omejeni na štiri sočasne procese. Test ročnega vrstnega
  reda bere shranjeno stanje prek API namesto sredi pisanja testne JSON datoteke.
- Pred objavo: obvezni strežniški PostgreSQL/restore testi, nadgradnja kopije
  produkcije in dodatni preizkus stare kode nad nadgrajeno kopijo.
- Po objavi: zdravstveni pregled storitev, dnevniki in vizualni pregled v
  produkcijskem brskalniku brez spreminjanja poslovnih podatkov.

## Povrnitev samo kode

Predhodno izdajo `/opt/indus-ure/releases/07f7690` in njeno QA dokazilo obdrži.
Po potrebi na strežniku zaženi:

```sh
sudo /usr/local/sbin/deploy-indus-ure 07f7690
```

Ukaz preveri vsebino izdaje, naredi novo varnostno kopijo trenutnih podatkov,
preklopi povezavo `current`, znova zažene Ure in preveri zdravje. Baze in prilog
NE vrača na starejši čas. Ta prejšnja izdaja že vsebuje CAS varovalo.
Če obvezna kopija ne uspe, objava/povrnitev z razlogom obstane; ne obidi varovala.
Za ponovno objavo nove kode uporabi isti ukaz z oznako nove izdaje.
Ne zaganjaj celotnega `deploy.ps1` samo zaradi povrnitve; ne spreminjaj Faktur
ali skupne Nginx konfiguracije. Ne briši predhodne izdaje.

## Dokazila o objavi

- Objavljena izdaja: `64ad819`, 15. 9. 2026 ob 17:05 po lokalnem času.
  Refaktor je v commitu `9352c45`, dopolnjen test povrnitve v `64ad819`.
- Arhiv kode SHA-256:
  `0be7fa422f4d4b0e0e34486f01f8274f35a1a33ebd2d6e3a60859b7de67542cb`.
- Strežniški prehod: 215/215 testov in 16/16 PG preverjanj (12 osnovnih,
  2 obnovi, nadgradnja produkcijske kopije, povrnitev/ponovni prehod).
  Dokazila: `/var/lib/indus-ure/qa/64ad819.*`.
- Pri prvem novem rollback testu se je pokazalo, da surovi PG zapis in
  normalizirani pogled nimata vedno enake oblike. Star in nov normalizirani
  pogled sta bila enaka; test zdaj primerja oba normalizirana pogleda in nato
  še vse poslovne vrstice po zapisu z vsako različico. Testno varovalo ni obito.
- Recovery: `backup-20260915T150505Z-7d91cda7`, datoteka
  `indus-ure-recovery-20260915T150505Z.tar.gz`, 188.236.565 bajtov.
  SHA-256: `9202b7ec386c799c71a25c01b609ec51bacc619dc831cc56a4e01af4c215d640`.
  Preverjeno: lokalni arhiv, Drive velikost, MD5, sveže branje metapodatkov in
  navodila za obnovo. Arhiv vsebuje predhodno produkcijsko kodo in podatke.
- Produkcija: Ure in Fakture aktivni, oba health odgovora uspešna. Po objavi
  brez opozoril storitve Ure. Prejšnja izdaja `07f7690` in skladno QA dokazilo
  sta ohranjena; rollback ni destruktivna obnova baze.
- Vizualno v produkciji: odprto obstoječe opravilo, prikazana fotografija,
  odprt obračun Ibra, seznam in podrobnosti obračuna stranke. Krožni izbirnik
  uspešno preide od ure na minute, nato na končno uro in se po končni minuti
  zapre; pravilno prikaže 1 h 15 min. Nov obrazec je zavržen brez shranjevanja.
  Poslovnih vnosov in obračunov med preizkusom nismo spreminjali ali potrjevali.
  Brskalnik je vrnjen v šefovski pogled Opravila.
