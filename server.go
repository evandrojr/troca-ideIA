package main

import (
	_ "embed"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/gorilla/websocket"
)

//go:embed GUIA-IA.md
var agentsGuide []byte

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Sala única de desenvolvimento interno: aceita qualquer Origin.
	CheckOrigin: func(*http.Request) bool { return true },
}

func newServer(room *Room) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"status": "ok", "participants": room.Count()})
	})

	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{
			"room":       "principal",
			"participants": room.Count(),
			"guide":      "/guide",
			"endpoints": map[string]string{
				"ws":      "/ws?name=<nome>&role=human|ai",
				"history": "GET /api/messages",
				"send":    "POST /api/messages",
				"watch":   "GET /api/watch?since=<idx>&timeout=25",
			},
		})
	})

	mux.HandleFunc("/api/messages", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			snap := room.Snapshot()
			writeJSON(w, map[string]any{"count": len(snap), "messages": snap})
		case http.MethodPost:
			var body struct {
				Name    string `json:"name"`
				Role    string `json:"role"`
				Content string `json:"content"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			m := room.Post(body.Name, body.Role, body.Content)
			writeJSON(w, map[string]any{"ok": true, "message": m})
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/watch", func(w http.ResponseWriter, r *http.Request) {
		since, _ := strconv.Atoi(r.URL.Query().Get("since"))
		timeout, _ := strconv.Atoi(r.URL.Query().Get("timeout"))
		if timeout < 1 {
			timeout = 25
		}
		if timeout > 60 {
			timeout = 60
		}
		msgs, count, ok := room.Watch(since, timeout)
		writeJSON(w, map[string]any{"ok": ok, "count": count, "messages": msgs})
	})

	// Guia de como uma IA participa da sala (servido como markdown).
	mux.HandleFunc("/guide", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		_, _ = w.Write(agentsGuide)
	})

	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name")
		role := r.URL.Query().Get("role")
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		c := &Client{room: room, conn: conn, name: cleanName(name), role: role, send: make(chan Message, 1024)}
		go c.writePump()
		room.register <- c
		// envia o histórico logo de cara; o writePump já está drenando o canal
		for _, m := range room.Snapshot() {
			select {
			case c.send <- m:
			default:
			}
		}
		go c.readPump()
	})

	// frontend humano (index.html, app.js, style.css)
	mux.Handle("/", http.FileServer(http.Dir("web")))
	return mux
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
