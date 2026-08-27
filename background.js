let copyEnabled = false;
const enabledTabs = new Set();

// ── 向指定标签页发送复制保护状态 ──────────────

function sendCopyState(tabId, enabled) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: 'copyGuard:set', enabled }, () => {
    void chrome.runtime.lastError;
  });
  if (enabled) {
    enabledTabs.add(tabId);
  } else {
    enabledTabs.delete(tabId);
  }
}

// ── 为当前活跃标签页启用，其余禁用 ────────────

function enableForActiveTab() {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const activeId = tabs[0]?.id;
    for (const tabId of [...enabledTabs]) {
      if (tabId !== activeId) sendCopyState(tabId, false);
    }
    if (activeId) sendCopyState(activeId, true);
  });
}

// ── 全部禁用 ──────────────────────────────────

function disableEverywhere() {
  for (const tabId of [...enabledTabs]) {
    sendCopyState(tabId, false);
  }
  enabledTabs.clear();
}

// ── 侧边栏行为 ────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(['savedJob', 'savedResumeText', 'savedResumeFileName']);
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('侧边栏设置失败：', error));
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// ── SW 重启后恢复复制保护状态 ───────────────
chrome.storage.session.get(['copyGuardEnabled'], (data) => {
  if (data.copyGuardEnabled) {
    copyEnabled = true;
    enableForActiveTab();
  }
});

// ── 消息处理 ──────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'copyGuard:enable') {
    copyEnabled = true;
    chrome.storage.session.set({ copyGuardEnabled: true });
    enableForActiveTab();
    sendResponse({ enabled: true });
  }
  if (message.type === 'copyGuard:disable') {
    copyEnabled = false;
    chrome.storage.session.set({ copyGuardEnabled: false });
    disableEverywhere();
    sendResponse({ enabled: false });
  }
  if (message.type === 'copyGuard:ready' && copyEnabled && sender.tab?.active) {
    sendCopyState(sender.tab.id, true);
  }
});

// ── 侧边栏关闭时自动禁用复制保护 ────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidePanel') {
    // 侧边栏连接即视为需要复制保护（SW 重启后也能恢复）
    copyEnabled = true;
    chrome.storage.session.set({ copyGuardEnabled: true });
    enableForActiveTab();
    port.onDisconnect.addListener(() => {
      copyEnabled = false;
      chrome.storage.session.set({ copyGuardEnabled: false });
      disableEverywhere();
    });
  }
});

// ── 标签页切换 ────────────────────────────────

chrome.tabs.onActivated.addListener(() => {
  if (copyEnabled) enableForActiveTab();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enabledTabs.delete(tabId);
});
