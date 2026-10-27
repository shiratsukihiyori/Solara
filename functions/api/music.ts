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

// ---------- YouTube Music ----------
const YTM_CLIENT_VERSION = "1.20241127.01.00";


const ytUrlCache = new Map<string, { url: string; expires: number }>();

const VISIONOS_CLIENT = {
  clientName: "VISIONOS",
  clientVersion: "1.02",
  deviceMake: "Apple",
  deviceModel: "RealityDevice17,1",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  osName: "visionOS",
  osVersion: "26.5.23O471",
  hl: "en",
  gl: "US",
};

let ytmVisitor: { data: string; expires: number } = { data: "", expires: 0 };

async function getYouTubeVisitor(): Promise<string> {
  if (ytmVisitor.data && ytmVisitor.expires > Date.now()) return ytmVisitor.data;
  const res = await fetchWithTimeout(
    "https://www.youtube.com/youtubei/v1/visitor_id?prettyPrint=false",
    {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
      body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20241126.01.00" } } }),
    },
    10000
  );
  if (!res.ok) throw new Error(`visitor_id ${res.status}`);
  const data = await res.json();
  const visitor = String(data?.responseContext?.visitorData || "");
  if (!visitor) throw new Error("empty visitorData");
  ytmVisitor = { data: visitor, expires: Date.now() + 6 * 3600_000 };
  return visitor;
}

async function youtubeResolveAudio(videoId: string): Promise<string> {
  const cached = ytUrlCache.get(videoId);
  if (cached && cached.expires > Date.now()) return cached.url;

  const attempt = async (visitor: string) => {
    const res = await fetchWithTimeout(
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": BROWSER_UA,
          "x-goog-visitor-id": visitor,
          origin: "https://www.youtube.com",
        },
        body: JSON.stringify({
          context: { client: { ...VISIONOS_CLIENT, visitorData: visitor } },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      },
      15000
    );
    if (!res.ok) throw new Error(`player ${res.status}`);
    const data = await res.json();
    const status = String(data?.playabilityStatus?.status || "");
    const formats = data?.streamingData?.adaptiveFormats || [];
    const audios = formats.filter(
      (f: any) => String(f.mimeType || "").startsWith("audio") && f.url
    );
    if (!audios.length) throw new Error(`no audio (${status})`);
    audios.sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));
    const m4a = audios.find((f: any) => String(f.mimeType).includes("mp4")) || audios[0];
    return String(m4a.url);
  };

  try {
    const url = await attempt(await getYouTubeVisitor());
    ytUrlCache.set(videoId, { url, expires: Date.now() + 30 * 60_000 });
    return url;
  } catch {
    // visitorData 失效时刷新一次
    ytmVisitor = { data: "", expires: 0 };
    const url = await attempt(await getYouTubeVisitor());
    ytUrlCache.set(videoId, { url, expires: Date.now() + 30 * 60_000 });
    return url;
  }
}


function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 12000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function collectMusicRenderers(node: any, out: any[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectMusicRenderers(item, out);
    return;
  }
  if (typeof node !== "object") return;
  if (node.musicResponsiveListItemRenderer) out.push(node.musicResponsiveListItemRenderer);
  for (const key in node) collectMusicRenderers(node[key], out);
}

function parseYouTubeItem(it: any): any | null {
  try {
    const columns = it.flexColumns || [];
    const titleRuns = columns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const name = String(titleRuns[0]?.text || "").trim();
    const subRuns = columns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const subText = subRuns
      .map((r: any) => String(r.text || "").trim())
      .filter(Boolean)
      .join(" • ");
    let parts = subText.split("•").map((s: string) => s.trim()).filter(Boolean);

    let duration = "";
    const fixedText =
      it.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || "";
    if (/^\d{1,2}:\d{2}$/.test(fixedText)) duration = fixedText;
    if (parts.length && /^\d{1,2}:\d{2}$/.test(parts[parts.length - 1])) {
      duration = duration || String(parts.pop());
    }
    const kind = String(parts[0] || "").toLowerCase();
    if (["song", "video", "歌曲", "视频"].includes(kind)) parts = parts.slice(1);
    // 过滤观看数、纯分隔符等杂质
    parts = parts
      .filter((p: string) => !/次观看|次播放|观看|views?/i.test(p))
      .filter((p: string) => !/^[、，,&/·・和\s]+$/.test(p));
    // 过滤艺人卡片 / 播放列表 / 专辑卡片等非歌曲条目
    if (/subscribers|订阅者|播放列表|playlist|album|专辑/i.test(subText) && !duration) return null;

    let videoId = "";
    try {
      videoId =
        it.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer
          .playNavigationEndpoint.watchEndpoint.videoId || "";
    } catch {}
    if (!videoId) {
      for (const run of titleRuns) {
        const v = run?.navigationEndpoint?.watchEndpoint?.videoId;
        if (v) {
          videoId = v;
          break;
        }
      }
    }
    if (!videoId) {
      try {
        videoId = it.navigationEndpoint.watchEndpoint.videoId || "";
      } catch {}
    }
    if (!videoId || !name) return null;

    const thumbnails = it.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
    const pic = thumbnails.length ? String(thumbnails[thumbnails.length - 1].url || "") : "";

    return {
      id: videoId,
      name,
      artist: parts.length ? parts : ["YouTube Music"],
      album: "",
      duration,
      pic_id: pic || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      url_id: videoId,
      lyric_id: videoId,
      source: "youtube",
    };
  } catch {
    return null;
  }
}

async function youtubeSearch(q: string, count: number): Promise<any[]> {
  const contexts = [
    { host: "https://music.youtube.com", clientName: "WEB_REMIX" },
    { host: "https://www.youtube.com", clientName: "WEB_REMIX" },
  ];

  for (const ctx of contexts) {
    try {
      const res = await fetchWithTimeout(
        `${ctx.host}/youtubei/v1/search?prettyPrint=false`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": BROWSER_UA,
            "x-youtube-client-name": ctx.clientName === "WEB_REMIX" ? "67" : "1",
            "x-youtube-client-version": YTM_CLIENT_VERSION,
            origin: ctx.host,
            referer: `${ctx.host}/`,
          },
          body: JSON.stringify({
            context: {
              client: {
                clientName: ctx.clientName,
                clientVersion: YTM_CLIENT_VERSION,
                hl: "zh-CN",
                gl: "JP",
              },
            },
            query: q,
          }),
        }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const renderers: any[] = [];
      collectMusicRenderers(data, renderers);
      const seen = new Set<string>();
      const results: any[] = [];
      for (const it of renderers) {
        const song = parseYouTubeItem(it);
        if (!song || seen.has(song.id)) continue;
        seen.add(song.id);
        results.push(song);
      }
      if (results.length > 0) return results.slice(0, count);
    } catch {
      // 尝试下一个入口
    }
  }
  return [];
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
      let referer = "https://www.kuwo.cn/";
      try { referer = new URL(pic).origin + "/"; } catch {}
      const res = await fetch(pic, {
        headers: { "User-Agent": BROWSER_UA, Referer: referer },
      });
      const headers = new Headers();
      headers.set("content-type", res.headers.get("content-type") || "image/jpeg");
      headers.set("cache-control", "public, max-age=86400");
      headers.set("access-control-allow-origin", "*");
      return new Response(res.body, { status: res.status, headers });
    }

    if (source !== "kuwo" && source !== "youtube") {
      return jsonResponse({ error: "unsupported source" }, 400);
    }

    if (type === "search") {
      const q = url.searchParams.get("q") || "";
      if (!q.trim()) return jsonResponse({ error: "missing q" }, 400);
      const results =
        source === "kuwo" ? await kuwoSearch(q, page, count) : await youtubeSearch(q, count);
      return jsonResponse(results);
    }

    if (type === "url") {
      if (!id) return jsonResponse({ error: "missing id" }, 400);
      if (source === "kuwo") {
        return jsonResponse({
          url: `/api/music?type=stream&source=kuwo&id=${encodeURIComponent(id)}&br=${br}`,
        });
      }
      // YouTube Music：默认整首走官方 IFrame；fallback=1 时返回服务器兜底线路
      if (url.searchParams.get("fallback") === "1") {
        return jsonResponse({
          url: `/api/music?type=stream&source=youtube&id=${encodeURIComponent(id)}`,
          fallback: true,
        });
      }
      return jsonResponse({ url: `yt:${id}`, playable: "iframe" });
    }

    if (type === "stream") {
      if (!id) return jsonResponse({ error: "missing id" }, 400);
      if (source === "youtube") {
        // ① Worker 自己取票（VISIONOS 客户端 + visitorData），失败自动重试一次
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const audioUrl = await youtubeResolveAudio(id);
            const resp = await streamProxy(audioUrl, request);
            if (resp.status === 200 || resp.status === 206) return resp;
          } catch {
            // 继续重试
          }
          ytUrlCache.delete(id);
          ytmVisitor = { data: "", expires: 0 };
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return jsonResponse({ error: "音频解析失败，请稍后重试" }, 502);
      }
      let target: string | null = null;
      target = await kuwoResolveUrl(id, br);
      if (!target) return jsonResponse({ error: "no stream url" }, 404);
      return await streamProxy(target, request);
    }

    if (type === "lyric") {
      if (source === "kuwo") {
        const data = await kuwoSongInfo(id);
        return jsonResponse({ lyric: toLrc(data?.data?.lrclist || []) });
      }
      // YouTube Music 歌词需额外签名接口，先返回空（前端显示“暂无歌词”）
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
      // youtube：缩略图走同源代理（i.ytimg.com 无 CORS 头，直连会裂图）
      if (/^https?:\/\//i.test(id)) {
        return jsonResponse({ url: `/api/music?type=img&u=${encodeURIComponent(id)}` });
      }
      if (!id) return jsonResponse({ url: "" });
      return jsonResponse({
        url: `/api/music?type=img&u=${encodeURIComponent(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`)}`,
      });
    }

if (type === "img") {
      const pic = url.searchParams.get("u") || "";
      if (!/^https?:\/\//i.test(pic)) return jsonResponse({ error: "bad img" }, 400);
      let referer = "https://www.kuwo.cn/";
      try { referer = new URL(pic).origin + "/"; } catch {}
      const res = await fetch(pic, {
        headers: { "User-Agent": BROWSER_UA, Referer: referer },
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
