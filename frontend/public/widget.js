/*!
 * Vaysen AI CRM Live Chat Widget — Chatwoot-style
 * Embed: <script src="https://your-domain.com/widget.js" data-api="https://your-api.com" defer></script>
 */
(function () {
  'use strict';

  var script = document.currentScript;
  // API 基地址必须由嵌入页通过 data-api 属性提供；禁止硬编码 localhost / 私网 IP 作为回退（TASK-110）
  var API_BASE = (script && script.getAttribute('data-api')) || '';
  var PRIMARY_COLOR = (script && script.getAttribute('data-color')) || '#1a56db';

  var state = {
    open: false,
    name: '',
    email: '',
    conversationId: null,
    messages: [],
    polling: null,
    loading: false,
    unread: 0,
  };

  /* ---- DOM ---- */
  var cssId = 'vaysen-widget-css';
  if (!document.getElementById(cssId)) {
    var link = document.createElement('link');
    link.id = cssId;
    link.rel = 'stylesheet';
    link.href = API_BASE.replace('/api', '') + '/widget.css';
    document.head.appendChild(link);
  }

  var bubble = document.createElement('button');
  bubble.className = 'vaysen-bubble';
  bubble.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>';
  bubble.onclick = toggleWidget;
  document.body.appendChild(bubble);

  var unreadDot = document.createElement('span');
  unreadDot.className = 'unread-dot';
  unreadDot.style.display = 'none';
  bubble.appendChild(unreadDot);

  var win = document.createElement('div');
  win.className = 'vaysen-window';
  win.innerHTML = buildWindowHTML();
  document.body.appendChild(win);

  /* ---- API ---- */
  function apiPost(path, body) {
    return fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  function apiGet(path) {
    return fetch(API_BASE + path).then(function (r) { return r.json(); });
  }

  /* ---- Build HTML ---- */
  function buildWindowHTML() {
    return [
      '<div class="vaysen-window-header">',
      '<div class="avatar">VA</div>',
      '<div class="info"><div class="name">示例贸易公司</div><div class="status">在线 · 通常几分钟内回复</div></div>',
      '<button class="close-btn" onclick="this.closest(\'.vaysen-window\').classList.remove(\'open\');document.querySelector(\'.vaysen-bubble\').style.display=\'\'">&times;</button>',
      '</div>',
      '<div class="vaysen-messages" id="vaysen-msgs">',
      '<div class="system-msg">欢迎联系示例贸易公司！请留下您的姓名和邮箱开始对话。</div>',
      '</div>',
      '<div class="vaysen-form" id="vaysen-register">',
      '<input type="text" id="vaysen-name" placeholder="您的姓名" />',
      '<input type="email" id="vaysen-email" placeholder="您的邮箱" />',
      '<div class="btn-row"><button class="btn-send" id="vaysen-start-btn">开始对话</button></div>',
      '</div>',
      '<div class="vaysen-form" id="vaysen-chat" style="display:none">',
      '<input type="text" id="vaysen-input" placeholder="输入消息..." />',
      '<div class="btn-row"><button class="btn-send" id="vaysen-send-btn">发送</button></div>',
      '</div>',
      '<div class="footer-note">Example Trading Company · 定制包装解决方案</div>',
    ].join('');
  }

  /* ---- Interaction ---- */
  function toggleWidget() {
    state.open = !state.open;
    if (state.open) {
      win.classList.add('open');
      bubble.style.display = 'none';
      state.unread = 0;
      updateUnreadBadge();
      bindEvents();
    } else {
      win.classList.remove('open');
      bubble.style.display = '';
      stopPolling();
    }
  }

  function bindEvents() {
    var startBtn = document.getElementById('vaysen-start-btn');
    if (startBtn) startBtn.onclick = startConversation;

    var sendBtn = document.getElementById('vaysen-send-btn');
    if (sendBtn) sendBtn.onclick = sendMessage;

    var input = document.getElementById('vaysen-input');
    if (input) input.onkeydown = function (e) {
      if (e.key === 'Enter') sendMessage();
    };

    var nameInput = document.getElementById('vaysen-name');
    var emailInput = document.getElementById('vaysen-email');
    if (nameInput && emailInput) {
      emailInput.onkeydown = function (e) {
        if (e.key === 'Enter') startConversation();
      };
    }
  }

  function startConversation() {
    var name = document.getElementById('vaysen-name').value.trim();
    var email = document.getElementById('vaysen-email').value.trim();
    if (!name) { alert('请输入您的姓名'); return; }
    if (!email) { alert('请输入您的邮箱'); return; }

    state.name = name;
    state.email = email;

    apiPost('/communications/website-inquiries', {
      contactName: name,
      email: email,
      subject: '网站在线聊天 — ' + name,
      message: '客户通过网站聊天组件发起对话',
      source: 'website_inquiry',
    }).then(function (res) {
      if (res.id) {
        state.conversationId = res.id;
        addSystemMsg('已连接，客服将尽快回复您。');
        document.getElementById('vaysen-register').style.display = 'none';
        document.getElementById('vaysen-chat').style.display = '';
        document.getElementById('vaysen-input').focus();
        startPolling();
      }
    }).catch(function () {
      addSystemMsg('连接失败，请稍后重试或发送邮件至 info@example.com');
    });
  }

  function sendMessage() {
    var input = document.getElementById('vaysen-input');
    var text = input.value.trim();
    if (!text || !state.conversationId || state.loading) return;

    state.loading = true;
    document.getElementById('vaysen-send-btn').disabled = true;
    input.value = '';

    addMessage({ content: text, direction: 'outbound', createdAt: new Date().toISOString() });

    apiPost('/communications/conversations/' + state.conversationId + '/messages', {
      direction: 'inbound',
      content: text,
      contentType: 'text',
      fromAddress: state.email,
    }).then(function () {
      state.loading = false;
      document.getElementById('vaysen-send-btn').disabled = false;
      input.focus();
    }).catch(function () {
      state.loading = false;
      document.getElementById('vaysen-send-btn').disabled = false;
      addSystemMsg('发送失败，请重试');
    });
  }

  /* ---- Messages ---- */
  function addMessage(msg) {
    state.messages.push(msg);
    renderMessages();
    var msgsEl = document.getElementById('vaysen-msgs');
    if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function addSystemMsg(text) {
    var el = document.getElementById('vaysen-msgs');
    if (!el) return;
    var div = document.createElement('div');
    div.className = 'system-msg';
    div.textContent = text;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  function renderMessages() {
    var el = document.getElementById('vaysen-msgs');
    if (!el) return;
    el.innerHTML = '';
    state.messages.forEach(function (m) {
      var div = document.createElement('div');
      div.className = 'msg ' + (m.direction === 'inbound' ? 'outbound' : 'inbound');
      div.innerHTML = '<p>' + escapeHtml(m.content) + '</p><div class="time">' + formatTime(m.createdAt) + '</div>';
      el.appendChild(div);
    });
    el.scrollTop = el.scrollHeight;
  }

  /* ---- Polling ---- */
  function startPolling() {
    stopPolling();
    state.polling = setInterval(checkNewMessages, 5000);
  }

  function stopPolling() {
    if (state.polling) { clearInterval(state.polling); state.polling = null; }
  }

  function checkNewMessages() {
    if (!state.conversationId) return;
    apiGet('/communications/conversations/' + state.conversationId)
      .then(function (res) {
        if (res.messages && res.messages.length > state.messages.length) {
          var newMsgs = res.messages.slice(state.messages.length);
          newMsgs.forEach(function (m) { addMessage(m); });
          if (!state.open) {
            state.unread += newMsgs.filter(function (m) { return m.direction === 'outbound'; }).length;
            updateUnreadBadge();
          }
        }
      }).catch(function () {});
  }

  function updateUnreadBadge() {
    unreadDot.style.display = state.unread > 0 ? '' : 'none';
    if (state.unread > 0) unreadDot.textContent = state.unread > 9 ? '9+' : state.unread;
  }

  /* ---- Helpers ---- */
  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function formatTime(ts) {
    var d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  /* ---- Init ---- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bindEvents(); });
  }

  /* Close on Escape */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.open) { toggleWidget(); }
  });
})();
