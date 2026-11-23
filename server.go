package main

import (
	_ "embed"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gorilla/websocket"
)

//go:embed GUIA-IA.md
var agentsGuide []byte

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Sala de desenvolvimento interno: aceita qualquer Origin.
	CheckOrigin: func(*http.Request) bool { return true },
}

func newServer(rooms *RoomManager) http.Handler {
	mux := http.NewServeMux()

	// roomOf resolve a sala alvo pela query param ?room=<slug>. Sem param, usa a
	// sala "principal". Salas desconhecidas são criadas sob demanda.
	roomOf := func(r *http.Request) *Room {
		slug := r.URL.Query().Get("room")
		return rooms.Get(slug)
	}

	mux.HandleFunc("/api/rooms", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, map[string]any{"rooms": rooms.Names()})
		case http.MethodPost:
			var body struct {
				Name string `json:"name"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			name := strings.TrimSpace(body.Name)
			if name == "" {
				http.Error(w, "nome da sala obrigatório", http.StatusBadRequest)
				return
			}
			room := rooms.Create(name)
			writeJSON(w, map[string]any{
				"ok":   true,
				"slug": room.Slug(),
				"name": room.Name(),
			})
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		room := roomOf(r)
		writeJSON(w, map[string]any{
			"status":       "ok",
			"room":         room.Slug(),
			"participants": room.Count(),
		})
	})

	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		room := roomOf(r)
		writeJSON(w, map[string]any{
			"room":         room.Slug(),
			"room_name":    room.Name(),
			"rooms":        rooms.Names(),
			"participants": room.Count(),
			"guide":        "/guide",
			"ia_names":     room.AINames().Names(),
			"history_max":  room.MaxHistory(), // 0 = ilimitado
			"endpoints": map[string]string{
				"rooms":   "GET/POST /api/rooms",
				"ws":      "/ws?room=<sala>&name=<nome>&role=human|ai",
				"history": "GET /api/messages?room=<sala>",
				"send":    "POST /api/messages?room=<sala>",
				"watch":   "GET /api/watch?room=<sala>&since=<idx>&timeout=25",
			},
		})
	})

	mux.HandleFunc("/api/ia-names", func(w http.ResponseWriter, r *http.Request) {
		room := roomOf(r)
		ai := room.AINames()
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, map[string]any{"names": ai.Names()})
		case http.MethodPost:
			var body struct {
				Names []string `json:"names"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if err := ai.Set(body.Names); err != nil {
				http.Error(w, "falha ao salvar", http.StatusInternalServerError)
				return
			}
			writeJSON(w, map[string]any{"ok": true, "names": ai.Names()})
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/messages", func(w http.ResponseWriter, r *http.Request) {
		room := roomOf(r)
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
		room := roomOf(r)
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
		room := roomOf(r)
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

	// Sala na URL: /sala/<slug> serve a interface web; o frontend lê o slug e
	// se conecta naquela sala. Sala desconhecida é criada sob demanda no /ws.
	mux.HandleFunc("/sala/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join("web", "index.html"))
	})

	// frontend humano (index.html, app.js, style.css)
	mux.Handle("/", http.FileServer(http.Dir("web")))
	return mux
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
