package main

import (
	"encoding/json"
	"os"
	"sync"
)

// AgentFile é o formato do agents.json usado pelo watcher (cmd/poke): cada
// entrada tem o Name canônico e as Aliases pelas quais aparece na sala (ex.:
// "usabilidade-a11y" também posta como "📐 usabilidade-a11y"). O servidor usa o
// mesmo arquivo para colapsar o painel de Atividades: cada IA passa a ter um
// único nome, mesmo que poste status/mensagens com escritas diferentes.
type AgentFile struct {
	Name    string   `json:"Name"`
	Aliases []string `json:"Aliases"`
}

// NameRegistry mapeia cada apelido de participante para um nome canônico.
type NameRegistry struct {
	mu      sync.RWMutex
	file    string
	aliasTo map[string]string // alias -> canônico
}

func NewNameRegistry(file string) *NameRegistry {
	return &NameRegistry{
		file:    file,
		aliasTo: map[string]string{},
	}
}

// Load lê o agents.json (array de AgentFile) e constrói alias -> canônico.
// Também registra o próprio Name canônico (apelido de si mesmo, sem efeito).
func (r *NameRegistry) Load() {
	b, err := os.ReadFile(r.file)
	if err != nil {
		return
	}
	var list []AgentFile
	if json.Unmarshal(b, &list) != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, ag := range list {
		canon := cleanName(ag.Name)
		if canon == "" || canon == "Anônimo" {
			continue
		}
		for _, a := range ag.Aliases {
			a = cleanName(a)
			if a == "" || a == "Anônimo" {
				continue
			}
			r.aliasTo[a] = canon
		}
	}
}

// Canonical devolve o nome canônico se name for apelido registrado; senão o
// próprio name (já limpo). Alias de si mesmo (Name==alias) resolve para si.
func (r *NameRegistry) Canonical(name string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	name = cleanName(name)
	if c, ok := r.aliasTo[name]; ok {
		return c
	}
	return name
}
