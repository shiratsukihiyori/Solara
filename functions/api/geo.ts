// /api/geo —— 访问者地区判定
// 用于「心动模式」混合音源时的分流：境内 → 网易云/酷我，境外 → YouTube
//
// 优先使用 Cloudflare 边缘注入的 request.cf.country（无需外部请求、无精度损失）；
// 非 CF 环境（自托管 / 本地 dev）退化为 Accept-Language 判定。

type GeoPayload = {
  country: string;
  region: string | null;
  city: string | null;
  cn: boolean;
  via: "edge" | "accept-language" | "unknown";
};

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function geoResponse(payload: GeoPayload): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      // 同一个访问者短时间内不会换国家，允许浏览器缓存 10 分钟
      "Cache-Control": "private, max-age=600",
    },
  });
}

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, { status: 204, headers: CORS });

export const onRequestGet: PagesFunction = async ({ request }) => {
  const cf = (request as unknown as { cf?: { country?: string; region?: string; city?: string } }).cf || {};
  const country = String(cf.country || "").toUpperCase();

  if (country) {
    return geoResponse({
      country,
      region: cf.region || null,
      city: cf.city || null,
      cn: country === "CN",
      via: "edge",
    });
  }

  // 退化路径：Accept-Language
  const lang = String(request.headers.get("accept-language") || "").toLowerCase();
  if (lang) {
    const cn = lang.includes("zh-cn") || lang.includes("zh-hans") || lang.startsWith("zh");
    return geoResponse({
      country: cn ? "CN" : "",
      region: null,
      city: null,
      cn,
      via: "accept-language",
    });
  }

  return geoResponse({ country: "", region: null, city: null, cn: false, via: "unknown" });
};
