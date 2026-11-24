// Command herdr is the bridge between the troca-ideIA room and hc terminals.
//
// It long-polls GET /api/watch and pastes new room events into the hc terminal
// of the agent they are meant for (hc send <terminal> <texto>). Agents publish
// their own speech to the room with `troca-say`/`troca-ask`, so pasting here
// never feeds the room back automatically — no echo loops.
//
// The bridge is optional: the web room works without it. It exists so IAs that
// live in Herdr terminals can see human messages, questions and answers.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Agent mirrors the entries of agents.json (shared with cmd/poke).
type Agent struct {
	Name          string   `json:"Name"`
	Dir           string   `json:"Dir,omitempty"`
	SessionID     string   `json:"SessionID,omitempty"`
	Agent         string   `json:"OpenCodeAgent,omitempty"`
	Aliases       []string `json:"Aliases,omitempty"`
	Terminal      string   `json:"Terminal,omitempty"`
	PokeOnAI      bool     `json:"PokeOnAI,omitempty"`
	MinGapSec     int      `json:"MinGapSec,omitempty"`
	StatusIdleMin int      `json:"StatusIdleMin,omitempty"`
	StatusCheck   int      `json:"StatusCheckSec,omitempty"`
}

// Message, QuestionOption and Question mirror room.go's wire format.
type Message struct {
	ID       string    `json:"id,omitempty"`
	Type     string    `json:"type"`
	Name     string    `json:"name,omitempty"`
	Role     string    `json:"role,omitempty"`
	Content  string    `json:"content,omitempty"`
	Ts       string    `json:"ts,omitempty"`
	Question *Question `json:"question,omitempty"`
}

type QuestionOption struct {
	Label string `json:"label"`
	Value string `json:"value,omitempty"`
}

type Question struct {
	ID        string           `json:"id,omitempty"`
	Target    string           `json:"target,omitempty"`
	Prompt    string           `json:"prompt,omitempty"`
	Options   []QuestionOption `json:"options,omitempty"`
	Multiple  bool             `json:"multiple,omitempty"`
	AllowText bool             `json:"allow_text,omitempty"`
	Answer    *Answer          `json:"answer,omitempty"`
}

type Answer struct {
	QuestionID string `json:"question_id"`
	Value      string `json:"value,omitempty"`
	Label      string `json:"label,omitempty"`
	Text       string `json:"text,omitempty"`
}

type WatchResponse struct {
	OK       bool      `json:"ok"`
	Count    int       `json:"count"`
	Messages []Message `json:"messages"`
}

type Client struct {
	base   string
	room   string
	client *http.Client
}

func main() {
	addr := flag.String("addr", "http://127.0.0.1:7676", "URL base da sala troca-ideIA")
	room := flag.String("room", "principal", "slug da sala a acompanhar")
	agentsPath := flag.String("agents", "agents.json", "caminho para agents.json")
	timeout := flag.Int("timeout", 25, "segundos de long-poll (1-60)")
	replay := flag.Bool("replay", false, "reprocessar histórico existente (padrão: só novidades)")
	flag.Parse()

	if *timeout < 1 || *timeout > 60 {
		log.Fatal("-timeout deve ficar entre 1 e 60")
	}
	agents, err := loadAgents(*agentsPath)
	if err != nil {
		log.Fatalf("carregar agents.json: %v", err)
	}
	c := &Client{
		base:   strings.TrimRight(*addr, "/"),
		room:   *room,
		client: &http.Client{Timeout: time.Duration(*timeout+5) * time.Second},
	}
	since := 0
	if !*replay {
		since, err = c.historyLen()
		if err != nil {
			log.Fatalf("consultar histórico: %v", err)
		}
	}
	log.Printf("bridge Herdr: sala=%s desde=%d agentes=%d", *room, since, len(agents))
	for {
		resp, err := c.watch(since, *timeout)
		if err != nil {
			log.Printf("watch: %v (nova tentativa em 2s)", err)
			time.Sleep(2 * time.Second)
			continue
		}
		for _, m := range resp.Messages {
			deliver(agents, m)
		}
		since = resp.Count
	}
}

// historyLen devolve o tamanho atual do histórico, para começar sem repetir
// mensagens antigas quando o bridge é iniciado.
func (c *Client) historyLen() (int, error) {
	resp, err := c.client.Get(c.base + "/api/messages?room=" + url.QueryEscape(c.room))
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return 0, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var out struct {
		Count int `json:"count"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, err
	}
	return out.Count, nil
}

func (c *Client) watch(since, timeout int) (WatchResponse, error) {
	var out WatchResponse
	u := fmt.Sprintf("%s/api/watch?room=%s&since=%d&timeout=%d",
		c.base, url.QueryEscape(c.room), since, timeout)
	resp, err := c.client.Get(u)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return out, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return out, err
	}
	return out, nil
}

// deliver envia um recado da sala para o(s) terminal(is) hc destinatário(s).
func deliver(agents []Agent, m Message) {
	text := format(m)
	if text == "" {
		return
	}
	for _, terminal := range targets(agents, m) {
		if err := hc("send", terminal, text); err != nil {
			log.Printf("hc send %s: %v", terminal, err)
		}
	}
}

// targets escolhe os terminais que devem ver a mensagem.
//   - respostas e perguntas com target explícito vão para o agente citado;
//   - mensagens de IAs vão para todas as outras IAs (assim elas conversam);
//   - mensagens do humano sem target vão para todas as IAs.
func targets(agents []Agent, m Message) []string {
	target := ""
	if m.Question != nil {
		target = m.Question.Target
	}
	var out []string
	add := func(a Agent) {
		if a.Terminal == "" {
			return
		}
		for _, t := range out {
			if t == a.Terminal {
				return
			}
		}
		out = append(out, a.Terminal)
	}
	if target != "" {
		for _, a := range agents {
			if sameAgent(a, target) {
				add(a)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	for _, a := range agents {
		if a.Terminal == "" || a.Terminal == "troca-ideIA" {
			continue
		}
		if m.Role == "ai" && (sameAgent(a, m.Name) || sameTerminal(a, m.Name)) {
			continue // não devolve a fala para quem a escreveu
		}
		add(a)
	}
	return out
}

func sameAgent(a Agent, name string) bool {
	if name == "" {
		return false
	}
	name = strings.ToLower(strings.TrimSpace(name))
	if strings.ToLower(a.Name) == name || strings.ToLower(a.Terminal) == name {
		return true
	}
	for _, alias := range a.Aliases {
		if strings.ToLower(strings.TrimSpace(alias)) == name {
			return true
		}
	}
	return false
}

func sameTerminal(a Agent, name string) bool {
	return a.Terminal != "" && strings.EqualFold(a.Terminal, strings.TrimSpace(name))
}

func format(m Message) string {
	name := strings.TrimSpace(m.Name)
	if name == "" {
		name = "alguém"
	}
	switch m.Type {
	case "question":
		lines := []string{fmt.Sprintf("[troca-ideIA] %s perguntou:\n%s", name, m.Content)}
		if m.Question != nil && len(m.Question.Options) > 0 {
			opts := make([]string, 0, len(m.Question.Options))
			for _, o := range m.Question.Options {
				label := o.Label
				if label == "" {
					label = o.Value
				}
				opts = append(opts, "  - "+label)
			}
			lines = append(lines, "Opções:\n"+strings.Join(opts, "\n"))
			if m.Question.AllowText {
				lines = append(lines, "  - (resposta livre)")
			}
		}
		return strings.Join(lines, "\n")
	case "answer":
		if m.Question != nil && m.Question.Answer != nil {
			return fmt.Sprintf("[troca-ideIA] %s respondeu à pergunta %s:\n%s",
				name, shortID(m.Question.Answer.QuestionID), m.Content)
		}
		return fmt.Sprintf("[troca-ideIA] %s respondeu:\n%s", name, m.Content)
	case "message", "":
		return fmt.Sprintf("[troca-ideIA/%s] %s", name, strings.TrimSpace(m.Content))
	default:
		return ""
	}
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func loadAgents(path string) ([]Agent, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var agents []Agent
	if err := json.Unmarshal(b, &agents); err != nil {
		return nil, err
	}
	return agents, nil
}

func hc(args ...string) error {
	bin, err := findHC()
	if err != nil {
		return err
	}
	cmd := exec.Command(bin, args...)
	combined, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(combined)))
	}
	return nil
}

func findHC() (string, error) {
	if p, err := exec.LookPath("hc"); err == nil {
		return p, nil
	}
	home, _ := os.UserHomeDir()
	for _, p := range []string{
		filepath.Join(home, ".local", "bin", "hc"),
		filepath.Join(home, "go", "bin", "hc"),
		"/usr/local/bin/hc",
	} {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("hc não encontrado no PATH")
}
