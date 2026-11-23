package main

import (
	"encoding/json"
	"os"
	"strings"
	"sync"
)

// roomDef é a definição persistida de uma sala no arquivo rooms.json.
type roomDef struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

// RoomManager gerencia N salas simultâneas. Cada sala tem histórico e lista de
// IAs próprios. Salas são criadas sob demanda (POST /api/rooms) e a lista é
// persistida em ROOMS_FILE para sobreviver a restart.
type RoomManager struct {
	mu         sync.RWMutex
	file       string       // caminho do arquivo rooms.json ("" = sem persistência)
	rooms      map[string]*Room
	order      []string     // slugs na ordem de criação (para a GUI)
	maxHistory int
}

// NewRoomManager cria o gerente com o arquivo de salas e o limite de histórico.
func NewRoomManager(file string) *RoomManager {
	return &RoomManager{
		file:       file,
		rooms:      make(map[string]*Room),
		maxHistory: getEnvInt("HISTORY_MAX", 500),
	}
}

// storeDetach desacopla o armazenamento de histórico e IAs do número de salas.
// A sala "principal" mantém os arquivos legados (history.jsonl / ia-names.json).
func historyFileFor(slug string) string {
	if slug == "principal" {
		return getEnv("HISTORY_FILE", "history.jsonl")
	}
	return "history-" + slug + ".jsonl"
}

func aiNamesFileFor(slug string) string {
	if slug == "principal" {
		return getEnv("IA_NAMES_FILE", "ia-names.json")
	}
	return "ia-names-" + slug + ".json"
}

// Load lê o arquivo de salas. Se não existir, cria a sala "principal" como
// padrão. Salas já existentes são instanciadas e iniciadas.
func (m *RoomManager) Load() {
	m.mu.Lock()
	defer m.mu.Unlock()

	defs := []roomDef{{Slug: "principal", Name: "Principal"}}
	if b, err := os.ReadFile(m.file); err == nil {
		if json.Unmarshal(b, &defs) == nil && len(defs) > 0 {
			// ok, usamos a lista persistida
		}
	}
	for _, d := range defs {
		m.getLocked(d.Slug, d.Name)
	}
	if len(m.order) > 0 {
		m.saveLocked()
	}
}

// Get devolve (criando se preciso) a sala com o slug dado. Criação sob demanda
// permite que uma IA conecte em uma sala nova pela URL (?room=<slug>).
func (m *RoomManager) Get(slug string) *Room {
	if slug == "" {
		slug = "principal"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.getLocked(slug, slug)
}

// Create cria (ou devolve a existente) uma sala com nome de exibição. O slug é
// derivado do nome.
func (m *RoomManager) Create(name string) *Room {
	slug := slugify(name)
	if slug == "" {
		slug = "principal"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.getLocked(slug, name)
}

// getLocked instancia a sala caso não exista e garante que o loop Run está ativo.
func (m *RoomManager) getLocked(slug, name string) *Room {
	if r, ok := m.rooms[slug]; ok {
		if name != "" && name != slug && r.name == slug {
			r.name = name
			m.saveLocked()
		}
		return r
	}

	ai := NewAINames(aiNamesFileFor(slug))
	ai.Load()

	r := NewRoom(slug, name, historyFileFor(slug), m.maxHistory)
	r.ai = ai
	r.loadHistory()

	if len(ai.Names()) == 0 {
		// primeira execução: aproveita os nomes de IA que já aparecem no histórico
		if err := ai.Seed(r.DistinctAINames()); err != nil {
			// sem log aqui: silencioso como antes
		}
	}

	m.rooms[slug] = r
	m.order = append(m.order, slug)
	go r.Run()
	m.saveLocked()
	return r
}

// Names devolve a lista de salas (slug, nome, participantes) na ordem de criação.
func (m *RoomManager) Names() []map[string]any {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]map[string]any, 0, len(m.order))
	for _, slug := range m.order {
		r := m.rooms[slug]
		out = append(out, map[string]any{
			"slug":         slug,
			"name":         r.name,
			"participants": r.Count(),
		})
	}
	return out
}

// saveLocked grava a lista de salas no disco.
func (m *RoomManager) saveLocked() {
	if m.file == "" {
		return
	}
	defs := make([]roomDef, 0, len(m.order))
	for _, slug := range m.order {
		r := m.rooms[slug]
		defs = append(defs, roomDef{Slug: slug, Name: r.name})
	}
	b, err := json.MarshalIndent(defs, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(m.file, b, 0o644)
}

// slugify converte um nome de sala em um slug URL-safe: minúsculas, sem
// acentos, sem espaços nem caracteres especiais.
func slugify(name string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(name) {
		ok := r == '-' || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if ok {
			if r == '-' && prevDash {
				continue
			}
			b.WriteRune(r)
			prevDash = r == '-'
		} else {
			if b.Len() > 0 && !prevDash {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return strings.ToLower(name)
	}
	if len(out) > 32 {
		out = out[:32]
		out = strings.TrimRight(out, "-")
	}
	return out
}
