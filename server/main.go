package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const version = "1.0.0"

func main() {
	cfg := &Config{}
	var configFile string
	var migrateMetrics, migrateApply bool

	flag.StringVar(&cfg.StorageRoot, "storage-root", "", "Root directory for Markdown storage (required)")
	flag.StringVar(&cfg.MetricsRoot, "metrics-root", "", "Root directory for engagement metrics stored as platform/year/month/day-title.md (empty disables metrics storage)")
	flag.IntVar(&cfg.Port, "port", 7070, "HTTP listen port")
	flag.StringVar(&cfg.Host, "host", "127.0.0.1", "HTTP bind address")
	flag.StringVar(&cfg.LogLevel, "log-level", "info", "Log level: debug|info|warn|error")
	flag.StringVar(&configFile, "config", "", "Optional path to config.yaml (flags take priority)")
	flag.BoolVar(&migrateMetrics, "migrate-metrics", false, "Move engagement_* front matter of existing content files into the metrics tree, then exit")
	flag.BoolVar(&migrateApply, "migrate-apply", false, "With --migrate-metrics: actually write the changes (default: dry run)")
	flag.Parse()

	// Load YAML config first (flags override it)
	if configFile != "" {
		if err := cfg.LoadFromFile(configFile); err != nil {
			log.Fatalf("[synapse] Failed to load config file %q: %v", configFile, err)
		}
		log.Printf("[synapse] Loaded config from %s", configFile)
	}

	// Validate required fields
	if cfg.StorageRoot == "" {
		fmt.Fprintln(os.Stderr, "Error: --storage-root is required")
		flag.Usage()
		os.Exit(1)
	}

	// Ensure storage root exists
	if err := os.MkdirAll(cfg.StorageRoot, 0755); err != nil {
		log.Fatalf("[synapse] Cannot create storage root %q: %v", cfg.StorageRoot, err)
	}

	// One-shot migration: move legacy engagement_* front matter into the metrics tree
	if migrateMetrics {
		if cfg.MetricsRoot == "" {
			log.Fatalf("[synapse] --migrate-metrics requires --metrics-root")
		}
		if err := runMetricsMigration(cfg, migrateApply); err != nil {
			log.Fatalf("[synapse] Migration failed: %v", err)
		}
		return
	}

	// Ensure metrics root exists (optional feature)
	if cfg.MetricsRoot != "" {
		if err := os.MkdirAll(cfg.MetricsRoot, 0755); err != nil {
			log.Fatalf("[synapse] Cannot create metrics root %q: %v", cfg.MetricsRoot, err)
		}
	} else {
		log.Printf("[synapse] WARNING: --metrics-root not set, engagement data will not be persisted")
	}

	// Build ID cache from existing Markdown files
	cache := NewCache()
	log.Printf("[synapse] Scanning %s for existing entries...", cfg.StorageRoot)
	scanStart := time.Now()
	count, err := cache.BuildFromDisk(cfg.StorageRoot)
	if err != nil {
		log.Printf("[synapse] WARNING: Cache scan error: %v", err)
	} else {
		log.Printf("[synapse] Cache ready: %d entries (scanned in %v)", count, time.Since(scanStart).Round(time.Millisecond))
	}

	// Initialize and start scheduler
	scheduler := NewScheduler(cfg)
	scheduler.Start()

	// Wire up routes
	h := NewHandler(cfg, cache, scheduler)
	mux := http.NewServeMux()

	mux.HandleFunc("GET /{$}", h.Index)
	mux.HandleFunc("GET /health", h.Health)
	mux.HandleFunc("POST /collect", h.Collect)
	mux.HandleFunc("POST /collect/batch", h.CollectBatch)
	mux.HandleFunc("GET /check", h.Check)
	mux.HandleFunc("POST /check/batch", h.CheckBatch)
	mux.HandleFunc("POST /upsert", h.Upsert)
	mux.HandleFunc("POST /upsert/batch", h.UpsertBatch)
	mux.HandleFunc("GET /stats", h.Stats)
	mux.HandleFunc("GET /tasks", h.GetTasks)
	mux.HandleFunc("POST /tasks", h.SaveTasks)
	mux.HandleFunc("GET /tasks/trigger", h.TasksTrigger)

	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	srv := &http.Server{
		Addr:           addr,
		Handler:        LogMiddleware(mux),
		ReadTimeout:    30 * time.Second,
		WriteTimeout:   60 * time.Second,
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 1 << 20, // 1 MB header limit
	}

	// Start server in background
	go func() {
		log.Printf("[synapse] Listening on http://%s  (v%s, storage: %s, metrics: %s)", addr, version, cfg.StorageRoot, cfg.MetricsRoot)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[synapse] Server error: %v", err)
		}
	}()

	// Graceful shutdown on SIGINT / SIGTERM
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Printf("[synapse] Shutting down gracefully...")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	scheduler.Stop()

	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("[synapse] Shutdown error: %v", err)
	}
	log.Printf("[synapse] Stopped.")
}
