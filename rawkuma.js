/** @type {import('./_venera_.js')} */

/**
 * Rawkuma (rawkuma.net) —— 日文 RAW 汉化源, WordPress 站
 * 列表 WP REST /wp-json/wp/v2/manga → 章节 admin-ajax chapter_list → 章节页 data-image-data
 *
 * 实测要点 (2026-11-14): 正文图片在 cdn.rawkuma.com, 直接下载无需 Referer;
 * 部分条目的 chapter_list 返回空 (仅部分番号有独立章节), 需跳过或按全一话兜底。
 */
class Rawkuma extends ComicSource {
  name = "Rawkuma";
  key = "rawkuma";
  version = "1.0.0";
  minAppVersion = "1.0.0";
  url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/rawkuma.js";

  static baseUrl = "https://rawkuma.net";
  static headers = {
    Referer: "https://rawkuma.net/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "*/*",
  };

  static api(path) {
    return `${Rawkuma.baseUrl}/wp-json/wp/v2/${path}`;
  }

  static parseMangaItem(it) {
    let cover = "";
    try {
      cover = it._embedded?.["wp:featuredmedia"]?.[0]?.source_url || "";
    } catch (_) {}
    return new Comic({
      id: String(it.id),
      title: (it.title?.rendered || it.slug || "").replace(/&#\d+;|&[a-z]+;/g, "").trim(),
      cover,
    });
  }

  explore = [
    {
      title: "最新",
      type: "multiPageComicList",
      load: async (page) => {
        page = page || 1;
        let res = await Network.get(
          Rawkuma.api(`manga?page=${page}&per_page=20&_embed`), Rawkuma.headers);
        if (res.status !== 200) throw `Invalid status: ${res.status}`;
        let items = JSON.parse(res.body);
        if (!Array.isArray(items)) throw "unexpected REST response";
        return { comics: items.map(Rawkuma.parseMangaItem), maxPage: items.length > 0 ? page + 1 : page };
      },
    },
  ];

  search = {
    load: async (keyword, options, page) => {
      page = page || 1;
      let res = await Network.get(
        Rawkuma.api(`manga?search=${encodeURIComponent(keyword)}&page=${page}&per_page=20&_embed`),
        Rawkuma.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let items = JSON.parse(res.body);
      if (!Array.isArray(items)) throw "unexpected REST response";
      return { comics: items.map(Rawkuma.parseMangaItem), maxPage: items.length > 0 ? page + 1 : page };
    },
    optionList: [],
  };

  comic = {
    loadInfo: async (id) => {
      id = String(id).replace(/\D/g, "");
      let res = await Network.get(Rawkuma.api(`manga/${id}?_embed`), Rawkuma.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let it = JSON.parse(res.body);
      let title = (it.title?.rendered || it.slug || "").replace(/&#\d+;|&[a-z]+;/g, "").trim();
      let cover = "";
      try {
        cover = it._embedded?.["wp:featuredmedia"]?.[0]?.source_url || "";
      } catch (_) {}
      let description = (it.content?.rendered || "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();

      // 章节列表 (admin-ajax, page 参数为缓存穿透位)
      let chapters = new Map();
      let res2 = await Network.get(
        `${Rawkuma.baseUrl}/wp-admin/admin-ajax.php?manga_id=${id}&page=1&action=chapter_list`,
        Rawkuma.headers);
      if (res2.status === 200) {
        let re = /href="(https?:\/\/rawkuma\.net\/manga\/[^"]+|\/manga\/[^"]+)"/g;
        let x;
        let seen = {};
        while ((x = re.exec(res2.body)) !== null) {
          let href = x[1];
          let abs = href.startsWith("http") ? href : Rawkuma.baseUrl + href;
          if (seen[abs]) continue;
          seen[abs] = true;
          let seg = abs.replace(/\/$/, "").split("/").pop();
          let name = seg.replace(/[-_]/g, " ").trim() || seg;
          chapters.set(abs, name);
        }
      }
      // 部分条目无独立章节: 按全一话兜底, 指向漫画页本身 (同模板阅读页)
      if (chapters.size === 0) {
        let slug = it.slug || id;
        chapters.set(`${Rawkuma.baseUrl}/manga/${slug}/`, title || "全一话");
      }

      return new ComicDetails({
        title,
        cover,
        description,
        tags: {},
        chapters,
      });
    },

    loadEp: async (comicId, epId) => {
      let url = String(epId).startsWith("http") ? epId : Rawkuma.baseUrl + epId;
      let res = await Network.get(url, Rawkuma.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let body = res.body;
      // data-image-data 区块内的正文图 (cdn.rawkuma.com)
      let images = [];
      let seen = {};
      let re = /<img[^>]+(?:data-src|src)="(https?:\/\/cdn\.rawkuma\.com\/[^"]+)"/g;
      let x;
      while ((x = re.exec(body)) !== null) {
        let u = x[1];
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
          "User-Agent": Rawkuma.headers["User-Agent"],
        },
      };
    },
  };
}
