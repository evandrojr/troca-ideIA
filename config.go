package main

import (
	"encoding/json"
	"os"
	"sort"
	"sync"
)

// AINames é a lista configurada de nomes das IAs da sala, persistida em disco
// (JSON) para sobreviver a restart. O frontend usa para autocomplete e destaque
// de @menção, e o operador pode editar pelo painel de configuração.
type AINames struct {
	mu    sync.Mutex
	file  string
	names []string
}

func NewAINames(file string) *AINames {
	return &AINames{file: file}
}

// Load lê o arquivo do disco. Se não existir (primeira execução), mantém vazio.
func (a *AINames) Load() {
	a.mu.Lock()
	defer a.mu.Unlock()
	b, err := os.ReadFile(a.file)
	if err != nil {
		return
	}
	var c struct {
		Names []string `json:"names"`
	}
	if json.Unmarshal(b, &c) == nil && len(c.Names) > 0 {
		a.names = cleanNamesList(c.Names)
	}
}

// Seed preenche a lista com nomes sugeridos, mas só grava no disco se o arquivo
// ainda não existir (evita sobrescrever edições manuais).
func (a *AINames) Seed(suggested []string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, err := os.Stat(a.file); err == nil {
		return nil
	}
	a.names = cleanNamesList(suggested)
	sort.Strings(a.names)
	b, _ := json.Marshal(map[string][]string{"names": a.names})
	return os.WriteFile(a.file, b, 0o644)
}

// Names devolve uma cópia da lista atual.
func (a *AINames) Names() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, len(a.names))
	copy(out, a.names)
	return out
}

// Set substitui a lista inteira e grava no disco.
func (a *AINames) Set(names []string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.names = cleanNamesList(names)
	sort.Strings(a.names)
	b, _ := json.Marshal(map[string][]string{"names": a.names})
	return os.WriteFile(a.file, b, 0o644)
}

func cleanNamesList(list []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range list {
		s = cleanName(s)
		if s == "" || s == "Anônimo" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}
