# Skrite stranke pri novih opravilih – 23. 9. 2026

## Uporaba in obseg

Šef: Nastavitve in orodja → Stranke → Uredi → **Skrij pri novih opravilih** →
Shrani spremembe. Enak obrazec je dostopen s svinčnikom pri izbiri stranke.
Odstranitev kljukice stranko ponovno ponudi. Nobena obstoječa stranka se ne
skrije samodejno.

Skrita stranka ni med predlogi pri novem dogodku, vpisu ur, vpisu materiala
ali zapisku. V imeniku ima oznako »Skrita pri novih opravilih«. Obstoječi
zapisi, urejanje, obračuni, splošno iskanje in masovni prenos obstoječih
vpisov stranko še vedno poznajo. To ni prepoved poslovanja ali nova dostopna
pravica: že izbrana stranka (npr. na povezanem projektu/osnutku) ostane
veljavna, kot tudi neposredno vpisano ime.

## Shranjevanje in varnost

- Kanonična stranka ima opcijsko polje `hiddenFromNewTasks: true` v obstoječem
  JSON podatku; brez nove SQL sheme. Pri vidnih strankah polja ni.
- Manjkajoče polje v starejšem zahtevku ohrani nastavitev. Izrecni `false`
  jo odstrani. HTTP sprejme le boolean, spremembo vidnosti lahko naredi le šef.
- Seznam vseh strank se ne filtrira na strežniku. Filtrirani so le predlogi
  za ustvarjanje; tudi stara referenca brez ID-ja ne sme ponovno ponuditi
  skrite kanonične stranke.
- Varnostna blokada brisanja strank z aktivnimi vnosi je nespremenjena.
- Povrnitev kode na starejšo izdajo ohrani poslovne zapise, starejša
  normalizacija pa lahko odstrani novo nastavitev skrivanja. Pred takšno
  povrnitvijo ohranimo preverjeno kopijo; skritja je nato treba obnoviti.

## Preizkusi

- Enotski preizkus normalizacije, ohranitve pri starem zahtevku in razreševanja ID-ja.
- Brskalniška preizkusa: skrivanje aktivne stranke, osvežitev, vse štiri vrste
  novih zapisov, urejanje obstoječega, imenik in ponovni prikaz; preverjanje
  nespremenjenih opravil/obračunov, starih referenc in dovoljenj delavca.
- PostgreSQL QA vključuje trajni zapis skrite stranke ter obstoječe preverjanje
  obnovitve backup formata z enakimi podatki.
- Ročni vizualni preizkus v izolirani aplikaciji prek vgrajenega brskalnika.

Rezultat objave se dopolni po preverjeni varnostni kopiji in preklopu izdaje.
