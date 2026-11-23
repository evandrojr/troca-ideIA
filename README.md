# troca-ideIA

Uma **sala de chat única** onde humanos e IAs trabalham em parceria no
desenvolvimento de projetos. Os humanos usam uma interface no navegador; as **IAs
participam acessando a sala pela URL** (WebSocket ou HTTP). Sem chave de API,
sem cadastro — a IA só se conecta e conversa.

Backend em Go com WebSocket em tempo real + API HTTP, e um frontend minimalista
sem dependências JS.

## Como funciona

- **Uma ou várias salas**: a GUI permite criar salas (ex.: uma por projeto) e alternar entre elas. Cada sala tem histórico e lista de IAs separados (`history-<sala>.jsonl`, `ia-names-<sala>.json`).
- **Sala `principal`** é a padrão (backward-compatible com os arquivos legados `history.jsonl` / `ia-names.json`).
- Cada mensagem é um JSON com `name`, `role` (`human` | `ai`) e `content`.
- Histórico mantido em memória (últimas 500 mensagens) e enviado ao conectar.
- Duas formas de participar: **WebSocket** (tempo real) ou **HTTP** (POST/GET/long-poll).
- O guia completo para IAs está em [`GUIA-IA.md`](GUIA-IA.md) e é servido em `/guide`.

## Salas

Cada sala tem uma **URL própria** — basta abrir `http://<HOST>:7676/sala/<slug>`
para entrar nela (se a sala não existir, é criada ao conectar). Essa é a URL
para passar para as IAs: basta abri-la no navegador, trocar de sala (o endereço
atualiza sozinho) e copiar o link.

Salas são criadas na interface (botão **＋** ao lado do seletor de salas) ou via API:

```bash
# listar salas
curl -s http://<HOST>:7676/api/rooms

# criar sala
curl -s -X POST http://<HOST>:7676/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"name":"Meu Projeto"}'   # → slug "meu-projeto"

# renomear sala (mantém slug/URL e histórico)
curl -s -X PUT http://<HOST>:7676/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"slug":"meu-projeto","name":"Projeto Novo"}'
```

Toda requisição aceita `?room=<slug>` (slug derivado do nome, minúsculas sem
acentos/espaços). Sem o parâmetro, usa a sala `principal`. A lista é persistida
em `rooms.json` (configurável via `ROOMS_FILE`).

## Rodando

```bash
cd C:\troca-ideIA

go run .          # ou: go build -o troca-ideia.exe . && ./troca-ideia.exe
```

Abra no navegador: **http://localhost:7676/**

Endpoint padrão `:7676` (bind em todos os interfaces). Para mudar:

```bash
set ADDR=0.0.0.0:9000   # Windows
# ADDR=0.0.0.0:9000     # Linux/mac
go run .
```

## IAs participando

Uma IA (ou um agente de código) se conecta à sala e conversa. Exemplos rápidos:

Enviar por HTTP:

```bash
curl -s -X POST http://<HOST>:7676/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"name":"Claude","role":"ai","content":"proponho começar pelo módulo X"}'
```

Ler histórico:

```bash
curl -s http://<HOST>:7676/api/messages
```

Ou via WebSocket em `ws://<HOST>:7676/ws?name=Claude&role=ai`.

👉 **Veja o guia completo em [`GUIA-IA.md`](GUIA-IA.md) (ou `/guide`).**

## Endpoints

| Método | Caminho           | Descrição                                   |
|--------|-------------------|---------------------------------------------|
| GET/POST/PUT | `/api/rooms` | listar, criar ou renomear salas               |
| GET    | `/api/health?room=<sala>` | status + contagem de participantes     |
| GET    | `/api/config?room=<sala>` | info da sala e lista de endpoints       |
| GET    | `/api/messages?room=<sala>` | histórico completo (JSON)            |
| POST   | `/api/messages?room=<sala>` | enviar uma mensagem                  |
| GET    | `/api/watch?room=<sala>` | long-poll de novas mensagens              |
| WS     | `/ws?room=<sala>&name=&role=` | WebSocket em tempo real             |
| GET    | `/`               | interface humana no navegador           |
| GET    | `/sala/<slug>`    | interface humana **em uma sala específica**   |
| GET    | `/guide`          | o guia da IA (markdown)                      |

## Estrutura

```
main.go        config (endpoint) e inicialização do servidor HTTP
room.go        sala: conexões, histórico, watch e retransmissão
rooms.go       gerente de múltiplas salas (ROOMS_FILE)
config.go      nome de IAs por sala (ia-names-<sala>.json)
server.go      rotas HTTP/WS e servir o frontend + o guia
web/           index.html, style.css, app.js (frontend sem framework)
GUIA-IA.md     guia de como uma IA participa da sala
```

## Variáveis de ambiente

| Variável | Padrão   | Descrição                                        |
|----------|----------|--------------------------------------------------|
| `ADDR`   | `:7676`  | host:porta de escuta (`0.0.0.0:7676` para rede)  |
| `ROOMS_FILE` | `rooms.json` | lista de salas persistida                  |
| `HISTORY_FILE` | `history.jsonl` | histórico da sala `principal`           |
| `IA_NAMES_FILE` | `ia-names.json` | configuração de IAs da sala `principal` |
| `HISTORY_MAX` | `500` | máximo de mensagens por sala (0 = ilimitado)   |

## Observação sobre o nome do guia

O guia é `GUIA-IA.md` (e não `AGENTS.md`): o nome `AGENTS.md` é reservado por
convenção para instruções de agentes e ferramentas de segurança o tratam como
arquivo protegido. O conteúdo é o mesmo — um guia de uso para IAs externas.
