# Varnostno vzdrževanje — 23. 10. 2026

Objavljena revizija: `4e92712f4cf3264f8a2c5ff56556f1036e6e5fbe`.

- Nodemailer 9.1.1 → 10.2.1; brace-expansion 2.1.4 → 2.1.7.
- Produkcijski Node.js posodobljen na 24.22.1, zlib1g na
  `1:1.3.dfsg+really1.3.1-1ubuntu3.2`.
- Lokalni regresijski testi: 337 uspešnih, 1 Linux-only preskok.
- Ubuntu regresije: 338/338. PostgreSQL QA: 26 preverjanj in uspešen restore.
- Chromium: 111/111; Firefox: 19 uspešnih, 1 preskok.
- Preverjeni dejanski funkciji opozorilne pošte z nadomestnim transportom;
  test ni pošiljal prave pošte.
- Objava prek obstoječega postopka po preverjenem offsite backupu.
- Po objavi: storitev aktivna, notranji health uspešen, javna stran HTTP 200.
- `npm audit --omit=dev` v objavljeni izdaji: 0 znanih ranljivosti.

Spremembe so omejene na odvisnosti; poslovna logika in podatkovna shema
ostajata nespremenjeni. Varnostni pregled odvisnosti ni celovit pentest.
