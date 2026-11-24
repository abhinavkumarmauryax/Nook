/* Nook - Copyright (c) 2026 Abhi. Source-available, non-commercial licence. See LICENSE. */
/* Shared ephemeral chat UI: rendering, GIF composer, local-only message state. */
(function () {
  'use strict';

  const MAX_LOCAL_MESSAGES = 300;
  const EMOJI = [
    ['😀','grin smile happy'], ['😂','laugh tears funny'], ['🥹','touching emotional'], ['😍','love heart eyes'],
    ['🤔','thinking think'], ['👍','thumbs up yes'], ['👎','thumbs down no'], ['🔥','fire hot lit'],
    ['✨','sparkle stars shine'], ['🎉','party celebrate'], ['❤️','heart love red'], ['🙏','thanks please'],
    ['👀','eyes look watching'], ['🚀','rocket launch'], ['💬','chat message'], ['😎','cool sunglasses'],
    ['🥳','party celebrate'], ['💡','idea lightbulb'], ['🎬','movie video'], ['🍿','popcorn watch'],
    ['👋','wave hello bye'], ['😭','cry sad'], ['🙌','raised hands yay'], ['💪','strong muscle'],
    ['⭐','star favourite'], ['🤣','rofl laughing'], ['😴','sleep tired'], ['🎧','music headphones'],
    ['😅','sweat nervous'], ['🤝','handshake deal'], ['😊','smile happy'], ['😉','wink'],
  ];

  function initials(name) {
    return String(name || '?').trim().split(/[\s_.\-]+/).filter(Boolean)
      .slice(0, 2).map((x) => x[0].toUpperCase()).join('') || '?';
  }

  function isNearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }

  function createPreview(overlay, url, alt) {
    let img = overlay.querySelector('img');
    if (!img) {
      img = document.createElement('img');
      overlay.appendChild(img);
    }
    img.src = url;
    img.alt = alt || 'GIF preview';
    overlay.style.display = 'flex';
  }

  window.NookChatUI = {
    setup(opts) {
      const messagesEl = opts.messagesEl;
      const inputEl = opts.inputEl;
      const state = { messages: [], last: null, provider: null };

      // Panels live on the body so the chat container cannot clip them.
      const bodyGifPanel = document.getElementById('gifPanel');
      const bodyEmojiPanel = document.getElementById('emojiPicker');
      if (bodyGifPanel) document.body.appendChild(bodyGifPanel);
      if (bodyEmojiPanel) document.body.appendChild(bodyEmojiPanel);
      function placePanel(panel) {
        if (!panel) return;
        panel.style.display = 'flex';
        const r = inputEl.getBoundingClientRect();
        const w = panel.offsetWidth || 300;
        const h = panel.offsetHeight || 320;
        panel.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
        panel.style.top = Math.max(8, r.top - h - 10) + 'px';
      }

      // Empty state (no history is ever loaded from the server).
      const empty = document.createElement('div');
      empty.className = 'chat-empty-state';
      empty.innerHTML = '<div class="empty-icon">✨</div><strong>You\'re all caught up!</strong><span>Start the conversation.</span>';
      messagesEl.appendChild(empty);

      function updateEmpty() {
        const real = state.messages.filter((m) => m.type !== 'system').length;
        empty.style.display = real ? 'none' : 'flex';
      }
      function prune() {
        if (state.messages.length <= MAX_LOCAL_MESSAGES) return;
        const excess = state.messages.length - MAX_LOCAL_MESSAGES;
        state.messages.splice(0, excess);
        for (let i = 0; i < excess; i++) {
          if (messagesEl.firstChild && messagesEl.firstChild !== empty) messagesEl.removeChild(messagesEl.firstChild);
        }
      }
      function reset() {
        state.messages = [];
        state.last = null;
        Array.from(messagesEl.children).forEach((c) => { if (c !== empty) c.remove(); });
        updateEmpty();
      }

      function renderGif(msg, body) {
        const wrap = document.createElement('div');
        wrap.className = 'gif-message';
        const img = document.createElement('img');
        img.className = 'gif-image';
        img.loading = 'lazy';
        img.alt = msg.alt || 'GIF';
        const still = msg.staticUrl && (window.matchMedia('(prefers-reduced-motion: reduce)').matches || state.staticOnly);
        img.src = still ? msg.staticUrl : msg.url;
        img.addEventListener('load', () => wrap.classList.add('loaded'));
        img.addEventListener('error', () => {
          wrap.classList.add('failed');
          img.alt = 'GIF unavailable';
        });
        img.addEventListener('click', () => {
          const ov = document.getElementById('nookGifPreview');
          if (ov) createPreview(ov, img.src, img.alt);
        });
        wrap.appendChild(img);
        body.appendChild(wrap);
      }

      function append(msg) {
        const stick = isNearBottom(messagesEl);
        const div = document.createElement('div');
        div.className = 'message ' + (msg.type || 'chat');
        if (msg.type === 'system') {
          const bubble = document.createElement('div');
          bubble.className = 'bubble';
          bubble.textContent = msg.text || '';
          div.appendChild(bubble);
          state.last = null;
        } else {
          const user = typeof opts.getUser === 'function' ? opts.getUser(msg.username) : null;
          const grouped = !!(state.last && state.last.username === msg.username && msg.kind === state.last.kind);
          const myName = typeof opts.myUsername === 'function' ? opts.myUsername() : opts.myUsername;
          if (msg.username === myName) div.classList.add('me');
          if (grouped) div.classList.add('grouped');
          if (grouped) {
            const sp = document.createElement('span');
            sp.style.cssText = 'width:32px;flex:none';
            div.appendChild(sp);
          } else {
            const av = document.createElement('span');
            av.className = 'avatar avatar-' + (user ? user.role : 'member');
            av.textContent = initials(msg.username);
            div.appendChild(av);
          }
          const body = document.createElement('div');
          body.className = 'message-body';
          if (!grouped) {
            const head = document.createElement('div');
            head.className = 'message-head';
            const name = document.createElement('span');
            name.className = 'username';
            name.textContent = msg.username;
            const meta = document.createElement('span');
            meta.className = 'meta';
            meta.textContent = new Date(msg.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            head.append(name, meta);
            if (user) {
              const tag = document.createElement('span');
              tag.className = 'role-tag role-tag-' + user.role;
              tag.textContent = user.role.toUpperCase();
              head.appendChild(tag);
            }
            body.appendChild(head);
          }
          if (msg.kind === 'gif') renderGif(msg, body);
          else {
            const bubble = document.createElement('div');
            bubble.className = 'bubble';
            bubble.textContent = msg.text || '';
            body.appendChild(bubble);
          }
          div.appendChild(body);
          const actions = document.createElement('div');
          actions.className = 'msg-actions';
          const copy = document.createElement('button');
          copy.textContent = 'Copy';
          copy.addEventListener('click', () => {
            const value = msg.kind === 'gif' ? msg.url : msg.text;
            if (navigator.clipboard) navigator.clipboard.writeText(value);
          });
          actions.appendChild(copy);
          div.appendChild(actions);
          state.last = msg;
        }
        messagesEl.appendChild(div);
        state.messages.push(msg);
        updateEmpty();
        prune();
        if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      // --- Emoji picker ---
      const emojiBtn = document.getElementById('emojiBtn');
      const emojiPicker = document.getElementById('emojiPicker');
      const emojiGrid = document.getElementById('emojiGrid');
      const emojiSearch = document.getElementById('emojiSearch');
      const emojiClose = document.getElementById('emojiClose');
      if (emojiBtn && emojiPicker) {
        function renderEmoji(query) {
          if (!emojiGrid) return;
          emojiGrid.innerHTML = '';
          const q = String(query || '').trim().toLowerCase();
          const matches = EMOJI.filter(([, words]) => !q || words.includes(q));
          if (!matches.length) {
            const empty = document.createElement('div');
            empty.className = 'emoji-empty';
            empty.textContent = 'No emoji found';
            emojiGrid.appendChild(empty);
            return;
          }
          matches.forEach(([char]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = char;
            b.title = char;
            b.addEventListener('click', () => {
              const s = inputEl.selectionStart ?? inputEl.value.length;
              inputEl.value = inputEl.value.slice(0, s) + char + inputEl.value.slice(inputEl.selectionEnd ?? s);
              inputEl.focus();
            });
            emojiGrid.appendChild(b);
          });
        }
        renderEmoji('');
        if (emojiSearch) emojiSearch.addEventListener('input', () => renderEmoji(emojiSearch.value));
        if (emojiClose) emojiClose.addEventListener('click', () => { emojiPicker.style.display = 'none'; });
        emojiBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (emojiPicker.style.display === 'none') placePanel(emojiPicker);
          else emojiPicker.style.display = 'none';
          if (emojiPicker.style.display !== 'none' && emojiSearch) {
            emojiSearch.value = '';
            renderEmoji('');
            emojiSearch.focus();
          }
          const gifPanel = document.getElementById('gifPanel');
          if (gifPanel) gifPanel.style.display = 'none';
        });
      }

      // --- GIF picker (provider-independent) ---
      const gifBtn = document.getElementById('gifBtn');
      const gifPanel = document.getElementById('gifPanel');
      const gifSearch = document.getElementById('gifSearch');
      const gifResults = document.getElementById('gifResults');
      const gifClose = document.getElementById('gifClose');
      const gifDirect = document.getElementById('gifDirect');
      const gifDirectSend = document.getElementById('gifDirectSend');
      const gifStatus = document.getElementById('gifStatus');

      function setGifStatus(text) { if (gifStatus) gifStatus.textContent = text || ''; }

      function sendGif(payload) {
        opts.send(payload, (resp) => {
          if (!resp || !resp.ok) {
            if (opts.toast) opts.toast((resp && resp.message) || 'Could not send GIF');
            return;
          }
          if (gifPanel) gifPanel.style.display = 'none';
        });
      }

      function directUrl() {
        const value = String((gifDirect && gifDirect.value) || '').trim();
        try {
          const u = new URL(value);
          if (!/^https?:$/.test(u.protocol) || !/\.gif($|\?)/i.test(u.pathname)) throw new Error();
          return u.toString();
        } catch { return null; }
      }
      if (gifDirect) gifDirect.addEventListener('input', () => {
        if (gifDirectSend) gifDirectSend.disabled = !directUrl();
      });
      if (gifDirectSend) gifDirectSend.addEventListener('click', () => {
        const url = directUrl();
        if (url) sendGif({ kind: 'gif', url, alt: 'GIF' });
      });

      function reflowGif() {
        if (gifPanel && gifPanel.style.display !== 'none') placePanel(gifPanel);
      }
      async function searchGifs(q) {
        if (!state.provider) {
          try {
            const s = await (await fetch('/api/status')).json();
            state.provider = s.gifProvider || false;
          } catch { state.provider = false; }
        }
        if (!state.provider) {
          setGifStatus('No GIF provider configured - you can still paste a direct .gif URL below.');
          if (gifResults) gifResults.innerHTML = '';
          reflowGif();
          return;
        }
        setGifStatus('Searching…');
        try {
          const token = encodeURIComponent(opts.getSessionToken ? opts.getSessionToken() : '');
          const res = await fetch(`/api/gifs/search?token=${token}&q=${encodeURIComponent(q || '')}`);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Search failed');
          if (gifResults) gifResults.innerHTML = '';
          if (!data.results || !data.results.length) {
            setGifStatus('No GIFs found. Try another search.');
            reflowGif();
            return;
          }
          setGifStatus('');
          data.results.forEach((g) => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'gif-card';
            const img = document.createElement('img');
            img.src = g.previewUrl || g.url;
            img.alt = g.alt || 'GIF';
            img.loading = 'lazy';
            card.appendChild(img);
            card.addEventListener('click', () => sendGif({ kind: 'gif', url: g.url, staticUrl: g.staticUrl, alt: g.alt, source: 'provider' }));
            gifResults.appendChild(card);
          });
          reflowGif();
        } catch (err) {
          setGifStatus('GIF search unavailable. You can still paste a direct .gif URL.');
          reflowGif();
        }
      }

      if (gifBtn && gifPanel) {
        gifBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (gifPanel.style.display === 'none') {
            placePanel(gifPanel);
            searchGifs('');
          } else gifPanel.style.display = 'none';
          if (emojiPicker) emojiPicker.style.display = 'none';
        });
        if (gifClose) gifClose.addEventListener('click', () => { gifPanel.style.display = 'none'; });
        if (gifSearch) {
          let t = null;
          gifSearch.addEventListener('input', () => {
            clearTimeout(t);
            t = setTimeout(() => searchGifs(gifSearch.value.trim()), 350);
          });
          gifSearch.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); searchGifs(gifSearch.value.trim()); }
          });
        }
      }
      document.addEventListener('click', (e) => {
        if (gifPanel && gifPanel.style.display !== 'none' && !e.target.closest('#gifPanel') && e.target !== gifBtn) {
          gifPanel.style.display = 'none';
        }
        if (emojiPicker && emojiPicker.style.display !== 'none' && !e.target.closest('#emojiPicker') && e.target !== emojiBtn) {
          emojiPicker.style.display = 'none';
        }
      });

      // --- Expanded GIF preview overlay ---
      let overlay = document.getElementById('nookGifPreview');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'nookGifPreview';
        overlay.className = 'gif-preview-overlay';
        overlay.innerHTML = '<button class="gif-preview-close" aria-label="Close">✕</button>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.classList.contains('gif-preview-close')) overlay.style.display = 'none'; });
      }

      function setGifsEnabled(enabled) {
        const on = enabled !== false;
        if (gifBtn) gifBtn.style.display = on ? '' : 'none';
        if (!on) {
          if (gifPanel) gifPanel.style.display = 'none';
          if (gifDirectSend) gifDirectSend.disabled = true;
        }
      }

      updateEmpty();
      return { append, reset, updateEmpty, setGifsEnabled };
    },
  };
})();
