/** @type {import('./_venera_.js')} */

/**
 * 肉漫屋 (roum29.xyz，永久域 rouman5.com) — 韩漫
 *
 * 2026-11-21 站点改版重写（上游 coldnighten v1.1.0 解析已失效）:
 * 站点为 SSR React 站，首页/详情/章节全部服务端渲染，卡片结构 a.site-comic > h3 + img。
 * - 搜索参数为 `term`（上游误用 `keyword`，服务端只认 `term`，旧版恒返回空页）;
 * - 章节锚点为 a.site-chapter-link（href /books/{id}/{ep}，标题在 span[title]）;
 * - 章节图 URL 内嵌 base64 载荷（czM6Ly9... = s3://rouman/images/{book}/{ch}/{NNN}.webp），
 *   签名 URL 形如 https://{towm85.xyz 系}/m/{token}/wm:0/sr:0/{载荷}，
 *   广告图载荷为 s3://roupub/advertiser-assets|adcs（300x250 GIF），按载荷前缀过滤;
 * - 图域 towm85.xyz / v1.towm85.xyz 等多变，需带 Referer。
 *
 * 2026-11-21 海外代理实测全链路通过：搜索 2 命中、详情 127 章、
 * 章节页 71 张内容图 URL、首图 WebP 16968B 字节验证落地。
 */
class Roum27 extends ComicSource {
  name = "肉漫屋";
  key = "roum27";
  version = "1.1.1";
  minAppVersion = "1.6.0";
  url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/roum27.js";

  settings = {
    domains: {
      title: "自定义域名",
      type: "input",
      default: "roum29.xyz",
    },
    permanentDomain: {
      title: "永久域名",
      type: "callback",
      buttonText: "查看",
      callback: () => {
        UI.showMessage("永久域名：rouman5.com");
      },
    },
  };

  static ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  static headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "text/html,*/*",
    "Accept-Language": "zh-TW,zh;q=0.9",
  };

  get baseUrl() {
    return `https://${this.loadSetting("domains") || "roum29.xyz"}/`;
  }

  /** 章节图签名 URL 的站点域（Referer 用，与阅读页一致即可） */
  get referer() {
    return this.baseUrl;
  }

  static unescapeHtml(s) {
    return String(s || "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .trim();
  }

  static stripTags(s) {
    return Roum27.unescapeHtml(String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  }

  /**
   * base64 载荷解码（czM6Ly9... = s3://...）；失败返回 ""。
   * 站点在 URL 中剥离了 base64 的 "=" padding（实测 68/79 载荷长度 %4==2），
   * 需先补齐 padding 再交给 Convert.decodeBase64（严格校验长度）。
   */
  static decodePayload(s) {
    try {
      let b64 = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
      const mod = b64.length % 4;
      if (mod === 2) b64 += "==";
      else if (mod === 3) b64 += "=";
      else if (mod === 1) return "";
      return Convert.decodeUtf8(Convert.decodeBase64(b64));
    } catch (_) {
      return "";
    }
  }

  /**
   * 从 SSR HTML 提取漫画卡片（a.site-comic > img + h3）。
   * 用于首页分区与搜索结果页。
   */
  static parseCardsFromHtml(html) {
    const comics = [];
    const seen = {};
    const re = /<a\b[^>]*class="site-comic[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html))) {
      const seg = m[1];
      const href = (seg.match(/href="\/books\/([A-Za-z0-9-]+)"/) || m[0].match(/href="\/books\/([A-Za-z0-9-]+)"/) || [])[1];
      if (!href) continue;
      const id = href;
      if (seen[id]) continue;
      let title = "";
      const h3 = seg.match(/<h3[^>]*title="([^"]+)"/);
      if (h3) title = Roum27.unescapeHtml(h3[1]);
      if (!title) {
        const h3t = seg.match(/<h3[^>]*>([\s\S]{1,120}?)<\/h3>/);
        if (h3t) title = Roum27.stripTags(h3t[1]);
      }
      if (!title) {
        const alt = seg.match(/alt="([^"]+)"/);
        if (alt) title = Roum27.unescapeHtml(alt[1]);
      }
      if (!title) continue;
      const img = seg.match(/<img[^>]+src="([^"]+)"/);
      const cover = img ? img[1] : "";
      seen[id] = true;
      comics.push(new Comic({ id, title, cover }));
    }
    return comics;
  }

  explore = [
    {
      title: "肉漫屋",
      type: "multiPartPage",
      load: async (page) => {
        const res = await Network.get(this.baseUrl + "home", Roum27.headers);
        if (res.status !== 200) throw `Invalid status: ${res.status}`;
        const html = res.body;
        // 首页 5 个分区: 此刻,正熱門 / 今日最佳 / 最近更新 / 本週熱門 / 一口氣讀完
        // 以 site-comic-grid 分块, 标题取块前最近的 h1/h2 文本
        const chunks = html.split("site-comic-grid");
        const sections = [];
        for (let i = 0; i < chunks.length - 1; i++) {
          const heads = chunks[i].match(/<h[12][^>]*>([\s\S]{2,80}?)<\/h[12]>/g) || [];
          let title = heads.length ? Roum27.stripTags(heads[heads.length - 1]) : "";
          if (!title) title = "推薦";
          const comics = Roum27.parseCardsFromHtml(chunks[i + 1]);
          if (comics.length > 0) {
            sections.push({ title, comics });
          }
        }
        if (sections.length < 1) {
          // 结构变化兜底: 全页卡片合并为单分区
          const comics = Roum27.parseCardsFromHtml(html);
          if (comics.length > 0) sections.push({ title: "推薦", comics });
        }
        return sections;
      },
    },
  ];

  search = {
    load: async (keyword, options, page) => {
      page = page || 1;
      const term = String(keyword || "").trim();
      if (!term) return { comics: [], maxPage: 0 };
      // 搜索参数是 term 而非 keyword（上游 bug 根因）
      let url = `${this.baseUrl}search?term=${encodeURIComponent(term)}`;
      if (page > 1) url += `&page=${page}`;
      const res = await Network.get(url, Roum27.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      const comics = Roum27.parseCardsFromHtml(res.body);
      // 搜索页每页 18 条（前端常量 B=18），不足一页视为末页
      const maxPage = comics.length >= 18 ? page + 1 : page;
      return { comics, maxPage };
    },
    enableTagsSuggestions: false,
  };

  comic = {
    loadInfo: async (id) => {
      const res = await Network.get(`${this.baseUrl}books/${id}`, Roum27.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      const html = res.body;

      const h1 = html.match(/<h1[^>]*>([\s\S]{1,160}?)<\/h1>/);
      const title = h1 ? Roum27.stripTags(h1[1]) : String(id);

      let cover = "";
      const og = html.match(/og:image"\s*content="([^"]+)"/);
      if (og) cover = og[1];

      // site-book-data: 作者 / 狀態 / 地區 / 更新
      let author = "";
      let status = "unknown";
      const region = [];
      const ddRe = /<dt[^>]*>([^<]{1,10})<\/dt>\s*<dd[^>]*>([\s\S]{1,200}?)<\/dd>/g;
      let dm;
      while ((dm = ddRe.exec(html))) {
        const k = Roum27.unescapeHtml(dm[1]);
        const v = Roum27.stripTags(dm[2]);
        if (k === "作者" && v) author = v;
        else if (k === "狀態") {
          if (/連載|连载/.test(v)) status = "ongoing";
          else if (/完結|完结/.test(v)) status = "completed";
        } else if (k === "地區" && v) region.push(v);
      }

      let description = "";
      const syn = html.match(/site-book-synopsis[^"]*"[\s\S]{0,80}?>((?:[\s\S](?!<\/div>))*?)<\/div>/);
      if (syn) description = Roum27.stripTags(syn[1]);
      if (!description) {
        const ogd = html.match(/og:description"\s*content="([^"]+)"/);
        if (ogd) description = Roum27.unescapeHtml(ogd[1]);
      }

      // 章节: a.site-chapter-link（"開始閱讀"按钮锚点无此 class, 天然排除）
      const chapters = new Map();
      const seen = {};
      const aRe = /<a\b[^>]*class="site-chapter-link[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
      let am;
      while ((am = aRe.exec(html))) {
        const seg = am[1] + am[0];
        const hm = seg.match(/href="\/books\/[^"']+\/(\d+)"/) || (seg.match(/href="\/books\/[^"']+\/([^"']+)"/) || []);
        const epId = hm ? hm[1] : "";
        if (!epId || seen[epId]) continue;
        const tm = seg.match(/<span[^>]*title="([^"]+)"/);
        let name = tm ? Roum27.unescapeHtml(tm[1]) : "";
        if (!name) name = Roum27.stripTags(am[1]) || epId;
        seen[epId] = true;
        chapters.set(epId, name);
      }

      return new ComicDetails({
        id,
        title,
        cover,
        author,
        description,
        tags: Object.assign({}, region.length ? { 地區: region } : {}),
        status,
        chapters,
      });
    },

    loadEp: async (comicId, epId) => {
      // 站点对自动化客户端存在降级响应: 200 但页面在路由 flight 数据处截断,
      // 只剩广告载荷、无正文图。识别该形态并重试一次; 仍降级则声明环境受限。
      let html = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
        const res = await Network.get(
          `${this.baseUrl}books/${comicId}/${epId}`,
          Roum27.headers,
        );
        if (res.status !== 200) throw `Invalid status: ${res.status}`;
        html = res.body || "";

        // 正文图: https://{cdn}/m/{token}/wm:0/sr:0/{base64 载荷}
        // 载荷必须解码为 s3://rouman/images/ 开头（广告为 roupub/advertiser-assets|adcs），
        // 且排除封面 cover.*
        const images = [];
        const seen = {};
        const re = /https:\/\/[a-zA-Z0-9.-]+\/m\/[^"'\s<>\\]+/g;
        let m;
        while ((m = re.exec(html))) {
          const u = m[0];
          if (seen[u]) continue;
          const pm = u.match(/czM6Ly9[A-Za-z0-9+/=]+/);
          if (!pm) continue;
          const payload = Roum27.decodePayload(pm[0]);
          if (payload.indexOf("s3://rouman/images/") !== 0) continue;
          if (/\/cover\.(?:jpg|jpeg|png|webp)$/i.test(payload)) continue;
          seen[u] = true;
          images.push(u);
        }
        if (images.length > 0) return { images };

        // 页面完全不含图片载荷 → 结构变化(真实改版), 不做降级重试归类
        if (!/czM6Ly9/.test(html)) break;
      }

      if (/czM6Ly9/.test(html)) {
        throw "SITE_DEGRADED: 站点对自动化客户端降级响应(页面截断, 仅广告无正文图), 重试后仍未恢复";
      }
      throw "页面无图片载荷(站点结构可能变化)";
    },

    onImageLoad: (url, comicId, epId) => {
      return {
        headers: {
          Referer: this.referer,
        },
      };
    },

    idMatch: "^[A-Za-z0-9_-]{10,50}$",

    link: {
      domains: ["roum29.xyz", "roum28.xyz", "rouman5.com"],
      linkToId: (url) => {
        const m = String(url).match(/\/books\/([A-Za-z0-9-]+)/);
        return m ? m[1] : null;
      },
    },
  };
}
