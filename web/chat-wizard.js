/*
 * chat-wizard — Web Component (custom element) de chatbot guiado.
 *
 * Conduz o usuário por uma sequência de passos com estes tipos de interação:
 *   • choice   — pergunta de múltipla escolha (uma ou várias opções, role=radio
 *     quando é uma só); é o "radio" do chat;
 *   • select   — <select> nativo para escolher uma opção de uma lista;
 *   • input    — campo de texto livre (usado nas perguntas ao humano);
 *   • boolean  — pergunta sim/não;
 *   • file     — input de arquivo que aceita VÁRIOS arquivos de uma vez;
 *   • text     — mensagem do bot (sem esperar resposta).
 *
 * Copiado de /home/j/lab/serproAssina/nova-tela/chat-wizard.js. As adições
 * "select" e "input" e as variáveis de cor permitem usar o componente na sala
 * troca-ideIA sem transformá-lo em um projeto com framework.
 *
 * Uso:
 *   <chat-wizard flow='[{...}, ...]'></chat-wizard>
 *
 * Propriedades:
 *   el.flow       array de passos (ou JSON via atributo "flow").
 *   el.start()    (re)inicia o fluxo na primeira pergunta.
 *   el.reset()    limpa a conversa e devolve ao estado inicial.
 *   el.answers    array das respostas coletadas até agora.
 *
 * Passo:
 *   { type:"text", content:"Olá!" }
 *   { type:"boolean", content:"Tem certificado?", yes:"Sim", no:"Não",
 *     key:"tem_cert", on_yes:"next", on_no:"end" }
 *   { type:"choice", content:"Escolha", multi:true,
 *     options:[{label:"A", value:"a"}], key:"opcoes" }
 *   { type:"select", content:"Para quem?", placeholder:"Escolha…",
 *     options:[{label:"Claude", value:"Claude"}], key:"alvo" }
 *   { type:"input", content:"Escreva sua resposta", placeholder:"Texto…",
 *     optional:true, key:"resposta" }
 *   { type:"file", content:"Selecione os arquivos", key:"arquivos",
 *     accept:".pdf,.xml", multiple:true, min:0, max:0 }
 *
 * Controle de fluxo:
 *   Sem "on_yes"/"on_no"/"on_choice", o próximo passo é sempre o índice+1.
 *   "on_yes"/"on_no"/opção com "next"/"end": "next" = próximo passo; "end"
 *   OU o último passo encerram o fluxo (dispara "chat-complete").
 *
 * Eventos (bubbles + composed, pode ouvir de fora):
 *   "chat-answer"   detalhe { step, answer }      — uma resposta foi dada
 *   "chat-files"    detalhe { step, files }       — arquivos foram enviados
 *   "chat-complete" detalhe { answers, files }    — fluxo encerrado
 *
 * Acessibilidade: log com aria-live="polite", foco movido para os controles
 * de resposta de cada pergunta, navegação por teclado (Enter/espaço nas
 * opções; <input type=file> nativo). Reutilizável como o pades-seal-positioner.
 */
(function () {
	'use strict';

	const STYLE = `
    :host { display:flex; flex-direction:column; min-height:0; overflow:hidden;
            border:1px solid var(--cw-border, #d9dfea); border-radius:14px;
            background:var(--cw-bg, #fff);
            box-shadow:0 6px 24px rgba(21,34,56,.10);
            font-family:var(--cw-font, system-ui, sans-serif); }
    #log  { flex:1; overflow-y:auto; padding:16px; display:flex;
            flex-direction:column; gap:10px; scroll-behavior:smooth; }
    .bubble { max-width:78%; padding:9px 13px; border-radius:14px;
              font:14px/1.45 var(--cw-font, system-ui, sans-serif);
              white-space:pre-wrap; word-break:break-word; }
    .bot { align-self:flex-start; background:var(--cw-bot, #f0f3f8);
           color:var(--cw-text, #152238); border-bottom-left-radius:4px; }
    .user { align-self:flex-end; background:var(--cw-accent, #1b5fb8);
            color:var(--cw-accent-text, #fff); border-bottom-right-radius:4px; }
    .sys { align-self:center; font-size:12px; color:var(--cw-muted, #5b6b84); }
    .busy { align-self:flex-start; color:var(--cw-muted, #5b6b84); font-style:italic; }
    .dot::after { content:'…'; animation:op .8s infinite alternate; }
    @keyframes op { from{opacity:.2} to{opacity:1} }
    .ans { align-self:flex-start; display:flex; flex-direction:column;
           gap:6px; margin-top:2px; max-width:100%; }
    .opt { display:block; text-align:left; padding:8px 13px; cursor:pointer;
           border:1px solid var(--cw-border, #c3ccdb); border-radius:9px;
           background:var(--cw-bg, #fff); font:14px/1.4 var(--cw-font, system-ui);
           color:var(--cw-text, #152238);
           transition:border-color .12s, box-shadow .12s; }
    .opt:hover { border-color:var(--cw-accent, #1b5fb8); }
    .opt:focus-visible { outline:2px solid var(--cw-accent, #1b5fb8); outline-offset:1px; }
    .opt.on { background:var(--cw-selected, #e6f0fd); border-color:var(--cw-accent, #1b5fb8); }
    .opt:disabled { opacity:.45; cursor:not-allowed; }
    .confirm { padding:8px 13px; cursor:pointer; border:none; border-radius:9px;
               background:var(--cw-accent, #1b5fb8); color:var(--cw-accent-text, #fff);
               font:600 14px/1.4 var(--cw-font, system-ui);
               display:inline-flex; align-items:center; gap:6px; }
    .confirm:hover { filter:brightness(.88); }
    .confirm:focus-visible { outline:2px solid var(--cw-accent, #1b5fb8); outline-offset:2px; }
    .confirm:disabled { opacity:.5; cursor:not-allowed; }
    .ghost { background:transparent; border:1px solid var(--cw-border, #c3ccdb);
             color:var(--cw-muted, #5b6b84); font-weight:400; }
    .field, .select { width:100%; box-sizing:border-box; padding:8px 10px;
           border:1px solid var(--cw-border, #c3ccdb); border-radius:9px;
           background:var(--cw-bg, #fff); color:var(--cw-text, #152238);
           font:14px/1.4 var(--cw-font, system-ui); resize:vertical; }
    .field:focus, .select:focus { outline:none; border-color:var(--cw-accent, #1b5fb8);
           box-shadow:0 0 0 2px var(--cw-selected, #e6f0fd); }
    .chip { display:inline-flex; align-items:center; gap:6px; padding:4px 9px;
            margin:2px 4px 2px 0; border:1px solid var(--cw-border, #d9dfea);
            border-radius:999px; background:var(--cw-bot, #f0f3f8);
            font:12px/1.4 var(--cw-font, system-ui); }
    .chip .x { cursor:pointer; color:var(--cw-muted, #5b6b84); border:none;
               background:transparent; font-size:13px; line-height:1; padding:0 2px;
               border-radius:4px; }
    .chip .x:hover { color:#c0392b; }
    .chip .x:focus-visible { outline:2px solid var(--cw-accent, #1b5fb8); }
    #pick { margin-top:8px; }
    #pick-btn { display:inline-flex; align-items:center; gap:7px; cursor:pointer;
                border:1px dashed var(--cw-border, #c3ccdb); border-radius:9px;
                background:var(--cw-bot, #f0f3f8); padding:8px 13px;
                font:14px/1.4 var(--cw-font, system-ui); color:var(--cw-text, #152238); }
    #pick-btn:hover, #pick-btn.on { border-color:var(--cw-accent, #1b5fb8);
                background:var(--cw-selected, #e6f0fd); }
    #pick-btn:focus-visible { outline:2px solid var(--cw-accent, #1b5fb8); outline-offset:1px; }
    #files { margin-top:6px; display:flex; flex-wrap:wrap; gap:0; }
    .hint { font-size:12px; color:var(--cw-muted, #5b6b84); margin-top:4px; }
    .hint[hidden] { display:none; }`;

	class ChatWizard extends HTMLElement {
		static get observedAttributes() {
			return ['flow'];
		}

		constructor() {
			super();
			this.attachShadow({ mode: 'open' });
			this.shadowRoot.innerHTML = `<style>${STYLE}</style>
				<div id="log" role="log" aria-live="polite" aria-relevant="additions"></div>`;
			this._log = this.shadowRoot.getElementById('log');
			this._flow = [];
			this._idx = 0;
			this._answers = [];
			this._busy = false;
		}

		connectedCallback() {
			if (this._flow.length === 0) {
				const f = this.getAttribute('flow');
				if (f) this.flow = f;
			}
			if (this._flow.length > 0 && this._log.children.length === 0) {
				this.ask();
			}
		}

		attributeChangedCallback(name, oldV, newV) {
			if (name === 'flow' && newV && newV !== oldV) {
				this.flow = newV;
			}
		}

		// meFtodos e propriedades publicas

		set flow(v) {
			let steps = v;
			if (typeof v === 'string') {
				try {
					steps = JSON.parse(v);
				} catch (e) {
					console.error('chat-wizard: flow JSON inválido', e);
					steps = [{ type: 'text', content: 'Erro: fluxo inválido.' }];
				}
			}
			if (!Array.isArray(steps)) {
				console.error('chat-wizard: flow deve ser um array de passos');
				return;
			}
			this._flow = steps.filter((s) => s && typeof s === 'object');
			this.reset();
		}
		get flow() { return this._flow; }

		get answers() { return this._answers.slice(); }

		// Permite que o host poste mensagens (sys/bot/user) no log do chat,
		// mantendo uma única conversa na tela.
		log(cls, text) {
			return this._bubble(cls || 'sys', text);
		}

		start() { this.reset(); }
		reset() {
			this._answers = [];
			this._idx = 0;
			this._log.innerHTML = '';
			if (this.isConnected && this._flow.length > 0) this.ask();
		}

		// ── internos: renderizacao ─────────────────────────────────────────

		_bubble(cls, text) {
			const d = document.createElement('div');
			d.className = 'bubble ' + cls;
			d.textContent = text == null ? '' : text;
			this._log.appendChild(d);
			this._scroll();
			return d;
		}

		_wrap(cls) {
			const d = document.createElement('div');
			d.className = 'ans ' + (cls || '');
			this._log.appendChild(d);
			this._scroll();
			return d;
		}

		_scroll() {
			this._log.scrollTop = this._log.scrollHeight;
		}

		async _typeBot(text) {
			const b = this._bubble('busy', '');
			b.innerHTML = '<span class="dot"></span>';
			const delay = Math.min(700, 180 + text.length * 8);
			await new Promise((r) => setTimeout(r, delay));
			b.classList.remove('busy');
			b.textContent = text;
			this._scroll();
		}

		_emit(name, detail) {
			this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
		}

		_finish() {
			const files = this._answers
				.filter((a) => a.step.type === 'file' && Array.isArray(a.answer))
				.flatMap((a) => a.answer);
			this._emit('chat-complete', { answers: this._answers.slice(), files });
		}

		// ── fluxo ──────────────────────────────────────────────────────────

		_go(n) {
			this._idx = n;
			if (this._flow[this._idx]) {
				this.ask();
			} else {
				this._bubble('sys', 'Fim. Obrigado por conversar!');
				this._finish();
			}
		}

		_nextOr(step, target) {
			if (target === 'end') { this._bubble('sys', 'Fim.'); this._finish(); return; }
			if (typeof target === 'number') {
				this._go(this._idx + target);
			} else if (this._flow[this._idx + 1]) {
				this._go(this._idx + 1);
			} else {
				this._bubble('sys', 'Fim.');
				this._finish();
			}
		}

		_record(step, answer) {
			this._answers.push({ step, answer });
			this._emit('chat-answer', { step, answer });
		}

		ask() {
			const step = this._flow[this._idx];
			if (!step) return;
			if (this._busy) return;
			this._busy = true;

			const t = () => {
				this._busy = false;
				switch (step.type) {
					case 'choice': this._renderChoice(step); break;
					case 'select': this._renderSelect(step); break;
					case 'input': this._renderInput(step); break;
					case 'boolean': this._renderBoolean(step); break;
					case 'file': this._renderFile(step); break;
					case 'text':
					default: this._renderText(step); break;
				}
			};
			this._typeBot(step.content || '…').then(t);
		}

		// ── passo: texto informativo ────────────────────────────────────────

		_renderText(step) {
			this._scroll();
			const go = () => this._nextOr(step, step.next);
			if (this._flow[this._idx + 1]) {
				const w = this._wrap('inline');
				const b = document.createElement('button');
				b.type = 'button';
				b.className = 'confirm';
				b.textContent = 'Continuar';
				b.addEventListener('click', go);
				w.appendChild(b);
				// foco ajuda na leitura por teclado
				requestAnimationFrame(() => { if (this.isConnected) b.focus(); });
			} else {
				setTimeout(go, 300);
			}
		}

		// ── passo: sim/não ──────────────────────────────────────────────────

		_renderBoolean(step) {
			const w = this._wrap('inline');
			const mk = (value, label) => {
				const b = document.createElement('button');
				b.type = 'button';
				b.className = 'opt';
				b.textContent = label || (value ? 'Sim' : 'Não');
				b.addEventListener('click', () => {
					this._record(step, value);
					this._bubble('user', b.textContent);
					this._nextOr(step, value ? step.on_yes : step.on_no);
				});
				return b;
			};
			w.appendChild(mk(true, step.yes));
			w.appendChild(mk(false, step.no));
			requestAnimationFrame(() => {
				const f = w.querySelector('.opt');
				if (f && this.isConnected) f.focus();
			});
		}

		// ── passo: múltipla escolha ─────────────────────────────────────────

		_renderChoice(step) {
			const opts = step.options || [];
			const multi = !!step.multi;
			const chosen = new Set();
			const w = this._wrap();
			const list = document.createElement('div');
			list.setAttribute('role', multi ? 'group' : 'radiogroup');
			list.setAttribute('aria-label', step.content || 'Opções');
			list.style.cssText = 'display:flex;flex-direction:column;gap:6px';
			const btns = [];

			const maybeConfirm = () => {};

			opts.forEach((o, i) => {
				const label = typeof o === 'string' ? o : (o.label || String(o.value));
				const value = typeof o === 'string' ? o : (o.value != null ? o.value : label);
				const b = document.createElement('button');
				b.type = 'button';
				b.className = 'opt';
				b.textContent = label;
				if (!multi) b.setAttribute('role', 'radio');
				b.addEventListener('click', () => {
					if (multi) {
						if (chosen.has(value)) { chosen.delete(value); b.classList.remove('on'); }
						else { chosen.add(value); b.classList.add('on'); }
					} else {
						btns.forEach((other) => other.setAttribute('aria-checked', 'false'));
						b.setAttribute('aria-checked', 'true');
						this._record(step, value);
						this._bubble('user', label);
						this._nextOr(step, o.next);
					}
				});
				btns.push(b);
				list.appendChild(b);
				if (i === 0) b.setAttribute('aria-checked', 'false');
			});
			w.appendChild(list);

			if (multi) {
				const conf = document.createElement('button');
				conf.type = 'button';
				conf.className = 'confirm';
				conf.textContent = 'Confirmar';
				conf.disabled = true;
				const update = () => {
					conf.disabled = chosen.size === 0;
					btns.forEach((b, i) => b.setAttribute('aria-checked', chosen.has(opts[i].value != null ? opts[i].value : (typeof opts[i] === 'string' ? opts[i] : opts[i].label)) ? 'true' : 'false'));
				};
				conf.addEventListener('click', () => {
					this._record(step, Array.from(chosen));
					this._bubble('user', btns.filter((b) => b.classList.contains('on')).map((b) => b.textContent).join(', '));
					this._nextOr(step, step.on_choice);
				});
				w.appendChild(conf);
				btns.forEach((b) => b.addEventListener('click', update));
				requestAnimationFrame(() => {
					if (this.isConnected) btns[0] && btns[0].focus();
				});
			} else {
				requestAnimationFrame(() => {
					const f = list.querySelector('.opt');
					if (f && this.isConnected) f.focus();
				});
			}
			this._scroll();
		}

		// ── passo: <select> nativo ──────────────────────────────────────────

		_renderSelect(step) {
			const w = this._wrap();
			const sel = document.createElement('select');
			sel.className = 'select';
			sel.setAttribute('aria-label', step.content || 'Escolha uma opção');
			const ph = document.createElement('option');
			ph.value = '';
			ph.disabled = true;
			ph.selected = true;
			ph.textContent = step.placeholder || 'Escolha…';
			sel.appendChild(ph);
			const labels = new Map();
			(step.options || []).forEach((o) => {
				const label = typeof o === 'string' ? o : (o.label || String(o.value));
				const value = typeof o === 'string' ? o : (o.value != null ? o.value : label);
				const opt = document.createElement('option');
				opt.value = String(value);
				opt.textContent = label;
				labels.set(String(value), label);
				sel.appendChild(opt);
			});
			const conf = document.createElement('button');
			conf.type = 'button';
			conf.className = 'confirm';
			conf.textContent = step.confirm || 'Enviar';
			conf.disabled = true;
			sel.addEventListener('change', () => { conf.disabled = sel.value === ''; });
			const send = () => {
				if (sel.value === '') return;
				this._record(step, sel.value);
				this._bubble('user', labels.get(sel.value) || sel.value);
				this._nextOr(step, step.next);
			};
			conf.addEventListener('click', send);
			sel.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') { e.preventDefault(); send(); }
			});
			w.appendChild(sel);
			w.appendChild(conf);
			if (step.optional) {
				const skip = document.createElement('button');
				skip.type = 'button';
				skip.className = 'confirm ghost';
				skip.textContent = 'Pular';
				skip.addEventListener('click', () => {
					this._bubble('sys', 'Pulado');
					this._nextOr(step, step.next);
				});
				w.appendChild(skip);
			}
			this._scroll();
			requestAnimationFrame(() => { if (this.isConnected) sel.focus(); });
		}

		// ── passo: texto livre ──────────────────────────────────────────────

		_renderInput(step) {
			const w = this._wrap();
			const field = document.createElement(step.multiline ? 'textarea' : 'input');
			if (step.multiline) field.rows = 3;
			else field.type = 'text';
			field.className = 'field';
			field.placeholder = step.placeholder || 'Escreva sua resposta…';
			field.setAttribute('aria-label', step.content || field.placeholder);
			const conf = document.createElement('button');
			conf.type = 'button';
			conf.className = 'confirm';
			conf.textContent = step.confirm || 'Enviar';
			conf.disabled = true;
			field.addEventListener('input', () => { conf.disabled = field.value.trim() === ''; });
			const send = () => {
				const value = field.value.trim();
				if (!value) return;
				this._record(step, value);
				this._bubble('user', value);
				this._nextOr(step, step.next);
			};
			conf.addEventListener('click', send);
			field.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && (field.tagName !== 'TEXTAREA' || !e.shiftKey)) {
					e.preventDefault();
					send();
				}
			});
			w.appendChild(field);
			w.appendChild(conf);
			if (step.optional) {
				const skip = document.createElement('button');
				skip.type = 'button';
				skip.className = 'confirm ghost';
				skip.textContent = 'Pular';
				skip.addEventListener('click', () => {
					this._bubble('sys', 'Pulado');
					this._nextOr(step, step.next);
				});
				w.appendChild(skip);
			}
			this._scroll();
			requestAnimationFrame(() => { if (this.isConnected) field.focus(); });
		}

		// ── passo: arquivo (aceita vários) ──────────────────────────────────

		_renderFile(step) {
			const w = this._wrap();
			const row = document.createElement('div');
			row.innerHTML = '';
			const pb = document.createElement('button');
			pb.type = 'button';
			pb.id = 'pick-btn';
			pb.textContent = '📎 Adicionar arquivos';
			const input = document.createElement('input');
			input.type = 'file';
			input.multiple = step.multiple !== false;
			if (step.accept) input.accept = step.accept;
			input.style.cssText = 'display:none';

			let files = [];
			const chips = document.createElement('div');
			chips.id = 'files';
			const hint = document.createElement('p');
			hint.className = 'hint';
			hint.textContent = (input.multiple ? 'Você pode selecionar vários arquivos de uma vez. ' : '') + (step.hint || '');
			hint.hidden = !hint.textContent;

			const renderChips = () => {
				chips.innerHTML = '';
				files.forEach((f, i) => {
					const c = document.createElement('span');
					c.className = 'chip';
					c.textContent = f.name + ' (' + (f.size / 1024).toFixed(0) + ' KB)';
					const x = document.createElement('button');
					x.type = 'button';
					x.className = 'x';
					x.setAttribute('aria-label', 'Remover ' + f.name);
					x.textContent = '✕';
					x.addEventListener('click', () => {
						files.splice(i, 1);
						renderChips();
						conf.disabled = (step.min || 1) > files.length;
					});
					c.appendChild(x);
					chips.appendChild(c);
				});
			};

			const conf = document.createElement('button');
			conf.type = 'button';
			conf.className = 'confirm';
			conf.textContent = 'Enviar arquivos';
			conf.disabled = true;

			pb.addEventListener('click', () => input.click());
			input.addEventListener('change', () => {
				files = Array.from(input.files || []);
				input.value = '';
				renderChips();
				conf.disabled = files.length === 0;
			});

			conf.addEventListener('click', () => {
				this._record(step, files.slice());
				this._emit('chat-files', { step, files: files.slice() });
				this._bubble('user', files.length + (files.length === 1 ? ' arquivo adicionado' : ' arquivos adicionados'));
				this._nextOr(step, step.next);
			});

			row.appendChild(pb);
			row.appendChild(input);
			w.appendChild(row);
			w.appendChild(chips);
			w.appendChild(conf);
			w.appendChild(hint);
			this._scroll();
			requestAnimationFrame(() => {
				if (this.isConnected) pb.focus();
			});
		}
	}

	customElements.define('chat-wizard', ChatWizard);
})();
