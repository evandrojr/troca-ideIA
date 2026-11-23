package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// MsgType são os tipos de evento que circulam na sala.
type MsgType string

const (
	TypeMessage MsgType = "message" // mensagem de texto (humano ou IA)
	TypeTyping  MsgType = "typing"  // alguém está digitando
	TypeError   MsgType = "error"   // mensagem de erro do sistema
)

// Message é o pacote JSON trocado entre clientes e a sala.
type Message struct {
	ID      string  `json:"id,omitempty"`
	Type    MsgType `json:"type"`
	Name    string  `json:"name,omitempty"`
	Role    string  `json:"role,omitempty"` // "human" (padrão) | "ai"
	Content string  `json:"content,omitempty"`
	Ts      string  `json:"ts,omitempty"`
}

// Client é uma conexão WebSocket ativa de um participante.
type Client struct {
	room *Room
	conn *websocket.Conn
	send chan Message
	name string
	role string
}

// Room é a sala única: relê mensagens para todos os participantes e guarda o
// histórico. Toda operação que toca o mapa de clientes acontece na goroutine
// do Run, o que evita corridas sem trava no mapa.
type Room struct {
	clients    map[*Client]bool
	register   chan *Client
	unregister chan *Client
	broadcast  chan Message

	watchers map[chan struct{}]struct{}
	watchMu  sync.Mutex

	history []Message
	mu      sync.Mutex
	counter int64

	// lastSeen guarda quando cada nome postou pela última vez (humano ou IA).
	// Permite contar "participantes ativos" mesmo sem WebSocket — agentes
	// HTTP comunicam por POST /api/messages + long-poll /api/watch.
	lastSeen map[string]time.Time

	slug string // identificador URL-safe da sala (ex.: "principal")
	name string // nome de exibição da sala

	ai *AINames // nomes de IA configurados desta sala (configuração por sala)

	// status guarda "no quê" cada participante está trabalhando, informado via
	// POST /api/status. Listado na aba Atividades do frontend.
	status map[string]*Status

	// canon normaliza apelidos de IA para o nome canônico (ex.: "📐 usabilidade-a11y"
	// -> "usabilidade-a11y"), evitando a mesma IA repetida no painel de Atividades.
	// nil = sem normalização.
	canon *NameRegistry

	historyFile string // caminho do arquivo de persistência ("" = sem persistência)
	// maxHistory limita o nº de mensagens mantidas em memória (histórico + snapshot).
	// 0 = ilimitado. Config via HISTORY_MAX=0|500|...
	maxHistory int
}

// Status informa a tarefa atual de um participante e desde quando.
type Status struct {
	Name    string    `json:"name"`
	Task    string    `json:"task"`
	Since   time.Time `json:"-"`
	Updated time.Time `json:"-"`
}

func (s *Status) MarshalJSON() ([]byte, error) {
	type alias struct {
		Name    string `json:"name"`
		Task    string `json:"task"`
		Since   string `json:"since"`
		Minutes int64  `json:"minutes"` // minutos desde o início da tarefa
		Updated string `json:"updated"`
		IdleMin int64  `json:"idle_min"` // minutos desde a última atualização do status
	}
	a := alias{Name: s.Name, Task: s.Task}
	if !s.Since.IsZero() {
		a.Since = s.Since.Format(time.RFC3339)
		a.Minutes = int64(time.Since(s.Since).Minutes())
	}
	if !s.Updated.IsZero() {
		a.Updated = s.Updated.Format(time.RFC3339)
		a.IdleMin = int64(time.Since(s.Updated).Minutes())
	}
	return json.Marshal(a)
}

const activeWindow = 15 * time.Minute // janela de "online" para quem não mantém WS

func NewRoom(slug, name, historyFile string, maxHistory int) *Room {
	if slug == "" {
		slug = "principal"
	}
	if name == "" {
		name = "Principal"
	}
	return &Room{
		slug:        slug,
		name:        name,
		clients:     make(map[*Client]bool),
		register:    make(chan *Client, 16),
		unregister:  make(chan *Client, 16),
		broadcast:   make(chan Message, 512),
		watchers:    make(map[chan struct{}]struct{}),
		lastSeen:    make(map[string]time.Time),
		status:      make(map[string]*Status),
		historyFile: historyFile,
		maxHistory:  maxHistory,
	}
}

// Slug devolve o identificador URL-safe da sala.
func (r *Room) Slug() string { return r.slug }

// Name devolve o nome de exibição da sala.
func (r *Room) Name() string { return r.name }

// AINames devolve a configuração de nomes de IA desta sala.
func (r *Room) AINames() *AINames { return r.ai }

// loadHistory reconstrói o histórico do disco caso HISTORY_FILE esteja definido.
// Chame antes de Run.
func (r *Room) loadHistory() {
	if r.historyFile == "" {
		return
	}
	f, err := os.Open(r.historyFile)
	if err != nil {
		return // arquivo ainda não existe: começa vazio
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var m Message
		if json.Unmarshal([]byte(line), &m) != nil || m.ID == "" {
			continue
		}
		r.history = append(r.history, m)
	}
	r.trimHistory()
	r.setCounterFromHistory()
}

func (r *Room) trimHistory() {
	if r.maxHistory <= 0 || len(r.history) <= r.maxHistory {
		return // 0 = ilimitado
	}
	r.history = r.history[len(r.history)-r.maxHistory:]
}

// setCounterFromHistory faz o próximo id não colidir com os já gravados.
func (r *Room) setCounterFromHistory() {
	for _, m := range r.history {
		if n, err := strconv.ParseInt(strings.TrimPrefix(m.ID, "m"), 10, 64); err == nil && n > r.counter {
			r.counter = n
		}
	}
}

// saveToDisk grava uma mensagem nova em append no arquivo de histórico.
func (r *Room) saveToDisk(m Message) {
	if r.historyFile == "" {
		return
	}
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	f, err := os.OpenFile(r.historyFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	f.Write(append(b, '\n'))
}

// Run é o loop único que processa toda a entrada/saída da sala.
func (r *Room) Run() {
	for {
		select {
		case c := <-r.register:
			r.clients[c] = true
		case c := <-r.unregister:
			if _, ok := r.clients[c]; ok {
				delete(r.clients, c)
				close(c.send)
			}
		case m := <-r.broadcast:
			r.deliver(m)
		}
	}
}

func (r *Room) deliver(m Message) {
	switch m.Type {
	case TypeTyping:
		if m.Name == "" {
			m.Name = "Alguém"
		}
		r.broadcastToAll(m)

	case TypeMessage:
		if strings.TrimSpace(m.Content) == "" {
			return
		}
		if m.ID == "" {
			m.ID = r.nextID()
		}
		if m.Ts == "" {
			m.Ts = now()
		}
		m.Name = cleanName(m.Name)
		if m.Role != "ai" {
			m.Role = "human"
		}
		r.append(m)
		r.broadcastToAll(m)
		r.notifyWatchers()

	default: // TypeError, etc.
		r.broadcastToAll(m)
	}
}

// Post insere uma mensagem vinda de um cliente HTTP (POST /api/messages).
// O trabalho real (histórico + retransmissão) ocorre na goroutine do Run via
// broadcast, mantendo o mapa de clientes livre de corrida. O id é gerado aqui
// para que o remetente HTTP já receba o identificador no ack.
func (r *Room) Post(name, role, content string) Message {
	m := Message{Type: TypeMessage, Name: name, Role: role, Content: content}
	m.ID = r.nextID()
	m.Ts = now()
	m.Name = cleanName(m.Name)
	if m.Role != "ai" {
		m.Role = "human"
	}
	select {
	case r.broadcast <- m:
	default:
	}
	return m
}

func (r *Room) nextID() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.counter++
	return fmt.Sprintf("m%d", r.counter)
}

func (r *Room) append(m Message) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.history) > 0 {
		if last := r.history[len(r.history)-1]; last.ID == m.ID {
			return // já gravado (ex.: ack HTTP e broadcast)
		}
	}
	r.history = append(r.history, m)
	r.lastSeen[m.Name] = time.Now()
	r.trimHistory()
	r.saveToDisk(m)
}

// Snapshot devolve uma cópia do histórico para um novo participante.
func (r *Room) Snapshot() []Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Message, len(r.history))
	copy(out, r.history)
	return out
}

func (r *Room) Count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws := len(r.clients)
	active := 0
	cutoff := time.Now().Add(-activeWindow)
	seen := make(map[string]bool, len(r.clients))
	for c := range r.clients {
		if c.name != "" {
			seen[c.name] = true
		}
	}
	for name, t := range r.lastSeen {
		if !t.Before(cutoff) && !seen[name] {
			active++
		}
	}
	return ws + active
}

func (r *Room) HistoryLen() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.history)
}

// MaxHistory devolve o limite de mensagens retidas (0 = ilimitado).
func (r *Room) MaxHistory() int { return r.maxHistory }

// SetMaxHistory altera o limite de mensagens retidas em tempo de execução.
// n <= 0 libera o teto (ilimitado). O histórico já residente é ajustado.
func (r *Room) SetMaxHistory(n int) {
	if n < 0 {
		n = 0
	}
	r.mu.Lock()
	r.maxHistory = n
	r.trimHistory()
	r.mu.Unlock()
}

// SetNameRegistry define a normalização de nomes (alias -> canônico) usada em
// SetStatus e Statuses. Pode ser chamado antes de primeiro uso; nil desativa.
func (r *Room) SetNameRegistry(reg *NameRegistry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.canon = reg
}

// SetStatus registra/atualiza a tarefa atual de um participante. task vazio
// encerra a tarefa (participante fica sem "atividade corrente").
func (r *Room) SetStatus(name, task string) {
	if cleanName(name) == "Anônimo" {
		return
	}
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.canon != nil {
		name = r.canon.Canonical(name)
	}
	s, ok := r.status[name]
	if !ok {
		s = &Status{Name: name}
		r.status[name] = s
	}
	if task == "" {
		s.Task = ""
		s.Since = time.Time{}
	} else if s.Task != task {
		s.Task = task
		s.Since = now
	}
	s.Updated = now
}

// Statuses devolve uma cópia das tarefas atuais (nome -> status), ordenadas
// por Updated (mais recente primeiro). Apelidos são colapsados no nome canônico
// (mantém o status mais recente entre os sinônimos), para a mesma IA não
// aparecer repetida.
func (r *Room) Statuses() []*Status {
	r.mu.Lock()
	defer r.mu.Unlock()
	byCanon := map[string]*Status{}
	for _, s := range r.status {
		if s.Task == "" {
			continue
		}
		cp := *s
		name := cp.Name
		if r.canon != nil {
			name = r.canon.Canonical(name)
		}
		cp.Name = name
		prev, ok := byCanon[name]
		if ok && prev.Updated.After(cp.Updated) {
			continue
		}
		byCanon[name] = &cp
	}
	out := make([]*Status, 0, len(byCanon))
	for _, s := range byCanon {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Updated.After(out[j].Updated) })
	return out
}

// DistinctAINames devolve nomes distintos de Role=="ai" presentes no histórico,
// na ordem de aparição. Usado para semear a configuração de IAs na 1ª execução.
func (r *Room) DistinctAINames() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []string{}
	seen := map[string]bool{}
	for _, m := range r.history {
		if m.Role == "ai" && m.Name != "" && !seen[m.Name] {
			seen[m.Name] = true
			out = append(out, m.Name)
		}
	}
	return out
}

// Watch devolve as mensagens com índice >= sinceIdx, bloqueando até timeout
// segundos. ok=false significa timeout sem novidades (o cliente deve reler com
// o count retornado como novo since).
func (r *Room) Watch(sinceIdx, timeoutSec int) (msgs []Message, count int, ok bool) {
	notify := make(chan struct{}, 1)
	r.watchMu.Lock()
	if len(r.watchers) < 256 {
		r.watchers[notify] = struct{}{}
	}
	r.watchMu.Unlock()
	defer func() {
		r.watchMu.Lock()
		delete(r.watchers, notify)
		r.watchMu.Unlock()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	for {
		r.mu.Lock()
		start := sinceIdx
		if start < 0 {
			start = 0
		}
		if start > len(r.history) {
			start = len(r.history)
		}
		if start < len(r.history) {
			out := make([]Message, len(r.history)-start)
			copy(out, r.history[start:])
			n := len(r.history)
			r.mu.Unlock()
			return out, n, true
		}
		r.mu.Unlock()
		select {
		case <-notify:
			// nova mensagem chegou
		case <-ctx.Done():
			return nil, r.HistoryLen(), false
		}
	}
}

func (r *Room) notifyWatchers() {
	r.watchMu.Lock()
	defer r.watchMu.Unlock()
	for w := range r.watchers {
		select {
		case w <- struct{}{}:
		default:
		}
	}
}

func (r *Room) broadcastToAll(m Message) {
	for c := range r.clients {
		select {
		case c.send <- m:
		default:
			// participante lento: descarta para não travar a sala
		}
	}
}

func cleanName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "Anônimo"
	}
	if len(name) > 32 {
		return name[:32]
	}
	return name
}

// --- WebSocket ---

func (c *Client) readPump() {
	defer func() {
		c.room.unregister <- c
		_ = c.conn.Close()
	}()

	c.conn.SetReadLimit(65536)
	_ = c.conn.SetReadDeadline(time.Now().Add(70 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(70 * time.Second))
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		var m Message
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		m.Name = cleanName(m.Name)
		select {
		case c.room.broadcast <- m:
		default:
		}
	}
}

func (c *Client) writePump() {
	defer func() { _ = c.conn.Close() }()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case m, ok := <-c.send:
			if !ok {
				return
			}
			if err := c.conn.WriteJSON(m); err != nil {
				return
			}
		case <-ticker.C:
			// ping mantém o readPump do cliente e o nosso read deadline vivos;
			// sem isso, um WS mudo é derrubado após 70s (SetReadDeadline).
			if err := c.conn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(time.Second)); err != nil {
				return
			}
		}
	}
}

func now() string { return time.Now().Format(time.RFC3339) }
