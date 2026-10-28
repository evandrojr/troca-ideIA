package main

import (
	"context"
	"encoding/json"
	"fmt"
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
}

func NewRoom() *Room {
	return &Room{
		clients:    make(map[*Client]bool),
		register:   make(chan *Client, 16),
		unregister: make(chan *Client, 16),
		broadcast:  make(chan Message, 512),
		watchers:   make(map[chan struct{}]struct{}),
	}
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
	if len(r.history) >= 500 {
		r.history = r.history[len(r.history)-500:]
	}
	r.history = append(r.history, m)
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
	return len(r.clients)
}

func (r *Room) HistoryLen() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.history)
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
	for m := range c.send {
		if err := c.conn.WriteJSON(m); err != nil {
			return
		}
	}
}

func now() string { return time.Now().Format(time.RFC3339) }
