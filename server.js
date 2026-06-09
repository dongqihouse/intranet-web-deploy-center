const AdmZip = require("adm-zip");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
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
const ZIP_MODE_SYMLINK = 0o120000;
const ZIP_MODE_TYPE_MASK = 0o170000;

fs.mkdirSync(SERVICES_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const app = express();
const services = new Map();
const serviceProcesses = new Map();
const installProcesses = new Map();
const jsonParser = express.json({ limit: "1mb" });

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

app.use((req, res, next) => {
  if (req.path.startsWith("/services/")) {
    next();
    return;
  }

  jsonParser(req, res, next);
});
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
      await fsp.rm(serviceDir, { recursive: true, force: true });
      await fsp.mkdir(sourceDir, { recursive: true });

      try {
        await extractZip(filePath, sourceDir);
        const projectRoot = await resolveProjectRoot(
          sourceDir,
          input.projectSubdir
        );

        const service = {
          id: serviceId,
          name: input.name,
          port: input.port,
          projectSubdir: input.projectSubdir,
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

  app.get("/services/:id", (req, res) => {
    res.redirect(302, `${req.originalUrl}/`);
  });

  app.use("/services/:id/", proxyServiceRequest);

  const server = http.createServer(app);
  server.on("upgrade", proxyServiceUpgrade);
  server.listen(CENTER_PORT, "0.0.0.0", () => {
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
  const host = getRequestHostWithPort(req);
  const status = getRuntimeStatus(service);
  const portListening = await isPortListening(service.port);

  return {
    id: service.id,
    name: service.name,
    port: service.port,
    projectSubdir: service.projectSubdir || "",
    installCommand: service.installCommand,
    startCommand: service.startCommand,
    note: service.note,
    serviceDir: service.serviceDir,
    projectRoot: service.projectRoot,
    status,
    pid: serviceProcesses.get(service.id)?.child.pid || null,
    portListening,
    url: `http://${host}${getServiceBasePath(service)}`,
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
  const projectSubdir = normalizeProjectSubdir(body.projectSubdir);
  const installCommand = String(
    body.installCommand || "rm -rf node_modules && npm install --include=dev"
  ).trim();
  const startCommand = String(
    body.startCommand ||
      "npm run dev -- --host 0.0.0.0 --port $PORT --strictPort --base $SERVICE_BASE_PATH"
  ).trim();
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
    projectSubdir,
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

    const mode = getZipEntryMode(entry);
    if ((mode & ZIP_MODE_TYPE_MASK) === ZIP_MODE_SYMLINK) {
      await createSafeSymlink(entry, targetPath, destinationRoot);
      continue;
    }

    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, entry.getData());
    await applyZipEntryMode(targetPath, mode, entryName);
  }
}

function getZipEntryMode(entry) {
  return (entry.header.attr >>> 16) & 0o777777;
}

async function createSafeSymlink(entry, targetPath, destinationRoot) {
  const linkTarget = entry.getData().toString("utf8");
  const normalizedTarget = linkTarget.replace(/\\/g, "/");

  if (
    !linkTarget ||
    linkTarget.includes("\0") ||
    path.isAbsolute(normalizedTarget) ||
    path.win32.isAbsolute(linkTarget)
  ) {
    return;
  }

  const resolvedLinkTarget = path.resolve(
    path.dirname(targetPath),
    normalizedTarget
  );
  const insideDestination =
    resolvedLinkTarget === destinationRoot ||
    resolvedLinkTarget.startsWith(`${destinationRoot}${path.sep}`);

  if (!insideDestination) {
    return;
  }

  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  if (!(await removeExistingSymlinkTarget(targetPath))) {
    return;
  }

  await fsp.symlink(linkTarget, targetPath);
}

async function removeExistingSymlinkTarget(targetPath) {
  let stat;

  try {
    stat = await fsp.lstat(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return true;
    }

    throw error;
  }

  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    return false;
  }

  await fsp.rm(targetPath, { force: true });
  return true;
}

async function applyZipEntryMode(targetPath, mode, entryName) {
  const executable = Boolean(mode & 0o111) || isNodeBinPath(entryName);
  if (executable) {
    await fsp.chmod(targetPath, 0o755);
  }
}

function isNodeBinPath(entryName) {
  return /(^|\/)node_modules\/\.bin\/[^/]+$/.test(entryName);
}

async function resolveProjectRoot(sourceDir, projectSubdir) {
  const archiveRoot = await resolveArchiveRoot(sourceDir);

  if (!projectSubdir) {
    await assertPackageJson(archiveRoot, "zip 根目录需要包含 package.json");
    return archiveRoot;
  }

  const candidates = uniquePaths([
    resolveInside(archiveRoot, projectSubdir),
    resolveInside(sourceDir, projectSubdir),
  ]);

  for (const candidate of candidates) {
    if (await exists(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  throw httpError(400, `项目目录 ${projectSubdir} 需要包含 package.json`);
}

async function resolveArchiveRoot(sourceDir) {
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

async function assertPackageJson(directory, message) {
  if (!(await exists(path.join(directory, "package.json")))) {
    throw httpError(400, message);
  }
}

function normalizeProjectSubdir(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "." || raw === "./") {
    return "";
  }

  if (raw.length > 200) {
    throw httpError(400, "项目目录不能超过 200 个字符");
  }

  const normalized = raw.replace(/\\/g, "/");
  if (
    normalized.includes("\0") ||
    path.isAbsolute(normalized) ||
    /^[a-z]:\//i.test(normalized)
  ) {
    throw httpError(400, "项目目录必须是 zip 内的相对路径");
  }

  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw httpError(400, "项目目录不能包含 ..");
  }

  return parts.join("/");
}

function resolveInside(root, relativePath) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(rootPath, relativePath);
  const insideRoot =
    targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);

  if (!insideRoot) {
    throw httpError(400, "项目目录不能跳出 zip 根目录");
  }

  return targetPath;
}

function uniquePaths(paths) {
  return Array.from(new Set(paths));
}

async function repairNpmBinLinks(service) {
  const nodeModulesDir = path.join(service.projectRoot, "node_modules");
  if (!(await exists(nodeModulesDir))) {
    return;
  }

  const binDir = path.join(nodeModulesDir, ".bin");
  await fsp.mkdir(binDir, { recursive: true });

  let repaired = await repairExistingNpmBinEntries(binDir, nodeModulesDir);
  const packageDirs = await listNodeModulePackageDirs(nodeModulesDir);

  for (const packageDir of packageDirs) {
    const packageJson = path.join(packageDir, "package.json");
    if (!(await exists(packageJson))) {
      continue;
    }

    const packageData = await readJsonFile(packageJson);
    const bins = getPackageBins(packageData);
    for (const [binName, binTarget] of bins) {
      const targetPath = resolvePackageBinTarget(packageDir, binTarget);
      if (!targetPath) {
        continue;
      }

      if (!(await exists(targetPath))) {
        continue;
      }

      await fsp.chmod(targetPath, 0o755).catch(() => {});
      repaired += await ensureNpmBinSymlink(binDir, binName, targetPath);
    }
  }

  if (repaired > 0) {
    await appendLog(service, `npm bin links repaired: ${repaired}`);
  }
}

async function repairExistingNpmBinEntries(binDir, nodeModulesDir) {
  const entries = await fsp.readdir(binDir, { withFileTypes: true });
  let repaired = 0;

  for (const entry of entries) {
    const binPath = path.join(binDir, entry.name);
    const stat = await fsp.lstat(binPath);

    if (stat.isSymbolicLink()) {
      const linkTarget = await fsp.readlink(binPath);
      const targetPath = resolveSafeNpmBinTarget(
        binDir,
        linkTarget,
        nodeModulesDir
      );
      await fsp.chmod(targetPath, 0o755).catch(() => {});
      continue;
    }

    if (!stat.isFile()) {
      continue;
    }

    const linkTarget = await readPlainLinkTarget(binPath);
    if (!linkTarget) {
      if ((stat.mode & 0o111) === 0) {
        await fsp.chmod(binPath, 0o755);
        repaired += 1;
      }
      continue;
    }

    const targetPath = resolveSafeNpmBinTarget(
      binDir,
      linkTarget,
      nodeModulesDir
    );
    await fsp.chmod(targetPath, 0o755).catch(() => {});
    await fsp.unlink(binPath);
    await fsp.symlink(linkTarget, binPath);
    repaired += 1;
  }

  return repaired;
}

async function readPlainLinkTarget(filePath) {
  const text = await fsp.readFile(filePath, "utf8").catch(() => "");
  const linkTarget = text.trim();

  if (
    !linkTarget ||
    linkTarget.includes("\0") ||
    linkTarget.includes("\n") ||
    linkTarget.startsWith("#!") ||
    path.isAbsolute(linkTarget)
  ) {
    return "";
  }

  return linkTarget;
}

function resolveSafeNpmBinTarget(binDir, linkTarget, nodeModulesDir) {
  const targetPath = path.resolve(binDir, linkTarget);
  const nodeModulesRoot = path.resolve(nodeModulesDir);
  const insideNodeModules =
    targetPath === nodeModulesRoot ||
    targetPath.startsWith(`${nodeModulesRoot}${path.sep}`);

  if (!insideNodeModules) {
    throw httpError(400, "node_modules/.bin 包含不安全链接");
  }

  return targetPath;
}

async function listNodeModulePackageDirs(nodeModulesDir) {
  const entries = await fsp.readdir(nodeModulesDir, { withFileTypes: true });
  const packageDirs = [];

  for (const entry of entries) {
    if (entry.name === ".bin" || entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      const scopedEntries = await fsp.readdir(entryPath, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) {
          packageDirs.push(path.join(entryPath, scopedEntry.name));
        }
      }
      continue;
    }

    if (entry.isDirectory() || entry.isSymbolicLink()) {
      packageDirs.push(entryPath);
    }
  }

  return packageDirs;
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (_error) {
    return {};
  }
}

function getPackageBins(packageData) {
  const bins = [];

  if (typeof packageData.bin === "string" && packageData.name) {
    bins.push([getPackageBinName(packageData.name), packageData.bin]);
  } else if (packageData.bin && typeof packageData.bin === "object") {
    for (const [binName, binTarget] of Object.entries(packageData.bin)) {
      bins.push([binName, binTarget]);
    }
  }

  return bins.filter(
    ([binName, binTarget]) =>
      isSafeBinName(binName) && typeof binTarget === "string" && binTarget.trim()
  );
}

function resolvePackageBinTarget(packageDir, binTarget) {
  const normalized = String(binTarget).trim().replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    path.isAbsolute(normalized)
  ) {
    return null;
  }

  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    return null;
  }

  return path.resolve(packageDir, parts.join("/"));
}

function getPackageBinName(packageName) {
  return String(packageName).split("/").pop();
}

function isSafeBinName(binName) {
  return (
    typeof binName === "string" &&
    Boolean(binName) &&
    !binName.includes("/") &&
    !binName.includes("\\") &&
    !binName.includes("\0")
  );
}

async function ensureNpmBinSymlink(binDir, binName, targetPath) {
  const binPath = path.join(binDir, binName);
  const linkTarget = path.relative(binDir, targetPath);

  if (await exists(binPath)) {
    const stat = await fsp.lstat(binPath);
    if (stat.isSymbolicLink()) {
      const currentTarget = await fsp.readlink(binPath);
      if (currentTarget === linkTarget) {
        return 0;
      }
    }

    await fsp.rm(binPath, { force: true });
  }

  await fsp.symlink(linkTarget, binPath);
  return 1;
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
    let binRepairError = null;

    if (code === 0) {
      try {
        await repairNpmBinLinks(service);
      } catch (error) {
        binRepairError = error;
      }
    }

    service.status = code === 0 && !binRepairError ? "stopped" : "error";
    service.lastExitCode = code;
    service.lastSignal = signal;
    service.lastError = binRepairError
      ? binRepairError.message
      : code === 0
        ? null
        : `安装命令退出码 ${code}`;
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

  await repairNpmBinLinks(service);

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
    NODE_ENV: process.env.SERVICE_NODE_ENV || "development",
    PORT: String(service.port),
    HOST: "0.0.0.0",
    HOSTNAME: "0.0.0.0",
    VITE_HOST: "0.0.0.0",
    VITE_PORT: String(service.port),
    npm_config_host: "0.0.0.0",
    npm_config_port: String(service.port),
    npm_config_include: process.env.npm_config_include || "dev",
    npm_config_production: process.env.npm_config_production || "false",
    SERVICE_ID: service.id,
    SERVICE_BASE_PATH: getServiceBasePath(service),
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

function proxyServiceRequest(req, res) {
  const service = getServiceOrThrow(req.params.id);

  if (!serviceProcesses.has(service.id)) {
    sendError(res, httpError(409, "服务未运行"));
    return;
  }

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: service.port,
      method: req.method,
      path: req.originalUrl,
      headers: getProxyRequestHeaders(req, service),
    },
    (proxyRes) => {
      const headers = getProxyResponseHeaders(proxyRes.headers, service);
      res.writeHead(proxyRes.statusCode || 502, headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (error) => {
    if (!res.headersSent) {
      sendError(res, httpError(502, `服务代理失败: ${error.message}`));
    } else {
      res.destroy(error);
    }
  });

  req.pipe(proxyReq);
}

function proxyServiceUpgrade(req, socket, head) {
  const service = getUpgradeService(req);
  if (!service || !serviceProcesses.has(service.id)) {
    socket.destroy();
    return;
  }

  const upstream = net.createConnection(
    { host: "127.0.0.1", port: service.port },
    () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
      writeRawHeaders(upstream, req.rawHeaders);
      upstream.write("\r\n");

      if (head.length > 0) {
        upstream.write(head);
      }

      upstream.pipe(socket);
      socket.pipe(upstream);
    }
  );

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

function getUpgradeService(req) {
  const url = new URL(req.url || "/", `http://localhost:${CENTER_PORT}`);
  const match = url.pathname.match(/^\/services\/([^/]+)\//);
  if (!match) {
    return null;
  }

  return services.get(match[1]) || null;
}

function writeRawHeaders(stream, rawHeaders) {
  for (let index = 0; index < rawHeaders.length; index += 2) {
    stream.write(`${rawHeaders[index]}: ${rawHeaders[index + 1]}\r\n`);
  }
}

function getProxyRequestHeaders(req, service) {
  return {
    ...req.headers,
    host: `127.0.0.1:${service.port}`,
    "x-forwarded-host": req.get("host") || "",
    "x-forwarded-proto": req.protocol,
    "x-forwarded-prefix": getServiceBasePath(service).replace(/\/$/, ""),
  };
}

function getProxyResponseHeaders(headers, service) {
  const nextHeaders = { ...headers };
  const location = nextHeaders.location;

  if (typeof location === "string") {
    nextHeaders.location = rewriteProxyLocation(location, service);
  }

  return nextHeaders;
}

function rewriteProxyLocation(location, service) {
  const internalOrigins = [
    `http://127.0.0.1:${service.port}`,
    `http://localhost:${service.port}`,
  ];

  for (const origin of internalOrigins) {
    if (location.startsWith(origin)) {
      return joinProxyPath(
        getServiceBasePath(service),
        location.slice(origin.length)
      );
    }
  }

  return location;
}

function joinProxyPath(basePath, suffix) {
  if (!suffix) {
    return basePath;
  }

  if (suffix.startsWith("/")) {
    return `${basePath}${suffix.slice(1)}`;
  }

  return `${basePath}${suffix}`;
}

function getServiceBasePath(service) {
  return `/services/${service.id}/`;
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

function getRequestHostWithPort(req) {
  return req.get("host") || `localhost:${CENTER_PORT}`;
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
