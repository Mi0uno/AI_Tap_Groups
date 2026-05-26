const DEFAULT_SETTINGS = {
  endpoint: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  model: "gpt-4.1-mini",
  scope: "currentWindow",
  includePinned: false,
  sendFullUrls: false,
  groupPrefix: "",
  maxGroups: 8,
  aiRequestTimeoutSeconds: 60,
  autoGroupEnabled: false,
  autoGroupDebounceSeconds: 5
};

const AUTO_GROUP_CHANGE_ALARM = "auto-group-tabs-after-change";
const AUTO_GROUP_PERIODIC_ALARM = "auto-group-tabs-periodic";
const MANUAL_GROUP_ALARM = "manual-group-tabs";
const AUTO_GROUP_STATE_KEY = "__aiTabGrouperAutoState";
const MANUAL_GROUP_JOB_KEY = "__aiTabGrouperManualJob";
const AUTO_UNGROUPABLE_TABS_KEY = "__aiTabGrouperUngroupableTabs";
const AUTO_GROUP_PERIODIC_FALLBACK_MINUTES = 5;
const AUTO_GROUP_ALARM_FALLBACK_MINUTES = 0.5;
const UNGROUPED_GROUP_ID = -1;
const JOB_STALE_AFTER_MS = 10 * 60 * 1000;
const MAX_GROUPS_SETTING = 999;
let autoGroupTimer = null;

const GROUP_COLORS = [
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
  "grey"
];

chrome.runtime.onInstalled.addListener(async () => {
  const storedSettings = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const missingDefaults = Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).filter(([key]) => storedSettings[key] === undefined)
  );

  if (Object.keys(missingDefaults).length > 0) {
    await chrome.storage.local.set(missingDefaults);
  }

  await configureAutoGrouping(await getSettings());
});

chrome.runtime.onStartup.addListener(async () => {
  await configureAutoGrouping(await getSettings());
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "group-tabs") {
    enqueueManualGrouping("command").catch((error) => {
      console.error("Failed to enqueue grouping from command:", error);
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MANUAL_GROUP_ALARM) {
    runManualGroupingJob().catch((error) => {
      console.error("Manual background grouping failed:", error);
    });
    return;
  }

  if (![AUTO_GROUP_CHANGE_ALARM, AUTO_GROUP_PERIODIC_ALARM].includes(alarm.name)) {
    return;
  }

  runAutomaticGrouping(alarm.name).catch((error) => {
    console.error("Silent automatic grouping failed:", error);
  });
});

chrome.tabs.onCreated.addListener(() => {
  scheduleAutoGroupingAfterChange();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearAutoUngroupableTab(tabId).catch((error) => {
    console.error("Failed to clear automatic grouping ignore marker:", error);
  });
  scheduleAutoGroupingAfterChange();
});

chrome.tabs.onAttached.addListener(() => {
  scheduleAutoGroupingAfterChange();
});

chrome.tabs.onDetached.addListener(() => {
  scheduleAutoGroupingAfterChange();
});

chrome.tabs.onMoved.addListener(() => {
  scheduleAutoGroupingAfterChange();
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.title || changeInfo.url) {
    scheduleAutoGroupingAfterChange();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("AI Tab Grouper error:", error);
      sendResponse({ ok: false, error: error.message || "Unknown error" });
    });

  return true;
});

async function handleMessage(message) {
  if (!message || typeof message.type !== "string") {
    throw new Error("Invalid message");
  }

  if (message.type === "GET_SETTINGS") {
    return { ok: true, settings: await getSettings() };
  }

  if (message.type === "SAVE_SETTINGS") {
    await saveSettings(message.settings);
    return { ok: true, settings: await getSettings() };
  }

  if (message.type === "GET_GROUP_JOB") {
    return { ok: true, job: await getManualGroupingJob() };
  }

  if (message.type === "GROUP_TABS") {
    const job = await enqueueManualGrouping("popup");
    return { ok: true, job };
  }

  throw new Error(`Unsupported message type: ${message.type}`);
}

async function enqueueManualGrouping(trigger) {
  const existingJob = await getManualGroupingJob();
  if (isActiveJob(existingJob)) {
    return existingJob;
  }

  const job = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    status: "queued",
    trigger,
    queuedAt: Date.now(),
    updatedAt: Date.now()
  };

  await chrome.storage.local.set({ [MANUAL_GROUP_JOB_KEY]: job });
  await chrome.alarms.create(MANUAL_GROUP_ALARM, { delayInMinutes: 0.01 });
  return job;
}

async function runManualGroupingJob() {
  const job = await getManualGroupingJob();
  if (!job || job.status === "completed") {
    return;
  }

  const runningJob = {
    ...job,
    status: "running",
    startedAt: job.startedAt || Date.now(),
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [MANUAL_GROUP_JOB_KEY]: runningJob });

  try {
    const result = await groupTabs({ source: "manual", trigger: runningJob.trigger });
    await chrome.storage.local.set({
      [MANUAL_GROUP_JOB_KEY]: {
        ...runningJob,
        status: "completed",
        result,
        completedAt: Date.now(),
        updatedAt: Date.now()
      }
    });
  } catch (error) {
    await chrome.storage.local.set({
      [MANUAL_GROUP_JOB_KEY]: {
        ...runningJob,
        status: "failed",
        error: error.message || "Unknown error",
        completedAt: Date.now(),
        updatedAt: Date.now()
      }
    });
  }
}

async function getManualGroupingJob() {
  const stored = await chrome.storage.local.get(MANUAL_GROUP_JOB_KEY);
  return stored[MANUAL_GROUP_JOB_KEY] || null;
}

function isActiveJob(job) {
  if (!job || !["queued", "running"].includes(job.status)) {
    return false;
  }

  return Date.now() - Number(job.updatedAt || job.queuedAt || 0) < JOB_STALE_AFTER_MS;
}

async function getSettings() {
  const storedSettings = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return {
    ...DEFAULT_SETTINGS,
    ...storedSettings
  };
}

async function saveSettings(rawSettings) {
  const settings = sanitizeSettings(rawSettings);
  await chrome.storage.local.set(settings);
  await configureAutoGrouping(settings);
}

function sanitizeSettings(rawSettings = {}) {
  const endpoint = String(rawSettings.endpoint || DEFAULT_SETTINGS.endpoint).trim();
  const apiKey = String(rawSettings.apiKey || "").trim();
  const model = String(rawSettings.model || DEFAULT_SETTINGS.model).trim();
  const scope = rawSettings.scope === "allWindows" ? "allWindows" : "currentWindow";
  const groupPrefix = String(rawSettings.groupPrefix || "").trim().slice(0, 20);
  const maxGroups = clamp(Number(rawSettings.maxGroups || DEFAULT_SETTINGS.maxGroups), 2, MAX_GROUPS_SETTING);
  const aiRequestTimeoutSeconds = clamp(
    Number(rawSettings.aiRequestTimeoutSeconds || DEFAULT_SETTINGS.aiRequestTimeoutSeconds),
    10,
    180
  );
  const autoGroupDebounceSeconds = clamp(
    Number(rawSettings.autoGroupDebounceSeconds || DEFAULT_SETTINGS.autoGroupDebounceSeconds),
    1,
    60
  );

  return {
    endpoint,
    apiKey,
    model,
    scope,
    includePinned: Boolean(rawSettings.includePinned),
    sendFullUrls: Boolean(rawSettings.sendFullUrls),
    groupPrefix,
    maxGroups,
    aiRequestTimeoutSeconds,
    autoGroupEnabled: Boolean(rawSettings.autoGroupEnabled),
    autoGroupDebounceSeconds
  };
}

async function configureAutoGrouping(settings) {
  await Promise.all([
    chrome.alarms.clear(AUTO_GROUP_CHANGE_ALARM),
    chrome.alarms.clear(AUTO_GROUP_PERIODIC_ALARM)
  ]);

  if (!settings.autoGroupEnabled) {
    return;
  }

  await chrome.alarms.create(AUTO_GROUP_PERIODIC_ALARM, {
    delayInMinutes: AUTO_GROUP_PERIODIC_FALLBACK_MINUTES,
    periodInMinutes: AUTO_GROUP_PERIODIC_FALLBACK_MINUTES
  });
}

async function scheduleAutoGroupingAfterChange() {
  const settings = await getSettings();
  if (!settings.autoGroupEnabled) {
    return;
  }

  const gateway = await prepareAutoGroupingGateway(settings);
  if (!gateway.shouldRun) {
    return;
  }

  if (autoGroupTimer) {
    clearTimeout(autoGroupTimer);
  }

  autoGroupTimer = setTimeout(() => {
    autoGroupTimer = null;
    runAutomaticGrouping("tab-change-debounce").catch((error) => {
      console.error("Debounced automatic grouping failed:", error);
    });
  }, settings.autoGroupDebounceSeconds * 1000);

  await chrome.alarms.create(AUTO_GROUP_CHANGE_ALARM, {
    delayInMinutes: Math.max(settings.autoGroupDebounceSeconds / 60, AUTO_GROUP_ALARM_FALLBACK_MINUTES)
  });
}

async function runAutomaticGrouping(trigger) {
  const settings = await getSettings();
  if (!settings.autoGroupEnabled) {
    return;
  }

  const gateway = await prepareAutoGroupingGateway(settings);
  if (!gateway.shouldRun) {
    return;
  }

  await groupTabs({
    source: "auto",
    trigger,
    candidateTabIds: gateway.candidateTabIds
  });
}

async function groupTabs(options = {}) {
  const source = options.source || "manual";
  const settings = await getSettings();
  const collectedTabs = await collectTabs(settings);
  const tabs = filterTabsForGrouping(collectedTabs, options.candidateTabIds);

  if (tabs.length < 2) {
    return {
      groupedTabs: 0,
      groupCount: 0,
      usedFallback: false,
      message: "Need at least two eligible tabs to create groups."
    };
  }

  if (source === "auto" && await shouldSkipAutoGrouping(tabs, settings)) {
    return {
      groupedTabs: 0,
      groupCount: 0,
      usedFallback: false,
      skipped: true,
      message: "Tabs have not changed since the last automatic grouping."
    };
  }

  const strategy = chooseGroupingStrategy(source, tabs);
  const result = strategy.mode === "incremental"
    ? await incrementallyGroupTabs(tabs, settings, strategy)
    : await refreshTabGroups(tabs, settings, strategy);

  result.strategy = strategy.mode;
  result.strategyReason = strategy.reason;

  if (source === "auto") {
    await rememberAutoGrouping(await collectTabs(settings), settings, result);
    await markRemainingAutoUngroupableTabs(options.candidateTabIds, settings);
  }

  return result;
}

function filterTabsForGrouping(tabs, candidateTabIds) {
  if (!Array.isArray(candidateTabIds)) {
    return tabs;
  }

  const candidateIds = new Set(candidateTabIds);
  return tabs.filter((tab) => tab.groupId !== UNGROUPED_GROUP_ID || candidateIds.has(tab.id));
}

function chooseGroupingStrategy(source, tabs) {
  if (source !== "auto") {
    return { mode: "refresh", reason: "manual request" };
  }

  const groupedTabs = tabs.filter((tab) => tab.groupId !== UNGROUPED_GROUP_ID);
  if (groupedTabs.length === 0) {
    return { mode: "refresh", reason: "no existing groups" };
  }

  const groupedRatio = groupedTabs.length / tabs.length;
  if (groupedRatio < 0.5) {
    return { mode: "refresh", reason: "most tabs are ungrouped" };
  }

  return { mode: "incremental", reason: "existing groups cover most tabs" };
}

function hasGroupableUngroupedTabs(tabs) {
  const ungroupedTabs = tabs.filter((tab) => tab.groupId === UNGROUPED_GROUP_ID);
  if (ungroupedTabs.length === 0) {
    return false;
  }

  const existingGroups = buildExistingGroupIndex(tabs);
  const canJoinExistingGroup = ungroupedTabs.some((tab) => {
    const hostname = getHostname(tab.url);
    return hostname && existingGroups.has(`${tab.windowId}:${hostname}`);
  });

  return canJoinExistingGroup || ungroupedTabs.length >= 2;
}

async function prepareAutoGroupingGateway(settings) {
  const tabs = await collectTabs(settings);
  const ignoredIds = await getAutoUngroupableTabIds();
  const existingGroups = buildExistingGroupIndex(tabs);
  const matchingExistingTabs = [];
  const unmatchedTabs = [];

  for (const tab of tabs) {
    if (tab.groupId !== UNGROUPED_GROUP_ID || ignoredIds.has(tab.id)) {
      continue;
    }

    const hostname = getHostname(tab.url);
    const canJoinExisting = hostname && existingGroups.has(`${tab.windowId}:${hostname}`);
    if (canJoinExisting) {
      matchingExistingTabs.push(tab);
      continue;
    }

    unmatchedTabs.push(tab);
  }

  const hasExistingGroups = tabs.some((tab) => tab.groupId !== UNGROUPED_GROUP_ID);
  const shouldAskAiForSingleUnmatchedTab = unmatchedTabs.length === 1 && hasExistingGroups;
  if (unmatchedTabs.length === 1 && !shouldAskAiForSingleUnmatchedTab) {
    await markAutoUngroupableTabs(unmatchedTabs, "single unmatched tab");
  }

  const candidateTabs = [
    ...matchingExistingTabs,
    ...(unmatchedTabs.length >= 2 || shouldAskAiForSingleUnmatchedTab ? unmatchedTabs : [])
  ];

  if (candidateTabs.length === 0) {
    return { shouldRun: false, candidateTabIds: [] };
  }

  return {
    shouldRun: true,
    candidateTabIds: candidateTabs.map((tab) => tab.id)
  };
}

async function refreshTabGroups(tabs, settings, strategy) {
  await clearExistingTabGroups(tabs);
  const tabsByWindow = groupBy(tabs, (tab) => tab.windowId);
  const summaries = [];
  let groupedTabs = 0;
  let groupCount = 0;
  let usedFallback = false;
  let fallbackReason = "";

  for (const [windowId, windowTabs] of tabsByWindow.entries()) {
    const suggestedGroups = await suggestGroups(windowTabs, settings).catch((error) => {
      console.warn("AI grouping failed, falling back to hostname grouping:", error);
      usedFallback = true;
      fallbackReason = error.message || "AI request failed";
      return createFallbackGroups(windowTabs, settings);
    });

    const appliedGroups = await applyTabGroups(Number(windowId), windowTabs, suggestedGroups, settings);
    summaries.push(...appliedGroups);
    groupedTabs += appliedGroups.reduce((count, group) => count + group.tabIds.length, 0);
    groupCount += appliedGroups.length;
  }

  return {
    groupedTabs,
    groupCount,
    usedFallback,
    fallbackReason,
    groups: summaries,
    message: groupCount > 0
      ? `Created ${groupCount} group(s) using ${strategy.mode} grouping.`
      : "No groups were created."
  };
}

async function incrementallyGroupTabs(tabs, settings, strategy) {
  const mergedDuplicateGroups = await mergeDuplicateExistingGroups(tabs);
  const workingTabs = mergedDuplicateGroups.length > 0 ? await collectTabs(settings) : tabs;
  const ungroupedTabs = workingTabs.filter((tab) => tab.groupId === UNGROUPED_GROUP_ID);
  const existingGroups = buildExistingGroupIndex(workingTabs);
  const { matchedTabs, unmatchedTabs, touchedGroups } = await moveTabsIntoMatchingGroups(ungroupedTabs, existingGroups);
  const tabsByWindow = groupBy(unmatchedTabs, (tab) => tab.windowId);
  const summaries = [...mergedDuplicateGroups, ...touchedGroups];
  let groupedTabs = matchedTabs.length;
  let groupCount = mergedDuplicateGroups.length + touchedGroups.length;
  let usedFallback = false;
  let fallbackReason = "";

  for (const [windowId, windowTabs] of tabsByWindow.entries()) {
    const hasExistingWindowGroups = workingTabs.some((tab) => (
      tab.windowId === Number(windowId) && tab.groupId !== UNGROUPED_GROUP_ID
    ));
    if (windowTabs.length < 2 && !hasExistingWindowGroups) {
      continue;
    }

    const suggestedGroups = await suggestIncrementalGroups(Number(windowId), windowTabs, workingTabs, settings).catch((error) => {
      console.warn("AI incremental grouping failed, falling back to hostname grouping:", error);
      usedFallback = true;
      fallbackReason = error.message || "AI request failed";
      return createFallbackGroups(windowTabs, settings);
    });

    const appliedGroups = await applyTabGroups(Number(windowId), windowTabs, suggestedGroups, settings, workingTabs);
    summaries.push(...appliedGroups);
    groupedTabs += appliedGroups.reduce((count, group) => count + group.tabIds.length, 0);
    groupCount += appliedGroups.length;
  }

  return {
    groupedTabs,
    groupCount,
    usedFallback,
    fallbackReason,
    groups: summaries,
    message: groupCount > 0
      ? `Updated ${groupCount} group(s) using ${strategy.mode} grouping.`
      : "No incremental grouping was needed."
  };
}

async function clearExistingTabGroups(tabs) {
  const groupedTabIds = tabs
    .filter((tab) => tab.groupId !== UNGROUPED_GROUP_ID)
    .map((tab) => tab.id);

  if (groupedTabIds.length > 0) {
    await chrome.tabs.ungroup(groupedTabIds);
  }
}

function buildExistingGroupIndex(tabs) {
  const groupedTabs = tabs.filter((tab) => tab.groupId !== UNGROUPED_GROUP_ID);
  const groupsById = groupBy(groupedTabs, (tab) => tab.groupId);
  const hostMatches = new Map();

  for (const [groupId, groupTabs] of groupsById.entries()) {
    const hostCounts = new Map();

    for (const tab of groupTabs) {
      const hostname = getHostname(tab.url);
      if (!hostname) continue;

      hostCounts.set(hostname, (hostCounts.get(hostname) || 0) + 1);
    }

    for (const [hostname] of hostCounts.entries()) {
      const key = `${groupTabs[0].windowId}:${hostname}`;
      const existingMatch = hostMatches.get(key);

      if (existingMatch && existingMatch.groupId !== Number(groupId)) {
        hostMatches.set(key, null);
        continue;
      }

      hostMatches.set(key, {
        groupId: Number(groupId),
        windowId: groupTabs[0].windowId,
        title: `Existing ${groupId}`
      });
    }
  }

  return hostMatches;
}

async function getExistingGroupSummaries(windowId, tabs) {
  const groupedTabs = tabs.filter((tab) => (
    tab.windowId === windowId && tab.groupId !== UNGROUPED_GROUP_ID
  ));
  const tabsByGroup = groupBy(groupedTabs, (tab) => tab.groupId);
  const groupMetadata = new Map();

  try {
    const browserGroups = await chrome.tabGroups.query({ windowId });
    for (const group of browserGroups) {
      groupMetadata.set(group.id, group);
    }
  } catch (error) {
    console.warn("Failed to read existing tab group metadata:", error);
  }

  return [...tabsByGroup.entries()].map(([groupId, groupTabs]) => {
    const metadata = groupMetadata.get(Number(groupId));
    const domains = [...new Set(groupTabs.map((tab) => getHostname(tab.url)).filter(Boolean))].slice(0, 6);
    const sampleTitles = groupTabs
      .map((tab) => tab.title || "Untitled")
      .slice(0, 5);

    return {
      id: Number(groupId),
      title: metadata?.title || `Group ${groupId}`,
      normalizedTitle: normalizeGroupTitle(metadata?.title || `Group ${groupId}`),
      color: metadata?.color || "grey",
      tabCount: groupTabs.length,
      domains,
      sampleTitles
    };
  });
}

async function mergeDuplicateExistingGroups(tabs) {
  const tabsByWindow = groupBy(tabs, (tab) => tab.windowId);
  const mergedGroups = [];

  for (const [windowId, windowTabs] of tabsByWindow.entries()) {
    const existingGroups = await getExistingGroupSummaries(Number(windowId), windowTabs);
    const primaryGroups = [];

    for (const group of [...existingGroups].sort((first, second) => second.tabCount - first.tabCount)) {
      const duplicateGroup = primaryGroups.find((primaryGroup) => (
        areDuplicateGroupTitles(group.normalizedTitle, primaryGroup.normalizedTitle)
      ));

      if (!duplicateGroup) {
        primaryGroups.push(group);
        continue;
      }

      const duplicateTabIds = windowTabs
        .filter((tab) => tab.groupId === group.id)
        .map((tab) => tab.id);

      if (duplicateTabIds.length === 0) {
        continue;
      }

      await chrome.tabs.group({ groupId: duplicateGroup.id, tabIds: duplicateTabIds });
      mergedGroups.push({
        title: duplicateGroup.title,
        color: duplicateGroup.color,
        tabIds: duplicateTabIds,
        existingGroupId: duplicateGroup.id,
        mergedDuplicateGroupId: group.id
      });
    }
  }

  return mergedGroups;
}

async function moveTabsIntoMatchingGroups(tabs, existingGroups) {
  const matchesByGroup = new Map();
  const unmatchedTabs = [];

  for (const tab of tabs) {
    const hostname = getHostname(tab.url);
    const match = hostname ? existingGroups.get(`${tab.windowId}:${hostname}`) : null;

    if (!match) {
      unmatchedTabs.push(tab);
      continue;
    }

    const tabIds = matchesByGroup.get(match.groupId) || [];
    tabIds.push(tab.id);
    matchesByGroup.set(match.groupId, tabIds);
  }

  const matchedTabs = [];
  const touchedGroups = [];

  for (const [groupId, tabIds] of matchesByGroup.entries()) {
    await chrome.tabs.group({ groupId, tabIds });
    matchedTabs.push(...tabIds);
    touchedGroups.push({
      title: `Existing ${groupId}`,
      color: "grey",
      tabIds,
      existing: true
    });
  }

  return { matchedTabs, unmatchedTabs, touchedGroups };
}

async function shouldSkipAutoGrouping(tabs, settings) {
  const state = await chrome.storage.local.get(AUTO_GROUP_STATE_KEY);
  const previousFingerprint = state[AUTO_GROUP_STATE_KEY]?.fingerprint;

  return previousFingerprint === createAutoGroupingFingerprint(tabs, settings);
}

async function getAutoUngroupableTabIds() {
  const stored = await chrome.storage.local.get(AUTO_UNGROUPABLE_TABS_KEY);
  const tabMap = stored[AUTO_UNGROUPABLE_TABS_KEY] || {};
  return new Set(Object.keys(tabMap).map((tabId) => Number(tabId)));
}

async function markAutoUngroupableTabs(tabs, reason) {
  if (!tabs.length) {
    return;
  }

  const stored = await chrome.storage.local.get(AUTO_UNGROUPABLE_TABS_KEY);
  const tabMap = stored[AUTO_UNGROUPABLE_TABS_KEY] || {};
  const markedAt = Date.now();

  for (const tab of tabs) {
    tabMap[tab.id] = {
      reason,
      markedAt,
      title: tab.title || "",
      url: tab.url || ""
    };
  }

  await chrome.storage.local.set({ [AUTO_UNGROUPABLE_TABS_KEY]: tabMap });
}

async function clearAutoUngroupableTab(tabId) {
  const stored = await chrome.storage.local.get(AUTO_UNGROUPABLE_TABS_KEY);
  const tabMap = stored[AUTO_UNGROUPABLE_TABS_KEY] || {};

  if (!tabMap[tabId]) {
    return;
  }

  delete tabMap[tabId];
  await chrome.storage.local.set({ [AUTO_UNGROUPABLE_TABS_KEY]: tabMap });
}

async function markRemainingAutoUngroupableTabs(candidateTabIds, settings) {
  if (!Array.isArray(candidateTabIds) || candidateTabIds.length === 0) {
    return;
  }

  const candidateIds = new Set(candidateTabIds);
  const tabs = await collectTabs(settings);
  const remainingUngroupedTabs = tabs.filter((tab) => (
    candidateIds.has(tab.id) && tab.groupId === UNGROUPED_GROUP_ID
  ));

  await markAutoUngroupableTabs(remainingUngroupedTabs, "not grouped by automatic pass");
}

async function rememberAutoGrouping(tabs, settings, result) {
  await chrome.storage.local.set({
    [AUTO_GROUP_STATE_KEY]: {
      fingerprint: createAutoGroupingFingerprint(tabs, settings),
      observedTabIds: tabs.map((tab) => tab.id),
      groupedTabs: result.groupedTabs,
      groupCount: result.groupCount,
      timestamp: Date.now()
    }
  });
}

function createAutoGroupingFingerprint(tabs, settings) {
  const tabSignature = tabs
    .map((tab) => ({
      id: tab.id,
      windowId: tab.windowId,
      groupId: tab.groupId,
      pinned: tab.pinned,
      title: tab.title || "",
      url: tab.url || ""
    }))
    .sort((first, second) => first.windowId - second.windowId || first.id - second.id);

  return hashString(JSON.stringify({
    settings: {
      endpoint: settings.endpoint,
      model: settings.model,
      scope: settings.scope,
      includePinned: settings.includePinned,
      sendFullUrls: settings.sendFullUrls,
      groupPrefix: settings.groupPrefix,
      maxGroups: settings.maxGroups,
      aiRequestTimeoutSeconds: settings.aiRequestTimeoutSeconds,
      autoGroupDebounceSeconds: settings.autoGroupDebounceSeconds
    },
    tabs: tabSignature
  }));
}

async function collectTabs(settings) {
  const query = settings.scope === "currentWindow"
    ? { lastFocusedWindow: true, windowType: "normal" }
    : { windowType: "normal" };
  const tabs = await chrome.tabs.query(query);

  return tabs.filter((tab) => {
    if (typeof tab.id !== "number" || typeof tab.windowId !== "number") return false;
    if (!settings.includePinned && tab.pinned) return false;
    if (!tab.url || isUnsupportedUrl(tab.url)) return false;
    return true;
  });
}

function isUnsupportedUrl(url) {
  return /^(edge|chrome|about|devtools|chrome-extension):\/\//i.test(url);
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_error) {
    return "";
  }
}

async function suggestGroups(tabs, settings) {
  if (!settings.apiKey) {
    return createFallbackGroups(tabs, settings);
  }

  const payload = {
    model: settings.model,
    temperature: 0.1,
    max_tokens: 1200,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You group browser tabs for a productivity-focused user.",
          "Return only JSON with this shape:",
          "{\"groups\":[{\"name\":\"short label\",\"color\":\"blue|red|yellow|green|pink|purple|cyan|orange|grey\",\"tabIds\":[1,2]}]}",
          "Rules: use only provided tab ids, do not exceed the requested maxGroups value, skip single-tab groups unless the tab is clearly standalone, keep group names under 20 characters."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          maxGroups: settings.maxGroups,
          tabs: tabs.map((tab) => formatTabForAi(tab, settings))
        })
      }
    ]
  };
  applyProviderSpecificOptions(payload, settings);

  const parsedContent = await requestAiJson(payload, settings);
  return normalizeAiGroups(parsedContent.groups, tabs, settings);
}

async function suggestIncrementalGroups(windowId, candidateTabs, allWindowTabs, settings) {
  if (!settings.apiKey) {
    return createFallbackGroups(candidateTabs, settings);
  }

  const existingGroups = await getExistingGroupSummaries(windowId, allWindowTabs);
  const payload = {
    model: settings.model,
    temperature: 0.1,
    max_tokens: 1600,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You incrementally organize browser tabs without creating duplicate tab groups.",
          "Return only JSON with this shape:",
          "{\"groups\":[{\"name\":\"short label\",\"existingGroupId\":123,\"color\":\"blue|red|yellow|green|pink|purple|cyan|orange|grey\",\"tabIds\":[1,2]}]}",
          "Use existingGroupId when a candidate belongs in an existing group, especially when the name, topic, site, or content type is similar.",
          "Create a new group only when no existing group fits.",
          "For multiple tabs from the same video site, classify by intent/content type from title and URL, such as search, anime, videos, courses, music, research, or creator/channel.",
          "Never create a new group whose meaning duplicates an existing group. Do not exceed maxGroups. Keep names under 20 characters."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          maxGroups: settings.maxGroups,
          existingGroups,
          candidateTabs: candidateTabs.map((tab) => formatTabForAi(tab, settings))
        })
      }
    ]
  };
  applyProviderSpecificOptions(payload, settings);

  const parsedContent = await requestAiJson(payload, settings);
  return normalizeAiGroups(parsedContent.groups, candidateTabs, settings, {
    existingGroupIds: new Set(existingGroups.map((group) => group.id)),
    allowSingleTabExistingGroup: true
  });
}

async function requestAiJson(payload, settings) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), settings.aiRequestTimeoutSeconds * 1000);
  let response;

  try {
    response = await fetch(settings.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`AI request timed out after ${settings.aiRequestTimeoutSeconds}s`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AI provider returned HTTP ${response.status}: ${text.slice(0, 240)}`);
  }

  const responseBody = await response.json();
  const content = responseBody?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("AI provider response did not include choices[0].message.content");
  }

  const parsedContent = parseJsonContent(content);
  return parsedContent;
}

function applyProviderSpecificOptions(payload, settings) {
  if (!isDeepSeekV4Request(settings)) {
    return;
  }

  payload.thinking = { type: "disabled" };
}

function isDeepSeekV4Request(settings) {
  try {
    const endpoint = new URL(settings.endpoint);
    return endpoint.hostname.endsWith("deepseek.com") && settings.model.startsWith("deepseek-v4-");
  } catch (_error) {
    return false;
  }
}

function formatTabForAi(tab, settings) {
  const url = new URL(tab.url);

  return {
    id: tab.id,
    title: tab.title || "Untitled",
    domain: url.hostname,
    url: settings.sendFullUrls ? tab.url : `${url.origin}${url.pathname === "/" ? "" : url.pathname}`
  };
}

function parseJsonContent(content) {
  if (typeof content === "object" && content !== null) {
    return content;
  }

  const trimmedContent = String(content).trim();
  try {
    return JSON.parse(trimmedContent);
  } catch (_error) {
    const jsonMatch = trimmedContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("AI provider did not return valid JSON");
    }

    return JSON.parse(jsonMatch[0]);
  }
}

function normalizeAiGroups(rawGroups, tabs, settings, options = {}) {
  if (!Array.isArray(rawGroups)) {
    throw new Error("AI JSON must include a groups array");
  }

  const validTabIds = new Set(tabs.map((tab) => tab.id));
  const usedTabIds = new Set();
  const existingGroupIds = options.existingGroupIds || new Set();

  return rawGroups
    .slice(0, settings.maxGroups)
    .map((group, index) => {
      const existingGroupId = Number(group.existingGroupId ?? group.groupId);
      const uniqueTabIds = [...new Set(Array.isArray(group.tabIds) ? group.tabIds : [])]
        .map((tabId) => Number(tabId))
        .filter((tabId) => validTabIds.has(tabId) && !usedTabIds.has(tabId));

      uniqueTabIds.forEach((tabId) => usedTabIds.add(tabId));

      return {
        name: sanitizeGroupName(group.name, index, settings),
        color: GROUP_COLORS.includes(group.color) ? group.color : GROUP_COLORS[index % GROUP_COLORS.length],
        tabIds: uniqueTabIds,
        existingGroupId: existingGroupIds.has(existingGroupId) ? existingGroupId : null
      };
    })
    .filter((group) => group.tabIds.length > 1 || (options.allowSingleTabExistingGroup && group.existingGroupId));
}

function createFallbackGroups(tabs, settings) {
  const hostGroups = groupBy(tabs, (tab) => {
    try {
      return new URL(tab.url).hostname.replace(/^www\./, "");
    } catch (_error) {
      return "Other";
    }
  });

  return [...hostGroups.entries()]
    .map(([hostname, hostTabs], index) => ({
      name: sanitizeGroupName(hostname.split(".").slice(-2).join("."), index, settings),
      color: GROUP_COLORS[index % GROUP_COLORS.length],
      tabIds: hostTabs.map((tab) => tab.id)
    }))
    .filter((group) => group.tabIds.length > 1)
    .slice(0, settings.maxGroups);
}

async function applyTabGroups(windowId, tabs, groups, settings, contextTabs = tabs) {
  const validTabIds = new Set(tabs.map((tab) => tab.id));
  const existingGroups = await getExistingGroupSummaries(windowId, contextTabs);
  const existingGroupIds = new Set(existingGroups.map((group) => group.id));
  const existingGroupsByTitle = new Map(
    existingGroups.map((group) => [group.normalizedTitle, group])
  );
  const appliedGroups = [];

  for (const [index, group] of groups.entries()) {
    const tabIds = group.tabIds.filter((tabId) => validTabIds.has(tabId));
    if (tabIds.length === 0) continue;

    const title = sanitizeGroupName(group.name, index, settings);
    const existingGroupId = Number(group.existingGroupId);
    if (existingGroupIds.has(existingGroupId)) {
      await chrome.tabs.group({ groupId: existingGroupId, tabIds });
      appliedGroups.push({ title, color: group.color, tabIds, existingGroupId });
      continue;
    }

    const duplicateGroup = findDuplicateExistingGroup(title, existingGroups, existingGroupsByTitle);
    if (duplicateGroup) {
      await chrome.tabs.group({ groupId: duplicateGroup.id, tabIds });
      appliedGroups.push({ title: duplicateGroup.title, color: duplicateGroup.color, tabIds, existingGroupId: duplicateGroup.id });
      continue;
    }

    if (tabIds.length < 2) continue;
    const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, {
      title,
      color: GROUP_COLORS.includes(group.color) ? group.color : GROUP_COLORS[index % GROUP_COLORS.length]
    });

    appliedGroups.push({ title, color: group.color, tabIds });
    existingGroupsByTitle.set(normalizeGroupTitle(title), {
      id: groupId,
      title,
      color: group.color,
      normalizedTitle: normalizeGroupTitle(title)
    });
    existingGroupIds.add(groupId);
  }

  return appliedGroups;
}

function sanitizeGroupName(rawName, index, settings) {
  const fallbackName = `Group ${index + 1}`;
  const baseName = String(rawName || fallbackName)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);
  const prefixedName = settings.groupPrefix ? `${settings.groupPrefix}${baseName}` : baseName;

  return prefixedName.slice(0, 24) || fallbackName;
}

function findDuplicateExistingGroup(title, existingGroups, existingGroupsByTitle) {
  const normalizedTitle = normalizeGroupTitle(title);
  const exactMatch = existingGroupsByTitle.get(normalizedTitle);
  if (exactMatch) {
    return exactMatch;
  }

  return existingGroups.find((group) => areDuplicateGroupTitles(normalizedTitle, group.normalizedTitle));
}

function areDuplicateGroupTitles(firstTitle, secondTitle) {
  if (!firstTitle || !secondTitle) {
    return false;
  }

  if (firstTitle === secondTitle) {
    return true;
  }

  const firstTokens = new Set(splitGroupTitleTokens(firstTitle));
  const secondTokens = new Set(splitGroupTitleTokens(secondTitle));
  if (firstTokens.size === 0 || secondTokens.size === 0) {
    return false;
  }

  const intersectionSize = [...firstTokens].filter((token) => secondTokens.has(token)).length;
  const smallerSize = Math.min(firstTokens.size, secondTokens.size);
  return intersectionSize / smallerSize >= 0.9 && Math.abs(firstTitle.length - secondTitle.length) <= 4;
}

function splitGroupTitleTokens(title) {
  const asciiTokens = title.match(/[a-z0-9]+/g) || [];
  const cjkTokens = title.match(/[\u4e00-\u9fa5]{1,2}/g) || [];
  return [...asciiTokens, ...cjkTokens].filter((token) => token.length > 0);
}

function normalizeGroupTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/bilibili|哔哩哔哩|嗶哩嗶哩/g, "b站")
    .replace(/[\s\-_/|:：,，.。()[\]【】{}]+/g, "")
    .trim();
}

function groupBy(items, keySelector) {
  const groups = new Map();

  for (const item of items) {
    const key = keySelector(item);
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }

  return groups;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

function hashString(value) {
  let hash = 5381;

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }

  return (hash >>> 0).toString(16);
}
