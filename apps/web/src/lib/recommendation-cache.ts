import type { RecommendationsResponse } from "@/lib/profile";

/** Keep successful recommendation responses available across route changes. */
const TTL_MS = 5 * 60 * 1000;

const responses = new Map<string, { response: RecommendationsResponse; loadedAt: number }>();

function isFresh(loadedAt: number): boolean {
  return Date.now() - loadedAt <= TTL_MS;
}

function key(profileToken: string, limit: number): string {
  return `${profileToken}:${limit}`;
}

export function readCachedRecommendations(
  profileToken: string | null,
  limit: number,
): RecommendationsResponse | null {
  if (profileToken === null) return null;

  const entry = responses.get(key(profileToken, limit));
  return entry && isFresh(entry.loadedAt) ? entry.response : null;
}

export function cacheRecommendations(
  profileToken: string,
  limit: number,
  response: RecommendationsResponse,
): void {
  responses.set(key(profileToken, limit), { response, loadedAt: Date.now() });
}
