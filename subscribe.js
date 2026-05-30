const cfg = window.SHORTLY || {};
const form = document.querySelector("#subscribeForm");
const emailInput = document.querySelector("#subEmail");
const nameInput = document.querySelector("#subName");
const button = document.querySelector("#subscribeButton");
const message = document.querySelector("#subscribeMessage");
const xLink = document.querySelector("#xLink");
const linkedinLink = document.querySelector("#linkedinLink");

if (cfg.twitterUrl && xLink) {
  xLink.href = cfg.twitterUrl;
}

if (cfg.linkedinUrl && linkedinLink) {
  linkedinLink.href = cfg.linkedinUrl;
}

function setMessage(text, type) {
  message.textContent = text;
  message.className = `subscribe-message ${type}`;
}

async function api(path, body) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.anonKey) {
    headers.apikey = cfg.anonKey;
    headers.Authorization = `Bearer ${cfg.anonKey}`;
  }

  const response = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!cfg.subscribers || !cfg.anonKey) {
    setMessage("This page is not configured yet. Please try again after deployment.", "error");
    return;
  }

  button.disabled = true;
  setMessage("Adding you to Shortly...", "");

  try {
    const data = await api(cfg.subscribers, {
      action: "add",
      email: emailInput.value.trim(),
      full_name: nameInput.value.trim()
    });

    form.reset();

    if (data.resubscribed) {
      setMessage("Welcome back. Your subscription is active again.", "success");
    } else if (data.existing) {
      setMessage("You're already subscribed to Shortly Daily Wrap.", "success");
    } else {
      setMessage("You're in. Watch your inbox for the next Shortly Daily Wrap.", "success");
    }
  } catch (error) {
    setMessage(error.message || "Something went wrong. Please try again.", "error");
  } finally {
    button.disabled = false;
  }
});
