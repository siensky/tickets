# ADR-0008: Sharding per event

**Status:** Accepted
**Datum:** 2026-10-30

## Kontext

Uppgiften vill se hur databasen skalar under en bokningstopp. Kontention uppstår per event (samma
stolar), inte mellan events.

## Beslut

Två Postgres-instanser. Shard-nyckeln är `event_id`: ett routinglager (`shared/db/src/shard-router.ts`)
hashar eventets id till shard 0 eller 1. Globala tabeller (`users`, `venues`, `venue_sections`,
`venue_seats`, `config`) ligger på shard 0. Varje shardad tabell bär `event_id`, även när värdet går att
härleda, så att routinglagret alltid vet vilken shard en fråga ska till. Läsningar över alla events
("Mina biljetter", eventlistan) görs som scatter-gather med `Promise.allSettled`: en nedgången shard ger
ett partiellt svar, inte ett fel.

## Alternativ som övervägdes

- **En enda Postgres** — enklast, men ger ingen demonstration av skalning och en enda felpunkt.
- **Sharding på `user_id`** — avvisat: kontentionen sitter på stolarna, så en bokningstransaktion
  skulle då korsa shards.
- **Citus eller annan distribuerad databas** — för tungt för projektets storlek.

## Konsekvenser

Bokningstransaktionen (`SELECT ... FOR UPDATE NOWAIT` över ordnade stolar) rör alltid en shard och
behöver ingen distribuerad transaktion. Priset: migrations körs mot båda shards, backup tas av båda,
och globala tabeller på shard 0 är en gemensam felpunkt (`orders.user_id` är därför en UUID utan
främmande nyckel). Globala frågor går via `getGlobalPool(...)` (shard 0).
