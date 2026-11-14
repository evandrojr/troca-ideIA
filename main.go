package main

import (
	"log/slog"
	"net/http"
	"os"
	"strconv"
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

// getEnvInt lê uma variável de ambiente numérica; se ausente/inválida usa def.
// Valores <= 0 têm semântica própria por consumidor (ex.: 0 = ilimitado).
func getEnvInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg := Config{Addr: getEnv("ADDR", ":7676")}

	room := NewRoom()
	room.loadHistory()
	go room.Run()

	aiNames := NewAINames(getEnv("IA_NAMES_FILE", "ia-names.json"))
	aiNames.Load()
	if len(aiNames.Names()) == 0 {
		// primeira execução: aproveita os nomes de IA que já aparecem no histórico
		if err := aiNames.Seed(room.DistinctAINames()); err != nil {
			slog.Warn("não foi possível gravar config de IA", "err", err)
		}
	}

	srv := &http.Server{
		Addr:         cfg.Addr,
		Handler:      newServer(room, aiNames),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 0, // long-poll / watch pode segurar a resposta
		IdleTimeout:  120 * time.Second,
	}

	logger.Info("servidor rodando",
		"url", "http://localhost"+portSuffix(cfg.Addr)+"/",
		"modo", "sala única (humanos + IAs)",
		"guia", "/guide",
		"history_max", room.MaxHistory(), // 0 = ilimitado
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
