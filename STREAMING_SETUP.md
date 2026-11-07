# Native browser streaming — real Guacamole/TigerVNC integration

The implementation runs actual GUI software on Linux EC2. It does **not** render screenshots, fake application windows, or remote terminals. Remote input and the display travel over the Guacamole protocol.

## Data path

```text
Browser (guacamole-common-js)
  -> WSS api.example.com/guac/?token=<one-minute encrypted token>
  -> Nginx Upgrade proxy
  -> guacamole-lite (127.0.0.1:8081)
  -> guacd (127.0.0.1:4822)
  -> TCP 5901 (private execution IP via AWS security group)
  -> Ubuntu TigerVNC virtual X11 display :1 / Xfce / native application
```

The API's POST `/api/v1/sessions/:id/connection-ticket` checks access JWT ownership and the authoritative running state, then returns an encrypted, HMAC-signed 60-second ticket containing remote destination details. `guacamole-lite` callback synchronously checks the signature and expiration and pins the connection to the private EC2 IP and VNC password included in the server-issued authenticated ticket. Session ownership and authoritative running state are checked by the API at ticket issuance. Existing tickets expire after 60 seconds; terminating an instance revokes the underlying VNC access. The URL is a short-lived bearer credential; don't log or share it. Browser users do not receive the plain VNC password or EC2 IP as separate fields.

## Dependencies

- On the **API host**: `sudo apt install guacd libguac-client-vnc0t64` with guacd bound to `127.0.0.1:4822`; backend `guacamole-lite` server bound to `127.0.0.1:8081`.
- In the **frontend**: `guacamole-common-js`; no separately hosted Java/Tomcat Guacamole UI needed.
- On a clean **x86_64 Ubuntu 24.04 execution AMI**: `xfce4`, `dbus-x11`, `tigervnc-standalone-server`, `tigervnc-common`, `libfuse2t64`, the provided `cloudstream-boot` script, the native app systemd service, firewall, SSM agent and CloudWatch agent.
- AWS networking: API SG to execution SG TCP 5901 only. **Never open VNC to 0.0.0.0/0**. Execution EC2 has no public IP.
- Nginx HTTPS/WSS setup from [DEPLOYMENT.md](DEPLOYMENT.md). A browser in an HTTPS site will reject insecure `ws://` connections.

## Prepare the execution AMI

The supplied [scripts/prepare-executor-ami.sh](scripts/prepare-executor-ami.sh) adds a `streamer` UID and configures Ubuntu's TigerVNC `tigervncserver@:1.service` to map display `:1` to `streamer`. It also writes `cloudstream-app.service` (no shell concatenation of user arguments), blocks outbound connections from that UID through iptables and forces VNC's plaintext RFB auth to stay within the private VPC. The worker creates a fresh random 8-character VNC password per VM. VNC password auth is legacy, so the VPC network barrier and short-lived authenticated Guacamole gate are essential; consider upgrading to DCV for higher-security/graphics-heavy production tiers.

The per-session EC2 user data contains a short-lived S3 GET URL and VNC secret. Root-only cloud-init writes `/run/cloudstream-config.json` mode 0600 and calls `cloudstream-boot`, which downloads the package as root, validates path safety again, prepares it under `/opt/cloudstream/app`, sets unprivileged ownership, sets the VNC secret and starts the native application systemd unit. The application is launched on `DISPLAY=:1` and cannot access the backend host or the internet through standard outbound TCP connections. Only the root host services retain metadata/SSM networking; this is defense in depth, not a hardware security boundary.

Use Systems Manager to inspect a session instance (do not open SSH):

```bash
aws ssm start-session --target i-RUNNING-EXECUTOR --region eu-west-1
sudo systemctl status tigervncserver@:1.service --no-pager
sudo systemctl status cloudstream-app.service --no-pager
sudo journalctl -u cloudstream-app --no-pager -n 100
sudo cat /var/log/cloudstream-boot.log
sudo /usr/local/bin/cloudstream-metrics
sudo iptables -S CS_APP_EGRESS
sudo test -f /run/cloudstream-ready && echo 'runtime ready'
```

Check the VM's private IP and that the API host can connect to port 5901 via its security group. **Do not copy the private VNC password or AWS access credentials into the browser.** The Guacamole token handles gateway connection automatically.

## Browser interaction

The stream page mounts the genuine `Guacamole.Client` display DOM, sends keyboard `Guacamole.Keyboard` events, mouse `Guacamole.Mouse` state, supports fullscreen, displays the live authoritative session state and polls SSM-recorded CPU/RAM measurements. Reconnect fetches a **new** time-limited ticket, instead of replaying an expired one. Session heartbeats are authenticated REST requests every 30 seconds. Disconnect closes the local tunnel but does not immediately terminate EC2; Stop triggers the authoritative EC2 termination workflow.

The default Xfce display is 1280×800. To change physical remote desktop resolution, the running TigerVNC server must support negotiated resize (e.g., through Guacamole `sendSize`/Xrandr); browser fullscreen alone scales the viewport, not the remote OS. The included settings UI sends a Guacamole resize request and warns when the native VNC server retains the AMI default resolution. Do not claim all apps dynamically resize. Browser audio redirection is **not** implemented. VNC performs best for non-video graphics; for low-latency GPU/high-FPS applications, architect a future Amazon DCV native gateway with explicit licenses and drivers.

## Debugging

1. `curl -fsS https://api.example.com/health` must return JSON.
2. Inspect browser devtools WebSocket upgrade to `/guac/?token=...` (101 Switching Protocols). If it fails, fix Nginx/HTTPS first.
3. `sudo systemctl status guacd` on the API host; ensure plugin `libguac-client-vnc0t64` is installed and daemon listens only on loopback.
4. Confirm instance `DescribeInstances` state is `running` and the `cloudstream-metrics` SSM command reports `ready: true, appAlive: true`.
5. Check private TCP 5901 SG reference between API SG and execution SG; no public IP is required.
6. Check CloudWatch `/cloudstream/execution` stream named by instance ID and `GET /api/v1/sessions/:id/logs` when logs exist.
7. For AppImage failures, inspect host libraries, x86_64 architecture, `APPIMAGE_EXTRACT_AND_RUN`, executable bits and log output. For `.tar.gz`, verify executable path relative to archive root and all preinstalled dependencies.

In a production cluster, avoid scaling guacamole-lite horizontally without affinity or a shared connection strategy; the supplied configuration assumes a single API/gateway node.
