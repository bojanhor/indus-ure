# Mobilni prenos PDF obračuna stranke – 14. 9. 2026

Obseg: samo zadnja točka Google TODO, neuspešen Android prenos Anžetovega
obračuna. Preostalih odprtih točk in odložene razdelitve monolita ne spreminjamo.

## Ugotovitve

- Šest Android/Firefox zahtevkov za pripravo PDF povezave med 16:37 in 16:46 UTC
  je prejelo HTTP 201. V povezanih strežniških dnevnikih ni napake izdelave PDF.
- Zasebna pot prenosa namenoma ne beleži URL-jev z žetoni v access log. Iz
  zgodovinskih dnevnikov zato ni mogoče dokazati, kaj se je zgodilo po izdaji
  povezave na telefonu.
- Namizni produkcijski brskalnik je Anže zupin / 8 vpisov / 16,5 h / 68 km
  uspešno prenesel že pred spremembo. Produkcijskih dogodkov nismo urejali.
- Prejšnji mobilni tok je odprl začasen prazen zavihek in ga šele po asinhronem
  zahtevku preusmeril na datoteko. Ob blokiranem popupu je ostal le neviden
  programatski klik, brez vidne povezave za ponovni poskus.

## Sprememba

- Priprava ostane v aplikaciji, brez odpiranja praznega zavihka.
- Telefon pokaže običajno vidno povezavo Prenesi PDF; neposreden dotik sproži
  same-origin prenos s Content-Disposition. Namizje ohrani samodejni prenos,
  vidna povezava pa ostane kot alternativa.
- Dialog pokaže stranko, pripravo, napako/ponovni poskus, 30-sekundni timeout
  priprave in potek povezave po 4 minutah. Strežniški žeton še vedno velja
  največ 5 minut in je vezan na isto prijavljeno šefovo sejo.
- Zapiranje prekliče zahtevek in ignorira pozni odgovor. Ponovni poskus ohrani
  isti zajeti izbor vpisov, prilog in načina prikaza ur. Prenos ne potrjuje
  obračuna in ne spreminja vpisov.
- Sporočilo po kliku pravi le, da je prenos zahtevan; ne trdi, da je Android
  datoteko že shranil.

## Preverjanje pred objavo

- `npm test`: 204/204.
- `npm run test:e2e`: 42/42, brez preskočenih testov.
- Novi testi: prenos dejanske PDF datoteke in preverjanje njene vsebine;
  mobilni dotik brez popupa; namizni samodejni prenos; napaka in retry;
  preklic počasne priprave; timeout; potek povezave; prazen izbor; 401/403/410
  za neprijavljeno, delavčevo in drugo šefovo sejo; nespremenjen vpis po prenosu.
- Vizualno pregledani mobilni posnetki pripravljene povezave in napake na
  390 × 844 px. Mobilni avtomatizirani preizkus je Chromium z emulacijo dotika
  in Android/Firefox UA, ne dejanski Firefox na fizičnem telefonu.

Objava zahteva obstoječi PostgreSQL QA/restore in uspešno zasebno recovery
kopijo pred preklopom. Uporabiti samo pripravo kandidata, QA in preklop Ure;
ne nameščati stare skupne Nginx konfiguracije in ne posegati v Fakture.
