// Command troca publishes an IA's speech in the troca-ideIA room over HTTP.
//
// Usage:
//
//	troca say <nome> <texto...>
//	troca ask <nome> <pergunta...> [--to <agente>] [--option "rótulo[=valor]"]... [--multi] [--free]
//
// Environment: TROCA_ADDR (default http://127.0.0.1:7676), TROCA_ROOM (default
// principal). All messages are posted with role=ai so the web UI and the Herdr
// bridge treat them as coming from an IA.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type optionFlag []string

func (o *optionFlag) String() string { return strings.Join(*o, ",") }
func (o *optionFlag) Set(v string) error {
	*o = append(*o, v)
	return nil
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "say":
		err = say(os.Args[2:])
	case "ask":
		err = ask(os.Args[2:])
	case "help", "-h", "--help":
		usage()
		return
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "troca:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `Uso:
  troca say <nome> <texto...>
  troca ask <nome> <pergunta...> [--to <agente>] [--option "rótulo[=valor]"]... [--multi] [--free]`)
}

func say(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("say precisa de nome e texto")
	}
	return post("/api/messages", map[string]any{
		"name":    args[0],
		"role":    "ai",
		"content": strings.Join(args[1:], " "),
	})
}

func ask(args []string) error {
	fs := flag.NewFlagSet("ask", flag.ContinueOnError)
	to := fs.String("to", "", "agente que deve responder (opcional)")
	multi := fs.Bool("multi", false, "permitir múltipla escolha")
	free := fs.Bool("free", false, "permitir resposta livre")
	var opts optionFlag
	fs.Var(&opts, "option", `opção no formato "rótulo" ou "rótulo=valor" (repetível)`)
	flags, rest := splitFlags(args)
	if err := fs.Parse(flags); err != nil {
		return err
	}
	rest = append(rest, fs.Args()...)
	if len(rest) < 2 {
		return fmt.Errorf("ask precisa de nome e pergunta")
	}
	options := make([]map[string]string, 0, len(opts))
	for _, raw := range opts {
		label, value, found := strings.Cut(raw, "=")
		if !found {
			value = label
		}
		options = append(options, map[string]string{"label": label, "value": value})
	}
	return post("/api/questions", map[string]any{
		"name":       rest[0],
		"role":       "ai",
		"prompt":     strings.Join(rest[1:], " "),
		"target":     *to,
		"options":    options,
		"multiple":   *multi,
		"allow_text": *free,
	})
}

// splitFlags permite que as opções venham antes ou depois do texto da
// pergunta ("ask UI pergunta? --to UI"), o que é natural ao digitar no hc.
func splitFlags(args []string) (flags, positional []string) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "-") {
			positional = append(positional, a)
			continue
		}
		flags = append(flags, a)
		if strings.Contains(a, "=") || a == "-multi" || a == "--multi" || a == "-free" || a == "--free" {
			continue
		}
		if (a == "-to" || a == "--to" || a == "-option" || a == "--option") && i+1 < len(args) {
			i++
			flags = append(flags, args[i])
		}
	}
	return flags, positional
}

func post(path string, body any) error {
	addr := strings.TrimRight(env("TROCA_ADDR", "http://127.0.0.1:7676"), "/")
	room := env("TROCA_ROOM", "principal")
	u := addr + path + "?room=" + url.QueryEscape(room)
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(u, "application/json", bytes.NewReader(b))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	var out struct {
		Message json.RawMessage `json:"message"`
	}
	if len(data) > 0 && json.Unmarshal(data, &out) == nil && len(out.Message) > 0 {
		fmt.Println(string(out.Message))
		return nil
	}
	fmt.Print(string(data))
	return nil
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
