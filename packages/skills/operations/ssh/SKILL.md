---
name: ssh
description: "已授权 SSH：按 ~/.ssh/config 别名连接服务器/路由器，执行远程命令、传文件、排障。"
---

# SSH

事实源：`~/.ssh/config`，主机索引：`~/.ssh/AGENTS.md`。

优先用别名：

```bash
ssh ALIAS 'uname -a; pwd'
ssh -G ALIAS
```

传文件优先不用 `scp`，OpenWrt 常缺 `sftp-server`：

```bash
cat local | ssh ALIAS 'cat > /remote/path'
tar -C localdir -cf - . | ssh ALIAS 'mkdir -p /remote/dir && tar -C /remote/dir -xf -'
```

排障保留原始错误：

```bash
ssh -vvv ALIAS 'true'
nc -vz HOST PORT
```