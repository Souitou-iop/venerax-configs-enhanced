/** @type {import('./_venera_.js')} */

/**
 * 漫本 (manben.com) —— dm5 族
 * 搜索 / 最新更新 / 章节 / 图片（cdndm5.com）
 *
 * 站点改版应对 (2026-11-14 实测): 阅读页初始 HTML 已壳化(无 packer/newImgs),
 * 图片改走 `chapterfun.ashx?cid={cid}&key=` 返回 Dean packer 脚本,
 * 解包产物公式: pix + pvalue[i] + `?cid=&key=&uk=&hkey=&=时间戳`。
 * 直接 eval 解包产物并调用 dm5imagefun() 即得完整图片 URL 数组。
 */
class Manben extends ComicSource {
  name = "漫本";
  key = "manben";
  version = "1.0.1";
  minAppVersion = "1.0.0";
  url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/manben.js";

  static baseUrl = "https://www.manben.com";
  static headers = {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
    Accept: "text/html,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };

  static abs(href) {
    if (!href) return "";
    if (/^https?:/i.test(href)) return href.replace(/^http:/i, "https:");
    try {
      return new URL(href, Manben.baseUrl + "/").href.replace(/^http:/i, "https:");
    } catch (_) {
      return href;
    }
  }

  static parseComicLinks(document) {
    // 搜索页与列表页锚点结构不同: 列表页 <a href="/mh-x/">含文本,
    // 搜索页为 纯图锚点(<a href="mh-x">无前导斜杠) + 标题锚点(<a><p class="title">)
    // 分离在同一条目上, 需按 id 合并 cover 与 title。
    let map = {};
    let order = [];
    for (let a of document.querySelectorAll("a[href*='mh-']")) {
      let href = a.attributes["href"] || "";
      let m = href.match(/mh-[^\/#?\s]+/i);
      if (!m) continue;
      let id = m[0];
      if (/mh-(updated|boutique|recommend|rank)/i.test(id)) continue;
      if (!map[id]) {
        map[id] = { title: "", cover: "" };
        order.push(id);
      }
      let title = (a.attributes["title"] || a.text || "").trim();
      if (!title) {
        let p = a.querySelector("p.title, .title");
        if (p) title = (p.text || "").trim();
      }
      if (title && !map[id].title) map[id].title = title;
      if (!map[id].cover) {
        let img = a.querySelector("img");
        if (img) map[id].cover = img.attributes["data-src"] || img.attributes["src"] || "";
      }
    }
    let comics = [];
    for (let id of order) {
      if (!map[id].title) continue;
      comics.push(new Comic({ id, title: map[id].title, cover: Manben.abs(map[id].cover) }));
    }
    return comics;
  }

  explore = [
    {
      title: "最新更新",
      type: "multiPageComicList",
      load: async (page) => {
        page = page || 1;
        let url =
          page <= 1
            ? `${Manben.baseUrl}/mh-updated/`
            : `${Manben.baseUrl}/mh-updated/pagerdata.ashx?t=2&pageindex=${page}&tagid=0&mt=1&tst=0&tsort=0`;
        let res = await Network.get(url, Manben.headers);
        if (res.status !== 200) throw `Invalid status: ${res.status}`;
        let document = new HtmlDocument(res.body);
        let comics = Manben.parseComicLinks(document);
        // 分页接口返回 JSON 数组
        if (!comics.length && res.body.trim().startsWith("[")) {
          try {
            let arr = JSON.parse(res.body) || [];
            comics = arr
              .map((it) => {
                let u = String(it.Url || it.url || "");
                let idMatch = u.match(/mh-[^\/]+/i);
                let id = idMatch ? idMatch[0] : "mh-" + u.replace(/\//g, "");
                return new Comic({
                  id,
                  title: it.Title || it.title || id,
                  cover: Manben.abs(it.ShowPicUrlSmall || it.Cover || ""),
                });
              })
              .filter((c) => c.title);
          } catch (_) {}
        }
        return { comics, maxPage: comics.length > 0 ? page + 1 : page };
      },
    },
  ];

  search = {
    load: async (keyword, options, page) => {
      page = page || 1;
      let url = `${Manben.baseUrl}/search?page=${page}&title=${encodeURIComponent(keyword)}`;
      let res = await Network.get(url, Manben.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let document = new HtmlDocument(res.body);
      return { comics: Manben.parseComicLinks(document), maxPage: page + 1 };
    },
    optionList: [],
  };

  comic = {
    loadInfo: async (id) => {
      id = String(id);
      if (!id.startsWith("mh-")) id = "mh-" + id.replace(/^\/+|\/+$/g, "");
      let res = await Network.get(`${Manben.baseUrl}/${id}/`, Manben.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let body = res.body;
      let document = new HtmlDocument(body);

      let titleEl = document.querySelector("h1, .title");
      let title = titleEl ? titleEl.text.trim() : "";
      if (!title) {
        title = ((body.match(/<title[^>]*>([^<]+)/i) || [])[1] || id)
          .split("_")[0]
          .trim();
      }
      let coverEl = document.querySelector(".mh_cover img, .cover img, img");
      let cover = "";
      if (coverEl) cover = coverEl.attributes["data-src"] || coverEl.attributes["src"] || "";

      // 章节链接 /m{cid}/: DOM 锚文本优先, 正则兜底
      let items = [];
      let seen = {};
      for (let a of document.querySelectorAll("a[href*='/m']")) {
        let href = a.attributes["href"] || "";
        let m2 = href.match(/\/m(\d+)\/?/);
        if (!m2 || seen[m2[1]]) continue;
        let name = (a.text || "").trim().replace(/\s+/g, " ");
        if (/开始阅读|继续阅读/i.test(name)) continue;
        seen[m2[1]] = true;
        items.push([m2[1], name]);
      }
      if (items.length === 0) {
        let re = /href="[^"]*\/m(\d+)\/?"/g;
        let x;
        while ((x = re.exec(body)) !== null) {
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
        cover: Manben.abs(cover),
        description: "",
        tags: {},
        chapters,
      });
    },

    loadEp: async (comicId, epId) => {
      epId = String(epId).replace(/\D/g, "");
      let res = await Network.get(
        `${Manben.baseUrl}/chapterfun.ashx?cid=${epId}&key=`,
        { ...Manben.headers, Referer: `${Manben.baseUrl}/m${epId}/` }
      );
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let body = res.body.trim();
      if (!body.startsWith("eval(")) throw "packer not found";
      // 两段式解包: 先求值 packer 调用得到源码字符串, 再执行源码并调用 dm5imagefun()
      let code = body.slice(5, body.lastIndexOf(")"));
      let imgs;
      try {
        let unpacked = new Function(`return (${code})`)();
        imgs = new Function(`${unpacked}; return dm5imagefun();`)();
      } catch (e) {
        throw "packer eval failed";
      }
      if (!Array.isArray(imgs) || imgs.length < 1) throw "No images";
      let images = imgs.filter((u) => typeof u === "string" && /^https?:/i.test(u));
      if (images.length < 1) throw "No images";
      return { images };
    },

    onImageLoad: (url, comicId, epId) => {
      return {
        headers: {
          Referer: Manben.baseUrl + "/",
          "User-Agent": Manben.headers["User-Agent"],
        },
      };
    },
  };
}
