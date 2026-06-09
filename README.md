# 内网 Web 部署中心

单 Docker 容器的内网前端项目部署中心。Dashboard 监听 `10000`，上传的 Node/Vite/React/Next 项目使用 `10001-19999` 端口段。

容器启动时只发布 Dashboard 端口 `10000`，不会预先抢占 `10001-19999`。只有用户上传/启动服务时，系统才检查用户填写的端口；如果端口不可用，Dashboard 会提示换端口。

## 运行

```bash
docker compose up -d --build
```

或直接使用 Docker：

```bash
docker build -t intranet-web-deploy-center .
docker run -d \
  --name intranet-web-deploy-center \
  --restart unless-stopped \
  -p 10000:10000 \
  -v "$(pwd)/data:/data/web-deploy-center" \
  intranet-web-deploy-center
```

打开：

```text
http://服务器IP:10000
```

宿主机持久化目录：

```text
./data
```

macOS 使用 Docker Desktop 时，默认不要挂载 `/data/web-deploy-center` 这类根目录路径，否则可能出现 `Mounts denied`。项目目录在 `/Users` 下时，直接使用仓库内的 `./data` 最省心。

## 上传项目

上传 zip 包需要包含 `package.json`。如果 zip 外层只有一个项目目录，系统会自动把它识别为项目根目录。

如果 `package.json` 不在 zip 根目录，可以在 Dashboard 的「项目目录」里填写 zip 内相对路径。比如上传的包结构是 `feedback/web/package.json`，项目目录填 `web` 或 `feedback/web` 都可以，安装命令和启动命令会在这个目录里执行。

推荐上传不包含 `node_modules` 的源码包，上传后先点击「安装」再点击「启动」。如果 zip 中已经包含 `node_modules`，系统会在解压时保留安全符号链接和可执行权限，避免 `vite: Permission denied` 这类 npm bin 权限问题。

推荐命令：

```bash
npm install
npm run dev -- --host 0.0.0.0
```

系统会自动注入：

```text
PORT=用户填写的端口
HOST=0.0.0.0
HOSTNAME=0.0.0.0
VITE_PORT=用户填写的端口
VITE_HOST=0.0.0.0
npm_config_port=用户填写的端口
npm_config_host=0.0.0.0
```

Dashboard 访问：

```text
http://服务器IP:10000
```

默认 Docker 配置只发布 Dashboard 的 `10000`。上传项目填写的服务端口用于容器内部进程监听和冲突检测；如果要让用户服务也通过独立端口直接暴露到局域网，需要另外发布对应端口或接入反向代理。

## 生命周期

Dashboard 支持：

- 手动端口检测
- 上传 zip
- 安装依赖
- 启动
- 停止
- 重启
- 查看日志
- 清空日志
- 删除服务

## 注意

当前版本不做登录、命令限制、资源隔离。上传项目和执行命令等价于在部署中心容器内执行代码，适合可信内网 MVP。
