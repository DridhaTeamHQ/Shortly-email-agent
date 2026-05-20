export type ScrapedArticle = {
  title: string;
  url: string;
  summary: string;
  source?: string;
  topic?: string;
  note?: string;
};

export async function sendScrapedArticle(article: ScrapedArticle, endpoint: string) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(article)
  });

  if (!response.ok) {
    throw new Error(`Article email send failed: ${response.status}`);
  }

  return response.json();
}
