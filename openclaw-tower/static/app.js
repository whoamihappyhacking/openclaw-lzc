// OpenClaw Tower - Recovery UI

let terminal = null;
let fitAddon = null;
let ws = null;
let statusPollInterval = null;
let logsPollInterval = null;
let logs = [];
const MAX_LOGS = 500;

// Initialize on page load
document.addEventListener("DOMContentLoaded", function () {
  initTerminal();
  pollStatus();
  pollLogs();
  // Poll status every 1 second for faster crash detection
  statusPollInterval = setInterval(pollStatus, 1000);
  logsPollInterval = setInterval(pollLogs, 2000);
});

// Initialize xterm.js terminal
function initTerminal() {
  terminal = new Terminal({
    cursorBlink: true,
    fontFamily:
      "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', 'Consolas', 'Noto Sans Mono CJK SC', 'Microsoft YaHei', monospace",
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

  ws.onopen = function () {
    terminal.write("\x1b[32m终端已连接\x1b[0m\r\n");
    // Send initial size
    const dims = { type: "resize", cols: terminal.cols, rows: terminal.rows };
    ws.send(JSON.stringify(dims));
  };

  ws.onmessage = function (event) {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "data") {
        terminal.write(msg.data);
      } else if (msg.type === "error") {
        terminal.write("\x1b[31m错误: " + msg.data + "\x1b[0m\r\n");
      }
    } catch (e) {
      // Raw data
      terminal.write(event.data);
    }
  };

  ws.onerror = function () {
    terminal.write("\x1b[31m连接错误\x1b[0m\r\n");
  };

  ws.onclose = function () {
    terminal.write("\x1b[33m已断开，3秒后重连...\x1b[0m\r\n");
    setTimeout(connectTerminalWS, 3000);
  };

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
    .catch(function (err) {
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

  // Auto-scroll if was at bottom
  if (isAtBottom) {
    logsContainer.scrollTop = logsContainer.scrollHeight;
  }
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
  fetch("/tower/logs/clear", { method: "POST" }).catch(function () {});
}

// Refresh logs
function refreshLogs() {
  pollLogs();
  showToast("日志已刷新", "info");
}

// Update status UI
function updateStatusUI(data) {
  const indicator = document.getElementById("statusIndicator");
  const statusText = document.getElementById("statusText");
  const statusDetails = document.getElementById("statusDetails");
  const dot = indicator.querySelector(".status-dot");
  const confirmSection = document.getElementById("confirmSection");

  // Auto-reload when running and no crashes (first time startup)
  // This will cause Tower to proxy to OpenClaw
  if (data.status === "running" && data.crashCount === 0 && !data.awaitingReturn) {
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
  if (data.uptime) {
    details.push("运行时间: " + formatUptime(data.uptime));
  }
  statusDetails.textContent = details.join(" | ");

  // Show confirm button when:
  // - AI/config requested gateway self-restart and operator should re-enter OpenClaw
  // - Running after a crash (legacy behavior) and not yet confirmed
  if (
    data.awaitingReturn ||
    (data.status === "running" && data.crashCount > 0 && !data.userConfirmed)
  ) {
    confirmSection.style.display = "block";
  } else {
    confirmSection.style.display = "none";
  }

  // Update button states
  const btnStart = document.getElementById("btnStart");
  const btnStop = document.getElementById("btnStop");

  btnStart.disabled = data.status === "running" || data.status === "starting";
  btnStop.disabled = data.status === "stopped";
}

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
  const btn = document.getElementById("btnStart");
  setLoading(btn, true);

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
      setLoading(btn, false);
      pollStatus();
    });
}

function stopService() {
  const btn = document.getElementById("btnStop");
  setLoading(btn, true);

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
      setLoading(btn, false);
      pollStatus();
    });
}

function restoreBackup() {
  if (!confirm("确定要恢复备份配置吗？当前配置将被覆盖。")) {
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
}

function restoreDefault() {
  if (!confirm("确定要恢复默认配置吗？\n\n警告：当前配置将被完全覆盖为初始配置！")) {
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
  if (loading) {
    btn.classList.add("loading");
    btn.disabled = true;
  } else {
    btn.classList.remove("loading");
    // Don't re-enable here, let pollStatus handle button states
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
