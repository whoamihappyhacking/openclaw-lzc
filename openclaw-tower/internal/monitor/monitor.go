package monitor

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// OpenClaw installation paths
	ImageDir            = "/opt/openclaw-image"
	ImagePackagePath    = ImageDir + "/package.json"
	ImageBuildInfoPath  = ImageDir + "/dist/build-info.json"
	ImageEntryJSPath    = ImageDir + "/dist/entry.js"
	NPMGlobal           = "/app/npm-global"
	OpenClawDir         = NPMGlobal + "/lib/node_modules/openclaw"
	OpenClawPackagePath = OpenClawDir + "/package.json"
	OpenClawBuildInfo   = OpenClawDir + "/dist/build-info.json"
	OpenClawBin         = NPMGlobal + "/bin/openclaw"
	EntryJSPath         = OpenClawDir + "/dist/entry.js"
	EntrypointCopyState = "/tmp/openclaw-entrypoint-copy-progress.json"
)

type Status string

const (
	StatusStarting Status = "starting"
	StatusRunning  Status = "running"
	StatusStopped  Status = "stopped"
	StatusCrashed  Status = "crashed"
)

const (
	MaxLogLines          = 500
	startupHealthTimeout = 30 * time.Second
)

type Config struct {
	OpenClawPort string
	ConfigPath   string
}

type Monitor struct {
	config            Config
	status            Status
	userConfirmed     bool
	awaitingReturn    bool
	updateRequired    bool
	updateReason      string
	stopRequested     bool
	copyInProgress    bool
	copySource        string
	copyStage         string
	copyTotalEntries  int
	copyCopiedEntries int
	copyTotalBytes    int64
	copyCopiedBytes   int64
	copyPercent       int
	copyUpdatedAt     time.Time
	mu                sync.RWMutex
	cmd               *exec.Cmd
	cmdDone           chan error
	lastError         string
	lastRestartReason string
	startTime         time.Time
	startingDeadline  time.Time
	crashCount        int
	logs              []string
	logsMu            sync.RWMutex
}

func New(cfg Config) *Monitor {
	return &Monitor{
		config: cfg,
		status: StatusStopped,
		logs:   make([]string, 0, MaxLogLines),
	}
}

func (m *Monitor) Start() {
	// Check installation integrity before starting
	m.checkAndRepairInstallation()

	// Check for same-version image/runtime drift before startup
	m.evaluateInstallSyncRequirement()

	if m.IsUpdateRequired() {
		m.mu.Lock()
		m.status = StatusStopped
		m.lastError = ""
		m.startingDeadline = time.Time{}
		m.mu.Unlock()
		m.addLog("[tower] Auto-start blocked: sync is required before entering OpenClaw")
	} else {
		// Initial startup
		m.startOpenClaw()
	}

	// Health check loop - check every 1 second for faster detection
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		m.checkHealth()
	}
}

// checkAndRepairInstallation checks if OpenClaw installation is intact
// and repairs it from the image if corrupted
func (m *Monitor) checkAndRepairInstallation() {
	m.addLog("[tower] Checking OpenClaw installation integrity...")

	// Check if entry.js exists
	if _, err := os.Stat(EntryJSPath); err == nil {
		m.addLog("[tower] Installation OK: dist/entry.js found")
		return
	}

	m.addLog("[tower] WARNING: dist/entry.js missing, installation corrupted!")
	m.addLog("[tower] Reinstalling OpenClaw from image...")

	// Set status to show we're repairing
	m.mu.Lock()
	m.status = StatusStarting
	m.lastError = "Installation corrupted, reinstalling..."
	m.startingDeadline = time.Time{}
	m.mu.Unlock()

	if err := m.reinstallFromImage(); err != nil {
		m.addLog(fmt.Sprintf("[tower] Failed to reinstall from image: %v", err))
		m.mu.Lock()
		m.status = StatusCrashed
		m.lastError = fmt.Sprintf("Failed to reinstall: %v", err)
		m.startingDeadline = time.Time{}
		m.crashCount++
		m.mu.Unlock()
		return
	}

	m.addLog("[tower] Reinstallation complete!")

	// Reset status
	m.mu.Lock()
	m.status = StatusStopped
	m.lastError = ""
	m.startingDeadline = time.Time{}
	m.mu.Unlock()
}

type packageManifest struct {
	Version string `json:"version"`
}

type buildInfo struct {
	Commit string `json:"commit"`
}

type entrypointCopyProgress struct {
	Source        string `json:"source"`
	Stage         string `json:"stage"`
	Percent       int    `json:"percent"`
	CopiedEntries int    `json:"copiedEntries"`
	TotalEntries  int    `json:"totalEntries"`
	CopiedBytes   int64  `json:"copiedBytes"`
	TotalBytes    int64  `json:"totalBytes"`
	Done          bool   `json:"done"`
	UpdatedAt     string `json:"updatedAt"`
}

func readPackageVersion(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var pkg packageManifest
	if err := json.Unmarshal(raw, &pkg); err != nil {
		return "", err
	}
	return strings.TrimSpace(pkg.Version), nil
}

func readBuildCommit(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var info buildInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return ""
	}
	return strings.TrimSpace(info.Commit)
}

func fileSHA256(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:]), nil
}

func (m *Monitor) detectInstallMismatch() (bool, string, error) {
	imageVersion, err := readPackageVersion(ImagePackagePath)
	if err != nil {
		return false, "", fmt.Errorf("read image package: %w", err)
	}
	currentVersion, err := readPackageVersion(OpenClawPackagePath)
	if err != nil {
		return false, "", fmt.Errorf("read installed package: %w", err)
	}

	if imageVersion == "" || currentVersion == "" {
		return false, "", nil
	}

	if imageVersion != currentVersion {
		reason := fmt.Sprintf("detected install mismatch: image version %s differs from installed version %s", imageVersion, currentVersion)
		return true, reason, nil
	}

	imageCommit := readBuildCommit(ImageBuildInfoPath)
	currentCommit := readBuildCommit(OpenClawBuildInfo)
	if imageCommit != "" && currentCommit != "" && imageCommit != currentCommit {
		reason := fmt.Sprintf("detected install drift: same version %s but commit differs (image=%s installed=%s)", imageVersion, imageCommit, currentCommit)
		return true, reason, nil
	}

	imageHash, imageErr := fileSHA256(ImageEntryJSPath)
	currentHash, currentErr := fileSHA256(EntryJSPath)
	if imageErr == nil && currentErr == nil && imageHash != currentHash {
		reason := fmt.Sprintf("detected install drift: same version %s but dist/entry.js hash differs", imageVersion)
		return true, reason, nil
	}

	return false, "", nil
}

func (m *Monitor) evaluateInstallSyncRequirement() {
	drift, reason, err := m.detectInstallMismatch()
	m.mu.Lock()
	m.updateRequired = drift
	m.updateReason = reason
	if drift {
		m.userConfirmed = false
	}
	m.mu.Unlock()

	if err != nil {
		m.addLog(fmt.Sprintf("[tower] install drift check skipped: %v", err))
		return
	}
	if drift {
		m.addLog("[tower] WARNING: image/runtime install mismatch detected")
		m.addLog(fmt.Sprintf("[tower] %s", reason))
		m.addLog("[tower] Update required; Tower will not auto-enter OpenClaw")
	} else {
		m.addLog("[tower] Installation sync check passed")
	}
}

func (m *Monitor) setCopyStateStart(source, stage string) {
	m.mu.Lock()
	m.copyInProgress = true
	m.copySource = source
	m.copyStage = stage
	m.copyTotalEntries = 0
	m.copyCopiedEntries = 0
	m.copyTotalBytes = 0
	m.copyCopiedBytes = 0
	m.copyPercent = 0
	m.copyUpdatedAt = time.Now()
	m.mu.Unlock()
}

func (m *Monitor) setCopyStateTotals(totalEntries int, totalBytes int64) {
	m.mu.Lock()
	m.copyTotalEntries = totalEntries
	m.copyTotalBytes = totalBytes
	m.copyPercent = 0
	m.copyUpdatedAt = time.Now()
	m.mu.Unlock()
}

func (m *Monitor) updateCopyProgress(copiedEntries int, copiedBytes int64, stage string) {
	percent := 0
	if copiedEntries > 0 {
		percent = 1
	}

	m.mu.Lock()
	m.copyCopiedEntries = copiedEntries
	m.copyCopiedBytes = copiedBytes
	if stage != "" {
		m.copyStage = stage
	}
	if m.copyTotalBytes > 0 {
		percent = int((copiedBytes * 100) / m.copyTotalBytes)
	} else if m.copyTotalEntries > 0 {
		percent = int((copiedEntries * 100) / m.copyTotalEntries)
	}
	if percent > 99 {
		percent = 99
	}
	if percent < 0 {
		percent = 0
	}
	m.copyPercent = percent
	m.copyUpdatedAt = time.Now()
	m.mu.Unlock()
}

func (m *Monitor) setCopyStateDone(stage string) {
	m.mu.Lock()
	m.copyInProgress = false
	if stage != "" {
		m.copyStage = stage
	}
	if m.copyTotalEntries > 0 {
		m.copyCopiedEntries = m.copyTotalEntries
	}
	if m.copyTotalBytes > 0 {
		m.copyCopiedBytes = m.copyTotalBytes
	}
	m.copyPercent = 100
	m.copyUpdatedAt = time.Now()
	m.mu.Unlock()
}

func (m *Monitor) clearCopyState() {
	m.mu.Lock()
	m.copyInProgress = false
	m.copySource = ""
	m.copyStage = ""
	m.copyTotalEntries = 0
	m.copyCopiedEntries = 0
	m.copyTotalBytes = 0
	m.copyCopiedBytes = 0
	m.copyPercent = 0
	m.copyUpdatedAt = time.Time{}
	m.mu.Unlock()
}

func (m *Monitor) loadEntrypointCopyProgress(info map[string]interface{}) {
	raw, err := os.ReadFile(EntrypointCopyState)
	if err != nil {
		return
	}

	var progress entrypointCopyProgress
	if err := json.Unmarshal(raw, &progress); err != nil {
		return
	}

	showAsActive := !progress.Done && progress.Percent < 100

	updatedAt, parseErr := time.Parse(time.RFC3339Nano, strings.TrimSpace(progress.UpdatedAt))
	if parseErr == nil {
		age := time.Since(updatedAt)
		if age > 20*time.Second {
			return
		}
		if progress.Done && age <= 8*time.Second {
			showAsActive = true
		}
		info["copyUpdatedAt"] = updatedAt.Format(time.RFC3339Nano)
	}

	copiedBytes := progress.CopiedBytes
	totalBytes := progress.TotalBytes
	if copiedBytes <= 0 && progress.CopiedEntries > 0 {
		copiedBytes = int64(progress.CopiedEntries)
	}
	if totalBytes <= 0 && progress.TotalEntries > 0 {
		totalBytes = int64(progress.TotalEntries)
	}

	info["copyInProgress"] = showAsActive
	info["copySource"] = strings.TrimSpace(progress.Source)
	info["copyStage"] = strings.TrimSpace(progress.Stage)
	info["copyPercent"] = progress.Percent
	info["copyCopiedEntries"] = progress.CopiedEntries
	info["copyTotalEntries"] = progress.TotalEntries
	info["copyCopiedBytes"] = copiedBytes
	info["copyTotalBytes"] = totalBytes
}

func (m *Monitor) reinstallFromImage() error {
	m.setCopyStateStart("tower", "准备复制 OpenClaw 安装")
	copyCompleted := false
	defer func() {
		if !copyCompleted {
			m.clearCopyState()
		}
	}()

	if err := os.RemoveAll(OpenClawDir); err != nil {
		return fmt.Errorf("remove existing install: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(OpenClawDir), 0755); err != nil {
		return fmt.Errorf("create install parent dir: %w", err)
	}

	if err := m.copyDirWithProgress(ImageDir, OpenClawDir); err != nil {
		return fmt.Errorf("copy image install: %w", err)
	}
	m.setCopyStateDone("复制完成")

	if _, err := m.ensureOpenClawExecutable(); err != nil {
		return err
	}

	copyCompleted = true
	return nil
}

func (m *Monitor) ensureOpenClawExecutable() (string, error) {
	entryPath, err := m.resolveOpenClawEntryPath()
	if err != nil {
		return "", err
	}

	if err := os.MkdirAll(filepath.Dir(OpenClawBin), 0755); err != nil {
		return "", fmt.Errorf("create bin dir: %w", err)
	}

	if err := os.Remove(OpenClawBin); err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("remove stale openclaw bin link: %w", err)
	}

	wrapper := fmt.Sprintf("#!/bin/sh\nexec node %s \"$@\"\n", shellSingleQuote(entryPath))
	if err := os.WriteFile(OpenClawBin, []byte(wrapper), 0755); err != nil {
		return "", fmt.Errorf("write openclaw bin wrapper: %w", err)
	}

	if err := os.Chmod(OpenClawBin, 0755); err != nil {
		return "", fmt.Errorf("chmod openclaw bin wrapper: %w", err)
	}

	return OpenClawBin, nil
}

func (m *Monitor) resolveOpenClawEntryPath() (string, error) {
	candidates := []string{
		filepath.Join(OpenClawDir, "dist", "entry.js"),
	}

	raw, err := os.ReadFile(OpenClawPackagePath)
	if err == nil {
		var manifest struct {
			Bin any `json:"bin"`
		}
		if jsonErr := json.Unmarshal(raw, &manifest); jsonErr == nil {
			switch bin := manifest.Bin.(type) {
			case string:
				if path := resolveOpenClawRelativeEntry(bin); path != "" {
					candidates = append(candidates, path)
				}
			case map[string]any:
				if value, ok := bin["openclaw"].(string); ok {
					if path := resolveOpenClawRelativeEntry(value); path != "" {
						candidates = append(candidates, path)
					}
				}
			}
		}
	}

	candidates = append(candidates,
		filepath.Join(OpenClawDir, "openclaw.mjs"),
	)

	checked := make([]string, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if _, exists := seen[candidate]; exists {
			continue
		}
		seen[candidate] = struct{}{}
		checked = append(checked, candidate)

		stat, statErr := os.Stat(candidate)
		if statErr == nil && !stat.IsDir() {
			if isShellWrapperFile(candidate) {
				continue
			}
			return candidate, nil
		}
	}

	return "", fmt.Errorf("openclaw entry not found under %s (checked: %s)", OpenClawDir, strings.Join(checked, ", "))
}

func isShellWrapperFile(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	if len(raw) == 0 {
		return false
	}
	firstLine := string(raw)
	if idx := strings.IndexByte(firstLine, '\n'); idx >= 0 {
		firstLine = firstLine[:idx]
	}
	firstLine = strings.TrimSpace(firstLine)
	return firstLine == "#!/bin/sh" || firstLine == "#!/usr/bin/env sh"
}

func resolveOpenClawRelativeEntry(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if filepath.IsAbs(trimmed) {
		return ""
	}
	cleaned := filepath.Clean(trimmed)
	if cleaned == "." || strings.HasPrefix(cleaned, "..") {
		return ""
	}
	return filepath.Join(OpenClawDir, cleaned)
}

func shellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func (m *Monitor) SyncInstallToLatest() error {
	m.addLog("[tower] Sync requested: syncing installed OpenClaw to latest image version")

	m.mu.Lock()
	shouldRestart := m.cmd != nil && m.cmd.Process != nil
	m.status = StatusStarting
	m.lastError = ""
	m.awaitingReturn = false
	m.lastRestartReason = ""
	m.userConfirmed = false
	m.startingDeadline = time.Time{}
	m.mu.Unlock()

	if shouldRestart {
		m.addLog("[tower] Stopping OpenClaw before sync")
		if err := m.StopOpenClaw(); err != nil {
			m.mu.Lock()
			m.status = StatusCrashed
			m.lastError = fmt.Sprintf("Failed to stop OpenClaw for sync: %v", err)
			m.startingDeadline = time.Time{}
			m.crashCount++
			m.mu.Unlock()
			return err
		}
	}

	if err := m.reinstallFromImage(); err != nil {
		m.mu.Lock()
		m.status = StatusCrashed
		m.lastError = err.Error()
		m.startingDeadline = time.Time{}
		m.crashCount++
		m.mu.Unlock()
		m.addLog(fmt.Sprintf("[tower] Sync failed: %v", err))
		return err
	}

	m.evaluateInstallSyncRequirement()

	if shouldRestart {
		m.addLog("[tower] Restarting OpenClaw after sync")
		if err := m.startOpenClaw(); err != nil {
			m.addLog(fmt.Sprintf("[tower] Restart after sync failed: %v", err))
			return err
		}
		return nil
	}

	m.mu.Lock()
	m.status = StatusStopped
	m.lastError = ""
	m.awaitingReturn = false
	m.lastRestartReason = ""
	m.startingDeadline = time.Time{}
	m.mu.Unlock()

	m.addLog("[tower] Sync complete; OpenClaw remains stopped")
	return nil
}

// copyDirWithProgress copies installation files using cp -a and reports progress by polling target size.
func (m *Monitor) copyDirWithProgress(src, dst string) error {
	totalBytes, err := dirSizeBytes(src)
	if err != nil || totalBytes <= 0 {
		totalBytes = 1
	}
	m.setCopyStateTotals(0, totalBytes)
	m.updateCopyProgress(0, 0, "正在复制文件")

	if err := os.MkdirAll(dst, 0755); err != nil {
		return fmt.Errorf("create destination root: %w", err)
	}

	// Use src/. to copy directory contents into dst directly.
	// filepath.Join(src, ".") collapses to src and would create dst/<basename(src)>.
	srcContents := filepath.Clean(src) + string(os.PathSeparator) + "."
	cmd := exec.Command("cp", "-a", srcContents, dst)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start cp -a: %w", err)
	}

	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case err := <-done:
			if err != nil {
				return fmt.Errorf("cp -a failed: %w", err)
			}
			copiedBytes, sizeErr := dirSizeBytes(dst)
			if sizeErr != nil || copiedBytes <= 0 {
				copiedBytes = totalBytes
			}
			if copiedBytes > totalBytes {
				copiedBytes = totalBytes
			}
			m.updateCopyProgress(0, copiedBytes, "复制完成")
			return nil
		case <-ticker.C:
			copiedBytes, sizeErr := dirSizeBytes(dst)
			if sizeErr != nil {
				continue
			}
			if copiedBytes > totalBytes {
				copiedBytes = totalBytes
			}
			m.updateCopyProgress(0, copiedBytes, "正在复制文件")
		}
	}
}

func dirSizeBytes(path string) (int64, error) {
	out, err := exec.Command("du", "-sb", path).Output()
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(out))
	if len(fields) == 0 {
		return 0, fmt.Errorf("unexpected du output for %s", path)
	}
	size, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil {
		return 0, err
	}
	return size, nil
}

func (m *Monitor) GetStatus() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}

func (m *Monitor) GetStatusInfo() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	info := map[string]interface{}{
		"status":            string(m.status),
		"userConfirmed":     m.userConfirmed,
		"awaitingReturn":    m.awaitingReturn,
		"updateRequired":    m.updateRequired,
		"updateReason":      m.updateReason,
		"copyInProgress":    m.copyInProgress,
		"copySource":        m.copySource,
		"copyStage":         m.copyStage,
		"copyTotalEntries":  m.copyTotalEntries,
		"copyCopiedEntries": m.copyCopiedEntries,
		"copyTotalBytes":    m.copyTotalBytes,
		"copyCopiedBytes":   m.copyCopiedBytes,
		"copyPercent":       m.copyPercent,
		"crashCount":        m.crashCount,
		"lastError":         m.lastError,
		"lastRestartReason": m.lastRestartReason,
	}

	if !m.copyUpdatedAt.IsZero() {
		info["copyUpdatedAt"] = m.copyUpdatedAt.Format(time.RFC3339Nano)
	}

	if !m.startTime.IsZero() {
		info["uptime"] = time.Since(m.startTime).Seconds()
	}

	if !m.copyInProgress && strings.TrimSpace(m.copySource) == "" {
		m.loadEntrypointCopyProgress(info)
	}

	return info
}

func (m *Monitor) GetLogs() []string {
	m.logsMu.RLock()
	defer m.logsMu.RUnlock()
	result := make([]string, len(m.logs))
	copy(result, m.logs)
	return result
}

func (m *Monitor) ClearLogs() {
	m.logsMu.Lock()
	defer m.logsMu.Unlock()
	m.logs = make([]string, 0, MaxLogLines)
}

func (m *Monitor) addLog(line string) {
	m.logsMu.Lock()
	defer m.logsMu.Unlock()

	// Add timestamp
	ts := time.Now().Format("15:04:05")
	logLine := fmt.Sprintf("[%s] %s", ts, line)

	m.logs = append(m.logs, logLine)

	// Trim if too many
	if len(m.logs) > MaxLogLines {
		m.logs = m.logs[len(m.logs)-MaxLogLines:]
	}
}

func (m *Monitor) IsProxyMode() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	// Proxy when running, unless crashed and not yet confirmed
	// After crash, user must confirm to re-enter proxy mode
	if m.status == StatusRunning {
		// OpenClaw requested an in-process restart (for example after AI config operations).
		// Keep Tower UI visible until operator confirms return.
		if m.awaitingReturn {
			return false
		}
		if m.updateRequired && !m.userConfirmed {
			return false
		}
		// If never crashed, auto-proxy
		// If crashed before, need user confirmation
		if m.crashCount == 0 {
			return true
		}
		return m.userConfirmed
	}
	return false
}

func (m *Monitor) SetUserConfirmed(confirmed bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.userConfirmed = confirmed
	if confirmed {
		m.awaitingReturn = false
		m.lastRestartReason = ""
	}
}

func (m *Monitor) IsUpdateRequired() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.updateRequired
}

// PromoteRunningIfReachable probes gateway liveness and updates status to running when reachable.
// This is used by explicit operator actions (for example "confirm return") to avoid stale status.
func (m *Monitor) PromoteRunningIfReachable() bool {
	url := fmt.Sprintf("http://localhost:%s/health", m.config.OpenClawPort)
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url)

	healthErr := err
	if resp != nil {
		defer resp.Body.Close()
		io.Copy(io.Discard, resp.Body)
		if resp.StatusCode != http.StatusOK {
			healthErr = fmt.Errorf("health endpoint returned status %d", resp.StatusCode)
		}
	}

	reachable := healthErr == nil
	if !reachable {
		reachable = isTCPPortReachable("127.0.0.1", m.config.OpenClawPort, 1200*time.Millisecond)
	}
	if !reachable {
		return false
	}

	m.mu.Lock()
	wasRunning := m.status == StatusRunning
	m.status = StatusRunning
	m.lastError = ""
	m.startingDeadline = time.Time{}
	if m.startTime.IsZero() {
		m.startTime = time.Now()
	}
	m.mu.Unlock()

	if !wasRunning {
		if healthErr == nil {
			m.addLog("[tower] Gateway liveness probe succeeded; status promoted to running")
		} else {
			m.addLog(fmt.Sprintf("[tower] Gateway port is reachable during confirm probe (health unavailable: %v)", healthErr))
		}
	}

	return true
}

func (m *Monitor) StartOpenClaw() error {
	m.mu.Lock()
	if m.status == StatusRunning || m.status == StatusStarting {
		m.mu.Unlock()
		return fmt.Errorf("OpenClaw is already running or starting")
	}
	m.mu.Unlock()

	return m.startOpenClaw()
}

func (m *Monitor) StopOpenClaw() error {
	m.mu.Lock()

	if m.cmd == nil || m.cmd.Process == nil {
		m.status = StatusStopped
		m.awaitingReturn = false
		m.lastRestartReason = ""
		m.startingDeadline = time.Time{}
		m.mu.Unlock()
		return nil
	}

	cmd := m.cmd
	cmdDone := m.cmdDone
	m.mu.Unlock()

	m.addLog("[tower] Stopping OpenClaw...")

	m.mu.Lock()
	m.stopRequested = true
	m.mu.Unlock()

	// Send SIGTERM first
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		// Process might already be dead
		m.mu.Lock()
		m.status = StatusStopped
		m.cmd = nil
		m.startingDeadline = time.Time{}
		m.mu.Unlock()
		return nil
	}

	if cmdDone == nil {
		m.addLog("[tower] Stop requested but process watcher channel missing; continuing without wait")
		m.mu.Lock()
		m.status = StatusStopped
		m.cmd = nil
		m.awaitingReturn = false
		m.lastRestartReason = ""
		m.stopRequested = false
		m.startingDeadline = time.Time{}
		m.mu.Unlock()
		return nil
	}

	select {
	case <-cmdDone:
		m.mu.Lock()
		m.status = StatusStopped
		m.cmd = nil
		m.cmdDone = nil
		m.awaitingReturn = false
		m.lastRestartReason = ""
		m.stopRequested = false
		m.startingDeadline = time.Time{}
		m.mu.Unlock()
		m.addLog("[tower] OpenClaw stopped gracefully")
	case <-time.After(5 * time.Second):
		// Force kill
		cmd.Process.Kill()
		select {
		case <-cmdDone:
			m.mu.Lock()
			m.status = StatusStopped
			m.cmd = nil
			m.cmdDone = nil
			m.awaitingReturn = false
			m.lastRestartReason = ""
			m.stopRequested = false
			m.startingDeadline = time.Time{}
			m.mu.Unlock()
			m.addLog("[tower] OpenClaw force killed after timeout")
		case <-time.After(3 * time.Second):
			m.mu.Lock()
			m.status = StatusStopped
			m.cmd = nil
			m.cmdDone = nil
			m.awaitingReturn = false
			m.lastRestartReason = ""
			m.stopRequested = false
			m.startingDeadline = time.Time{}
			m.mu.Unlock()
			m.addLog("[tower] OpenClaw force kill requested; process exit not observed in time")
		}
	}

	return nil
}

func (m *Monitor) startOpenClaw() error {
	m.mu.Lock()
	m.status = StatusStarting
	m.lastError = ""
	m.awaitingReturn = false
	m.lastRestartReason = ""
	m.startingDeadline = time.Now().Add(startupHealthTimeout)
	m.mu.Unlock()

	m.addLog("[tower] Starting OpenClaw...")

	binPath, err := m.ensureOpenClawExecutable()
	if err != nil {
		m.mu.Lock()
		m.status = StatusCrashed
		m.lastError = err.Error()
		m.startingDeadline = time.Time{}
		m.mu.Unlock()
		m.addLog(fmt.Sprintf("[tower] Failed to prepare OpenClaw executable: %v", err))
		return err
	}

	// Build command using absolute binary path to avoid PATH drift issues.
	cmd := exec.Command(binPath, "gateway", "run", "--bind", "lan", "--port", m.config.OpenClawPort)
	cmd.Env = os.Environ()

	// Capture stdout
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		m.addLog(fmt.Sprintf("[tower] Failed to create stdout pipe: %v", err))
		return err
	}

	// Capture stderr
	stderr, err := cmd.StderrPipe()
	if err != nil {
		m.addLog(fmt.Sprintf("[tower] Failed to create stderr pipe: %v", err))
		return err
	}

	if err := cmd.Start(); err != nil {
		m.mu.Lock()
		m.status = StatusCrashed
		m.lastError = err.Error()
		m.startingDeadline = time.Time{}
		m.mu.Unlock()
		m.addLog(fmt.Sprintf("[tower] Failed to start OpenClaw: %v", err))
		return err
	}

	m.mu.Lock()
	m.cmd = cmd
	m.cmdDone = make(chan error, 1)
	m.stopRequested = false
	m.startTime = time.Now()
	m.mu.Unlock()

	m.addLog(fmt.Sprintf("[tower] OpenClaw started with PID %d", cmd.Process.Pid))

	// Read stdout in background
	go m.readOutput(stdout, "stdout")
	go m.readOutput(stderr, "stderr")

	// Monitor process in background
	go func() {
		err := cmd.Wait()

		m.mu.Lock()
		cmdDone := m.cmdDone
		if cmdDone != nil {
			select {
			case cmdDone <- err:
			default:
			}
		}
		wasStopRequested := m.stopRequested

		if wasStopRequested {
			m.status = StatusStopped
			m.awaitingReturn = false
			m.lastRestartReason = ""
			m.startingDeadline = time.Time{}
			m.lastError = ""
		} else {
			// OpenClaw can restart itself and drop the original child handle.
			// Keep status in "starting" and let health checks determine real liveness.
			m.status = StatusStarting
			m.userConfirmed = false
			if m.lastRestartReason == "" {
				m.lastRestartReason = "Gateway process exited; waiting for health check"
			}
			m.awaitingReturn = true
			m.startingDeadline = time.Now().Add(startupHealthTimeout)
			if err != nil {
				m.lastError = err.Error()
			} else {
				m.lastError = ""
			}
		}
		m.cmd = nil
		m.cmdDone = nil
		m.stopRequested = false
		m.mu.Unlock()

		// Log outside of lock
		if wasStopRequested {
			if err != nil {
				m.addLog(fmt.Sprintf("[tower] OpenClaw stopped: %v", err))
			} else {
				m.addLog("[tower] OpenClaw exited normally")
			}
		} else if err != nil {
			m.addLog(fmt.Sprintf("[tower] OpenClaw process exited (%v); waiting for health check", err))
		} else {
			m.addLog("[tower] OpenClaw process exited; waiting for health check")
		}
	}()

	return nil
}

func (m *Monitor) readOutput(r io.Reader, name string) {
	scanner := bufio.NewScanner(r)
	// Increase buffer size for long lines
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		m.trackRestartIntent(line)
		m.addLog(line)
		// Also print to console for debugging
		fmt.Printf("[openclaw:%s] %s\n", name, line)
	}
}

func (m *Monitor) trackRestartIntent(line string) {
	lower := strings.ToLower(line)
	restartByConfig := strings.Contains(lower, "config change requires gateway restart")
	restartBySignal := strings.Contains(lower, "received sigusr1; restarting")
	if !restartByConfig && !restartBySignal {
		return
	}

	reason := "Gateway self-restart requested"
	if restartByConfig {
		reason = "Config change requested gateway restart"
	}

	m.mu.Lock()
	alreadyAwaiting := m.awaitingReturn
	m.awaitingReturn = true
	m.userConfirmed = false
	m.status = StatusStarting
	m.startingDeadline = time.Now().Add(startupHealthTimeout)
	m.lastRestartReason = reason
	m.mu.Unlock()

	if !alreadyAwaiting {
		m.addLog("[tower] Detected gateway self-restart, waiting for operator confirmation to return")
	}
}

func (m *Monitor) checkHealth() {
	// HTTP health check is the source of truth for liveness; process handles are advisory.
	url := fmt.Sprintf("http://localhost:%s/health", m.config.OpenClawPort)
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url)

	healthErr := err
	if resp != nil {
		defer resp.Body.Close()
		io.Copy(io.Discard, resp.Body)
		if resp.StatusCode != http.StatusOK {
			healthErr = fmt.Errorf("health endpoint returned status %d", resp.StatusCode)
		}
	}

	portReachable := false
	if healthErr != nil {
		portReachable = isTCPPortReachable("127.0.0.1", m.config.OpenClawPort, 1200*time.Millisecond)
	}

	if healthErr == nil || portReachable {
		m.mu.Lock()
		wasRunning := m.status == StatusRunning
		m.status = StatusRunning
		m.lastError = ""
		m.startingDeadline = time.Time{}
		if !wasRunning || m.startTime.IsZero() {
			m.startTime = time.Now()
		}
		m.mu.Unlock()
		if !wasRunning {
			if healthErr == nil {
				m.addLog("[tower] OpenClaw is now healthy")
			} else {
				m.addLog(fmt.Sprintf("[tower] OpenClaw port is reachable (health check unavailable: %v)", healthErr))
			}
		}
		return
	}

	m.mu.Lock()
	switch m.status {
	case StatusStarting:
		// During install/sync copy we intentionally stay in starting while /health is unavailable.
		if m.copyInProgress {
			m.mu.Unlock()
			return
		}
		// Starting without a deadline means we are in a non-runtime phase (for example sync/copy).
		if m.startingDeadline.IsZero() || time.Now().Before(m.startingDeadline) {
			m.mu.Unlock()
			return
		}
		m.status = StatusCrashed
		m.lastError = healthErr.Error()
		m.startingDeadline = time.Time{}
		m.crashCount++
		m.userConfirmed = false
		m.awaitingReturn = false
		m.lastRestartReason = ""
		m.mu.Unlock()
		m.addLog(fmt.Sprintf("[tower] Health check failed after startup timeout: %v", healthErr))
		return
	case StatusRunning:
		m.status = StatusCrashed
		m.lastError = healthErr.Error()
		m.startingDeadline = time.Time{}
		m.crashCount++
		m.userConfirmed = false
		m.awaitingReturn = false
		m.lastRestartReason = ""
		m.mu.Unlock()
		m.addLog(fmt.Sprintf("[tower] Health check failed: %v", healthErr))
		return
	default:
		m.mu.Unlock()
		return
	}
}

func isTCPPortReachable(host, port string, timeout time.Duration) bool {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, port), timeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
