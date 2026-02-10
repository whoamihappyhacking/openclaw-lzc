package web

import (
	"bytes"
	"compress/gzip"
	"embed"
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"

	"openclaw-tower/internal/monitor"
	"openclaw-tower/internal/recovery"
	"openclaw-tower/internal/terminal"
)

// Default OpenClaw config (embedded from default-config.json).
//
//go:embed default-config.json
var defaultConfig string

// Tower health check script to inject into proxied HTML responses
const towerHealthCheckScript = `<script>
(function(){
  var checkInterval = setInterval(function(){
    fetch('/tower/status').then(function(r){return r.json()}).then(function(d){
      // Return to Tower UI when gateway is down, crashed, or requested an operator-confirmed return
      if(d.awaitingReturn||d.status==='crashed'||d.status==='stopped'){
        clearInterval(checkInterval);
        location.reload();
      }
      // If running but crashed before and not confirmed, also reload to recovery UI
      if(d.status==='running'&&d.crashCount>0&&!d.userConfirmed){
        clearInterval(checkInterval);
        location.reload();
      }
    }).catch(function(){});
  }, 2000);
})();
</script>`

type Config struct {
	Monitor      *monitor.Monitor
	StaticFS     embed.FS
	OpenClawPort string
	ConfigPath   string
}

type Handler struct {
	config   Config
	proxy    *httputil.ReverseProxy
	recovery *recovery.Recovery
}

func NewHandler(cfg Config) *Handler {
	target, _ := url.Parse("http://localhost:" + cfg.OpenClawPort)
	proxy := httputil.NewSingleHostReverseProxy(target)

	// Custom error handler for proxy
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("[proxy] Error: %v", err)
		// Don't write anything, let the main handler deal with it
	}

	// Modify response to inject health check script into HTML
	proxy.ModifyResponse = func(resp *http.Response) error {
		contentType := resp.Header.Get("Content-Type")
		if !strings.Contains(contentType, "text/html") {
			return nil
		}

		// Read original body
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return err
		}

		// Check if gzipped
		isGzip := resp.Header.Get("Content-Encoding") == "gzip"
		var htmlBody []byte

		if isGzip {
			gr, err := gzip.NewReader(bytes.NewReader(body))
			if err != nil {
				// Not actually gzip, use as-is
				htmlBody = body
				isGzip = false
			} else {
				htmlBody, _ = io.ReadAll(gr)
				gr.Close()
			}
		} else {
			htmlBody = body
		}

		// Inject script before </body> or </html> or at end
		injected := false
		htmlStr := string(htmlBody)

		if idx := strings.LastIndex(strings.ToLower(htmlStr), "</body>"); idx != -1 {
			htmlStr = htmlStr[:idx] + towerHealthCheckScript + htmlStr[idx:]
			injected = true
		} else if idx := strings.LastIndex(strings.ToLower(htmlStr), "</html>"); idx != -1 {
			htmlStr = htmlStr[:idx] + towerHealthCheckScript + htmlStr[idx:]
			injected = true
		}

		if !injected {
			htmlStr += towerHealthCheckScript
		}

		newBody := []byte(htmlStr)

		// Re-compress if was gzipped
		if isGzip {
			var buf bytes.Buffer
			gw := gzip.NewWriter(&buf)
			gw.Write(newBody)
			gw.Close()
			newBody = buf.Bytes()
		}

		// Update response
		resp.Body = io.NopCloser(bytes.NewReader(newBody))
		resp.ContentLength = int64(len(newBody))
		resp.Header.Set("Content-Length", strconv.Itoa(len(newBody)))

		return nil
	}

	rec := recovery.New(cfg.ConfigPath, defaultConfig)

	return &Handler{
		config:   cfg,
		proxy:    proxy,
		recovery: rec,
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	// Tower API endpoints
	if strings.HasPrefix(path, "/tower/") {
		h.handleTowerAPI(w, r)
		return
	}

	// Check if we should proxy or show recovery UI
	if h.config.Monitor.IsProxyMode() {
		h.proxy.ServeHTTP(w, r)
		return
	}

	// Show recovery UI
	h.serveRecoveryUI(w, r)
}

func (h *Handler) handleTowerAPI(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/tower")

	switch {
	case path == "/status" && r.Method == "GET":
		h.handleStatus(w, r)

	case path == "/start" && r.Method == "POST":
		h.handleStart(w, r)

	case path == "/stop" && r.Method == "POST":
		h.handleStop(w, r)

	case path == "/restore-backup" && r.Method == "POST":
		h.handleRestoreBackup(w, r)

	case path == "/restore-default" && r.Method == "POST":
		h.handleRestoreDefault(w, r)

	case path == "/confirm-ready" && r.Method == "POST":
		h.handleConfirmReady(w, r)

	case path == "/logs" && r.Method == "GET":
		h.handleLogs(w, r)

	case path == "/logs/clear" && r.Method == "POST":
		h.handleClearLogs(w, r)

	case path == "/ws/terminal":
		h.handleTerminalWS(w, r)

	case strings.HasPrefix(path, "/static/"):
		h.serveStatic(w, r, strings.TrimPrefix(path, "/static/"))

	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) handleStatus(w http.ResponseWriter, r *http.Request) {
	info := h.config.Monitor.GetStatusInfo()
	info["config"] = h.recovery.GetConfigInfo()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(info)
}

func (h *Handler) handleStart(w http.ResponseWriter, r *http.Request) {
	if err := h.config.Monitor.StartOpenClaw(); err != nil {
		h.jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}
	h.jsonOK(w, "OpenClaw starting")
}

func (h *Handler) handleStop(w http.ResponseWriter, r *http.Request) {
	if err := h.config.Monitor.StopOpenClaw(); err != nil {
		h.jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	h.jsonOK(w, "OpenClaw stopped")
}

func (h *Handler) handleRestoreBackup(w http.ResponseWriter, r *http.Request) {
	if err := h.recovery.RestoreBackup(); err != nil {
		h.jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	h.jsonOK(w, "Backup restored")
}

func (h *Handler) handleRestoreDefault(w http.ResponseWriter, r *http.Request) {
	if err := h.recovery.RestoreDefault(); err != nil {
		h.jsonError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	h.jsonOK(w, "Default config restored")
}

func (h *Handler) handleConfirmReady(w http.ResponseWriter, r *http.Request) {
	h.config.Monitor.SetUserConfirmed(true)
	h.jsonOK(w, "Confirmed, switching to OpenClaw")
}

func (h *Handler) handleLogs(w http.ResponseWriter, r *http.Request) {
	logs := h.config.Monitor.GetLogs()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"logs": logs,
	})
}

func (h *Handler) handleClearLogs(w http.ResponseWriter, r *http.Request) {
	h.config.Monitor.ClearLogs()
	h.jsonOK(w, "Logs cleared")
}

func (h *Handler) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	if !terminal.IsWebSocketRequest(r) {
		http.Error(w, "WebSocket required", http.StatusBadRequest)
		return
	}
	// Use /home/node as default cwd
	terminal.HandleWebSocket(w, r, "/home/node")
}

func (h *Handler) serveStatic(w http.ResponseWriter, r *http.Request, name string) {
	f, err := h.config.StaticFS.Open("static/" + name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()

	stat, _ := f.Stat()
	content, _ := io.ReadAll(f)

	// Set content type
	switch {
	case strings.HasSuffix(name, ".html"):
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	case strings.HasSuffix(name, ".css"):
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	case strings.HasSuffix(name, ".js"):
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	}

	http.ServeContent(w, r, name, stat.ModTime(), strings.NewReader(string(content)))
}

func (h *Handler) serveRecoveryUI(w http.ResponseWriter, r *http.Request) {
	f, err := h.config.StaticFS.Open("static/index.html")
	if err != nil {
		http.Error(w, "Recovery UI not found", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	io.Copy(w, f.(fs.File))
}

func (h *Handler) jsonOK(w http.ResponseWriter, message string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"ok": "true", "message": message})
}

func (h *Handler) jsonError(w http.ResponseWriter, message string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"ok": "false", "error": message})
}
