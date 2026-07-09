# INDUS URE

Skupna spletna aplikacija za Bojana in Ibra za ure, stranke, material, kilometrino in statuse obracuna.

## Lokalni zagon

Najlazje:

```bat
ZAGON.bat
```

Nato odpri:

```text
http://127.0.0.1:8123
```

Uporabnika:

- `bojan` / `bojan123`
- `ibro` / `ibro123`

## Objavo na splet

Najlazje je GitHub + Render.

1. Ustvari GitHub repository, npr. `indus-ure`.
2. Nalozi celotno mapo projekta.
3. V Render izberi `New` -> `Blueprint`.
4. Povezi GitHub repository.
5. Render bo uporabil `render.yaml`.

Po objavi dobis javni HTTPS naslov.

Opomba: trenutna Render nastavitev uporablja free plan brez diska, da ne zahteva kartice. Za trajno shranjevanje podatkov je kasneje potreben persistent disk ali zunanja baza.

## Podatki

Lokalni podatki so v:

```text
outputs/data/db.json
```

Ta datoteka je v `.gitignore`, da se zasebni vnosi in gesla ne objavijo na GitHub.
