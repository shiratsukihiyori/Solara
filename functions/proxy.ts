const API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];
const NETEASE_API_BASE = "https://music.163.com/api";

function createCorsHeaders(init?: Headers | Record<string, string>): Headers {
  const headers = new Headers();
  if (init) {
    const entries = init instanceof Headers ? init.entries() : Object.entries(init);
    for (const [key, value] of entries) {
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

async function fetchNeteasePlaylistDirect(playlistId: string, limit: number): Promise<Response> {
  const PLAYLIST_HEADERS = {
    "User-Agent": BROWSER_UA,
    "Referer": "https://music.163.com/",
    "Accept": "application/json",
  };

  // Step 1: get track IDs from v6 API (returns all trackIds + first 10 tracks)
  const v6Url = `${NETEASE_API_BASE}/v6/playlist/detail?id=${playlistId}&n=1000&s=0`;
  console.log(`[Netease Direct] Fetching v6: ${v6Url}`);
  const v6Resp = await fetch(v6Url, { headers: PLAYLIST_HEADERS });
  const v6Data: any = await v6Resp.json();
  if (v6Data.code !== 200 || !v6Data.playlist) {
    return new Response(JSON.stringify({ error: "Netease direct fetch failed" }), {
      status: 502,
      headers: createCorsHeaders({ "Content-Type": "application/json; charset=utf-8" }),
    });
  }

  const existingTracks: any[] = Array.isArray(v6Data.playlist.tracks) ? v6Data.playlist.tracks : [];
  const trackIds: Array<{ id: number }> = Array.isArray(v6Data.playlist.trackIds) ? v6Data.playlist.trackIds : [];

  // Step 2: collect IDs not in existing tracks
  const existingIdSet = new Set(existingTracks.map((t: any) => t.id));
  const missingIds = trackIds.filter((ti: { id: number }) => !existingIdSet.has(ti.id)).map((ti: { id: number }) => ti.id);

  if (missingIds.length > 0) {
    // Step 3: fetch missing track details via POST to v3/song/detail
    const batchSize = 100;
    const maxRetries = 3;
    for (let i = 0; i < missingIds.length; i += batchSize) {
      const batch = missingIds.slice(i, i + batchSize);
      let success = false;
      for (let attempt = 1; attempt <= maxRetries && !success; attempt++) {
        const payload = batch.map((id: number) => JSON.stringify({ id })).join(",");
        const bodyStr = `c=[${payload}]`;
        console.log(`[Netease Direct] POST song detail for ${batch.length} tracks (attempt ${attempt}/${maxRetries})`);
        try {
          const resp = await fetch(`${NETEASE_API_BASE}/v3/song/detail`, {
            method: "POST",
            headers: {
              ...PLAYLIST_HEADERS,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: bodyStr,
          });
          const text = await resp.text();
          if (text.startsWith("{")) {
            const data = JSON.parse(text);
            if (data.code === 200 && Array.isArray(data.songs)) {
              for (const s of data.songs) existingTracks.push(s);
              success = true;
            }
          }
        } catch (e) {
          console.warn(`[Netease Direct] Song detail POST failed (attempt ${attempt}/${maxRetries}):`, e);
          if (attempt < maxRetries) {
            const delay = 1000 * Math.pow(2, attempt - 1);
            console.log(`[Netease Direct] Retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
      // 避免触发网易云限流
      if (i + batchSize < missingIds.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  const tracks = existingTracks.slice(0, trackIds.length);
  const result = { playlist: { tracks } };
  const headers = createCorsHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=300",
    "X-Cache-Status": "MISS",
    "X-Source": "netease-direct",
  });
  headers.set("Access-Control-Expose-Headers", "X-Cache-Status, X-Source");
  return new Response(JSON.stringify(result), { status: 200, headers });
}

async function proxyApiRequest(url: URL, request: Request, waitUntil?: (promise: Promise<any>) => void): Promise<Response> {
  try {
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const types = url.searchParams.get("types");
    
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

    let upstream: Response;
    try {
      upstream = await fetch(apiUrl.toString(), {
        headers: {
            "User-Agent": BROWSER_UA,
            "Accept": "application/json",
        },
      });
    } catch (error) {
      console.error(`[Upstream Fetch Error] ${apiUrl.toString()}`, error);
      // 第三方 API 不可达时，playlist 类型尝试直连网易云
      if (types === "playlist") {
        const pid = url.searchParams.get("id");
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        if (pid) return await fetchNeteasePlaylistDirect(pid, limit);
      }
      const errHeaders = createCorsHeaders();
      errHeaders.set("Content-Type", "application/json; charset=utf-8");
      return new Response(JSON.stringify({ error: "Upstream API unreachable", detail: String(error) }), {
        status: 502,
        headers: errHeaders,
      });
    }

    const responseText = await upstream.text();
    const headers = createCorsHeaders(upstream.headers);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }

    headers.set("X-Cache-Status", "MISS");
    headers.set("Access-Control-Expose-Headers", "X-Cache-Status");

    const isSearch = types === "search";
    const isEmptyResult = responseText.trim() === "[]";
    const isError = responseText.includes('"error"') || responseText.includes('"status":0');

    // 第三方 API 返回错误时，playlist 类型尝试直连网易云
    if (types === "playlist" && (upstream.status !== 200 || isError)) {
      const pid = url.searchParams.get("id");
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      if (pid) {
        console.log(`[Upstream Error] Third-party failed for playlist ${pid}, trying direct Netease`);
        return await fetchNeteasePlaylistDirect(pid, limit);
      }
    }

    let shouldCache = upstream.status === 200 && request.method === "GET" && !isError;

    if (isSearch && isEmptyResult) {
      shouldCache = false;
    }

    if (shouldCache) {
      headers.set("Cache-Control", "public, s-maxage=300, max-age=300");
    } else {
      headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    }

    const response = new Response(responseText, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });

    if (shouldCache && waitUntil && cache) {
      try {
        waitUntil(cache.put(cacheKey, response.clone()));
        console.log(`[Cache PUT] Saved to cache: ${url.toString()}`);
      } catch (err) {
        console.warn(`[Cache PUT Error] ${url.toString()}`, err);
      }
    }

    return response;
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
