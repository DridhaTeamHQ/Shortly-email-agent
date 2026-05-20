const fields = {
  title: document.querySelector("#title"),
  url: document.querySelector("#url"),
  summary: document.querySelector("#summary"),
  source: document.querySelector("#source"),
  topic: document.querySelector("#topic"),
  note: document.querySelector("#note")
};

const preview = {
  source: document.querySelector("#previewSource"),
  title: document.querySelector("#previewTitle"),
  summary: document.querySelector("#previewSummary"),
  link: document.querySelector("#previewLink"),
  status: document.querySelector("#agentStatus"),
  toast: document.querySelector("#toast")
};

const endpoint = window.SHORTLY_EMAIL_ENDPOINT || "";

function articlePayload() {
  return {
    title: fields.title.value.trim(),
    url: fields.url.value.trim(),
    summary: fields.summary.value.trim(),
    source: fields.source.value.trim(),
    topic: fields.topic.value.trim(),
    note: fields.note.value.trim()
  };
}

function updatePreview() {
  const article = articlePayload();
  preview.source.textContent = article.source || "Shortly Digest";
  preview.title.textContent = article.title || "Your article title appears here";
  preview.summary.textContent = article.summary || "Add a summary and the preview will update before sending.";
  preview.link.href = article.url || "#";
}

function showToast(message) {
  preview.toast.textContent = message;
  preview.toast.classList.add("show");
  window.setTimeout(() => preview.toast.classList.remove("show"), 3200);
}

async function sendArticle() {
  const form = document.querySelector("#articleForm");
  if (!form.reportValidity()) return;

  const article = articlePayload();
  preview.status.textContent = "Sending";

  if (!endpoint) {
    preview.status.textContent = "Demo";
    showToast("UI payload is ready. Set window.SHORTLY_EMAIL_ENDPOINT to call the Supabase Edge Function.");
    return;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(article)
    });

    if (!response.ok) {
      throw new Error(`Send failed with ${response.status}`);
    }

    const result = await response.json();
    preview.status.textContent = "Sent";
    showToast(`Sent to ${result.sent ?? 0} subscribers. Failed: ${result.failed ?? 0}.`);
  } catch (error) {
    preview.status.textContent = "Failed";
    showToast(error.message);
  }
}

Object.values(fields).forEach((field) => field.addEventListener("input", updatePreview));
document.querySelector("#sendButton").addEventListener("click", sendArticle);
updatePreview();
