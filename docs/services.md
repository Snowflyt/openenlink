# Running as a service

English | [简体中文](services.zh-CN.md)

A service manager can start `serve` at boot or sign-in and restart it after a crash. The setups below cover systemd, Docker, launchd on macOS and Task Scheduler on Windows.

Before setting one up:

- Sign in once in a terminal with `openenlink login`, as the same user the service runs as. The authorization is saved per user.
- Run one `serve` per account. A second client on the same account takes the tunnel from the first. See [one client per account](usage.md#one-client-per-account).
- Status 3 means the saved sign-in no longer works. Restarting does not help until you run `openenlink login` again, so each setup below stops at status 3. See [exit statuses](usage.md#exit-statuses).

## Linux with systemd

A server without a desktop session has no Secret Service, so sign in with `--insecure-storage` as the user that runs the service:

```sh
openenlink login https://vpn.example.edu --insecure-storage
```

Write `/etc/systemd/system/openenlink.service`, with `User=` set to that user:

```ini
[Unit]
Description=openenlink proxy
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=/usr/local/bin/openenlink serve
User=alice
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=3

[Install]
WantedBy=multi-user.target
```

Start it, and start it at boot:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now openenlink
journalctl -u openenlink -f
```

`systemctl stop` sends SIGTERM, and `serve` exits with 0. A crash restarts it after 5 seconds. Status 3 leaves the unit failed. After `openenlink login`, run `sudo systemctl restart openenlink`.

## Docker

Put the `-gnu` Linux file for the host's architecture next to this `Dockerfile`, renamed to `openenlink`:

```dockerfile
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 openenlink /usr/local/bin/openenlink
ENV XDG_CONFIG_HOME=/config
ENTRYPOINT ["openenlink"]
CMD ["serve", "--bind", "0.0.0.0"]
```

Build the image, sign in with the authorization saved to a volume, then start the proxy:

```sh
docker build -t openenlink .
docker run -it --rm -v openenlink:/config openenlink login https://vpn.example.edu --insecure-storage
docker run -d --name openenlink --restart on-failure:3 -e TZ=Asia/Shanghai -v openenlink:/config -p 127.0.0.1:1088:1088 openenlink
docker logs -f openenlink
```

`login` needs `-it` to prompt in the terminal. `serve` listens on all addresses inside the container and warns that the proxy has no password. `-p 127.0.0.1:1088:1088` publishes the port on the host's loopback only. To reach the proxy from other machines, publish it on another address and add `--proxy-user` to the command.

`TZ` sets the time zone of the log lines, which is UTC otherwise.

`docker stop` exits with 0, and the container stays stopped. Docker cannot exclude one status from `on-failure`, so `:3` caps the restarts after the sign-in expires. The count accumulates over the life of the container. After signing in again with the `login` command above, remove the container with `docker rm openenlink` and run it again.

## macOS with launchd

A LaunchAgent runs `serve` in your session after you sign in to the Mac. launchd restarts a job whose exit status is not 0, so a shell wrapper turns status 3 into 0.

Write `~/Library/LaunchAgents/edu.example.openenlink.plist`. launchd does not expand `~`, so every path is absolute:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>edu.example.openenlink</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>"$0" serve; status=$?; [ "$status" -eq 3 ] &amp;&amp; exit 0; exit "$status"</string>
    <string>/Users/alice/bin/openenlink</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/alice/Library/Logs/openenlink.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/alice/Library/Logs/openenlink.log</string>
</dict>
</plist>
```

Load it, which also starts it at each sign-in, and unload it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/edu.example.openenlink.plist
launchctl bootout gui/$(id -u)/edu.example.openenlink
```

A crash restarts `serve` after about 10 seconds. `launchctl print gui/$(id -u)/edu.example.openenlink` shows the state and the last exit status. After status 3 and `openenlink login`, run `launchctl kickstart gui/$(id -u)/edu.example.openenlink`.

After you replace the `openenlink` file, for example with a new version, macOS asks once whether openenlink may use its keychain item. `serve` waits for the answer before it listens. Choose Always Allow.

## Windows with Task Scheduler

A task that starts at sign-in runs `serve` in your session, where it reads the authorization from Credential Manager. In PowerShell, with the path to the file:

```powershell
Register-ScheduledTask -TaskName openenlink -Action (New-ScheduledTaskAction -Execute 'C:\Tools\openenlink.exe' -Argument 'serve') -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0)
```

Without these settings, Task Scheduler skips the task on battery power, stops it when the laptop unplugs, and stops it after 3 days.

Start it now, stop it, and remove it:

```powershell
Start-ScheduledTask -TaskName openenlink
Stop-ScheduledTask -TaskName openenlink
Unregister-ScheduledTask -TaskName openenlink -Confirm:$false
```

`serve` runs in a console window that shows its log, and closing the window stops it. The proxy is ready a few seconds after the start. Task Scheduler does not restart `serve` after it exits. `Get-ScheduledTaskInfo -TaskName openenlink` shows the exit status as `LastTaskResult`. Run `Start-ScheduledTask` again, after `openenlink login` if the status was 3.

Keep `openenlink.exe` as the action itself. `Stop-ScheduledTask` ends only the process it started, so a `cmd` or `powershell` wrapper would leave `serve` running.
