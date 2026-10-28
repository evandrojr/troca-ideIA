package main

import (
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

// Config guarda a única configuração necessária: o endpoint de escuta.
type Config struct {
	Addr string
}

func getEnv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg := Config{Addr: getEnv("ADDR", ":7676")}

	room := NewRoom()
	go room.Run()

	srv := &http.Server{
		Addr:         cfg.Addr,
		Handler:      newServer(room),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 0, // long-poll / watch pode segurar a resposta
		IdleTimeout:  120 * time.Second,
	}

	logger.Info("servidor rodando",
		"url", "http://localhost"+portSuffix(cfg.Addr)+"/",
		"modo", "sala única (humanos + IAs)",
		"guia", "/guide",
	)
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("servidor falhou", "err", err)
		os.Exit(1)
	}
}

// portSuffix extrai a parte ":porta" de um endereço para montar a URL no log.
func portSuffix(addr string) string {
	if i := strings.IndexByte(addr, ':'); i >= 0 {
		return addr[i:]
	}
	return ":" + addr
}
