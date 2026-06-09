const AdmZip = require("adm-zip");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const multer = require("multer");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const CENTER_PORT = Number(process.env.PORT || 10000);
const PORT_RANGE_START = Number(process.env.SERVICE_PORT_START || 10001);
const PORT_RANGE_END = Number(process.env.SERVICE_PORT_END || 19999);
const DATA_DIR = path.resolve(
  process.env.DATA_DIR || path.join(__dirname, "data")
);
const SERVICES_DIR = path.join(DATA_DIR, "services");
const TMP_DIR = path.join(DATA_DIR, "tmp");
const STATE_FILE = path.join(DATA_DIR, "services.json");
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 512);

fs.mkdirSync(SERVICES_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const app = express();
const services = new Map();
const serviceProcesses = new Map();
const installProcesses = new Map();

const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (_req, file, cb) => {
      const suffix = crypto.randomBytes(8).toString("hex");
      const safeName = path.basename(file.originalname || "upload.zip");
      cb(null, `${Date.now()}-${suffix}-${safeName}`);
    },
  }),
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
  },
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  await loadState();

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      centerPort: CENTER_PORT,
      portRange: [PORT_RANGE_START, PORT_RANGE_END],
      dataDir: DATA_DIR,
    });
  });

  app.get("/api/ports/:port", async (req, res) => {
    const result = await checkPort(Number(req.params.port));
    res.status(result.available ? 200 : 409).json(result);
  });

  app.get("/api/services", async (req, res) => {
    const payload = await Promise.all(
      Array.from(services.values())
        .sort((a, b) => a.port - b.port)
        .map((service) => serializeService(req, service))
    );
    res.json({ services: payload });
  });

  app.post("/api/services", upload.single("archive"), async (req, res) => {
    const filePath = req.file?.path;

    try {
      const input = parseServiceInput(req.body);
      const duplicateName = Array.from(services.values()).some(
        (service) => service.name.toLowerCase() === input.name.toLowerCase()
      );

      if (duplicateName) {
        throw httpError(409, "服务名称已存在");
      }

      if (!filePath) {
        throw httpError(400, "请上传 zip 项目包");
      }

      if (path.extname(req.file.originalname || "").toLowerCase() !== ".zip") {
        throw httpError(400, "只支持上传 zip 文件");
      }

      const portStatus = await checkPort(input.port);
      if (!portStatus.available) {
        throw httpError(409, portStatus.reason);
      }

      const serviceId = uniqueServiceId(input.name);
      const serviceDir = path.join(SERVICES_DIR, serviceId);
      const sourceDir = path.join(serviceDir, "source");
      await fsp.mkdir(sourceDir, { recursive: true });

      try {
        await extractZip(filePath, sourceDir);
        const projectRoot = await resolveProjectRoot(sourceDir);
        const packageJson = path.join(projectRoot, "package.json");

        if (!(await exists(packageJson))) {
          throw httpError(400, "zip 根目录需要包含 package.json");
        }

        const service = {
          id: serviceId,
          name: input.name,
          port: input.port,
          installCommand: input.installCommand,
          startCommand: input.startCommand,
          note: input.note,
          serviceDir,
          sourceDir,
          projectRoot,
          logFile: path.join(serviceDir, "service.log"),
          status: "stopped",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastStartedAt: null,
          lastStoppedAt: null,
          lastExitCode: null,
          lastSignal: null,
          lastError: null,
        };

        await appendLog(service, `service created: ${service.name}`);
        services.set(service.id, service);
        await saveState();

        res.status(201).json({ service: await serializeService(req, service) });
      } catch (error) {
        await fsp.rm(serviceDir, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      sendError(res, error);
    } finally {
      if (filePath) {
        fsp.rm(filePath, { force: true }).catch(() => {});
      }
    }
  });

  app.post("/api/services/:id/install", async (req, res) => {
    const service = getServiceOrThrow(req.params.id);

    try {
      if (serviceProcesses.has(service.id)) {
        throw httpError(409, "服务运行中，请先停止再安装");
      }
      if (installProcesses.has(service.id)) {
        throw httpError(409, "安装任务已经在运行");
      }
      if (!service.installCommand.trim()) {
        throw httpError(400, "安装命令不能为空");
      }

      await startInstall(service);
      res.json({ service: await serializeService(req, service) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/services/:id/start", async (req, res) => {
    const service = getServiceOrThrow(req.params.id);

    try {
      await startService(service, "manual");
      res.json({ service: await serializeService(req, service) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/services/:id/stop", async (req, res) => {
    const service = getServiceOrThrow(req.params.id);

    try {
      await stopService(service, "manual");
      res.json({ service: await serializeService(req, service) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/services/:id/restart", async (req, res) => {
    const service = getServiceOrThrow(req.params.id);

    try {
      await stopService(service, "restart");
      await startService(service, "restart");
      res.json({ service: await serializeService(req, service) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete("/api/services/:id", async (req, res) => {
    const service = getServiceOrThrow(req.params.id);

    try {
      await stopService(service, "delete");
      services.delete(service.id);
      await saveState();
      await fsp.rm(service.serviceDir, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/services/:id/logs", async (req, res) => {
    const service = getServiceOrThrow(req.params.id);
    const maxBytes = Math.max(8 * 1024, Number(req.query.maxBytes || 512000));
    const text = await readTail(service.logFile, maxBytes);
    res.type("text/plain").send(text || "暂无日志");
  });

  app.delete("/api/services/:id/logs", async (req, res) => {
    const service = getServiceOrThrow(req.params.id);
    await fsp.writeFile(service.logFile, "");
    res.json({ ok: true });
  });

  app.listen(CENTER_PORT, "0.0.0.0", () => {
    console.log(`deploy center listening on :${CENTER_PORT}`);
  });
}

async function loadState() {
  if (!(await exists(STATE_FILE))) {
    return;
  }

  const raw = await fsp.readFile(STATE_FILE, "utf8");
  const data = JSON.parse(raw);

  for (const service of data.services || []) {
    services.set(service.id, {
      ...service,
      status: "stopped",
      lastError: null,
    });
  }
}

async function saveState() {
  const data = {
    version: 1,
    savedAt: new Date().toISOString(),
    services: Array.from(services.values()).map((service) => {
      const legacyStartupKey = "auto" + "start";
      const { [legacyStartupKey]: _unused, ...persistedService } = service;
      return {
        ...persistedService,
        status: serviceProcesses.has(service.id) ? "running" : service.status,
      };
    }),
  };
  const suffix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const tmpFile = `${STATE_FILE}.${process.pid}.${suffix}.tmp`;
  await fsp.writeFile(tmpFile, JSON.stringify(data, null, 2));
  await fsp.rename(tmpFile, STATE_FILE);
}

async function serializeService(req, service) {
  const host = getRequestHost(req);
  const status = getRuntimeStatus(service);
  const portListening = await isPortListening(service.port);

  return {
    id: service.id,
    name: service.name,
    port: service.port,
    installCommand: service.installCommand,
    startCommand: service.startCommand,
    note: service.note,
    serviceDir: service.serviceDir,
    projectRoot: service.projectRoot,
    status,
    pid: serviceProcesses.get(service.id)?.child.pid || null,
    portListening,
    url: `http://${host}:${service.port}`,
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
    lastStartedAt: service.lastStartedAt,
    lastStoppedAt: service.lastStoppedAt,
    lastExitCode: service.lastExitCode,
    lastSignal: service.lastSignal,
    lastError: service.lastError,
  };
}

function parseServiceInput(body) {
  const name = String(body.name || "").trim();
  const port = Number(body.port);
  const installCommand = String(body.installCommand || "npm install").trim();
  const startCommand = String(body.startCommand || "").trim();
  const note = String(body.note || "").trim();

  if (!name || name.length > 80) {
    throw httpError(400, "服务名称需要在 1-80 个字符之间");
  }

  if (!Number.isInteger(port)) {
    throw httpError(400, "服务端口必须是整数");
  }

  if (!startCommand) {
    throw httpError(400, "启动命令不能为空");
  }

  if (installCommand.length > 500 || startCommand.length > 500) {
    throw httpError(400, "命令长度不能超过 500 个字符");
  }

  return {
    name,
    port,
    installCommand,
    startCommand,
    note,
  };
}

async function checkPort(port) {
  if (!Number.isInteger(port)) {
    return { available: false, reason: "端口必须是整数" };
  }

  if (port < PORT_RANGE_START || port > PORT_RANGE_END) {
    return {
      available: false,
      reason: `端口必须在 ${PORT_RANGE_START}-${PORT_RANGE_END} 范围内`,
    };
  }

  if (port === CENTER_PORT) {
    return { available: false, reason: "部署中心端口不可用于服务" };
  }

  const reserved = Array.from(services.values()).find(
    (service) => service.port === port
  );
  if (reserved) {
    return {
      available: false,
      reason: `端口已被 ${reserved.name} 使用`,
      serviceId: reserved.id,
    };
  }

  const canBind = await canBindPort(port);
  if (!canBind) {
    return { available: false, reason: "端口已被系统中的其他进程占用" };
  }

  return { available: true, reason: "端口可用" };
}

function canBindPort(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    let settled = false;

    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    tester.unref();
    tester.once("error", () => done(false));
    tester.listen({ port, host: "0.0.0.0" }, () => {
      tester.close(() => done(true));
    });
  });
}

function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(350);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function extractZip(zipPath, destination) {
  const destinationRoot = path.resolve(destination);
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  if (!entries.length) {
    throw httpError(400, "zip 文件为空");
  }

  for (const entry of entries) {
    const entryName = entry.entryName.replace(/\\/g, "/");

    if (!entryName || entryName.includes("\0") || entryName === ".") {
      continue;
    }

    if (entryName.startsWith("__MACOSX/") || entryName.endsWith(".DS_Store")) {
      continue;
    }

    const targetPath = path.resolve(destinationRoot, entryName);
    const insideDestination =
      targetPath === destinationRoot ||
      targetPath.startsWith(`${destinationRoot}${path.sep}`);

    if (!insideDestination) {
      throw httpError(400, "zip 文件包含不安全路径");
    }

    if (entry.isDirectory) {
      await fsp.mkdir(targetPath, { recursive: true });
      continue;
    }

    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, entry.getData());
  }
}

async function resolveProjectRoot(sourceDir) {
  if (await exists(path.join(sourceDir, "package.json"))) {
    return sourceDir;
  }

  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  const meaningful = entries.filter(
    (entry) => entry.name !== "__MACOSX" && entry.name !== ".DS_Store"
  );

  if (meaningful.length === 1 && meaningful[0].isDirectory()) {
    return path.join(sourceDir, meaningful[0].name);
  }

  return sourceDir;
}

async function startInstall(service) {
  service.status = "installing";
  service.updatedAt = new Date().toISOString();
  service.lastError = null;
  await saveState();

  const child = spawnServiceCommand(service, service.installCommand);
  const entry = { child };
  installProcesses.set(service.id, entry);

  await appendLog(service, `install started: ${service.installCommand}`);
  pipeProcessLogs(service, child, "install");

  child.on("error", async (error) => {
    installProcesses.delete(service.id);
    service.status = "error";
    service.lastError = error.message;
    service.updatedAt = new Date().toISOString();
    await appendLog(service, `install error: ${error.message}`);
    await saveState();
  });

  child.on("exit", async (code, signal) => {
    if (installProcesses.get(service.id) !== entry) {
      return;
    }

    installProcesses.delete(service.id);
    service.status = code === 0 ? "stopped" : "error";
    service.lastExitCode = code;
    service.lastSignal = signal;
    service.lastError = code === 0 ? null : `安装命令退出码 ${code}`;
    service.updatedAt = new Date().toISOString();
    await appendLog(service, `install exited: code=${code} signal=${signal}`);
    await saveState();
  });
}

async function startService(service, reason) {
  if (serviceProcesses.has(service.id)) {
    throw httpError(409, "服务已经在运行");
  }

  if (installProcesses.has(service.id)) {
    throw httpError(409, "安装任务运行中");
  }

  if (!service.startCommand.trim()) {
    throw httpError(400, "启动命令不能为空");
  }

  if (!(await canBindPort(service.port))) {
    throw httpError(409, "端口已经被其他进程监听");
  }

  const child = spawnServiceCommand(service, service.startCommand);
  const entry = { child, stopping: false };
  serviceProcesses.set(service.id, entry);

  service.status = "running";
  service.lastStartedAt = new Date().toISOString();
  service.lastStoppedAt = null;
  service.lastExitCode = null;
  service.lastSignal = null;
  service.lastError = null;
  service.updatedAt = new Date().toISOString();
  await saveState();

  await appendLog(service, `service started (${reason}): ${service.startCommand}`);
  pipeProcessLogs(service, child, "service");

  child.on("error", async (error) => {
    if (serviceProcesses.get(service.id) === entry) {
      serviceProcesses.delete(service.id);
    }
    service.status = "error";
    service.lastError = error.message;
    service.updatedAt = new Date().toISOString();
    await appendLog(service, `service error: ${error.message}`);
    await saveState();
  });

  child.on("exit", async (code, signal) => {
    if (serviceProcesses.get(service.id) !== entry) {
      return;
    }

    serviceProcesses.delete(service.id);
    service.lastExitCode = code;
    service.lastSignal = signal;
    service.lastStoppedAt = new Date().toISOString();
    service.status = entry.stopping || code === 0 ? "stopped" : "error";
    service.lastError =
      entry.stopping || code === 0 ? null : `启动命令退出码 ${code}`;
    service.updatedAt = new Date().toISOString();
    await appendLog(service, `service exited: code=${code} signal=${signal}`);
    await saveState();
  });
}

async function stopService(service, reason) {
  const entry = serviceProcesses.get(service.id);

  if (!entry) {
    service.status = "stopped";
    service.lastStoppedAt = service.lastStoppedAt || new Date().toISOString();
    service.updatedAt = new Date().toISOString();
    await saveState();
    return;
  }

  entry.stopping = true;
  await appendLog(service, `service stopping (${reason})`);

  await terminateChild(entry.child);
  serviceProcesses.delete(service.id);
  service.status = "stopped";
  service.lastStoppedAt = new Date().toISOString();
  service.updatedAt = new Date().toISOString();
  await saveState();
}

function spawnServiceCommand(service, command) {
  return spawn(command, {
    cwd: service.projectRoot,
    env: commandEnv(service),
    shell: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commandEnv(service) {
  return {
    ...process.env,
    PORT: String(service.port),
    HOST: "0.0.0.0",
    HOSTNAME: "0.0.0.0",
    VITE_HOST: "0.0.0.0",
    VITE_PORT: String(service.port),
    npm_config_host: "0.0.0.0",
    npm_config_port: String(service.port),
    NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED || "1",
    BROWSER: "none",
  };
}

function terminateChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }

    const done = () => {
      clearTimeout(killTimer);
      resolve();
    };

    const killTimer = setTimeout(() => {
      sendSignal(child, "SIGKILL");
      resolve();
    }, 8000);

    child.once("exit", done);
    sendSignal(child, "SIGTERM");
  });
}

function sendSignal(child, signal) {
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (_error) {
    try {
      child.kill(signal);
    } catch (_fallbackError) {
      // Process already exited.
    }
  }
}

function pipeProcessLogs(service, child, label) {
  child.stdout.on("data", (chunk) => appendLogChunk(service, label, chunk));
  child.stderr.on("data", (chunk) => appendLogChunk(service, `${label}:err`, chunk));
}

function appendLogChunk(service, label, chunk) {
  const lines = String(chunk)
    .replace(/\r/g, "")
    .split("\n")
    .filter(Boolean);

  for (const line of lines) {
    appendLog(service, `[${label}] ${line}`).catch(() => {});
  }
}

async function appendLog(service, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await fsp.mkdir(path.dirname(service.logFile), { recursive: true });
  await fsp.appendFile(service.logFile, line);
}

async function readTail(filePath, maxBytes) {
  if (!(await exists(filePath))) {
    return "";
  }

  const stat = await fsp.stat(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const handle = await fsp.open(filePath, "r");

  try {
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function getRuntimeStatus(service) {
  if (installProcesses.has(service.id)) {
    return "installing";
  }

  if (serviceProcesses.has(service.id)) {
    return "running";
  }

  return service.status || "stopped";
}

function getServiceOrThrow(id) {
  const service = services.get(id);
  if (!service) {
    throw httpError(404, "服务不存在");
  }
  return service;
}

function uniqueServiceId(name) {
  const base = slugify(name);
  let candidate = base;
  let index = 2;

  while (services.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }

  return candidate;
}

function slugify(value) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || `service-${crypto.randomBytes(4).toString("hex")}`;
}

function getRequestHost(req) {
  const hostHeader = req.get("host") || `localhost:${CENTER_PORT}`;
  return hostHeader.replace(/:\d+$/, "");
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) {
    console.error(error);
  }
  res.status(status).json({
    error: error.message || "服务器错误",
  });
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}
