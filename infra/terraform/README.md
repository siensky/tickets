# infra/terraform

Provisionerar Hetzner-infrastrukturen (noder, nätverk, brandvägg, CSI) och
klusterkomponenterna som sällan ändras (ingress-nginx, cert-manager). Se
[docs/plan.md](../../docs/plan.md) "Terraform" och
[docs/forsvar.md](../../docs/forsvar.md) för motiveringarna bakom varje val.

## Förutsättningar

Gjort enligt den manuella guiden du fått i chatten:

- Domän köpt och tillagd som en zon i Cloudflare
- Hetzner Cloud-konto + API-token (Read & Write)
- Cloudflare-konto + **två** API-tokens, med olika scope (se nedan)
- Tailscale-konto, med **två** auth-nycklar (se nedan)
- En SSH-nyckel (`ssh-keygen -t ed25519` om du inte redan har en)
- `terraform`, `helm`, `kubectl` installerade lokalt

### Två Cloudflare-tokens, inte en

`TF_VAR_cloudflare_api_token` (Terraform) och `TF_VAR_cloudflare_dns_token` (cert-manager i
klustret) har olika scope av samma skäl som de två Tailscale-nycklarna nedan har olika
inställningar — rätt mängd access för vad som faktiskt använder den, inte en gemensam,
överdimensionerad token.

| Token                          | Används av                      | Zon-rättigheter                                        | Miljövariabel                       |
| ------------------------------- | -------------------------------- | ------------------------------------------------------- | ------------------------------------ |
| `cloudflare_api_token`          | Terraform (denna maskin/CI apply) | DNS:Edit, Zone Settings:Edit, Cache Rules:Edit            | `TF_VAR_cloudflare_api_token`        |
| `cloudflare_dns_token`          | cert-manager (en secret i klustret) | **Endast** DNS:Edit                                      | `TF_VAR_cloudflare_dns_token`        |

Skapa båda i Cloudflare Dashboard → **My Profile → API Tokens → Create Token → Custom
token**, scopade mot din specifika zon. Den bredare token i klustret vore annars ett sätt för
en komprometterad podd att ändra zonens SSL-läge eller cache-regler, inte bara DNS-poster för
en ACME-utmaning. Se docs/forsvar.md "Varför två Cloudflare-tokens?".

### Två Tailscale-nycklar, inte en

Kubernetes-API:et (6443) exponeras aldrig i den publika brandväggen — all
åtkomst, både din egen kubectl och CI, går via Tailscale. Det kräver två
separata auth-nycklar med olika inställningar:

| Nyckel       | Används av                                  | Ephemeral                                           | Miljövariabel/secret                    |
| ------------ | ------------------------------------------- | --------------------------------------------------- | --------------------------------------- |
| Node-nyckeln | Control-plane-noden (ansluter permanent)    | **Av** — annars faller noden ur tailnet vid omstart | `TF_VAR_tailscale_node_authkey`         |
| CI-nyckeln   | GitHub Actions (ansluter bara under jobbet) | **På** — städas bort automatiskt                    | GitHub secret `TS_AUTHKEY` (redan satt) |

Skapa node-nyckeln likadant som CI-nyckeln (Tailscale admin console →
**Settings → Keys → Generate auth key**, Reusable: på) men med
**Ephemeral: av**.

**Din egen maskin måste också gå med i samma tailnet** innan du kör
`terraform apply` — installera Tailscale-appen och logga in med samma
konto. Det är bara SSH (port 22, publikt) som fungerar utan det; allt
som rör Kubernetes-API:et (inklusive `helm`/`kubernetes`-providers i
samma `apply`) kräver det.

## Körning

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# redigera terraform.tfvars: domain_name, letsencrypt_email, ssh_public_key, admin_ipv4_cidr

export TF_VAR_hcloud_token="..."
export TF_VAR_cloudflare_api_token="..."
export TF_VAR_cloudflare_dns_token="..."
export TF_VAR_tailscale_node_authkey="..."

terraform init
terraform plan
terraform apply
```

### Viktigt: första `apply` på ett helt nytt kluster kan behöva köras två gånger

`helm`- och `kubernetes`-providers läser `.kube/config` när providern
initieras, **innan** resursgrafen exekveras. På en helt ny klustret finns
den filen inte än — den skapas av `null_resource.fetch_kubeconfig` som en
del av samma `apply`. Terraform klarar normalt av detta (providers
konfigureras lat), men om du får ett fel om att kubeconfig-filen saknas
eller är tom: kör `terraform apply` igen. Andra körningen hittar filen
och fortsätter där den första slutade.

### Efter `apply`

```bash
export KUBECONFIG=$(terraform output -raw kubeconfig_path)
kubectl get nodes
```

(Kräver att din maskin är ansluten till tailnet — se ovan. Kubeconfig-
filens serveradress pekar på nodens Tailscale-IP — lästs av från noden
själv vid varje hämtning, inte på dess MagicDNS-hostname. Se
docs/forsvar.md "Varför pekar kubeconfig på Tailscale-IP i stället för
MagicDNS-namnet?" — en riven och återskapad nod håller sitt namn men inte
sin IP, och MagicDNS hade då pekat på en död nod.)

Noderna visas som `NotReady` eller med en `uninitialized`-taint tills
Hetzners Cloud Controller Manager (installeras av samma `apply`) har satt
`providerID` på dem — det är förväntat och löser sig inom någon minut.

### Riva infrastrukturen

```bash
terraform destroy
```

Kostar praktiskt taget ingenting att riva och återskapa — se
[docs/plan.md](../../docs/plan.md) "Kostnadsstrategi". DNS-posterna och
Cloudflare-inställningarna hanteras av samma `terraform destroy`/`apply`,
så en återskapad kluster pekas om automatiskt.

## Vad som INTE hanteras här

- **Applikationens manifest** (booking-api, Postgres, migrations-Job) —
  de ligger i [infra/k8s](../k8s) och appliceras av GitHub Actions vid
  varje merge till main, inte av Terraform. Se docs/plan.md "Terraform
  äger inte applikationens manifest".
- **KEDA och kube-prometheus-stack** — installeras här senare (Fas 3
  respektive Fas 4), inte i Fas 1.
