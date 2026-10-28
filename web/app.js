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

  // ---- contagem de participantes ----
  const refreshParticipants = () => {
    fetch("/api/health")
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

  // ---- conexão ----
  let ws;
  const bubbles = new Map(); // id -> { el, body, _buf }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(
      `${proto}://${location.host}/ws?name=${encodeURIComponent(name)}`
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
        addOrSet(msg.id, msg.name, msg.role, msg.content);
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

  function addOrSet(id, who, role, content) {
    content = content || "";
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
    head.innerHTML = badge + escapeHtml(who || "Anônimo");

    const body = document.createElement("div");
    body.className = "body";
    body.innerHTML = render(content);

    wrap.appendChild(head);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    bubbles.set(id, { el: wrap, body, _buf: content });
    scrollDown();
  }

  // ---- markdown mínimo e seguro (escape + código) ----
  function render(text) {
    let html = escapeHtml(text);
    html = html.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      return `<pre data-lang="${escapeHtml(lang)}"><code>${code.replace(/\n$/, "")}</code></pre>`;
    });
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
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
  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  }
  inputEl.addEventListener("input", autoGrow);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    } else {
      sendWs({ type: "typing", name });
    }
  });
  sendBtn.addEventListener("click", send);

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

  connect();
})();
