# Fas 2 — Domänkärnan

**Status:** klar och mergad. Inget eget avsnitt i `phase-status.md` (filen började skrivas efter Fas 3).

## Mål

Projektets hjärta

## Omfattning

Planerat datum: 23–26/10.

**Domänkärnan.** Schema + migrations mot båda shardarna. Shard-router. Reservationstransaktionen (`release_after`, `now()` från Postgres). Idempotensnycklar med `event_id` + principal-scope. Outbox + relay i `scheduler-worker`. **De fyra kronjuveltesterna** + invariantkontrollen.

## Beroenden

Fas 1 klar.

## Berör

[`specification.md`](../specification.md): "Bokningskärnan", "Databas", "Tester".

## Implementationssteg

Fasen planerades som raden i fastabellen ("Omfattning" ovan), utan numrerade steg.

## Acceptanskriterier

Inte formulerat som egna kriterier när fasen byggdes. Målet ovan och kraven i
[`specification.md`](../specification.md) "Kraven och var de uppfylls" gäller.
