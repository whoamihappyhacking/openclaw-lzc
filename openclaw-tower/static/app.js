// OpenClaw Tower - Recovery UI

let terminal = null;
let fitAddon = null;
let ws = null;
let syncInFlight = false;
let serviceActionInFlight = false;
let dangerConfirmResolve = null;
const DANGER_CONFIRM_TEXT = "yes";

// Initialize on page load
document.addEventListener("DOMContentLoaded", function () {
  setLogsPlaceholderState(true);
  initTerminal();
  initDangerConfirmModal();
  pollStatus();
  pollLogs();
  // Poll status every 0.5 second for more responsive progress/state update
  setInterval(pollStatus, 500);
  setInterval(pollLogs, 2000);
});

// Initialize xterm.js terminal
function initTerminal() {
  terminal = new Terminal({
    cursorBlink: true,
    fontFamily:
      "'JetBrains Mono', 'Cascadia Mono', 'Fira Code', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Noto Sans Mono CJK SC', 'Source Han Mono SC', monospace",
    fontSize: 14,
    lineHeight: 1.4,
    scrollback: 5000,
    theme: {
      background: "#1a1a1a",
      foreground: "#e0e0e0",
      cursor: "#f0f0f0",
      selectionBackground: "#444444",
      black: "#000000",
      red: "#ef4444",
      green: "#22c55e",
      yellow: "#f59e0b",
      blue: "#3b82f6",
      magenta: "#a855f7",
      cyan: "#06b6d4",
      white: "#e0e0e0",
      brightBlack: "#666666",
      brightRed: "#f87171",
      brightGreen: "#4ade80",
      brightYellow: "#fbbf24",
      brightBlue: "#60a5fa",
      brightMagenta: "#c084fc",
      brightCyan: "#22d3ee",
      brightWhite: "#ffffff",
    },
  });

  fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);

  const container = document.getElementById("terminal");
  terminal.open(container);
  fitAddon.fit();

  // Connect WebSocket
  connectTerminalWS();

  // Handle window resize
  window.addEventListener("resize", function () {
    if (fitAddon) {
      fitAddon.fit();
    }
  });

  // Handle container resize
  const resizeObserver = new ResizeObserver(function () {
    if (fitAddon) {
      fitAddon.fit();
    }
  });
  resizeObserver.observe(container);
}

// Connect terminal WebSocket
function connectTerminalWS() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = proto + "//" + window.location.host + "/tower/ws/terminal";

  ws = new WebSocket(wsUrl);

  ws.addEventListener("open", function () {
    terminal.write("\x1b[32m终端已连接\x1b[0m\r\n");
    // Send initial size
    const dims = { type: "resize", cols: terminal.cols, rows: terminal.rows };
    ws.send(JSON.stringify(dims));
  });

  ws.addEventListener("message", function (event) {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "data") {
        terminal.write(msg.data);
      } else if (msg.type === "error") {
        terminal.write("\x1b[31m错误: " + msg.data + "\x1b[0m\r\n");
      }
    } catch {
      // Raw data
      terminal.write(event.data);
    }
  });

  ws.addEventListener("error", function () {
    terminal.write("\x1b[31m连接错误\x1b[0m\r\n");
  });

  ws.addEventListener("close", function () {
    terminal.write("\x1b[33m已断开，3秒后重连...\x1b[0m\r\n");
    setTimeout(connectTerminalWS, 3000);
  });

  // Send input to server
  terminal.onData(function (data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data: data }));
    }
  });

  // Send resize events
  terminal.onResize(function (size) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
    }
  });
}

// Poll status from server
function pollStatus() {
  fetch("/tower/status")
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      updateStatusUI(data);
    })
    .catch(function (err) {
      console.error("Status poll failed:", err);
    });
}

// Poll logs from server
function pollLogs() {
  fetch("/tower/logs")
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      if (data.logs && Array.isArray(data.logs)) {
        updateLogsUI(data.logs);
      }
    })
    .catch(function () {
      // Logs endpoint might not exist yet, ignore
    });
}

// Update logs UI
function updateLogsUI(newLogs) {
  if (newLogs.length === 0) {
    return;
  }

  const logsContent = document.getElementById("logsContent");
  const logsContainer = document.getElementById("logsContainer");

  // Check if user is scrolled to bottom
  const isAtBottom =
    logsContainer.scrollHeight - logsContainer.scrollTop <= logsContainer.clientHeight + 50;

  // Format logs with colors
  let html = "";
  newLogs.forEach(function (line) {
    let className = "";
    if (
      line.includes("[error]") ||
      line.includes("Error") ||
      line.includes("ERROR") ||
      line.includes("failed") ||
      line.includes("Failed")
    ) {
      className = "log-error";
    } else if (line.includes("[warn]") || line.includes("Warning") || line.includes("WARN")) {
      className = "log-warn";
    } else if (line.includes("[info]") || line.includes("[tower]") || line.includes("[openclaw]")) {
      className = "log-info";
    }

    const escapedLine = escapeHtml(line);
    if (className) {
      html += '<span class="' + className + '">' + escapedLine + "</span>\n";
    } else {
      html += escapedLine + "\n";
    }
  });

  logsContent.innerHTML = html;
  setLogsPlaceholderState(false);

  // Auto-scroll if was at bottom
  if (isAtBottom) {
    logsContainer.scrollTop = logsContainer.scrollHeight;
  }
}

function setLogsPlaceholderState(isPlaceholder) {
  const logsContent = document.getElementById("logsContent");
  if (!logsContent) {
    return;
  }
  logsContent.classList.toggle("logs-placeholder", isPlaceholder);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Clear logs
function clearLogs() {
  const logsContent = document.getElementById("logsContent");
  logsContent.innerHTML = "日志已清空";
  setLogsPlaceholderState(true);
  fetch("/tower/logs/clear", { method: "POST" }).catch(function () {});
}

// Refresh logs
function refreshLogs() {
  pollLogs();
  showToast("日志已刷新", "info");
}

// Copy logs
function copyLogs() {
  const logsContent = document.getElementById("logsContent");
  if (!logsContent) {
    showToast("日志区域不可用", "error");
    return;
  }

  const text = logsContent.textContent || "";
  if (!text.trim() || logsContent.classList.contains("logs-placeholder")) {
    showToast("暂无可复制日志", "info");
    return;
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(function () {
        showToast("日志已复制", "success");
      })
      .catch(function () {
        fallbackCopyText(text);
      });
    return;
  }

  fallbackCopyText(text);
}

function fallbackCopyText(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  document.body.removeChild(textarea);

  if (copied) {
    showToast("日志已复制", "success");
  } else {
    showToast("复制失败，请手动复制", "error");
  }
}

// Update status UI
function updateStatusUI(data) {
  const indicator = document.getElementById("statusIndicator");
  const statusText = document.getElementById("statusText");
  const statusDetails = document.getElementById("statusDetails");
  const dot = indicator.querySelector(".status-dot");
  const confirmSection = document.getElementById("confirmSection");
  const updateExplanation = document.getElementById("updateExplanation");
  const btnConfirmReady = document.getElementById("btnConfirmReady");
  const btnSyncLatest = document.getElementById("btnSyncLatest");
  const confirmActionsRow = document.getElementById("confirmActionsRow");
  const copyProgress = document.getElementById("copyProgress");
  const copyProgressLabel = document.getElementById("copyProgressLabel");
  const copyProgressPercent = document.getElementById("copyProgressPercent");
  const copyProgressFill = document.getElementById("copyProgressFill");
  const copyProgressMeta = document.getElementById("copyProgressMeta");

  // Auto-reload when running and no manual confirmation/sync is pending.
  // This causes Tower to proxy back to OpenClaw automatically.
  if (data.status === "running" && !data.updateRequired && !data.requiresReturnConfirmation) {
    showToast("OpenClaw 已就绪，正在进入...", "success");
    setTimeout(function () {
      window.location.reload();
    }, 500);
    return;
  }

  // Update status dot
  dot.className = "status-dot " + data.status;

  // Update status text
  const statusLabels = {
    starting: "启动中...",
    running: "运行中",
    stopped: "已停止",
    crashed: "已崩溃",
  };
  statusText.textContent = statusLabels[data.status] || data.status;

  // Update details
  let details = [];
  if (data.crashCount > 0) {
    details.push("崩溃次数: " + data.crashCount);
  }
  if (data.lastError) {
    details.push("错误: " + data.lastError);
  }
  if (data.awaitingReturn && data.lastRestartReason) {
    details.push("重启原因: " + data.lastRestartReason);
  }
  if (data.updateRequired) {
    details.push("更新提示: 检测到镜像与运行代码不一致");
    if (data.updateReason) {
      details.push("原因: " + data.updateReason);
    }
  }
  if (data.uptime) {
    details.push("运行时间: " + formatUptime(data.uptime));
  }
  const hasDetails = details.length > 0;
  if (statusDetails) {
    statusDetails.classList.toggle("status-details-empty", !hasDetails);
    statusDetails.textContent = hasDetails ? details.join("\n") : "暂无崩溃/运行详情";
  }

  updateCopyProgressUI({
    copyProgress,
    copyProgressLabel,
    copyProgressPercent,
    copyProgressFill,
    copyProgressMeta,
    data,
  });

  // Show action area when:
  // - update is required (always show sync button), or
  // - operator confirmation is needed after restart/crash.
  const requiresReturnConfirmation = !!data.requiresReturnConfirmation;
  const showUpdateAction = !!data.updateRequired;
  const showConfirmReadyAction =
    requiresReturnConfirmation || (showUpdateAction && data.status === "running");
  const showConfirmSection = showUpdateAction || requiresReturnConfirmation;

  if (showConfirmSection) {
    confirmSection.style.display = "block";
  } else {
    confirmSection.style.display = "none";
  }

  if (btnConfirmReady) {
    btnConfirmReady.style.display = showConfirmReadyAction ? "flex" : "none";
  }

  if (updateExplanation) {
    updateExplanation.style.display = showUpdateAction ? "block" : "none";
  }

  if (btnSyncLatest) {
    btnSyncLatest.style.display = showUpdateAction ? "flex" : "none";
    if (showUpdateAction && !syncInFlight) {
      btnSyncLatest.disabled = false;
      btnSyncLatest.classList.remove("loading");
    } else if (showUpdateAction && syncInFlight) {
      btnSyncLatest.disabled = true;
      btnSyncLatest.classList.add("loading");
    }
  }

  if (confirmActionsRow) {
    const showBothActions = showConfirmReadyAction && showUpdateAction;
    const showSyncOnlyAction = showUpdateAction && !showConfirmReadyAction;
    confirmActionsRow.classList.toggle("dual-actions", showBothActions);
    confirmActionsRow.classList.toggle("sync-only", showSyncOnlyAction);
  }

  // Update button states
  const btnStart = document.getElementById("btnStart");
  const btnStop = document.getElementById("btnStop");

  if (syncInFlight || serviceActionInFlight) {
    btnStart.disabled = true;
    btnStop.disabled = true;
  } else {
    btnStart.disabled = data.status === "running" || data.status === "starting";
    btnStop.disabled = data.status === "stopped";
  }
}

function updateCopyProgressUI(ctx) {
  const copyInProgress = !!ctx.data.copyInProgress;
  const percent = Number(ctx.data.copyPercent || 0);
  const source = String(ctx.data.copySource || "").trim();
  const stage = String(ctx.data.copyStage || "").trim();
  const copiedEntries = Number(ctx.data.copyCopiedEntries || 0);
  const totalEntries = Number(ctx.data.copyTotalEntries || 0);
  const copiedBytes = Number(ctx.data.copyCopiedBytes || 0);
  const totalBytes = Number(ctx.data.copyTotalBytes || 0);

  if (!ctx.copyProgress) {
    return;
  }

  if (!copyInProgress && !syncInFlight) {
    ctx.copyProgress.style.display = "none";
    return;
  }

  ctx.copyProgress.style.display = "block";

  let sourceLabel = "Tower 同步";
  if (source === "entrypoint") {
    sourceLabel = "容器初始化";
  }

  const stageLabel = stage || "正在复制 OpenClaw 安装";
  if (ctx.copyProgressLabel) {
    ctx.copyProgressLabel.textContent = sourceLabel + " · " + stageLabel;
  }

  const safePercent = Math.max(0, Math.min(100, percent));
  if (ctx.copyProgressPercent) {
    ctx.copyProgressPercent.textContent = safePercent + "%";
  }
  if (ctx.copyProgressFill) {
    ctx.copyProgressFill.style.width = safePercent + "%";
  }

  if (ctx.copyProgressMeta) {
    if (totalBytes > 0) {
      ctx.copyProgressMeta.textContent =
        "数据进度: " + formatBytes(copiedBytes) + " / " + formatBytes(totalBytes);
    } else if (totalEntries > 0) {
      ctx.copyProgressMeta.textContent = "文件进度: " + copiedEntries + " / " + totalEntries;
    } else {
      ctx.copyProgressMeta.textContent = "正在准备复制进度...";
    }
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  if (index === 0) {
    return Math.round(value) + " " + units[index];
  }

  return value.toFixed(1) + " " + units[index];
}

window.startService = startService;
window.stopService = stopService;
window.restoreBackup = restoreBackup;
window.restoreDefault = restoreDefault;
window.confirmReady = confirmReady;
window.syncToLatest = syncToLatest;
window.toggleLogsExpand = toggleLogsExpand;
window.toggleTerminalExpand = toggleTerminalExpand;
window.clearLogs = clearLogs;
window.refreshLogs = refreshLogs;
window.copyLogs = copyLogs;
window.closeDangerConfirmModal = closeDangerConfirmModal;

function formatUptime(seconds) {
  if (seconds < 60) {
    return Math.floor(seconds) + "秒";
  } else if (seconds < 3600) {
    return Math.floor(seconds / 60) + "分钟";
  } else {
    return Math.floor(seconds / 3600) + "小时";
  }
}

// API Actions
function startService() {
  if (serviceActionInFlight || syncInFlight) {
    return;
  }

  serviceActionInFlight = true;
  const btn = document.getElementById("btnStart");
  const btnStop = document.getElementById("btnStop");
  setLoading(btn, true);
  if (btnStop) {
    btnStop.disabled = true;
  }

  fetch("/tower/start", { method: "POST" })
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      if (data.ok === "true") {
        showToast("服务启动中...", "info");
      } else {
        showToast(data.error || "启动失败", "error");
      }
    })
    .catch(function (err) {
      showToast("请求失败: " + err.message, "error");
    })
    .finally(function () {
      serviceActionInFlight = false;
      setLoading(btn, false);
      pollStatus();
    });
}

function stopService() {
  if (serviceActionInFlight || syncInFlight) {
    return;
  }

  serviceActionInFlight = true;
  const btn = document.getElementById("btnStop");
  const btnStart = document.getElementById("btnStart");
  setLoading(btn, true);
  if (btnStart) {
    btnStart.disabled = true;
  }

  fetch("/tower/stop", { method: "POST" })
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      if (data.ok === "true") {
        showToast("服务已停止", "success");
      } else {
        showToast(data.error || "停止失败", "error");
      }
    })
    .catch(function (err) {
      showToast("请求失败: " + err.message, "error");
    })
    .finally(function () {
      serviceActionInFlight = false;
      setLoading(btn, false);
      pollStatus();
    });
}

function restoreBackup() {
  requestDangerConfirmation("确定要恢复备份配置吗？当前配置将被覆盖。")
    .then(function (confirmed) {
      if (!confirmed) {
        return;
      }

      const btn = document.getElementById("btnRestoreBackup");
      setLoading(btn, true);

      fetch("/tower/restore-backup", { method: "POST" })
        .then(function (res) {
          return res.json();
        })
        .then(function (data) {
          if (data.ok === "true") {
            showToast("备份配置已恢复", "success");
          } else {
            showToast(data.error || "恢复失败", "error");
          }
        })
        .catch(function (err) {
          showToast("请求失败: " + err.message, "error");
        })
        .finally(function () {
          setLoading(btn, false);
        });
    })
    .catch(function () {
      showToast("确认流程失败", "error");
    });
}

function restoreDefault() {
  requestDangerConfirmation("确定要恢复默认配置吗？当前配置将被完全覆盖为初始配置。")
    .then(function (confirmed) {
      if (!confirmed) {
        return;
      }

      const btn = document.getElementById("btnRestoreDefault");
      setLoading(btn, true);

      fetch("/tower/restore-default", { method: "POST" })
        .then(function (res) {
          return res.json();
        })
        .then(function (data) {
          if (data.ok === "true") {
            showToast("默认配置已恢复", "success");
          } else {
            showToast(data.error || "恢复失败", "error");
          }
        })
        .catch(function (err) {
          showToast("请求失败: " + err.message, "error");
        })
        .finally(function () {
          setLoading(btn, false);
        });
    })
    .catch(function () {
      showToast("确认流程失败", "error");
    });
}

function confirmReady() {
  fetch("/tower/confirm-ready", { method: "POST" })
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      if (data.ok === "true") {
        showToast("正在切换到 OpenClaw...", "success");
        setTimeout(function () {
          window.location.href = "/";
        }, 1000);
      } else {
        showToast(data.error || "确认失败", "error");
      }
    })
    .catch(function (err) {
      showToast("请求失败: " + err.message, "error");
    });
}

function syncToLatest() {
  const btn = document.getElementById("btnSyncLatest");
  if (!btn) {
    return;
  }

  syncInFlight = true;
  setLoading(btn, true);
  showToast("开始同步到最新懒猫 OpenClaw 版本...", "info");

  fetch("/tower/sync-latest", { method: "POST" })
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      if (data.ok === "true") {
        showToast("同步完成，正在刷新状态...", "success");
      } else {
        showToast(data.error || "同步失败", "error");
      }
    })
    .catch(function (err) {
      showToast("请求失败: " + err.message, "error");
    })
    .finally(function () {
      syncInFlight = false;
      setLoading(btn, false);
      setTimeout(function () {
        pollStatus();
        pollLogs();
      }, 100);
    });
}

function initDangerConfirmModal() {
  document.addEventListener("keydown", function (event) {
    const modal = document.getElementById("confirmModal");
    if (!modal || modal.style.display === "none") {
      return;
    }

    if (event.key === "Escape") {
      closeDangerConfirmModal(false);
      return;
    }

    if (event.key === "Enter") {
      const submitBtn = document.getElementById("confirmModalSubmit");
      if (submitBtn && !submitBtn.disabled) {
        closeDangerConfirmModal(true);
      }
    }
  });

  const modal = document.getElementById("confirmModal");
  if (modal) {
    modal.addEventListener("click", function (event) {
      if (event.target === modal) {
        closeDangerConfirmModal(false);
      }
    });
  }

  const modalInput = document.getElementById("confirmModalInput");
  if (modalInput) {
    modalInput.addEventListener("input", function () {
      const submitBtn = document.getElementById("confirmModalSubmit");
      if (!submitBtn) {
        return;
      }
      submitBtn.disabled = modalInput.value.trim().toLowerCase() !== DANGER_CONFIRM_TEXT;
    });
  }
}

function requestDangerConfirmation(message) {
  return new Promise(function (resolve) {
    const modal = document.getElementById("confirmModal");
    const modalMessage = document.getElementById("confirmModalMessage");
    const modalInput = document.getElementById("confirmModalInput");
    const submitBtn = document.getElementById("confirmModalSubmit");

    if (!modal || !modalMessage || !modalInput || !submitBtn) {
      resolve(false);
      return;
    }

    dangerConfirmResolve = resolve;
    modalMessage.textContent = message;
    modalInput.value = "";
    submitBtn.disabled = true;
    modal.style.display = "flex";

    setTimeout(function () {
      modalInput.focus();
    }, 0);
  });
}

function closeDangerConfirmModal(confirmed) {
  const modal = document.getElementById("confirmModal");
  const modalInput = document.getElementById("confirmModalInput");
  if (!modal || !modalInput) {
    if (dangerConfirmResolve) {
      const resolve = dangerConfirmResolve;
      dangerConfirmResolve = null;
      resolve(false);
    }
    return;
  }

  const isValid = modalInput.value.trim().toLowerCase() === DANGER_CONFIRM_TEXT;
  const result = confirmed && isValid;

  modal.style.display = "none";
  modalInput.value = "";

  if (confirmed && !isValid) {
    showToast("请输入完整确认文本", "error");
  }

  if (dangerConfirmResolve) {
    const resolve = dangerConfirmResolve;
    dangerConfirmResolve = null;
    resolve(result);
  }
}

// Toggle logs expand/collapse
function toggleLogsExpand() {
  const section = document.getElementById("logsSection");
  const btn = document.getElementById("btnExpandLogs");

  section.classList.toggle("expanded");

  if (section.classList.contains("expanded")) {
    btn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg><span>收起</span>';
  } else {
    btn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg><span>展开</span>';
  }
}

// Toggle terminal expand/collapse
function toggleTerminalExpand() {
  const section = document.getElementById("terminalSection");
  const btnText = document.getElementById("expandBtnText");
  const btn = document.getElementById("btnExpandTerminal");

  section.classList.toggle("expanded");

  if (section.classList.contains("expanded")) {
    btnText.textContent = "收起";
    btn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg><span id="expandBtnText">收起</span>';
  } else {
    btnText.textContent = "展开";
    btn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg><span id="expandBtnText">展开</span>';
  }

  // Refit terminal after size change
  setTimeout(function () {
    if (fitAddon) {
      fitAddon.fit();
    }
  }, 100);
}

// UI Helpers
function setLoading(btn, loading) {
  if (!btn) {
    return;
  }
  if (loading) {
    btn.classList.add("loading");
    btn.disabled = true;
  } else {
    btn.classList.remove("loading");
    // Status polling controls start/stop buttons.
    if (btn.id === "btnSyncLatest") {
      btn.disabled = false;
    }
  }
}

function showToast(message, type) {
  const container = document.getElementById("toastContainer");

  // Create toast element
  const toast = document.createElement("div");
  toast.className = "toast " + type;
  toast.textContent = message;
  container.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(function () {
    toast.classList.add("show");
  });

  // Remove after delay
  setTimeout(function () {
    toast.classList.remove("show");
    setTimeout(function () {
      container.removeChild(toast);
    }, 200);
  }, 3000);
}
