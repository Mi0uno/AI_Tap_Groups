const elements = {
  endpointInput: document.querySelector("#endpointInput"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  modelInput: document.querySelector("#modelInput"),
  scopeInput: document.querySelector("#scopeInput"),
  maxGroupsInput: document.querySelector("#maxGroupsInput"),
  aiTimeoutInput: document.querySelector("#aiTimeoutInput"),
  groupPrefixInput: document.querySelector("#groupPrefixInput"),
  includePinnedInput: document.querySelector("#includePinnedInput"),
  sendFullUrlsInput: document.querySelector("#sendFullUrlsInput"),
  autoGroupEnabledInput: document.querySelector("#autoGroupEnabledInput"),
  autoGroupDebounceInput: document.querySelector("#autoGroupDebounceInput"),
  saveButton: document.querySelector("#saveButton"),
  saveAndGroupButton: document.querySelector("#saveAndGroupButton"),
  groupTabsButton: document.querySelector("#groupTabsButton"),
  status: document.querySelector("#status")
};

let jobPollTimer = null;

document.addEventListener("DOMContentLoaded", initializePopup);

async function initializePopup() {
  bindEvents();

  try {
    const response = await sendMessage({ type: "GET_SETTINGS" });
    fillSettings(response.settings);
    await refreshJobStatus();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function bindEvents() {
  elements.saveButton.addEventListener("click", async () => {
    await withBusyState(async () => {
      await saveSettings();
      setStatus("配置已保存。", "success");
    });
  });

  elements.saveAndGroupButton.addEventListener("click", async () => {
    await withBusyState(async () => {
      await saveSettings();
      await runGrouping();
    });
  });

  elements.groupTabsButton.addEventListener("click", async () => {
    await withBusyState(async () => {
      await saveSettings();
      await runGrouping();
    });
  });
}

function fillSettings(settings) {
  elements.endpointInput.value = settings.endpoint || "";
  elements.apiKeyInput.value = settings.apiKey || "";
  elements.modelInput.value = settings.model || "";
  elements.scopeInput.value = settings.scope || "currentWindow";
  elements.maxGroupsInput.value = settings.maxGroups || 8;
  elements.aiTimeoutInput.value = settings.aiRequestTimeoutSeconds || 60;
  elements.groupPrefixInput.value = settings.groupPrefix || "";
  elements.includePinnedInput.checked = Boolean(settings.includePinned);
  elements.sendFullUrlsInput.checked = Boolean(settings.sendFullUrls);
  elements.autoGroupEnabledInput.checked = Boolean(settings.autoGroupEnabled);
  elements.autoGroupDebounceInput.value = settings.autoGroupDebounceSeconds || 5;
}

function readSettings() {
  return {
    endpoint: elements.endpointInput.value,
    apiKey: elements.apiKeyInput.value,
    model: elements.modelInput.value,
    scope: elements.scopeInput.value,
    maxGroups: Number(elements.maxGroupsInput.value),
    aiRequestTimeoutSeconds: Number(elements.aiTimeoutInput.value),
    groupPrefix: elements.groupPrefixInput.value,
    includePinned: elements.includePinnedInput.checked,
    sendFullUrls: elements.sendFullUrlsInput.checked,
    autoGroupEnabled: elements.autoGroupEnabledInput.checked,
    autoGroupDebounceSeconds: Number(elements.autoGroupDebounceInput.value)
  };
}

async function saveSettings() {
  const settings = readSettings();
  const response = await sendMessage({ type: "SAVE_SETTINGS", settings });
  fillSettings(response.settings);
}

async function runGrouping() {
  setStatus("已提交后台分组任务，关闭弹窗也会继续执行。");
  const response = await sendMessage({ type: "GROUP_TABS" });
  if (response.result) {
    renderGroupingResult(response.result);
    return;
  }

  renderJobStatus(response.job);
  startJobPolling();
}

async function withBusyState(action) {
  setBusy(true);

  try {
    await action();
  } catch (error) {
    setStatus(error.message || "操作失败。", "error");
  } finally {
    setBusy(false);
  }
}

function setBusy(isBusy) {
  elements.saveButton.disabled = isBusy;
  elements.saveAndGroupButton.disabled = isBusy;
  elements.groupTabsButton.disabled = isBusy;
}

function setStatus(message, tone = "") {
  elements.status.textContent = message;
  elements.status.className = tone ? `status ${tone}` : "status";
}

async function refreshJobStatus() {
  let response;

  try {
    response = await sendMessage({ type: "GET_GROUP_JOB" });
  } catch (error) {
    if (error.message.includes("Unsupported message type: GET_GROUP_JOB")) {
      setStatus("配置已载入。请在 edge://extensions/ 刷新扩展以启用后台任务状态。");
      return;
    }

    throw error;
  }

  renderJobStatus(response.job);

  if (isActiveJob(response.job) && !jobPollTimer) {
    startJobPolling();
  }
}

function startJobPolling() {
  stopJobPolling();
  jobPollTimer = setInterval(() => {
    refreshJobStatus().catch((error) => {
      stopJobPolling();
      setStatus(error.message || "读取任务状态失败。", "error");
    });
  }, 1500);
}

function stopJobPolling() {
  if (jobPollTimer) {
    clearInterval(jobPollTimer);
    jobPollTimer = null;
  }
}

function renderJobStatus(job) {
  if (!job) {
    setStatus("配置已载入。");
    return;
  }

  if (job.status === "queued") {
    setStatus("后台分组任务已排队，稍后开始。");
    return;
  }

  if (job.status === "running") {
    setStatus("后台正在分析并分组标签页，关闭弹窗也会继续。");
    return;
  }

  stopJobPolling();

  if (job.status === "completed") {
    renderGroupingResult(job.result || {});
    return;
  }

  if (job.status === "failed") {
    setStatus(job.error || "后台分组任务失败。", "error");
    return;
  }

  setStatus("配置已载入。");
}

function isActiveJob(job) {
  return job && ["queued", "running"].includes(job.status);
}

function renderGroupingResult(result) {
  const suffix = result.usedFallback
    ? ` 已使用本地兜底规则：${result.fallbackReason || "AI 调用失败"}。`
    : "";
  setStatus(`${result.message || "分组完成。"} 已分组 ${result.groupedTabs || 0} 个标签页。${suffix}`, "success");
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error || "Extension background script did not respond."));
        return;
      }

      resolve(response);
    });
  });
}
