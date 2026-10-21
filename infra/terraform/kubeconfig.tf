# Hämtar kubeconfig från control-plane-noden via SSH (port 22, publikt —
# oförändrat av Tailscale-bytet) och skriver den DIREKT till sin
# slutgiltiga plats (.kube/config), med 127.0.0.1 ersatt av nodens
# faktiska Tailscale-IP. Både lokal kubectl och CI når alltså
# API-servern över Tailscale — 6443 är aldrig öppen i den publika
# brandväggen (firewall.tf).
#
# Adressen är nodens Tailscale-IP, INTE dess MagicDNS-namn: en
# icke-ephemeral nod ligger kvar registrerad i tailnet efter att den
# rivits, så nästa nod med samma önskade namn får ett suffix
# ("tickets-cp-1-1"), medan MagicDNS fortsätter peka det ursprungliga
# namnet på den döda noden. Resultatet blir en kubeconfig som ser
# korrekt ut men pekar på en server som inte finns. IP:n läses därför av
# från den levande noden vid varje hämtning. Se docs/forsvar.md "Varför
# pekar kubeconfig på Tailscale-IP i stället för MagicDNS-namnet?".
#
# Skriver INTE via en Terraform-resurs som läser filen med file()/
# fileexists() — det mönstret ger ett "function returned an inconsistent
# result"-fel varje gång, eftersom Terraform inte kan garantera att en
# sidoeffekt-skapad fil är konsekvent mellan plan och apply. Skriptet
# äger hela filens livscykel, och providers.tf pekar på samma statiska
# sökväg direkt.
#
# VIKTIGT: din egen maskin måste vara ansluten till SAMMA tailnet innan
# helm/kubernetes-providers kan nå klustret. SSH-hämtningen nedan
# fungerar utan det (den går över publik IP), men "terraform apply" som
# helhet gör det inte. Se README.md i den här katalogen.
#
# Första "terraform apply" på ett helt nytt kluster kan behöva köras två
# gånger: providers läser filen när de initieras, innan resursgrafen
# exekveras, så filen måste redan finnas från ett tidigare försök.
resource "null_resource" "fetch_kubeconfig" {
  depends_on = [hcloud_server.control_plane]

  triggers = {
    control_plane_id = hcloud_server.control_plane.id
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      SSH_TARGET="root@${hcloud_server.control_plane.ipv4_address}"

      # Rensar en ev. gammal SSH-värdnyckel för den här IP:n innan vi
      # ansluter. Hetzner återanvänder ofta samma IP när en nod rivs och
      # återskapas, men den nya noden har en ny, slumpmässigt genererad
      # värdnyckel — SSH ser då en "ändrad" värd och vägrar ansluta.
      # Säkert här eftersom IP:n tillhör en server vi själva precis
      # skapade via Terraform, inte en okänd host.
      ssh-keygen -R "${hcloud_server.control_plane.ipv4_address}" >/dev/null 2>&1 || true

      SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=5"

      found=0
      for i in $(seq 1 60); do
        if ssh $SSH_OPTS "$SSH_TARGET" 'test -f /etc/rancher/k3s/k3s.yaml'; then
          found=1
          break
        fi
        sleep 10
      done
      if [ "$found" -ne 1 ]; then
        echo "k3s.yaml dök aldrig upp på noden inom tidsgränsen (10 min)." >&2
        echo "Felsök genom att SSH:a in manuellt och köra:" >&2
        echo "  ssh $SSH_TARGET 'cloud-init status --long; tail -100 /var/log/cloud-init-output.log'" >&2
        exit 1
      fi

      # Nodens Tailscale-IP läses av från noden själv, aldrig antagen.
      TS_IP=$(ssh $SSH_OPTS "$SSH_TARGET" 'tailscale ip -4 2>/dev/null | head -1' | tr -d '\r\n ')
      case "$TS_IP" in
        100.*) : ;;
        *)
          echo "Noden rapporterade ingen giltig Tailscale-IP (fick: '$TS_IP')." >&2
          echo "Kontrollera 'tailscale status' på noden — anslöt den till tailnet?" >&2
          exit 1
          ;;
      esac

      mkdir -p "${path.module}/.kube"
      ssh $SSH_OPTS "$SSH_TARGET" 'cat /etc/rancher/k3s/k3s.yaml' \
        | sed "s/127.0.0.1/$TS_IP/" \
        > "${path.module}/.kube/config"
      chmod 600 "${path.module}/.kube/config"
      echo "kubeconfig skriven, API-server: https://$TS_IP:6443"
    EOT
  }
}
