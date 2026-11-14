/** @type {import('./_venera_.js')} */

/**
 * jcomic.net —— 单本画廊站
 * 分类 /cat/{name} → 搜索 /search/{kw} → 漫画页 /page/{id} (单章)
 *
 * 实测要点 (2026-11-14):
 * - 匿名直连可用 (无需 jcomic_access cookie, 实测两种均返回 15 条列表);
 * - 图片为 data-locked 保护: 去掉 JCOMIC_TRAPS_ 前缀 → 反转 → base64 解出真实 URL,
 *   解不出 http 开头的即陷阱图, 直接丢弃;
 * - 阅读页后端偶发无图壳页, 接入端建议对空结果重试 1-2 次 (Venera 端由用户重试兜底)。
 */
class Jcomic extends ComicSource {
  name = "JComic";
  key = "jcomic";
  version = "1.0.0";
  minAppVersion = "1.0.0";
  url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/jcomic.js";

  static baseUrl = "https://jcomic.net";
  static headers = {
    Referer: "https://jcomic.net/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,*/*",
  };

  static abs(href) {
    if (!href) return "";
    if (/^https?:/i.test(href)) return href;
    try {
      return new URL(href, Jcomic.baseUrl + "/").href;
    } catch (_) {
      return href;
    }
  }

  static parseList(document) {
    let comics = [];
    let seen = {};
    for (let a of document.querySelectorAll("a[href*='/page/']")) {
      let href = a.attributes["href"] || "";
      let m = href.match(/\/page\/([^\/]+)/);
      if (!m) continue;
      let id = decodeURIComponent(m[1]);
      if (seen[id]) continue;
      let title = (a.attributes["title"] || a.text || "").trim();
      if (!title) {
        let img = a.querySelector("img");
        if (img) title = img.attributes["alt"] || "";
      }
      if (!title) continue;
      seen[id] = true;
      let img = a.querySelector("img");
      let cover = "";
      if (img) cover = img.attributes["data-src"] || img.attributes["src"] || "";
      comics.push(new Comic({ id, title, cover: Jcomic.abs(cover) }));
    }
    return comics;
  }

  explore = [
    {
      title: "同人",
      type: "multiPageComicList",
      load: async (page) => {
        page = page || 1;
        let url = page <= 1
          ? `${Jcomic.baseUrl}/cat/${encodeURIComponent("同人")}`
          : `${Jcomic.baseUrl}/cat/${encodeURIComponent("同人")}/${page}`;
        let res = await Network.get(url, Jcomic.headers);
        if (res.status !== 200) throw `Invalid status: ${res.status}`;
        let document = new HtmlDocument(res.body);
        let comics = Jcomic.parseList(document);
        return { comics, maxPage: comics.length > 0 ? page + 1 : page };
      },
    },
  ];

  search = {
    load: async (keyword, options, page) => {
      page = page || 1;
      let url = page <= 1
        ? `${Jcomic.baseUrl}/search/${encodeURIComponent(keyword)}`
        : `${Jcomic.baseUrl}/search/${encodeURIComponent(keyword)}/${page}`;
      let res = await Network.get(url, Jcomic.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let document = new HtmlDocument(res.body);
      let comics = Jcomic.parseList(document);
      return { comics, maxPage: comics.length > 0 ? page + 1 : page };
    },
    optionList: [],
  };

  comic = {
    loadInfo: async (id) => {
      // id 为 slug (如 "[Patreon] Genesis（AI）"), 非数字
      id = decodeURIComponent(String(id));
      let res = await Network.get(`${Jcomic.baseUrl}/page/${encodeURIComponent(id)}`, Jcomic.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let body = res.body;
      let document = new HtmlDocument(body);
      let titleEl = document.querySelector("h1, .title");
      let title = titleEl ? titleEl.text.trim() : "";
      if (!title) {
        title = ((body.match(/<title[^>]*>([^<]+)/i) || [])[1] || id).trim();
      }
      let coverEl = document.querySelector("img");
      let cover = "";
      if (coverEl) cover = coverEl.attributes["data-src"] || coverEl.attributes["src"] || "";

      // 单本画廊: 单章指向自身
      let chapters = new Map();
      chapters.set(id, title || id);

      return new ComicDetails({
        title,
        cover: Jcomic.abs(cover),
        description: "",
        tags: {},
        chapters,
      });
    },

    loadEp: async (comicId, epId) => {
      epId = decodeURIComponent(String(epId));
      let res = await Network.get(`${Jcomic.baseUrl}/page/${encodeURIComponent(epId)}`, Jcomic.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let body = res.body;
      // data-locked: JCOMIC_TRAPS_ 前缀 → 反转 → base64 → 真实 URL (陷阱图解不出 http, 丢弃)
      let images = [];
      let re = /data-locked="([^"]+)"/g;
      let x;
      while ((x = re.exec(body)) !== null) {
        try {
          let val = x[1].replace("JCOMIC_TRAPS_", "").split("").reverse().join("");
          let u = Convert.decodeUtf8(Convert.decodeBase64(val));
          if (/^https?:/i.test(u)) images.push(u);
        } catch (_) { /* 陷阱图或非法编码, 跳过 */ }
      }
      if (images.length < 1) throw "No images (empty shell page, retry recommended)";
      return { images };
    },

    onImageLoad: (url, comicId, epId) => {
      return {
        headers: {
          Referer: Jcomic.baseUrl + "/",
          "User-Agent": Jcomic.headers["User-Agent"],
        },
      };
    },
  };
}
