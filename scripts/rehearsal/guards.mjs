const SYNTHETIC_SLUG = /^dev-play-[0-9a-f]{12}$/;
const CONTROLLER_ORIGIN = "http://127.0.0.1:3100";
const METHODS = new Set(["GET", "HEAD", "POST", "PATCH"]);
const POST_PATHS = new Set([
  "/api/session/bootstrap", "/api/session/claim", "/api/session/operator", "/api/session/release",
  "/api/profile/submit", "/api/state/sync", "/api/admin",
  "/api/game/more-data", "/api/game/guess", "/api/game/ensemble-shared",
  "/api/game/ensemble-vote", "/api/game/ensemble-end-discussion", "/api/game/intro-ack",
]);

/** Validate the browser's original request before rewriting upstream headers. */
export function isLocalRequest({ host, origin, method, fetchSite } = {}, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !METHODS.has(method)) return false;
  if (host !== `127.0.0.1:${port}`) return false;
  if (fetchSite !== undefined && fetchSite !== null &&
      !["", "same-origin", "same-site", "none"].includes(fetchSite)) return false;
  const ownOrigin = `http://127.0.0.1:${port}`;
  if (method === "GET" || method === "HEAD") {
    return origin === undefined || origin === null || origin === ownOrigin || origin === CONTROLLER_ORIGIN;
  }
  return origin === ownOrigin;
}

function safePath(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.startsWith("//")) return false;
  if (/[\\?#\u0000-\u0020\u007f]/.test(pathname) || /%(?:2f|5c|00|25)/i.test(pathname)) return false;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  return !decoded.includes("..") && !decoded.includes("%") &&
    !/[\\?#\u0000-\u0020\u007f]/.test(decoded) && !decoded.includes("//");
}

/** Paths are relative to the one fixed rehearsal upstream, never arbitrary URLs. */
export function isAllowedActorPath(method, pathname, slug) {
  if (!SYNTHETIC_SLUG.test(slug) || !METHODS.has(method) || !safePath(pathname)) return false;
  if (method === "GET" || method === "HEAD") {
    if (pathname === "/" || pathname === `/e/${slug}` || pathname === "/favicon.ico") return true;
    if (pathname.startsWith("/_next/static/") && pathname.length > "/_next/static/".length && !pathname.endsWith("/")) return true;
    return method === "GET" && pathname === "/api/state";
  }
  if (method === "PATCH") return pathname === "/api/profile";
  return POST_PATHS.has(pathname);
}

/** JSON mutations must retain the proxy's own newly-created synthetic event. */
export function validateActorPayload(pathname, payload, slug) {
  if (!SYNTHETIC_SLUG.test(slug) || !payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const method = pathname === "/api/profile" ? "PATCH" : "POST";
  return isAllowedActorPath(method, pathname, slug) && Object.hasOwn(payload, "slug") && payload.slug === slug;
}
