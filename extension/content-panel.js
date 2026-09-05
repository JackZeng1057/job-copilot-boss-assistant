// 面板初始化、配置同步和运行控制；布局计算位于 content-panel-layout.js。
function initPanel() {
  const existingPanel = document.getElementById("job-copilot-panel");
  existingPanel?.remove();
  document.getElementById("job-copilot-launcher")?.remove();
  const launcher = document.createElement("button");
  launcher.id = "job-copilot-launcher";
  launcher.textContent = "JC";
  launcher.title = "打开 Job Copilot，可上下拖动调整位置";
  launcher.setAttribute("aria-label", "打开 Job Copilot");
  launcher.style.display = "flex";
  const panel = document.createElement("div");
  panel.id = "job-copilot-panel";
  panel.dataset.scriptVersion = CONTENT_SCRIPT_VERSION;
  panel.style.display = "none";
  panel.innerHTML = `
    <div class="jc-header">
      <span>Job Copilot <small class="jc-version">v${EXTENSION_VERSION}</small></span>
      <div class="jc-header-actions">
        <button class="jc-icon-button" id="jc-minimize" title="缩小">−</button>
        <button class="jc-icon-button" id="jc-close" title="关闭">×</button>
      </div>
    </div>
    <div class="jc-body" id="jc-body">
      <div class="jc-status-card">
        <div class="jc-status-heading">
          <div class="jc-status-label">当前页面</div>
          <button class="jc-text-button" id="jc-rescan">重新扫描</button>
        </div>
        <div class="jc-page-context" id="jc-page-context">正在识别当前岗位列表...</div>
        <div class="jc-status" id="jc-status">准备扫描当前 BOSS 页面。</div>
      </div>
      <div class="jc-progress-summary" aria-label="当前页处理进度">
        <div><strong id="jc-total-count">0</strong><span>岗位</span></div>
        <div><strong id="jc-analyzed-count">0</strong><span>已分析</span></div>
        <div><strong id="jc-qualified-count">0</strong><span>达标</span></div>
        <div><strong id="jc-contacted-count">0</strong><span>已沟通</span></div>
      </div>
      <div class="jc-primary-actions">
        <button class="jc-button wide" id="jc-pipeline-control">开始自动投递</button>
      </div>
      <div class="jc-automation-box">
        <div class="jc-automation-title">换页行为</div>
        <div class="jc-control-line">
          <div>
            <span>换页后自动投递</span>
            <small id="jc-jobs-state">关闭时只刷新岗位列表，需手动开始</small>
          </div>
          <button class="jc-switch" id="jc-toggle-jobs" type="button" role="switch" aria-checked="false" aria-label="切换职位页面后自动投递"><span></span></button>
        </div>
      </div>
      <div class="jc-list-heading">
        <span>当前页岗位进度</span>
        <button class="jc-text-button" id="jc-next">定位下一个达标岗位</button>
      </div>
      <div id="jc-list"></div>
    </div>
    <div class="jc-resize-handle jc-resize-edge jc-resize-n" data-jc-resize="n"></div>
    <div class="jc-resize-handle jc-resize-edge jc-resize-e" data-jc-resize="e"></div>
    <div class="jc-resize-handle jc-resize-edge jc-resize-s" data-jc-resize="s"></div>
    <div class="jc-resize-handle jc-resize-edge jc-resize-w" data-jc-resize="w"></div>
    <div class="jc-resize-handle jc-resize-corner jc-resize-nw" data-jc-resize="nw"></div>
    <div class="jc-resize-handle jc-resize-corner jc-resize-ne" data-jc-resize="ne"></div>
    <div class="jc-resize-handle jc-resize-corner jc-resize-sw" data-jc-resize="sw"></div>
    <div class="jc-resize-handle jc-resize-corner jc-resize-se" data-jc-resize="se"></div>
  `;
  document.documentElement.appendChild(launcher);
  document.documentElement.appendChild(panel);
  panel.style.visibility = "hidden";
  panel.style.display = "block";
  if (!restorePanelGeometry(panel)) placePanelDefault(panel);
  panel.style.display = "none";
  panel.style.visibility = "";
  restoreLauncherTop(launcher);
  enableLauncherDock(launcher);
  enablePanelDrag(panel);
  enablePanelResize(panel);
  launcher.addEventListener("click", () => {
    if (launcher.dataset.skipClick === "1") {
      launcher.dataset.skipClick = "0";
      return;
    }
    openPanel(panel, launcher);
  });
  window.addEventListener("resize", () => {
    restoreLauncherTop(launcher);
    if (panel.style.display !== "none") {
      ensurePanelInViewport(panel);
      savePanelGeometry(panel);
    }
  });
  document.getElementById("jc-rescan").addEventListener("click", handleRescanOrFocusAutomationTab);
  document.getElementById("jc-pipeline-control").addEventListener("click", handlePipelineControl);
  document.getElementById("jc-toggle-jobs").addEventListener("click", toggleJobsPageAutomation);
  document.getElementById("jc-next").addEventListener("click", focusNextQualifiedJob);
  document.getElementById("jc-minimize").addEventListener("click", () => {
    const body = document.getElementById("jc-body");
    const collapsed = body.style.display !== "none";
    body.style.display = collapsed ? "none" : "block";
    panel.classList.toggle("jc-minimized", collapsed);
  });
  document.getElementById("jc-close").addEventListener("click", () => closePanel(panel, launcher));
  chrome.runtime.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "automationControl") return false;
    applyExternalAutomationControl(message.action, message.reason);
    sendResponse({ ok: true });
    return false;
  });
  sendMessage({ type: "getSettings" }).then((response) => {
    if (response?.ok) JC_STATE.settings = { ...JC_STATE.settings, ...response.settings };
    updateAutomationControls();
    watchRuntimeSettingChanges();
    startPageContextWatcher();
    bootstrapAutomationContext().catch((error) => setStatus(`恢复自动投递状态失败：${error.message || error}`));
  }).catch((error) => setStatus(`读取插件设置失败：${error.message || error}`));
}
