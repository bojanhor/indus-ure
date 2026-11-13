# Lokalna testna instanca

Testna aplikacija je ločena od produkcije in je namenjena dejanskim pregledom v brskalniku: `http://192.168.50.242:8124`.

Uporablja svojo PostgreSQL bazo `indus_ure_test`, svojega sistemskega uporabnika `indus-ure-test`, svojo mapo prilog `/var/lib/indus-ure-test/media` in sistemsko storitev `indus-ure-test.service`. Dostopna je samo iz omrežja `192.168.50.0/24`; port 8124 se ne odpira v routerju.

Google prijava za IP naslov ni uporabna, zato ta LAN instanca uporablja testno prijavo in lastno geslo v `/etc/indus-ure-test.env`. Testna uporabnika sta Bojan (šef) in Ibro (delavec). Produkcija ne uporablja tega testnega načina ali testnega gesla; ima ločeno, izrecno omogočeno osebno in podporno LAN-prijavo ([pogoji](OPERATIONS.md)). Za običajen razvoj oddaljena instanca ni potrebna.

## Prva vzpostavitev

Iz lokalnega repozitorija zaženi (geslo naj bo dolgo vsaj 16 znakov, brez presledkov):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\provision-test-instance.ps1 -TestPassword LASTNO_TESTNO_GESLO
```

Nato testno izdajo objaviš brez GitHub pusha in brez vpliva na produkcijo:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-test.ps1 -IdentityFile C:\tmp\indus-ure-deploy-key-v1-bridge\id_ed25519
```

## Priporočen potek za vsako spremembo

1. Lokalni `npm test`.
2. Objavi v testno instanco z `deploy-test.ps1`.
3. V Firefoxu preveri prijavo šefa in delavca, dodajanje/urejanje/vpis ur, koledar, priloge, drag-and-drop in ozek prikaz.
4. Če je odobrena tudi produkcijska objava, sledi [operativnemu postopku](OPERATIONS.md#obvezni-postopek-objave-ure). Objava v LAN testno instanco ni dovoljenje za produkcijo.

## Avtomatiziran klik-test

Za osnovni, ponovljiv test uporabniškega toka ne uporablja produkcije ali oddaljene testne instance. Ukaz spodaj sam zažene kratkotrajni strežnik na `127.0.0.1`, s prazno začasno bazo in z lokalno testno prijavo; po testu proces in podatke izbriše.

```powershell
npm.cmd run test:e2e
```

Prvič je treba namestiti brskalnik, ki ga uporablja Playwright:

```powershell
npx.cmd playwright install chromium firefox
```

Chromiumov nabor vključuje tudi opravila, obračune, koledar in osnutke. Za pregled z odprtim oknom uporabi `npm.cmd run test:e2e:headed`; ločeni `npm.cmd run test:e2e:firefox` izvede izbrane regresije. Za ročni ogled brez oddaljene instance glej [hiter lokalni zagon](docs/RAZVIJALSKI-PRIROCNIK.md#lokalna-ponovitev).

Za pregled stanja na strežniku:

```bash
sudo systemctl status indus-ure-test.service --no-pager
curl --fail http://192.168.50.242:8124/api/health
```

Testnih podatkov ne uporablja nobena produkcijska storitev, backup ali Google povezava. Če je potrebna popolna ponastavitev, najprej ustavi testno storitev, ponovno ustvari samo bazo `indus_ure_test` in izprazni samo `/var/lib/indus-ure-test`.
