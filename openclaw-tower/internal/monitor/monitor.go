package monitor

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// OpenClaw installation paths
	ImageDir    = "/opt/openclaw-image"
	NPMGlobal   = "/app/npm-global"
	OpenClawDir = NPMGlobal + "/lib/node_modules/openclaw"
	OpenClawBin = NPMGlobal + "/bin/openclaw"
	EntryJSPath = OpenClawDir + "/dist/entry.js"
)

type Status string

const (
	StatusStarting Status = "starting"
	StatusRunning  Status = "running"
	StatusStopped  Status = "stopped"
	StatusCrashed  Status = "crashed"
)

const MaxLogLines = 500

type Config struct {
	OpenClawPort string
	ConfigPath   string
}

type Monitor struct {
	config            Config
	status            Status
	userConfirmed     bool
	awaitingReturn    bool
	mu                sync.RWMutex
	cmd               *exec.Cmd
	lastError         string
	lastRestartReason string
	startTime         time.Time
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

	// Initial startup
	m.startOpenClaw()

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
	m.mu.Unlock()

	// Remove corrupted installation
	if err := os.RemoveAll(OpenClawDir); err != nil {
		m.addLog(fmt.Sprintf("[tower] Failed to remove corrupted installation: %v", err))
		m.mu.Lock()
		m.status = StatusCrashed
		m.lastError = fmt.Sprintf("Failed to remove corrupted installation: %v", err)
		m.crashCount++
		m.mu.Unlock()
		return
	}

	// Copy from image
	if err := m.copyDir(ImageDir, OpenClawDir); err != nil {
		m.addLog(fmt.Sprintf("[tower] Failed to copy from image: %v", err))
		m.mu.Lock()
		m.status = StatusCrashed
		m.lastError = fmt.Sprintf("Failed to reinstall: %v", err)
		m.crashCount++
		m.mu.Unlock()
		return
	}

	// Recreate symlink
	os.MkdirAll(filepath.Dir(OpenClawBin), 0755)
	os.Remove(OpenClawBin) // Remove old symlink if exists
	if err := os.Symlink(OpenClawDir+"/openclaw.mjs", OpenClawBin); err != nil {
		m.addLog(fmt.Sprintf("[tower] Failed to create symlink: %v", err))
		// Not fatal, continue
	}

	m.addLog("[tower] Reinstallation complete!")

	// Reset status
	m.mu.Lock()
	m.status = StatusStopped
	m.lastError = ""
	m.mu.Unlock()
}

// copyDir recursively copies a directory
func (m *Monitor) copyDir(src, dst string) error {
	// Use cp -r for simplicity
	cmd := exec.Command("cp", "-r", src, dst)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, string(output))
	}
	return nil
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
		"crashCount":        m.crashCount,
		"lastError":         m.lastError,
		"lastRestartReason": m.lastRestartReason,
	}

	if !m.startTime.IsZero() {
		info["uptime"] = time.Since(m.startTime).Seconds()
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
		m.mu.Unlock()
		return nil
	}

	cmd := m.cmd
	m.mu.Unlock()

	m.addLog("[tower] Stopping OpenClaw...")

	// Send SIGTERM first
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		// Process might already be dead
		m.mu.Lock()
		m.status = StatusStopped
		m.cmd = nil
		m.mu.Unlock()
		return nil
	}

	// Wait a bit for graceful shutdown
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	select {
	case <-done:
		m.mu.Lock()
		m.status = StatusStopped
		m.cmd = nil
		m.awaitingReturn = false
		m.lastRestartReason = ""
		m.mu.Unlock()
		m.addLog("[tower] OpenClaw stopped gracefully")
	case <-time.After(5 * time.Second):
		// Force kill
		cmd.Process.Kill()
		m.mu.Lock()
		m.status = StatusStopped
		m.cmd = nil
		m.awaitingReturn = false
		m.lastRestartReason = ""
		m.mu.Unlock()
		m.addLog("[tower] OpenClaw force killed (timeout)")
	}

	return nil
}

func (m *Monitor) startOpenClaw() error {
	m.mu.Lock()
	m.status = StatusStarting
	m.lastError = ""
	m.awaitingReturn = false
	m.lastRestartReason = ""
	m.mu.Unlock()

	m.addLog("[tower] Starting OpenClaw...")

	// Build command - use the openclaw binary
	cmd := exec.Command("openclaw", "gateway", "run", "--bind", "lan", "--port", m.config.OpenClawPort)
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
		m.mu.Unlock()
		m.addLog(fmt.Sprintf("[tower] Failed to start OpenClaw: %v", err))
		return err
	}

	m.mu.Lock()
	m.cmd = cmd
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
		if err != nil {
			m.status = StatusCrashed
			m.lastError = err.Error()
			m.crashCount++
			m.userConfirmed = false // Reset confirmation on crash
			m.awaitingReturn = false
			m.lastRestartReason = ""
		} else {
			m.status = StatusStopped
			m.awaitingReturn = false
		}
		m.cmd = nil
		m.mu.Unlock()

		// Log outside of lock
		if err != nil {
			m.addLog(fmt.Sprintf("[tower] OpenClaw crashed: %v", err))
		} else {
			m.addLog("[tower] OpenClaw exited normally")
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
	m.lastRestartReason = reason
	m.mu.Unlock()

	if !alreadyAwaiting {
		m.addLog("[tower] Detected gateway self-restart, waiting for operator confirmation to return")
	}
}

func (m *Monitor) checkHealth() {
	m.mu.RLock()
	status := m.status
	m.mu.RUnlock()

	// Only check if we think it should be running
	if status != StatusStarting && status != StatusRunning {
		return
	}

	// HTTP health check
	url := fmt.Sprintf("http://localhost:%s/health", m.config.OpenClawPort)
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url)

	if err != nil {
		m.mu.Lock()
		if m.status == StatusStarting {
			// Still starting, give it time
			m.mu.Unlock()
			return
		}
		// Was running, now crashed
		m.status = StatusCrashed
		m.lastError = err.Error()
		m.crashCount++
		m.userConfirmed = false
		m.awaitingReturn = false
		m.lastRestartReason = ""
		m.mu.Unlock()
		m.addLog(fmt.Sprintf("[tower] Health check failed: %v", err))
		return
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)

	if resp.StatusCode == http.StatusOK {
		m.mu.Lock()
		if m.status != StatusRunning {
			m.status = StatusRunning
			m.addLog("[tower] OpenClaw is now healthy")
		}
		m.mu.Unlock()
	}
}
