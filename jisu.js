/** @type {import('./_venera_.js')} */

/**
 * 极速漫画 (www.1kkk.com) —— dm5 族
 * 搜索 /search?title= → 详情 /manhua{id}/ → 章节 /ch{n}-{cid}/ → chapterfun.ashx packer
 *
 * 实测要点 (2026-11-14): 章节页含 DM5_CID/DM5_MID/DM5_IMAGE_COUNT/DM5_VIEWSIGN(_DT) 参数,
 * 拼入 chapterfun.ashx 查询串后单次请求即返回整章图片 (实测 26 页一次给全);
 * 解包产物为 pix + pvalue 路径 (+ ?cid=&key= 签名)。图片 Referer 必须为章节页。
 */
class Jisu extends ComicSource {
  name = "极速漫画";
  key = "jisu";
  version = "1.0.0";
  minAppVersion = "1.0.0";
  url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/jisu.js";

  static baseUrl = "https://www.1kkk.com";
  static headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };

  static parseList(document) {
    let comics = [];
    let seen = {};
    for (let a of document.querySelectorAll("a[href*='manhua']")) {
      let href = a.attributes["href"] || "";
      let m = href.match(/manhua(\d+)\/?/i);
      if (!m) continue;
      let id = m[1];
      if (seen[id]) continue;
      let title = (a.attributes["title"] || a.text || "").trim();
      if (!title) {
        let img = a.querySelector("img");
        if (img) title = img.attributes["alt"] || "";
      }
      if (!title || title.length < 1) continue;
      seen[id] = true;
      let img = a.querySelector("img");
      let cover = "";
      if (img) cover = img.attributes["data-src"] || img.attributes["src"] || "";
      comics.push(new Comic({ id, title, cover: Jisu.abs(cover) }));
    }
    return comics;
  }

  static abs(href) {
    if (!href) return "";
    if (/^https?:/i.test(href)) return href;
    try {
      return new URL(href, Jisu.baseUrl + "/").href;
    } catch (_) {
      return href;
    }
  }

  explore = [
    {
      title: "人气排行",
      type: "multiPageComicList",
      load: async (page) => {
        page = page || 1;
        let res = await Network.get(`${Jisu.baseUrl}/list/geek/1--${page}.html`, Jisu.headers);
        if (res.status !== 200) throw `Invalid status: ${res.status}`;
        let document = new HtmlDocument(res.body);
        let comics = Jisu.parseList(document);
        return { comics, maxPage: comics.length > 0 ? page + 1 : page };
      },
    },
    {
      title: "最新上架",
      type: "multiPageComicList",
      load: async (page) => {
        page = page || 1;
        let res = await Network.get(`${Jisu.baseUrl}/list/geek/4--${page}.html`, Jisu.headers);
        if (res.status !== 200) throw `Invalid status: ${res.status}`;
        let document = new HtmlDocument(res.body);
        let comics = Jisu.parseList(document);
        return { comics, maxPage: comics.length > 0 ? page + 1 : page };
      },
    },
  ];

  search = {
    load: async (keyword, options, page) => {
      page = page || 1;
      let url = `${Jisu.baseUrl}/search?title=${encodeURIComponent(keyword)}&language=1&page=${page}`;
      let res = await Network.get(url, Jisu.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let document = new HtmlDocument(res.body);
      let comics = Jisu.parseList(document);
      return { comics, maxPage: comics.length > 0 ? page + 1 : page };
    },
    optionList: [],
  };

  comic = {
    loadInfo: async (id) => {
      id = String(id).replace(/\D/g, "");
      let url = `${Jisu.baseUrl}/manhua${id}/`;
      let res = await Network.get(url, Jisu.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let body = res.body;
      let document = new HtmlDocument(body);
      let titleEl = document.querySelector("h1, .title, .comic-title");
      let title = titleEl ? titleEl.text.trim() : "";
      if (!title) {
        title = ((body.match(/<title[^>]*>([^<]+)/i) || [])[1] || id)
          .split("_")[0]
          .trim();
      }
      let coverEl = document.querySelector(".comic-cover img, .detail-cover img, img");
      let cover = "";
      if (coverEl) cover = coverEl.attributes["data-src"] || coverEl.attributes["src"] || "";
      let descEl = document.querySelector(".comic-desc, .content, .desc");
      let description = descEl ? descEl.text.trim() : "";

      // 章节 /ch{n}-{cid}/ —— n 与 cid 需一起保存才能拼回章节页
      let chapters = new Map();
      let items = [];
      let seen = {};
      let re = /href="(?:https?:\/\/www\.1kkk\.com)?(\/ch\d+-\d+\/)"/g;
      let x;
      while ((x = re.exec(body)) !== null) {
        let seg = x[1].replace(/\//g, ""); // ch1-410069
        if (seen[seg]) continue;
        seen[seg] = true;
        items.push([seg, ""]);
      }
      items.forEach(([seg], idx) => {
        chapters.set(seg, `第${idx + 1}话`);
      });

      return new ComicDetails({
        title,
        cover: Jisu.abs(cover),
        description,
        tags: {},
        chapters,
      });
    },

    loadEp: async (comicId, epId) => {
      // epId 形如 "1-410069" (ch{n}-{cid} 的路径段)
      let seg = String(epId).replace(/[^0-9-]/g, "");
      let cid0 = seg.split("-")[1] || seg;
      let churl = `${Jisu.baseUrl}/ch${seg}/`;
      let res = await Network.get(churl, Jisu.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let body = res.body;
      let cid = (body.match(/DM5_CID\s*=\s*(\d+)/) || [])[1] || cid0;
      let mid = (body.match(/DM5_MID\s*=\s*(\d+)/) || [])[1];
      let sign = (body.match(/DM5_VIEWSIGN\s*=\s*"([^"]+)"/) || [])[1];
      let signDt = (body.match(/DM5_VIEWSIGN_DT\s*=\s*"([^"]+)"/) || [])[1];
      if (!sign) throw "chapter page missing DM5_VIEWSIGN";
      let query =
        `cid=${cid}&page=1&key=&language=1&gtk=6&_cid=${cid}` +
        (mid ? `&_mid=${mid}` : "") +
        (signDt ? `&_dt=${encodeURIComponent(signDt)}` : "") +
        `&_sign=${sign}`;
      let res2 = await Network.get(`${Jisu.baseUrl}/chapterfun.ashx?${query}`, {
        ...Jisu.headers,
        Referer: churl,
      });
      if (res2.status !== 200) throw `Invalid status: ${res2.status}`;
      let ashx = res2.body.trim();
      if (!ashx.startsWith("eval(")) throw "packer not found";
      // 两段式解包: packer 调用 → 源码字符串, 从中取 pix/pvalue/key (与实测链路一致)
      let code = ashx.slice(5, ashx.lastIndexOf(")"));
      let unpacked;
      try {
        unpacked = new Function(`return (${code})`)();
      } catch (e) {
        throw "packer eval failed";
      }
      let pix = (unpacked.match(/var pix=["']([^"']+)["']/) || [])[1];
      let pv = (unpacked.match(/var pvalue=(\[[^\]]*\])/) || [])[1];
      let key = (unpacked.match(/var key=["']([^"']*)["']/) || [])[1];
      if (!pix || !pv) throw "unpacked payload missing pix/pvalue";
      let paths;
      try {
        paths = JSON.parse(pv.replace(/'/g, '"'));
      } catch (_) {
        paths = pv.match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) || [];
      }
      if (!paths || paths.length < 1) throw "No images";
      let images = paths.map((p) => {
        if (/^https?:/i.test(p)) return p;
        let u = pix + p;
        if (key) u += `?cid=${cid}&key=${encodeURIComponent(key)}`;
        return u;
      });
      return { images };
    },

    onImageLoad: (url, comicId, epId) => {
      return {
        headers: {
          Referer: `${Jisu.baseUrl}/ch${String(epId).replace(/[^0-9-]/g, "")}/`,
          "User-Agent": Jisu.headers["User-Agent"],
        },
      };
    },
  };
}
