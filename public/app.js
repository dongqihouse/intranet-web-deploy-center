const state = {
  services: [],
  selectedServiceId: null,
  portAvailable: false,
  logTimer: null,
};

const form = document.querySelector("#deployForm");
const servicesGrid = document.querySelector("#servicesGrid");
const serviceCount = document.querySelector("#serviceCount");
const refreshButton = document.querySelector("#refreshButton");
const portInput = document.querySelector("#portInput");
const centerPortLabel = document.querySelector("#centerPortLabel");
const portRangeLabel = document.querySelector("#portRangeLabel");
const checkPortButton = document.querySelector("#checkPortButton");
const uploadButton = document.querySelector("#uploadButton");
const terminal = document.querySelector("#terminal");
const selectedLogLabel = document.querySelector("#selectedLogLabel");
const clearLogsButton = document.querySelector("#clearLogsButton");
const cardTemplate = document.querySelector("#serviceCardTemplate");

const statusMeta = {
  running: ["运行中", "status-running"],
  stopped: ["已停止", "status-stopped"],
  installing: ["安装中", "status-installing"],
  error: ["异常", "status-error"],
};

loadHealth();
refreshButton.addEventListener("click", () => refreshServices());
checkPortButton.addEventListener("click", () => checkPort());
portInput.addEventListener("input", () => {
  state.portAvailable = false;
  setPortStatus("待检查");
});
portInput.addEventListener("blur", () => checkPort());
form.addEventListener("submit", handleUpload);
clearLogsButton.addEventListener("click", clearSelectedLogs);

refreshServices();
setInterval(refreshServices, 5000);

async function loadHealth() {
  try {
    const health = await api("/api/health");
    const [start, end] = health.portRange || [10001, 19999];
    centerPortLabel.textContent = `端口 ${health.centerPort}`;
    portRangeLabel.textContent = `范围 ${start}-${end}`;
    portInput.min = start;
    portInput.max = end;
  } catch (_error) {
    centerPortLabel.textContent = "端口 10000";
    portRangeLabel.textContent = "范围 10001-19999";
  }
}

async function refreshServices() {
  try {
    const data = await api("/api/services");
    state.services = data.services || [];
    renderServices();

    if (state.selectedServiceId) {
      const selected = state.services.find(
        (service) => service.id === state.selectedServiceId
      );
      if (!selected) {
        selectService(null);
      }
    }
  } catch (error) {
    serviceCount.textContent = "读取失败";
    terminal.textContent = error.message;
  }
}

function renderServices() {
  serviceCount.textContent = `${state.services.length} 个服务`;
  servicesGrid.textContent = "";

  if (state.services.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无已部署服务";
    servicesGrid.append(empty);
    return;
  }

  for (const service of state.services) {
    servicesGrid.append(renderServiceCard(service));
  }
}

function renderServiceCard(service) {
  const node = cardTemplate.content.firstElementChild.cloneNode(true);
  const status = statusMeta[service.status] || statusMeta.error;

  node.querySelector("h3").textContent = `${service.name}:${service.port}`;
  node.querySelector(".port-line").textContent = service.portListening
    ? `端口 ${service.port} 已监听`
    : `端口 ${service.port} 未监听`;
  node.querySelector(".status-pill").textContent = status[0];
  node.querySelector(".status-pill").classList.add(status[1]);
  node.querySelector(".path-line").textContent = service.projectRoot;
  node.querySelector(".command-line").textContent = service.startCommand;
  node.querySelector(".note-line").textContent =
    service.note || service.projectSubdir || "";

  const isRunning = service.status === "running";
  const isInstalling = service.status === "installing";
  node.querySelector(".action-open").disabled = !service.portListening;
  node.querySelector(".action-install").disabled = isRunning || isInstalling;
  node.querySelector(".action-start").disabled = isRunning || isInstalling;
  node.querySelector(".action-stop").disabled = !isRunning;
  node.querySelector(".action-restart").disabled = isInstalling;

  node
    .querySelector(".action-open")
    .addEventListener("click", () => window.open(service.url, "_blank"));
  node
    .querySelector(".action-install")
    .addEventListener("click", () => serviceAction(service.id, "install"));
  node
    .querySelector(".action-start")
    .addEventListener("click", () => serviceAction(service.id, "start"));
  node
    .querySelector(".action-stop")
    .addEventListener("click", () => serviceAction(service.id, "stop"));
  node
    .querySelector(".action-restart")
    .addEventListener("click", () => serviceAction(service.id, "restart"));
  node
    .querySelector(".action-logs")
    .addEventListener("click", () => selectService(service.id));
  node
    .querySelector(".action-delete")
    .addEventListener("click", () => deleteService(service));

  return node;
}

async function checkPort() {
  const port = Number(portInput.value);
  state.portAvailable = false;

  if (!Number.isInteger(port)) {
    setPortStatus("待检查");
    return false;
  }

  setPortStatus("检查中");

  try {
    const response = await fetch(`/api/ports/${port}`);
    const data = await response.json();
    state.portAvailable = response.ok && data.available;
    setPortStatus(data.reason || (state.portAvailable ? "端口可用" : "不可用"));
    return state.portAvailable;
  } catch (error) {
    setPortStatus(error.message || "检查失败");
    return false;
  }
}

function setPortStatus(label) {
  const neutral = label === "待检查" || label === "检查中";
  checkPortButton.textContent = label;
  checkPortButton.classList.toggle("available", state.portAvailable);
  checkPortButton.classList.toggle(
    "unavailable",
    Boolean(label && !neutral && !state.portAvailable)
  );
}

async function handleUpload(event) {
  event.preventDefault();

  uploadButton.disabled = true;
  uploadButton.textContent = "上传中";

  try {
    const ok = await checkPort();
    if (!ok) {
      throw new Error("端口不可用");
    }

    const data = await api("/api/services", {
      method: "POST",
      body: new FormData(form),
    });

    form.reset();
    state.portAvailable = false;
    setPortStatus("待检查");
    await refreshServices();
    selectService(data.service.id);
  } catch (error) {
    alert(error.message);
  } finally {
    uploadButton.disabled = false;
    uploadButton.textContent = "上传部署";
  }
}

async function serviceAction(id, action) {
  try {
    await api(`/api/services/${id}/${action}`, { method: "POST" });
    await refreshServices();
    selectService(id);
  } catch (error) {
    alert(error.message);
  }
}

async function deleteService(service) {
  const confirmed = confirm(`删除服务 ${service.name}:${service.port}？`);
  if (!confirmed) {
    return;
  }

  try {
    await api(`/api/services/${service.id}`, { method: "DELETE" });
    if (state.selectedServiceId === service.id) {
      selectService(null);
    }
    await refreshServices();
  } catch (error) {
    alert(error.message);
  }
}

function selectService(id) {
  state.selectedServiceId = id;
  clearInterval(state.logTimer);
  state.logTimer = null;

  if (!id) {
    selectedLogLabel.textContent = "选择服务查看日志";
    terminal.textContent = "选择服务查看日志";
    clearLogsButton.disabled = true;
    return;
  }

  const selected = state.services.find((service) => service.id === id);
  selectedLogLabel.textContent = selected
    ? `${selected.name}:${selected.port}`
    : "选择服务查看日志";
  clearLogsButton.disabled = false;
  loadLogs();
  state.logTimer = setInterval(loadLogs, 2000);
}

async function loadLogs() {
  if (!state.selectedServiceId) {
    return;
  }

  try {
    const response = await fetch(`/api/services/${state.selectedServiceId}/logs`);
    if (!response.ok) {
      throw new Error("日志读取失败");
    }
    const text = await response.text();
    const shouldStick =
      terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 80;
    terminal.textContent = text;
    if (shouldStick) {
      terminal.scrollTop = terminal.scrollHeight;
    }
  } catch (error) {
    terminal.textContent = error.message;
  }
}

async function clearSelectedLogs() {
  if (!state.selectedServiceId) {
    return;
  }

  await api(`/api/services/${state.selectedServiceId}/logs`, {
    method: "DELETE",
  });
  await loadLogs();
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const body = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const message = isJson ? body.error : body;
    throw new Error(message || `请求失败: ${response.status}`);
  }

  return body;
}
