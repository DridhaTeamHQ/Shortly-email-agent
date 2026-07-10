const REAL_ESTATE_SIGNALS = /\b(real estate|property|properties|housing|home|apartment|flat|villa|builder|developer|construction|rera|fsi|carpet area|super built|mortgage|rent|lease|office space|commercial realty|warehouse|plot|land parcel|possession|housing project|residential project|realty)\b/i;
const REAL_ESTATE_BLOCKLIST = /\b(cricket|ipl|football|soccer|hockey|tennis|badminton|match|wicket|bowler|batter|run rate|goal|league|tournament|olympics|sports?)\b/i;

export function matchesCategoryContent(category: string, title = "", summary = ""): boolean {
  const text = `${title} ${summary}`.trim();
  if (!text) return false;
  if (/^real estate$/i.test(category.trim())) {
    return REAL_ESTATE_SIGNALS.test(text) && !REAL_ESTATE_BLOCKLIST.test(text);
  }
  return true;
}
