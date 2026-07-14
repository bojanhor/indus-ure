# INDUS URE na Ubuntu strezniku

Produkcijska pot je:

```text
javni HTTPS edge -> 192.168.50.242:8081 (Nginx) -> 127.0.0.1:8123 (Node) -> 127.0.0.1:5432 (PostgreSQL)
```

Obstojeca testna stran na `8080` in javni forwarding `1900 -> 8080` ostaneta nespremenjena. Node port `8123` in PostgreSQL `5432` se ne odpirata v UFW.

## 1. Koda in sistemski uporabnik

Po potrjenem commitu na GitHubu:

```bash
sudo useradd --system --home /var/lib/indus-ure --create-home --shell /usr/sbin/nologin indus-ure
sudo install -d -o root -g root -m 0755 /opt/indus-ure/releases
cd /tmp
git clone https://github.com/ibrahimetemaj04-art/indus-ure.git indus-ure-release
cd indus-ure-release
npm ci --omit=dev
sudo mv /tmp/indus-ure-release /opt/indus-ure/releases/PRVI_COMMIT
sudo chown -R root:root /opt/indus-ure/releases/PRVI_COMMIT
sudo ln -sfn /opt/indus-ure/releases/PRVI_COMMIT /opt/indus-ure/current
```

Za naslednjo verzijo uporabi novo mapo z imenom commita; prejsnja ostane za hiter rollback.

## 2. PostgreSQL

Geslo vnesi interaktivno; ne lepi ga v ukaz ali Git:

```bash
sudo -u postgres createuser --pwprompt indus_ure
sudo -u postgres createdb --owner=indus_ure indus_ure
```

PostgreSQL naj ostane vezan samo na localhost. Connection string uporablja URL-encoded geslo.

## 3. Skrivnosti in okolje

```bash
sudo install -o root -g root -m 0600 /opt/indus-ure/current/.env.example /etc/indus-ure.env
sudoedit /etc/indus-ure.env
```

Nastavi dolgo DB geslo ter Google OAuth podatke. `PUBLIC_BASE_URL` in `GOOGLE_REDIRECT_URI` morata biti `https://ure.indus.si` oziroma `https://ure.indus.si/api/google/callback`. Skrivnosti ne posiljaj v chat in jih ne commitaj.

Google Cloud OAuth client mora imeti natanko ta Authorized redirect URI. Prijava zahteva samo profil/e-posto; Calendar in Sheets se nato povezeta loceno z gumbom Google sync.

## 4. Prenos obstojecih podatkov

Pred prenosom ustavi stare vnose in naredi backup.

Ce je vir stara PostgreSQL baza (Render/Neon), uporabi `pg_dump -Fc` in `pg_restore --no-owner --no-acl` v prazno lokalno bazo.

Ce je vir celoten `outputs/data/db.json`:

```bash
cd /opt/indus-ure/current
set -a
source /etc/indus-ure.env
set +a
npm run import:json -- /varna/pot/db.json
```

Importer zavrne prepis obstojece vrstice. Po preverjenem backupu je zavesten prepis mogoc z `--force`. UI JSON izvoz ni popoln: manjka mu del nastavitev, uporabnikov, zaklepov in Google tokenov.

## 5. systemd

```bash
sudo install -o root -g root -m 0644 deploy/indus-ure.service /etc/systemd/system/indus-ure.service
sudo systemctl daemon-reload
sudo systemctl enable --now indus-ure.service
sudo systemctl status indus-ure.service --no-pager
curl --fail http://127.0.0.1:8123/api/health
```

Logi:

```bash
journalctl -u indus-ure.service -n 100 --no-pager
```

## 6. Nginx na notranjem portu 8081

```bash
sudo install -o root -g root -m 0644 deploy/nginx-indus-ure.conf /etc/nginx/conf.d/indus-ure.conf
sudo nginx -t
sudo systemctl reload nginx
curl --fail -H 'Host: ure.indus.si' http://127.0.0.1:8081/api/health
```

UFW dovoli `8081/tcp` samo iz LAN-a, VPN omrezja in/ali tocnega IP-ja javnega edge reverse proxyja. Ne uporabi `ufw allow 8081` za ves internet.

Da bo `https://ure.indus.si` deloval brez porta, mora sistem, ki trenutno prejema javna vrata 80/443, terminirati TLS in proxyjati na `192.168.50.242:8081`. Na njem dodaj tudi HSTS. Pred tem moramo vedeti, kateri racunalnik/program trenutno drzi 80/443.

## 7. Dnevni backup

```bash
sudo install -d -o postgres -g postgres -m 0700 /var/backups/indus-ure
sudo install -o root -g root -m 0755 deploy/indus-ure-backup /usr/local/sbin/indus-ure-backup
sudo install -o root -g root -m 0644 deploy/indus-ure-backup.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/indus-ure-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now indus-ure-backup.timer
sudo systemctl start indus-ure-backup.service
sudo systemctl status indus-ure-backup.service --no-pager
sudo -u postgres pg_restore --list /var/backups/indus-ure/NAJNOVEJSI.dump | head
```

Dump vsebuje tudi Google refresh tokene, zato mora ostati zaseben. Lokalna kopija ni dovolj; dodaj se sifrirano off-site kopijo.

## 8. Cutover in rollback

Pred javnim preklopom preveri Google prijavo za oba dovoljena e-naslova, testni vnos, fotografijo, Google sync, restart servisa in obstoj podatkov po restartu. Staro okolje obdrzi vsaj sedem dni.

Rollback kode:

```bash
sudo ln -sfn /opt/indus-ure/releases/PREJSNJI_COMMIT /opt/indus-ure/current
sudo systemctl restart indus-ure
```

Rollback podatkov se dela samo iz preverjenega pre-migration dumpa.
