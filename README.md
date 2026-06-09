# 内网 Web 部署中心

单 Docker 容器的内网前端项目部署中心。Dashboard 监听 `10000`，上传的 Node/Vite/React/Next 项目使用 `10001-19999` 端口段。

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
  -p 10000-19999:10000-19999 \
  -v /data/web-deploy-center:/data/web-deploy-center \
  intranet-web-deploy-center
```

打开：

```text
http://服务器IP:10000
```

宿主机持久化目录：

```text
/data/web-deploy-center
```

## 上传项目

上传 zip 包需要包含 `package.json`。如果 zip 外层只有一个项目目录，系统会自动把它识别为项目根目录。

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

用户服务访问：

```text
http://服务器IP:10001
```

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
- 跟随 Dashboard 启动

## 注意

当前版本不做登录、命令限制、资源隔离。上传项目和执行命令等价于在部署中心容器内执行代码，适合可信内网 MVP。
