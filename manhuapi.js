/** @type {import('./_venera_.js')} */

/**
 * 漫画皮 (www.manhuapi.cc)
 * 列表 /manhua/，章节菜单 /menu/{id}.html，阅读页 jhc-data 图片属性
 *
 * 实测要点 (2026-11-14): 列表/菜单/阅读页链路已验证, 图片域 manhuapi.dwdghg.com;
 * 站内搜索 /search/ CLI 实测返回空结果页, 保留入口并回退到列表。
 */
class Manhuapi extends ComicSource {
  name = "漫画皮";
  key = "manhuapi";
  version = "1.0.0";
  minAppVersion = "1.0.0";
  url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/manhuapi.js";

  static baseUrl = "http://www.manhuapi.cc";
  static headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };

  static abs(href) {
    if (!href) return "";
    if (/^https?:/i.test(href)) return href;
    if (/^\/\//.test(href)) return "http:" + href;
    try {
      return new URL(href, Manhuapi.baseUrl + "/").href;
    } catch (_) {
      return href;
    }
  }

  static parseList(document) {
    let comics = [];
    let seen = {};
    for (let a of document.querySelectorAll("a[href*='/manhua/']")) {
      let href = a.attributes["href"] || "";
      let m = href.match(/\/manhua\/(\d+)\.html/);
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
      comics.push(new Comic({ id, title, cover: Manhuapi.abs(cover) }));
    }
    return comics;
  }

  explore = [
    {
      title: "全部漫画",
      type: "multiPageComicList",
      load: async (page) => {
        page = page || 1;
        let url =
          page <= 1
            ? `${Manhuapi.baseUrl}/manhua/`
            : `${Manhuapi.baseUrl}/manhua/0_0_0_0_0_${page}.html`;
        let res = await Network.get(url, Manhuapi.headers);
        if (res.status !== 200) throw `Invalid status: ${res.status}`;
        let document = new HtmlDocument(res.body);
        let comics = Manhuapi.parseList(document);
        return { comics, maxPage: comics.length > 0 ? page + 1 : page };
      },
    },
  ];

  search = {
    load: async (keyword, options, page) => {
      page = page || 1;
      // 站内搜索 CLI 实测返回空结果页; 空结果时回退列表
      let url = `${Manhuapi.baseUrl}/search/?keywords=${encodeURIComponent(keyword)}&page=${page}`;
      let res = await Network.get(url, Manhuapi.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let document = new HtmlDocument(res.body);
      let comics = Manhuapi.parseList(document);
      if (!comics.length) {
        let list = await Network.get(`${Manhuapi.baseUrl}/manhua/`, Manhuapi.headers);
        if (list.status === 200) comics = Manhuapi.parseList(new HtmlDocument(list.body));
      }
      return { comics, maxPage: comics.length > 0 ? page + 1 : page };
    },
    optionList: [],
  };

  comic = {
    loadInfo: async (id) => {
      id = String(id).replace(/\D/g, "");
      let url = `${Manhuapi.baseUrl}/manhua/${id}.html`;
      let res = await Network.get(url, Manhuapi.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let document = new HtmlDocument(res.body);
      let titleEl = document.querySelector("h1, .title, .book-title");
      let title = titleEl ? titleEl.text.trim() : id;
      if (!title) {
        title = ((res.body.match(/<title[^>]*>([^<]+)/i) || [])[1] || id)
          .split("_")[0]
          .trim();
      }
      let coverEl = document.querySelector(".cover img, .pic img, img");
      let cover = "";
      if (coverEl) cover = coverEl.attributes["data-src"] || coverEl.attributes["src"] || "";

      // 章节菜单页为完整目录 (实测 15 章)
      let chapters = new Map();
      let items = [];
      let seen = {};
      let menu = await Network.get(`${Manhuapi.baseUrl}/menu/${id}.html`, Manhuapi.headers);
      if (menu.status === 200) {
        let md = new HtmlDocument(menu.body);
        for (let a of md.querySelectorAll("a[href*='/chapter/']")) {
          let href = a.attributes["href"] || "";
          let m = href.match(/\/chapter\/(\d+)\.html/i);
          if (!m) continue;
          let cid = m[1];
          if (seen[cid]) continue;
          seen[cid] = true;
          let name = (a.text || "").trim().replace(/\s+/g, " ");
          items.push([cid, name || cid]);
        }
      }
      // 菜单为空时回退详情页内嵌章节
      if (items.length === 0) {
        for (let a of document.querySelectorAll("a[href*='/chapter/']")) {
          let href = a.attributes["href"] || "";
          let m = href.match(/\/chapter\/(\d+)\.html/i);
          if (!m) continue;
          let cid = m[1];
          if (seen[cid]) continue;
          seen[cid] = true;
          let name = (a.text || "").trim().replace(/\s+/g, " ");
          items.push([cid, name || cid]);
        }
      }
      for (let [cid, name] of items) chapters.set(cid, name);
      return new ComicDetails({
        title,
        cover: Manhuapi.abs(cover),
        description: "",
        tags: {},
        chapters,
      });
    },

    loadEp: async (comicId, epId) => {
      epId = String(epId).replace(/\D/g, "");
      let url = `${Manhuapi.baseUrl}/chapter/${epId}.html`;
      let res = await Network.get(url, {
        ...Manhuapi.headers,
        Referer: `${Manhuapi.baseUrl}/manhua/${comicId}.html`,
      });
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let html = res.body;
      let images = [];
      let seen = {};
      // jhc-data 属性为图片地址 (实测链路)
      let re = /jhc-data=["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(html))) {
        let u = Manhuapi.abs(m[1]);
        if (!u || seen[u]) continue;
        if (!/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(u) && !/tupian|kantu|upload/i.test(u))
          continue;
        seen[u] = true;
        images.push(u);
      }
      if (images.length < 1) {
        let re2 = /(?:data-src|src)=["']([^"']+\.(?:jpg|jpeg|png|webp))["']/gi;
        while ((m = re2.exec(html))) {
          let u = Manhuapi.abs(m[1]);
          if (!u || seen[u] || /logo|icon|template/i.test(u)) continue;
          seen[u] = true;
          images.push(u);
        }
      }
      if (images.length < 1) throw "No images";
      return { images };
    },

    onImageLoad: (url, comicId, epId) => {
      return {
        headers: {
          Referer: Manhuapi.baseUrl + "/",
          "User-Agent": Manhuapi.headers["User-Agent"],
        },
      };
    },
  };
}
