# 免费持久部署

这个服务会把关卡配置和埋点写入 SQLite，本地文件必须持久化。Render / Koyeb 的免费 Web 服务适合临时演示，但免费实例的文件系统会丢数据或不能挂持久卷，不适合作为正式埋点后台。

推荐使用 Oracle Cloud Always Free VM：它有长期免费的计算资源和块存储，能直接运行当前 Node + SQLite 服务。

## 目标形态

- 游戏：`https://你的域名/game/`
- 后台：`https://你的域名/admin/`
- API：`https://你的域名/api/levels/config`
- SQLite：服务器 `/opt/trick-brick-server/data/app.db`

这样游戏和后端同域，不需要额外 CORS，也不会被浏览器拦截 mixed content。

## 前置条件

1. 一台 Ubuntu VM，可以 SSH 登录，例如 `ubuntu@1.2.3.4`。
2. VM 的云防火墙 / 安全组放行 TCP `80`、`443`。
3. 本机能通过 SSH 免密或输入密码登录 VM。

如果没有自己的域名，脚本会在 SSH 主机是 IPv4 地址时使用 `1.2.3.4.sslip.io` 这类免费解析域名，并用 Caddy 自动申请 HTTPS 证书。

## 一键部署

在 `trick-brick-server` 目录执行：

```bash
ADMIN_PASSWORD='改成强口令' ./scripts/deploy-free-vm.sh ubuntu@1.2.3.4
```

如果有自己的域名：

```bash
ADMIN_PASSWORD='改成强口令' ./scripts/deploy-free-vm.sh ubuntu@1.2.3.4 game.example.com
```

脚本会上传当前 `trick-brick-server` 和同级 `../trick-brick`，安装 Node 20、Caddy、systemd 服务，并生成随机 `JWT_SECRET` / `IP_SALT`。

部署后检查：

```bash
curl https://你的域名/api/levels/config
ssh ubuntu@1.2.3.4 'systemctl status trick-brick-server --no-pager'
```

## 重新部署

代码或游戏资源更新后，重新运行同一条 `deploy-free-vm.sh` 命令即可。脚本不会删除服务器上的 `data/` 目录。
