# ADR-0003: cloud-init konfigurerar Hetzners privata nätverk, Tailscale SSH av

**Status:** Accepted
**Datum:** 2026-10-21

## Kontext

Hetzners cloud-init-datasource genererar nätverkskonfiguration ENDAST för det publika
interfacet. Ett privat nätverk kopplat till servern syns som ett NIC, men lämnas `DOWN` utan
adress — upptäckt genom att `kubectl get nodes` gav "No resources found" trots att api-servern
svarade (kubelet startade aldrig, `node-ip` pekade på en adress som inte fanns). Samtidigt
övervägdes `tailscale up --ssh` för nodfelsökning.

## Beslut

Båda cloud-init-mallarna (server och agent) konfigurerar det privata interfacet själva: MAC
slås upp via Hetzners metadata-tjänst, interfacet identifieras via MAC:en (aldrig hårdkodat
namn — `eth1`/`enp7s0`/`ens10` varierar med servertyp/image), en egen netplan-fil skrivs med
`mtu: 1450`. Bootstrappen avbryter synligt (`exit 1`) om adressen inte dyker upp.

`--ssh` (Tailscale SSH) används INTE — default-ACL:n ("*" → "*:*") hade gett alla enheter i
tailnet, inklusive CI-körarens `tag:ci`, root på noden. Vanlig SSH (publik 22,
`admin_ipv4_cidr`) räcker för felsökning.

## Alternativ som övervägdes

- **Hårdkoda interfacenamnet** (t.ex. `enp7s0`) — avvisat: verifierat att det varierar med
  servertyp/image; ett hårdkodat namn är en tidsinställd bugg vid nästa servertypsbyte.
- **Lita på att Hetzners cloud-init hinner konfigurera nätverket** — avvisat: verifierat live
  att det aldrig händer, oavsett väntetid.
- **En tailnet-ACL som begränsar `tag:ci` till `tcp:6443`** i stället för att ta bort `--ssh`
  helt — inte kodifierat (ingen Tailscale-provider i Terraform), men ett förberett muntligt
  svar om frågan kommer upp.

## Konsekvenser

Nätverksuppsättningen sker nu två gånger (publikt via Hetzners egen cloud-init, privat via
vår) i stället för att vara ett enhetligt steg — mer kod att underhålla, men den enda vägen
som faktiskt fungerar. Nodfelsökning utan publik SSH-nyckel till hands kräver `kubectl`
(räcker för det mesta) i stället för en rå skal. Se `docs/forsvar.md` "Varför konfigurerar
cloud-init Hetzners privata nätverk själv?" och "Varför --ssh och accept-dns inte används".
