package terminal

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

type Message struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

// Winsize for pty resize
type Winsize struct {
	Rows uint16
	Cols uint16
	X    uint16
	Y    uint16
}

// Simple WebSocket connection wrapper
type wsConn struct {
	conn   net.Conn
	reader *bufio.Reader
	mu     sync.Mutex
}

func (ws *wsConn) ReadMessage() ([]byte, error) {
	// Read frame header
	header := make([]byte, 2)
	if _, err := io.ReadFull(ws.reader, header); err != nil {
		return nil, err
	}

	masked := (header[1] & 0x80) != 0
	length := int(header[1] & 0x7F)

	// Extended payload length
	if length == 126 {
		ext := make([]byte, 2)
		if _, err := io.ReadFull(ws.reader, ext); err != nil {
			return nil, err
		}
		length = int(ext[0])<<8 | int(ext[1])
	} else if length == 127 {
		ext := make([]byte, 8)
		if _, err := io.ReadFull(ws.reader, ext); err != nil {
			return nil, err
		}
		length = int(ext[4])<<24 | int(ext[5])<<16 | int(ext[6])<<8 | int(ext[7])
	}

	// Masking key
	var mask []byte
	if masked {
		mask = make([]byte, 4)
		if _, err := io.ReadFull(ws.reader, mask); err != nil {
			return nil, err
		}
	}

	// Payload
	payload := make([]byte, length)
	if _, err := io.ReadFull(ws.reader, payload); err != nil {
		return nil, err
	}

	// Unmask
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}

	return payload, nil
}

func (ws *wsConn) WriteMessage(data []byte) error {
	ws.mu.Lock()
	defer ws.mu.Unlock()

	length := len(data)
	var header []byte

	if length <= 125 {
		header = []byte{0x81, byte(length)}
	} else if length <= 65535 {
		header = []byte{0x81, 126, byte(length >> 8), byte(length)}
	} else {
		header = []byte{0x81, 127, 0, 0, 0, 0, byte(length >> 24), byte(length >> 16), byte(length >> 8), byte(length)}
	}

	if _, err := ws.conn.Write(header); err != nil {
		return err
	}
	_, err := ws.conn.Write(data)
	return err
}

func (ws *wsConn) WriteJSON(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return ws.WriteMessage(data)
}

func (ws *wsConn) Close() error {
	return ws.conn.Close()
}

// UpgradeWebSocket performs WebSocket handshake
func UpgradeWebSocket(w http.ResponseWriter, r *http.Request) (*wsConn, error) {
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "Missing Sec-WebSocket-Key", http.StatusBadRequest)
		return nil, io.EOF
	}

	// Compute accept key
	h := sha1.New()
	h.Write([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	accept := base64.StdEncoding.EncodeToString(h.Sum(nil))

	// Hijack connection
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "WebSocket not supported", http.StatusInternalServerError)
		return nil, io.EOF
	}

	conn, bufrw, err := hijacker.Hijack()
	if err != nil {
		return nil, err
	}

	// Send handshake response
	response := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"

	if _, err := conn.Write([]byte(response)); err != nil {
		conn.Close()
		return nil, err
	}

	return &wsConn{
		conn:   conn,
		reader: bufrw.Reader,
	}, nil
}

// openPty opens a new pty/tty pair using pure syscalls
func openPty() (pty, tty *os.File, err error) {
	// Open /dev/ptmx
	ptmx, err := os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		return nil, nil, err
	}

	// Get the pts name
	var ptyno uint32
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, ptmx.Fd(), syscall.TIOCGPTN, uintptr(unsafe.Pointer(&ptyno)))
	if errno != 0 {
		ptmx.Close()
		return nil, nil, errno
	}

	// Unlock the pts
	var unlock int32
	_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, ptmx.Fd(), syscall.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock)))
	if errno != 0 {
		ptmx.Close()
		return nil, nil, errno
	}

	// Open the slave pts
	ptsName := "/dev/pts/" + itoa(int(ptyno))
	pts, err := os.OpenFile(ptsName, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		ptmx.Close()
		return nil, nil, err
	}

	return ptmx, pts, nil
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(b[pos:])
}

// setWinsize sets the terminal size
func setWinsize(fd uintptr, w *Winsize) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(w)))
	if errno != 0 {
		return errno
	}
	return nil
}

// startWithPty starts a command with a pty
func startWithPty(cmd *exec.Cmd) (pty *os.File, err error) {
	ptmx, pts, err := openPty()
	if err != nil {
		return nil, err
	}

	cmd.Stdin = pts
	cmd.Stdout = pts
	cmd.Stderr = pts

	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid:  true,
		Setctty: true,
	}

	if err := cmd.Start(); err != nil {
		ptmx.Close()
		pts.Close()
		return nil, err
	}

	pts.Close() // Close slave in parent

	return ptmx, nil
}

// HandleWebSocket handles terminal WebSocket connection
func HandleWebSocket(w http.ResponseWriter, r *http.Request, cwd string) {
	ws, err := UpgradeWebSocket(w, r)
	if err != nil {
		log.Printf("[terminal] WebSocket upgrade failed: %v", err)
		return
	}
	defer ws.Close()

	// Create PTY
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}

	cmd := exec.Command(shell)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	ptmx, err := startWithPty(cmd)
	if err != nil {
		log.Printf("[terminal] Failed to start PTY: %v", err)
		ws.WriteJSON(Message{Type: "error", Data: err.Error()})
		return
	}
	defer ptmx.Close()

	var closed bool
	var closeMu sync.Mutex

	// Read from PTY and send to WebSocket
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if err != nil {
				break
			}
			closeMu.Lock()
			if closed {
				closeMu.Unlock()
				break
			}
			closeMu.Unlock()

			ws.WriteJSON(Message{Type: "data", Data: string(buf[:n])})
		}
	}()

	// Read from WebSocket and write to PTY
	for {
		msgBytes, err := ws.ReadMessage()
		if err != nil {
			break
		}

		var msg Message
		if err := json.Unmarshal(msgBytes, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "input":
			ptmx.Write([]byte(msg.Data))
		case "resize":
			if msg.Cols > 0 && msg.Rows > 0 {
				setWinsize(ptmx.Fd(), &Winsize{
					Cols: uint16(msg.Cols),
					Rows: uint16(msg.Rows),
				})
			}
		case "close":
			closeMu.Lock()
			closed = true
			closeMu.Unlock()
			cmd.Process.Kill()
			return
		}
	}

	// Cleanup
	closeMu.Lock()
	closed = true
	closeMu.Unlock()
	cmd.Process.Kill()
}

// IsWebSocketRequest checks if request is a WebSocket upgrade
func IsWebSocketRequest(r *http.Request) bool {
	return strings.ToLower(r.Header.Get("Upgrade")) == "websocket"
}
