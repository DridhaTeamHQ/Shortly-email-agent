const cfg = window.SHORTLY || {};
const form = document.querySelector("#subscribeForm");
const emailInput = document.querySelector("#subEmail");
const nameInput = document.querySelector("#subName");
const button = document.querySelector("#subscribeButton");
const message = document.querySelector("#subscribeMessage");
const xLink = document.querySelector("#xLink");
const linkedinLink = document.querySelector("#linkedinLink");
const planInputs = [...document.querySelectorAll('input[name="plan"]')];
const categoryField = document.querySelector("#categoryField");
const categorySelect = document.querySelector("#subCategory");

function selectedPlan() {
  return planInputs.find((input) => input.checked)?.value || "daily-wrap";
}

// Show the category dropdown only for plans that need one.
function syncCategoryField() {
  const needsCategory = selectedPlan() !== "daily-wrap";
  if (categoryField) categoryField.hidden = !needsCategory;
  if (categorySelect) categorySelect.required = needsCategory;
}

planInputs.forEach((input) => input.addEventListener("change", syncCategoryField));
syncCategoryField();

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

  const plan = selectedPlan();
  const category = categorySelect ? categorySelect.value : "";
  if (plan !== "daily-wrap" && !category) {
    setMessage("Please choose a category for this plan.", "error");
    return;
  }

  button.disabled = true;
  setMessage("Adding you to Shortly...", "");

  try {
    const data = await api(cfg.subscribers, {
      action: "add",
      email: emailInput.value.trim(),
      full_name: nameInput.value.trim(),
      plan,
      category: plan === "daily-wrap" ? null : category
    });

    form.reset();

    if (data.resubscribed) {
      setMessage("Welcome back. Your subscription is active again.", "success");
    } else if (data.existing) {
      setMessage("You're already subscribed to Shortly Daily Wrap.", "success");
    } else if (data.welcome_sent === false) {
      setMessage("You're subscribed, but we could not send the welcome email yet. Your daily emails remain active.", "success");
    } else {
      setMessage("You're in. Check your inbox for a welcome from Daily Mattr.", "success");
    }
  } catch (error) {
    setMessage(error.message || "Something went wrong. Please try again.", "error");
  } finally {
    button.disabled = false;
  }
});
