# Försvarsmaterial

Motiveringar till varje vägval i [`plan.md`](./plan.md). Syftet är att varje fråga vid
det muntliga försvaret ska ha ett skrivet svar redan förberett.

---

## Varför deterministisk låsordning?

En **deadlock** kräver att två transaktioner tar samma rader i *motsatt* ordning.

Anna vill ha stol [5, 9]. Bosse vill ha [9, 5] — samma stolar, men han klickade på 9 först.
Utan sortering: Anna låser 5, Bosse låser 9, Anna väntar på 9, Bosse väntar på 5. Båda
väntar för evigt tills Postgres dödar den ena efter ~1 sekund. Vid 20 000 användare händer
det hundratals gånger per minut, och användarna får oförklarliga fel.

Med `ORDER BY id` tar **alla** stolarna i samma ordning. Bosse väntar bara på stol 5, får
den när Anna är klar, och deadlock blir **matematiskt omöjlig** — inte osannolik, utesluten.

## Varför `FOR UPDATE NOWAIT`?

Utan `NOWAIT` köar förlorarens transaktion och **håller en databasanslutning** medan den
väntar. Under hög last tar anslutningarna slut och hela systemet dör. Med `NOWAIT`
misslyckas försöket omedelbart och användaren får "stolen är upptagen" direkt.

## Varför inte `SKIP LOCKED`?

`SKIP LOCKED` är till för "ge mig vilka N lediga rader som helst" — ståplats eller fri
placering. Här har användaren valt **specifika** stolar, så en överhoppad rad vore ett
felaktigt svar, inte en optimering.

## Varför är `UNIQUE (event_id, seat_id)` på `tickets` den yttersta garantin?

Det är inte en optimering utan ett **bevis**. Även om Redis ljuger, routinglagret har en
bugg och transaktionskoden är fel — databasen kan fysiskt inte utfärda två biljetter för
samma stol. Svaret på "hur vet ni att ni inte översäljer" blir därmed inte "jag har
testat", utan "det är omöjligt, här är constrainten".

## Varför är `tickets` skild från `orders`?

En **order** är en affärshändelse ("betalade 1 500 kr för tre stolar"). En **biljett** är
en inträdeshandling: en per stol, egen QR-kod, egen livscykel med `scanned_at` när
dörrvärden skannar. Köper du tre stolar blir det en order och tre biljetter, eftersom du
kan ge bort två till vänner som kommer separat. Ordern kan inte veta vilken av de tre som
just gick in.

## Varför `idempotency_keys`?

Användaren klickar "Betala". Servern drar kortet och skapar ordern — men svaret kommer
aldrig fram (wifi hickar, eller användaren trycker uppdatera). Webbläsaren skickar samma
request igen, servern drar kortet **en gång till** och skapar en **andra order**.

Lösning: klienten skapar en UUID per köpförsök och **återanvänder den vid omförsök**.
Servern försöker INSERT:a nyckeln (unique-index). Lyckas det → första gången, genomför och
**spara svaret i raden**. Misslyckas det → omförsök, returnera det sparade svaret utan att
göra något. Unique-constrainten gör att två samtidiga omförsök inte båda kan tro att de är
först. Samma princip som Stripes `Idempotency-Key`-header.

## Varför transactional outbox?

Postgres och RabbitMQ kan **inte** skrivas till atomärt — det är två separata system.
Committas ordern i samma sekund som RabbitMQ är nere, försvinner orderbekräftelsen
spårlöst och kunden får aldrig sin biljett.

Lösning: meddelandet skrivs till `outbox`-tabellen **inuti samma transaktion** som ordern.
En separat relay läser tabellen, publicerar och markerar raden. Är RabbitMQ nere ligger
meddelandet kvar och skickas när den kommer tillbaka.

## Varför måste konsumenterna vara idempotenta?

RabbitMQ garanterar **at-least-once**, inte exactly-once. Outbox-relayn kan dessutom
publicera och krascha innan raden markeras som skickad. Dubbletter är alltså **garanterade
över tid**, inte hypotetiska. Därför måste varje konsument klara samma meddelande två
gånger utan att göra jobbet två gånger.

Dedupe nivåindelas efter **konsekvens**: en dubbel biljett är allvarlig (tabell med
unique-constraint, durabelt), ett dubbelt mejl är irriterande (Redis-set med TTL, billigt).
Priset betalas högst där konsekvensen motiverar det.

## Varför polling för arenakartan istället för WebSockets?

Kostnaden för push är `ändringar/sek × anslutna klienter`. Vid 20 000 anslutna och 500
reservationer per sekund blir det **10 miljoner meddelanden per sekund** — cirka 1 GB/s
bandbredd och långt mer CPU än budgeten tillåter. Det är inte en optimeringsfråga.

Kartan är **ett-till-många**: 20 000 personer tittar på samma data. Där vinner cache över
push. Med 1 sekunds Cloudflare-cache vid kanten ser klustret ~20 requests per sekund
oavsett om 200 eller 20 000 pollar — fan-out-problemet flyttas ut till Cloudflares nät.

**Tumregeln:** WebSockets när utskicket är ett-till-ett, cache och polling när det är
ett-till-många. WebSockets används därför till köplats, reservationsnedräkning, "din stol
togs" och AI-chatt — alla ett-till-ett, där 20 000 anslutningar med ett meddelande i
sekunden är helt oproblematiskt (det är meddelandetakten som dödar system, inte antalet
anslutningar). Ingen backoffice eller ops-panel byggs.

## Varför virtuellt väntrum?

- **Löser fan-out vid roten** — bara insläppta håller WebSocket-anslutningar
- **Gör belastningen förutsägbar** — insläppstakten styr backend-lasten oavsett hur många
  som kommer
- **Ger autoscaling en meningsfull signal** — ködjup, istället för konstruerad CPU-last
- **Takt + sessionstid, inte bara tak:** ett rent tak ("max 2 000 inne") kan få kön att
  stanna helt om folk sitter och grubblar. Med takt rör sig kön alltid, och sessionstiden
  begränsar ändå antalet inne till `takt × sessionstid`
- Mönstret är etablerat — Queue-it är en kommersiell produkt byggd enbart kring det

Takten är konfigurerbar så att **båda** scenarierna kan demonstreras: utan kö degraderar
p95, med kö ligger den platt. Att visa problemet *och* lösningen är starkare än bara
lösningen.

## Varför gula stolar utan nedräkning på kartan?

De flesta konsumentbiljettsajter visar andras reservationer helt enkelt som otillgängliga,
troligen just på grund av **camping** — visar du att en stol blir ledig om två minuter så
sitter folk och väntar på den.

Vi avviker medvetet: gult **visar visuellt att hold-mekanismen arbetar**, vilket är
projektets tekniskt mest intressanta del. Grått skulle dölja det bästa arbetet. Nedräkningen
visas bara i popup **vid klick**, så bara den redan intresserade ser den — inte alla som
skannar kartan.

## Varför jitter på frisläppandet?

Reservationer skapas i vågor och löper därför ut i vågor. Utan jitter blir många stolar
gröna i **exakt samma millisekund**, alla tittande klienter ser det samtidigt, och tusentals
försöker ta samma stol. Det är en självförvållad trafikspik som upprepas var femte minut.

Innehavaren behåller exakt 5:00 — endast frisläppandet sprids över 0–20 sekunder.

## Varför är WebSocket-gatewayen en egen tjänst?

Två skäl:
1. **Annan skalningsprofil** — den förbrukar minne och öppna anslutningar, inte CPU.
2. **Viktigast:** ligger den i samma pod som boknings-API:et **tappas alla 20 000
   anslutningar vid varje deploy**. API:et deployas ofta, WebSocket-koden ändras sällan.

## Varför två separata workers?

De kräver **motsatt antal repliker**. `scheduler-worker` måste köra i exakt en instans —
tre kopior av insläppskontrollen skulle släppa in tre gånger så många. `notification-worker`
måste kunna köra i många och skalas av KEDA. Samma deployment kan inte ha både
`replicas: 1` och `replicas: 1–10`.

## Vilken gräns dras medvetet INTE?

Stolar, ordrar och betalningar delas **inte** upp i separata tjänster med varsin databas.
Hela projektets kärna är att reservationen sker i **en ACID-transaktion**. Sprids den över
tjänstegränser krävs sagamönster med kompensation — mer arbete, och just den garanti vi
försöker demonstrera går förlorad.

## Varför `event_id` på varje shardad tabell, även när det går att härleda?

Routinglagret måste veta vilken shard raden ligger på **innan** frågan ställs. Det kan inte
slå upp föräldern först — den ligger också på en shard.

## Vad gör man med data som saknar shard-nyckel?

`users`, `faq_documents` och `config` hör inte till något evenemang. De blir **globala
tabeller på shard-0**. `orders.user_id` är en vanlig UUID **utan främmande nyckel** —
främmande nycklar fungerar inte över databasgränser, vilket är normalt i shardade system.
"Mina ordrar" hämtas med **scatter-gather** från båda shardarna och slås ihop i
routinglagret.

## Varför är `seats.status` en lagrad kolumn och inte härledd?

Kartan är systemets mest lästa data — 20 000 användare × var 2:a sekund. En SELECT på en
indexerad statuskolumn är storleksordningar snabbare än en join mot reservationer med
tidsjämförelse mot `expires_at` på den hetaste läsvägen. Kolumnen uppdateras ändå inuti
transaktionen som redan låser stolen.

## Varför rensas `reservations` efter 30 dagar?

Under ett försäljningsfönster skapas ~50 000 reservationer varav ~1 500 blir ordrar —
resten är folk som ångrade sig. 30 dagar räcker för felsökning och konverteringsstatistik.
Ordrar och biljetter är självständiga (biljetten vet sin stol, ordern vet beloppet), så
ingenting går förlorat när reservationen raderas.

## Varför Zod när Fastify redan har JSON Schema-validering?

Fastifys inbyggda validering **är** valideringsmotorn — Zod ersätter den inte, utan är hur
schemat författas. Handskrivet JSON Schema kräver att TypeScript-typen skrivs separat, och
de två glider isär **tyst**, vilket är precis den buggklass validering ska förhindra.

Det avgörande argumentet: **ett schema, tre användningar** — Fastifys validering i backend,
TypeScript-typer i båda ändar, och formulärvalidering i React via react-hook-form.

## Varför kräver zero-downtime fyra saker?

`strategy: RollingUpdate` ensamt **tappar requests**. Fyra delar krävs:
1. **Readiness probe** — utan den skickas trafik till poddar som fortfarande startar → 502
2. **`maxUnavailable: 0`** — nya poddar startas först, gamla tas ner sedan
3. **`preStop`-hook + grace period** — vid SIGTERM vet ingress-nginx ännu inte att podden
   ska dö; hooken väntar tills podden tagits ur rotation
4. **Graceful shutdown i appen** — sluta ta emot nya, **slutför pågående**, stäng pooler

Femte delen för WebSockets: klienterna måste återansluta automatiskt med backoff, annars
tappar 20 000 användare sin köplats vid varje deploy.

## Varför måste `scaleDown.stabilizationWindowSeconds` sänkas till 60?

HPA:s standardvärde är **300 sekunder**. Det betyder att poddarna inte skalar *ned* förrän
fem minuter efter att lasten försvunnit. VG-kravet säger uttryckligen att antalet instanser
ska öka **och minska** med last, och ska demonstreras — med standardvärdet står man och
väntar i fem minuter framför examinatorn medan ingenting händer.

Värdet finns av en god anledning i produktion: det hindrar *flapping*, alltså att poddar
startas och dödas om vartannat vid ojämn last. 60 sekunder är en medveten kompromiss för
demonstrerbarhet, och det är så det ska förklaras.

## Varför får `livenessProbe` inte kontrollera beroenden?

`readinessProbe` svarar på "kan den här podden ta emot trafik just nu" — den *ska*
kontrollera att Postgres och Redis går att nå, för kan den inte nå dem ska den tas ur
rotation.

`livenessProbe` svarar på "ska den här podden dödas och startas om". Kontrollerar den
databasen så startar Kubernetes om **alla** poddar samtidigt när Postgres hickar till —
precis när systemet är som mest pressat. Ett litet problem blir ett totalt avbrott, och
omstarterna gör dessutom återhämtningen långsammare.

Liveness ska därför bara kontrollera att processen lever och inte har låst sig.

## Hur fungerar Prometheus egentligen? (pull, inte sidecar)

Prometheus körs som **en central server** som regelbundet **hämtar** mätvärden. Flödet är
*pull*: varje tjänst exponerar en vanlig HTTP-route `GET /metrics` (via `prom-client` i
Node), och Prometheus gör var 15:e sekund `GET http://<podd-ip>:3000/metrics` mot varje
podd den ska bevaka. Appen skickar alltså aldrig något själv. Poddarna hittas via
Kubernetes service discovery genom `ServiceMonitor`-resurser.

Sidecars används däremot för komponenter som **inte själva kan tala Prometheus** — en
liten översättare som kallas *exporter*: `postgres-exporter`, `redis-exporter`.
RabbitMQ har en inbyggd plugin. `node-exporter` körs som DaemonSet för maskinernas egna
CPU- och diskvärden.

## Vad är vägen från en request till databasen?

```
Webbläsare
  → Cloudflare (TLS, cache, Turnstile)
  → A-post mot nodens publika IP:443
  → ingress-nginx (DaemonSet) — ruttar via värdnamn
  → Service (ClusterIP) — lastbalanserar över friska poddar
  → booking-api-podd
  → shard-router: hash(event_id)
  → Postgres-podd (shard-0 eller shard-1)
```

En Kubernetes **Service** lastbalanserar till **Poddar**, inte till noder. Det är i
Service-lagret VG-kravet "minst två instanser bakom en load balancer" uppfylls.

## Varför tracing, och varför instrumentera direkt men koppla in Tempo senare?

Med **bara metrics** vet man *att* `POST /reservations` tog 8 sekunder. Med **loggar** har
man separata rader från separata tjänster som måste korreleras för hand — nästan omöjligt
vid 10 000 requests per sekund. Med **tracing** ser man ett vattenfall för en enskild
request och hittar att 6,8 av 8 sekunder gick åt till att vänta på en databasanslutning.

Det asynkrona köhoppet är nyckelskälet: när en order går
`order → outbox → RabbitMQ → worker → mejl` är det mycket svårt att följa ett enskilt köp
över den gränsen med bara loggar.

**Ordningen** beror på kostnaden: instrumentering *medan* man bygger kostar ~2 timmar,
men i efterhand i fem färdiga tjänster betydligt mer. Att installera Tempo senare tar
däremot en timme. Alltså: instrumentera direkt, koppla in backend när VG-kraven är säkrade.

## Varför skickas `payment_succeeded` från servern och inte webbläsaren?

Användaren kan stänga fliken innan webbläsaren hinner skicka händelsen. Kritiska
konverteringshändelser blir därför systematiskt underrapporterade om de skickas
klientsidigt. Mindre kritiska händelser (sidvisningar, klick) skickas från klienten.

## Varför `oversell_prevented_total` och inte `oversell_total`?

Den ursprungliga idén var en räknare för "översäljning inträffade", som alltid skulle vara
noll. Men det är en **tautologi**: unique-constrainten gör översäljning fysiskt omöjlig, så
räknaren kunde aldrig öka — och en metrik som aldrig kan ändras bevisar ingenting.

Omdefinierad mäter den i stället *förhindrade* försök: den inkrementeras när ett insert på
`tickets` fallerar på unique violation. Nu säger den något verkligt — "databasen fångade N
försök som applikationslogiken släppte igenom" — och påståendet blir både starkare och sant.

Det är invarianten gjord mätbar, kontinuerligt och inte bara vid testtillfället.

## Varför KEDA och inte bara HPA?

HPA kan bara skala på CPU och minne. `notification-worker` kan ha 10 000 meddelanden i kö
och ändå ligga på 3 % CPU, eftersom den väntar på nätverk — HPA skulle se "allt lugnt"
medan kön växer obehindrat. KEDA skalar på **RabbitMQ-ködjup** och kan gå till noll.

Dessutom blir demon ärlig: med CPU-baserad skalning måste man konstruera artificiell last.
Med KEDA kör man bara lasttestet och poddarna går synligt 1 → 8 → 1.

## Varför proof of work — och varför är det inte byggt?

PoW är **asymmetriskt**: klienten provar miljontals hashningar (~200 ms), servern
verifierar med *en* hashning (~0,01 ms). 20 000 riktiga användare kostar alltså servern
ingenting — de bränner CPU på sina egna enheter. En bot som vill ha 10 000 köplatser
betalar däremot 10 000 × 200 ms CPU.

Turnstile och PoW gör samma sak vid samma steg; staplade på varje användare lägger de
500–1000 ms innan någon kommer in i kön, och Turnstile är ett externt nätverksberoende på
den hetaste vägen. Därför var planen **adaptiv eskalering** — Turnstile bara vid misstänkta
signaler.

**Båda är medvetet flyttade till efter inlämningen.** Varken PoW eller Turnstile är
betygsgrundande, och tiden behövdes till observability och VG-kraven. Kvar finns de två lager
som faktiskt bär skyddet: rate limiting per IP, och **en aktiv reservation per kötoken**
upprätthållet av ett partiellt index i databasen. Det sista är mekanismen som gör de andra
lagren meningsfulla — utan den spelar det ingen roll hur dyra tokens är att skaffa.

**Lasttest-principen gäller ändå:** *lastgeneratorn får aldrig vara flaskhalsen.* Den
tillämpas nu på anslutningar i stället för pussel — fd-gränser, `somaxconn` och
`ip_local_port_range` höjs på både generatorer och noder, eftersom 20 000 WebSockets
inte är default-territorium.

## Varför inloggning först vid betalning?

Lägst friktion, och verifierat mot hur Ticketmaster faktiskt gör. Lasttestet behöver också
bara förutfärdade tokens för de ~5 000 som betalar, inte för alla 20 000.

**Konsekvensen** är att en anonym session kan hålla stolar — *denial-of-inventory*: en bot
reserverar 5 stolar, låter dem löpa ut, upprepar. Den kan aldrig köpa, men den kan göra
platser otillgängliga. **Motåtgärden** är att binda reservationen till **kötoken** (en
aktiv reservation per token), så skyddet flyttas till att göra kötokens dyra att skaffa.

## Varför OAuth2 client credentials bara för scanner-appen?

Dörrvärdens scanner är en **maskin med egen identitet**, inte en person som loggar in — ett
äkta client credentials-fall. Att lägga samma flöde på varje internt anrop skulle göra
Auth0 till ett externt beroende mitt i den hetaste vägen, med latens och en ny
felmöjlighet när 20 000 användare strömmar in. Internt räcker NetworkPolicies.

## Varför HMAC-signerad webhook?

Utan signatur kan vem som helst som hittar webhook-URL:en skicka "betalningen lyckades"
och få gratis biljetter. Samma mekanism som Stripe använder.

## Varför äger Terraform inte applikationens manifest?

Terraform skulle försöka spåra tillståndet på poddar som startar och dör hela tiden, och
varje `terraform plan` skulle visa drift som inte är drift. Gränsen går vid: **ändras det
här vid varje merge eller inte.**

## Varför får Terraforms statefil aldrig committas?

Den innehåller **hemligheter i klartext** — Hetzner-API-token, databaslösenord,
Auth0-nycklar. Repot är publikt. Statefilen är därför `.gitignore`:ad och säkerhetskopieras
manuellt utanför repot.

## Varför Testcontainers och inte mockad databas?

Hela projektets kärna **är** hur Postgres beter sig vid samtidiga lås. Mockar man databasen
testar man ingenting av det som faktiskt är svårt. Testcontainers ger dessutom identiskt
beteende lokalt och i CI, så konfigurationen inte glider isär.

## Varför behövs Redis Pub/Sub för WebSockets?

En WebSocket-anslutning ligger på en **viss** `realtime-gateway`-podd. Men HTTP-requesten
som ska trigga ett meddelande hanterades av en **helt annan** `booking-api`-podd. När
booking-api behöver skicka något till en klient vet den inte vilken gateway-podd som
håller just den anslutningen.

Lösningen: booking-api publicerar på Redis, alla gateway-poddar lyssnar, och den som
råkar hålla anslutningen skickar vidare. Utan det fungerar realtid bara så länge man har
exakt en podd — alltså inte alls i ett system som ska skala horisontellt.

## Varför har noden en publik IP om Cloudflare och ingress ska skydda den?

Något måste vara nåbart från internet, och utan managed load balancer är det noden som kör
ingress-nginx. Men "publik IP" betyder inte "öppen":

- **Endast port 443 är öppen** i Hetzners brandvägg, och bara **från Cloudflares
  publicerade IP-intervall**. En direkt träff mot nodens IP nekas av brandväggen
- **SSH (22) och Kubernetes-API:et (6443)** är låsta till utvecklarens egen IP
- **Postgres, Redis och RabbitMQ har ingen publik exponering alls** — de är ClusterIP och
  nåbara endast inifrån klustret

Det finns alltså bara en väg in: Cloudflare → ingress-nginx. Den publika IP:n är adressen
där den dörren sitter.

## Varför TanStack Query istället för egen polling?

För hand hade kartans polling krävt: `setInterval` i en `useEffect`, städning vid unmount
(glöms det fortsätter requesterna för alltid), laddnings- och feltillstånd, deduplicering
när två komponenter vill ha samma data, omförsök med backoff, omhämtning när fliken får
fokus — och **pausad polling när fliken är dold**.

Det sista är inte kosmetiskt: utan det hamrar 20 000 bakgrundsflikar på API:et. Cirka 150
rader petig kod ersätts av tre rader konfiguration.

## Varför infrastruktur först (walking skeleton)?

Den riskabla delen av projektet är **inte** bokningslogiken — den går att felsöka lokalt,
och fel syns direkt. Det riskabla är infrastrukturen: DNS-propagering, TLS-certifikat som
inte utfärdas, Kubernetes-nätverk, hemligheter i CI som inte når fram,
registry-autentisering. Sådant går sönder på sätt som tar timmar och **inte går att
skynda på**.

Byggs appen i tre veckor och deployas sedan, upptäcks de problemen med tre dagar kvar.
Deployas istället ett "hello world" genom hela kedjan först, är G-kravet om automatisk
deploy uppfyllt redan första veckan, varje senare fas åker på en pipeline som redan
fungerar, och infraproblem dyker upp medan marginalen finns kvar.

## Varför allowlistas lastgeneratorerna i rate limitern?

Vårt eget IP-baserade botskydd ser 20 000 virtuella användare från några få maskiner som
exakt det angrepp skyddet är byggt för. Utan allowlistning mäter testet rate limitern
istället för systemet. Avsteget dokumenteras i rapporten — det är en medveten
testkonfiguration, inte ett kringgående av skyddet i produktion.

## Varför bygger vi egen felhierarki (`BaseError`) istället för generiska Error-objekt?

Generiska fel ger inga garantier om form — varje felhanterare måste gissa vad som ligger
i felet. Med en bas och typade subklasser (se `rules.md`) vet den yttersta felhanteraren
alltid att den kan läsa `httpStatus`, `code` och `isOperational`.

`isOperational` är den avgörande fördelen: den skiljer **förväntade** affärsfel ("stolen
är upptagen", som händer tusentals gånger under en försäljning) från **oväntade** buggar
(en nullpointer). Förväntade fel ska svara med rätt HTTP-status och inte larma. Oväntade
fel ska larma direkt. Utan den distinktionen blir larmkanalen antingen tyst när det
verkligen spricker, eller fullständigt brus — och brus är det som gör att man slutar läsa
larmen, vilket är värre än att inte ha några alls.

## Varför får AI-verktyget aldrig committa, pusha eller merga?

All historik i ett projekt som ska granskas och försvaras individuellt måste gå genom en
person som förstår och kan stå för varje ändring. Att låta ett verktyg committa automatiskt
skulle göra det möjligt att få kod i repot som aldrig faktiskt lästs — vilket undergräver
hela poängen med det muntliga försvaret, där den sökande ska kunna förklara varje rad.
Reglen är därför en hård spärr, inte en rekommendation (se `rules.md`, avsnitt 12).

---

# Tillägg efter extern granskning av planen

Följande punkter kom ur en granskning av systemdesignen. De är med här eftersom var och en
är en fråga som rimligen kan komma — och flera av dem är ställen där den ursprungliga planen
hade en lucka.

## Vad händer om betalningen kommer efter att reservationen löpt ut?

Det här är den enda punkten i systemet där **riktiga pengar kan försvinna**: Stripe har
dragit beloppet, reservationen har löpt ut, stolarna är sålda till någon annan. Med
5-minutershold och Checkout i ett annat fönster är det inte ett hypotetiskt kantfall — det
kommer att hända.

**Två mekanismer, inte en.** Primärt **fryser** vi utgången: när Checkout-sessionen skapas går
reservationen till `pending_payment` och slutar räkna ner, med ett eget tak
(`payment_frozen_until`, t.ex. 10 min) och **en aktiv Checkout per kötoken** så att
frysningen inte blir ett sätt att hålla stolar gratis. Som **skyddsnät** återbetalas en
betalning som ändå kommer efter det frysta taket automatiskt, med förklarande mejl.

Frysningen löser det normala fallet. Återbetalningen finns för att även frysningen kan ta
slut — fördröjda Stripe-retries, en flik som lämnats öppen. Att bara ha den ena hade lämnat
ett hål.

## Varför är kötoken signerad och stateless i stället för att bara ligga i Redis?

Ursprungligen var Redis enda hemmet för kötokens. Men Redis är **en podd**, och
reservationer binds till kötoken snarare än till inloggning. En Redis-omstart mitt i
försäljningsfönstret hade därför betytt: alla 20 000 köplatser borta, alla tokens ogiltiga,
och — värst — **alla pågående reservationer omöjliga att slutföra**, eftersom ägarens token
inte längre existerade. Stolarna hade legat låsta till expiry medan ingen kunde köpa dem.

Lösningen är att göra signaturen *tillräcklig*: tokenen är en HMAC/JWT med `queue_token_id`
och `exp`, och validering kräver ingen uppslagning. Redis används till revokering och
aktivitetsspårning, inte som enda sanning. Plus AOF-persistens.

Resten av Redis-användningen tål en omstart — cachen byggs om, rate limits nollställs,
ett dubbelt mejl är irriterande men ofarligt. Det var kön och tokens som var farliga.

## Varför DNS-01 i stället för HTTP-01 för certifikaten?

HTTP-01 genom proxad Cloudflare i Full (strict) har ett **bootstrap-problem**: Cloudflare
kräver ett giltigt certifikat på origin för att nå det över 443 — men det är just det
certifikatet som ska hämtas. Dessutom kan "Always Use HTTPS", botskydd på
`/.well-known/acme-challenge/` och cachning var för sig sabotera valideringen, med
svårlästa fel.

DNS-01 kräver ingen port 80 alls, vilket matchar vår egen brandväggsdesign (endast 443 från
Cloudflares intervall), och ger wildcard-certifikat på köpet. Vi äger redan DNS i Terraform,
så API-tokenen finns där.

**Let's Encrypt staging-issuer används tills kedjan är stabil.** LE ger 5 identiska
certifikat per vecka, och upprepade `terraform destroy/apply` i Fas 1 bränner dem — att
sitta certlös precis vid demon vore ett självmål.

## Varför måste rate limitern läsa `CF-Connecting-IP`, och bara från Cloudflares intervall?

Bakom Cloudflare ser varje request ut att komma från en CF-IP. Gör man ingenting räknas
**hela världen som en användare** och systemet rate-limitar sig självt.

Men att naivt lita på headern är värre: då kan vem som helst som når origin direkt sätta
`CF-Connecting-IP` till ett offers adress och **låsa ut dem**. Rate limitern blir ett vapen
mot användarna i stället för ett skydd.

Därför: `use-forwarded-headers` med `proxy-real-ip-cidr` satt till Cloudflares publicerade
intervall, så headern bara respekteras när den kommer därifrån. Samma princip gäller
allowlistningen av lastgeneratorerna.

## Varför garanterar inte `replicas: 1` att scheduler-workern är ensam?

Det gör den inte — och det är lätt att tro motsatsen. En Deployment med `replicas: 1` och
standardstrategin RollingUpdate har `maxSurge: 25%`, vilket **avrundas uppåt till 1**. Under
varje deploy kan alltså två schemaläggare köra samtidigt, och då släpper insläppskontrollen
in dubbelt så många.

Två åtgärder: `strategy: Recreate` (den korta luckan är ofarlig för en bakgrundsprocess), och
ett **Postgres advisory lock vid start** — håller någon annan låset avstår processen.
Korrektheten ska inte vila på Kubernetes schemaläggning.

## Varför körs migrations som ett eget Job och inte som init-container?

En init-container i `booking-api` körs av *varje* podd. Med 2–10 repliker tävlar de om att
migrera samma databas samtidigt. Ett separat Kubernetes Job med **Postgres advisory lock**,
kört mot **båda shardarna** före rollout, gör migreringen till exakt en operation — och
pipelinen avbryter deployen om den misslyckas.

Det är också därför `rules.md §4` kräver **framåtkompatibla migrations**: en ny migration
måste kunna köras *innan* den nya koden rullas ut, annars fungerar inte zero-downtime.

## Varför nätverksvolymer i stället för k3s standardlagring?

k3s default-storageclass är `local-path`, som binder volymen till den nod podden råkade
hamna på. Två konsekvenser: **"döda shard-1 live" blir ett avbrottstest i stället för ett
failover-test** (podden kan bara schemaläggas tillbaka på samma nod), och en förlorad nod
tar shardens data med sig — upp till 24 timmars förlust med nattlig backup.

Hetzner CSI ger nätverksvolymer som kan följa med podden. `storageClassName` skrivs ut
**explicit** i manifesten; att förlita sig på default är precis hur sådant här missas.

## Varför är `UNIQUE (event_id, seat_id)` partiellt?

Den ursprungliga constrainten var rätt tänkt men för absolut: en biljett som ogiltigförklaras
(t.ex. vid den automatiska återbetalningen ovan) hade blockerat stolen för alltid, eftersom
raden låg kvar.

Med `tickets.status` och `UNIQUE (event_id, seat_id) WHERE status = 'valid'` är garantin mot
översäljning exakt lika stark — databasen kan fortfarande inte utfärda två *giltiga* biljetter
för en stol — men återförsäljning blir möjlig.

## Varför är QR-token en HMAC och inte en vanlig hash?

Planen sa först "deterministisk hash av `order_id` + `seat_id`". Men en ren hash av två
värden är inte hemlig: `order_id` och `seat_id` syns i API-svar till användaren. Vem som helst
som kan gissa eller härleda ingångarna kan då **tillverka en giltig biljett**.

HMAC-SHA256 med en serverhemlighet bevarar det vi var ute efter — samma indata ger samma
token, så omkörning är idempotent — men utan nyckeln går den inte att konstruera.

## Varför måste idempotensnyckeln vara scopad på vem som anropar?

Utan scope räcker det att gissa eller snappa upp en nyckel för att få tillbaka **någon annans
sparade svar**, och det svaret innehåller orderdata. Nyckeln är därför unik per
`(event, principal, operation)`, där principal är kötoken eller user-id.

Och in-flight-fallet: när INSERT-vinnaren fortfarande arbetar finns det inget sparat svar att
returnera till de samtidiga försöken. De får **409**, inte ett tomt svar — därför asserterar
kronjuveltestet `1 × 200 + 9 × 409` och exakt en order. Hade alla tio fått 200 med samma
kropp vore det bara möjligt om nio av dem väntat, vilket är ett annat beteende än det vi
påstår att vi har.

## `SKIP LOCKED` — varför fel för stolar men rätt för outbox?

Den här kontrasten är värd att ha klar, för båda sidorna förekommer i systemet.

För **stolar** är `SKIP LOCKED` fel: användaren har valt *specifika* platser, så en överhoppad
rad vore ett felaktigt svar ("stol 14 var ledig, men du fick stol 22"). Där används
`ORDER BY id` + `FOR UPDATE NOWAIT`.

För **outbox-relayn** är det exakt rätt: den vill ha *vilka N opublicerade rader som helst*,
och ska inte blockera för att en annan relay-instans råkar hålla en rad. Samma verktyg,
motsatt lämplighet — skillnaden ligger i om anroparen bryr sig om *vilka* rader den får.

## Varför är WebSocket aldrig enda leveransvägen?

Redis Pub/Sub är fire-and-forget: inget persisteras, ingen leverans garanteras. Deployas
gatewayen i exakt den sekund ett insläpp publiceras försvinner meddelandet — men
**insläppsplatsen är förbrukad**, och användaren väntar för alltid på ett besked som aldrig
kommer.

Därför principen: varje WS-meddelande måste motsvaras av tillstånd klienten kan **läsa om**
vid återanslutning (`GET /queue/status`, `GET /reservations/:id`). WebSocket gör upplevelsen
omedelbar; den bär aldrig ensam ansvaret för att något kommer fram. Samma lösning tar
dessutom hand om att nedräkningen hamnar ur synk när anslutningen tappar.

## Varför höjs `requests` till 250m på booking-api?

HPA räknar utnyttjande mot **requests**, inte mot limits. Med `requests: 100m` visar en podd
som drar 350m hela 350 % — och hoppar direkt till max 10 repliker vid första mätningen.
Demon blir "2 → 10 på en gång" i stället för den gradvisa kurva som faktiskt visar att
autoscaling fungerar. Dessutom ger CFS-throttling vid en snäv limit systematiskt sämre p99.

`requests: 250m` med `limits: 500m` (2× request) ger både en läsbar kurva och utrymme för
toppar. Kurvan mäts i Fas 6 **före** den stora körningen, inte under den.

## Varför lovar vi inte nedskalning för realtime-gateway?

Två skäl. Node återlämnar inte minne till operativsystemet, så RSS stannar uppe efter en
topp — en minnesbaserad HPA skalar därför upp men i praktiken aldrig ner. Och att skala ner
en WebSocket-gateway **dödar aktiva anslutningar**, vilket är precis fel beteende.

Upp-och-ner demonstreras på booking-api, där skalningen är CPU-baserad och ärlig. Att lova
något i en demo som synligt inte kommer att hända är sämre än att inte lova det.

## Varför demonstreras inte nodskalning live?

ingress-nginx körs som DaemonSet och Cloudflare pekar på specifika nod-IP:n. Nya noder får
därför ingen trafik förrän Terraform uppdaterat A-posterna och TTL:en löpt ut — mitt i en
demo är det minuter av ingenting.

VG-kravet gäller dessutom att *antalet instanser* ökar och minskar med last, vilket HPA och
KEDA sköter på poddnivå. Demonoderna provisioneras i förväg; nodskalning nämns som nästa steg.

## Varför raderar vi inte personuppgifter på begäran?

Därför att en hård radering skulle bryta mot **bokföringslagens krav på sju års bevarande**
av bokföringsmaterial, och dessutom förstöra giltiga biljetter för evenemang som ännu inte
ägt rum.

Lösningen är **anonymisering**: personuppgifterna i `users` nollas, medan `orders` och
`payments` behålls med ett anonymiserat `user_id`. GDPR art. 17(3)(b) tillåter uttryckligen
fortsatt behandling när en rättslig förpliktelse kräver bevarande. Rätten till radering är
alltså uppfylld — men den omsätts i rätt mekanism.

## Vad är vårt RPO, och är det bra nog?

**RPO är 24 timmar** (nattlig `pg_dump`) och **RTO är den uppmätta återställningstiden** från
övningen i Fas 4.

Det är **otillräckligt för riktig biljettförsäljning** — en krasch strax före midnatt skulle
radera hela dagens försäljning, och hela systemets poäng är ett 15-minutersfönster.
Point-in-time recovery med WAL-arkivering skulle ta ner RPO till sekunder, till priset av
kontinuerlig WAL-lagring och mer driftkomplexitet.

Det är ett medvetet val för projektets omfattning, inte ett förbiseende — och det står i
`runbook.md` snarare än att upptäckas vid en följdfråga.

## Varför ligger CDN, TLS-terminering, identitet och betalning utanför VPS:en?

Systemet kör på vår egen VPS: applikationen, databaserna, kön, cachen och hela
observability-stacken. Det som ligger utanför är **edge och identitet** — Cloudflare för
TLS-terminering och cachning, Auth0 för inloggning, Stripe för betalning.

Det är hur det görs i praktiken, och för två av dem finns ett konkret skäl: Stripe håller
kortuppgifter borta från våra servrar så att vi aldrig hamnar under PCI DSS, och Cloudflare
absorberar fan-out som en enskild VPS omöjligt kan ta.

## Varför är `oversell_prevented_total` inte bara pynt?

Se avsnittet ovan om varför metriken omdefinierades. Kortversionen: den ursprungliga
formuleringen kunde aldrig öka och bevisade därför ingenting. Den nuvarande mäter något som
faktiskt kan inträffa, och som berättar om applikationslagret har en bugg — databasen är
sista försvarslinjen, och metriken visar hur ofta den behövde användas.

## Varför öppnas 6443 aldrig i den publika brandväggen, inte ens mot ett Tailscale-intervall?

Den första versionen av brandväggen öppnade 6443 mot `admin_ipv4_cidr`
och ett Tailscale CGNAT-intervall (`100.64.0.0/10`), i tron att CI:s
Tailscale-anslutna trafik skulle synas som en 100.64.x.x-adress mot
nodens publika gränssnitt. Det är fel: Tailscale bygger en krypterad
WireGuard-tunnel direkt mellan två noder i samma tailnet. Hetzners
brandvägg filtrerar den publika nätverksgränssnittet och ser bara
opaka, redan krypterade UDP-paket på Tailscales egen port — den vet
inte att det finns en "6443-anslutning" inuti, och kan därför varken
släppa igenom eller blockera den baserat på en regel för port 6443.
En regel för ett Tailscale-CIDR på 6443 gör alltså ingenting alls.

Den riktiga lösningen: control-plane-noden går själv med i tailnet
(cloud-init, med en egen, **icke-ephemeral** auth-nyckel så den inte
faller ur tailnet vid omstart). Både lokal kubectl och CI ansluter till
samma tailnet och når API-servern via dess Tailscale-hostname —
trafiken går aldrig via nodens publika IP eller genom den publika
brandväggen. 6443 kan då strykas ur `hcloud_firewall` helt, vilket är
en strängare och samtidigt enklare regel: inte "öppet mot ett brett
intervall", utan "aldrig öppet publikt, oavsett källa".

Konsekvensen är att *alla* som ska nå klustrets API — även
utvecklarens egen maskin som kör `terraform apply` — måste vara
ansluten till samma tailnet. SSH (port 22) är opåverkat och förblir
den publika vägen in för Terraforms kubeconfig-hämtning.
