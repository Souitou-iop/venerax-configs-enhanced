class WManhuaSource extends ComicSource {
    name = "W漫画"
    key = "wmanhua"
    version = "1.0.4"
    minAppVersion = "1.6.0"
    url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/wmanhua.js"

    get baseUrl() {
        return "https://www.wmanhua.com/";
    }

    init() {
        this.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": this.baseUrl
        }
    }

    explore = [
        {
            title: "W漫画",
            type: "multiPartPage",
            load: async (page) => {
                let res = await Network.get(this.baseUrl, this.headers)
                if (res.status !== 200) {
                    throw `Invalid status code: ${res.status}`
                }

                let document = new HtmlDocument(res.body)
                let result = []

                let sections = document.querySelectorAll(".card-main")
                for (let sec of sections) {
                    let titleElem = sec.querySelector("h2")
                    let title = titleElem ? titleElem.text.trim() : ""
                    if (!title) continue

                    let comics = []
                    let items = sec.querySelectorAll(".card-content")
                    for (let item of items) {
                        let link = item.querySelector("a")
                        let img = item.querySelector("img")

                        let id = ""
                        let href = link ? (link.attributes["href"] || "") : ""
                        let match = href.match(/\/comic\/(\d+)\.html/)
                        if (match) {
                            id = match[1]
                        }

                        let titleText = ""
                        if (link) {
                            let titleElem2 = link.querySelector(".cardtitle, h3")
                            titleText = titleElem2 ? titleElem2.text.trim() : link.text.trim()
                        }

                        let cover = ""
                        if (img) {
                            cover = img.attributes["data-src"] || img.attributes["src"] || ""
                        }

                        if (id && titleText) {
                            comics.push(new Comic({
                                id: id,
                                title: titleText,
                                cover: cover,
                            }))
                        }
                    }

                    if (comics.length > 0) {
                        result.push({ title: title, comics: comics })
                    }
                }

                // 2026-11 站点改版: 首页不再有 .card-main 分区, 兜底扫描全部漫画封面锚点
                if (result.length === 0) {
                    let comics = []
                    let seenIds = {}
                    for (let a of document.querySelectorAll("a[href*='/comic/']")) {
                        let href = a.attributes["href"] || ""
                        let m = href.match(/\/comic\/(\d+)\.html/)
                        if (!m || seenIds[m[1]]) continue
                        let img = a.querySelector("img")
                        if (!img) continue
                        let t = (img.attributes["alt"] || a.attributes["aria-label"] || "").trim()
                        if (!t) continue
                        seenIds[m[1]] = true
                        comics.push(new Comic({
                            id: m[1],
                            title: t,
                            cover: img.attributes["src"] || img.attributes["data-src"] || "",
                        }))
                    }
                    if (comics.length > 0) {
                        result.push({ title: "W漫画", comics: comics })
                    }
                }

                document.dispose()
                return result
            }
        }
    ]

    category = {
        title: "W漫画",
        parts: [
            {
                name: "分类",
                type: "fixed",
                categories: [
                    "全部", "欢乐", "生活", "爱情", "奇幻", "冒险", "轻改", "魔幻",
                    "重生", "修仙", "校园", "悬疑", "侦探", "玄幻", "职场", "搞笑",
                    "格斗", "游戏", "灵异", "性转", "仙侠", "都市", "后宫", "穿越",
                    "百合", "转生", "女主", "热血", "末世", "异界", "异能", "长篇",
                    "萌系", "系统", "魔法", "科幻", "日常", "惊悚", "恐怖", "武侠",
                    "励志", "耽美", "复仇", "养成", "同人", "美食", "言情", "逆袭",
                    "竞技", "战争", "爆笑", "生存", "战斗", "诡异", "网游", "推理",
                    "恋爱"
                ],
                categoryParams: [
                    "0", "1", "2", "3", "4", "5", "6", "7",
                    "8", "9", "10", "11", "12", "13", "14", "15",
                    "16", "17", "18", "19", "20", "21", "22", "23",
                    "24", "25", "26", "27", "28", "29", "30", "31",
                    "33", "34", "35", "36", "37", "38", "63", "44",
                    "45", "47", "48", "49", "50", "54", "55", "56",
                    "57", "59", "60", "62", "65", "68", "69", "71",
                    "72"
                ],
                itemType: "category",
            }
        ],
        enableRankingPage: false,
    }

    categoryComics = {
        load: async (category, param, options, page) => {
            let tag = param || "0"
            let url = `${this.baseUrl}sort?category=0&tag=${tag}`
            if (page > 1) {
                url = url + `&page=${page}`
            }

            let res = await Network.get(url, this.headers)
            if (res.status !== 200) {
                throw `Invalid status code: ${res.status}`
            }

            let document = new HtmlDocument(res.body)
            let items = document.querySelectorAll(".card-content")

            let comics = []
            for (let item of items) {
                let link = item.querySelector("a")
                let img = item.querySelector("img")

                let id = ""
                let href = link ? (link.attributes["href"] || "") : ""
                let match = href.match(/\/comic\/(\d+)\.html/)
                if (match) {
                    id = match[1]
                }

                let titleText = ""
                if (link) {
                    let titleElem2 = link.querySelector(".cardtitle, h3")
                    titleText = titleElem2 ? titleElem2.text.trim() : link.text.trim()
                }
                if (!titleText && item.localName === "a") {
                    // 2026-11 改版结构: 标题在 h3, 兜底 aria-label
                    let h3 = item.querySelector("h3")
                    titleText = h3 ? h3.text.trim() : (item.attributes["aria-label"] || "").trim()
                }

                let cover = ""
                if (img) {
                    cover = img.attributes["data-src"] || img.attributes["src"] || ""
                }
                if (!cover && item.localName === "a") {
                    // 2026-11 改版: 封面在 .thumb 的 background-image
                    let thumb = item.querySelector(".thumb, div[style*='background-image']")
                    if (thumb) {
                        let style = thumb.attributes["style"] || ""
                        let bm = style.match(/url\(['"]?([^'")]+)['"]?\)/)
                        if (bm) cover = bm[1]
                    }
                }

                if (id && titleText) {
                    comics.push(new Comic({
                        id: id,
                        title: titleText,
                        cover: cover,
                    }))
                }
            }

            let maxPage = 1
            let allLinks = document.querySelectorAll("a")
            for (let link of allLinks) {
                let href = link.attributes["href"] || ""
                let text = link.text.trim()
                if (href.indexOf("page=") >= 0 && /^\d+$/.test(text)) {
                    let num = parseInt(text)
                    if (num > maxPage) {
                        maxPage = num
                    }
                }
            }

            document.dispose()
            return {
                comics: comics,
                maxPage: maxPage
            }
        },
        optionList: []
    }

    search = {
        load: async (keyword, options, page) => {
            let url = `${this.baseUrl}search?query=${encodeURIComponent(keyword)}`
            if (page > 1) {
                url = url + `&page=${page}`
            }

            let res = await Network.get(url, this.headers)
            if (res.status !== 200) {
                throw `Invalid status code: ${res.status}`
            }

            let document = new HtmlDocument(res.body)
            // 2026-11 站点改版: 搜索结果为 <a class="book" href="/comic/{id}.html">
            //   <div class="thumb" style="background-image:url(封面)">…</div><h3>标题</h3></a>
            // 旧 .card-content 结构已不存在; 保留旧解析兜底。
            let items = document.querySelectorAll("a.book")
            if (items.length === 0) {
                items = document.querySelectorAll(".card-content")
            }

            let comics = []
            for (let item of items) {
                let link = item.querySelector("a") || item
                let img = item.querySelector("img")

                let id = ""
                let href = (item.localName === "a" ? item.attributes["href"] : "") || (link ? (link.attributes["href"] || "") : "")
                let match = href.match(/\/comic\/(\d+)\.html/)
                if (match) {
                    id = match[1]
                }

                let titleText = ""
                if (link) {
                    let titleElem2 = link.querySelector(".cardtitle, h3")
                    titleText = titleElem2 ? titleElem2.text.trim() : link.text.trim()
                }
                if (!titleText && item.localName === "a") {
                    // 2026-11 改版结构: 标题在 h3, 兜底 aria-label
                    let h3 = item.querySelector("h3")
                    titleText = h3 ? h3.text.trim() : (item.attributes["aria-label"] || "").trim()
                }

                let cover = ""
                if (img) {
                    cover = img.attributes["data-src"] || img.attributes["src"] || ""
                }
                if (!cover && item.localName === "a") {
                    // 2026-11 改版: 封面在 .thumb 的 background-image
                    let thumb = item.querySelector(".thumb, div[style*='background-image']")
                    if (thumb) {
                        let style = thumb.attributes["style"] || ""
                        let bm = style.match(/url\(['"]?([^'")]+)['"]?\)/)
                        if (bm) cover = bm[1]
                    }
                }

                if (id && titleText) {
                    comics.push(new Comic({
                        id: id,
                        title: titleText,
                        cover: cover,
                    }))
                }
            }

            let maxPage = 1
            let allLinks = document.querySelectorAll("a")
            for (let link of allLinks) {
                let href = link.attributes["href"] || ""
                let text = link.text.trim()
                if (href.indexOf("page=") >= 0 && /^\d+$/.test(text)) {
                    let num = parseInt(text)
                    if (num > maxPage) {
                        maxPage = num
                    }
                }
            }

            document.dispose()
            return {
                comics: comics,
                maxPage: maxPage
            }
        },
        enableTagsSuggestions: false,
    }

    comic = {
        loadInfo: async (id) => {
            let url = `${this.baseUrl}comic/${id}.html`
            let res = await Network.get(url, this.headers)
            if (res.status !== 200) {
                throw `Invalid status code: ${res.status}`
            }

            let document = new HtmlDocument(res.body)

            let titleElem = document.querySelector("h1")
            let title = titleElem ? titleElem.text.trim() : ""

            let coverImg = document.querySelector("img[alt*='封面'], .cover img, img[src*='cover'], .comic-cover img, .info img")
            let cover = ""
            if (coverImg) {
                cover = coverImg.attributes["src"] || coverImg.attributes["data-src"] || ""
            }
            if (!cover) {
                let allImgs = document.querySelectorAll("img")
                for (let img of allImgs) {
                    let src = img.attributes["src"] || img.attributes["data-src"] || ""
                    if (src.indexOf("cover") >= 0 || src.indexOf("/comic/") >= 0) {
                        cover = src
                        break
                    }
                }
            }
            if (cover && !cover.startsWith("http")) {
                if (cover.startsWith("//")) {
                    cover = "https:" + cover
                } else {
                    cover = this.baseUrl.replace(/\/$/, "") + cover
                }
            }

            let description = ""
            let descElem = document.querySelector(".description, .comic-desc, .intro, .detail-info p")
            if (descElem) {
                description = descElem.text.trim()
            }

            let author = ""
            let tags = []
            let updateTime = ""

            let authorDivs = document.querySelectorAll(".author")
            for (let div of authorDivs) {
                let text = div.text.trim()
                if (text.indexOf("作者") === 0 || text.indexOf("作者：") === 0 || text.indexOf("作者:") === 0) {
                    author = text.replace(/^作者[：:]\s*/, "").trim()
                } else if (text.indexOf("标签") === 0 || text.indexOf("标签：") === 0 || text.indexOf("标签:") === 0) {
                    let tagLinks = div.querySelectorAll("a")
                    for (let link of tagLinks) {
                        let tagText = link.text.trim()
                        if (tagText && tags.indexOf(tagText) === -1) {
                            tags.push(tagText)
                        }
                    }
                } else if (text.indexOf("更新") === 0 || text.indexOf("更新：") === 0 || text.indexOf("更新:") === 0) {
                    updateTime = text.replace(/^更新[：:]\s*/, "").trim()
                }
            }

            let chapters = new Map()

            let apiUrl = `${this.baseUrl}comic/${id}`
            let postHeaders = {}
            for (let k in this.headers) {
                postHeaders[k] = this.headers[k]
            }
            postHeaders["Content-Type"] = "application/json"

            try {
                let apiRes = await Network.post(apiUrl, postHeaders, JSON.stringify({}))
                let apiData = JSON.parse(apiRes.body)
                // 2026-11: 新版接口返回 {data:{chapters:[...]}} 不再带 code 字段, 两种形态都接受
                if ((apiData.code === 0 || apiData.code === undefined) && apiData.data && apiData.data.chapters && apiData.data.chapters.length > 0) {
                    let chapterList = apiData.data.chapters
                    for (let i = chapterList.length - 1; i >= 0; i--) {
                        let ch = chapterList[i]
                        let chId = ch.contentId ? `${ch.contentId}-${ch.id}` : String(ch.id)
                        let chTitle = ch.chapterName
                        if (chId && chTitle) {
                            chapters.set(chId, chTitle)
                        }
                    }
                }
            } catch (e) {
            }

            if (chapters.size === 0) {
                let chapterContainer = document.querySelector(".chapter-list .flex")
                if (chapterContainer) {
                    let chapterLinks = chapterContainer.querySelectorAll("a.chaper-btn")
                    let chapterArr = []
                    for (let link of chapterLinks) {
                        let href = link.attributes["href"] || ""
                        let chMatch = href.match(/\/chapter\/(\d+-\d+)\.html/)
                        if (chMatch) {
                            let chId = chMatch[1]
                            let chTitle = link.text.trim()
                            if (chId && chTitle) {
                                chapterArr.push({ id: chId, title: chTitle })
                            }
                        }
                    }
                    for (let i = chapterArr.length - 1; i >= 0; i--) {
                        if (!chapters.has(chapterArr[i].id)) {
                            chapters.set(chapterArr[i].id, chapterArr[i].title)
                        }
                    }
                }
            }

            if (chapters.size === 0) {
                let chapterContainer = document.querySelector(".chapter-list, .list-chapter, .chapter-box")
                if (chapterContainer) {
                    let chapterLinks = chapterContainer.querySelectorAll("a")
                    let chapterArr = []
                    for (let link of chapterLinks) {
                        let href = link.attributes["href"] || ""
                        let chMatch = href.match(/\/chapter\/(\d+-\d+)\.html/)
                        if (chMatch) {
                            let chId = chMatch[1]
                            let chTitle = link.text.trim()
                            if (chId && chTitle) {
                                chapterArr.push({ id: chId, title: chTitle })
                            }
                        }
                    }
                    for (let i = chapterArr.length - 1; i >= 0; i--) {
                        if (!chapters.has(chapterArr[i].id)) {
                            chapters.set(chapterArr[i].id, chapterArr[i].title)
                        }
                    }
                }
            }

            document.dispose()

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
            })
        },

        loadEp: async (comicId, epId) => {
            // 2026-11 改版: 章节地址为 /chapter/{contentId}-{chapterId}.html; 兼容只传 chapterId
            let seg = String(epId).includes("-") ? String(epId) : `${comicId}-${epId}`
            let url = `${this.baseUrl}chapter/${seg}.html`
            let res = await Network.get(url, this.headers)
            if (res.status !== 200) {
                throw `Invalid status code: ${res.status}`
            }

            let document = new HtmlDocument(res.body)
            let images = []

            let html = res.body

            // 新版阅读器: 内嵌脚本按 imgBaseUrl + 序号 .webp 动态构建图片
            // imgBaseUrl 源码形如 'https://…/mh/{封面hash}/' + ('{章节path}' || '…') + '/', 为字符串拼接
            let totalMatch = html.match(/var\s+totalPages\s*=\s*parseInt\('(\d+)'\)/)
            let baseMatch = html.match(/var\s+imgBaseUrl\s*=\s*'([^']+)'\s*\+\s*\('([^']+)'/)
            if (totalMatch && baseMatch) {
                let total = parseInt(totalMatch[1])
                if (total > 0 && total < 500) {
                    let imgBase = baseMatch[1] + baseMatch[2] + "/"
                    for (let i = 1; i <= total; i++) {
                        images.push(imgBase + i + ".webp")
                    }
                }
            }

            if (images.length === 0) {
                let numMatch = html.match(/var\s+num\s*=\s*eval\s*\(\s*["'](\d+)["']\s*\)/)
                let pasdMatch = html.match(/var\s+pasd\s*=\s*["']([^"']+)["']/)

                if (numMatch && pasdMatch) {
                    let num = parseInt(numMatch[1])
                    let pasd = pasdMatch[1]
                    if (num > 0 && pasd) {
                        for (let i = 1; i <= num; i++) {
                            images.push(pasd + i + ".webp")
                        }
                    }
                }
            }

            if (images.length === 0) {
                let imgContainer = document.querySelector(".images")
                if (imgContainer) {
                    let imgs = imgContainer.querySelectorAll("img.comic-image")
                    for (let img of imgs) {
                        let src = img.attributes["data-src"] || img.attributes["src"] || ""
                        if (src && src.indexOf("loading") === -1 && src.indexOf("/cover") === -1 && images.indexOf(src) === -1) {
                            if (!src.startsWith("http")) {
                                if (src.startsWith("//")) {
                                    src = "https:" + src
                                } else if (src.startsWith("/")) {
                                    src = this.baseUrl.replace(/\/$/, "") + src
                                }
                            }
                            images.push(src)
                        }
                    }
                }
            }

            document.dispose()
            return {
                images: images
            }
        },

        onImageLoad: (url, comicId, epId) => {
            return {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Referer": this.baseUrl
                }
            }
        },
    }
}
