# Försvarsmaterial

Motiveringar till vägvalen i [`plan.md`](./plan.md), som förberedda svar inför det muntliga
försvaret. Sorterat efter tema. Sist finns ärliga svar om det som inte är byggt.

---

## 1. Bokning och konsistens

### Varför deterministisk låsordning?

En deadlock kräver att två transaktioner tar samma rader i motsatt ordning. Anna vill ha
stol [5, 9], Bosse [9, 5]. Utan sortering låser Anna 5, Bosse 9, och båda väntar på varandra
tills Postgres dödar den ena. Vid tusentals samtidiga köpare blir det hundratals oförklarliga
fel per minut.

Med `ORDER BY id` tar alla stolarna i samma ordning. Bosse väntar bara på stol 5 och får den
när Anna är klar. Deadlock blir omöjlig, inte bara osannolik.

### Varför `FOR UPDATE NOWAIT`?

Utan `NOWAIT` köar förloraren och **håller en databasanslutning** medan den väntar. Under hög
last tar anslutningarna slut och hela systemet stannar. Med `NOWAIT` misslyckas försöket direkt
och användaren får "stolen är upptagen" (409) på en gång.

### `SKIP LOCKED` — fel för stolar, rätt för outbox

För stolar är `SKIP LOCKED` fel: användaren har valt *specifika* platser, och en överhoppad
rad vore ett felaktigt svar ("stol 14 var ledig, men du fick stol 22"). För outbox-relayn är
det exakt rätt: den vill ha *vilka* opublicerade rader som helst och ska inte blockera på en rad
någon annan håller. Skillnaden är om anroparen bryr sig om vilka rader den får.

### Hur vet ni att ni inte översäljer?

`UNIQUE (event_id, seat_id) WHERE status = 'valid'` på `tickets`. Även om Redis ljuger,
routinglagret har en bugg och transaktionskoden är fel kan databasen inte utfärda två giltiga
biljetter för samma stol. Svaret är inte "jag har testat", utan "det är omöjligt, här är
constrainten".

Indexet är **partiellt** så att en återbetald eller ogiltigförklarad biljett inte blockerar
stolen för alltid. Garantin är lika stark: två *giltiga* biljetter går fortfarande inte.

### Varför `oversell_prevented_total` och inte `oversell_total`?

En räknare för "översäljning inträffade" kan aldrig öka, eftersom constrainten gör det
omöjligt, och en metrik som aldrig kan ändras bevisar ingenting. `oversell_prevented_total`
ökar när ett insert på `tickets` faller på unique violation, alltså när databasen fångade något
applikationslogiken släppte igenom. Den visar hur ofta sista försvarslinjen behövdes.

### Varför är `tickets` skild från `orders`?

En order är en affärshändelse ("betalade 1 500 kr för tre stolar"). En biljett är en
inträdeshandling: en per stol, egen QR-kod, egen skanning. Tre stolar blir en order och tre
biljetter, eftersom två kan ges bort till vänner som kommer separat.

### Varför är `seats.status` lagrad och inte härledd?

Stolsstatus är systemets mest lästa data (alla tittande klienter, var 2:a sekund). En SELECT
på en indexerad statuskolumn är mycket snabbare än en join mot reservationer med
tidsjämförelse. Kolumnen uppdateras i samma transaktion som redan låser stolen, och invarianten
mot `reservations` testas.

### Varför jitter på frisläppandet?

Reservationer skapas i vågor och löper ut i vågor. Utan jitter blir många stolar lediga i
samma millisekund, alla ser det samtidigt och tusentals försöker ta samma stol, en
självförvållad spik var femte minut. Innehavaren behåller exakt 5:00, bara frisläppandet sprids
över 0–20 s.

### Varför idempotensnycklar, och varför scopade på anroparen?

Användaren klickar "Betala", servern gör jobbet, men svaret kommer aldrig fram. Webbläsaren
skickar igen och utan skydd blir det en andra order. Klienten skickar därför samma UUID vid
omförsök. Servern INSERT:ar nyckeln (unique): lyckas det är det första gången och svaret sparas,
annars returneras det sparade svaret. Samma princip som Stripes `Idempotency-Key`.

Nyckeln är unik per `(event, principal, operation)`. Utan scope kan den som gissar en nyckel få
tillbaka någon annans sparade svar med orderdata. Samtidiga försök medan den första fortfarande
kör får **409**, inte ett tomt svar. Därför asserterar testet `1 × 200 + 9 × 409`.

### Varför transactional outbox?

Postgres och RabbitMQ kan inte skrivas atomärt. Committas ordern samtidigt som RabbitMQ är
nere försvinner bekräftelsen. Därför skrivs meddelandet till `outbox` i samma transaktion som
ordern, och en relay publicerar det efteråt. Är RabbitMQ nere ligger det kvar.

### Varför måste konsumenterna vara idempotenta?

RabbitMQ garanterar at-least-once, och relayn kan publicera och krascha innan raden markeras.
Dubbletter är alltså garanterade över tid. Dedupe nivåindelas efter konsekvens: en dubbel
biljett är allvarlig (tabell med unique), ett dubbelt mejl är irriterande (Redis-set med TTL).

### Varför dead-letter-köer?

Utan dem försvinner ett meddelande som nått delivery limit, eller så redelivereras det för
evigt och KEDA skalar upp kraschande poddar. Nu hamnar det i `<kö>.dead`, syns i Grafana och
ger ett Slack-larm, och kan spelas upp igen. Två saker upptäcktes på vägen: RabbitMQ 4 räknar
inte `nack requeue=true` mot delivery limit (konsumenten räknar därför själv), och policyerna
importeras av en `postStart`-hook eftersom `load_definitions` kraschade RabbitMQs boot.

### Vad händer om betalningen kommer efter att reservationen löpt ut?

Det enda stället där riktiga pengar kan försvinna. Två mekanismer:

1. **Frysning:** när Checkout skapas går reservationen till `pending_payment` och slutar räkna
   ner, med ett eget tak och en aktiv Checkout per kötoken, så frysningen inte blir ett sätt att
   hålla stolar gratis
2. **Automatisk återbetalning:** kommer betalningen ändå efter taket återbetalas den med ett
   förklarande mejl

Frysningen löser normalfallet, återbetalningen täcker att även frysningen kan ta slut
(fördröjda Stripe-retries, en flik som lämnats öppen).

### Vilken gräns dras medvetet INTE?

Stolar, ordrar och betalningar delas inte upp i egna tjänster med egna databaser. Kärnan är att
reservationen sker i **en ACID-transaktion**. Sprids den över tjänstegränser krävs sagor med
kompensation, och just den garanti vi vill visa går förlorad.

---

## 2. Väntrum, realtid och botskydd

### Varför virtuellt väntrum?

- **Förutsägbar last:** insläppstakten styr backend-lasten oavsett hur många som kommer
- **Takt + sessionstid, inte bara tak:** ett tak kan få kön att stanna om folk sitter och
  funderar. Med takt rör sig kön alltid, och sessionstiden begränsar ändå hur många som är inne
- Mönstret är etablerat (Queue-it är en hel produkt kring det)

**Bokningsfönstret räknas från insläppet.** Kötokenen är signerad och stateless, så dess `exp` sätts vid
join och kan inte skrivas om. Hade `exp` varit hela sessionen hade den som väntat 14 av 15 minuter fått en
minut att boka. Därför har insläppet en egen klocka (10 min) som ligger i Redis: nyckelns värde är slutdatumet
och varje förnyelse klipps mot det. Tokenens `exp` räcker för kötid + fönster + 15 min för håll och
betalningsfrysning, så en kund som reserverar i fönstrets sista minut ändå hinner betala.

**Direktinsläpp** lades till efter att UI:t testats: en ensam köpare ska inte se ett väntrum.
Är kön tom och färre än 1 000 insläppta går man in direkt, annars köar man som vanligt.
Avgörs atomärt i Redis, så FIFO-ordningen bryts aldrig. Gränsen ändras i `config` utan deploy.

### Varför är kötoken signerad och stateless?

Reservationer binds till kötoken. Hade token bara funnits i Redis hade en Redis-omstart mitt i
försäljningen gjort alla köplatser och alla pågående reservationer omöjliga att slutföra.
Nu är signaturen tillräcklig för validering, och Redis används bara till revokering och
aktivitet. Resten av Redis-användningen tål en omstart (cache byggs om, rate limits nollställs).

### Varför polling för kartan och inte WebSockets?

Kostnaden för push är `ändringar/sek × anslutna klienter`. 20 000 tittare och 500
reservationer per sekund blir 10 miljoner meddelanden per sekund. Kartan är ett-till-många,
och där vinner cache över push: med 1 s cache vid Cloudflares kant ser klustret ungefär samma
antal requests oavsett om 200 eller 20 000 pollar.

**Tumregel:** WebSocket för ett-till-ett (köplats, insläpp, "din stol togs"), cache och
polling för ett-till-många.

### Varför är WebSocket aldrig enda leveransvägen?

Redis Pub/Sub är fire-and-forget. Startar gatewayen om i samma sekund som ett insläpp
publiceras försvinner meddelandet, men insläppsplatsen är förbrukad. Därför motsvaras varje
WS-meddelande av tillstånd klienten kan läsa om (`GET /queue/status`, `GET /reservations/:id`).
Det löser också att nedräkningen hamnar ur synk när anslutningen tappas.

### Varför Redis Pub/Sub, och varför en egen gateway-tjänst?

En WebSocket ligger på en viss gateway-podd, men händelsen uppstår i en annan booking-api-podd.
booking-api publicerar på Redis och den gateway som håller anslutningen skickar vidare. Varje
gateway-podd har en enda delad prenumeration, inte en per klient.

Gatewayen är egen tjänst för att den har en annan skalningsprofil (minne och anslutningar, inte
CPU) och för att en deploy av API:t annars hade kapat alla WebSocket-anslutningar.

### Varför inloggning först vid betalning?

Lägst friktion, och lasttestet behöver bara tokens för dem som faktiskt betalar. Konsekvensen
är att en anonym session kan hålla stolar (denial of inventory). Motåtgärden är en aktiv
reservation per kötoken plus botskyddet, så skyddet flyttas till att göra kötokens dyra att
skaffa.

### Varför adaptivt botskydd med proof of work och Turnstile?

Proof of work är asymmetriskt: klienten bränner ~0,3 s CPU, servern verifierar med en hashning.
Riktiga användare märker nästan inget, en bot med 10 000 köplatser betalar 10 000 × 0,3 s.

Turnstile och PoW på varje användare hade lagt till en halv sekund eller mer innan någon kommer
in i kön, och Turnstile är ett externt beroende. Därför eskalerar vi: inga signaler → ingen
utmaning, svag signal → osynlig PoW, stark signal → Turnstile. Turnstile är fail-closed bara på
den högsta nivån, så normalvägen har inget externt beroende.

IP-volymsignalerna räknas som **en** signal, så ett klassrum eller ett CGNAT-nät ensamt bara
får PoW. Allt ligger i `config` med en kill switch, och lasttestet går förbi med en hemlig header.

### Varför måste rate limitern läsa `CF-Connecting-IP`, och bara från Cloudflare?

Bakom Cloudflare ser varje request ut att komma från en CF-IP, så utan åtgärd räknas hela
världen som en användare. Att naivt lita på headern är värre: då kan vem som helst sätta den
till ett offers IP och låsa ute dem. Därför `use-forwarded-headers` med `proxy-real-ip-cidr` =
Cloudflares intervall.

### Varför allowlistas lastgeneratorerna?

Vårt IP-baserade skydd ser tusentals virtuella användare från några få maskiner som exakt det
angrepp det är byggt mot. Utan undantaget mäter testet rate limitern i stället för systemet.
Undantaget slås av och på med `loadtest-mode`, eftersom generatorernas IP:n lämnas tillbaka till
Hetzner och kan hamna hos någon annan.

### Varför gula stolar för andras reservationer?

De flesta biljettsajter visar andras reservationer som otillgängliga, troligen för att folk
annars sitter och väntar på dem. Vi visar dem gula med randning: det visar att hold-mekanismen
arbetar, vilket är projektets tekniskt mest intressanta del.

---

## 3. Data

### Varför sharding per event, och `event_id` på varje tabell?

All bokning sker inom ett event, så en bokning korsar aldrig en shard och ACID-transaktionen
behålls. Routinglagret måste veta shard **innan** frågan ställs, och kan inte slå upp en
förälder först (den ligger också på en shard). Därför bär varje shardad tabell `event_id`.

### Vad gör man med data som saknar shard-nyckel?

`users`, `venues` och `config` hör inte till ett event och ligger globalt på shard-0.
`orders.user_id` saknar FK, eftersom främmande nycklar inte fungerar över databasgränser.
"Mina biljetter" hämtas med scatter-gather från båda shardarna.

### Varför anonymisering i stället för radering?

Bokföringslagen kräver 7 års bevarande, och en hård radering förstör giltiga biljetter till
kommande events. Personuppgifterna i `users` nollas och `orders`/`payments` behålls med ett
anonymiserat `user_id`. GDPR art. 17(3)(b) tillåter det när en rättslig förpliktelse kräver
bevarande.

### Vad är RPO och RTO, och räcker det?

RPO upp till 24 h (nattlig `pg_dump`), RTO uppmätt i återställningsövningen till ca 3 s för
hämtning och restore plus några minuters manuellt arbete. 24 h är **otillräckligt för riktig
biljettförsäljning**, där allt händer inom 15 minuter. Point-in-time recovery med
WAL-arkivering hade gett sekunder, till priset av mer lagring och drift. Ett medvetet val för
projektets omfattning, dokumenterat i runbooken.

Övningen var värd att göra: den visade att nattens backup aldrig nått R2 (rclone försökte skapa
bucketen och fick 403). Fixat med `--s3-no-check-bucket`.

---

## 4. Kod och tester

### Varför två separata workers?

De kräver motsatt antal repliker. `scheduler-worker` måste vara exakt en, annars släpps tre
gånger så många in. `notification-worker` måste kunna vara många och skalas av KEDA.

### Varför Zod när Fastify har JSON Schema?

Zod ersätter inte Fastifys validering, det är hur schemat skrivs. Handskrivet JSON Schema kräver
en separat TypeScript-typ, och de två glider isär tyst. Med Zod blir det **ett schema** för både
validering och typer, delat mellan backend och frontend via `shared/schemas`.

### Varför en egen felhierarki (`BaseError`)?

Den yttersta felhanteraren vet alltid att den kan läsa `httpStatus`, `code` och
`isOperational`. `isOperational` skiljer **förväntade** fel ("stolen är upptagen", tusentals
gånger per försäljning) från **oväntade** buggar. Förväntade fel larmar inte, oväntade larmar
direkt. Utan skillnaden blir larmkanalen brus, och då slutar man läsa den.

### Varför Testcontainers och inte mockad databas?

Kärnan i projektet är hur Postgres beter sig vid samtidiga lås. En mockad databas testar inget
av det som är svårt. Testcontainers ger dessutom samma beteende lokalt och i CI.

### Vad fångar Pact, och vad fångar det inte?

Pact fångar att formen på ett svar ändras så att en konsument går sönder (ett fält byter namn,
en statuskod ändras). Det fångar **inte** driftkonfiguration: när betalningarna slutade
fungera under lasttestet var det för att booking-api och payment-mock hade olika
webhook-hemligheter, och kontraktet var oförändrat. Det fångas av `loadtest-mode`s kontroll att
ordrarna faktiskt blir `paid`. Därför finns båda lagren. Ingen broker behövs i ett monorepo.

### Varför systemtester utöver e2e?

e2e testar UI:t i en webbläsare. Systemtesterna testar beteende och data utifrån: bara publikt
HTTP-API och läsande SQL, och de får inte importera från koden (ESLint-regel). Byts
implementationen ut men beteendet är detsamma ska de vara gröna utan ändringar.

### Varför ett regressionstest för lagergränserna?

En granskning visade att `eslint-plugin-boundaries` inte bevakade något alls. Orsaken: hela
kodbasen importerar `.ts`-filer som `.js` (Node-ESM), pluginet kunde inte slå upp dem och hoppade
tyst över alla okända mål. Lösningen var en TypeScript-medveten resolver. Eftersom `pnpm lint`
är lika grönt oavsett om regeln fungerar eller inte, skriver
`scripts/verify-boundaries-enforcement.mjs` en avsiktlig överträdelse och failar om den inte
flaggas.

### Varför får AI-verktyget aldrig committa, pusha eller merga?

All historik i ett projekt som försvaras individuellt måste gå genom en person som kan stå för
varje ändring. En hård spärr (`rules.md` §12), inte en rekommendation.

---

## 5. Kubernetes och drift

### Varför kräver zero-downtime fyra saker?

`RollingUpdate` ensamt tappar requests:

1. **Readiness probe** — annars går trafik till poddar som inte har startat
2. **`maxUnavailable: 0`** — nya poddar upp innan gamla tas ner
3. **`preStop` + grace period** — vid SIGTERM vet ingress ännu inte att podden ska dö
4. **Graceful shutdown** — sluta ta emot nya, slutför pågående, stäng pooler

Plus automatisk återanslutning med backoff för WebSocket-klienterna.

### Varför bevisades zero-downtime med `rollout restart` och inte en merge?

Beviset kördes med `loadtest-mode on`, som lägger `STRIPE_WEBHOOK_SECRET` som literal i
Deployment:en. Pipelinens `kubectl apply` lägger då basfilens `valueFrom` ovanpå och failar. En
`rollout restart` är exakt samma mekanism: samma probes, samma `maxUnavailable: 0`, samma
dränering. Det enda som skiljer är vad som startar rollouten. Begränsning att nämna:
pipelinens egna steg (migrations-Job, `apply`) ingår inte i mätningen.

Resultat: 0 misslyckade av 22 978 requests, 0 ingress-5xx, två rollouter.

### Varför får `livenessProbe` inte kontrollera beroenden?

Readiness svarar på "kan podden ta trafik nu" och ska kontrollera Postgres och Redis. Liveness
svarar på "ska podden startas om". Kontrollerar den databasen startar Kubernetes om **alla**
poddar samtidigt när Postgres hickar, precis när systemet är mest pressat.

### Varför garanterar inte `replicas: 1` att scheduler-workern är ensam?

RollingUpdate har `maxSurge: 25 %`, som avrundas uppåt till 1, så två schemaläggare kör
samtidigt under varje deploy. Därför `strategy: Recreate` och ett Postgres advisory lock vid
start. Korrektheten ska inte vila på Kubernetes schemaläggning.

### Varför körs migrations som ett Job och inte som init-container?

En init-container körs av varje podd, och 2–6 repliker hade tävlat om att migrera. Ett Job med
advisory lock mot båda shardarna gör det till en operation, och pipelinen avbryter om det
misslyckas. Därför måste migrationer också vara additiva: de körs innan den nya koden rullas ut.

### Varför `requests: 250m` på booking-api?

HPA räknar mot requests, inte limits. Med 100m visar en podd som drar 350m hela 350 % och
hoppar direkt till 10 repliker. Med 250m request och 500m limit blir kurvan gradvis.

### Varför är `scaleDown`-fönstret 300 s och inte 60 s?

Planen var 60 s för att nedskalningen skulle synas i demon. I lasttestet visade det sig farligt:
en kort dipp i CPU fick HPA:n att skala ner flera repliker mitt i pågående köp, vilket gav en
våg av "connection reset". 300 s (Kubernetes standard) är trögt men stabilt. Inför en demo
sänks det tillfälligt till 60 s med `kubectl patch` och återställs efteråt.

### Varför KEDA och inte bara HPA?

`notification-worker` kan ha tusentals meddelanden i kö och ändå ligga på 3 % CPU eftersom den
väntar på nätverk. HPA skulle se "allt lugnt". KEDA skalar på RabbitMQ-ködjup (100 per podd,
1–4 poddar).

### Varför lovas inte nedskalning för realtime-gateway?

Node återlämnar inte minne till OS:et, så en minnesbaserad HPA skalar i praktiken aldrig ner.
Och att skala ner en WebSocket-gateway dödar aktiva anslutningar. Upp och ner visas på
booking-api, där skalningen är CPU-baserad.

### Varför demonstreras inte nodskalning?

ingress-nginx är DaemonSet och Cloudflare pekar på specifika nod-IP:n, så en ny nod får ingen
trafik förrän DNS uppdaterats. VG-kravet gäller antalet instanser, vilket HPA och KEDA sköter.
Demonoderna är en egen Terraform-resurs, så att skala dem inte rör control plane-noden.

### Varför nätverksvolymer och inte k3s standardlagring?

k3s `local-path` binder volymen till en nod. Då blir "döda shard-1" ett avbrottstest i stället
för failover, och en förlorad nod tar datan med sig. Hetzner CSI ger volymer som följer podden.
`storageClassName` skrivs ut explicit. Postgres har dessutom `startupProbe` (WAL-återuppspelning
får ta tid utan att liveness dödar den) och anti-affinity så shardarna föredrar olika noder.

### Varför PDB med `maxUnavailable: 1` på tjänster med en podd?

`minAvailable: 1` kan aldrig uppfyllas med en podd, så `kubectl drain` hade hängt. `maxUnavailable: 1`
gör idag samma sak som ingen PDB, men visar att valet är medvetet och börjar skydda automatiskt
om tjänsten får fler repliker.

### Varför togs staging-overlayn bort?

Den var en exakt kopia av base, med samma host och namnrymder. Applicerad av misstag hade den
skrivit över produktionen. En riktig staging behöver egna secrets, databas och värdnamn, och
läggs till den dagen den behövs.

---

## 6. Infrastruktur och nätverk

### Varför infrastruktur först (walking skeleton)?

Bokningslogiken går att felsöka lokalt. Det riskabla är DNS, TLS, Kubernetes-nätverk och
secrets i CI, som går sönder på sätt som tar timmar och inte går att skynda på. Med en "hello
world" genom hela kedjan först var G-kravet om automatisk deploy klart första veckan, och
infraproblemen dök upp medan det fanns marginal.

### Varför k3s på Hetzner och inte managed Kubernetes?

Kostnad och kontroll. Två små noder räcker i vardagen, och uppgiften kräver egen VPS. Priset är
att vi själva äger det managed-tjänster sköter: certifikat, lagring, nätverk och uppgraderingar
(se ADR-0006).

### Varför DNS round robin och ingen load balancer framför noderna?

Cloudflare pekar på nodernas IP:n och ingress-nginx körs på varje nod. Det sparar en extern LB,
men Cloudflare Free gör inga hälsokontroller, så en död nod får fortsatt trafik. Därför dödas
bara poddar i demon, aldrig noder (ADR-0007). Lastbalanseringen mellan instanser sker i
Kubernetes Service, och det är där VG-kravet "bakom en load balancer" uppfylls.

### Varför har noden en publik IP?

Utan managed LB måste noden som kör ingress vara nåbar. Men publik betyder inte öppen: bara 443
från Cloudflares intervall, SSH bara från egen IP, datatjänsterna är ClusterIP. Den enda vägen in
är Cloudflare → ingress-nginx.

### Varför öppnas 6443 aldrig publikt, inte ens mot ett Tailscale-intervall?

Tailscale-trafik går i en krypterad WireGuard-tunnel. Hetzners brandvägg ser bara UDP-paket på
Tailscales port och vet inte att det finns en 6443-anslutning inuti, så en regel för port 6443
mot ett Tailscale-CIDR gör ingenting. Control plane-noden går i stället med i tailnet, och både
lokal kubectl och CI når API:t via Tailscale. 6443 kan då strykas helt.

Tailscale körs utan `--ssh` (default-ACL:en hade gett CI-köraren root-SSH på noden) och med
`--accept-dns=false` (annars hade all DNS i klustret tyst berott på att `tailscaled` kör).
kubeconfig pekar på nodens Tailscale-IP, inte MagicDNS-namnet, eftersom en riven nod ligger kvar
i tailnet och namnet då pekar på fel maskin.

### Varför DNS-01 och inte HTTP-01?

HTTP-01 genom Cloudflare i Full (strict) har ett hönan-och-ägget-problem: Cloudflare kräver ett
giltigt origin-cert för att nå origin, men det är just det certet som ska hämtas. DNS-01 kräver
ingen port 80 (matchar brandväggen) och ger wildcard. Let's Encrypt staging användes tills
kedjan var stabil, eftersom upprepade `destroy/apply` annars bränner rate limiten. Cloudflares
SSL-läge följde samma flagga (Full under staging, Full strict i produktion), annars hade varje
request fått 526.

### Varför två Cloudflare-tokens?

Terraform behöver breda rättigheter (SSL-läge, Cache Rules, Workers). cert-manager i klustret
behöver bara DNS:Edit. Med en delad token hade en podd kunnat ändra zonens SSL-läge. Rätt mängd
access för den som faktiskt använder den.

### Varför äger Terraform inte applikationens manifest, och varför committas statefilen aldrig?

Manifesten ändras vid varje merge, och Terraform hade sett ständig drift i poddar som startar och
dör. Gränsen: ändras det vid varje merge eller inte. Statefilen innehåller hemligheter i klartext
och repot är publikt, så den är `.gitignore`:ad och säkerhetskopieras utanför repot.

### Varför ligger CDN, TLS, identitet och betalning utanför VPS:en?

Applikationen, databaserna, kön, cachen och observability kör på vår VPS. Cloudflare (TLS, cache),
Auth0 och Stripe ligger utanför, för att det är så det görs i praktiken. Stripe håller oss utanför
PCI DSS och Cloudflare tar fan-out som en enskild VPS inte klarar.

### Varför cachas eventlistan i Redis och inte vid kanten?

Svaret har en CORS-header som beror på anroparens `Origin`, listan anropas från två origins
(webb och scanner), och Cloudflare följer inte `Vary: Origin`. Ett kantcachat svar kunde alltså
serveras med fel header. Därför 10 s cache i Redis (fail-open). De anonyma kantcachade routes
(stolsstatus, geometri, sektionssammanfattning) sätter i stället `Access-Control-Allow-Origin: *`,
eftersom svaret är samma för alla och API:t aldrig använder cookies. Kill switch:
`API_CACHE_MAX_AGE_SECONDS=0`.

### Varför bara vitlistade prefix i cdn-Workern?

Samma R2-bucket håller frontenden och databasbackuperna. En vanlig R2 Custom Domain hade gjort
hela bucketen publik, backuperna inräknade. Workern läser bara `images/` och `brand/`, allt annat
ger 404, och ett test visar att `/backups/…` och `../` inte går igenom.

### Varför CPX22 i stället för CX22?

Nya Hetzner-konton får inte alltid cx-serien. CPX22 har samma specifikation (2 vCPU, 4 GB) under
ett annat namn, så arkitekturen påverkas inte.

### Lärdomar från bootstrap av klustret

Fel som var tysta och tog tid att hitta, värda att kunna berätta om:

- **Privat nätverk:** Hetzners cloud-init konfigurerar bara det publika interfacet. Utan egen
  netplan-fil startade k3s-agenten aldrig, medan API-servern svarade "No resources found".
  cloud-init sätter nu upp nätet själv och avbryter med `exit 1` om adressen saknas
- **`providerID`:** k3s sätter `k3s://<namn>`, som Hetzners CCM inte förstår, och fältet går inte
  att ändra efter registrering. cloud-init skickar `hcloud://<id>` från början
- **`disable: [cloud-controller]`** ignoreras tyst av k3s. Rätt flagga är
  `disable-cloud-controller: true`
- **ClusterIssuers** skapas med `kubectl apply`, eftersom `kubernetes_manifest` kräver att CRD:n
  finns redan vid `plan`
- **Inklistrade nycklar** kan bära ett osynligt `\r` som bryter YAML:en i cloud-init, därför
  saneras de i Terraform
- **Loki** hade multi-tenancy på som standard och avvisade varje loggbatch med 401, så inga loggar
  sparades. Fixat med `auth_enabled = false` och ett larm om Alloy tappar loggrader

---

## 7. Observability och analys

### Hur fungerar Prometheus?

Pull: varje tjänst exponerar `GET /metrics` (via `prom-client`) och Prometheus hämtar var 15:e
sekund. Poddarna hittas via `ServiceMonitor`. Komponenter som inte talar Prometheus själva får en
exporter (`postgres-exporter`, `redis-exporter`). RabbitMQ har en inbyggd plugin.

### Varför finns det ingen tracing?

Metrics säger *att* ett anrop tog 8 s, och loggar säger *vad* som hände. Ett trace hade visat var
tiden gick för en enskild request. OpenTelemetry fanns i alla tjänster, men lasttestet visade priset:
varje anrop blev flera spans (HTTP, Postgres, Redis, RabbitMQ, nätverk), till 100 %, och skickades till
Alloy utan att någon backend tog emot dem. Det åt CPU på två små noder precis när systemet behövde den
som mest. Tracing togs därför bort helt (docs/loadtest-cpu-plan.md steg 1). Mått i Prometheus och
loggar i Loki räcker för det här systemets felsökning. Behövs traces igen är rätt sätt att sampla redan
i tjänsterna (till exempel 1–10 %) och ha en backend som tar emot dem.

### Varför skickas `payment_succeeded` från servern?

Användaren kan stänga fliken innan webbläsaren hinner skicka, och adblockers stoppar en del
klienthändelser. Kritiska konverteringshändelser skickas därför från servern, exakt en gång.

### Hur hanteras integritet i PostHog?

EU-regionen via en egen proxy (`/ingest`) i apex-Workern. Cookielöst tills användaren godkänt.
`distinct_id` är Auth0 `sub`, aldrig e-post eller namn. Feature flaggor utvärderas bara efter
samtycke, annars hade varianten bytts vid varje sidladdning. Session replay är maskerad och
också bara efter samtycke.

### Varför tre redaction-djup i loggern?

`fast-redact` har inget rekursivt jokertecken: `*.password` matchar bara en nivå ner. Därför
genereras fältlistan på tre djup. Verifierat med riktiga loggrader, vilket också visade att
Fastify loggade `remoteAddress` i klartext, så den maskeras nu.

---

## 8. Klienter

### Varför TanStack Query?

Polling för hand kräver intervall, städning, laddnings- och feltillstånd, deduplicering,
backoff och **pausad polling när fliken är dold**. Det sista är inte kosmetiskt: utan det hamrar
alla bakgrundsflikar på API:et. Ungefär 150 rader kod blir tre rader konfiguration.

### Varför SVG och inte canvas för arenakartan?

Vi ritar en sektion i taget, några hundra stolar, långt under där SVG blir långsamt. SVG ger
riktiga fokuserbara element (tangentbord, `aria-label`), skalar skarpt vid zoom och går att
testa med Testing Library och Playwright. Canvas ger inget av det.

### Varför är scannern en webbapp och inte en Expo-app med client credentials?

Planen var en Expo-app som loggar in som maskin. Men kameran fungerar i mobilwebbläsaren över
HTTPS, och en webbapp får samma stack och pipeline som `apps/web`, utan app store. Personalen
loggar in med vanlig Auth0-inloggning och rollen `staff`, vilket dessutom ger spårbarhet per
person (ADR-0010).

QR-koden innehåller bara en HMAC och går inte att avkoda, så scannern slår upp `qr_token` inom
det valda eventets shard. "Fel event" och "ogiltig" ger därför samma svar. Unikt index på
`ticket_scans` gör att två samtidiga skanningar ger exakt en `ok`.

### Varför visar bekräftelsesidan "klart" först vid `paid`?

Att användaren kommer tillbaka från Stripe bevisar inget. Sidan pollar orderstatusen och säger
"klart" först när webhooken har bearbetats.

---

## 9. Ärliga svar om det som inte är byggt

- **NetworkPolicies saknas.** Datatjänsterna har ingen publik exponering, men poddarna i
  klustret är inte isolerade från varandra. Nästa steg är default-deny per namnrymd
- **Retention** finns bara för reservationer (30 dagar, timjobb). Outbox, `processed_messages` och idempotensnycklar rensas inte
- **Delad databas.** booking-api och scheduler-worker skriver båda till `reservations`, `seats` och
  `outbox`. Låsen och de unika indexen skyddar datan, men det bryter mot principen "en databas per
  tjänst": schemat är delat och tjänsterna måste ändras i takt. Scheduler-worker är i praktiken
  booking-apis bakgrundsdel (samma domän), därför valdes det. Renare vore att den anropar booking-api
  eller att jobben körs i booking-api med ledarval
- **Kösidan pollade länge i stället för att lyssna på WebSocket.** Servern skickade insläppet över
  WebSocket, men kösidan frågade `GET /queue/status` varannan sekund. Vid en stor kö blev det tiotusentals
  anrop per sekund, och lasttestet fick slut på CPU. Nu är WebSocket huvudvägen och polling var 15:e
  sekund bara reserv (docs/loadtest-cpu-plan.md steg 3)
- **Väntelistan** saknas (`waitlist`-tabellen används inte). Kön töms med besked vid slutsålt
- **Cache hit ratio vid kanten** är inte uppmätt, så påståendet om fan-out vilar på
  Cloudflares dokumenterade beteende
- **Radering av personuppgifter** finns som princip, inte som funktion
- **k3s 1.31 är EOL.** Uppgraderas efter försvaret, för riskabelt precis innan
- **RPO 24 h** och ingen PITR (se avsnitt 3)
- **Ingen staging-miljö**, ingen GitOps (ArgoCD) och inga Sealed Secrets
