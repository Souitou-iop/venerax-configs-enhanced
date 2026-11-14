/** @type {import('./_venera_.js')} */

/**
 * 漫画看 (m.wmh1234.com)
 * 搜索 / 分类 / 章节 / 图片（wszwhg.net 签名图域）
 *
 * 站点改版应对 (2026-11-14 实测): 阅读页不再直接含图片节点,
 * 而是 `location.replace("https://reader.hqread.cc/r/{token}")` 跳转到新阅读器,
 * 需手动跟随跳转后从 img.reader-image 的 data-src 取签名 WebP (?st=&e= 有效期签名,
 * 对 Referer 不敏感)。详情页 DOM 存在条目级差异, 章节解析带兜底。
 */
class Mhkan extends ComicSource {
  name = "漫画看";
  key = "mhkan";
  version = "1.0.0";
  minAppVersion = "1.0.0";
  url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/mhkan.js";

  static baseUrl = "https://m.wmh1234.com";
  static headers = {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    Accept: "text/html,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };

  static abs(href) {
    if (!href) return "";
    if (/^https?:/i.test(href)) return href;
    try {
      return new URL(href, Mhkan.baseUrl + "/").href;
    } catch (_) {
      return href;
    }
  }

  static parseList(document) {
    let comics = [];
    let seen = {};
    for (let a of document.querySelectorAll("a[href*='/comic/']")) {
      let href = a.attributes["href"] || "";
      let m = href.match(/\/comic\/(\d+)\.html/);
      if (!m) continue;
      let id = m[1];
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
      comics.push(new Comic({ id, title, cover: Mhkan.abs(cover) }));
    }
    return comics;
  }

  explore = [
    {
      title: "首页",
      type: "multiPageComicList",
      load: async (page) => {
        page = page || 1;
        let url = page <= 1 ? `${Mhkan.baseUrl}/` : `${Mhkan.baseUrl}/?page=${page}`;
        let res = await Network.get(url, Mhkan.headers);
        if (res.status !== 200) throw `Invalid status: ${res.status}`;
        let document = new HtmlDocument(res.body);
        let comics = Mhkan.parseList(document);
        return { comics, maxPage: comics.length > 0 ? page + 1 : page };
      },
    },
    {
      title: "分类",
      type: "multiPageComicList",
      load: async (page) => {
        page = page || 1;
        let url =
          page <= 1
            ? `${Mhkan.baseUrl}/category/`
            : `${Mhkan.baseUrl}/category/?page=${page}`;
        let res = await Network.get(url, Mhkan.headers);
        if (res.status !== 200) throw `Invalid status: ${res.status}`;
        let document = new HtmlDocument(res.body);
        let comics = Mhkan.parseList(document);
        return { comics, maxPage: comics.length > 0 ? page + 1 : page };
      },
    },
  ];

  search = {
    load: async (keyword, options, page) => {
      page = page || 1;
      let url = `${Mhkan.baseUrl}/search/?keywords=${encodeURIComponent(keyword)}`;
      if (page > 1) url += `&page=${page}`;
      let res = await Network.get(url, Mhkan.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let document = new HtmlDocument(res.body);
      return { comics: Mhkan.parseList(document), maxPage: page + 1 };
    },
    optionList: [],
  };

  comic = {
    loadInfo: async (id) => {
      id = String(id).replace(/\D/g, "");
      let res = await Network.get(`${Mhkan.baseUrl}/comic/${id}.html`, Mhkan.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let body = res.body;
      let document = new HtmlDocument(body);

      let titleEl = document.querySelector("h1, .comic-title, .detail-title");
      let title = titleEl ? titleEl.text.trim() : id;
      let coverEl = document.querySelector(
        ".comic-cover img, .detail-cover img, .cover img, img.lazy"
      );
      let cover = "";
      if (coverEl) cover = coverEl.attributes["data-src"] || coverEl.attributes["src"] || "";

      // 章节链接 /comic/{id}/{ep}.html; DOM 锚文本优先, 正则兜底 (详情页 DOM 有条目差异)
      let items = [];
      let seen = {};
      let re1 = new RegExp(`/comic/${id}/(\\d+)\\.html`, "i");
      for (let a of document.querySelectorAll("a[href*='/comic/']")) {
        let href = a.attributes["href"] || "";
        let m2 = re1.exec(href);
        if (!m2 || seen[m2[1]]) continue;
        let name = (a.text || "").trim().replace(/\s+/g, " ");
        if (/开始阅读|继续阅读/i.test(name)) continue;
        seen[m2[1]] = true;
        items.push([m2[1], name]);
      }
      if (items.length === 0) {
        let re2 = new RegExp(`comic/${id}/(\\d+)\\.html`, "gi");
        while ((x = re2.exec(body)) !== null) {
          if (seen[x[1]]) continue;
          seen[x[1]] = true;
          items.push([x[1], ""]);
        }
      }
      let chapters = new Map();
      items.forEach(([cid, name], idx) => {
        chapters.set(cid, name || `第${idx + 1}话`);
      });

      return new ComicDetails({
        title,
        cover: Mhkan.abs(cover),
        description: "",
        tags: {},
        chapters,
      });
    },

    loadEp: async (comicId, epId) => {
      comicId = String(comicId).replace(/\D/g, "");
      epId = String(epId).replace(/\D/g, "");
      let res = await Network.get(`${Mhkan.baseUrl}/comic/${comicId}/${epId}.html`, {
        ...Mhkan.headers,
        Referer: `${Mhkan.baseUrl}/comic/${comicId}.html`,
      });
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let body = res.body;
      // 改版: 阅读页 location.replace 跳 reader.hqread.cc, 需手动跟随
      let redir = (body.match(/location\.replace\("([^"]+)"\)/) || [])[1];
      if (redir) {
        let res2 = await Network.get(redir, {
          ...Mhkan.headers,
          Referer: `${Mhkan.baseUrl}/`,
        });
        if (res2.status !== 200) throw `Invalid status: ${res2.status}`;
        body = res2.body;
      }
      let document = new HtmlDocument(body);
      let images = [];
      let seen = {};
      for (let img of document.querySelectorAll("img.reader-image, img.lazy, img")) {
        let u = img.attributes["data-src"] || img.attributes["src"] || "";
        if (!u || /placeholder\.svg|logo|icon/i.test(u)) continue;
        if (!/\.(jpg|jpeg|png|webp)/i.test(u) && !/UploadFiles|wszwhg/i.test(u)) continue;
        u = Mhkan.abs(u);
        if (seen[u]) continue;
        seen[u] = true;
        images.push(u);
      }
      if (images.length < 1) throw "No images";
      return { images };
    },

    onImageLoad: (url, comicId, epId) => {
      return {
        headers: {
          Referer: Mhkan.baseUrl + "/",
          "User-Agent": Mhkan.headers["User-Agent"],
        },
      };
    },
  };
}
