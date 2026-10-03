// Shared helpers for image provider adapters
import { fetchWithRedirectChecks } from "../../../src/lib/net/ssrf.js";

export const POLL_INTERVAL_MS = 1500;
export const POLL_TIMEOUT_MS = 120000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map OpenAI size to provider-specific aspect ratio
export function sizeToAspectRatio(size) {
  if (!size || typeof size !== "string") return "1:1";
  const map = {
    "1024x1024": "1:1",
    "1024x1792": "9:16",
    "1792x1024": "16:9",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
  };
  return map[size] || "1:1";
}

// Fetch URL → base64 (for providers returning image URLs)
//
// The URL arrives in an upstream response body, which is as
// attacker-controllable as anything in a request: a custom openai-compatible or
// custom-embedding node points at a host the operator chose, and that host
// decides which url to hand back. Fetching it verbatim let the server retrieve
// 169.254.169.254, a private range, or its own neighbours and return the bytes
// as the generated image. fetchWithRedirectChecks also covers the redirect chain.
export async function urlToBase64(url) {
  const res = await fetchWithRedirectChecks(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}
