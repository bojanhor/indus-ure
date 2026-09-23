# Obračun strank – primerjava ur

Uporabnik je zahteval odstranitev izbire »Prikaz ur« in stalni način
»Obračunska vrednost za stranko«. Pregled, seštevki in izvoz za stranko
zato uporabljajo izključno ure za stranko. PDF, PDF s prenosnim žetonom in
Gmail osnutek imajo to pravilo tudi na strežniku, če starejši odjemalec še
pošlje prejšnjo izbiro. Deljenje posameznega dogodka ostaja nespremenjeno
in še vedno vključuje dejanski čas izvajalca.

Pred »Za obračun (h)« je neurejevalno polje »Vpisane ure (h)«: seštevek
vpisanih ur vseh neizbrisanih dodelitev istega dogodka. Ročne ure za stranko
se ne seštevajo še enkrat po izvajalcih. Različni vrednosti sta poudarjeni
z jantarno barvo in besedilom »Za obračun je … h več/manj.« Poudarek se
posodobi že med tipkanjem; shranjevanje uporablja isti obstoječi varen
endpoint in ne spreminja delavčevega časa. Primerjava upošteva dve prikazani
decimalki in izrecno ničlo. Zaklenjeni obračuni kažejo isto informacijo samo
za branje. Material, zapiski, garancija in stare razlike poračunov se ne
predstavljajo kot navadna primerjava delovnih ur.

Na telefonu sta obe urni polji drug ob drugem, kilometrina pod njima.
Obstoječi zaklepi, pravice, formule obračunov, Google Koledar in poslovni
zapisi ostajajo nespremenjeni. Ni migracije. Povrnitev kode na `7f00768`
vrne prejšnji izbirnik in prikaz brez poseganja v podatke.

Preverjanje vključuje enake in različne ure, ničlo, skupno delo dveh oseb,
izbrisano dodelitev, zaklenjen obračun, izključene vrste vnosov ter širine
320/390/768/1280 px. Brskalniški preizkus dejansko shrani nove ure za
stranko na izoliranem strežniku, preveri nespremenjen čas delavca in
ponovitev po osvežitvi. Strežniški test prebere besedilo obeh vrst PDF
prenosa, tudi ob poslani stari izbiri, in preveri nespremenjeno deljenje
dogodka. Objavo varujeta sveži recovery backup in PostgreSQL QA.

## Rezultat objave

Objavljena izdaja `54d07c2`, prejšnja produkcija `7f00768`. Točen kandidat
je na strežniku prestal 288/288 testov in 20/20 PostgreSQL, restore,
upgrade ter rollback preverjanj. Celotni Chromium nabor: 65/65; ciljna
WebKit preizkusa: 2/2. Vizualno pregledani posnetki telefonskega in
namiznega prikaza, brez vodoravnega prelivanja pri 320/390/768/1280 px.

Predobjavna kopija `indus-ure-recovery-20260923T103305Z.tar.gz`, zaključena
ob 10:33:41 UTC, ima vseh pet preverjanj uspešnih in zaščiteno predobjavno
oznako. Po preklopu obe aplikaciji aktivni, health uspešen, javna stran
HTTP 200 brez izbirnika in z novim neurejevalnim poljem ter označevanjem
razlike. Brez opozoril v dnevniku Ure. Google Koledar ostaja omogočen brez
napak. Produkcijskih opravil, ur ali obračunov nismo testno spreminjali.
Google TODO in njegov odloženi razdelek nista bila spreminjana. GitHub
ni bil posodobljen.
