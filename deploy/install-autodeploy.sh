#!/usr/bin/env bash
# One-time, reviewed bootstrap. Does not change Caddy, application env, or data.
set -euo pipefail
REPOSITORY="${1:?Usage: install-autodeploy.sh OWNER/REPOSITORY [--enable]}"
ENABLE="${2:-}"
[[ "$REPOSITORY" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$ ]] || { echo 'Invalid repository'; exit 1; }
[[ -z "$ENABLE" || "$ENABLE" == '--enable' ]] || { echo 'Unknown option'; exit 1; }
[[ "$#" -le 2 && "$(id -u)" -eq 0 ]] || { echo 'Run as root with the documented arguments'; exit 1; }
SOURCE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
for file in update.py release_contract.py svoi-update.service svoi-update.timer; do
  [[ -f "$SOURCE/$file" && ! -L "$SOURCE/$file" ]] || { echo "Missing bootstrap file: $file"; exit 1; }
done
[[ -L /opt/svoi/current && -f /var/lib/svoi/svoi.sqlite ]] || { echo 'Existing Svoi installation required'; exit 1; }
/usr/bin/python3 - "$REPOSITORY" <<'PY'
import json, re, stat, subprocess, sys
from pathlib import Path
if sys.version_info < (3, 10):
    raise SystemExit('Python 3.10 or newer required')
directories = ['/opt/svoi', '/opt/svoi/releases', '/opt/svoi/.staging', '/usr/local/lib/svoi', '/var/lib/svoi-deploy', '/var/lib/svoi-deploy/backups', '/etc/svoi']
files = ['/etc/svoi/autodeploy.json', '/usr/local/lib/svoi/update.py', '/usr/local/lib/svoi/release_contract.py', '/etc/systemd/system/svoi-update.service', '/etc/systemd/system/svoi-update.timer']
for name in directories + files:
    path = Path(name)
    if not path.exists() and not path.is_symlink():
        continue
    info = path.lstat()
    valid_type = stat.S_ISDIR(info.st_mode) if name in directories else stat.S_ISREG(info.st_mode)
    if not valid_type or path.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
        raise SystemExit('Unsafe existing bootstrap path: '+name)
current = Path('/opt/svoi/current').resolve(strict=True)
if current.parent != Path('/opt/svoi/releases'):
    raise SystemExit('Current release is outside /opt/svoi/releases')
config = Path('/etc/svoi/autodeploy.json')
if config.exists() and json.loads(config.read_text()) != {'repository':sys.argv[1]}:
    raise SystemExit('Existing repository configuration differs; review manually before reinstalling')
version = subprocess.check_output(['/usr/bin/node','--version'],text=True).strip()
match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)',version)
if not match or tuple(map(int,match.groups())) < (22,22,0):
    raise SystemExit('Node.js 22.22.0 or newer required')
PY
for service in svoi-web.service svoi-bot.service; do
  [[ "$(systemctl show "$service" --property=User --value)" == 'svoi' ]] || { echo "$service must run as svoi"; exit 1; }
done
for directory in /usr/local/lib/svoi /var/lib/svoi-deploy /opt/svoi /opt/svoi/releases /opt/svoi/.staging /var/lib/svoi-deploy/backups /etc/svoi; do
  [[ ! -L "$directory" ]] || { echo 'Unexpected symlink in control directories'; exit 1; }
done
install -d -m 0755 -o root -g root /usr/local/lib/svoi /opt/svoi/releases
install -d -m 0700 -o root -g root /var/lib/svoi-deploy /opt/svoi/.staging /var/lib/svoi-deploy/backups
[[ -d /etc/svoi ]] || install -d -m 0750 -o root -g root /etc/svoi
install -m 0644 -o root -g root "$SOURCE/update.py" /usr/local/lib/svoi/update.py
install -m 0644 -o root -g root "$SOURCE/release_contract.py" /usr/local/lib/svoi/release_contract.py
/usr/bin/python3 - "$REPOSITORY" <<'PY'
import json, os, sys
from pathlib import Path
path = Path('/etc/svoi/autodeploy.json')
value = {'repository': sys.argv[1]}
if path.exists():
    if path.is_symlink() or json.loads(path.read_text()) != value:
        raise SystemExit('Existing updater config differs; review it manually. Config was not overwritten.')
else:
    with path.open('x') as stream:
        json.dump(value, stream)
    os.chmod(path, 0o600)
PY
install -m 0644 -o root -g root "$SOURCE/svoi-update.service" /etc/systemd/system/svoi-update.service
install -m 0644 -o root -g root "$SOURCE/svoi-update.timer" /etc/systemd/system/svoi-update.timer
# The previous daily timer executed backup.py from the active release as root.
# Pin that trusted maintenance operation outside all automatically updated code.
install -d -m 0755 -o root -g root /etc/systemd/system/svoi-backup.service.d
cat > /etc/systemd/system/svoi-backup.service.d/10-fixed-backup.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=/usr/bin/python3 -Es /usr/local/lib/svoi/update.py --backup-only
ReadWritePaths=
ReadWritePaths=/var/lib/svoi-deploy/backups
UNIT
systemctl daemon-reload
if [[ "$ENABLE" == '--enable' ]]; then
  systemctl enable --now svoi-update.timer
fi
printf 'Bootstrap installed for %s. Application env, SQLite and Caddy were not changed.\n' "$REPOSITORY"
printf 'Inspect: systemctl cat svoi-update.service svoi-backup.service\n'
printf 'Enable: systemctl enable --now svoi-update.timer\n'
printf 'One check: systemctl start svoi-update.service\n'
printf 'Status: journalctl -u svoi-update.service -n 50 --no-pager\n'
