(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const messagesEl = $("messages");
  const inputEl = $("input");
  const nameEl = $("name");
  const sendBtn = $("send");
  const typingEl = $("typing");
  const connEl = $("conn");
  const participantsEl = $("participants");

  // ---- nome (persistido no navegador) ----
  let name = localStorage.getItem("idea_name") || "";
  nameEl.value = name;
  if (!name) nameEl.focus();
  nameEl.addEventListener("change", () => {
    name = nameEl.value.trim() || "Anônimo";
    localStorage.setItem("idea_name", name);
  });
  if (!name) name = "Anônimo";

  // ---- sala atual (persistida no navegador) ----
  // A sala vem da URL /sala/<slug> (fácil de copiar e mandar para as IAs);
  // sem URL, usa a sala salva ou a "principal".
  const roomFromPath = () => {
    const m = location.pathname.match(/^\/sala\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  };
  let currentRoom = roomFromPath() || localStorage.getItem("idea_room") || "principal";
  let currentRoomName = currentRoom; // nome de exibição (atualizado em loadRooms)
  const roomsEl = $("rooms");
  const newRoomBtn = $("newroom");
  const renameBtn = $("rename");
  const renamePanel = $("renamepanel");
  const renameToEl = $("renameto");
  const renameSaveBtn = $("renamesave");
  const renameCloseBtn = $("renameclose");
  const roomPanel = $("roompanel");
  const roomNameEl = $("roomname");
  const roomCreateBtn = $("roomcreate");
  const roomCloseBtn = $("roomclose");
  const roomU = () => "?room=" + encodeURIComponent(currentRoom);
  // atualiza a URL sem recarregar a página; mantém o histórico (botão voltar)
  const setRoomURL = (slug) => {
    if (roomFromPath() !== slug) {
      history.pushState(null, "", "/sala/" + encodeURIComponent(slug));
    }
  };
  // normalização de abertura: ao abrir a raiz "/", a URL passa a mostrar a sala
  // atual (vinda da URL, do localStorage, ou a principal) — sem criar histórico.
  if (!roomFromPath()) {
    history.replaceState(null, "", "/sala/" + encodeURIComponent(currentRoom));
  }

  // ---- nomes de IA configurados (servidor) ----
  let aiNames = []; // lista atual editada no painel
  const cfgBtn = $("cfg");
  const cfgPanel = $("cfgpanel");
  const cfgList = $("cfglist");
  const cfgIn = $("cfgin");
  const cfgAdd = $("cfgadd");
  const cfgSave = $("cfgsave");
  const cfgClose = $("cfgclose");

  const loadAINames = () => {
    fetch("/api/ia-names" + roomU())
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.names)) {
          aiNames = j.names;
          aiNames.forEach((n) => knownNames.add(n));
        }
      })
      .catch(() => {});
  };
  loadAINames();

  function renderCfgList() {
    cfgList.innerHTML = "";
    if (aiNames.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cfg-item";
      empty.innerHTML =
        '<span class="name" style="opacity:.6">Nenhuma IA cadastrada</span>';
      cfgList.appendChild(empty);
      return;
    }
    aiNames.forEach((n) => {
      const it = document.createElement("div");
      it.className = "cfg-item";
      it.innerHTML =
        '<span class="ai-tag">IA</span><span class="name">' +
        escapeHtml(n) +
        "</span>";
      const del = document.createElement("button");
      del.type = "button";
      del.className = "cfg-del";
      del.textContent = "✕";
      del.title = "remover " + n;
      del.addEventListener("click", () => {
        aiNames = aiNames.filter((x) => x !== n);
        renderCfgList();
      });
      it.appendChild(del);
      cfgList.appendChild(it);
    });
  }

  cfgBtn.addEventListener("click", () => {
    renderCfgList();
    cfgPanel.hidden = false;
    cfgIn.focus();
  });
  cfgClose.addEventListener("click", () => (cfgPanel.hidden = true));
  cfgPanel.addEventListener("mousedown", (ev) => {
    if (ev.target === cfgPanel) cfgPanel.hidden = true;
  });
  cfgAdd.addEventListener("click", () => {
    const v = cfgIn.value.trim();
    if (v && !aiNames.includes(v)) {
      aiNames.push(v);
      cfgIn.value = "";
      renderCfgList();
    }
  });
  cfgIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      cfgAdd.click();
    }
  });
  cfgSave.addEventListener("click", () => {
    fetch("/api/ia-names" + roomU(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: aiNames }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.names)) {
          aiNames = j.names;
          knownNames.clear();
          aiNames.forEach((n) => knownNames.add(n));
        }
        cfgPanel.hidden = true;
      })
      .catch(() => {});
  });

  // ---- limite do histórico (history_max) ----
  const cfgHist = $("cfghist");
  const cfgHistSet = $("cfghistset");
  const cfgHistInfo = $("cfghistinfo");

  const loadHistoryMax = () => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((j) => {
        if (typeof j.history_max === "number") {
          cfgHist.value = j.history_max;
          cfgHistInfo.textContent =
            j.history_max === 0
              ? "Atual: ilimitado"
              : "Atual: até " + j.history_max + " mensagens";
        }
      })
      .catch(() => {});
  };
  cfgBtn.addEventListener("click", loadHistoryMax, { once: true });

  cfgHistSet.addEventListener("click", () => {
    const v = parseInt(cfgHist.value, 10);
    if (Number.isNaN(v) || v < 0) {
      cfgHistInfo.textContent = "Digite um número >= 0 (0 = ilimitado).";
      return;
    }
    fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history_max: v }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          cfgHistInfo.textContent =
            j.history_max === 0
              ? "Salvo: ilimitado."
              : "Salvo: até " + j.history_max + " mensagens.";
        }
      })
      .catch(() => {});
  });
  cfgHist.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      cfgHistSet.click();
    }
  });

  // ---- contagem de participantes ----
  const refreshParticipants = () => {
    fetch("/api/health" + roomU())
      .then((r) => r.json())
      .then((j) => {
        if (typeof j.participants === "number") {
          participantsEl.textContent = j.participants + " online";
        }
      })
      .catch(() => {});
  };
  refreshParticipants();
  setInterval(refreshParticipants, 5000);

  // ---- gerenciamento de salas ----
  const loadRooms = () => {
    fetch("/api/rooms")
      .then((r) => r.json())
      .then((j) => {
        if (!Array.isArray(j.rooms)) return;
        roomsEl.innerHTML = "";
        const hasCurrent = j.rooms.some((rm) => rm.slug === currentRoom);
        if (!hasCurrent) {
          // sala da URL ainda não registrada (criada sob demanda no connect)
          j.rooms = j.rooms.concat([{ slug: currentRoom, name: currentRoom, participants: 0 }]);
        }
        j.rooms.forEach((rm) => {
          if (rm.slug === currentRoom) currentRoomName = rm.name;
          const opt = document.createElement("option");
          opt.value = rm.slug;
          opt.textContent = rm.name + (rm.participants ? ` (${rm.participants})` : "");
          opt.selected = rm.slug === currentRoom;
          roomsEl.appendChild(opt);
        });
      })
      .catch(() => {});
  };

  const enterRoom = (slug) => {
    slug = slug || "principal";
    if (slug === currentRoom) return;
    currentRoom = slug;
    localStorage.setItem("idea_room", slug);
    setRoomURL(slug);
    // limpa a interface e reconecta na nova sala
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try { ws.close(); } catch (_) {}
    }
    messagesEl.innerHTML = "";
    bubbles.clear();
    lastDay = "";
    aiNames = [];
    knownNames.clear();
    clearTyping();
    hideMentionMenu();
    loadRooms();
    loadAINames();
    refreshParticipants();
    connect();
  };

  roomsEl.addEventListener("change", () => enterRoom(roomsEl.value));
  newRoomBtn.addEventListener("click", () => {
    roomNameEl.value = "";
    roomPanel.hidden = false;
    roomNameEl.focus();
  });
  roomCloseBtn.addEventListener("click", () => (roomPanel.hidden = true));
  roomPanel.addEventListener("mousedown", (ev) => {
    if (ev.target === roomPanel) roomPanel.hidden = true;
  });
  const createRoom = () => {
    const name = roomNameEl.value.trim();
    if (!name) return;
    fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
      .then((r) => r.json())
      .then((j) => {
        roomPanel.hidden = true;
        if (j.ok && j.slug) {
          currentRoom = j.slug;
          localStorage.setItem("idea_room", j.slug);
          setRoomURL(j.slug);
          if (ws && ws.readyState <= WebSocket.OPEN) {
            try { ws.close(); } catch (_) {}
          }
          messagesEl.innerHTML = "";
          bubbles.clear();
          lastDay = "";
          aiNames = [];
          knownNames.clear();
          clearTyping();
          hideMentionMenu();
          loadRooms();
          loadAINames();
          refreshParticipants();
          connect();
        }
      })
      .catch(() => {});
  };
  roomCreateBtn.addEventListener("click", createRoom);
  roomNameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      createRoom();
    }
  });

  // ---- renomear sala (mantém o slug/URL) ----
  const openRename = () => {
    renameToEl.value = currentRoomName;
    renamePanel.hidden = false;
    renameToEl.focus();
    renameToEl.select();
  };
  const saveRename = () => {
    const name = renameToEl.value.trim();
    if (!name) return;
    fetch("/api/rooms", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: currentRoom, name }),
    })
      .then((r) => {
        if (!r.ok) throw new Error("falha ao renomear");
        return r.json();
      })
      .then((j) => {
        renamePanel.hidden = true;
        currentRoomName = j.name;
        loadRooms();
        loadAINames();
      })
      .catch(() => {});
  };
  renameBtn.addEventListener("click", openRename);
  renameCloseBtn.addEventListener("click", () => (renamePanel.hidden = true));
  renamePanel.addEventListener("mousedown", (ev) => {
    if (ev.target === renamePanel) renamePanel.hidden = true;
  });
  renameSaveBtn.addEventListener("click", saveRename);
  renameToEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveRename();
    }
  });

  // navegação com botão voltar/avançar do navegador (muda a sala pela URL)
  window.addEventListener("popstate", () => {
    const slug = roomFromPath() || "principal";
    if (slug !== currentRoom) {
      currentRoom = slug;
      localStorage.setItem("idea_room", slug);
      if (ws && ws.readyState <= WebSocket.OPEN) {
        try { ws.close(); } catch (_) {}
      }
      messagesEl.innerHTML = "";
      bubbles.clear();
      lastDay = "";
      aiNames = [];
      knownNames.clear();
      clearTyping();
      hideMentionMenu();
      loadRooms();
      loadAINames();
      refreshParticipants();
      connect();
    }
  });
  // ---- painel lateral de atividades: o que cada um está fazendo ----
  const activBtn = $("activ");
  const activPanel = $("activpanel");
  const activList = $("activlist");
  const activClose = $("activclose");
  const activRefresh = $("activrefresh");

  const fmtDuration = (mins) => {
    if (mins < 60) return "h\u00e1 " + mins + " min";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return "h\u00e1 " + h + "h" + (m ? " " + m + "min" : "");
  };

  // semáforo: quem está trabalhando vs. ocioso.
  //   verde   = com tarefa, status recente (incrições em dia)
  //   amarelo = com tarefa, parado há >= 10 min (quase cutucada)
  //   vermelho= com tarefa, parado há >= 20 min (limite da cutucada)
  //   cinza   = sem tarefa (ocioso / livre)
  const statusLevel = (s) => {
    if (!s.task) return "idle";
    const idle = typeof s.idle_min === "number" ? s.idle_min : 0;
    if (idle >= 20) return "stuck";
    if (idle >= 10) return "warn";
    return "busy";
  };
  const LEVEL_META = {
    busy:  { cls: "semaforo-verde", label: "trabalhando" },
    warn:  { cls: "semaforo-amarelo", label: "parado há " + "≥10min" },
    stuck: { cls: "semaforo-vermelho", label: "cutucado" },
    idle:  { cls: "semaforo-cinza", label: "ocioso" },
  };

  const LABEL_IDLE = "\u00a0cutucar";

  // pokes pendentes: nome -> { at, ack, task-before, updated-before }
  const pokes = new Map();
  const POKE_WAIT_MS = 5 * 60 * 1000; // espera de confirmação

  const cutucar = (who, btn) => {
    const content =
      "@" + who +
      " — cutucada do painel de status de " + name +
      ". Por favor leia a sala (GET /api/messages), e CONFIRME no seu status " +
      "que recebeu (POST /api/status com a sua atividade atual, ex.: task=\"recebi cutucada: <o que vai fazer>\").";
    const sendMsg = (payload) =>
      fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then((r) => r.json());
    const capture = (s) => ({ task: (s && s.task) || "", updated: (s && s.updated) || "" });
    sendMsg({ name, role: "human", content }).then(() => {
      fetch("/api/status")
        .then((r) => r.json())
        .then((j) => {
          const me = (Array.isArray(j.statuses) ? j.statuses : []).find((s) => s.name === who);
          pokes.set(who, { at: Date.now(), ack: false, before: capture(me) });
        });
    });
    if (btn) setPokeBtn(btn, "wait");
  };

  const setPokeBtn = (btn, state) => {
    if (!btn) return;
    btn.disabled = state === "wait";
    if (state === "wait") {
      btn.classList.add("wait");
      btn.classList.remove("ok");
      btn.textContent = "aguardando...";
    } else if (state === "ok") {
      btn.classList.add("ok");
      btn.classList.remove("wait");
      btn.textContent = "✓ respondeu";
    } else {
      btn.classList.remove("ok", "wait");
      btn.textContent = LABEL_IDLE;
    }
  };

  // durante o refresh, detecta se o alvo mexeu no status (confirmou a cutucada)
  const reconcilePokes = (list) => {
    const now = Date.now();
    pokes.forEach((p, who) => {
      const cur = list.find((s) => s.name === who);
      if (p.ack) return;
      if (now - p.at > POKE_WAIT_MS) {
        pokes.delete(who); // expirou
        return;
      }
      // ack: status mudou (task com conteúdo novo OU updated mudou) desde a cutucada
      if (cur) {
        const taskChanged = cur.task && cur.task !== p.before.task;
        const updatedChanged = cur.updated && cur.updated !== p.before.updated;
        if (taskChanged || updatedChanged) {
          p.ack = true;
        }
      }
    });
  };

  const loadActivities = () => {
    const statuses = fetch("/api/status").then((r) => r.json());
    const names = fetch("/api/config")
      .then((r) => r.json())
      .then((j) => (Array.isArray(j.ia_names) ? j.ia_names : []))
      .catch(() => []);
    Promise.all([statuses, names])
      .then(([j, iaNames]) => {
        activList.innerHTML = "";
        const list = Array.isArray(j.statuses) ? j.statuses : [];
        const shown = new Set();
        list.forEach((s) => shown.add(s.name));
        // participantes conhecidos (IAs cadastradas) sem status → ocioso
        iaNames.forEach((n) => {
          if (!shown.has(n)) {
            list.push({ name: n, task: "", since: "", minutes: 0, idle_min: 0 });
            shown.add(n);
          }
        });
        list.sort((a, b) => (a.name < b.name ? -1 : 1));
        reconcilePokes(list);
        if (list.length === 0) {
          const empty = document.createElement("div");
          empty.className = "cfg-item";
          empty.innerHTML =
            '<span class="name" style="opacity:.6">Ningu\u00e9m informou atividade ainda</span>';
          activList.appendChild(empty);
          return;
        }
        list.forEach((s) => {
          const lvl = statusLevel(s);
          const meta = LEVEL_META[lvl];
          const it = document.createElement("div");
          it.className = "cfg-item activ-item";
          const head = document.createElement("div");
          head.className = "activ-head";
          head.innerHTML =
            '<span class="activ-dot ' + meta.cls + '" title="' + meta.label + '"></span>' +
            '<span class="name">' + escapeHtml(s.name) + "</span>";
          const since = document.createElement("span");
          since.className = "activ-since";
          if (s.since) {
            since.textContent = fmtDuration(s.minutes);
          } else if (lvl === "idle") {
            since.textContent = "ocioso";
          }
          if (lvl === "stuck" || lvl === "warn") {
            since.classList.add("stale");
            since.textContent += " · " + meta.label;
          }
          const pokeBtn = document.createElement("button");
          pokeBtn.type = "button";
          pokeBtn.className = "activ-poke";
          pokeBtn.textContent = "cutucar";
          pokeBtn.title = "Envia um recado @ na sala para " + s.name;
          pokeBtn.dataset.name = s.name;
          const pending = pokes.get(s.name);
          if (pending) {
            if (pending.ack === true) {
              pokeBtn.textContent = "✓ respondeu";
              pokeBtn.classList.add("ok");
            } else {
              pokeBtn.textContent = "aguardando...";
              pokeBtn.classList.add("wait");
            }
          }
          pokeBtn.addEventListener("click", () => {
            cutucar(s.name, pokeBtn);
          });
          head.appendChild(since);
          head.appendChild(pokeBtn);
          const taskEl = document.createElement("div");
          taskEl.className = "activ-task";
          if (s.task) {
            taskEl.textContent = s.task;
          } else if (lvl === "idle") {
            taskEl.textContent = "Sem atividade informada";
            taskEl.style.opacity = ".6";
          }
          it.appendChild(head);
          it.appendChild(taskEl);
          activList.appendChild(it);
        });
      })
      .catch(() => {});
  };
  activRefresh.addEventListener("click", loadActivities);
  activClose.addEventListener("click", () => {
    activPanel.hidden = true;
    document.body.classList.remove("side-open");
  });
  activBtn.addEventListener("click", () => {
    const willOpen = activPanel.hidden;
    activPanel.hidden = !willOpen;
    document.body.classList.toggle("side-open", willOpen);
    if (willOpen) loadActivities();
  });
  setupActivResize();
  loadActivities();

  // ---- painel de atividades: redimensionável (largura mín./máx., lembra o valor) ----
  function setupActivResize() {
    const handle = $("activresize");
    const MIN = 260, MAX = 720;
    function apply() {
      const w = activPanel.offsetWidth;
      document.documentElement.style.setProperty("--activ-w", w + "px");
      try { localStorage.setItem("activpanel.width", String(w)); } catch (_) { }
    }
    try {
      const saved = parseInt(localStorage.getItem("activpanel.width") || "0", 10);
      if (saved >= MIN && saved <= MAX) {
        document.documentElement.style.setProperty("--activ-w", saved + "px");
      }
    } catch (_) { }
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      handle.setPointerCapture(ev.pointerId);
      const startX = ev.clientX;
      const startW = activPanel.getBoundingClientRect().width;
      const onMove = (e) => {
        activPanel.style.setProperty("--activ-w", "auto");
        const w = Math.max(MIN, Math.min(MAX, startW + (startX - e.clientX)));
        document.documentElement.style.setProperty("--activ-w", w + "px");
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        apply();
        document.body.classList.remove("resizing");
      };
      document.body.classList.add("resizing");
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }
  setInterval(() => {
    if (!activPanel.hidden) loadActivities();
  }, 15000);

  // ---- conexão ----
  let ws;
  const bubbles = new Map(); // id -> { el, body, _buf }
  let lastDay = ""; // data do último cabeçalho de dia inserido
  const knownNames = new Set(); // nomes para autocomplete de @menção

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(
      `${proto}://${location.host}/ws?name=${encodeURIComponent(name)}&room=${encodeURIComponent(currentRoom)}`
    );
    ws.onopen = () => {
      connEl.textContent = "conectado";
      connEl.className = "conn ok";
    };
    ws.onclose = () => {
      connEl.textContent = "desconectado — reconectando…";
      connEl.className = "conn err";
      setTimeout(connect, 2000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      try {
        handle(JSON.parse(ev.data));
      } catch (_) {}
    };
  }

  function handle(msg) {
    switch (msg.type) {
      case "message":
        addOrSet(msg.id, msg.name, msg.role, msg.content, msg.ts);
        clearTyping();
        break;
      case "typing":
        showTyping(msg.name);
        break;
      case "error":
        addOrSet("err-" + Date.now(), "Sistema", "ai", msg.content);
        break;
    }
  }

  function addOrSet(id, who, role, content, ts) {
    content = content || "";
    if (who && who !== "Anônimo") knownNames.add(who);
    if (bubbles.has(id)) {
      const b = bubbles.get(id);
      b._buf = content;
      b.body.innerHTML = render(content);
      scrollDown();
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "msg " + (role === "ai" ? "ai" : "human");

    const head = document.createElement("div");
    head.className = "who";
    const badge =
      role === "ai"
        ? '<span class="role ai">IA</span> '
        : '<span class="role human">humano</span> ';
    head.innerHTML =
      badge + escapeHtml(who || "Anônimo") + '<span class="when">' + fmtTs(ts) + "</span>";

    const body = document.createElement("div");
    body.className = "body";
    body.innerHTML = render(content);

    wrap.appendChild(head);
    wrap.appendChild(body);
    sepDay(ts);
    messagesEl.appendChild(wrap);
    bubbles.set(id, { el: wrap, body, _buf: content });
    scrollDown();
  }

  // ---- separador de data "Hoje" / "12/11" entre mensagens de dias diferentes ----
  function sepDay(ts) {
    const key = dayKey(ts);
    if (!key || key === lastDay) return;
    lastDay = key;
    const sep = document.createElement("div");
    sep.className = "daysep";
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
      sep.textContent = "Hoje";
      sep.dataset.day = "hoje";
    } else {
      const yest = new Date(today);
      yest.setDate(today.getDate() - 1);
      if (d.toDateString() === yest.toDateString()) {
        sep.textContent = "Ontem";
        sep.dataset.day = "ontem";
      } else {
        sep.textContent =
          d.toLocaleDateString([], { day: "2-digit", month: "2-digit" }) +
          " " +
          d.toLocaleDateString([], { weekday: "long" });
      }
    }
    messagesEl.appendChild(sep);
    scrollDown();
  }

  function dayKey(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d)) return "";
    return d.toDateString();
  }

  // ---- markdown seguro (escape + títulos/negrito/itálico/links/código/@menção) ----
  function render(text) {
    let html = escapeHtml(text);
    // blocos de código primeiro (nada dentro é re-processado)
    html = html.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      return `<pre data-lang="${escapeHtml(lang)}"><code>${code.replace(/\n$/, "")}</code></pre>`;
    });
    // títulos "## texto" (linhas com nada além de # e espaço)
    html = html.replace(/(^|\n)(#{1,6})[ \t]+([^#\r\n]*)/g, (m, pre, hash, txt) => {
      return pre + `<h${hash.length}>${txt.trim()}</h${hash.length}>`;
    });
    // negrito **texto** (antes do itálico)
    html = html.replace(/\*\*([^*][^*\n]*)\*\*/g, "<strong>$1</strong>");
    // itálico *texto* / _texto_ (mesmo delimitador dos dois lados, sem cruzar linha)
    html = html.replace(/(^|[\s#(])[*_]([^\s*_][^_*\n]*?)[*_](?=[\s,.;:!?)]|$)/g, (m, pre, t) => pre + "<em>" + t + "</em>");
    // links [texto](https://...) e URLs puros
    html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    html = html.replace(/(?<!["=])https?:\/\/[^\s<)]+/g, (url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });
    html = html.replace(/(^|\n)((?:[-*] [^\r\n]+)(?:\r?\n[-*] [^\r\n]+)*)/g, (m, pre, block) => {
      const items = block
        .split(/\r?\n/)
        .map((l) => "<li>" + l.replace(/^[-*] /, "") + "</li>")
        .join("");
      return pre + "<ul>" + items + "</ul>";
    });
    html = html.replace(/(^|\n)((?:\d+[.)] [^\r\n]+)(?:\r?\n\d+[.)] [^\r\n]+)*)/g, (m, pre, block) => {
      const items = block
        .split(/\r?\n/)
        .map((l) => "<li>" + l.replace(/^\d+[.)] /, "") + "</li>")
        .join("");
      return pre + "<ol>" + items + "</ol>";
    });
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    html = html.replace(/(^|[\s(])@([A-Za-zÀ-ÿ0-9][\w.-]*(?:\s[\w./()-]+)*)(?=[\s,.;:!?)])/g, (m, pre, name) => {
      const cls = knownNames.has(name) ? "mention know" : "mention";
      return pre + '<span class="' + cls + '">@' + escapeHtml(name) + "</span>";
    });
    // listas: linhas consecutivas "- item" ou "1. item" viram <ul>/<ol>
    html = html.replace(
      /(^|\n)(?:([-*])\s+(?=[^\s])([^\n]*)\n(?:\2\s+(?=[^\s])[^\n]*\n)*)(?=\S|$)/g,
      (m, pre, marker, first) => {
        const ul = marker === "-" || marker === "*";
        const items = (m.slice(pre.length).trim() + "\n")
          .replace(/(^|\n)[-*]\s+/g, "\n") // bullets
          .trim()
          .split("\n");
        return pre + (ul ? "<ul>" : "<ol>") + items.map((i) => "<li>" + i + "</li>").join("") + (ul ? "</ul>" : "</ol>");
      }
    );
    html = html.replace(/^(\d+)[.][ \t]+([^\n]+(?:\n(?!\d+[.][ \t])[^\n]*)*)/gm, (m, n, rest) => {
      return "<ol><li>" + m.replace(/\n(\d+)[.][ \t]+/g, "</li><li>") + "</li></ol>";
    });
    html = html.replace(/\r?\n/g, "<br>");
    return html;
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // hora local: "14:05" hoje, "12/11 14:05" em outro dia
  function fmtTs(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d)) return "";
    const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return t;
    return d.toLocaleDateString([], { day: "2-digit", month: "2-digit" }) + " " + t;
  }

  // ---- indicador de digitação ----
  let typingTimer;
  function showTyping(who) {
    typingEl.hidden = false;
    typingEl.textContent = `${who} está digitando…`;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(clearTyping, 4000);
    scrollDown();
  }
  function clearTyping() {
    typingEl.hidden = true;
    typingEl.textContent = "";
  }

  function scrollDown() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---- entrada ----
  const mentionmenu = $("mentionmenu");
  let mentionQuery = "";
  let mentionIdx = -1;
  let mentionBefore = "";

  function currentMentionToken() {
    const caret = inputEl.selectionStart;
    const before = inputEl.value.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at < 0) return null;
    const prev = before.slice(0, at);
    if (/[\w@]/.test(prev.slice(-1))) return null; // não é começo de palavra
    const token = before.slice(at + 1);
    if (token && /[\s@]/.test(token)) return null;
    requestAnimationFrame(() => inputEl.setSelectionRange(caret, caret));
    return { at, token };
  }

  function updateMentionMenu() {
    const cur = currentMentionToken();
    if (!cur) {
      hideMentionMenu();
      return;
    }
    const q = cur.token.toLowerCase();
    const matches = [...knownNames]
      .filter((n) => n.toLowerCase().includes(q))
      .sort()
      .slice(0, 8);
    if (matches.length === 0) {
      hideMentionMenu();
      return;
    }
    mentionQuery = cur.token;
    mentionBefore = cur;
    mentionmenu.innerHTML = "";
    matches.forEach((name, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "mention-item";
      item.textContent = "@" + name;
      item.dataset.idx = i;
      item.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        applyMention(name);
      });
      mentionmenu.appendChild(item);
    });
    mentionmenu.hidden = false;
    mentionIdx = 0;
    markMentionActive();
  }

  function markMentionActive() {
    [...mentionmenu.children].forEach((el, i) => {
      el.classList.toggle("active", i === mentionIdx);
    });
    const active = mentionmenu.children[mentionIdx];
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function applyMention(name) {
    const caret = inputEl.selectionStart;
    const before = inputEl.value.slice(0, caret);
    const at = before.lastIndexOf("@");
    inputEl.value = before.slice(0, at) + "@" + name + " " + inputEl.value.slice(caret);
    autoGrow();
    inputEl.focus();
    hideMentionMenu();
  }

  function hideMentionMenu() {
    mentionmenu.hidden = true;
    mentionmenu.innerHTML = "";
    mentionQuery = "";
    mentionIdx = -1;
  }

  function selectMentionDelta(delta) {
    const total = mentionmenu.children.length;
    if (!total) return;
    mentionIdx = (mentionIdx + delta + total) % total;
    markMentionActive();
  }

  inputEl.addEventListener("input", () => {
    autoGrow();
    updateMentionMenu();
  });
  inputEl.addEventListener("keydown", (e) => {
    if (!mentionmenu.hidden) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        selectMentionDelta(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        selectMentionDelta(-1);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const item = mentionmenu.children[mentionIdx];
        if (item) applyMention(item.textContent.slice(1));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideMentionMenu();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    } else {
      sendWs({ type: "typing", name });
    }
  });
  sendBtn.addEventListener("click", send);

  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  }

  function send() {
    const content = inputEl.value.trim();
    if (!content) return;
    sendWs({ type: "message", name, role: "human", content });
    inputEl.value = "";
    autoGrow();
  }

  function sendWs(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  loadRooms();
  connect();
})();
