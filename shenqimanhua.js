/** @type {import('./_venera_.js')} */
class ShenQiManHua extends ComicSource {
  name = "神奇漫画";

  key = "shenqimanhua";

  version = "1.1.1";

  minAppVersion = "1.6.0";

  url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/shenqimanhua.js";

  settings = {
    domains: {
      title: "自定义域名",
      type: "input",
      default: "shenqimanhua.net"
    }
  };

  get baseUrl() {
    return `https://${this.loadSetting("domains") || this.settings.domains.default}`;
  }

  async getHtml(url) {
    let headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    };
    let res = await Network.get(url, headers);
    if (res.status !== 200) {
      throw "Invalid status code: " + res.status;
    }
    let document = new HtmlDocument(res.body);
    return document;
  }

  parseComicCard(linkElement) {
    if (!linkElement) return null;

    let href = linkElement.attributes["href"] || "";
    if (!href.includes("/comic/")) return null;

    let id = href.split("/comic/").pop().replace(/\/$/, "");
    if (!id) return null;

    let img = linkElement.querySelector("img");
    let title = "";
    let cover = "";

    if (img) {
      let alt = img.attributes["alt"] || "";
      if (alt.startsWith("《") && alt.endsWith("》封面")) {
        title = alt.slice(1, -3);
      }
      cover = img.attributes["src"] || img.attributes["data-src"] || "";
      if (cover && cover.startsWith("/")) {
        cover = this.baseUrl + cover;
      }
    }

    if (!title) {
      title = linkElement.text.trim();
    }

    return new Comic({
      id: id,
      title: title,
      cover: cover,
    });
  }

  explore = [
    {
      title: "神奇漫画",
      type: "multiPartPage",
      load: async (page) => {
        let document = await this.getHtml(this.baseUrl + "/");

        let isSectionTitle = (text) => {
          if (!text) return false;
          if (text === "热议") return false;
          if (text === "抢先更新") return false;
          if (text === "高能榜单") return false;
          if (text === "热门动漫") return false;
          if (/^《.+》$/.test(text)) return false;
          return true;
        };

        let isHeading = (el) => {
          if (!el) return false;
          let name = el.localName;
          return name === "h1" || name === "h2" || name === "h3";
        };

        let viewMoreMap = {
          "热门漫画": "sort:total",
          "新漫尝鲜": "sort:latest",
          "热血冒险": "theme:cmigxh0xk0004dsopw3n53al1",
          "3D漫画": "theme:cmj2dz7ie0001b4ovpz014eq4",
          "AI漫画": "theme:cmscw87m100frnme20nfehxrd",
        };

        let elements = document.querySelectorAll("h1, h2, h3, .grid");
        let currentTitle = null;
        let partsMap = new Map();
        let order = [];

        for (let el of elements) {
          if (isHeading(el)) {
            let text = (el.text || "").trim();
            currentTitle = isSectionTitle(text) ? text : null;
            continue;
          }

          if (!currentTitle) continue;

          let links = el.querySelectorAll("a[href*='/comic/']");
          let comics = [];
          for (let link of links) {
            let comic = this.parseComicCard(link);
            if (comic) {
              comics.push(comic);
            }
          }
          if (comics.length === 0) continue;

          if (!partsMap.has(currentTitle)) {
            partsMap.set(currentTitle, []);
            order.push(currentTitle);
          }
          let arr = partsMap.get(currentTitle);
          for (let c of comics) {
            arr.push(c);
          }
        }

        let parts = [];
        for (let title of order) {
          let part = { title: title, comics: partsMap.get(title) };
          if (viewMoreMap[title]) {
            part.viewMore = {
              page: "category",
              attributes: {
                category: title,
                param: viewMoreMap[title],
              },
            };
          }
          parts.push(part);
        }

        document.dispose();
        return parts;
      },
      loadNext(next) {},
    },
  ];

  category = {
    title: "神奇漫画",
    parts: [
      {
        name: "分类",
        type: "fixed",
        categories: [
          "全部", "复仇", "奇幻", "宫廷", "幻想", "恋爱",
          "悬疑", "暗黑", "校园", "欲望", "武侠", "治愈",
          "热血", "禁忌", "科幻", "穿越", "轻松", "进阶",
          "逆袭", "都市"
        ],
        categoryParams: [
          "", "复仇", "奇幻", "宫廷", "幻想", "恋爱",
          "悬疑", "暗黑", "校园", "欲望", "武侠", "治愈",
          "热血", "禁忌", "科幻", "穿越", "轻松", "进阶",
          "逆袭", "都市"
        ],
        itemType: "category",
      }
    ],
    enableRankingPage: false,
  };

  categoryComics = {
    load: async (category, param, options, page) => {
      let url;
      let hasPagination = true;

      if (param && param.startsWith("sort:")) {
        let sort = param.split(":")[1];
        url = `${this.baseUrl}/comics?sort=${sort}&page=${page}`;
      } else if (param && param.startsWith("theme:")) {
        let themeId = param.split(":")[1];
        url = `${this.baseUrl}/theme?id=${themeId}`;
        hasPagination = false;
      } else {
        let tag = param || "全部";
        let sort = options[0] || "total";
        url = `${this.baseUrl}/comics?tag=${encodeURIComponent(tag)}&sort=${sort}&page=${page}`;
      }

      let document = await this.getHtml(url);

      let comics = [];
      let grids = document.querySelectorAll(".grid");
      for (let grid of grids) {
        let links = grid.querySelectorAll("a[href*='/comic/']");
        for (let link of links) {
          let comic = this.parseComicCard(link);
          if (comic) {
            comics.push(comic);
          }
        }
      }

      let maxPage = 1;
      if (hasPagination) {
        let pageLinks = document.querySelectorAll("a[href*='page=']");
        for (let link of pageLinks) {
          let href = link.attributes["href"] || "";
          let match = href.match(/page=(\d+)/);
          if (match) {
            let num = parseInt(match[1]);
            if (num > maxPage) {
              maxPage = num;
            }
          }
        }
      }

      document.dispose();
      return {
        comics: comics,
        maxPage: maxPage
      };
    },
    optionList: [
      {
        options: ["total-最热", "latest-最新"],
      },
    ],
  };

  search = {
    load: async (keyword, options, page) => {
      let encodedKeyword = encodeURIComponent(keyword);
      let url = `${this.baseUrl}/search?query=${encodedKeyword}&page=${page}`;

      let document = await this.getHtml(url);

      let comics = [];
      let grid = document.querySelector(".grid.grid-cols-3");
      if (grid) {
        let links = grid.querySelectorAll("a[href*='/comic/']");
        for (let link of links) {
          let comic = this.parseComicCard(link);
          if (comic) {
            comics.push(comic);
          }
        }
      }

      let maxPage = 1;
      let pageLinks = document.querySelectorAll("a[href*='page=']");
      for (let link of pageLinks) {
        let href = link.attributes["href"] || "";
        let match = href.match(/page=(\d+)/);
        if (match) {
          let num = parseInt(match[1]);
          if (num > maxPage) {
            maxPage = num;
          }
        }
      }

      document.dispose();
      return {
        comics: comics,
        maxPage: maxPage
      };
    },
    enableTagsSuggestions: false,
  };

  comic = {
    loadInfo: async (id) => {
      let url = `${this.baseUrl}/comic/${id}`;
      let res = await Network.get(url, {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });
      if (res.status !== 200) {
        throw "Invalid status code: " + res.status;
      }

      let html = res.body;
      let document = new HtmlDocument(html);

      let title = "";
      let cover = "";
      let description = "";
      let author = "";
      let tags = [];
      let updateTime = "";

      let titleElement = document.querySelector("h1");
      if (titleElement) {
        title = titleElement.text.trim();
      }

      let statusLabels = document.querySelectorAll("span.text-gray-600");
      for (let span of statusLabels) {
        if (span.text.trim() === "状态：") {
          let statusValue = span.nextElementSibling;
          if (statusValue) {
            updateTime = statusValue.text.trim();
          }
          break;
        }
      }

      let ogImage = document.querySelector("meta[property='og:image']");
      if (ogImage) {
        cover = ogImage.attributes["content"] || "";
      }

      let ogDesc = document.querySelector("meta[property='og:description']");
      if (ogDesc) {
        description = ogDesc.attributes["content"] || "";
      }

      let chapterPattern = /\{\\"id\\":\\"(cm[a-z0-9]+)\\",\\"title\\":\\"([^\\"]+)\\",\\"number\\":(\d+),\\"createdAt\\":\\"[^\\"]*\\"/g;
      let chapters = new Map();
      let chapterList = [];
      let match;

      while ((match = chapterPattern.exec(html)) !== null) {
        let chId = match[1];
        let chTitle = match[2];
        let chNumber = parseInt(match[3]);
        chapterList.push({ id: chId, title: chTitle, number: chNumber });
      }

      chapterList.sort((a, b) => a.number - b.number);

      for (let ch of chapterList) {
        chapters.set(ch.id, ch.title);
      }

      let authorPattern = /"author":\{"@type":"Person","name":"([^"]+)"\}/;
      let authorMatch = html.match(authorPattern);
      if (authorMatch) {
        author = authorMatch[1];
      }

      let genrePattern = /"genre":\[([^\]]+)\]/;
      let genreMatch = html.match(genrePattern);
      if (genreMatch) {
        let genreStr = genreMatch[1];
        let genreMatches = genreStr.match(/"([^"]+)"/g);
        if (genreMatches) {
          tags = genreMatches.map(g => g.replace(/"/g, ""));
        }
      }

      if (!title) {
        let namePattern = /"name":"([^"]+)","url":"https:\/\/shenqimanhua\.cc\/comic\//;
        let nameMatch = html.match(namePattern);
        if (nameMatch) {
          title = nameMatch[1];
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
        },
        chapters: chapters,
        updateTime: updateTime,
      });
    },

    loadEp: async (comicId, epId) => {
      let url = `${this.baseUrl}/read/${comicId}/${epId}`;
      let document = await this.getHtml(url);

      let images = [];
      let imgs = document.querySelectorAll("img[src*='/image/']");

      for (let img of imgs) {
        let src = img.attributes["src"] || "";
        if (src && src.includes("/img/") && (src.endsWith(".webp") || src.endsWith(".jpg") || src.endsWith(".png"))) {
          if (src.startsWith("/")) {
            src = this.baseUrl + src;
          }
          images.push(src);
        }
      }

      if (images.length === 0) {
        let imgElements = document.querySelectorAll("img");
        for (let img of imgElements) {
          let alt = img.attributes["alt"] || "";
          if (alt.includes("第") && alt.includes("张图")) {
            let src = img.attributes["src"] || "";
            if (src) {
              if (src.startsWith("/")) {
                src = this.baseUrl + src;
              }
              images.push(src);
            }
          }
        }
      }

      document.dispose();
      return {
        images: images
      };
    },

    onImageLoad: (url, comicId, epId) => {
      return {
        headers: {
          "Referer": `${this.baseUrl}/`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }
      };
    },
  };
}
