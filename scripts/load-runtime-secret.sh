#!/usr/bin/env bash
# sudo bash scripts/load-runtime-secret.sh cloudstream/backend/runtime eu-west-1
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root'; exit 1; }
secret=${1:?Secrets Manager name required};region=${2:?AWS region required}
command -v aws >/dev/null || { echo 'Install AWS CLI v2 first'; exit 1; }
mkdir -p /etc/cloudstream;chmod 0700 /etc/cloudstream
aws secretsmanager get-secret-value --secret-id "$secret" --region "$region" --query SecretString --output text | python3 -c '
import json,sys,re
values=json.load(sys.stdin)
with open("/etc/cloudstream/backend.env","w") as f:
  for k,v in values.items():
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*",k):raise SystemExit("Invalid environment key")
    v=str(v)
    if "\n" in v or "\r" in v:raise SystemExit("Multiline values not allowed")
    f.write(k+"="+json.dumps(v)+"\n")
'
chmod 0600 /etc/cloudstream/backend.env
printf 'Runtime configuration loaded from Secrets Manager. Restart the systemd unit to apply changes.\n'
