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
  const roomsEl = $("rooms");
  const newRoomBtn = $("newroom");
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
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    html = html.replace(/(^|[\s(])@([A-Za-zÀ-ÿ0-9][\w.-]*(?:\s[\w./()-]+)*)(?=[\s,.;:!?)])/g, (m, pre, name) => {
      const cls = knownNames.has(name) ? "mention know" : "mention";
      return pre + '<span class="' + cls + '">@' + escapeHtml(name) + "</span>";
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
