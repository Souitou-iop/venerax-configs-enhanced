/** @type {import('./_venera_.js')} */

/**
 * 热门漫画 (m.remenmanhua.com)
 * 列表 /comic/{id}，章节 /view/{id}.html，图片 API /e/extend/api/index.php
 *
 * 实测要点 (2026-11-14): 首页列表为唯一已验证的探索入口 (/cate/ 无漫画条目);
 * 章节页从隐藏域取 id/zid/numid 后调章节 API 拼图片列表;
 * API 返回的图片 URL 为协议相对 (//static.998876.xyz/...), 需补 https: 前缀。
 * POST /e/search/ 站内搜索在 CLI 环境未复现成功(响应抖动), 保留上游设计。
 */
class Remenmanhua extends ComicSource {
  name = "热门漫画";
  key = "remenmanhua";
  version = "1.0.0";
  minAppVersion = "1.0.0";
  url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/remenmanhua.js";

  static baseUrl = "http://m.remenmanhua.com";
  static headers = {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    Accept: "text/html,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };

  static abs(href) {
    if (!href) return "";
    if (/^https?:/i.test(href)) return href;
    if (/^\/\//.test(href)) return "https:" + href;
    try {
      return new URL(href, Remenmanhua.baseUrl + "/").href;
    } catch (_) {
      return href;
    }
  }

  static parseList(document) {
    let comics = [];
    let seen = {};
    for (let a of document.querySelectorAll("a[href*='/comic/']")) {
      let href = a.attributes["href"] || "";
      let m = href.match(/\/comic\/(\d+)\.?/);
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
      comics.push(new Comic({ id, title, cover: Remenmanhua.abs(cover) }));
    }
    return comics;
  }

  explore = [
    {
      title: "首页",
      type: "multiPageComicList",
      load: async (page) => {
        if ((page || 1) > 1) return { comics: [], maxPage: 1 };
        let res = await Network.get(`${Remenmanhua.baseUrl}/`, Remenmanhua.headers);
        if (res.status !== 200) throw `Invalid status: ${res.status}`;
        let document = new HtmlDocument(res.body);
        return { comics: Remenmanhua.parseList(document), maxPage: 1 };
      },
    },
  ];

  search = {
    load: async (keyword, options, page) => {
      page = page || 1;
      let body = `show=title,ftitle,author,body&tbname=comic&tempid=1&keyboard=${encodeURIComponent(keyword)}`;
      let res = await Network.post(
        `${Remenmanhua.baseUrl}/e/search/`,
        {
          ...Remenmanhua.headers,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: Remenmanhua.baseUrl + "/",
        },
        body
      );
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let document = new HtmlDocument(res.body);
      return { comics: Remenmanhua.parseList(document), maxPage: 1 };
    },
    optionList: [],
  };

  comic = {
    loadInfo: async (id) => {
      id = String(id).replace(/\D/g, "");
      let url = `${Remenmanhua.baseUrl}/comic/${id}`;
      let res = await Network.get(url, Remenmanhua.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let document = new HtmlDocument(res.body);
      let titleEl = document.querySelector("h1.title, article h1, h1");
      let title = titleEl ? titleEl.text.trim() : "";
      title = title.replace(/^漫画名称[：:]/, "").trim();
      if (!title) {
        let t = (res.body.match(/<title[^>]*>([^<]+)/i) || [])[1] || id;
        title = t.split("|")[0].trim() || id;
      }
      let coverEl = document.querySelector(".cover img, .book-cover img, img.lazyload, img");
      let cover = "";
      if (coverEl) cover = coverEl.attributes["data-src"] || coverEl.attributes["src"] || "";

      let chapters = new Map();
      let items = [];
      let seen = {};
      for (let a of document.querySelectorAll("a[href*='/view/']")) {
        let href = a.attributes["href"] || "";
        let m = href.match(/\/view\/(\d+)\.html/);
        if (!m) continue;
        let cid = m[1];
        if (seen[cid]) continue;
        let name = (a.text || "").trim().replace(/\s+/g, " ");
        if (/开始阅读|继续阅读|加入|书架/i.test(name)) continue;
        seen[cid] = true;
        items.push([cid, name || `话 ${cid}`]);
      }
      for (let [cid, name] of items) chapters.set(cid, name);
      return new ComicDetails({
        title,
        cover: Remenmanhua.abs(cover),
        description: "",
        tags: {},
        chapters,
      });
    },

    loadEp: async (comicId, epId) => {
      epId = String(epId).replace(/\D/g, "");
      let pageUrl = `${Remenmanhua.baseUrl}/view/${epId}.html`;
      let res = await Network.get(pageUrl, {
        ...Remenmanhua.headers,
        Referer: `${Remenmanhua.baseUrl}/comic/${comicId}`,
      });
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let html = res.body;
      let id = (html.match(/id=["']id["'][^>]*value=["'](\d+)["']/i) ||
        html.match(/value=["'](\d+)["'][^>]*id=["']id["']/i) ||
        [])[1];
      let zid = (html.match(/id=["']zid["'][^>]*value=["'](\d+)["']/i) ||
        html.match(/value=["'](\d+)["'][^>]*id=["']zid["']/i) ||
        [])[1];
      let nid = (html.match(/id=["']numid["'][^>]*value=["'](\d+)["']/i) ||
        html.match(/value=["'](\d+)["'][^>]*id=["']numid["']/i) ||
        [])[1];
      if (!id) id = epId;
      if (!zid) zid = String(comicId).replace(/\D/g, "");
      if (!nid) nid = "1";
      let api = `${Remenmanhua.baseUrl}/e/extend/api/index.php?type=chapter&filter=info&id=${id}&zid=${zid}&nid=${nid}`;
      let apiRes = await Network.get(api, {
        ...Remenmanhua.headers,
        Accept: "application/json,*/*",
        Referer: pageUrl,
      });
      if (apiRes.status !== 200) throw `Invalid status: ${apiRes.status}`;
      let data;
      try {
        data = JSON.parse(apiRes.body);
      } catch (_) {
        throw "chapter api json parse failed";
      }
      let images = [];
      let seen = {};
      for (let block of data.data || []) {
        for (let it of block.list || []) {
          let u = Remenmanhua.abs(it.img || "");
          if (!u || seen[u]) continue;
          // 付费试看占位 / 站点皮肤图
          if (/\/skin\/images\//i.test(u) || /shikan|vip\d*\.png/i.test(u)) continue;
          seen[u] = true;
          images.push(u);
        }
      }
      if (images.length < 1) throw "No images (paywalled or empty)";
      return { images };
    },

    onImageLoad: (url, comicId, epId) => {
      return {
        headers: {
          Referer: Remenmanhua.baseUrl + "/",
          "User-Agent": Remenmanhua.headers["User-Agent"],
        },
      };
    },
  };
}
