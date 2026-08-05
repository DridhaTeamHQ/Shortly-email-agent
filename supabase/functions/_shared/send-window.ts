import { json } from "./http.ts";

const SEND_WINDOW_TIME_ZONE = "Asia/Kolkata";
const SEND_WINDOW_HOUR = 9;

function istParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: SEND_WINDOW_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { hour: value("hour"), minute: value("minute") };
}

export function inIstSendWindow(now = new Date()): boolean {
  return istParts(now).hour === SEND_WINDOW_HOUR;
}

export function istSendWindowLabel(): string {
  return "09:00-09:59 IST";
}

export function istCurrentTimeLabel(now = new Date()): string {
  const { hour, minute } = istParts(now);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} IST`;
}

export function requireIstSendWindow({ dryRun = false }: { dryRun?: boolean } = {}): Response | null {
  if (dryRun || inIstSendWindow()) return null;
  return json({
    error: `Sending is allowed only during ${istSendWindowLabel()}. Current time: ${istCurrentTimeLabel()}.`,
    allowedWindow: istSendWindowLabel(),
    currentIstTime: istCurrentTimeLabel(),
  }, 403);
}
