// Sala troca-ideIA dentro do Herdr: mostra a conversa das IAs e as perguntas
// feitas ao humano. Sem DOM/webview — apenas gpui-kit + fetch da API da sala.
// Cliques nas opções de uma pergunta respondem via POST /api/questions/answer.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, checking } from "herdr";

const LIMIT = 60;

export default class TrocaChat extends View {
  init(_props, cx) {
    const p = _props ?? {};
    this.addr = String(p.addr ?? "http://127.0.0.1:7676").replace(/\/$/, "");
    this.room = String(p.room ?? "principal");
    this.messages = [];
    this.since = 0;
    this.status = "Conectando…";
    this.busy = false;
    if (!checking()) {
      cx.spawn(async (cx) => this.load(cx));
    } else {
      this.status = "Pronto (check)";
    }
  }

  url(path) {
    return `${this.addr}${path}?room=${encodeURIComponent(this.room)}`;
  }

  async load(cx) {
    try {
      const res = await fetch(this.url("/api/messages"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.messages = (data.messages ?? []).slice(-LIMIT);
      this.since = data.count ?? this.messages.length;
      this.status = `${this.room} · ${data.count ?? 0} mensagem(ns)`;
    } catch (e) {
      this.status = `Erro: ${e.message ?? e}`;
    }
    cx.notify();
    this.poll(cx);
  }

  poll(cx) {
    cx.spawn(async (cx) => {
      try {
        const res = await fetch(this.url(`/api/watch?since=${this.since}&timeout=25`));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        for (const m of data.messages ?? []) {
          this.messages.push(m);
        }
        if (this.messages.length > LIMIT) {
          this.messages = this.messages.slice(-LIMIT);
        }
        this.since = data.count ?? this.since;
        if (data.messages?.length) {
          this.status = `${this.room} · ${this.since} mensagem(ns)`;
          cx.notify();
        }
      } catch (e) {
        this.status = `Reconectando… (${e.message ?? e})`;
        cx.notify();
      }
      cx.timer.after(1000, (cx) => this.poll(cx));
    });
  }

  async answer(qid, value, label, cx) {
    if (this.busy) return;
    this.busy = true;
    this.status = "Enviando resposta…";
    cx.notify();
    try {
      const res = await fetch(this.url("/api/questions/answer"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question_id: qid,
          name: "humano (Herdr)",
          role: "human",
          value,
          label,
          text: "",
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      this.status = "Resposta enviada";
    } catch (e) {
      this.status = `Falha ao responder: ${e.message ?? e}`;
    }
    this.busy = false;
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const card = (m) => {
      const ai = m.role === "ai";
      const isQuestion = m.type === "question";
      const isAnswer = m.type === "answer";
      const who = (m.name ?? (ai ? "IA" : "humano")).trim();
      const badge = isQuestion ? "PERGUNTA" : isAnswer ? "RESPOSTA" : ai ? "IA" : "HUMANO";
      const accent = isQuestion ? t.accent : isAnswer ? t.done : ai ? t.working : t.muted;
      const children = [
        h_flex()
          .gap(8)
          .items_center()
          .child(div().text_size(11).font_medium().text_color(accent).child(badge))
          .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(who))
          .child(div().flex_1())
          .child(div().text_size(10.5).text_color(t.dim).child(m.ts ?? "")),
        div().pt(4).text_size(12.5).text_color(t.foreground).child(m.content ?? ""),
      ];
      const q = m.question;
      if (isQuestion && q?.options?.length) {
        const opts = v_flex().pt(8).gap(5);
        for (const o of q.options) {
          const label = o.label || o.value || "(opção)";
          const value = o.value || label;
          opts.child(
            div()
              .id(`q-${q.id ?? m.id}-${value}`)
              .px(10)
              .py(5)
              .rounded(7)
              .border_1()
              .border_color(t.input)
              .bg(t.raised)
              .text_size(11.5)
              .text_color(t.foreground)
              .cursor_pointer()
              .hover((s) => s.opacity(0.85))
              .on_click((_e, cx) => this.answer(q.id ?? m.id, value, label, cx))
              .child(label),
          );
        }
        children.push(opts);
      }
      return v_flex()
        .id(`m-${m.id ?? m.ts ?? Math.random()}`)
        .p(10)
        .gap(2)
        .rounded(9)
        .border_1()
        .border_color(t.border)
        .bg(t.surface)
        .children(children);
    };

    const list = this.messages.length
      ? v_flex().gap(8).children(this.messages.map(card))
      : div().text_size(12).text_color(t.dim).child("Nenhuma mensagem ainda.");

    return v_flex()
      .id("troca-chat")
      .size_full()
      .min_h(0)
      .bg(t.canvas)
      .text_color(t.foreground)
      .child(
        h_flex()
          .px(12)
          .py(9)
          .gap(8)
          .items_center()
          .border_b_1()
          .border_color(t.border)
          .child(div().text_size(13).font_semibold().child("troca-ideIA"))
          .child(div().flex_1())
          .child(div().text_size(10.5).text_color(t.dim).child(this.status)),
      )
      .child(
        v_flex()
          .id("troca-chat-list")
          .flex_1()
          .min_h(0)
          .p(12)
          .gap(8)
          .overflow_y_scrollbar()
          .child(list),
      )
      .child(
        h_flex()
          .px(12)
          .py(8)
          .border_t_1()
          .border_color(t.border)
          .child(
            div()
              .text_size(10.5)
              .text_color(t.dim)
              .child("Clique numa opção para responder. O histórico completo fica em /sala/<sala>."),
          ),
      );
  }
}
