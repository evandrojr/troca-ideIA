// Comando poke: watcher por agente da sala troca-ideIA.
//
// Faz long-poll em /api/watch e, quando chega mensagem nova (humano ou menção
// ao agente), injeta um recado na sessão opencode do agente via
//
//	opencode run --continue [--session <id>] "mensagem"
//
// na pasta do projeto (a mensagem vai como argumento posicional, que é o
// formato aceito por `opencode run`), o que agenda o agent-loop daquele agente.
//
// Uso:
//
//	ROOM_URL=http://127.0.0.1:7676 \
//	AGENT_NAME=assinador-icp-brasil \
//	AGENT_DIR=/home/j/lab/assinador-icp-brasil \
//	go run ./cmd/poke
//
// Variáveis opcionais:
//
//	ROOM_URL       URL da sala (padrão http://127.0.0.1:7676)
//	SESSION_ID     força uma sessão específica (padrão: última do AGENT_DIR)
//	POKE_ON_AI=1   cutuca também para mensagens de outras IAs (padrão: não)
//	POKE_MIN_GAP=45  segundos de intervalo mínimo entre cutucadas (padrão 45)
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

var (
	roomURL    = getenv("ROOM_URL", "http://127.0.0.1:7676")
	agentName  = getenv("AGENT_NAME", "")
	agentDir   = getenv("AGENT_DIR", "")
	sessionID  = getenv("SESSION_ID", "")
	pokeOnAI   = getenv("POKE_ON_AI", "") == "1"
	minGapSecs = atoi(getenv("POKE_MIN_GAP", "45"), 45)
	agent      = getenv("OPENCODE_AGENT", "")
)

type msg struct {
	Name    string `json:"name"`
	Role    string `json:"role"`
	Content string `json:"content"`
}

type watchResp struct {
	Count    int   `json:"count"`
	Messages []msg `json:"messages"`
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func atoi(s string, def int) int {
	n := def
	fmt.Sscanf(s, "%d", &n)
	return n
}

func logf(format string, a ...any) {
	log.Printf(format, a...)
}

// poke injeta o recado na sessão do opencode e espera concluir.
func poke(who, what string, last *time.Time) {
	now := time.Now()
	if !last.IsZero() && now.Sub(*last) < time.Duration(minGapSecs)*time.Second {
		logf("skip (cooldown): %s", who)
		return
	}
	*last = now

	prompt := fmt.Sprintf("## Recado automático da sala troca-ideIA\n\n"+
		"Chegou mensagem nova na sala (de %s). Protocolo da sala: %s/guide\n\n"+
		"Texto: %s\n\n"+
		"Se for pertinente ao seu trabalho, leia a sala (GET %s/api/messages) e responda. Se não for, ignore.",
		who, roomURL, what, roomURL)

	args := []string{"run"}
	if sessionID != "" {
		args = append(args, "--session", sessionID)
	} else {
		args = append(args, "--continue")
	}
	if agent != "" {
		args = append(args, "--agent", agent)
	}
	// O `opencode run` aceita o recado como argumento posicional, não como
	// flag --prompt (que faz o CLI imprimir o help e sair com erro).
	args = append(args, prompt)

	logf("cutucando: %s (%v)", who, args)
	cmd := exec.Command("opencode", args...)
	cmd.Dir = agentDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		logf("fim cutucada (err=%v): %s", err, tail(out, 200))
		return
	}
	logf("fim cutucada (ok): %s", tail(out, 200))
}

func tail(b []byte, n int) string {
	s := strings.TrimSpace(string(b))
	if len(s) > n {
		s = s[len(s)-n:]
	}
	return s
}

// fetchWatch faz GET na URL e devolve o payload {count, messages}.
func fetchWatch(url string, timeoutSec int) (*watchResp, error) {
	client := &http.Client{Timeout: time.Duration(timeoutSec) * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var payload struct {
		Count int   `json:"count"`
		Msgs  []msg `json:"messages"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return &watchResp{Count: payload.Count, Messages: payload.Msgs}, nil
}

func main() {
	if agentName == "" || agentDir == "" {
		log.Fatalf("defina AGENT_NAME e AGENT_DIR")
	}

	// ponto de partida: continua depois das mensagens já existentes
	var since int
	if resp, err := fetchWatch(roomURL+"/api/messages", 0); err == nil {
		since = resp.Count
	} else {
		logf("warn: não consegui ler histórico inicial: %v", err)
	}

	logf("watcher pronto: sala=%s agente=%s dir=%s desde=%d", roomURL, agentName, agentDir, since)

	var last time.Time
	for {
		resp, err := fetchWatch(fmt.Sprintf("%s/api/watch?since=%d&timeout=25", roomURL, since), 45)
		if err != nil {
			logf("erro de watch: %v", err)
			time.Sleep(3 * time.Second)
			continue
		}
		for _, m := range resp.Messages {
			if m.Name == agentName {
				continue
			}
			isHuman := m.Role == "human"
			mentions := strings.Contains(m.Content, "@"+agentName)
			if isHuman || mentions || (pokeOnAI && m.Role == "ai") {
				what := m.Content
				if len(what) > 400 {
					what = what[:400]
				}
				poke(m.Name, what, &last)
			}
		}
		if resp.Count > 0 {
			since = resp.Count
		}
	}
}
