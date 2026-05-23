// Shortly dashboard — review, approve, manage subscribers, send digest.

const cfg = window.SHORTLY;
const DAILY_CAP = cfg.dailyCap ?? 10;

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2800);
}

async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.anonKey) {
    headers["apikey"] = cfg.anonKey;
    headers["Authorization"] = `Bearer ${cfg.anonKey}`;
  }
  const r = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

const todayUtc = () => new Date().toISOString().slice(0, 10);
const isApprovedToday = (a) =>
  a.status === "approved" && (a.reviewed_at ?? "").slice(0, 10) === todayUtc();

// ---------- state + rendering ----------
const state = { articles: [], subscribers: [], section: "review" };

function approvedTodayCount() {
  return state.articles.filter(isApprovedToday).length;
}

function refreshChrome() {
  const approved = approvedTodayCount();
  const counts = sectionCounts();
  const pending = state.articles.filter((a) => a.status === "summarized").length;
  const rejected = state.articles.filter((a) => a.status === "rejected").length;
  const subs = state.subscribers.filter((s) => s.status === "subscribed").length;

  $("#badgeReview").textContent = pending;
  $("#badgeApproved").textContent = `${approved}/${DAILY_CAP}`;
  $("#badgeRejected").textContent = rejected;
  $("#badgeSubs").textContent = subs;

  const send = $("#sendDigest");
  send.textContent = `Send digest (${counts.wrapped}W + ${counts.ahead}A)`;
  // Allow sending even without full cap — fallback will auto-select remaining
  send.disabled = approved === 0 || subs === 0;

  const titles = {
    review: ["Review queue", `Approve articles for today's digest. Wrapped: ${counts.wrapped}/5, Ahead: ${counts.ahead}/5`],
    approved: ["Approved", `Today's selection. ${counts.wrapped} Wrapped + ${counts.ahead} Ahead = ${approved} total.`],
    rejected: ["Rejected", "Articles you removed from the queue."],
    subscribers: ["Subscribers", `${subs} active subscriber${subs === 1 ? "" : "s"}.`],
    scraper: ["Scraper handoff", "Submit one article — we summarize and queue it."]
  };
  const [t, sub] = titles[state.section];
  $("#sectionTitle").textContent = t;
  $("#sectionSub").textContent = sub;
}

function sectionCounts() {
  const approved = state.articles.filter(isApprovedToday);
  return {
    wrapped: approved.filter((a) => a.section !== "ahead").length,
    ahead: approved.filter((a) => a.section === "ahead").length
  };
}

function cardHtml(a, mode) {
  const text = a.edited_summary || a.summary || "";
  const date = new Date(a.scraped_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = new Date(a.scraped_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const source = a.source ? `<span class="source-pill">${esc(a.source)}</span>` : "";
  const topic = a.topic ? `<span class="topic-chip">${esc(a.topic)}</span>` : "";
  const atCap = approvedTodayCount() >= DAILY_CAP;
  const sec = a.section || "wrapped";

  // Section picker (wrapped / ahead)
  const sectionPicker = mode !== "rejected" ? `
    <div class="section-picker">
      <label class="section-label">Section:</label>
      <select data-role="section">
        <option value="wrapped" ${sec === "wrapped" ? "selected" : ""}>Wrapped</option>
        <option value="ahead" ${sec === "ahead" ? "selected" : ""}>Ahead</option>
      </select>
    </div>` : "";

  let actions = "";
  if (mode === "review") {
    actions = `
      <div class="actions">
        ${sectionPicker}
        <button class="btn-save"    data-action="edit">Save edit</button>
        <button class="btn-reject"  data-action="reject">Reject</button>
        <button class="btn-approve" data-action="approve" ${atCap ? "disabled" : ""}>
          ${atCap ? "Limit reached" : "Approve"}
        </button>
      </div>`;
  } else if (mode === "approved") {
    actions = `
      <div class="actions">
        ${sectionPicker}
        <button class="btn-save"   data-action="edit">Save edit</button>
        <button class="btn-reject" data-action="reject">Remove</button>
      </div>`;
  }

  const sectionTag = `<span class="tag section-${sec}">${sec}</span>`;
  const readonly = mode === "rejected" ? "readonly" : "";
  return `
    <article class="card" data-id="${a.id}">
      <header>
        <div class="card-head">
          <div class="chips">${source}${topic}${sectionTag}<span class="tag ${a.status}">${a.status}</span></div>
          <h3>${esc(a.title)}</h3>
          <div class="meta">${date} · ${time} · <a href="${esc(a.url)}" target="_blank" rel="noreferrer">Open source</a></div>
        </div>
      </header>
      <textarea data-role="summary" ${readonly}>${esc(text)}</textarea>
      ${actions}
    </article>`;
}

function renderReview() {
  const items = state.articles.filter((a) => a.status === "summarized");
  const node = $("#reviewList");
  node.innerHTML = items.length
    ? items.map((a) => cardHtml(a, "review")).join("")
    : `<p class="muted">No articles to review. Submit one from the Scraper tab.</p>`;
}

function renderApproved() {
  const items = state.articles.filter(isApprovedToday);
  const node = $("#approvedList");
  node.innerHTML = items.length
    ? items.map((a) => cardHtml(a, "approved")).join("")
    : `<p class="muted">Nothing approved yet today.</p>`;
}

function renderRejected() {
  const items = state.articles.filter((a) => a.status === "rejected");
  const node = $("#rejectedList");
  node.innerHTML = items.length
    ? items.map((a) => cardHtml(a, "rejected")).join("")
    : `<p class="muted">No rejected articles.</p>`;
}

function renderSubscribers() {
  const rows = state.subscribers
    .map(
      (s) => `
      <tr data-id="${s.id}">
        <td>${esc(s.email)}</td>
        <td>${esc(s.full_name || "")}</td>
        <td><span class="dot ${s.status}"></span>${esc(s.status)}</td>
        <td class="row-actions">
          ${s.status === "subscribed"
            ? `<button class="btn-ghost" data-action="unsubscribe">Unsubscribe</button>`
            : `<button class="btn-ghost" data-action="subscribe">Re-subscribe</button>`}
          <button class="btn-ghost" data-action="delete">Delete</button>
        </td>
      </tr>`
    )
    .join("");
  $("#subRows").innerHTML = rows || `<tr><td colspan="4" class="muted" style="padding:18px">No subscribers yet.</td></tr>`;
}

function renderAll() {
  refreshChrome();
  renderReview();
  renderApproved();
  renderRejected();
  renderSubscribers();
}

// ---------- data loaders ----------
async function loadArticles() {
  const data = await api("GET", `${cfg.list}?status=all&limit=200`);
  state.articles = data.articles || [];
}
async function loadSubscribers() {
  const data = await api("GET", cfg.subscribers);
  state.subscribers = data.subscribers || [];
}

async function reload() {
  try {
    await Promise.all([loadArticles(), loadSubscribers()]);
    renderAll();
  } catch (e) {
    toast(`Load failed: ${e.message}`);
  }
}

// ---------- actions ----------
async function handleArticleAction(card, action) {
  const id = card.dataset.id;
  const summary = card.querySelector("textarea")?.value.trim();
  const section = card.querySelector("select[data-role=section]")?.value || "wrapped";
  const body = { id, action, reviewer: cfg.reviewer, section };
  if (action === "edit" || action === "approve") body.edited_summary = summary;
  try {
    await api("POST", cfg.review, body);
    await reload();
    toast(action === "edit" ? "Summary saved." : `Article ${action}d.`);
  } catch (e) {
    toast(`Failed: ${e.message}`);
  }
}

async function handleSubscriberAction(row, action) {
  const id = row.dataset.id;
  try {
    if (action === "delete") {
      await api("POST", cfg.subscribers, { action: "delete", id });
    } else {
      const status = action === "subscribe" ? "subscribed" : "unsubscribed";
      await api("POST", cfg.subscribers, { action: "update", id, status });
    }
    await reload();
  } catch (e) {
    toast(`Failed: ${e.message}`);
  }
}

// ---------- section nav ----------
function showSection(name) {
  state.section = name;
  $$(".section").forEach((s) => s.classList.toggle("active", s.dataset.section === name));
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.section === name));
  refreshChrome();
}

// ---------- mobile menu ----------
function closeMenu() {
  $("#sidebar")?.classList.remove("open");
  $("#backdrop")?.classList.remove("show");
}
function openMenu() {
  $("#sidebar")?.classList.add("open");
  $("#backdrop")?.classList.add("show");
}
$("#menuToggle")?.addEventListener("click", () => {
  $("#sidebar").classList.contains("open") ? closeMenu() : openMenu();
});
$("#backdrop")?.addEventListener("click", closeMenu);

// ---------- wire up ----------
$$(".nav-item").forEach((btn) =>
  btn.addEventListener("click", () => {
    showSection(btn.dataset.section);
    closeMenu();
  })
);

// Article action delegation
["#reviewList", "#approvedList", "#rejectedList"].forEach((sel) => {
  $(sel).addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const card = btn.closest(".card");
    handleArticleAction(card, btn.dataset.action);
  });
});

// Subscriber actions
$("#subRows").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  handleSubscriberAction(btn.closest("tr"), btn.dataset.action);
});

$("#subForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#subEmail").value.trim();
  const full_name = $("#subName").value.trim();
  if (!email) return;
  try {
    await api("POST", cfg.subscribers, { action: "add", email, full_name });
    $("#subEmail").value = "";
    $("#subName").value = "";
    await reload();
    toast("Subscriber added.");
  } catch (e) {
    toast(`Failed: ${e.message}`);
  }
});

$("#scrapeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    title: $("#scTitle").value.trim(),
    url: $("#scUrl").value.trim(),
    source: $("#scSource").value.trim(),
    topic: $("#scTopic").value.trim(),
    raw_content: $("#scRaw").value.trim()
  };
  toast("Summarizing…");
  try {
    const res = await api("POST", cfg.submit, payload);
    const out = $("#scraperResult");
    out.textContent = JSON.stringify(res, null, 2);
    out.classList.remove("hidden");
    $("#scrapeForm").reset();
    await reload();
    toast("Article queued for review.");
  } catch (e) {
    toast(`Failed: ${e.message}`);
  }
});

$("#sendDigest").addEventListener("click", async () => {
  const approved = approvedTodayCount();
  const subCount = state.subscribers.filter((s) => s.status === "subscribed").length;
  const fallbackMsg = approved < DAILY_CAP
    ? `\n\nOnly ${approved}/${DAILY_CAP} approved — the rest will be auto-selected by rank.`
    : "";
  if (!confirm(`Send digest to ${subCount} subscribers?${fallbackMsg}`)) return;
  try {
    const res = await api("POST", cfg.digest);
    const autoMsg = res.autoSelected ? " (with auto-selected articles)" : "";
    toast(`Sent to ${res.sent ?? 0} subscribers${autoMsg}.`);
    await reload();
    showSection("review");
  } catch (e) {
    toast(`Failed: ${e.message}`);
  }
});

reload();
