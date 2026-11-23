// Comando poke: watcher multi-agente da sala troca-ideIA.
//
// Faz long-poll em /api/watch e, quando chega mensagem nova, entrega o recado
// na sessão/open-code do agente CORRETO (resolvido por menção @nome ou pelo
// nome do remetente), rodando:
//
//	opencode run [--session <id>] "recado"
//
// em AGENT_DIR de cada agente. Um único processo vigia a sala e despacha para
// todos os agentes cadastrados — sem shell por agente.
//
// Configuração (JSON, arquivo passado em -config; padrão "agents.json"):
//
//	[
//	  {"Name":"assinador-icp-brasil","Dir":"/home/j/lab/assinador-icp-brasil","SessionID":"...opcional"},
//	  {"Name":"Troca-IdeIA","Dir":"/home/j/lab/troca-ideIA","PokeOnAI":true,"MinGapSec":180,
//	   "StatusIdleMin":20,"StatusCheckSec":120}
//	]
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	roomURL = getenv("ROOM_URL", "http://127.0.0.1:7676")
	// respected only when -config empty and AGENT_NAME/AGENT_DIR provided
	legacyName   = getenv("AGENT_NAME", "")
	legacyDir    = getenv("AGENT_DIR", "")
	legacySess   = getenv("SESSION_ID", "")
	legacyAI     = getenv("POKE_ON_AI", "") == "1"
	legacyMinGap = atoi(getenv("POKE_MIN_GAP", "45"), 45)
	legacyIdle   = atoi(getenv("POKE_STATUS_IDLE_MIN", "0"), 0)
	legacyIdleCh = atoi(getenv("POKE_STATUS_CHECK_SECS", "120"), 120)

	// limite de duração de uma cutucada (evita travar o watcher para sempre)
	runTimeout = time.Duration(atoi(getenv("POKE_RUN_TIMEOUT_MIN", "25"), 25)) * time.Minute
)

type agent struct {
	Name          string   `json:"Name"`
	Dir           string   `json:"Dir"`
	SessionID     string   `json:"SessionID,omitempty"`
	Agent         string   `json:"OpenCodeAgent,omitempty"`
	Aliases       []string `json:"Aliases,omitempty"` // nomes/menções alternativos (ex.: "UI"→ui-assinador)
	PokeOnAI      bool     `json:"PokeOnAI,omitempty"`
	MinGapSec     int      `json:"MinGapSec,omitempty"`
	StatusIdleMin int      `json:"StatusIdleMin,omitempty"`
	StatusCheck   int      `json:"StatusCheckSec,omitempty"`

	last     time.Time
	lastMu   sync.Mutex
	lastSwe  time.Time
}

// hits reporta se a mensagem menciona o agente (por nome ou alias) ou é do
// autor dele (para não receber o próprio eco).
func (a *agent) hits(m msg) (mention, from bool) {
	if m.Name == a.Name {
		return false, true
	}
	for _, al := range a.Aliases {
		if m.Name == al {
			return false, true
		}
	}
	for _, n := range append([]string{a.Name}, a.Aliases...) {
		if strings.Contains(m.Content, "@"+n) {
			return true, false
		}
	}
	return false, false
}

type msg struct {
	Name    string `json:"name"`
	Role    string `json:"role"`
	Content string `json:"content"`
}

type watchResp struct {
	Count    int   `json:"count"`
	Messages []msg `json:"messages"`
}

type statusEntry struct {
	Name    string `json:"name"`
	Task    string `json:"task"`
	IdleMin int64  `json:"idle_min"`
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

func minGap(a *agent) time.Duration {
	if a.MinGapSec > 0 {
		return time.Duration(a.MinGapSec) * time.Second
	}
	return time.Duration(legacyMinGap) * time.Second
}

func statusIdleMin(a *agent) int {
	if a.StatusIdleMin > 0 {
		return a.StatusIdleMin
	}
	return legacyIdle
}

func statusCheck(a *agent) time.Duration {
	if a.StatusCheck > 0 {
		return time.Duration(a.StatusCheck) * time.Second
	}
	return time.Duration(legacyIdleCh) * time.Second
}

// loadAgents monta a lista de agentes vigiados a partir da config JSON; se
// ausente e AGENT_NAME/AGENT_DIR existirem, monta o agente único legado.
func loadAgents(cfgPath string) ([]*agent, error) {
	if cfgPath != "" {
		b, err := os.ReadFile(cfgPath)
		if err != nil {
			return nil, err
		}
		var as []*agent
		if err := json.Unmarshal(b, &as); err != nil {
			return nil, fmt.Errorf("config %s: %w", cfgPath, err)
		}
		var out []*agent
		for i := range as {
			if as[i].Name == "" || as[i].Dir == "" {
				return nil, fmt.Errorf("config %s: Name e Dir obrigatórios", cfgPath)
			}
			out = append(out, as[i])
		}
		if len(out) == 0 {
			return nil, fmt.Errorf("config %s: nenhum agente", cfgPath)
		}
		return out, nil
	}
	if legacyName != "" && legacyDir != "" {
		return []*agent{{
			Name: legacyName, Dir: legacyDir, SessionID: legacySess, PokeOnAI: legacyAI,
			StatusIdleMin: legacyIdle, StatusCheck: legacyIdleCh,
		}}, nil
	}
	return nil, fmt.Errorf("defina AGENT_NAME/AGENT_DIR ou passe -config")
}

// dispatch decide se uma mensagem é do interesse de um agente e, se sim,
// injeta o recado na sessão dele (serializado por agente via runMu).
// Não-orquestradores só acordam com menção @seu-nome; o orquestrador
// (PokeOnAI) acorda com qualquer mensagem para poder redistribuir tarefas.
func dispatch(as []*agent, m msg) {
	for _, a := range as {
		_, from := a.hits(m)
		if from {
			continue // não reenvia pro próprio autor
		}
		mention, _ := a.hits(m)
		overseer := a.PokeOnAI
		if mention || (overseer && (m.Role == "human" || m.Role == "ai")) {
			what := m.Content
			if len(what) > 400 {
				what = what[:400]
			}
			go poke(a, m.Name, what)
		}
	}
}

// poke injeta o recado na sessão do agente, respeitando o cooldown por agente.
func poke(a *agent, who, what string) bool {
	a.lastMu.Lock()
	defer a.lastMu.Unlock()
	now := time.Now()
	if !a.last.IsZero() && now.Sub(a.last) < minGap(a) {
		logf("skip (cooldown %s): %s", a.Name, who)
		return false
	}
	a.last = now

	prompt := fmt.Sprintf("## Recado automático da sala troca-ideIA\n\n"+
		"Chegou mensagem nova na sala (de %s). Protocolo da sala: %s/guide\n\n"+
		"Texto: %s\n\n"+
		"Se for pertinente ao seu trabalho, leia a sala (GET %s/api/messages) e responda. "+
		"Se a mensagem for uma CUTUCADA para você (conteúdo com \"cutucada\"), confirme "+
		"no seu status (POST %s/api/status com task atual) que recebeu.", who, roomURL, what, roomURL, roomURL)

	args := []string{"run"}
	if a.SessionID != "" {
		args = append(args, "--session", a.SessionID)
	} else {
		args = append(args, "--continue")
	}
	if a.Agent != "" {
		args = append(args, "--agent", a.Agent)
	}
	args = append(args, prompt)

	logf("cutucando %s (de %s): %v", a.Name, who, args)
	cmd := exec.Command("opencode", args...)
	cmd.Dir = a.Dir
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		logf("fim cutucada %s (err=%v)", a.Name, err)
		return false
	}
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			logf("fim cutucada %s (err=%v)", a.Name, err)
			return false
		}
		logf("fim cutucada %s (ok)", a.Name)
		return true
	case <-time.After(runTimeout):
		_ = cmd.Process.Kill()
		logf("fim cutucada %s (timeout %v)", a.Name, runTimeout)
		return false
	}
}

// sweepStale avisa o orquestrador quando alguém fica muito tempo com a mesma
// atividade informada (idle), para ele redistribuir/cutucar. Retorna true se acordou.
func sweepStale(a *agent) bool {
	if statusIdleMin(a) <= 0 {
		return false
	}
	resp, err := http.Get(roomURL + "/api/status")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var p struct {
		Statuses []statusEntry `json:"statuses"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&p); err != nil {
		return false
	}
	var stale []string
	for _, e := range p.Statuses {
		if e.Name == a.Name || e.Task == "" {
			continue
		}
		if e.IdleMin < int64(statusIdleMin(a)) {
			continue
		}
		task := e.Task
		if len(task) > 200 {
			task = task[:200]
		}
		stale = append(stale, fmt.Sprintf("%s (parado há %d min: %s)", e.Name, e.IdleMin, task))
	}
	if len(stale) == 0 {
		return false
	}
	what := fmt.Sprintf(
		"## Varredura de status da sala troca-ideIA\n\n"+
			"Estes participantes estão com a atividade informada SEM atualizar o status há mais de %d min:\n\n- %s\n\n"+
			"Leia a sala e os status (GET %s/api/status). Se algum ainda tiver tarefa pendente, cutuque-o "+
			"(`cd <repo> && opencode run -c \"<recado>\"`). Se concluiu/parou, peça para limpar o status. "+
			"Viável para distribuir nova tarefa.",
		statusIdleMin(a), strings.Join(stale, "\n- "), roomURL)
	return poke(a, "sweep-status", what)
}

func logf(format string, a ...any) {
	log.Printf(format, a...)
}

// fetchWatch faz GET na URL e devolve o payload {count, messages}.
func fetchWatch(url string, timeoutSec int) (*watchResp, error) {
	client := &http.Client{Timeout: time.Duration(timeoutSec) * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var p struct {
		Count int   `json:"count"`
		Msgs  []msg `json:"messages"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&p); err != nil {
		return nil, err
	}
	return &watchResp{Count: p.Count, Messages: p.Msgs}, nil
}

func main() {
	var cfgPath string
	for i, arg := range os.Args[1:] {
		if (arg == "-config" || arg == "--config") && i+1 < len(os.Args)-1 {
			cfgPath = os.Args[i+2]
			break
		}
	}
	if cfgPath == "" {
		if _, err := os.Stat("agents.json"); err == nil {
			cfgPath = "agents.json"
		}
	}
	if cfgPath != "" {
		if abs, err := filepath.Abs(cfgPath); err == nil {
			cfgPath = abs
		}
	}
	as, err := loadAgents(cfgPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	names := make([]string, 0, len(as))
	for _, a := range as {
		names = append(names, a.Name)
	}
	logf("watcher pronto: sala=%s agentes=%s", roomURL, strings.Join(names, ", "))

	// ponto de partida: continua depois das mensagens já existentes
	var since int
	if resp, err := fetchWatch(roomURL+"/api/messages", 0); err == nil {
		since = resp.Count
	} else {
		logf("warn: não consegui ler histórico inicial: %v", err)
	}

	for {
		resp, err := fetchWatch(fmt.Sprintf("%s/api/watch?since=%d&timeout=30", roomURL, since), 45)
		if err != nil {
			logf("erro de watch: %v", err)
			time.Sleep(3 * time.Second)
			continue
		}
		for _, m := range resp.Messages {
			dispatch(as, m)
		}
		if resp.Count > 0 {
			since = resp.Count
		}
		// varredura periódica de status parado (só em quem configurou)
		now := time.Now()
		for _, a := range as {
			if statusIdleMin(a) > 0 && now.Sub(a.lastSwe) >= statusCheck(a) {
				a.lastSwe = now
				go sweepStale(a)
			}
		}
	}
}
