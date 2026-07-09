# INDUS URE - deploy na splet

Najlazja pot za to aplikacijo je:

1. GitHub za kodo.
2. Render za javni Node.js web service.

Predlagan javni naslov na Renderju:

```text
https://indus-ure.onrender.com
```

GitHub Pages ni dovolj, ker aplikacija potrebuje Node.js streznik za prijavo, skupno bazo in shranjevanje vnosov.

## Render nastavitev - najlazje

Ker je dodan `render.yaml`, lahko na Render izberes `New` -> `Blueprint` in povezes GitHub repository. Render bo sam prebral:

- build command
- start command
- `DATA_DIR=/var/data`
- persistent disk

## Render nastavitev - rocno

V Render Dashboard izberi `New` -> `Web Service`, povezi GitHub repo in nastavi:

- Runtime: `Node`
- Build Command: `npm install`
- Start Command: `npm start`
- Environment variable:
  - `DATA_DIR=/var/data`

Ker se vnosi shranjujejo v datoteko, dodaj se persistent disk:

- Mount path: `/var/data`
- Size: najmanjsa mozna velikost je dovolj za zacetek

Render bo potem ustvaril javni HTTPS naslov, npr. `https://ime-aplikacije.onrender.com`.

## Uporabnika

- `bojan` / `bojan123`
- `ibro` / `ibro123`

Po prvem deployu naj oba v aplikaciji zamenjata geslo pod `Racun`.

## Podatki

Lokalna baza je v `outputs/data/db.json`, ampak je namenoma v `.gitignore`, da se zasebni podatki in gesla ne objavijo na GitHub.

Za prenos obstojecih lokalnih vnosov na splet jih lahko kasneje uvozimo posebej ali pa datoteko `db.json` prenesemo na streznik.
