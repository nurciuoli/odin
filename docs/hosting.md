# Hosting Odin on an always-on computer

Run Odin core on one computer that stays on (the host) and use it from your other devices over Tailscale. Agents keep
working when you close the browser or the laptop. This is for one person with their own tailnet; the access model is the
single-user one in [contracts](contracts.md#security-model-single-user-local).

```
 your PC / phone / tablet                         host (always on)
┌──────────────────────┐   tailnet (HTTPS)   ┌─────────────────────────────────────────┐
│ browser              │ ──────────────────► │ Tailscale Serve  :8443                  │
│ deploy/deploy.*  ────┼──── ssh + scp ────► │   └─► Odin core  127.0.0.1:8790         │
└──────────────────────┘                     │        runs as the `odin` user          │
                                             │        agents, checkouts, ~/.odin       │
                                             └─────────────────────────────────────────┘
```

Core only listens on loopback. Serve adds HTTPS and passes the caller's Tailscale login in a header, which Odin checks
with `ODIN_ALLOWED_LOGIN`. Everything below uses the scripts in `deploy/`. macOS and Linux hosts work; Windows hosts
are not covered yet. The deploying PC can be Windows, macOS or Linux.

## One-time host setup

1. **Tailscale.** Install it, sign in, and enable HTTPS certificates for your tailnet (admin console, DNS page).
2. **Create the `odin` user** (a standard, non-admin account). Odin and the agents run as this user, so they only see
   what it can see.
   - macOS: `sudo sysadminctl -addUser odin -fullName Odin -password - -home /Users/odin`
   - Linux: `sudo useradd -m -s /bin/bash odin && sudo passwd odin`
3. **Install Node 24 and corepack for that user.** For example with nvm or fnm, installed while logged in as `odin`
   (`sudo -iu odin`). Check with `sudo -iu odin node --version` (24 or later) and `sudo -iu odin corepack --version`.
   Install `git` too. Always use Yarn through corepack, never npm.
4. **Sign in the agent CLIs as that user**, for example `sudo -iu odin claude`, then the same for Codex or others you
   use. Odin never reads model credentials: they are whatever that account has. Claude Code run without a terminal
   needs credentials it can find without a prompt, so confirm `claude -p "hi"` works from an `ssh odin@host` session.
5. **Allow ssh from your PC.** Enable Remote Login (macOS: System Settings, General, Sharing; Linux: install and
   start `sshd`). Add your PC's public key to `~odin/.ssh/authorized_keys` (mode 600, folder 700).
   `ssh odin@<host>` must work without a password prompt, because the deploy uses `BatchMode`.

## Deploy from your PC

```sh
cp deploy/host.env.example deploy/host.env.local   # gitignored
```

Edit `deploy/host.env.local`: `ODIN_DEPLOY_HOST` (the host's Tailscale machine name), and optionally
`ODIN_DEPLOY_USER`, `ODIN_CORE_PORT`, `ODIN_SERVE_PORT`. Then, from the repo root:

```sh
deploy/deploy.sh          # macOS / Linux
deploy\deploy.ps1         # Windows PowerShell
```

It builds the web app, uploads a tarball, unpacks it into `~odin/odin-app`, installs production dependencies for core
only, creates `~odin/.odin.env` if it is missing (never overwritten), restarts core and waits for
`GET /api/health`. At this point core runs, but only from a shell-started process.

## Expose it with Tailscale Serve

On the host, as an admin (a user that can run `tailscale`):

```sh
sh /Users/odin/odin-app/deploy/setup-tailscale-serve.sh      # /home/odin/... on Linux
```

It runs `tailscale serve --bg --https=8443 http://127.0.0.1:8790`, shows the serve status, and prints the URL plus
two lines for `~odin/.odin.env`:

```
ODIN_EXTRA_HOSTS=<host>.<tailnet>.ts.net
ODIN_ALLOWED_LOGIN=<you@example.com>
```

Paste them into `~odin/.odin.env` (as `odin`, or with sudo), then restart core: `deploy/deploy.sh` again, or
`sudo -iu odin sh ~/odin-app/deploy/restart-core.sh`. Use `ODIN_SERVE_PORT=443` in front of the script if you want
the plain URL and nothing else uses 443. Serve, not Funnel: Funnel would publish Odin to the internet.

## Start at boot and after a crash

- **macOS**: `sudo sh /Users/odin/odin-app/deploy/install-launchd.sh` installs a LaunchDaemon
  (`dev.odin.core`) that runs core as `odin` at boot, restarts it within about 10 seconds if it exits, and logs to
  `~odin/.odin-logs/core.log`. It finds Node by asking the `odin` user, so rerun it if you change Node versions.
  Rerunning it is safe.
- **Linux**: as `odin`, install the user unit and let it run without a login:

  ```sh
  mkdir -p ~/.config/systemd/user && cp ~/odin-app/deploy/systemd/odin-core.service ~/.config/systemd/user/
  systemctl --user daemon-reload && systemctl --user enable --now odin-core
  sudo loginctl enable-linger odin
  ```

  `systemctl --user` needs a real login session for `odin` (`sudo -iu odin` may lack one; use `machinectl shell
  odin@` or ssh in). Logs: `journalctl --user -u odin-core`.

After either is installed, `deploy/restart-core.sh` (and so every deploy) kills the process and waits for the
supervisor to bring it back.

## Keep the host awake

- macOS: `sudo pmset -c sleep 0` (never sleep on power; the display may still sleep). Keep it plugged in and sign-in
  is not required for the daemon.
- Linux: mask sleep on power, for example `sudo systemctl mask sleep.target suspend.target`, and on a laptop set
  `HandleLidSwitchExternalPower=ignore` in `/etc/systemd/logind.conf`.

## Use it from other devices

Open the printed URL (`https://<host>.<tailnet>.ts.net:8443/`) on any device signed in to the same tailnet with the
allowed login. On a phone, use Share, Add to Home Screen. Projects and sessions on that Odin are the host's: paths
refer to the host's disks.

## Update, turn off

- **Update**: pull the version you want on your PC and run the deploy again.
- **Stop sharing**: `tailscale serve --https=8443 off` (use your port).
- **Stop core**: macOS `sudo launchctl bootout system/dev.odin.core` and delete the plist to keep it off; Linux
  `systemctl --user disable --now odin-core`. Data stays in `~odin/.odin`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| 421 Misdirected Request | `ODIN_EXTRA_HOSTS` is empty or not the exact hostname in the URL. Restart core after editing. |
| 401 Unauthorized | `ODIN_ALLOWED_LOGIN` is not your Tailscale login, or the request did not come through Serve (no `Tailscale-User-Login` header). |
| Odin desktop app on the host gets 401 | Once `ODIN_ALLOWED_LOGIN` is set, direct loopback requests are refused too. Open the Serve URL in a browser on the host instead. |
| Deploy fails at `ssh` | Run `ssh -o BatchMode=yes odin@<host> true`. It needs key auth. |
| Health check times out | `tail ~odin/.odin-logs/core.log` on the host. Often Node is older than 24, or the port is taken. |
| Agent says it is not signed in | Sign in as the `odin` user (step 4), not as your own account. |

## Security notes

- The dedicated user is the containment: agents act with `odin`'s files and credentials only, not yours. Keep the
  account out of the admin group.
- Use Serve, never Funnel. Restrict who can reach the host in your tailnet policy (ACLs) as well as with
  `ODIN_ALLOWED_LOGIN`; the login check relies on Serve being the only way in.
- Odin's ingest token and secrets vault work as before. `~/.odin.env` holds no secrets by default and is mode 600.
