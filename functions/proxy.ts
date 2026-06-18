const API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedKuwoHost(hostname: string): boolean {
  if (!hostname) return false;
  return KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (!isAllowedKuwoHost(parsed.hostname)) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.protocol = "http:";
    return parsed;
  } catch {
    return null;
  }
}

async function proxyKuwoAudio(targetUrl: string, request: Request): Promise<Response> {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", { status: 400 });
  }

  const init: RequestInit = {
    method: request.method,
    headers: {
      "User-Agent": BROWSER_UA,
      "Referer": "https://www.kuwo.cn/",
    },
  };

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    (init.headers as Record<string, string>)["Range"] = rangeHeader;
  }

  const upstream = await fetch(normalized.toString(), init);
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function proxyApiRequest(url: URL, request: Request, waitUntil?: (promise: Promise<any>) => void): Promise<Response> {
  try {
    const cache = typeof caches !== "undefined" ? caches.default : null;
    
    const cacheUrl = new URL(url.toString());
    cacheUrl.searchParams.delete("s");
    
    const cacheKey = new Request(cacheUrl.toString(), {
      method: request.method,
      headers: request.headers
    });

    if (request.method === "GET" && cache) {
      try {
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
          console.log(`[Cache HIT] ${url.toString()}`);
          const response = new Response(cachedResponse.body, cachedResponse);
          response.headers.set("X-Cache-Status", "HIT");
          response.headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
          return response;
        }
      } catch (err) {
        console.warn(`[Cache ERROR] ${url.toString()}`, err);
      }
    }

    console.log(`[Cache MISS] Fetching from upstream: ${url.toString()}`);

    const apiUrl = new URL(API_BASE_URL);
    url.searchParams.forEach((value, key) => {
      if (key === "target" || key === "callback") {
        return;
      }
      apiUrl.searchParams.set(key, value);
    });

    if (!apiUrl.searchParams.has("types")) {
      return new Response("Missing types", { status: 400 });
    }

    const testHeaders = createCorsHeaders();
    testHeaders.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify({ status: "ok", mode: "direct", ts: Date.now() }), {
      status: 200,
      headers: testHeaders,
    });
  } catch (error) {
    console.error(`[proxyApiRequest Error]`, error);
    const errHeaders = createCorsHeaders();
    errHeaders.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify({ error: "Internal proxy error", detail: String(error) }), {
      status: 502,
      headers: errHeaders,
    });
  }
}

export async function onRequest({ request, waitUntil }: { request: Request, waitUntil: (promise: Promise<any>) => void }): Promise<Response> {
  if (request.method === "OPTIONS") {
    return handleOptions();
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");

  if (target) {
    return proxyKuwoAudio(target, request);
  }

  return proxyApiRequest(url, request, waitUntil);
}
