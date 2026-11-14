/** @type {import('./_venera_.js')} */

/**
 * 知音漫客 (m.zymk.cn) —— 正版国漫
 * 排序列表 /apinew/getsortlist_new → 详情 /{id}/ → 章节 /{id}/{chapter}.html → mhpic 图片
 *
 * 实测要点 (2026-11-14):
 * - 列表 API 的 key= 关键词过滤当前返回空 (站点搜索维度失效), 探索页按 sort=click 浏览;
 * - 章节页内嵌 chapter_addr_original + start_var/end_var + domain + comic_size,
 *   图片 URL 公式 https://mhpic.{domain}/comic/{addr}{N}.jpg{comic_size} (整章一次给全);
 * - 地址含中文路径, 请求需 encodeURI。
 */
class Zymk extends ComicSource {
  name = "知音漫客";
  key = "zymk";
  version = "1.0.0";
  minAppVersion = "1.0.0";
  url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/zymk.js";

  static baseUrl = "https://m.zymk.cn";
  static headers = {
    Referer: "https://m.zymk.cn/",
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    Accept: "*/*",
  };

  static sortListUrl(sort, page) {
    return `${Zymk.baseUrl}/apinew/getsortlist_new?key=&page=${page}&sort=${sort}`;
  }

  static parseSortList(body) {
    let data = JSON.parse(body);
    let list = data?.data?.page?.comic_list || [];
    return list.map(
      (it) =>
        new Comic({
          id: String(it.comic_id),
          title: it.comic_name,
          subtitle: it.last_chapter?.name || "",
          cover: "",
          description: it.comic_feature || "",
        })
    );
  }

  explore = [
    {
      title: "人气榜",
      type: "multiPageComicList",
      load: async (page) => {
        page = page || 1;
        let res = await Network.get(Zymk.sortListUrl("click", page), Zymk.headers);
        if (res.status !== 200) throw `Invalid status: ${res.status}`;
        let comics = Zymk.parseSortList(res.body);
        return { comics, maxPage: comics.length > 0 ? page + 1 : page };
      },
    },
  ];

  search = {
    load: async (keyword, options, page) => {
      page = page || 1;
      // 站点关键词维度当前返回空列表 (11-10/11-14 两次实测), 接口保留待站点修复
      let url = `${Zymk.baseUrl}/apinew/getsortlist_new?key=${encodeURIComponent(keyword)}&page=${page}&sort=click`;
      let res = await Network.get(url, Zymk.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let comics = Zymk.parseSortList(res.body);
      return { comics, maxPage: comics.length > 0 ? page + 1 : page };
    },
    optionList: [],
  };

  comic = {
    loadInfo: async (id) => {
      id = String(id).replace(/\D/g, "");
      let res = await Network.get(`${Zymk.baseUrl}/${id}/`, Zymk.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let body = res.body;
      let document = new HtmlDocument(body);
      let titleEl = document.querySelector("h1");
      let title = titleEl ? titleEl.text.trim() : "";
      if (!title) {
        title = ((body.match(/<title[^>]*>([^<]+)/i) || [])[1] || id)
          .split("_")[0]
          .replace(/漫画.*$/, "")
          .trim();
      }
      // 封面尽力而为: 详情页第一张 zymkcdn/mhpic 图
      let cover =
        (body.match(/(?:data-src|src)="([^"]*(?:zymkcdn|mhpic)[^"]*\.(?:jpg|png|webp)[^"]*)"/i) || [])[1] || "";

      // 章节按钮 (DOM 序为新→旧, 反转成旧→新)
      let items = [];
      for (let a of document.querySelectorAll("a.chapterBtn, .chapterBtn a")) {
        let href = a.attributes["href"] || "";
        if (!/\.html?$/i.test(href) && !/^\d+\.html?$/i.test(href)) continue;
        let name = (a.text || "").trim();
        items.push([href.replace(/^\//, ""), name]);
      }
      items.reverse();
      let chapters = new Map();
      for (let [href, name] of items) chapters.set(href, name || href);

      return new ComicDetails({
        title,
        cover,
        description: "",
        tags: {},
        chapters,
      });
    },

    loadEp: async (comicId, epId) => {
      let href = String(epId).replace(/^\//, "");
      let res = await Network.get(`${Zymk.baseUrl}/${comicId}/${href}`, Zymk.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let body = res.body;
      let addr = (body.match(/chapter_addr_original:"([^"]*)"/) || [])[1];
      let start = (body.match(/start_var:(\d+)/) || [])[1];
      let end = (body.match(/end_var:(\d+)/) || [])[1];
      let dom = (body.match(/domain:"([^"]*)"/) || [])[1] || "yyhao.com";
      let sz = (body.match(/comic_size:"([^"]*)"/) || [])[1] || "";
      if (!addr || !start || !end) throw "chapter page missing addr/vars (paywalled or changed)";
      let s = parseInt(start);
      let e = parseInt(end);
      if (!(e >= s && e - s <= 500)) throw "invalid page range";
      let images = [];
      for (let n = s; n <= e; n++) {
        images.push(encodeURI(`https://mhpic.${dom}/comic/${addr}${n}.jpg${sz}`));
      }
      return { images };
    },

    onImageLoad: (url, comicId, epId) => {
      return {
        headers: {
          Referer: Zymk.baseUrl + "/",
          "User-Agent": Zymk.headers["User-Agent"],
        },
      };
    },
  };
}
