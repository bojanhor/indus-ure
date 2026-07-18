# INDUS URE na Ubuntu strezniku

Produkcijska pot:

```text
internet -> router TCP 80/443 -> Nginx -> 127.0.0.1:8123 (Node) -> 127.0.0.1:5432 (PostgreSQL)
                                      \-> /var/lib/indus-ure/media (priloge)
```

Node port `8123` in PostgreSQL port `5432` ne odpiraj v routerju ali UFW.
Samo TCP 80 in 443 sta javna; 8081 je po potrebi samo LAN diagnostični port.

## 0. Pred preklopom

1. Začasno ustavi vnos novih podatkov za čas preklopa.
2. Naredi neodvisen pred-migracijski dump trenutne baze:

```bash
sudo -u postgres pg_dump -Fc indus_ure > /var/backups/indus-ure/pre-v2.dump
sudo sha256sum /var/backups/indus-ure/pre-v2.dump
```

3. Zasebni `age` ključ naredi **na Bojanovem računalniku**, ne na strežniku:

```bash
age-keygen -o indus-ure-recovery.agekey
age-keygen -y indus-ure-recovery.agekey > indus-ure-recovery.agepub
```

V `/etc/indus-ure.env` pride samo vsebina javnega ključa (`age1...`). Zasebni
`.agekey` shrani v dva ločena varna prostora.

## 1. Sistemske zahteve in uporabnik

```bash
sudo apt update
sudo apt install -y git nginx postgresql postgresql-contrib age tar certbot python3-certbot-nginx
sudo useradd --system --home /var/lib/indus-ure --create-home --shell /usr/sbin/nologin indus-ure || true
sudo install -d -o indus-ure -g indus-ure -m 0700 /var/lib/indus-ure/media
sudo install -d -o indus-ure -g indus-ure -m 0700 /var/backups/indus-ure
sudo install -d -o root -g root -m 0755 /opt/indus-ure/releases
```

Node.js 20 LTS ali novejši mora biti že nameščen.

## 2. PostgreSQL

```bash
sudo -u postgres createuser --pwprompt indus_ure
sudo -u postgres createdb --owner=indus_ure indus_ure
```

PostgreSQL ostane vezan na localhost. Geslo URL-kodiraj v `DATABASE_URL`; ne
zapisuj ga v Git, terminal history ali chat.

## 3. Koda in okolje

Za novo izdajo uporabi mapo z imenom Git commita; prejšnja mapa ostane za
hitri rollback kode.

```bash
cd /tmp
git clone https://github.com/ibrahimetemaj04-art/indus-ure.git indus-ure-release
cd indus-ure-release
npm ci --omit=dev
COMMIT=$(git rev-parse --short HEAD)
sudo mv /tmp/indus-ure-release /opt/indus-ure/releases/$COMMIT
sudo chown -R root:root /opt/indus-ure/releases/$COMMIT
sudo ln -sfn /opt/indus-ure/releases/$COMMIT /opt/indus-ure/current

sudo install -o root -g root -m 0600 /opt/indus-ure/current/.env.example /etc/indus-ure.env
sudoedit /etc/indus-ure.env
```

Obvezni deli `/etc/indus-ure.env`:

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=8123
PUBLIC_BASE_URL=https://ure.indus.si
MEDIA_DIR=/var/lib/indus-ure/media
DATABASE_URL=postgresql://indus_ure:URL_KODIRANO_GESLO@127.0.0.1:5432/indus_ure

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://ure.indus.si/api/google/callback
GOOGLE_DRIVE_TASKS_FOLDER_ID=1_z_1I_wX8-VR0K9rXj7BHRFwc--00Ul5
GOOGLE_DRIVE_BACKUP_PARENT_FOLDER_ID=1_z_1I_wX8-VR0K9rXj7BHRFwc--00Ul5
GOOGLE_DRIVE_OWNER_EMAIL=bojan@indus.si

AGE_RECIPIENT=age1...
BACKUP_DIR=/var/backups/indus-ure
```

Google OAuth client potrebuje redirect URL natanko
`https://ure.indus.si/api/google/callback`. Google Drive API naj bo omogočen.
Bojanova potrjena Drive mapa ostane v njegovem My Drive; aplikacija lahko v
njej ustvarja Dokumente in Preglednice, katerih lastnik je Bojan. Zunanje
Google datoteke se samo pripnejo kot povezave.

Google Sheets in Google Calendar spremenljivk **ne dodajaj**. ICS povezava je
samo bralni izvoz.

## 4. Varno odstranjevanje starih aplikacijskih Google koledarjev

Ta korak izvedi **pred prvim zagonom nove verzije**, ker nova verzija zavrže
stara Calendar dovoljenja. Skripta nikoli ne našteva ali briše osebnih
koledarjev: obravnava samo koledarje, ki so v stari bazi izrecno označeni kot
ustvarjeni z INDUS URE, nato preveri še ime in opis.

```bash
sudo systemd-run --wait --collect --pipe \
  -p User=indus-ure -p Group=indus-ure -p EnvironmentFile=/etc/indus-ure.env \
  /usr/bin/node /opt/indus-ure/current/scripts/delete-legacy-google-calendars.js
```

Preveri izpis `wouldDelete`. Če vsebuje izključno dummy aplikacijske koledarje,
izvedi dejanski korak:

```bash
sudo systemd-run --wait --collect --pipe \
  -p User=indus-ure -p Group=indus-ure -p EnvironmentFile=/etc/indus-ure.env \
  /usr/bin/node /opt/indus-ure/current/scripts/delete-legacy-google-calendars.js --confirm
```

Tako systemd prebere root-only okoljsko datoteko in jo poda samo procesu pod
uporabnikom `indus-ure`; skrivnosti se ne razkrivajo v ukazni vrstici.

## 5. Relacijska migracija in systemd

Ob prvem zagonu nova aplikacija samodejno prenese obstoječo vrstico
`app_state/main` v relacijske tabele in jo pusti nedotaknjeno kot povratno
referenco. Priloge se iz Base64 preselijo v `/var/lib/indus-ure/media`.

```bash
sudo install -o root -g root -m 0644 deploy/indus-ure.service /etc/systemd/system/indus-ure.service
sudo systemctl daemon-reload
sudo systemctl enable --now indus-ure.service
sudo systemctl status indus-ure.service --no-pager
curl --fail http://127.0.0.1:8123/api/health
```

Preveri migracijo brez poseganja v podatke:

```bash
sudo -u postgres psql indus_ure -c "select key, data from indus_meta where key = 'storage_version';"
sudo -u postgres psql indus_ure -c "select count(*) as clients from indus_clients; select count(*) as tasks from indus_tasks; select count(*) as attachments from indus_attachments;"
```

## 6. Nginx, HTTPS in firewall

Za prvo izdajo certifikata najprej uporabi bootstrap konfiguracijo, nato
končno HTTPS konfiguracijo. HTML gre skozi Node, zato se nonce za CSP ustvari
za vsako stran; slike in ikone ostanejo statične.

```bash
sudo install -o root -g root -m 0644 deploy/nginx-indus-ure-bootstrap.conf /etc/nginx/conf.d/indus-ure.conf
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 80/tcp comment 'INDUS URE HTTP redirect'
sudo ufw allow 443/tcp comment 'INDUS URE HTTPS'
sudo ufw allow from 192.168.50.0/24 to any port 8081 proto tcp comment 'INDUS URE LAN'
sudo certbot certonly --nginx --non-interactive --agree-tos --no-eff-email --email bojan@indus.si -d ure.indus.si
sudo install -o root -g root -m 0644 deploy/nginx-indus-ure.conf /etc/nginx/conf.d/indus-ure.conf
sudo nginx -t && sudo systemctl reload nginx
curl --fail https://ure.indus.si/api/health
curl -I https://ure.indus.si/
sudo certbot renew --dry-run --no-random-sleep-on-renew
```

Router:

```text
TCP 80  -> 192.168.50.242:80
TCP 443 -> 192.168.50.242:443
```

## 7. Drive in varnostne kopije

Po prvem uspešnem Google loginu se Bojan v aplikaciji v meniju poveže z Google
Drive. To ponovno potrdi ožje dovoljenje `drive.file`; Calendar in Sheets
nista zahtevana.

Nato namesti nočni recovery backup:

```bash
sudo install -o root -g root -m 0755 deploy/indus-ure-backup /usr/local/sbin/indus-ure-backup
sudo install -o root -g root -m 0644 deploy/indus-ure-backup.service /etc/systemd/system/indus-ure-backup.service
sudo install -o root -g root -m 0644 deploy/indus-ure-backup.timer /etc/systemd/system/indus-ure-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now indus-ure-backup.timer
sudo systemctl start indus-ure-backup.service
sudo systemctl status indus-ure-backup.service --no-pager
```

Backup naredi PostgreSQL dump, kopijo prilog in manifest SHA-256, vse zapakira
ter šifrira z javnim `age` ključem. Paketa se ne da obnoviti brez Bojanovega
zasebnega ključa. Šifrirana kopija se naloži v namensko podmapo znotraj
potrjene Google Drive mape in se preveri po velikosti. Ob neuspehu gre
opozorilo v aplikacijo in po SMTP, če je SMTP nastavljen.

Za obnovo na čistem testnem strežniku: dešifriraj paket z zasebnim ključem,
`pg_restore` uporabi za `database.dump`, nato kopiraj `media/` v `MEDIA_DIR`.
Strežniške okoljske skrivnosti niso v paketu; obnovi jih iz ločenega varnega
zapisa in nato ponovno poveži Google Drive.

## 8. Preverjanje po preklopu

- prijava za Bojana in Ibra;
- nov ad-hoc klient, opravilo, ura in priloga;
- izklopi Wi-Fi, ustvari testno opravilo/prilogo, nato ponovno poveži in
  preveri vrsto sinhronizacije;
- odpri ICS povezavo kot read-only koledar;
- prenesi testni ZIP iz uporabniškega menija;
- preveri stanje nočnega backupa in sistemska opozorila;
- preveri `journalctl -u indus-ure.service -n 100 --no-pager`.

## Rollback

Kodni rollback je možen le, če po migraciji še ni novih zapisov, ali pa po
obnovi pred-migracijskega dumpa. Stara verzija bere `app_state`, nova pa po
preklopu zapisuje relacijske tabele, zato slepi preklop nazaj po novih vnosih
ni varen.

```bash
sudo systemctl stop indus-ure.service
sudo ln -sfn /opt/indus-ure/releases/PREJSNJI_COMMIT /opt/indus-ure/current
# po potrebi obnovi /var/backups/indus-ure/pre-v2.dump
sudo systemctl start indus-ure.service
```