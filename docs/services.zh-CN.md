# 作为服务运行

[English](services.md) | 简体中文

服务管理器可以在开机或登录系统时启动 `serve`，并在它崩溃后重启。下面分别介绍 systemd、Docker、macOS 的 launchd 和 Windows 的任务计划程序。

配置之前：

- 先在终端里执行一次 `openenlink login`，执行的用户要和运行服务的用户相同。授权按用户分别保存。
- 每个账号只运行一个 `serve`。同一账号的第二个客户端会抢走第一个的隧道，见[一个账号同时只连一个客户端](usage.zh-CN.md#一个账号同时只连一个客户端)。
- 状态 3 表示保存的登录已失效。重新执行 `openenlink login` 之前，重启没有用，所以下面每种配置在状态 3 时都不再重启。见[退出状态](usage.zh-CN.md#退出状态)。

## Linux 上的 systemd

没有桌面会话的服务器没有 Secret Service，所以用运行服务的用户执行带 `--insecure-storage` 的登录：

```sh
openenlink login https://vpn.example.edu --insecure-storage
```

写入 `/etc/systemd/system/openenlink.service`，`User=` 填这个用户：

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

启动服务，并设为开机启动：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now openenlink
journalctl -u openenlink -f
```

`systemctl stop` 发送 SIGTERM，`serve` 以 0 退出。崩溃后 5 秒重启。状态 3 会让服务停在 failed 状态，执行 `openenlink login` 后再运行 `sudo systemctl restart openenlink`。

## Docker

把对应主机架构的 `-gnu` Linux 文件放在下面这个 `Dockerfile` 旁边，改名为 `openenlink`：

```dockerfile
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 openenlink /usr/local/bin/openenlink
ENV XDG_CONFIG_HOME=/config
ENTRYPOINT ["openenlink"]
CMD ["serve", "--bind", "0.0.0.0"]
```

构建镜像，登录并把授权存进卷，再启动代理：

```sh
docker build -t openenlink .
docker run -it --rm -v openenlink:/config openenlink login https://vpn.example.edu --insecure-storage
docker run -d --name openenlink --restart on-failure:3 -e TZ=Asia/Shanghai -v openenlink:/config -p 127.0.0.1:1088:1088 openenlink
docker logs -f openenlink
```

`login` 需要 `-it` 才能在终端里提示输入。`serve` 在容器内监听所有地址，并警告代理没有密码。`-p 127.0.0.1:1088:1088` 只把端口发布在主机的回环地址上。要让其他机器连接代理，把端口发布到其他地址，并在命令里加上 `--proxy-user`。

`TZ` 设定日志行的时区，不设时为 UTC。

`docker stop` 以 0 退出，容器保持停止。Docker 的 `on-failure` 无法排除某一个状态，所以用 `:3` 限制登录失效后的重启次数。这个次数在容器的整个生命周期内累计。用上面的 `login` 命令重新登录后，用 `docker rm openenlink` 删除容器，再重新运行。

## macOS 上的 launchd

LaunchAgent 在你登录 Mac 后，在你的会话里运行 `serve`。launchd 会重启退出状态不为 0 的任务，所以用一个 shell 包装把状态 3 转成 0。

写入 `~/Library/LaunchAgents/edu.example.openenlink.plist`。launchd 不展开 `~`，所以每个路径都写绝对路径：

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

加载它（之后每次登录也会启动），以及卸载它：

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/edu.example.openenlink.plist
launchctl bootout gui/$(id -u)/edu.example.openenlink
```

崩溃后约 10 秒重启。`launchctl print gui/$(id -u)/edu.example.openenlink` 显示运行状态和上次的退出状态。状态 3 时执行 `openenlink login` 后，再运行 `launchctl kickstart gui/$(id -u)/edu.example.openenlink`。

替换 `openenlink` 文件后（比如换成新版本），macOS 会询问一次 openenlink 能否使用它在钥匙串里的项目。`serve` 得到回答后才开始监听。选择“始终允许”。

## Windows 上的任务计划程序

登录时启动的任务在你的会话里运行 `serve`，从凭据管理器读取授权。在 PowerShell 里填上文件路径：

```powershell
Register-ScheduledTask -TaskName openenlink -Action (New-ScheduledTaskAction -Execute 'C:\Tools\openenlink.exe' -Argument 'serve') -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0)
```

不加这些设置时，任务计划程序在使用电池时不启动任务，拔掉电源时停止任务，运行 3 天后也会停止任务。

立即启动、停止和删除任务：

```powershell
Start-ScheduledTask -TaskName openenlink
Stop-ScheduledTask -TaskName openenlink
Unregister-ScheduledTask -TaskName openenlink -Confirm:$false
```

`serve` 在一个显示日志的控制台窗口里运行，关闭窗口就会停止。启动几秒后代理可用。`serve` 退出后，任务计划程序不会重启它。`Get-ScheduledTaskInfo -TaskName openenlink` 的 `LastTaskResult` 是退出状态。再次运行 `Start-ScheduledTask` 即可，状态为 3 时先执行 `openenlink login`。

任务的操作直接用 `openenlink.exe`。`Stop-ScheduledTask` 只结束它启动的那个进程，用 `cmd` 或 `powershell` 包装会让 `serve` 继续运行。
