#!/usr/bin/env bash
# Run only on a disposable x86_64 Ubuntu 24.04 EC2 builder, then snapshot it as a private AMI.
set -Eeuo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run as root' >&2; exit 1; fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends xfce4 xfce4-goodies dbus-x11 tigervnc-standalone-server tigervnc-common python3 ca-certificates curl jq libfuse2t64 iptables apparmor apparmor-utils
id streamer >/dev/null 2>&1 || useradd -m -s /bin/bash -U streamer
passwd -l streamer || true
install -d -m 700 -o streamer -g streamer /home/streamer/.vnc
cat >/home/streamer/.vnc/config <<'CONF'
session=xfce
geometry=1280x800
localhost=no
alwaysshared=0
CONF
chown streamer:streamer /home/streamer/.vnc/config
chmod 0600 /home/streamer/.vnc/config
mkdir -p /etc/tigervnc
printf ':1=streamer\n' >/etc/tigervnc/vncserver.users
# Disallow an untrusted GUI process from reaching IMDS, AWS infrastructure or the internet.
cat >/usr/local/sbin/cloudstream-firewall <<'FW'
#!/usr/bin/env bash
set -euo pipefail
uid=$(id -u streamer)
iptables -C OUTPUT -m owner --uid-owner "$uid" -j CS_APP_EGRESS 2>/dev/null && exit 0
iptables -N CS_APP_EGRESS 2>/dev/null || true
iptables -F CS_APP_EGRESS
iptables -A CS_APP_EGRESS -o lo -j ACCEPT
iptables -A CS_APP_EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A CS_APP_EGRESS -d 169.254.169.254/32 -j REJECT
iptables -A CS_APP_EGRESS -d 169.254.170.2/32 -j REJECT
iptables -A CS_APP_EGRESS -j REJECT
iptables -I OUTPUT 1 -m owner --uid-owner "$uid" -j CS_APP_EGRESS
FW
chmod 0700 /usr/local/sbin/cloudstream-firewall
cat >/etc/systemd/system/cloudstream-firewall.service <<'UNIT'
[Unit]
Description=Block untrusted application network access
Before=tigervncserver@:1.service cloudstream-app.service
After=network.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cloudstream-firewall
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
cat >/usr/local/bin/cloudstream-run <<'PY'
#!/usr/bin/env python3
import json, os, pathlib, re, subprocess, sys
cfg=json.load(open('/opt/cloudstream/app-config.json'))
root=pathlib.Path('/opt/cloudstream/app').resolve()
format=cfg['format']
if format=='appimage':
    target=root/'uploaded.AppImage'
else:
    rel=cfg['startupExecutable']
    if rel.startswith('/') or '..' in pathlib.PurePosixPath(rel).parts or '\\' in rel: raise SystemExit('Unsafe executable')
    target=(root/rel).resolve()
    if not target.is_relative_to(root): raise SystemExit('Path escapes archive')
if not target.is_file(): raise SystemExit('Executable does not exist')
environ=os.environ.copy()
environ.update({'DISPLAY':':1','HOME':'/home/streamer','XDG_RUNTIME_DIR':'/run/user/'+str(os.getuid())})
for name,value in cfg.get('environment',{}).items():
    if not re.fullmatch(r'[A-Z][A-Z0-9_]*',name) or re.match(r'^(LD_|DYLD_|AWS_|DBUS_|PATH$|HOME$|DISPLAY$|XAUTHORITY$)',name): raise SystemExit('Unsafe environment variable')
    environ[name]=str(value)
args=cfg.get('args',[])
if not isinstance(args,list) or len(args)>30: raise SystemExit('Invalid arguments')
if format=='appimage': environ['APPIMAGE_EXTRACT_AND_RUN']='1'
os.chdir(root)
os.execve(str(target),[str(target)]+[str(a) for a in args],environ)
PY
chmod 0755 /usr/local/bin/cloudstream-run
cat >/usr/local/sbin/cloudstream-boot <<'PY'
#!/usr/bin/env python3
import json, os, pathlib, pwd, stat, subprocess, sys, tarfile, urllib.request
cfg=json.load(open(sys.argv[1]))
if cfg.get('format') not in ('appimage','tar.gz'): raise SystemExit('Unsupported format')
root=pathlib.Path('/opt/cloudstream')
app=root/'app'
app.mkdir(parents=True,exist_ok=True)
# Root fetches a time-limited signed S3 URL. Never write it into the untrusted user's files.
request=urllib.request.Request(cfg['url'],headers={'User-Agent':'cloudstream-executor'})
with urllib.request.urlopen(request,timeout=180) as response, open(root/'package','wb') as out:
    total=0
    while True:
        block=response.read(1024*1024)
        if not block: break
        total+=len(block)
        if total>2*1024**3: raise SystemExit('Package exceeds limit')
        out.write(block)
if cfg['format']=='appimage':
    destination=app/'uploaded.AppImage'
    (root/'package').rename(destination)
    destination.chmod(0o700)
else:
    with tarfile.open(root/'package','r:gz') as t:
        members=t.getmembers()
        if len(members)>5000: raise SystemExit('Too many files')
        total=0
        for m in members:
            if m.name.startswith('/') or '..' in pathlib.PurePosixPath(m.name).parts or '\\' in m.name or not(m.isdir() or m.isfile()) or m.mode&0o6000: raise SystemExit('Unsafe tar entry')
            total+=m.size
            if total>5*1024**3: raise SystemExit('Archive expansion too large')
        t.extractall(app,filter='data')
    (root/'package').unlink()
    for f in app.rglob('*'):
        if f.is_file(): f.chmod((f.stat().st_mode & 0o700) & ~0o6000)
uid=pwd.getpwnam('streamer').pw_uid;gid=pwd.getpwnam('streamer').pw_gid
for directory,dirs,files in os.walk(str(app)):
    os.chown(directory,uid,gid)
    for name in files:os.chown(os.path.join(directory,name),uid,gid)
os.chown(str(app),uid,gid)
app_cfg={key:cfg[key] for key in ('format','startupExecutable','args','environment') if key in cfg}
(root/'app-config.json').write_text(json.dumps(app_cfg))
os.chmod(root/'app-config.json',0o600)
os.chown(root/'app-config.json',uid,gid)
# VNC classic password auth uses only the first 8 characters. The random password is session specific.
subprocess.run(['install','-d','-m','700','-o','streamer','-g','streamer','/home/streamer/.vnc'],check=True)
password=subprocess.run(['tigervncpasswd','-f'],input=(cfg['vncPassword']+'\n').encode(),capture_output=True,check=True).stdout
passwd='/home/streamer/.vnc/passwd'
open(passwd,'wb').write(password)
os.chmod(passwd,0o600)
os.chown(passwd,uid,gid)
subprocess.run(['systemctl','start','cloudstream-firewall.service'],check=True)
subprocess.run(['systemctl','enable','--now','tigervncserver@:1.service'],check=True)
subprocess.run(['systemctl','enable','--now','cloudstream-app.service'],check=True)
PY
chmod 0700 /usr/local/sbin/cloudstream-boot
cat >>/usr/local/sbin/cloudstream-boot <<'PY'
# Health state is asserted only after the native application service is healthy.
import time
for i in range(20):
    ok=subprocess.run(['systemctl','is-active','--quiet','cloudstream-app.service']).returncode==0
    desktop=subprocess.run(['systemctl','is-active','--quiet','tigervncserver@:1.service']).returncode==0
    if ok and desktop:
        pathlib.Path('/run/cloudstream-ready').touch(); break
    time.sleep(2)
else: raise SystemExit('Application or remote desktop failed to start')
PY
cat >/etc/systemd/system/cloudstream-app.service <<'UNIT'
[Unit]
Description=CloudStream untrusted native application
After=tigervncserver@:1.service cloudstream-firewall.service
Requires=tigervncserver@:1.service cloudstream-firewall.service
[Service]
Type=simple
User=streamer
Group=streamer
WorkingDirectory=/opt/cloudstream/app
Environment=DISPLAY=:1
ExecStart=/usr/local/bin/cloudstream-run
Restart=no
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/cloudstream/app /home/streamer
PrivateTmp=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictRealtime=yes
SystemCallArchitectures=native
StandardOutput=append:/var/log/cloudstream-app.log
StandardError=append:/var/log/cloudstream-app.log
[Install]
WantedBy=multi-user.target
UNIT
# SSM calls this as root; output is actual VM state and sampled host resource utilization.
cat >/usr/local/bin/cloudstream-metrics <<'PY'
#!/usr/bin/env python3
import json, pathlib, subprocess
p=pathlib.Path('/proc/meminfo').read_text().splitlines();m={a.rstrip(':'):int(b.split()[0]) for a,b in (line.split(None,1) for line in p)}
total=m['MemTotal'];available=m.get('MemAvailable',0)
import time
def cpu():
    with open('/proc/stat') as f: return [int(x) for x in f.readline().split()[1:]]
a=cpu();time.sleep(0.2);b=cpu()
activity=sum(b)-sum(a);idle=(b[3]+b[4])-(a[3]+a[4])
result={'ready':pathlib.Path('/run/cloudstream-ready').exists(),'failed':pathlib.Path('/run/cloudstream-failed').exists(),'appAlive':subprocess.run(['systemctl','is-active','--quiet','cloudstream-app.service']).returncode==0,'ramPct':round((total-available)*100/total,1),'ramBytes':(total-available)*1024,'cpuPct':round(100*(activity-idle)/max(activity,1),1)}
print(json.dumps(result))
PY
chmod 0755 /usr/local/bin/cloudstream-metrics
# Install CloudWatch agent for persistent app stdout/stderr history.
ARCH=$(dpkg --print-architecture)
if [[ "$ARCH" == amd64 ]]; then
  curl -fsSL https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb -o /tmp/cw-agent.deb
  dpkg -i /tmp/cw-agent.deb
  rm -f /tmp/cw-agent.deb
  mkdir -p /opt/aws/amazon-cloudwatch-agent/etc
  cat >/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'JSON'
{"agent":{"run_as_user":"root"},"logs":{"logs_collected":{"files":{"collect_list":[{"file_path":"/var/log/cloudstream-app.log","log_group_name":"/cloudstream/execution","log_stream_name":"{instance_id}","retention_in_days":14}]}}}}
JSON
  systemctl enable amazon-cloudwatch-agent || true
  /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s || true
fi
# Guarantee a boot-time firewall even if cloud-init fails before running the app.
systemctl enable cloudstream-firewall.service
cloud-init clean --logs || true
printf 'AMI bootstrap installed. Reboot and verify it, then create a private AMI.\n'
