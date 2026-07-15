# INDUS URE na Ubuntu strezniku

Produkcijska pot je:

```text
internet -> router TCP 80/443 -> 192.168.50.242 (Nginx) -> 127.0.0.1:8123 (Node) -> 127.0.0.1:5432 (PostgreSQL)
```

Obstojeca testna stran na `8080` in javni forwarding `1900 -> 8080` ostaneta nespremenjena. Nginx deli isti javni port 443 med poddomene po `server_name`. Node port `8123` in PostgreSQL `5432` se ne odpirata v UFW.

## 1. Koda in sistemski uporabnik

Po potrjenem commitu na GitHubu:

```bash
sudo useradd --system --home /var/lib/indus-ure --create-home --shell /usr/sbin/nologin indus-ure
sudo install -d -o root -g root -m 0755 /opt/indus-ure/releases
cd /tmp
git clone https://github.com/bojanhor/indus-ure.git indus-ure-release
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

Google Cloud OAuth client mora imeti natanko ta Authorized redirect URI. Prijava zahteva samo profil/e-posto; Calendar in Sheets se nato povezeta loceno z gumbom Google sync. Calendar uporablja omejeni obseg `calendar.app.created`: aplikacija ustvari namenski sekundarni koledar `INDUS URE - uporabnik` in nima dostopa do osebnega koledarja. Spremembe se dvosmerno osvezujejo vsako minuto; interval doloca `GOOGLE_SYNC_INTERVAL_MS`.

### Osnovna baza strank v Google Sheets

Google Sheet je avtoritativni vir strank:

```env
GOOGLE_SHEETS_ID=1lQ2D1ZQlQyBZfih0B1-Jx-8UI58PK-vRzNbjW1V2MiM
GOOGLE_SHEETS_RANGE="'Baza Strank'!A:I"
```

Stolpci A-I ostanejo: `Srch`, naziv, e-posta, naslov, kraj, posta, drzava, davcna in zavezanec za DDV. Davcna stevilka je `clientId` v strankah, vnosih in opravilih; aplikacija za stranke ne ustvarja GUID-ov. Nova stranka se najprej zapise v Google Sheet in sele nato osvezi v PostgreSQL.

Vrstice brez davcne ali s podvojeno davcno ostanejo vidne kot napaka, vendar jih ni mogoce uporabiti pri novem vnosu, dokler se ne popravijo v osnovnem Sheetu. Bojan mora v aplikaciji enkrat izvesti `Google sync`, da podeli dovoljenje `spreadsheets`.

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

## 6. Nginx in HTTPS

Za prvo izdajo certifikata najprej namesti bootstrap konfiguracijo, nato koncno HTTPS konfiguracijo:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo install -o root -g root -m 0644 deploy/nginx-indus-ure-bootstrap.conf /etc/nginx/conf.d/indus-ure.conf
sudo nginx -t
sudo systemctl reload nginx
sudo ufw allow 80/tcp comment 'Nginx HTTP HTTPS redirect'
sudo ufw allow 443/tcp comment 'Nginx HTTPS'
sudo ufw allow from 192.168.50.0/24 to any port 8081 proto tcp comment 'INDUS URE LAN'
sudo certbot certonly --nginx --non-interactive --agree-tos --no-eff-email --email bojan@indus.si -d ure.indus.si
sudo install -o root -g root -m 0644 deploy/nginx-indus-ure.conf /etc/nginx/conf.d/indus-ure.conf
sudo nginx -t
sudo systemctl reload nginx
curl --fail https://ure.indus.si/api/health
sudo certbot renew --dry-run --no-random-sleep-on-renew
```

Router posreduje samo standardna spletna porta na Nginx:

```text
TCP 80  -> 192.168.50.242:80
TCP 443 -> 192.168.50.242:443
```

Port `8081` ostane dostopen samo iz LAN-a oziroma pozneje tudi iz tocno dolocenega VPN omrezja. Certbotov systemd timer samodejno obnavlja certifikat, port 80 pa vse druge zahteve preusmeri na HTTPS.

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
