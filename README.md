# INDUS URE

Skupna spletna aplikacija za Bojana in Ibra za ure, stranke, material, kilometrino in statuse obracuna.

## Funkcije

Aplikacija vsebuje skupni koledar delovnih ur, opravila s fotografijami, stranke,
kilometrino, material, dolgove, obracun, ICS feed ter Google Calendar/Sheets sync.

Google prijava je dovoljena samo naslovoma `bojan@indus.si` in
`ibrahim.etemaj04@gmail.com`.

## Lokalni zagon

```bash
npm install
npm start
```

Nato odpri `http://127.0.0.1:8123`.

Brez `DATABASE_URL` aplikacija uporablja lokalno razvojno JSON datoteko.
Produkcijski zagon brez PostgreSQL namenoma ni dovoljen.

## Ubuntu produkcija

Produkcija uporablja Node.js za API, lokalni PostgreSQL za podatke, Nginx kot
omejen reverse proxy ter systemd za aplikacijo in dnevne backupe.

Celotna navodila so v [DEPLOY-UBUNTU.md](DEPLOY-UBUNTU.md).

## Podatki

Razvojni podatki brez `DATABASE_URL` so v:

```text
outputs/data/db.json
```

V produkciji so podatki v PostgreSQL tabeli `app_state`. `db.json`, dumpi,
gesla in Google OAuth tokeni ne sodijo v Git.

## Preverjanje

```bash
npm test
```
