# Solara Hiyori Remix

> 基于 [Akudamatata/Solara](https://github.com/akudamatata/Solara) 修改的自定义的个性化音乐播放器，部署于 Cloudflare Pages。

## 特性

- **四源搜索** — 网易云 / 酷我 / 哔哩哔哩 / YouTube Music 一键切换
- **酷我全索引** — 走酷我现代搜索接口（非残缺旧接口），封面直连官方 CDN，歌词自动重试
- **YouTube Music 整曲播放** — 官方 IFrame 播放器为主路；直连失败自动切换服务器线路（Worker 自行取票，无需外部服务）
- **YouTube → MP3 下载** — 浏览器端 lamejs 转码，128/192/320k 三档，不经过任何第三方服务
- **双通道 API** — 优先 JSONP 直连上游，失败降级到 Pages Function 代理转发
- **心动模式** — 播放列表快播完时自动补歌：优先使用音源原厂推荐（YouTube 电台 / 网易云相似歌曲 / 酷我同歌手），列表混合多音源时按访客地区分流（境内→网易云/酷我，境外→YouTube）
- **探索雷达** — 按选定风格随机发现新歌，支持全选/清空快捷操作
- **网易云歌单** — 粘贴歌单 ID 或分享链接，直接加载到播放列表并开始播放
- **动态歌词** — 逐行滚动高亮，手动滚动后 3 秒自动回位（YouTube 源显示「不支持歌词」）
- **动态配色** — 从封面提取主色驱动整套主题
- **暗色模式** — 跟随系统或手动切换，无缝过渡
- **竖屏移动端** — 专为手机优化的布局与手势
- **收藏系统** — 独立播放进度与批量操作
- **多码率播放** — 128K / 192K / 320K / FLAC（视音源支持）
- **锁屏控制** — MediaSession API 支持
- **播放列表导入/导出** — JSON 格式一键迁移
- **调试面板** — 按 Ctrl+D 呼出实时日志

## API 架构

```
┌──────────┐     ┌───────────┐
│ Browser  │────▶│ 音乐平台API │  ← JSONP 直连（优先，无跨域限制）
│ (script) │     └───────────┘
│          │
│          │     ┌──────────┐  ┌──────────┐
│ (fetch)  │────▶│ /proxy   │─▶│ upstream │  ← 降级到代理转发
└──────────┘     └──────────┘  └──────────┘
        │
        │        ┌──────────────────────────────┐
        └───────▶│ /api/music （同源适配层）      │
                 │  source=kuwo / youtube        │
                 │  search / url / stream /      │
                 │  lyric / pic / img            │
                 └──────────────────────────────┘
```

- **JSONP 直连**：`<script>` 标签绕过跨域限制，请求从用户 IP 发出，节省服务器网络压力
- **代理转发**：JSONP 超时/失败后自动降级到 `functions/proxy.ts`
- **同源适配层**：酷我、YouTube Music 与图片中转统一走 `/api/music`

### 各源实现

| 音源 | 搜索 | 播放 | 歌词 |
|------|------|------|------|
| 网易云 / B站 | GD 音乐台 API（JSONP → /proxy 降级） | 同左 | 同左 |
| 酷我 | 酷我现代搜索接口（免登录、标准 JSON、完整索引） | `antiserver` 转链 + Range 透传中继 | `songinfoandlrc`，失败自动重试 5 次 |
| YouTube Music | YouTube Music Innertube（免 key、免登录） | ① 官方 IFrame 整曲播放 ② 失败时 Worker 用 VISIONOS 客户端 + visitorData 取票，直连 `googlevideo` 拉流 | 暂不支持（显示「不支持歌词」）|

### 心动模式的原厂推荐接口

| 音源 | 接口 | 说明 |
|------|------|------|
| YouTube Music | `youtubei/v1/next` + `RDAMVM<videoId>` 电台播放列表 | 免登录，返回平台自身的电台推荐 |
| 网易云 | `api/discovery/simiSong` | 需登录 Cookie（环境变量 `NETEASE_COOKIE`；未配置时自动降级为同歌手/风格搜索）|
| 酷我 | 官方曲库同歌手检索 | 酷我没有公开推荐接口 |

访客地区判定用 `/api/geo`（Cloudflare 边缘 `request.cf.country`，非 CF 环境退化为 Accept-Language）。

### YouTube 播放与下载说明

- **主路**：浏览器直连 YouTube 官方 IFrame 播放器，整曲播放，官方分账，合规。
- **兜底**：直连失败（脚本加载超时 / 播放器报错）时自动切换服务器线路。Worker 先调用 `visitor_id` 取访客令牌（缓存 6 小时）→ 以 `VISIONOS` 客户端请求播放地址 → 直接代理音频流并支持 Range 拖动。取票结果写入边缘缓存（30 分钟），大幅降低触发 YouTube 风控的概率。
- **下载**：YouTube 曲目在浏览器端用 [lamejs](https://github.com/zhuker/lamejs) 将 AAC 解码为 PCM 再编码为 MP3，完全本地完成，不依赖任何第三方转换服务。大文件按 256KB 分片拉取（绕过 Worker 单次子请求的 ~1MB 截断）。

## 部署（Cloudflare Pages）

### 前置准备

1. Fork 本仓库到你的 GitHub
2. 开通 [Cloudflare Pages](https://pages.cloudflare.com/)

### 步骤

1. 在 Cloudflare Dashboard 进入 **Workers & Pages → Create application → Pages → Connect to Git**
2. 授权并选择你的 Solara 仓库
3. 构建设置：
   - **Framework preset**: None
   - **Build command**: 留空
   - **Build output directory**: `.`
4. 点击 **Save and Deploy**

### 环境变量（可选）

在 Pages 项目 **Settings → Environment variables** 中添加：

| 变量 | 说明 |
|------|------|
| `PASSWORD` | 开启访问口令保护 |
| `LANGUAGE=ENG` | 切换为英文界面 |
| `NETEASE_COOKIE` | 可选：网易云登录 Cookie，用于心动模式的官方相似歌曲推荐 |

> 酷我与 YouTube Music 均为免登录接口，无需额外密钥。

### D1 数据库（可选）

1. 创建 D1 数据库 `solara-db`
2. 在 Pages 项目设置中绑定 Binding name `DB` 到该数据库
3. 执行建表语句：

```sql
CREATE TABLE IF NOT EXISTS playback_store (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS favorites_store (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

## 本地开发

```bash
npm install
npm run dev
npm run deploy
```

## 项目结构

```
├── css/
│   ├── desktop.css       # 桌面端布局
│   ├── mobile.css        # 移动端适配
│   └── style.css         # 主题与公共变量
├── functions/
│   ├── _middleware.ts    # 中间件（认证/国际化）
│   ├── proxy.ts          # API 代理与缓存（降级通道，含网易云歌单直连兜底）
│   ├── palette.ts        # 封面取色（供前端 Canvas 提取失败时降级）
│   └── api/
│       ├── music.ts      # 同源音乐适配层（酷我 / YouTube Music / 图片代理）
│       ├── login.ts      # 登录认证
│       └── storage.ts    # D1 存储
├── js/
│   ├── index.js          # 核心逻辑（双通道 API / 媒体门面 / 渐变背景 / 雷达 / 心跳 / MP3 转码）
│   ├── lame.min.js       # lamejs MP3 编码器（浏览器端转码）
│   └── mobile.js         # 移动端交互
├── index.html
├── login.html
├── package.json
├── wrangler.toml
└── .gitignore
```

## 使用

1. 输入关键词并选择曲库发起搜索
2. 点击结果可播放、下载或加入队列（YouTube 曲目下载为浏览器端转码的 MP3）
3. 心形图标收藏歌曲
4. 底部控制栏提供播放控制、进度条与音量
5. 打开歌词面板查看实时滚动歌词
6. 右上角齿轮进入设置：雷达风格、心动模式、网易云歌单

## 更新日志

### 2026-10-27

- **音源调整**：移除 JOOX（上游已下架）与 Spotify（整曲需登录 + Premium，官方仅提供 30 秒试听），新增 **YouTube Music**
- **YouTube Music 全链路**：Innertube 搜索 + 官方 IFrame 整曲播放 + 失败自动切服务器线路（Worker 自取票，无需自建解析服务）
- **YouTube 下载**：浏览器端 lamejs 转码 MP3（128/192/320k），分片拉取解决大文件截断
- **酷我修复**：搜索从残缺旧索引切换到现代完整索引（《提瓦特民谣》等新歌不再缺失），封面接入官方 CDN，歌词补 `httpsStatus` 参数并加重试（实测 12/12 成功）
- **设置面板**：「自定义预设歌单」改为「网易云歌单」专属输入框；雷达风格新增全选/清空；心动模式改为按当前歌曲补充同歌手/同风格歌曲，并修正说明文案
- **移除自建兜底线路**：YouTube 取票完全在 Cloudflare Worker 内完成，不再依赖任何外部 VPS

## 致谢

- [Akudamatata](https://github.com/akudamatata) — [Solara 原版](https://github.com/akudamatata/Solara)
- [GD音乐台](https://music.gdstudio.xyz) — 音乐 API
- [lamejs](https://github.com/zhuker/lamejs) — 纯 JS MP3 编码器
- [牛就是牛@ufoo](https://linux.do/t/topic/942415) — 灵感启发

## 许可证

[CC BY-NC-SA 4.0](LICENSE) — 禁止商用，衍生项目必须保留出处并以相同协议开源。
