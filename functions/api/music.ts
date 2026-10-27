// /api/music —— 酷我音乐 & Spotify 音源适配层
// 覆盖：搜索 / 播放地址 / 音频流中转(Range) / 歌词 / 封面
//
// 酷我：search.kuwo.cn 旧接口（免登录）+ antiserver/mobi 转直链 + m.kuwo.cn 歌词
// Spotify：Web Player 匿名 token + 官方 30 秒试听片段（完整播放受 DRM 限制）

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ---------- 工具 ----------
function decodeEntities(input: string): string {
  return input
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// 酷我旧接口返回单引号 JS 对象
function parseSingleQuotedJson(raw: string): any {
  let text = raw.trim();
  text = text.replace(/^var\s+[\w$]+\s*=\s*/, "").replace(/;+\s*$/, "");
  text = text.replace(/'/g, '"');
  return JSON.parse(text);
}

// 兼容两种返回：现代接口是标准 JSON，旧接口是单引号对象
function parseKuwoJson(raw: string): any {
  const text = String(raw || "").trim().replace(/^var\s+[\w$]+\s*=\s*/, "").replace(/;+\s*$/, "");
  try {
    return JSON.parse(text);
  } catch {
    return parseSingleQuotedJson(text);
  }
}

function mapKuwoList(list: any[]): any[] {
  return (Array.isArray(list) ? list : [])
    .map((song: any) => {
      const rid = String(
        song.DC_TARGETID || String(song.MUSICRID || "").replace("MUSIC_", "") || ""
      );
      const artists = decodeEntities(String(song.ARTIST || ""))
        .split(/&|\//)
        .map((s) => s.trim())
        .filter(Boolean);
      const cover = String(song.web_albumpic_short || song.web_artistpic_short || "").trim();
      return {
        id: rid,
        name: decodeEntities(String(song.SONGNAME || song.NAME || "")),
        artist: artists.length ? artists : ["未知歌手"],
        album: decodeEntities(String(song.ALBUM || "")),
        pic_id: cover || rid,
        url_id: rid,
        lyric_id: rid,
        source: "kuwo",
        cover_path: cover,
      };
    })
    .filter((s: any) => s.id && s.name);
}

// ---------- 酷我 ----------
async function kuwoSearch(q: string, page: number, count: number): Promise<any[]> {
  const pn = Math.max(0, (page || 1) - 1);

  // ① 现代完整索引接口（免登录，返回标准 JSON，结果最全）
  try {
    const modern =
      `https://www.kuwo.cn/search/searchMusicBykeyWord?vipver=1&client=kt&ft=music&cluster=0` +
      `&strategy=2012&encoding=utf8&rformat=json&mobi=1&issubtitle=1&show_copyright_off=1` +
      `&pn=${pn}&rn=${count}&all=${encodeURIComponent(q)}`;
    const res = await fetch(modern, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Referer": `https://www.kuwo.cn/search/list?key=${encodeURIComponent(q)}`,
      },
    });
    if (res.ok) {
      const data = parseKuwoJson(await res.text());
      const mapped = mapKuwoList(data?.abslist || []);
      if (mapped.length > 0) return mapped;
    }
  } catch {
    // 落回旧接口
  }

  // ② 旧接口兜底（索引较旧，可能缺歌）
  const legacy =
    `https://search.kuwo.cn/r.s?all=${encodeURIComponent(q)}&ft=music&itemset=web_2013` +
    `&client=kt&pn=${pn}&rn=${count}&rformat=json&encoding=utf8`;
  const res = await fetch(legacy, {
    headers: { "User-Agent": BROWSER_UA, "Referer": "https://www.kuwo.cn/" },
  });
  const data = parseKuwoJson(await res.text());
  return mapKuwoList(data?.abslist || []);
}

async function kuwoResolveUrl(id: string, br: string): Promise<string | null> {
  // ① antiserver 直链
  try {
    const res = await fetch(
      `https://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_${encodeURIComponent(id)}`,
      { headers: { "User-Agent": BROWSER_UA, "Referer": "https://www.kuwo.cn/" } }
    );
    const text = (await res.text()).trim();
    if (/^https?:\/\//i.test(text)) return text;
  } catch {}
  // ② mobi 带签名备用
  try {
    const quality = br === "128" ? "128kmp3" : "320kmp3";
    const res = await fetch(
      `https://mobi.kuwo.cn/mobi.s?f=web&source=kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&type=convert_url_with_sign&br=${quality}&rid=${encodeURIComponent(id)}`,
      { headers: { "User-Agent": BROWSER_UA } }
    );
    const data = await res.json();
    const target = data?.data?.url;
    if (typeof target === "string" && /^https?:\/\//i.test(target)) return target;
  } catch {}
  return null;
}

async function kuwoSongInfo(id: string): Promise<any> {
  // m.kuwo.cn 接口间歇性返回 data:null（实测约三成失败率），这里重试 5 次
  let lastData: any = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(
        `https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(id)}&httpsStatus=1`,
        { headers: { "User-Agent": BROWSER_UA, "Referer": "https://m.kuwo.cn/" } }
      );
      const data = await res.json();
      lastData = data;
      if (data?.data?.lrclist || data?.data?.songinfo) return data;
    } catch {
      // 继续重试
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 100 + attempt * 50));
  }
  return lastData;
}

function toLrc(lrclist: any[]): string {
  if (!Array.isArray(lrclist)) return "";
  return lrclist
    .map((item) => {
      const t = Number(item?.time) || 0;
      const mm = String(Math.floor(t / 60)).padStart(2, "0");
      const ss = String(Math.floor(t % 60)).padStart(2, "0");
      const xx = String(Math.min(99, Math.round((t % 1) * 100))).padStart(2, "0");
      return `[${mm}:${ss}.${xx}]${String(item?.lineLyric ?? "")}`;
    })
    .join("\n");
}

// ---------- Spotify ----------
// 鉴权链：① Client Credentials（env 配置，正规可靠）→ ② Web Player 匿名 token（官方已封，仅兜底）
let spotifyTokenCache: { token: string; expiresAt: number } = { token: "", expiresAt: 0 };

function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function getClientCredentialsToken(env: any): Promise<string | null> {
  const clientId = env?.SPOTIFY_CLIENT_ID;
  const clientSecret = env?.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  try {
    const res = await fetchWithTimeout(
      "https://accounts.spotify.com/api/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
        },
        body: "grant_type=client_credentials",
      },
      8000
    );
    if (!res.ok) return null;
    const data = await res.json();
    const token = data?.access_token;
    if (!token) return null;
    spotifyTokenCache = {
      token,
      expiresAt: Date.now() + (Number(data?.expires_in || 3600) - 60) * 1000,
    };
    return token;
  } catch {
    return null;
  }
}

async function getSpotifyToken(env: any): Promise<string | null> {
  if (spotifyTokenCache.token && Date.now() < spotifyTokenCache.expiresAt) return spotifyTokenCache.token;

  // ① 正式渠道：Client Credentials
  const ccToken = await getClientCredentialsToken(env);
  if (ccToken) return ccToken;

  // ② 兜底：Web Player 匿名 token（Spotify 已封锁此接口，通常返回 403）
  try {
    const res = await fetchWithTimeout(
      "https://open.spotify.com/get_access_token?reason=transport&productType=web_player",
      {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "application/json",
          Referer: "https://open.spotify.com/",
        },
      },
      8000
    );
    if (!res.ok) return null;
    const data = await res.json();
    const token = data?.accessToken;
    if (!token) return null;
    const expiresAt =
      Number(data?.accessTokenExpirationTimestampMs) - 60_000 || Date.now() + 30 * 60_000;
    spotifyTokenCache = { token, expiresAt };
    return token;
  } catch {
    return null;
  }
}

async function spotifyApi(env: any, path: string): Promise<any> {
  const token = await getSpotifyToken(env);
  if (!token) throw new Error("Spotify 鉴权失败：请配置 SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET");
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": BROWSER_UA },
  });
  if (!res.ok) throw new Error(`Spotify API ${res.status}`);
  return res.json();
}

// 试听兜底：老接口被封时，从官方 embed 页提取 30 秒试听地址
async function spotifyEmbedPreview(trackId: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      `https://open.spotify.com/embed/track/${encodeURIComponent(trackId)}`,
      { headers: { "User-Agent": BROWSER_UA } },
      8000
    );
    if (!res.ok) return null;
    const html = await res.text();
    const quoted = html.match(/"audioPreview":\{"url":"([^"]+)"/);
    if (quoted) return quoted[1];
    const bare = html.match(/mp3-preview\/([a-zA-Z0-9]+)/);
    if (bare) return `https://p.scdn.co/mp3-preview/${bare[1]}`;
    return null;
  } catch {
    return null;
  }
}

async function spotifySearch(env: any, q: string, page: number, count: number): Promise<any[]> {
  const offset = Math.max(0, (page || 1) - 1) * count;
  const data = await spotifyApi(
    env,
    `/search?q=${encodeURIComponent(q)}&type=track&limit=${count}&offset=${offset}`
  );
  const items = Array.isArray(data?.tracks?.items) ? data.tracks.items : [];
  return items.map((track: any) => ({
    id: track.id,
    name: track.name,
    artist: Array.isArray(track.artists) ? track.artists.map((a: any) => a.name) : [],
    album: track?.album?.name || "",
    // pic_id 直接放封面 URL，前端走 type=img 中转
    pic_id: track?.album?.images?.[0]?.url || "",
    url_id: track.id,
    lyric_id: track.id,
    source: "spotify",
    preview: true,
    duration: 30,
  }));
}

// ---------- 音频流中转（支持 Range 拖动） ----------
async function streamProxy(target: string, request: Request): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": BROWSER_UA };
  const range = request.headers.get("Range");
  if (range) headers.Range = range;
  try {
    headers.Referer = new URL(target).origin + "/";
  } catch {}

  const upstream = await fetch(target, { headers, redirect: "follow" });
  const out = new Headers();
  for (const key of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(key);
    if (value) out.set(key, value);
  }
  if (!out.has("accept-ranges")) out.set("accept-ranges", "bytes");
  out.set("Access-Control-Allow-Origin", "*");
  out.set("Cache-Control", "public, max-age=3600");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

// ---------- 主入口 ----------
export async function onRequest(context: any): Promise<Response> {
  const { request, env } = context;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "search";
  const source = (url.searchParams.get("source") || "").toLowerCase();
  const id = url.searchParams.get("id") || "";
  const page = Number(url.searchParams.get("page") || "1") || 1;
  const count = Math.min(50, Math.max(1, Number(url.searchParams.get("count") || "20") || 20));
  const br = url.searchParams.get("br") || "320";

  try {
    // 图片中转不依赖音源，先行处理
    if (type === "img") {
      const pic = url.searchParams.get("u") || "";
      if (!/^https?:\/\//i.test(pic)) return jsonResponse({ error: "bad img" }, 400);
      const res = await fetch(pic, {
        headers: { "User-Agent": BROWSER_UA, Referer: "https://open.spotify.com/" },
      });
      const headers = new Headers();
      headers.set("content-type", res.headers.get("content-type") || "image/jpeg");
      headers.set("cache-control", "public, max-age=86400");
      headers.set("access-control-allow-origin", "*");
      return new Response(res.body, { status: res.status, headers });
    }

    if (source !== "kuwo" && source !== "spotify") {
      return jsonResponse({ error: "unsupported source" }, 400);
    }

    if (type === "search") {
      const q = url.searchParams.get("q") || "";
      if (!q.trim()) return jsonResponse({ error: "missing q" }, 400);
      const results =
        source === "kuwo" ? await kuwoSearch(q, page, count) : await spotifySearch(env, q, page, count);
      return jsonResponse(results);
    }

    if (type === "url") {
      if (!id) return jsonResponse({ error: "missing id" }, 400);
      if (source === "kuwo") {
        return jsonResponse({
          url: `/api/music?type=stream&source=kuwo&id=${encodeURIComponent(id)}&br=${br}`,
        });
      }
      let preview: string | null = null;
      try {
        const track = await spotifyApi(env, `/tracks/${encodeURIComponent(id)}`);
        preview = track?.preview_url || null;
      } catch {
        // 未配置凭据时走 embed 兜底
      }
      if (!preview) preview = await spotifyEmbedPreview(id);
      if (!preview) return jsonResponse({ error: "该曲目暂无试听片段" }, 404);
      return jsonResponse({
        url: `/api/music?type=stream&source=spotify&id=${encodeURIComponent(id)}`,
        preview: true,
        duration: 30,
      });
    }

    if (type === "stream") {
      if (!id) return jsonResponse({ error: "missing id" }, 400);
      let target: string | null = null;
      if (source === "kuwo") {
        target = await kuwoResolveUrl(id, br);
      } else {
        try {
          const track = await spotifyApi(env, `/tracks/${encodeURIComponent(id)}`);
          target = track?.preview_url || null;
        } catch {
          target = null;
        }
        if (!target) target = await spotifyEmbedPreview(id);
      }
      if (!target) return jsonResponse({ error: "no stream url" }, 404);
      return await streamProxy(target, request);
    }

    if (type === "lyric") {
      if (source === "kuwo") {
        const data = await kuwoSongInfo(id);
        return jsonResponse({ lyric: toLrc(data?.data?.lrclist || []) });
      }
      // Spotify 歌词非公开接口，返回空（前端显示“暂无歌词”）
      return jsonResponse({ lyric: "" });
    }

    if (type === "pic") {
      if (source === "kuwo") {
        // pic_id 若是封面路径（形如 120/s4s7/41/xxx.jpg）直接用官方封面 CDN
        if (/\.(jpg|jpeg|png|webp)$/i.test(id)) {
          return jsonResponse({
            url: `/api/music?type=img&u=${encodeURIComponent("https://img1.kuwo.cn/star/albumcover/" + id)}`,
          });
        }
        const data = await kuwoSongInfo(id);
        const pic = data?.data?.songinfo?.pic || "";
        if (!pic) return jsonResponse({ url: "" });
        return jsonResponse({ url: `/api/music?type=img&u=${encodeURIComponent(pic)}` });
      }
      // spotify：id 传 track id 或直接传图片 URL
      let picUrl = id;
      if (id && !/^https?:\/\//i.test(id)) {
        try {
          const track = await spotifyApi(env, `/tracks/${encodeURIComponent(id)}`);
          picUrl = track?.album?.images?.[0]?.url || "";
        } catch {
          picUrl = "";
        }
      }
      if (!picUrl) return jsonResponse({ url: "" });
      return jsonResponse({ url: `/api/music?type=img&u=${encodeURIComponent(picUrl)}` });
    }

    if (type === "img") {
      const pic = url.searchParams.get("u") || "";
      if (!/^https?:\/\//i.test(pic)) return jsonResponse({ error: "bad img" }, 400);
      const res = await fetch(pic, {
        headers: { "User-Agent": BROWSER_UA, Referer: "https://open.spotify.com/" },
      });
      const headers = new Headers();
      headers.set("content-type", res.headers.get("content-type") || "image/jpeg");
      headers.set("cache-control", "public, max-age=86400");
      headers.set("access-control-allow-origin", "*");
      return new Response(res.body, { status: res.status, headers });
    }

    return jsonResponse({ error: "unknown type" }, 400);
  } catch (error: any) {
    return jsonResponse({ error: String(error?.message || error) }, 502);
  }
}
