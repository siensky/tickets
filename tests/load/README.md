# tests/load

k6-scenarier (docs/plan.md "Lasttest"), byggda i **Fas 6**. Körs manuellt,
separat från CI-pipelinen — inte vid varje merge.

| Script                 | Vad det mäter                                                          |
| ---------------------- | ---------------------------------------------------------------------- |
| `smoke.js`             | 10 VU, hela flödet — körs FÖRST, innan en riktig körning               |
| `queue-storm.js`       | 50 000 VU ansluter inom 60 s — bara väntrummet                         |
| `normal-sale.js`       | **Betygsgrundande.** 50 000 bokningsförsök jämnt över 15 min           |
| `spike-sale.js`        | **Betygsgrundande.** ~50 000 bokningsförsök över 6 min, medvetet ojämn |
| `deploy-under-load.js` | normal-sale, kör en deploy manuellt under tiden                        |
| `shard-failure.js`     | normal-sale, döda shard-1-podden manuellt under tiden                  |

`lib/booking-flow.js` delar byggstenarna (join/väntrum/karta/reservation/
betalning) mellan scripten; `lib/config.js` läser miljövariabler.

## Köra ett scenario

```sh
k6 run -e BASE_URL=https://loadtest.tikknet.se \
       -e EVENT_ID=<uuid> \
       -e AUTH_TOKENS=<tok1,tok2,...> \
       tests/load/normal-sale.js
```

`EVENT_ID` måste redan ha sina 5 000 biljetter importerade. `AUTH_TOKENS`
— se docs/runbook.md "Lasttest: förutfärdade Auth0-tokens".

**Höj insläppstakten innan `normal-sale`/`spike-sale`** — se kommentaren
i normal-sale.js (`queue_admission_rate_per_minute` i config-tabellen).
Default (300/min) räcker för queue-storms engångsstorm, men inte för en
15 minuter lång, jämn ankomsttakt — utan åtgärd ackumuleras en
obegränsad kö och nästan alla VU:er väntar i onödan.

## Flera generator-VM:er (queue-storm/spike-sale)

`maxVUs` i queue-storm.js/spike-sale.js är dimensionerat PER MASKIN
(docs/plan.md "Lasttest": k6:s per-VU-modell för WebSockets är
minnestung vid 50 000 VU — en ensam generator klarar inte hela skalan).
Kör SAMMA script på varje generator-VM (`terraform output
loadgen_ipv4s`) med k6:s `--execution-segment`, så lasten delas i
stället för att mångdubblas:

```sh
# Maskin 1 av 3:
k6 run --execution-segment "0:1/3" --execution-segment-sequence "0,1/3,2/3,1" \
  -e ... tests/load/queue-storm.js
# Maskin 2 av 3:
k6 run --execution-segment "1/3:2/3" --execution-segment-sequence "0,1/3,2/3,1" \
  -e ... tests/load/queue-storm.js
# Maskin 3 av 3:
k6 run --execution-segment "2/3:1" --execution-segment-sequence "0,1/3,2/3,1" \
  -e ... tests/load/queue-storm.js
```

## Rapport och reset (normal-sale/spike-sale)

```sh
k6 run --summary-export=/tmp/k6-summary.json -e ... tests/load/normal-sale.js
# vänta tills outbox/RabbitMQ hunnit tömmas (notification-worker bearbetat
# alla ordrar) innan nästa steg — annars jobbar den fortfarande på rader
# som reset-sale precis raderade
cd services/scheduler-worker
pnpm run generate-sale-report -- <eventId> normal-sale /tmp/k6-summary.json <körningens längd i sekunder> /tmp/report.json
pnpm run reset-sale -- <eventId>   # ENDAST mellan normal-sale och spike-sale, manuellt
```

**Rate limitern** (docs/plan.md "Lasttest": "Lastgeneratorernas
CF-verifierade adresser allowlistas i rate limitern under testet") —
se docs/runbook.md "Lasttest: allowlista generatorernas IP:n i rate
limitern".
