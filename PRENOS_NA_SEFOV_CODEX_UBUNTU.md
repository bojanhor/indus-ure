# INDUS URE - navodila za prenos na sefov Codex racun in Ubuntu streznik

Ta dokument prilepi oziroma nalozi v sefov Codex racun, da bo novi Codex takoj razumel projekt in ga lahko postavi na Ubuntu streznik.

## Kaj je projekt

INDUS URE je spletna aplikacija za Bojana in Ibra:

- koledar delovnih vnosov po dnevih
- vnos ur od-do, stranke, kilometrov, materiala, opomb in sodelavcev
- statusi: ze obracunano, garancija, opravljeno/ni obracunano, opravki/pot/malica, dopust
- opravila po strankah, tudi brez datuma ali s fiksnim datumom
- fotografije pri posameznem opravilu
- iskanje strank in pregled vseh del/opravila za stranko v izbranem obdobju
- mesecni obracun z Excel izvozom
- Google prijava samo za dovoljena uporabnika
- Google Calendar sync loceno po uporabniku

Uporabnika:

- Bojan: `bojan@indus.si`, vloga `boss`
- Ibro: `ibrahim.etemaj04@gmail.com`, vloga `worker`

Pravila:

- Bojan vidi in ureja vse.
- Ibro vidi vnose v koledarju, ampak naj zgoraj vidi samo svoj seštevek ur.
- Ibro ne sme urejati Bojanovih vnosov.
- Dopust se ne steje v ure.
- Opravki/pot/malica nimajo stranke.
- Malica in prekrivanje ur se ne sestevata dvojno; ure se racunajo po unikatnih intervalih na dan.

## Kje je koda

GitHub repo:

```text
https://github.com/ibrahimetemaj04-art/indus-ure.git
```

Glavni datoteki:

```text
outputs/server.js
outputs/index.html
```

Projekt je trenutno navaden Node.js HTTP server brez frameworka.

Zagon lokalno:

```bash
npm start
```

Privzeti port:

```text
8123
```

## Trenutne pomembne funkcije

### Koledar

- Klik na plus pri dnevu odpre dialog za vnos.
- Status `Dopust` obarva cel dan in se ne steje v ure.
- Status `Opravki` je za pot/malico in nima stranke.
- Pri vnosu je polje `Racun poslan` / `Racun ni poslan`.

### Opravila

- Opravilo ima lahko datum ali je brez datuma.
- Opravilo s fiksnim datumom se prikaze v koledarju.
- Pri opravilu se lahko dodajo fotografije.
- Fotografije niso locen splosen zavihek; prikazejo se pri konkretnem opravilu.

### Stranke

- Stranke se iscejo iz:
  - uvozene baze strank
  - vseh preteklih vnosov
  - vseh opravil
- Klik na stranko v search odpre pregled stranke/obracun.
- V pregledu stranke se lahko nastavi datum `Od` in `Do`.

### Obracun

Obracun trenutno racuna:

- Ibro ure x 15 EUR
- za vsak Ibro delovni dan dodatno 2 x 14 km = 28 km
- vpisani km + dodatni km
- kilometrina x 0,22 EUR
- doda Bojan dolg
- odbije Ibro dolg
- izvoz v Excel `.xls`

Pomembno: za "delovni dan" pri Ibru se steje dan, kjer ima Ibro delovni vnos, ki ni dopust in ni opravki.

## Cilj za Ubuntu streznik

Zelimo, da aplikacija deluje na sefovem racunalniku z Ubuntu kot pravi lokalni/produkcijski streznik:

- Node.js aplikacija tece kot systemd service
- PostgreSQL baza je lokalno na tem Ubuntu strezniku
- Nginx dela reverse proxy
- podatki se ne shranjujejo vec na Render/Neon
- vsak dan se naredi backup PostgreSQL baze
- po zelji se kasneje doda domena ali lokalni DNS

## Kaj naj bo pred-namesceno na Ubuntu

Minimalno:

```bash
sudo apt update
sudo apt install -y git curl ca-certificates nginx postgresql postgresql-contrib
```

Node.js LTS:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Priporoceno:

```bash
sudo apt install -y ufw unzip
```

## Postavitev kode

Primer lokacije:

```bash
sudo mkdir -p /opt/indus-ure
sudo chown -R $USER:$USER /opt/indus-ure
cd /opt/indus-ure
git clone https://github.com/ibrahimetemaj04-art/indus-ure.git .
npm install --omit=dev
```

Ce `package.json` nima dependencyjev, je `npm install` vseeno OK.

## PostgreSQL baza

Ustvari uporabnika in bazo:

```bash
sudo -u postgres psql
```

V PostgreSQL konzoli:

```sql
CREATE USER indus_ure WITH PASSWORD 'ZAMENJAJ_TO_GESLO';
CREATE DATABASE indus_ure OWNER indus_ure;
\q
```

Connection string bo:

```text
postgresql://indus_ure:ZAMENJAJ_TO_GESLO@127.0.0.1:5432/indus_ure
```

Pomembno: geslo naj bo dolgo in naj ne ostane ta primer.

## Environment datoteka

Ustvari:

```bash
sudo nano /etc/indus-ure.env
```

Vsebina:

```env
PORT=8123
HOST=127.0.0.1
DATABASE_URL=postgresql://indus_ure:ZAMENJAJ_TO_GESLO@127.0.0.1:5432/indus_ure

GOOGLE_CLIENT_ID=VSTAVI_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=VSTAVI_GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI=https://TVOJA-DOMENA/api/google/callback
GOOGLE_SHEETS_ID=VSTAVI_ID_GOOGLE_SHEETS_DATOTEKE
GOOGLE_SHEETS_RANGE=Stranke!A:B
```

Ce bo najprej delovalo samo lokalno brez domene:

```env
GOOGLE_REDIRECT_URI=http://IP_STREZNIKA:8123/api/google/callback
```

Za sync strank z Google Sheets mora imeti Google Sheet zavihek `Stranke` in stolpca:

```text
Naziv stranke | Search
```

`GOOGLE_SHEETS_ID` je del URL-ja Google Sheeta med `/d/` in `/edit`.

Za Nginx/domeno je bolje uporabiti HTTPS domeno.

Zakleni pravice:

```bash
sudo chmod 600 /etc/indus-ure.env
```

## Google OAuth

V Google Cloud mora biti OAuth client nastavljen na URL streznika.

Authorized redirect URI mora biti tocno:

```text
https://TVOJA-DOMENA/api/google/callback
```

ali za lokalno testiranje:

```text
http://IP_STREZNIKA:8123/api/google/callback
```

Ce se domena spremeni, je treba spremeniti:

- Google Cloud OAuth redirect URI
- `/etc/indus-ure.env` vrednost `GOOGLE_REDIRECT_URI`
- restart service

## Systemd service

Ustvari:

```bash
sudo nano /etc/systemd/system/indus-ure.service
```

Vsebina:

```ini
[Unit]
Description=INDUS URE web app
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/indus-ure
EnvironmentFile=/etc/indus-ure.env
ExecStart=/usr/bin/node /opt/indus-ure/outputs/server.js
Restart=always
RestartSec=5
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

Pravice:

```bash
sudo chown -R www-data:www-data /opt/indus-ure
sudo systemctl daemon-reload
sudo systemctl enable indus-ure
sudo systemctl start indus-ure
sudo systemctl status indus-ure
```

Logi:

```bash
journalctl -u indus-ure -f
```

## Nginx reverse proxy

Ustvari:

```bash
sudo nano /etc/nginx/sites-available/indus-ure
```

Vsebina za domeno:

```nginx
server {
    listen 80;
    server_name TVOJA-DOMENA;

    client_max_body_size 20M;

    location / {
        proxy_pass http://127.0.0.1:8123;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Omogoci:

```bash
sudo ln -s /etc/nginx/sites-available/indus-ure /etc/nginx/sites-enabled/indus-ure
sudo nginx -t
sudo systemctl reload nginx
```

HTTPS:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d TVOJA-DOMENA
```

## Firewall

Ce bo samo lokalno omrezje, odpri vsaj SSH in Nginx:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

## Backup baze

Ustvari mapo:

```bash
sudo mkdir -p /var/backups/indus-ure
sudo chown postgres:postgres /var/backups/indus-ure
```

Ustvari backup skripto:

```bash
sudo nano /usr/local/bin/backup-indus-ure.sh
```

Vsebina:

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/var/backups/indus-ure"
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"

sudo -u postgres pg_dump indus_ure | gzip > "$BACKUP_DIR/indus_ure_$STAMP.sql.gz"
find "$BACKUP_DIR" -type f -name "indus_ure_*.sql.gz" -mtime +30 -delete
```

Omogoci:

```bash
sudo chmod +x /usr/local/bin/backup-indus-ure.sh
sudo /usr/local/bin/backup-indus-ure.sh
ls -lah /var/backups/indus-ure
```

Cron:

```bash
sudo crontab -e
```

Dodaj:

```cron
15 2 * * * /usr/local/bin/backup-indus-ure.sh
```

## Obnova backupa

Primer:

```bash
gunzip -c /var/backups/indus-ure/indus_ure_YYYY-MM-DD_HH-MM-SS.sql.gz | sudo -u postgres psql indus_ure
```

Pred obnovo naj Codex/administrator ustavi service:

```bash
sudo systemctl stop indus-ure
```

Po obnovi:

```bash
sudo systemctl start indus-ure
```

## Migracija podatkov iz trenutnega Render/Neon okolja

Treba je ugotoviti, kje so zadnji pravi podatki:

1. Ce Render trenutno uporablja PostgreSQL `DATABASE_URL`, naredi dump iz stare baze.
2. Ce uporablja lokalno datoteko v Render containerju, podatki niso zanesljivi in jih je treba izvoziti iz aplikacije z gumbom backup, ce je se dostopno.
3. Aplikacija ima gumb za prenos varnostne kopije JSON, ampak za popolno migracijo na Postgres je bolje uporabiti obstojece mehanizme v `server.js`, ce so podatki ze v Postgres.

Codex naj preveri v `outputs/server.js`:

- kako deluje `DATABASE_URL`
- ali ima `ensurePostgresDb`
- kako se podatki mapirajo v `db.entries`, `db.todos`, `db.clients`, `db.debts`, `db.users`

Ce je treba, naj naredi enkratno migracijsko skripto iz JSON backupa v Postgres.

## Pomembna opozorila za Codex

- Ne brisi podatkov.
- Ne delaj `git reset --hard`.
- Pred migracijo naredi backup.
- Pred spremembo baze naredi `pg_dump`.
- Ce spreminjas shemo, mora `normalizeDb` ostati kompatibilen s starimi podatki.
- Aplikacija trenutno veliko logike drzi v `outputs/index.html`, zato naj se spremembe delajo previdno.
- Slike so trenutno shranjene kot base64 v podatkih opravil. To je OK za zacetek, ampak za veliko slik bo treba kasneje narediti upload mapo ali objektno shrambo.

## Hitri test po postavitvi

```bash
curl -I http://127.0.0.1:8123/
sudo systemctl status indus-ure
journalctl -u indus-ure --no-pager -n 80
```

V brskalniku preveri:

1. odpre se INDUS URE
2. Google prijava dela
3. prijavi se Ibro
4. prijavi se Bojan
5. dodaj testno stranko
6. dodaj testni vnos
7. dodaj testno opravilo
8. dodaj fotografijo pri opravilu
9. iskanje stranke naj odpre pregled stranke
10. obracun naj naredi Excel izvoz
11. restart serverja:

```bash
sudo systemctl restart indus-ure
```

12. preveri, da podatki ostanejo po restartu

## Kaj je naslednje po migraciji

Priporocene izboljsave:

- prava tabela za fotografije/datoteke namesto base64 v JSON podatkih
- boljsi PDF obracun
- bolj natancna pravila pravic po vlogah
- administracija strank v posebnem zavihku
- avtomatski off-site backup na zunanji disk ali cloud
- monitoring, da se vidi, ce app pade
