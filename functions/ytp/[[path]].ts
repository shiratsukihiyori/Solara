// /ytp/* —— YouTube 反向代理
//  /ytp/embed/<videoId>  代理官方 embed 页面（含 Cookie 转发/回写）
//  /ytp/h/<host>/<path>  代理子资源与媒体（Range 透传；JS 原样）

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const ALLOW_HOSTS = [
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube.com",
  "i.ytimg.com",
  "s.ytimg.com",
  "yt3.ggpht.com",
  "yt3.googleusercontent.com",
  "www.gstatic.com",
  "youtubei.googleapis.com",
  "googlevideo.com",
];

function isAllowedHost(host: string): boolean {
  return ALLOW_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

function rewriteText(body: string): string {
  return body
    .replace(/https:\/\/([a-z0-9-]+\.googlevideo\.com)/gi, "/ytp/h/$1")
    .replace(/https:\/\/(i\.ytimg\.com|yt3\.ggpht\.com|yt3\.googleusercontent\.com|www\.gstatic\.com)/gi, "/ytp/h/$1")
    .replace(/(src|href|action)="https:\/\/(www\.)?youtube\.com([^"]*)"/gi, '$1="$3"')
    .replace(/(src|href|action)="\/\/(www\.)?youtube\.com([^"]*)"/gi, '$1="$3"');
}

function relaySetCookie(upstream: Response, out: Headers): void {
  const anyHeaders = upstream.headers as any;
  const list: string[] = typeof anyHeaders.getSetCookie === "function" ? anyHeaders.getSetCookie() : [];
  for (const cookie of list) {
    const cleaned = cookie
      .replace(/;\s*Domain=[^;]+/gi, "")
      .replace(/;\s*Secure/gi, "")
      .replace(/;\s*Partitioned/gi, "")
      .replace(/;\s*SameSite=None/gi, "; SameSite=Lax");
    out.append("set-cookie", cleaned);
  }
}

const RUNTIME_SHIM = `<script>
(function () {
  try {
    var YT = ["https://www.youtube.com", "https://youtube.com", "https://m.youtube.com", "https://music.youtube.com"];
    var IMG = ["i.ytimg.com", "yt3.ggpht.com", "yt3.googleusercontent.com", "www.gstatic.com"];
    var map = function (u) {
      if (typeof u !== "string") return u;
      for (var i = 0; i < YT.length; i++) {
        if (u.indexOf(YT[i]) === 0) {
          var rest = u.slice(YT[i].length);
          if (YT[i] === "https://music.youtube.com") return "/ytp/h/music.youtube.com" + rest;
          return rest || "/";
        }
      }
      for (var j = 0; j < IMG.length; j++) {
        var p = "https://" + IMG[j];
        if (u.indexOf(p) === 0) return "/ytp/h/" + IMG[j] + u.slice(p.length);
      }
      if (u.indexOf("https://") === 0) {
        var body = u.slice(8);
        var slash = body.indexOf("/");
        var host = slash === -1 ? body : body.slice(0, slash);
        if (host.indexOf(".googlevideo.com") !== -1) return "/ytp/h/" + host + (slash === -1 ? "/" : body.slice(slash));
      }
      return u;
    };
    var of = window.fetch;
    window.fetch = function (input, init) {
      try {
        if (typeof input === "string") input = map(input);
        else if (input && input.url) input = new Request(map(input.url), input);
      } catch (e) {}
      return of.call(this, input, init);
    };
    var oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { url = map(url); } catch (e) {}
      var args = Array.prototype.slice.call(arguments);
      args[1] = url;
      return oo.apply(this, args);
    };
  } catch (e) {}
})();
</script>`;

async function proxyFetch(target: string, request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  const headers = new Headers(request.headers);
  for (const key of [
    "host", "connection", "content-length", "accept-encoding", "origin", "referer",
    "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cdn-loop",
    "x-forwarded-for", "x-real-ip", "x-forwarded-proto", "x-forwarded-host",
  ]) {
    headers.delete(key);
  }
  headers.set("user-agent", UA);
  headers.set("referer", origin + "/");
  headers.set("origin", "https://www.youtube.com");

  const upstream = await fetch(target, { headers, redirect: "follow" });
  const out = new Headers(CORS);
  const ctype = upstream.headers.get("content-type") || "application/octet-stream";
  out.set("content-type", ctype);
  for (const key of ["content-range", "accept-ranges", "etag", "last-modified", "content-length"]) {
    const v = upstream.headers.get(key);
    if (v) out.set(key, v);
  }
  out.set("cache-control", "public, max-age=300");
  relaySetCookie(upstream, out);

  if (/javascript/i.test(ctype)) {
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
  if (/json|html|text\/plain|css/i.test(ctype)) {
    const text = await upstream.text();
    out.delete("content-length");
    return new Response(rewriteText(text), { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export async function handleEmbedProxy(videoId: string, request: Request): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
    return new Response("bad video id", { status: 400, headers: CORS });
  }
  const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&playsinline=1`;
  const headers: Record<string, string> = {
    "user-agent": UA,
    "accept-language": "en-US,en;q=0.9",
    referer: new URL(request.url).origin + "/",
  };
  const cookie = request.headers.get("cookie");
  if (cookie) headers.cookie = cookie;
  try {
    const upstream = await fetch(embedUrl, { headers, redirect: "follow" });
    let html = await upstream.text();
    html = rewriteText(html);
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (m) => m + RUNTIME_SHIM);
    } else {
      html = RUNTIME_SHIM + html;
    }
    const out = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...CORS });
    relaySetCookie(upstream, out);
    return new Response(html, { status: 200, headers: out });
  } catch (error: any) {
    return new Response(`proxy error: ${String(error?.message || error)}`, { status: 502, headers: CORS });
  }
}

const handle: PagesFunction = async ({ request }) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/ytp\/?/, "");

  if (path.startsWith("embed/")) {
    return handleEmbedProxy(path.slice("embed/".length).split("/")[0], request);
  }

  if (path.startsWith("h/")) {
    const rest = path.slice(2);
    const slash = rest.indexOf("/");
    const host = slash === -1 ? rest : rest.slice(0, slash);
    const subPath = slash === -1 ? "/" : rest.slice(slash);
    if (!host || !isAllowedHost(host)) {
      return new Response("host not allowed", { status: 403, headers: CORS });
    }
    const target = `https://${host}${subPath}${url.search}`;
    try {
      return await proxyFetch(target, request);
    } catch (error: any) {
      return new Response(`proxy error: ${String(error?.message || error)}`, { status: 502, headers: CORS });
    }
  }

  return new Response("not found", { status: 404, headers: CORS });
};

export const onRequestGet = handle;
export const onRequestPost = handle;
export const onRequestHead = handle;
export const onRequestOptions: PagesFunction = async () => new Response(null, { status: 204, headers: CORS });
