/** @type {import('./_venera_.js')} */
class ManWaBa extends ComicSource {
  name = "漫蛙漫画";
  key = "manwaba";
  version = "2.0.4";
  minAppVersion = "1.4.0";
  url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/manwaba.js";

  settings = {
    domain: {
      title: "主域名",
      type: "input",
      default: "manwame.com",
    },
  };

  get baseUrl() {
    let domain = this.loadSetting("domain") || "manwame.com";
    return `https://${domain}`;
  }

  /// AES-128-CBC 解密密钥 (hex)
  aesKeyHex = "355626526f52254a6640704a50796446";

  /// hex 字符串转 ArrayBuffer
  hexToBytes(hex) {
    let buf = new ArrayBuffer(hex.length / 2);
    let view = new Uint8Array(buf);
    for (let i = 0; i < hex.length; i += 2) {
      view[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return buf;
  }

  /// 解密章节图片参数
  async decryptParams(params) {
    let key = this.hexToBytes(this.aesKeyHex);
    let encrypted = await Convert.decodeBase64(params);
    let view = new Uint8Array(encrypted);
    let iv = view.slice(0, 16).buffer;
    let ciphertext = view.slice(16).buffer;
    let decrypted = await Convert.decryptAesCbc(ciphertext, key, iv);

    // Convert.decryptAesCbc 不会自动去除 PKCS7 填充, 需手动剥离
    let decBytes = new Uint8Array(decrypted);
    let len = decBytes.length;
    if (len > 0) {
      let padLen = decBytes[len - 1];
      if (padLen > 0 && padLen <= 16 && padLen <= len) {
        let valid = true;
        for (let i = len - padLen; i < len; i++) {
          if (decBytes[i] !== padLen) {
            valid = false;
            break;
          }
        }
        if (valid) {
          decBytes = decBytes.slice(0, len - padLen);
        }
      }
    }

    let json = await Convert.decodeUtf8(decBytes.buffer);
    // 安全兜底: 截断最后一个 } 之后的残余字符
    json = json.trim();
    let lastBrace = json.lastIndexOf("}");
    if (lastBrace >= 0 && lastBrace < json.length - 1) {
      json = json.substring(0, lastBrace + 1);
    }
    return JSON.parse(json);
  }

  /// 解析漫画卡片
  parseCard(e) {
    let coverLink = e.querySelector("a.manga-cover");
    let href = coverLink.attributes["href"];
    let id = href.split("/").pop();
    let img = coverLink.querySelector("img");
    let title = img.attributes["alt"];
    let cover = img.attributes["src"];
    let subTitle = e.querySelector("div.manga-meta > p")?.text?.trim() || "";
    return new Comic({
      id: id,
      title: title,
      cover: cover,
      subTitle: subTitle,
    });
  }

  /// 从分页元素中提取最大页码
  parseMaxPage(document) {
    let maxPage = 1;
    let links = document.querySelectorAll(".pagination a");
    for (let a of links) {
      let href = a.attributes["href"] || "";
      let match = href.match(/(?:page[=/])(\d+)/);
      if (match) {
        maxPage = Math.max(maxPage, parseInt(match[1]));
      }
    }
    return maxPage;
  }

  // 探索页面
  explore = [
    {
      title: this.name,
      type: "singlePageWithMultiPart",
      load: async () => {
        let res = await Network.get(this.baseUrl);
        if (res.status !== 200) {
          throw "Invalid status code: " + res.status;
        }
        let document = new HtmlDocument(res.body);
        let result = {};
        let sections = document.querySelectorAll("section.content-section");
        for (let section of sections) {
          let titleEl = section.querySelector("h2");
          if (!titleEl) continue;
          let title = titleEl.text.trim();
          let grid = section.querySelector("div.manga-grid");
          if (!grid) continue;
          let cards = grid.querySelectorAll("article.manga-card");
          if (cards.length === 0) continue;
          result[title] = cards.map((e) => this.parseCard(e));
        }
        document.dispose();
        return result;
      },
    },
  ];

  // 分类页面
  category = {
    title: this.name,
    parts: [
      {
        name: "类型",
        type: "fixed",
        categories: [
          "全部", "热血", "玄幻", "恋爱", "冒险", "古风", "都市",
          "穿越", "奇幻", "搞笑", "校园", "后宫", "百合", "科幻",
          "悬疑", "战斗", "重生", "逆袭", "日常", "纯爱",
        ],
        itemType: "category",
        categoryParams: [
          "", "rexue", "xuanhuan", "lianai", "maoxian", "gufeng", "dushi",
          "chuanyue", "qihuan", "gaoxiao", "xiaoyuan", "hougong", "baihe", "kehuan",
          "xuanyi", "zhandou", "zhongsheng", "nixi", "richang", "chunai",
        ],
      },
    ],
    enableRankingPage: false,
  };

  // 分类漫画
  categoryComics = {
    load: async (category, param, options, page) => {
      let path = "/category";
      if (param) path += `/theme/${param}`;
      if (options[0] !== "all") path += `/area/${options[0]}`;
      if (options[1] !== "all") path += `/state/${options[1]}`;
      path += `/order/${options[2]}`;
      if (page > 1) path += `/page/${page}`;

      let res = await Network.get(this.baseUrl + path);
      if (res.status !== 200) {
        throw "Invalid status code: " + res.status;
      }
      let document = new HtmlDocument(res.body);
      let cards = document.querySelectorAll("article.manga-card");
      let comics = cards.map((e) => this.parseCard(e));
      let maxPage = this.parseMaxPage(document);
      document.dispose();
      return {
        comics: comics,
        maxPage: maxPage,
      };
    },
    optionList: [
      {
        options: ["all-全部", "guonei-国内", "riben-日本", "hanguo-韩国"],
      },
      {
        options: ["all-全部", "lianzai-连载", "wanjie-完结"],
      },
      {
        options: ["views-热门人气", "update-更新时间"],
      },
    ],
  };

  // 搜索
  search = {
    load: async (keyword, options, page) => {
      let url = `${this.baseUrl}/search?q=${encodeURIComponent(keyword)}`;
      if (page > 1) {
        url += `&page=${page}`;
      }
      let res = await Network.get(url);
      if (res.status !== 200) {
        throw "Invalid status code: " + res.status;
      }
      let document = new HtmlDocument(res.body);
      let cards = document.querySelectorAll("article.manga-card");
      let comics = cards.map((e) => this.parseCard(e));
      let maxPage = this.parseMaxPage(document);
      document.dispose();
      return {
        comics: comics,
        maxPage: maxPage,
      };
    },
    optionList: [],
  };

  // 单个漫画
  comic = {
    // 加载漫画信息
    loadInfo: async (id) => {
      let url = `${this.baseUrl}/book/${id}`;
      let res = await Network.get(url);
      if (res.status !== 200) {
        throw "Invalid status code: " + res.status;
      }
      let document = new HtmlDocument(res.body);

      let title = document.querySelector("section.comic-profile h1").text.trim();
      let cover = document.querySelector("section.comic-profile .profile-cover img").attributes["src"];

      let author = "";
      let status = "";
      let updateTime = "";
      let profileText = document.querySelector("section.comic-profile .profile-text");
      if (profileText) {
        for (let p of profileText.querySelectorAll("p")) {
          let text = p.text.trim();
          if (text.startsWith("作者：")) author = text.replace("作者：", "").trim();
          else if (text.startsWith("状态：")) status = text.replace("状态：", "").trim();
          else if (text.startsWith("更新：")) updateTime = text.replace("更新：", "").trim();
        }
      }

      let tags = [];
      for (let a of document.querySelectorAll(".tag-strip a")) {
        tags.push(a.text.trim());
      }

      let description = document.querySelector(".intro-text")?.text?.trim() || "";

      let chapters = new Map();
      for (let link of document.querySelectorAll("div[data-chapter-list] a")) {
        let href = link.attributes["href"];
        let epId = href.split("/").pop().replace(".html", "");
        let epTitle = link.text.trim();
        chapters.set(epId, epTitle);
      }

      let recommend = [];
      let sections = document.querySelectorAll("section.content-section");
      for (let section of sections) {
        let h2 = section.querySelector("h2");
        if (h2 && h2.text.trim() === "猜你喜欢") {
          let cards = section.querySelectorAll("article.manga-card");
          recommend = cards.map((e) => this.parseCard(e));
          break;
        }
      }

      document.dispose();

      return new ComicDetails({
        title: title,
        cover: cover,
        description: description,
        tags: {
          作者: author ? [author] : [],
          标签: tags,
          状态: status ? [status] : [],
        },
        chapters: chapters,
        recommend: recommend,
        updateTime: updateTime,
      });
    },

    // 加载章节图片
    loadEp: async (comicId, epId) => {
      let url = `${this.baseUrl}/book/${comicId}/${epId}.html`;
      let res = await Network.get(url);
      if (res.status !== 200) {
        throw "Invalid status code: " + res.status;
      }

      // res.body 可能是 string 或 ArrayBuffer，统一转为 string
      let body = res.body;
      if (typeof body !== "string") {
        body = await Convert.decodeUtf8(body);
      }

      let paramsMatch = body.match(/params\s*=\s*'([^']+)'/);
      if (!paramsMatch) {
        throw "Failed to extract params from chapter page";
      }
      let params = paramsMatch[1];

      let decrypted = await this.decryptParams(params);

      let host =
        (decrypted.images_hosts && decrypted.images_hosts[0]) ||
        decrypted.images_domain ||
        decrypted.cdnurl ||
        "";
      if (!host) {
        throw "No image host found";
      }

      let chapterImages = decrypted.chapter_images || [];
      if (chapterImages.length === 0) {
        throw "No chapter images found";
      }

      let images = chapterImages.map((path) => {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path)) {
          return path;
        }
        return host.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
      });

      return { images: images };
    },

    // 图片加载配置(附带 Referer 头)
    onImageLoad: (url, comicId, epId) => {
      return {
        url: url,
        headers: {
          referer: this.baseUrl + "/",
        },
      };
    },
  };
}
