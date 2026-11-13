#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu server (Oracle Cloud Always Free, or any VM).
#   curl -fsSL https://raw.githubusercontent.com/capricarun/school-tracker/main/deploy/oracle-setup.sh | bash
# Safe to run again: it updates the code and restarts the app.
set -euo pipefail

REPO="${REPO:-https://github.com/capricarun/school-tracker.git}"
DIR="$HOME/school-tracker"
ask() { local v; read -r -p "$1" v </dev/tty; printf '%s' "$v"; }

echo "== School Tracker server setup =="
DOMAIN="${DOMAIN:-$(ask 'Your DuckDNS address (e.g. arun-school.duckdns.org): ')}"
DUCK_TOKEN="${DUCK_TOKEN:-$(ask 'DuckDNS token (shown on duckdns.org; Enter to skip): ')}"
API_KEY="${ANTHROPIC_API_KEY:-$(ask 'Anthropic API key (Enter to use the free built-in date reader): ')}"
[ -n "$DOMAIN" ] || { echo "A domain is needed for HTTPS."; exit 1; }

echo "== Packages =="
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git curl cron iptables-persistent

echo "== Firewall: open 80/443 (Oracle images block them by default) =="
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    line="$(sudo iptables -L INPUT --line-numbers | awk '/REJECT/ {print $1; exit}')"
    if [ -n "$line" ]; then sudo iptables -I INPUT "$line" -p tcp --dport "$port" -j ACCEPT
    else sudo iptables -A INPUT -p tcp --dport "$port" -j ACCEPT; fi
  fi
done
sudo netfilter-persistent save

echo "== Docker =="
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"

if [ -n "$DUCK_TOKEN" ]; then
  echo "== DuckDNS: point $DOMAIN at this server and keep it updated =="
  sub="${DOMAIN%%.duckdns.org}"
  url="https://www.duckdns.org/update?domains=${sub}&token=${DUCK_TOKEN}&ip="
  curl -fsS "$url"; echo
  (crontab -l 2>/dev/null | grep -v duckdns.org || true; echo "*/5 * * * * curl -fsS '$url' >/dev/null 2>&1") | crontab -
fi

echo "== App code =="
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR"
[ -f .env ] || cp .env.example .env
set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
set_env DOMAIN "$DOMAIN"
set_env PUBLIC_URL "https://$DOMAIN"
set_env IMAGE "school-tracker:local"
[ -n "$API_KEY" ] && set_env ANTHROPIC_API_KEY "$API_KEY"
chmod 600 .env
chmod +x deploy/*.sh

echo "== Daily database backup at 3 AM (kept 14 days) =="
(crontab -l 2>/dev/null | grep -v deploy/backup.sh || true
 echo "0 3 * * * cd $DIR && ./deploy/backup.sh $HOME/backups >/dev/null 2>&1 && find $HOME/backups -name '*.db' -mtime +14 -delete") | crontab -

echo "== Build and start (first build takes a few minutes) =="
sudo docker compose up -d --build

echo
echo "Done. Open https://$DOMAIN on your phone (HTTPS can take a minute the first time)."
echo "Logs:   cd $DIR && sudo docker compose logs -f app"
echo "Update: run this script again, or: cd $DIR && git pull && sudo docker compose up -d --build"
echo "After creating your family, set ALLOW_SIGNUP=false in $DIR/.env and run: sudo docker compose up -d"
