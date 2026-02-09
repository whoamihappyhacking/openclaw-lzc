package main

import (
	"embed"
	"flag"
	"log"
	"net/http"

	"openclaw-tower/internal/monitor"
	"openclaw-tower/internal/web"
)

//go:embed static/*
var staticFS embed.FS

func main() {
	port := flag.String("port", "8800", "Port to listen on")
	openclawPort := flag.String("openclaw-port", "18789", "OpenClaw gateway port")
	configPath := flag.String("config", "/home/node/.openclaw/openclaw.json", "OpenClaw config file path")
	flag.Parse()

	// Initialize process monitor
	mon := monitor.New(monitor.Config{
		OpenClawPort: *openclawPort,
		ConfigPath:   *configPath,
	})

	// Start monitoring
	go mon.Start()

	// Setup HTTP handlers
	handler := web.NewHandler(web.Config{
		Monitor:      mon,
		StaticFS:     staticFS,
		OpenClawPort: *openclawPort,
		ConfigPath:   *configPath,
	})

	log.Printf("[tower] Starting on 0.0.0.0:%s, proxying to OpenClaw on port %s", *port, *openclawPort)
	if err := http.ListenAndServe("0.0.0.0:"+*port, handler); err != nil {
		log.Fatalf("[tower] Failed to start server: %v", err)
	}
}
