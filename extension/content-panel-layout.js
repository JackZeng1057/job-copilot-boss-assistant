// 面板位置、拖动、缩放和启动按钮停靠；仅操作面板 DOM 与本地几何配置。

const PANEL_GEOMETRY_KEY = "jobCopilotPanelGeometryV2";

const LAUNCHER_TOP_KEY = "jobCopilotLauncherTop";

function placePanelDefault(panel) {
  const width = Math.min(380, Math.max(300, window.innerWidth - 32));
  const height = Math.min(560, Math.max(300, window.innerHeight - 112));
  panel.style.width = `${width}px`;
  panel.style.height = `${height}px`;
  panel.style.maxHeight = "none";
  panel.style.left = `${clamp(window.innerWidth - width - 18, 8, window.innerWidth - width - 8)}px`;
  panel.style.top = `${clamp(88, 8, window.innerHeight - height - 8)}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
}

function restorePanelGeometry(panel) {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_GEOMETRY_KEY) || "{}");
    if (!saved || typeof saved !== "object") return false;
    const minWidth = 260;
    const minHeight = 180;
    const maxWidth = Math.min(680, window.innerWidth - 24);
    const maxHeight = Math.min(860, window.innerHeight - 24);
    if (Number.isFinite(saved.width)) panel.style.width = `${clamp(saved.width, minWidth, maxWidth)}px`;
    if (Number.isFinite(saved.height)) {
      panel.style.height = `${clamp(saved.height, minHeight, maxHeight)}px`;
      panel.style.maxHeight = "none";
    }
    if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      const width = panel.getBoundingClientRect().width || saved.width || 330;
      const height = panel.getBoundingClientRect().height || saved.height || 360;
      panel.style.left = `${clamp(saved.left, 8, window.innerWidth - width - 8)}px`;
      panel.style.top = `${clamp(saved.top, 8, window.innerHeight - height - 8)}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    }
    ensurePanelInViewport(panel);
    return true;
  } catch {
    localStorage.removeItem(PANEL_GEOMETRY_KEY);
    return false;
  }
}

function ensurePanelInViewport(panel) {
  const rect = panel.getBoundingClientRect();
  const width = rect.width || 330;
  const height = rect.height || 360;
  panel.style.left = `${clamp(rect.left || window.innerWidth - width - 18, 8, Math.max(8, window.innerWidth - width - 8))}px`;
  panel.style.top = `${clamp(rect.top || 88, 8, Math.max(8, window.innerHeight - height - 8))}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
}

function restoreLauncherTop(launcher) {
  const savedTop = Number(localStorage.getItem(LAUNCHER_TOP_KEY));
  const fallbackTop = Math.round(window.innerHeight * 0.58);
  setLauncherTop(launcher, Number.isFinite(savedTop) ? savedTop : fallbackTop);
}

function setLauncherTop(launcher, top) {
  const launcherHeight = launcher.offsetHeight || 72;
  launcher.style.top = `${clamp(top, 86, Math.max(86, window.innerHeight - launcherHeight - 22))}px`;
  launcher.style.right = "0";
  launcher.style.bottom = "auto";
}

function enableLauncherDock(launcher) {
  let startY = 0;
  let startTop = 0;
  let moved = false;
  launcher.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    startY = event.clientY;
    startTop = launcher.getBoundingClientRect().top;
    moved = false;
    launcher.setPointerCapture?.(event.pointerId);

    const onMove = (moveEvent) => {
      const nextTop = startTop + moveEvent.clientY - startY;
      if (Math.abs(moveEvent.clientY - startY) > 4) moved = true;
      if (moved) {
        moveEvent.preventDefault();
        launcher.classList.add("jc-launcher-dragging");
        setLauncherTop(launcher, nextTop);
      }
    };
    const onUp = () => {
      launcher.classList.remove("jc-launcher-dragging");
      localStorage.setItem(LAUNCHER_TOP_KEY, String(Math.round(launcher.getBoundingClientRect().top)));
      if (moved) {
        launcher.dataset.skipClick = "1";
        setTimeout(() => {
          launcher.dataset.skipClick = "0";
        }, 0);
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

function enablePanelDrag(panel) {
  const header = panel.querySelector(".jc-header");
  if (!header) return;
  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    panel.classList.add("jc-dragging");
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";

    const onMove = (moveEvent) => {
      const current = panel.getBoundingClientRect();
      panel.style.left = `${clamp(moveEvent.clientX - offsetX, 8, window.innerWidth - current.width - 8)}px`;
      panel.style.top = `${clamp(moveEvent.clientY - offsetY, 8, window.innerHeight - current.height - 8)}px`;
    };
    const onUp = () => {
      panel.classList.remove("jc-dragging");
      savePanelGeometry(panel);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

function enablePanelResize(panel) {
  const handles = Array.from(panel.querySelectorAll("[data-jc-resize]"));
  if (!handles.length) return;
  handles.forEach((handle) => handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const direction = handle.dataset.jcResize || "se";
    const rect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;
    const startRight = rect.right;
    const startBottom = rect.bottom;
    panel.classList.add("jc-resizing");
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.maxHeight = "none";
    handle.setPointerCapture?.(event.pointerId);

    const onMove = (moveEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      let nextLeft = rect.left;
      let nextTop = rect.top;
      let nextWidth = startWidth;
      let nextHeight = startHeight;

      if (direction.includes("e")) {
        nextWidth = clamp(startWidth + deltaX, 260, Math.min(680, window.innerWidth - rect.left - 8));
      }
      if (direction.includes("s")) {
        nextHeight = clamp(startHeight + deltaY, 180, Math.min(860, window.innerHeight - rect.top - 8));
      }
      if (direction.includes("w")) {
        nextWidth = clamp(startWidth - deltaX, 260, Math.min(680, startRight - 8));
        nextLeft = startRight - nextWidth;
      }
      if (direction.includes("n")) {
        nextHeight = clamp(startHeight - deltaY, 180, Math.min(860, startBottom - 8));
        nextTop = startBottom - nextHeight;
      }

      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
      panel.style.width = `${nextWidth}px`;
      panel.style.height = `${nextHeight}px`;
    };
    let finished = false;
    const finishResize = () => {
      if (finished) return;
      finished = true;
      panel.classList.remove("jc-resizing");
      savePanelGeometry(panel);
      if (handle.hasPointerCapture?.(event.pointerId)) {
        handle.releasePointerCapture?.(event.pointerId);
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      handle.removeEventListener("lostpointercapture", finishResize);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    handle.addEventListener("lostpointercapture", finishResize);
  }));
}

function savePanelGeometry(panel) {
  const rect = panel.getBoundingClientRect();
  localStorage.setItem(PANEL_GEOMETRY_KEY, JSON.stringify({
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }));
}

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value), min), max);
}
