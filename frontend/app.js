/* ============================================================
   MailBlast — Application Logic
   ============================================================ */

// ── State ──────────────────────────────────────────────────────────────────────
const state = {
  contacts: JSON.parse(localStorage.getItem('mailblast_contacts') || '[]'),
  campaigns: JSON.parse(localStorage.getItem('mailblast_campaigns') || '[]'),
  drafts: JSON.parse(localStorage.getItem('mailblast_drafts') || '[]'),
  settings: JSON.parse(localStorage.getItem('mailblast_settings') || '{}'),
  currentBodyType: 'html',
  currentRecipientTab: 'manual',
  csvRecipients: [],
  selectedContactEmails: new Set(),
  activePollInterval: null,
};

// ── API base URL helper ─────────────────────────────────────────────────────────
function apiBase() {
  return (state.settings.apiEndpoint || 'http://localhost:3001').replace(/\/$/, '');
}
async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (state.settings.apiKey) headers['Authorization'] = `Bearer ${state.settings.apiKey}`;
  const res = await fetch(`${apiBase()}${path}`, { ...options, headers });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

// ── Templates ──────────────────────────────────────────────────────────────────
const EMAIL_TEMPLATES = [
  {
    id: 'welcome',
    name: 'Welcome Email',
    description: 'Warm onboarding message for new subscribers',
    subject: 'Welcome to our community! 🎉',
    body: `<h2 style="color:#6c63ff;">Welcome aboard! 🎉</h2>
<p>Hi there,</p>
<p>We're thrilled to have you with us. You've just joined a community of thousands of people who are passionate about great products and services.</p>
<p>Here's what you can expect from us:</p>
<ul>
  <li>✅ Weekly insights and tips</li>
  <li>✅ Exclusive offers for subscribers</li>
  <li>✅ Early access to new features</li>
</ul>
<p>If you have any questions, simply reply to this email. We'd love to hear from you!</p>
<p>Warm regards,<br><strong>The Team</strong></p>`,
  },
  {
    id: 'promo',
    name: 'Promotional Offer',
    description: 'Flash sale or limited-time discount',
    subject: '⚡ Limited Time Offer — 30% OFF Everything!',
    body: `<div style="text-align:center;background:linear-gradient(135deg,#6c63ff,#00d4ff);padding:32px;border-radius:12px;margin-bottom:24px;">
  <h1 style="color:white;margin:0;">30% OFF</h1>
  <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;">Today Only — Don't Miss Out!</p>
</div>
<p>Hi there,</p>
<p>For the next <strong>24 hours only</strong>, everything in our store is <strong>30% off</strong>. No code needed — the discount is applied automatically at checkout.</p>
<p style="text-align:center;margin:24px 0;">
  <a href="#" style="background:#6c63ff;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Shop Now →</a>
</p>
<p>This offer expires at midnight, so act fast!</p>
<p>Happy shopping! 🛍️</p>`,
  },
  {
    id: 'newsletter',
    name: 'Monthly Newsletter',
    description: 'Regular digest of news and updates',
    subject: '📬 Your Monthly Digest — October 2024',
    body: `<h2>📬 October Newsletter</h2>
<p>Here's what happened this month and what's coming up:</p>
<hr style="border:1px solid #1f2937;margin:20px 0;" />
<h3>🔥 Top Stories</h3>
<p><strong>Feature Launch:</strong> We just released a major update with 15 new features. <a href="#">Read more →</a></p>
<p><strong>Community Spotlight:</strong> This month we feature one of our amazing community members. <a href="#">Read their story →</a></p>
<hr style="border:1px solid #1f2937;margin:20px 0;" />
<h3>📅 Upcoming Events</h3>
<ul>
  <li>Nov 1 — Monthly webinar (free)</li>
  <li>Nov 15 — Product demo</li>
</ul>
<p>That's all for this month. See you next time!</p>`,
  },
  {
    id: 'announcement',
    name: 'Product Announcement',
    description: 'Launch a new product or feature',
    subject: '🚀 Introducing our biggest product yet!',
    body: `<h2>🚀 Big News!</h2>
<p>We've been working on something special for months, and today we're finally ready to share it with you.</p>
<p>Introducing <strong>[Product Name]</strong> — the easiest way to [solve core problem].</p>
<p>Here's what makes it different:</p>
<ol>
  <li><strong>Speed</strong> — Get results in seconds, not hours</li>
  <li><strong>Simplicity</strong> — No learning curve, just results</li>
  <li><strong>Power</strong> — Built for professionals, usable by everyone</li>
</ol>
<p style="text-align:center;margin:28px 0;">
  <a href="#" style="background:linear-gradient(135deg,#6c63ff,#00d4ff);color:white;padding:13px 32px;border-radius:8px;text-decoration:none;font-weight:700;">Try it Free →</a>
</p>
<p>As an early subscriber, you get <strong>exclusive beta access</strong> today.</p>`,
  },
  {
    id: 'followup',
    name: 'Follow-Up',
    description: 'Re-engage inactive subscribers',
    subject: "We miss you! Here's 20% OFF to come back 💙",
    body: `<h2>We miss you 💙</h2>
<p>Hi there,</p>
<p>It's been a while since we've heard from you, and we wanted to check in. We hope you're doing well!</p>
<p>To welcome you back, we're offering you an exclusive <strong>20% discount</strong> on your next order — just use code <strong style="background:#6c63ff;color:white;padding:2px 8px;border-radius:4px;">WELCOME20</strong> at checkout.</p>
<p>This code is valid for the next 7 days.</p>
<p style="text-align:center;margin:24px 0;">
  <a href="#" style="background:#6c63ff;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Claim Your Discount →</a>
</p>
<p>Looking forward to seeing you again!</p>`,
  },
  {
    id: 'transactional',
    name: 'Order Confirmation',
    description: 'Transactional receipt template',
    subject: '✅ Order Confirmed — #12345',
    body: `<h2>✅ Order Confirmed!</h2>
<p>Hi there,</p>
<p>Thank you for your purchase! Your order has been received and is being processed.</p>
<table style="width:100%;border-collapse:collapse;margin:20px 0;">
  <tr style="background:rgba(108,99,255,0.1);">
    <th style="padding:10px;text-align:left;border:1px solid #1f2937;">Item</th>
    <th style="padding:10px;text-align:right;border:1px solid #1f2937;">Price</th>
  </tr>
  <tr>
    <td style="padding:10px;border:1px solid #1f2937;">Product Name × 1</td>
    <td style="padding:10px;text-align:right;border:1px solid #1f2937;">$49.00</td>
  </tr>
  <tr style="font-weight:bold;">
    <td style="padding:10px;border:1px solid #1f2937;">Total</td>
    <td style="padding:10px;text-align:right;border:1px solid #1f2937;">$49.00</td>
  </tr>
</table>
<p>You'll receive a shipping confirmation email once your order is dispatched.</p>`,
  },
];

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  renderTemplates();
  renderContactsTab();
  updateStats();
  renderCampaignsTable();
  renderHistoryTable();
  initSubjectCounter();
  initRecipientLiveCount();
});

// ── Navigation ─────────────────────────────────────────────────────────────────
function showSection(name, navEl) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const section = document.getElementById(`section-${name}`);
  if (section) section.classList.add('active');
  if (navEl) navEl.classList.add('active');

  const titles = { dashboard: 'Dashboard', compose: 'Compose Campaign', contacts: 'Contacts', templates: 'Email Templates', history: 'Campaign History', settings: 'Settings' };
  document.getElementById('topbar-title').textContent = titles[name] || name;

  // Close sidebar on mobile
  if (window.innerWidth < 768) document.getElementById('sidebar').classList.remove('open');

  if (name === 'compose') syncComposeRecipients();
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// ── Settings ───────────────────────────────────────────────────────────────────
function loadSettings() {
  const s = state.settings;
  if (s.apiEndpoint) document.getElementById('api-endpoint').value = s.apiEndpoint;
  if (s.apiKey) document.getElementById('api-key').value = s.apiKey;
  if (s.sesRegion) document.getElementById('ses-region').value = s.sesRegion;
  if (s.defaultFrom) document.getElementById('default-from').value = s.defaultFrom;
  if (s.defaultName) document.getElementById('default-name').value = s.defaultName;

  // Pre-fill compose if defaults exist
  if (s.defaultFrom) document.getElementById('from-email').value = s.defaultFrom;
  if (s.defaultName) document.getElementById('from-name').value = s.defaultName;
}

function saveSettings() {
  state.settings = {
    apiEndpoint: document.getElementById('api-endpoint').value.trim(),
    apiKey: document.getElementById('api-key').value.trim(),
    sesRegion: document.getElementById('ses-region').value,
    defaultFrom: document.getElementById('default-from').value.trim(),
    defaultName: document.getElementById('default-name').value.trim(),
  };
  localStorage.setItem('mailblast_settings', JSON.stringify(state.settings));
  loadSettings();
  showToast('Settings saved successfully!', 'success');
}

async function testConnection() {
  const endpoint = (document.getElementById('api-endpoint').value.trim() || 'http://localhost:3001').replace(/\/$/, '');
  const btn = document.getElementById('test-conn-btn');
  btn.textContent = 'Testing...';
  btn.disabled = true;
  try {
    const res = await fetch(`${endpoint}/health`);
    if (res.ok) {
      const data = await res.json();
      showResult('connection-result', 'success', `✅ Connected! Mode: ${data.mode || 'live'} · Account: ${data.accountId || 'unknown'}`);
    } else {
      showResult('connection-result', 'error', `❌ Server returned ${res.status}`);
    }
  } catch (e) {
    showResult('connection-result', 'error', `❌ Connection failed: ${e.message}`);
  } finally {
    btn.textContent = 'Test Connection';
    btn.disabled = false;
  }
}

function toggleApiKeyVisibility() {
  const input = document.getElementById('api-key');
  input.type = input.type === 'password' ? 'text' : 'password';
}

function showResult(id, type, msg) {
  const el = document.getElementById(id);
  el.className = `connection-result ${type}`;
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Compose: Subject Counter ───────────────────────────────────────────────────
function initSubjectCounter() {
  const sub = document.getElementById('subject');
  const cnt = document.getElementById('subject-count');
  sub.addEventListener('input', () => {
    const len = sub.value.length;
    cnt.textContent = `${len}/78`;
    cnt.style.color = len > 78 ? 'var(--red)' : 'var(--text-muted)';
  });
}

// ── Compose: Body type toggle ──────────────────────────────────────────────────
function setBodyType(type) {
  state.currentBodyType = type;
  const htmlArea = document.getElementById('email-body-html');
  const textArea = document.getElementById('email-body-text');
  const toolbar = document.getElementById('editor-toolbar');
  const htmlBtn = document.getElementById('body-html-btn');
  const textBtn = document.getElementById('body-text-btn');

  if (type === 'html') {
    htmlArea.classList.remove('hidden');
    textArea.classList.add('hidden');
    toolbar.classList.remove('hidden');
    htmlBtn.classList.add('active');
    textBtn.classList.remove('active');
  } else {
    htmlArea.classList.add('hidden');
    textArea.classList.remove('hidden');
    toolbar.classList.add('hidden');
    textBtn.classList.add('active');
    htmlBtn.classList.remove('active');
  }
}

function execCmd(cmd) {
  document.execCommand(cmd, false, null);
  document.getElementById('email-body-html').focus();
}

function clearEditor() {
  if (state.currentBodyType === 'html') {
    document.getElementById('email-body-html').innerHTML = '';
  } else {
    document.getElementById('email-body-text').value = '';
  }
}

function insertLink() {
  const url = prompt('Enter URL:');
  if (url) document.execCommand('createLink', false, url);
}

// ── Compose: Recipient Tabs ────────────────────────────────────────────────────
function switchRecipientTab(tab) {
  state.currentRecipientTab = tab;
  ['manual', 'csv', 'contacts'].forEach(t => {
    document.getElementById(`recipient-${t}`).classList.toggle('hidden', t !== tab);
    document.getElementById(`tab-${t}`)?.classList.toggle('active', t === tab);
  });
  updateRecipientSummary();
}

function initRecipientLiveCount() {
  document.getElementById('recipients-manual').addEventListener('input', () => {
    const count = parseManualEmails().length;
    document.getElementById('manual-count').textContent = `${count} recipient${count !== 1 ? 's' : ''} detected`;
    updateRecipientSummary();
  });
}

function parseManualEmails() {
  const raw = document.getElementById('recipients-manual').value;
  const emails = raw.split(/[\s,;]+/).map(e => e.trim()).filter(e => isValidEmail(e));
  return [...new Set(emails)];
}

function getActiveRecipients() {
  if (state.currentRecipientTab === 'manual') return parseManualEmails();
  if (state.currentRecipientTab === 'csv') return state.csvRecipients.map(r => r.email).filter(isValidEmail);
  if (state.currentRecipientTab === 'contacts') return [...state.selectedContactEmails];
  return [];
}

function updateRecipientSummary() {
  const recipients = getActiveRecipients();
  const count = recipients.length;
  document.getElementById('total-recipients-label').textContent = `${count} recipient${count !== 1 ? 's' : ''} ready`;
  document.getElementById('send-recipient-count').textContent = count;
  const batches = Math.ceil(count / 50);
  document.getElementById('send-batch-count').textContent = batches || 0;
  const secs = batches > 1 ? `~${batches * 0.5}s` : (count > 0 ? '< 1s' : '—');
  document.getElementById('send-est-time').textContent = secs;
}

function syncComposeRecipients() {
  renderContactCheckList();
  updateRecipientSummary();
}

// ── CSV Upload ─────────────────────────────────────────────────────────────────
function handleDragOver(e) {
  e.preventDefault();
  document.getElementById('csv-drop-zone').classList.add('drag-over');
}
function handleDragLeave() {
  document.getElementById('csv-drop-zone').classList.remove('drag-over');
}
function handleDrop(e) {
  e.preventDefault();
  handleDragLeave();
  const file = e.dataTransfer.files[0];
  if (file) processCSV(file);
}
function handleCSVUpload(e) {
  const file = e.target.files[0];
  if (file) processCSV(file);
}

function processCSV(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const rows = text.trim().split('\n').map(r => r.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
    const headers = rows[0].map(h => h.toLowerCase());
    const emailIdx = headers.indexOf('email');
    const nameIdx = headers.indexOf('name');

    if (emailIdx === -1) {
      showToast('CSV must have an "email" column', 'error');
      return;
    }

    state.csvRecipients = rows.slice(1).map(row => ({
      email: row[emailIdx] || '',
      name: nameIdx >= 0 ? row[nameIdx] : '',
    })).filter(r => isValidEmail(r.email));

    const preview = document.getElementById('csv-preview');
    const valid = state.csvRecipients.length;
    preview.innerHTML = `
      <div style="color:var(--green);margin-bottom:8px;">✅ ${valid} valid recipient${valid !== 1 ? 's' : ''} loaded from CSV</div>
      <div style="color:var(--text-muted);font-size:0.75rem;">Preview (first 5):</div>
      ${state.csvRecipients.slice(0, 5).map(r => `<div>${r.name ? r.name + ' — ' : ''}${r.email}</div>`).join('')}
      ${valid > 5 ? `<div style="color:var(--text-muted);">...and ${valid - 5} more</div>` : ''}
    `;
    preview.classList.remove('hidden');
    updateRecipientSummary();
    showToast(`${valid} recipients imported from CSV`, 'success');
  };
  reader.readAsText(file);
}

// ── Contacts ───────────────────────────────────────────────────────────────────
function saveContacts() {
  localStorage.setItem('mailblast_contacts', JSON.stringify(state.contacts));
}

function openAddContactModal() {
  document.getElementById('contact-name').value = '';
  document.getElementById('contact-email').value = '';
  document.getElementById('contact-tags').value = '';
  document.getElementById('add-contact-modal').classList.remove('hidden');
}

function addContact() {
  const name = document.getElementById('contact-name').value.trim();
  const email = document.getElementById('contact-email').value.trim();
  const tags = document.getElementById('contact-tags').value.split(',').map(t => t.trim()).filter(Boolean);

  if (!email || !isValidEmail(email)) {
    showToast('Please enter a valid email address', 'error');
    return;
  }
  if (state.contacts.find(c => c.email === email)) {
    showToast('This email already exists in your contacts', 'error');
    return;
  }

  state.contacts.push({ id: Date.now(), name, email, tags, added: new Date().toISOString() });
  saveContacts();
  closeModal('add-contact-modal');
  renderContactsTable();
  renderContactCheckList();
  updateStats();
  showToast(`${name || email} added to contacts`, 'success');
}

function deleteContact(id) {
  if (!confirm('Delete this contact?')) return;
  state.contacts = state.contacts.filter(c => c.id !== id);
  saveContacts();
  renderContactsTable();
  renderContactCheckList();
  updateStats();
  showToast('Contact deleted', 'info');
}

let filteredContacts = null;

function filterContacts(query) {
  const q = query.toLowerCase();
  filteredContacts = q
    ? state.contacts.filter(c => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
    : null;
  renderContactsTable(filteredContacts);
}

function renderContactsTable(list) {
  const tbody = document.getElementById('contacts-tbody');
  const contacts = list || state.contacts;
  if (contacts.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6"><div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none"><path d="M17 21V19C17 17.9391 16.5786 16.9217 15.8284 16.1716C15.0783 15.4214 14.0609 15 13 15H5C3.93913 15 2.92172 15.4214 2.17157 16.1716C1.42143 16.9217 1 17.9391 1 19V21" stroke="#4b5563" stroke-width="1.5"/><circle cx="9" cy="7" r="4" stroke="#4b5563" stroke-width="1.5"/></svg>
      <p>No contacts yet. Add your first contact.</p>
    </div></td></tr>`;
    return;
  }
  tbody.innerHTML = contacts.map(c => `
    <tr>
      <td><input type="checkbox" class="contact-row-check" data-email="${c.email}" onchange="handleTableRowCheck()" /></td>
      <td>${c.name || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td><code style="font-size:0.8rem;color:var(--cyan);">${c.email}</code></td>
      <td>${c.tags.length ? c.tags.map(t => `<span class="badge" style="margin-right:4px;">${t}</span>`).join('') : '—'}</td>
      <td style="color:var(--text-secondary);font-size:0.8rem;">${formatDate(c.added)}</td>
      <td>
        <button class="btn-ghost" style="padding:4px 10px;font-size:0.75rem;" onclick="deleteContact(${c.id})">Delete</button>
      </td>
    </tr>
  `).join('');
}

function toggleTableSelectAll(checkbox) {
  document.querySelectorAll('.contact-row-check').forEach(cb => cb.checked = checkbox.checked);
}
function handleTableRowCheck() {
  const all = document.querySelectorAll('.contact-row-check');
  const checked = document.querySelectorAll('.contact-row-check:checked');
  document.getElementById('select-all-table').checked = all.length > 0 && all.length === checked.length;
}

function exportContacts() {
  if (state.contacts.length === 0) { showToast('No contacts to export', 'info'); return; }
  const csv = ['name,email,tags', ...state.contacts.map(c => `${c.name},${c.email},"${c.tags.join(';')}"`).join('\n')].join('\n');
  downloadFile('contacts.csv', csv, 'text/csv');
  showToast('Contacts exported', 'success');
}

// ── Contact Check List (for Compose tab) ──────────────────────────────────────
function renderContactCheckList() {
  const list = document.getElementById('contact-checklist');
  if (state.contacts.length === 0) {
    list.innerHTML = `<div class="empty-state small">No contacts yet. <a href="#" onclick="showSection('contacts', document.getElementById('nav-contacts'))">Add contacts →</a></div>`;
    return;
  }
  list.innerHTML = state.contacts.map(c => `
    <label class="contact-check-item">
      <input type="checkbox" ${state.selectedContactEmails.has(c.email) ? 'checked' : ''} onchange="toggleContactEmail('${c.email}', this.checked)" />
      <div>
        <div style="color:var(--text-primary);font-size:0.85rem;">${c.name || c.email}</div>
        ${c.name ? `<span>${c.email}</span>` : ''}
      </div>
    </label>
  `).join('');
}

function toggleContactEmail(email, checked) {
  if (checked) state.selectedContactEmails.add(email);
  else state.selectedContactEmails.delete(email);
  document.getElementById('selected-count-badge').textContent = `${state.selectedContactEmails.size} selected`;
  updateRecipientSummary();
}

function toggleSelectAll(checkbox) {
  if (checkbox.checked) {
    state.contacts.forEach(c => state.selectedContactEmails.add(c.email));
  } else {
    state.selectedContactEmails.clear();
  }
  renderContactCheckList();
  document.getElementById('selected-count-badge').textContent = `${state.selectedContactEmails.size} selected`;
  updateRecipientSummary();
}

// ── Templates ──────────────────────────────────────────────────────────────────
function renderTemplates() {
  // Grid in templates section
  const grid = document.getElementById('templates-grid');
  grid.innerHTML = EMAIL_TEMPLATES.map(t => `
    <div class="template-card" onclick="applyTemplate('${t.id}')">
      <div class="template-preview">${t.body.replace(/<[^>]*>/g, ' ').substring(0, 200)}...</div>
      <div class="template-info">
        <h3>${t.name}</h3>
        <p>${t.description}</p>
      </div>
      <div class="template-actions">
        <button class="btn-ghost" style="font-size:0.75rem;padding:5px 12px;" onclick="event.stopPropagation();applyTemplate('${t.id}')">Use Template</button>
      </div>
    </div>
  `).join('');

  // Strip in compose
  const strip = document.getElementById('template-strip');
  strip.innerHTML = EMAIL_TEMPLATES.map(t => `
    <button class="template-chip" onclick="applyTemplate('${t.id}')">${t.name}</button>
  `).join('');
}

function applyTemplate(id) {
  const t = EMAIL_TEMPLATES.find(t => t.id === id);
  if (!t) return;

  document.getElementById('subject').value = t.subject;
  document.getElementById('subject-count').textContent = `${t.subject.length}/78`;

  setBodyType('html');
  document.getElementById('email-body-html').innerHTML = t.body;

  showSection('compose', document.getElementById('nav-compose'));
  showToast(`Template "${t.name}" applied`, 'success');
}

// ── Send Campaign (v2 API: create → recipients → SENDING → poll) ───────────────
async function sendCampaign() {
  const campaignName = document.getElementById('campaign-name').value.trim() || `Campaign ${new Date().toLocaleDateString()}`;
  const fromEmail    = document.getElementById('from-email').value.trim();
  const fromName     = document.getElementById('from-name').value.trim();
  const replyTo      = document.getElementById('reply-to').value.trim();
  const subject      = document.getElementById('subject').value.trim();
  const htmlBody     = document.getElementById('email-body-html').innerHTML.trim();
  const textBody     = document.getElementById('email-body-text').value.trim();
  const recipients   = getActiveRecipients();

  // Validate
  if (!subject)                              return showToast('Subject line is required.', 'error');
  if (!htmlBody && !textBody)                return showToast('Email body is required.', 'error');
  if (!fromEmail || !isValidEmail(fromEmail)) return showToast('A valid From Email is required.', 'error');
  if (recipients.length === 0)               return showToast('At least one recipient is required.', 'error');

  openProgressModal();
  clearPoll();

  let campaignId;
  try {
    // ── Step 1: Create campaign ──────────────────────────────────────────────
    setProgress(10, 'Creating campaign...');
    const { campaign } = await apiFetch('/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name: campaignName, subject, fromEmail, fromName: fromName || 'MailBlast', replyTo: replyTo || undefined, htmlBody, textBody: textBody || undefined }),
    });
    campaignId = campaign.campaignId;

    // ── Step 2: Upload recipients ────────────────────────────────────────────
    setProgress(25, `Uploading ${recipients.length} recipients...`);
    const CHUNK = 500;
    for (let i = 0; i < recipients.length; i += CHUNK) {
      await apiFetch(`/campaigns/${campaignId}/recipients`, {
        method: 'POST',
        body: JSON.stringify({ recipients: recipients.slice(i, i + CHUNK) }),
      });
      setProgress(25 + Math.round(25 * (i + CHUNK) / recipients.length), `Uploading recipients ${Math.min(i + CHUNK, recipients.length)}/${recipients.length}...`);
    }

    // ── Step 3: Transition to SENDING ────────────────────────────────────────
    setProgress(52, 'Preparing dispatch...');
    try {
      await apiFetch(`/campaigns/${campaignId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'SCHEDULED' }),
      });
    } catch (_) { /* may already be scheduled or direct transition allowed */ }

    setProgress(58, 'Starting send...');
    await apiFetch(`/campaigns/${campaignId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'SENDING' }),
    });

    // ── Step 4: Poll progress ─────────────────────────────────────────────────
    setProgress(60, 'Sending emails...');
    await pollCampaignProgress(campaignId, recipients.length);

  } catch (err) {
    clearPoll();
    setProgress(100, 'Error');
    showSendResult({ success: false, error: err.message });
  }
}

function clearPoll() {
  if (state.activePollInterval) { clearInterval(state.activePollInterval); state.activePollInterval = null; }
}

async function pollCampaignProgress(campaignId, total) {
  return new Promise((resolve) => {
    state.activePollInterval = setInterval(async () => {
      try {
        const stats = await apiFetch(`/campaigns/${campaignId}/stats`);
        const done  = (stats.sent || 0) + (stats.failed || 0) + (stats.suppressed || 0);
        const pct   = total > 0 ? Math.min(60 + Math.round(38 * done / total), 98) : 98;
        setProgress(pct, `Sending... ${done}/${total} processed`);

        if (stats.status === 'COMPLETED' || stats.status === 'FAILED' || stats.status === 'CANCELLED') {
          clearPoll();
          setProgress(100, stats.status === 'COMPLETED' ? 'Complete!' : stats.status);

          // Record in local history
          const c = {
            id: campaignId, name: document.getElementById('campaign-name').value.trim() || 'Campaign',
            subject: document.getElementById('subject').value.trim(),
            sent: stats.sent || 0, delivered: stats.sent || 0, failed: stats.failed || 0,
            total: stats.recipientCount || total,
            date: new Date().toISOString(),
            status: (stats.failed || 0) === 0 ? 'success' : (stats.sent || 0) > 0 ? 'partial' : 'failed',
          };
          state.campaigns.push(c);
          localStorage.setItem('mailblast_campaigns', JSON.stringify(state.campaigns));
          updateStats();
          renderCampaignsTable();
          renderHistoryTable();

          showSendResult({
            success: stats.status === 'COMPLETED' && (stats.failed || 0) === 0,
            summary: {
              sent: stats.sent || 0,
              failed: stats.failed || 0,
              total: stats.recipientCount || total,
              lastError: stats.lastError || null,
            },
          });
          resolve();
        }
      } catch (e) {
        clearPoll();
        showSendResult({ success: false, error: e.message });
        resolve();
      }
    }, 1000);
  });
}

function openProgressModal() {
  document.getElementById('progress-title').textContent = 'Sending Campaign...';
  document.getElementById('send-result').classList.add('hidden');
  document.getElementById('progress-close-btn').classList.add('hidden');
  document.getElementById('send-progress-modal').classList.remove('hidden');
}

function setProgress(pct, label) {
  document.getElementById('progress-bar-fill').style.width = `${pct}%`;
  document.getElementById('progress-label').textContent = label;
  document.getElementById('progress-pct').textContent = `${pct}%`;
}

function showSendResult(data) {
  document.getElementById('progress-title').textContent = data.success ? 'Campaign Sent! 🎉' : 'Campaign Complete';
  const resultEl = document.getElementById('send-result');
  const iconEl = document.getElementById('result-icon');
  const summaryEl = document.getElementById('result-summary');
  const detailsEl = document.getElementById('result-details');

  iconEl.textContent = data.success ? '✅' : (data.summary?.sent > 0 ? '⚠️' : '❌');
  if (data.summary) {
    summaryEl.textContent = `${data.summary.sent} of ${data.summary.total} emails delivered`;
    detailsEl.innerHTML = `
      <div>✅ Successfully sent: <strong>${data.summary.sent}</strong></div>
      ${data.summary.failed > 0 ? `<div style="color:var(--red);margin-top:6px;">❌ Failed: <strong>${data.summary.failed}</strong></div>` : ''}
      ${data.summary.lastError ? `<div style="color:#ef4444;font-size:0.8rem;margin-top:10px;background:rgba(239,68,68,0.1);padding:10px;border-radius:8px;border:1px solid rgba(239,68,68,0.3);text-align:left;line-height:1.4;"><strong>AWS Error:</strong> ${data.summary.lastError}</div>` : ''}
    `;
  } else {
    summaryEl.textContent = 'An error occurred';
    detailsEl.innerHTML = `<div style="color:var(--red);">${data.error || 'Unknown error'}</div>`;
  }

  resultEl.classList.remove('hidden');
  document.getElementById('progress-close-btn').classList.remove('hidden');
  showToast(data.success ? 'Campaign sent successfully!' : 'Campaign sent with some errors', data.success ? 'success' : 'error');
}

// ── Draft ──────────────────────────────────────────────────────────────────────
function saveDraft() {
  const draft = {
    id: Date.now(),
    name: document.getElementById('campaign-name').value || 'Untitled Draft',
    fromEmail: document.getElementById('from-email').value,
    subject: document.getElementById('subject').value,
    body: document.getElementById('email-body-html').innerHTML,
    saved: new Date().toISOString(),
  };
  state.drafts.push(draft);
  localStorage.setItem('mailblast_drafts', JSON.stringify(state.drafts));
  showToast('Draft saved', 'success');
}

// ── Stats & Tables ─────────────────────────────────────────────────────────────
async function updateStats() {
  // Try fetching live stats from the API server first
  try {
    const data = await apiFetch('/stats');
    animateCount('stat-sent',      data.totalSent      ?? 0);
    animateCount('stat-delivered', data.totalDelivered ?? 0);
    animateCount('stat-campaigns', data.totalCampaigns ?? state.campaigns.length);
    animateCount('stat-contacts',  data.totalContacts  ?? state.contacts.length);
    return;
  } catch (_) { /* fall back to local */ }
  // Fallback: local in-memory state
  animateCount('stat-sent',      state.campaigns.reduce((s, c) => s + (c.sent      || 0), 0));
  animateCount('stat-delivered', state.campaigns.reduce((s, c) => s + (c.delivered || 0), 0));
  animateCount('stat-campaigns', state.campaigns.length);
  animateCount('stat-contacts',  state.contacts.length);
}

function animateCount(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = parseInt(el.textContent) || 0;
  const duration = 600;
  const startTime = performance.now();
  const update = (now) => {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(start + (target - start) * eased).toLocaleString();
    if (progress < 1) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

function renderCampaignsTable() {
  const tbody = document.getElementById('campaigns-tbody');
  const recent = [...state.campaigns].reverse().slice(0, 5);
  if (recent.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6"><div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none"><path d="M3 8L10.89 13.26C11.2187 13.4793 11.6049 13.5963 12 13.5963C12.3951 13.5963 12.7813 13.4793 13.11 13.26L21 8M5 19H19C19.5304 19 20.0391 18.7893 20.4142 18.4142C20.7893 18.0391 21 17.5304 21 17V7C21 6.46957 20.7893 5.96086 20.4142 5.58579C20.0391 5.21071 19.5304 5 19 5H5C4.46957 5 3.96086 5.21071 3.58579 5.58579C3.21071 5.96086 3 6.46957 3 7V17C3 17.5304 3.21071 18.0391 3.58579 18.4142C3.96086 18.7893 4.46957 19 5 19Z" stroke="#4b5563" stroke-width="1.5"/></svg>
      <p>No campaigns yet. <a href="#" onclick="showSection('compose', document.getElementById('nav-compose'))">Create your first one →</a></p>
    </div></td></tr>`;
    return;
  }
  tbody.innerHTML = recent.map(c => `
    <tr>
      <td><strong>${c.name}</strong></td>
      <td>${c.sent?.toLocaleString() || 0}</td>
      <td>${c.delivered?.toLocaleString() || 0}</td>
      <td style="color:${c.failed > 0 ? 'var(--red)' : 'var(--text-muted)'}">${c.failed || 0}</td>
      <td style="color:var(--text-secondary);font-size:0.8rem;">${formatDate(c.date)}</td>
      <td>${statusBadge(c.status)}</td>
    </tr>
  `).join('');
}

function renderHistoryTable() {
  const tbody = document.getElementById('history-tbody');
  if (state.campaigns.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7"><div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#4b5563" stroke-width="1.5"/><path d="M12 6V12L16 14" stroke="#4b5563" stroke-width="1.5" stroke-linecap="round"/></svg>
      <p>No campaigns sent yet.</p>
    </div></td></tr>`;
    return;
  }
  tbody.innerHTML = [...state.campaigns].reverse().map(c => `
    <tr>
      <td><strong>${c.name}</strong></td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.subject || '—'}</td>
      <td>${c.sent?.toLocaleString() || 0}</td>
      <td>${c.delivered?.toLocaleString() || 0}</td>
      <td style="color:${c.failed > 0 ? 'var(--red)' : 'var(--text-muted)'}">${c.failed || 0}</td>
      <td style="color:var(--text-secondary);font-size:0.8rem;">${formatDate(c.date)}</td>
      <td>${statusBadge(c.status)}</td>
    </tr>
  `).join('');
}

function statusBadge(status) {
  const map = {
    success: ['success', '✓ Delivered'],
    partial: ['partial', '⚠ Partial'],
    failed: ['failed', '✕ Failed'],
    draft: ['draft', '○ Draft'],
  };
  const [cls, label] = map[status] || ['draft', status];
  return `<span class="status-badge ${cls}">${label}</span>`;
}

// ── Contacts rendering on page load ───────────────────────────────────────────
function renderContactsTab() {
  renderContactsTable();
  renderContactCheckList();
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type]}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function downloadFile(filename, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Close modals on backdrop click
document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal(backdrop.id);
  });
});
