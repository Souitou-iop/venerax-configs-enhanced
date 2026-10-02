/** @type {import('../_venera_.js')} */

/**
 * 漫画人 (manhuaren.com) —— Venera 漫画源（完全重写版 v2）
 *
 * ============================ 站点分析 ============================
 * 站点: 漫画人/DM5 移动版 (www.manhuaren.com)，匿名可访问，无需登录。
 * 分析依据: _analysis/fixtures/manhuaren/ 下 2026-09-11 的真实抓取夹具
 *           (manifest.jsonl 逐条记录来源 URL/状态/字节/抓取时间)。
 *
 * 1) 搜索      /search?title={kw}&language=1&page={page}
 *              列表: ul.book-list > li
 *                    .book-list-cover a[href][title] + img.book-list-cover-img[src]
 *                    .book-list-info-title / .book-list-info-desc
 *                    .book-list-info-bottom-item(标签) / .book-list-info-bottom-right-font(连载状态)
 *              (夹具 search_ship.html, 22 条)
 * 2) 分类列表  /manhua-list/            最热门
 *              /manhua-list-s2/         最近更新
 *              /manhua-list-s18/        最新上架
 *              /manhua-list-st2/        已完结
 *              /manhua-list-st1/        连载中
 *              (路径取自夹具 manhua_list.html 顶部 manga-list-bar 的自有链接)
 *              列表: .manga-list > ul.manga-list-2 > li
 *                    .manga-list-2-cover a[href] + img.manga-list-2-cover-img[src]
 *                    .manga-list-2-title / .manga-list-2-tip("最新 第178话")
 *              (夹具 manhua_list.html, 21 条 = 站点 pagesize)
 *              注意: 该页没有 HTML 分页，下一页由 dm5.ashx AJAX(POST) 提供，
 *              而匿名 POST dm5.ashx 返回 0 字节(夹具 category_dm5.json, 0B)，故不实现翻页。
 * 3) 排行榜    /manhua-rank/  (夹具 rank.html)
 *              ul.rank-list#rankList_1..4 = 人气榜/新番榜/收藏榜/吐槽榜，各 30 条
 *              结构: ul.rank-list > a[href=/manhua-<slug>/] > li
 *                    .rank-list-cover-img / .rank-list-info-right-title
 *                    .rank-list-info-right-subtitle / .rank-list-info-left-index
 *              (排行榜把 li 包在 a 内，属站点畸形 HTML，故按 a 聚合而不是 li)
 * 4) 详情      /manhua-{slug}/  (夹具 detail_haizeiwang.html)
 *              .detail-main-info-title / .detail-main-cover img
 *              .detail-main-info-author a / .detail-main-info-class a(标签)
 *              .detail-main-info-star.star-4(评分) / .detail-desc(简介)
 *              .normal-top-title(标题兜底)
 *              内联变量: var DM5_MID=432 (评论接口需要的 mid)
 *              章节列表: .detail-list 内的 /m{cid}/ 链接(移动版详情页章节容器)
 * 5) 章节      /m{cid}/  (夹具 chapter_m425189.html)
 *              页面用 Dean Edwards packer 保护图片数组:
 *              eval(function(p,a,c,k,e,d){...}('K s=[...]',49,49,'...'.split('|'),0,{}))
 *              解包后得到 var newImgs=[ 'https://manhua1032-61-174-50-99.cdndm5.com/17/16932/425189/1_8042.jpg?cid=425189&key=...&type=1', ... ]
 *              (夹具实测 30 张，顺序与页内 <label id="lbcurrentpage">1</label>/30 一致)
 *              内联变量: var mid="16932"; var cid="425189"
 * 6) 评论      JSON 数组，字段 Poster/PostContent/PostTime/Id/HeadUrl/PraiseCount/IsPraise/ToPostShowDataItems
 *              详情评论 /manhua-{mid}/pagerdata.ashx?d=&pageindex=&pagesize=&mid=&t=4
 *                       (夹具 detail_pagerdata.json, 10 条)
 *              章节评论 /showcomment/pagerdata.ashx?d=&pageindex=&pagesize=&cid=&t=9
 *                       (夹具 comments_chapter.json, 1 条)
 * 7) 图片      漫画图床为 *.cdndm5.com，需带 Referer(章节页) 与 UA。
 * ==================================================================
 */

class ManHuaRen extends ComicSource {
    name = "漫画人"

    key = "manhuaren"

    version = "2.0.1"

    minAppVersion = "1.6.0"

    // 更新地址
    url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/manhuaren.js"

    // 站点对无 UA 请求会返回异常页面，统一使用固定 UA
    static UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

    // 列表页每页条数(夹具 manhua_list.html 内联 var pagesize = "21")
    static LIST_PAGE_SIZE = 21

    // 详情评论接口一次可取回全部评论(夹具使用 pagesize=767)
    static DETAIL_COMMENT_PAGE_SIZE = 767

    // 章节评论接口每页条数(夹具使用 pagesize=20)
    static CHAPTER_COMMENT_PAGE_SIZE = 20

    // 排行榜子榜顺序与 /manhua-rank/ 页内 rankList_1..4 一致
    static RANK_NAMES = ["人气榜", "新番榜", "收藏榜", "吐槽榜"]

    // 章节链接形态 /m{cid}/
    static CHAPTER_PATH = /^\/m(\d+)\/?$/i

    // 漫画链接形态 /manhua-{slug}/(尾斜杠在部分内联链接里可省略)
    static COMIC_PATH = /^\/?(manhua-[^/?#]+)\/?/i

    // 站内非漫画的 /manhua-<slug>/ 页面(分类列表、排行榜)
    static NON_COMIC_SLUG = /^manhua-(?:list|rank)(?:-|$)/i

    // 图片扩展名(用于从解包脚本中过滤出图片直链)
    static IMAGE_URL = /\.(?:jpg|jpeg|png|webp|gif|bmp)(?:\?|$)/i

    get baseUrl() {
        return "https://www.manhuaren.com"
    }

    init() {
        // 站点无需登录、没有可缓存的域名列表，无需初始化任何数据
    }

    // ============================== 请求与工具 ==============================

    // 统一请求头，referer 为空时不发送 Referer
    _headers(referer) {
        let headers = {
            "User-Agent": ManHuaRen.UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
            "Cache-Control": "no-cache",
        }
        if (referer) headers["Referer"] = referer
        return headers
    }

    // 图片请求头: 图床校验 Referer 与 UA
    _imageHeaders(referer) {
        return {
            "User-Agent": ManHuaRen.UA,
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
            "Referer": referer || (this.baseUrl + "/"),
        }
    }

    /**
     * 统一 GET 请求入口，失败时抛出带 URL/状态码的可诊断错误。
     * @returns {Promise<string>} 响应正文
     */
    async _fetch(url, referer) {
        let res
        try {
            res = await Network.get(url, this._headers(referer))
        } catch (e) {
            throw new Error(`请求异常: ${url} -> ${(e && e.message) ? e.message : String(e)}`)
        }
        if (!res || typeof res.status !== "number") {
            throw new Error(`请求无响应: ${url}`)
        }
        if (res.status !== 200) {
            throw new Error(`请求失败 HTTP ${res.status}: ${url}`)
        }
        if (!res.body) {
            throw new Error(`响应正文为空(可能被风控或需要登录): ${url}`)
        }
        return res.body
    }

    // 相对路径/协议相对地址 -> 绝对地址
    _abs(path) {
        let u = String(path === undefined || path === null ? "" : path).trim()
        if (!u) return ""
        if (/^https?:\/\//i.test(u)) return u
        if (u.startsWith("//")) return "https:" + u
        if (u.startsWith("/")) return this.baseUrl + u
        return this.baseUrl + "/" + u
    }

    // 漫画 id -> 详情页绝对 URL(id 可以是绝对 URL、/manhua-<slug>/ 或裸 slug)
    _comicUrl(id) {
        let u = String(id === undefined || id === null ? "" : id).trim()
        if (!u) throw new Error("漫画 id 为空")
        if (/^https?:\/\//i.test(u)) return u
        if (u.startsWith("//")) return "https:" + u
        if (u.startsWith("/")) return this.baseUrl + u
        let parsed = this._comicId(u)
        if (parsed) return parsed
        return this.baseUrl + "/" + u.replace(/^\/+/, "").replace(/\/+$/, "") + "/"
    }

    // 封面/头像/图片地址归一化为 https 绝对地址
    _normImage(url) {
        let u = String(url === undefined || url === null ? "" : url).trim()
        if (!u) return ""
        if (u.startsWith("//")) return "https:" + u
        if (/^https?:\/\//i.test(u)) return u.replace(/^http:\/\//i, "https://")
        if (u.startsWith("/")) return this.baseUrl + u
        return this.baseUrl + "/" + u
    }

    // 文本清洗: 合并空白
    _clean(text) {
        let s = String(text === undefined || text === null ? "" : text)
        return s.replace(/\s+/g, " ").trim()
    }

    // 元素文本(不存在返回空串)
    _text(el) {
        return el ? this._clean(el.text) : ""
    }

    // 元素属性(不存在返回空串)
    _attr(el, name) {
        if (!el || !el.attributes) return ""
        let v = el.attributes[name]
        return v === undefined || v === null ? "" : String(v)
    }

    // 从 /manhua-{slug}/ 形式链接解析出统一漫画 id(绝对 URL, 去掉查询参数)
    _comicId(href) {
        if (!href) return null
        let u = String(href).trim().replace(/^https?:\/\/[^/]+/i, "")
        let m = u.match(ManHuaRen.COMIC_PATH)
        if (!m) return null
        // 排除 /manhua-list/、/manhua-rank/ 等非漫画页面
        if (ManHuaRen.NON_COMIC_SLUG.test(m[1])) return null
        return this.baseUrl + "/" + m[1] + "/"
    }

    // 从 /m{cid}/ 形式链接解析出章节 key(/m{cid}/)
    _chapterKey(href) {
        if (!href) return null
        let u = String(href).trim()
        if (/^https?:\/\//i.test(u)) u = u.replace(/^https?:\/\/[^/]+/i, "")
        let m = u.match(ManHuaRen.CHAPTER_PATH)
        return m ? `/m${m[1]}/` : null
    }

    // 从任意字符串(章节 id/纯数字)解析出章节数字 cid
    _chapterDigits(value) {
        if (!value) return null
        let m = String(value).match(/\/m(\d+)\b/) || String(value).match(/^(\d+)$/) || String(value).match(/(\d{3,})/)
        return m ? m[1] : null
    }

    // 从章节 id/URL 严格解析 cid（只接受 /m<cid>/、m<cid>、纯数字）
    _chapterCid(value) {
        let s = String(value === undefined || value === null ? "" : value).trim()
        let m = s.match(/\/m(\d+)\/?(?:[?#].*)?$/i) || s.match(/^m(\d+)$/i) || s.match(/^(\d+)$/)
        return m ? m[1] : null
    }

    // 章节 id/URL 归一化为标准章节页 URL（/m{cid}/）
    _chapterUrl(value) {
        let cid = this._chapterCid(value)
        if (cid) return `${this.baseUrl}/m${cid}/`
        return this._abs(value)
    }

    // ============================== HTML 片段解析 ==============================

    // 解析 manga-list 卡片(列表页/首页/推荐位共用)
    _parseMangaCard(item) {
        let coverA = item.querySelector(".manga-list-2-cover a") || item.querySelector("a")
        let id = this._comicId(this._attr(coverA, "href"))
        if (!id) return null

        let img = item.querySelector(".manga-list-2-cover-img") || item.querySelector("img")
        let titleEl = item.querySelector(".manga-list-2-title") || item.querySelector(".manga-list-1-title")
        let title = this._text(titleEl)
        if (!title) title = this._clean(this._attr(coverA, "title"))
        if (!title) return null

        let tipEl = item.querySelector(".manga-list-2-tip") || item.querySelector(".manga-list-1-tip")
        let badgeEl = item.querySelector(".manga-list-2-cover-logo-font") || item.querySelector(".manga-list-1-cover-logo-font")
        let badge = this._text(badgeEl)

        return new Comic({
            id: id,
            title: title,
            subTitle: this._text(tipEl),
            cover: this._normImage(this._attr(img, "data-src") || this._attr(img, "src")),
            tags: badge ? [badge] : [],
        })
    }

    // 解析容器内所有漫画卡片(root 可以是 HtmlDocument 或 .manga-list 元素)
    _parseMangaCards(root) {
        let comics = []
        let seen = {}
        for (let item of root.querySelectorAll("li")) {
            let c = null
            try {
                c = this._parseMangaCard(item)
            } catch (e) {
                // 单个卡片结构异常(站点畸形 HTML)时跳过该条目, 不影响整页解析
                c = null
            }
            if (!c || seen[c.id]) continue
            seen[c.id] = true
            comics.push(c)
        }
        return comics
    }

    // 解析页面中的 .manga-list 版块(首页聚合 / 详情页推荐位)
    _parseMangaSections(doc) {
        let sections = []
        for (let box of doc.querySelectorAll(".manga-list")) {
            let titleEl = box.querySelector(".manga-list-title")
            let title = this._text(titleEl).replace(/更多\s*$/, "").trim()
            let comics = this._parseMangaCards(box)
            if (comics.length === 0) continue
            sections.push({
                title: title || "漫画列表",
                comics: comics,
                moreHref: this._attr(titleEl ? titleEl.querySelector("a") : null, "href"),
            })
        }
        return sections
    }

    // 解析排行榜页: 每个 ul.rank-list 一个子榜
    _parseRankSections(doc) {
        let names = []
        for (let el of doc.querySelectorAll(".rank-selector-item")) {
            let n = this._text(el)
            names.push(n)
        }
        let lists = doc.querySelectorAll("ul.rank-list")
        let sections = []
        for (let i = 0; i < lists.length; i++) {
            let title = names[i] || ManHuaRen.RANK_NAMES[i] || `排行榜${i + 1}`
            let comics = []
            let seen = {}
            for (let a of lists[i].querySelectorAll("a")) {
                let id = this._comicId(this._attr(a, "href"))
                if (!id || seen[id]) continue
                let titleEl = a.querySelector(".rank-list-info-right-title")
                let subEl = a.querySelector(".rank-list-info-right-subtitle")
                let img = a.querySelector(".rank-list-cover-img")
                let indexEl = a.querySelector(".rank-list-info-left-index")
                let rankTitle = this._text(titleEl) || this._clean(this._attr(a, "title"))
                if (!rankTitle) continue
                let rank = this._text(indexEl)
                seen[id] = true
                comics.push(new Comic({
                    id: id,
                    title: rankTitle,
                    subTitle: this._text(subEl),
                    cover: this._normImage(this._attr(img, "src")),
                    tags: rank ? [`No.${rank}`] : [],
                }))
            }
            if (comics.length > 0) {
                sections.push({ title: title, comics: comics })
            }
        }
        return sections
    }

    // 解析搜索页
    _parseSearchResults(doc) {
        let comics = []
        for (let item of doc.querySelectorAll("ul.book-list > li")) {
            let linkA = item.querySelector(".book-list-cover a")
            let id = this._comicId(this._attr(linkA, "href"))
            if (!id) continue

            let titleEl = item.querySelector(".book-list-info-title")
            let title = this._text(titleEl)
            if (!title) title = this._clean(this._attr(linkA, "title"))
            if (!title) continue

            let img = item.querySelector(".book-list-cover-img")
            let cover = this._normImage(this._attr(img, "data-src") || this._attr(img, "src"))

            let tags = []
            for (let t of item.querySelectorAll(".book-list-info-bottom-item")) {
                let v = this._text(t)
                if (v) tags.push(v)
            }
            let status = this._text(item.querySelector(".book-list-info-bottom-right-font"))
            if (status) tags.push(status)

            comics.push(new Comic({
                id: id,
                title: title,
                cover: cover,
                description: this._text(item.querySelector(".book-list-info-desc")),
                tags: tags,
            }))
        }
        return comics
    }

    /**
     * 解析详情页章节列表。
     * 移动版详情页把章节放在 .detail-list 内，章节链接形如 /m{cid}/；
     * 部分页面只保留内层 .detail-list-2，故做一次容器兜底。
     */
    _parseChapters(doc) {
        let chapters = new Map()
        // 在线页为 ul.detail-list-1.detail-list-select；兼容旧主题 .detail-list / .detail-list-2
        let boxes = doc.querySelectorAll(".detail-list-1, .detail-list, .detail-list-2")
        for (let box of boxes) {
            for (let a of box.querySelectorAll("a")) {
                let key = this._chapterKey(this._attr(a, "href"))
                if (!key || chapters.has(key)) continue
                let title = this._clean(this._attr(a, "title")) || this._text(a)
                chapters.set(key, title || key)
            }
        }
        return chapters
    }

    // ============================== 章节图片解析 ==============================

    // 取出页面中用于保护图片地址的 packer 脚本
    _packedScript(html) {
        let doc = new HtmlDocument(html)
        try {
            for (let s of doc.querySelectorAll("script")) {
                let code = s.innerHTML || ""
                if (code.indexOf("eval(function(p,a,c,k,e,d)") >= 0) return code
            }
        } finally {
            doc.dispose()
        }
        return null
    }

    /**
     * 解包 Dean Edwards packer (eval(function(p,a,c,k,e,d){...}('...',a,c,'k'.split('|'),0,{})))。
     * 返回还原后的脚本字符串，无法识别时返回 null。
     */
    _unpackPacker(code) {
        let m = String(code).match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/)
        if (!m) return null

        let payload = m[1]
        let base = parseInt(m[2], 10)
        let count = parseInt(m[3], 10)
        let dict = m[4].split("|")
        if (!base || !count || isNaN(base) || isNaN(count)) return null

        // packer 的整数 -> 单词编码
        let encode = (n) => (n < base ? "" : encode(parseInt(n / base))) +
            ((n = n % base) > 35 ? String.fromCharCode(n + 29) : n.toString(36))

        let map = {}
        while (count--) {
            let token = encode(count)
            map[token] = dict[count] || token
        }
        return payload.replace(/\b\w+\b/g, (w) => (map[w] !== undefined ? map[w] : w))
    }

    // 从章节页 HTML 中解析图片地址(解包 newImgs 数组)
    _parseChapterImages(html) {
        let code = this._packedScript(html)
        if (!code) return []
        let decoded = this._unpackPacker(code)
        if (!decoded) return []

        let urls = decoded.match(/https?:\/\/[^\s'"\\,]+/g) || []
        let images = []
        let seen = {}
        for (let u of urls) {
            if (!ManHuaRen.IMAGE_URL.test(u)) continue
            if (seen[u]) continue
            seen[u] = true
            images.push(u)
        }
        return images
    }

    // ============================== 评论解析 ==============================

    // 单条评论 -> Comment
    _toComment(item, page) {
        let replies = Array.isArray(item.ToPostShowDataItems) ? item.ToPostShowDataItems : null
        return new Comment({
            id: `${item.Id}//${page}`,
            userName: this._clean(item.Poster),
            avatar: this._normImage(item.HeadUrl),
            content: String(item.PostContent === undefined || item.PostContent === null ? "" : item.PostContent),
            time: this._clean(item.PostTime),
            replyCount: replies ? replies.length : 0,
            isLiked: !!item.IsPraise,
        })
    }

    /**
     * 解析评论接口返回的 JSON 数组。
     * @param body {string}
     * @param page {number} 请求页码(用于生成可回传的评论 id)
     * @param pageSize {number} 该接口的每页条数(用于推断是否还有下一页)
     * @param replyTo {string?} 形如 "评论id//页码"
     */
    _parseComments(body, page, pageSize, replyTo) {
        let data
        try {
            data = JSON.parse(body)
        } catch (e) {
            let head = String(body).slice(0, 120)
            throw new Error(`评论接口返回非 JSON 数据: ${head}`)
        }
        if (!Array.isArray(data)) return { comments: [], maxPage: page }

        if (replyTo) {
            let targetId = String(replyTo).split("//")[0]
            let parent = null
            for (let item of data) {
                if (String(item.Id) === targetId) {
                    parent = item
                    break
                }
            }
            if (!parent || !Array.isArray(parent.ToPostShowDataItems)) {
                return { comments: [], maxPage: 1 }
            }
            return {
                comments: parent.ToPostShowDataItems.map((item) => this._toComment(item, page)),
                maxPage: 1,
            }
        }

        let comments = data.map((item) => this._toComment(item, page))
        // 一页取回的条数不足页大小时说明已经到底
        return {
            comments: comments,
            maxPage: comments.length >= pageSize ? page + 1 : page,
        }
    }

    // 评论请求参数中的页码为 0 基(夹具请求 pageindex=0 对应第 1 页)
    _commentRequestPage(page, replyTo) {
        let p = Math.max(1, parseInt(page, 10) || 1)
        if (replyTo) {
            let parts = String(replyTo).split("//")
            let rp = parseInt(parts[1], 10)
            if (!isNaN(rp) && rp > 0) p = rp
        }
        return p
    }

    // ============================== 首页聚合 ==============================

    explore = [
        {
            title: "漫画人",
            type: "multiPartPage",
            load: async (page) => {
                let parts = []
                let errors = []

                // 1) 首页: 移动版首页的 .manga-list 版块(桌面版首页是 APP 下载页，没有漫画版块)
                try {
                    let html = await this._fetch(this.baseUrl + "/", this.baseUrl + "/")
                    let doc = new HtmlDocument(html)
                    try {
                        for (let sec of this._parseMangaSections(doc)) {
                            let part = { title: sec.title, comics: sec.comics }
                            let target = this._viewMoreTarget(sec.title, sec.moreHref)
                            if (target) part.viewMore = target
                            parts.push(part)
                        }
                    } finally {
                        doc.dispose()
                    }
                } catch (e) {
                    errors.push(`首页: ${e && e.message ? e.message : String(e)}`)
                }

                // 2) 排行榜: /manhua-rank/ 的 4 个子榜
                try {
                    let html = await this._fetch(this.baseUrl + "/manhua-rank/", this.baseUrl + "/manhua-rank/")
                    let doc = new HtmlDocument(html)
                    try {
                        let sections = this._parseRankSections(doc)
                        for (let i = 0; i < sections.length; i++) {
                            parts.push({
                                title: sections[i].title,
                                comics: sections[i].comics,
                                viewMore: {
                                    page: "category",
                                    attributes: { category: sections[i].title, param: `rank${i + 1}` },
                                },
                            })
                        }
                    } finally {
                        doc.dispose()
                    }
                } catch (e) {
                    errors.push(`排行榜: ${e && e.message ? e.message : String(e)}`)
                }

                // 3) 分类列表首页(最热门)
                try {
                    let html = await this._fetch(this.baseUrl + "/manhua-list/", this.baseUrl + "/manhua-list/")
                    let doc = new HtmlDocument(html)
                    try {
                        let comics = this._parseMangaCards(doc)
                        if (comics.length > 0) {
                            parts.push({
                                title: "最热门",
                                comics: comics,
                                viewMore: {
                                    page: "category",
                                    attributes: { category: "最热门", param: "/manhua-list/" },
                                },
                            })
                        }
                    } finally {
                        doc.dispose()
                    }
                } catch (e) {
                    errors.push(`分类列表: ${e && e.message ? e.message : String(e)}`)
                }

                if (parts.length === 0) {
                    throw new Error(`漫画人首页聚合失败: ${errors.join(" | ")}`)
                }
                return parts
            },
            loadNext(next) { },
        },
    ]

    // 首页版块"更多"链接 -> 分类跳转目标(PAGE 跳转必须用 PageJumpTarget 对象)
    _viewMoreTarget(title, href) {
        let path = String(href || "").trim()
        if (/^\/manhua-list(-s\d+|-st\d+)?\/$/.test(path)) {
            return { page: "category", attributes: { category: title, param: path } }
        }
        if (/^\/manhua-rank\/?$/.test(path)) {
            return { page: "category", attributes: { category: "人气榜", param: "rank1" } }
        }
        return null
    }

    // ============================== 分类 ==============================

    category = {
        title: "漫画人",
        parts: [
            {
                name: "分类",
                type: "fixed",
                itemType: "category",
                categories: ["最热门", "最近更新", "最新上架", "已完结", "连载中"],
                // 参数取自夹具 manhua_list.html 顶部 manga-list-bar 的站点自有链接
                categoryParams: [
                    "/manhua-list/",
                    "/manhua-list-s2/",
                    "/manhua-list-s18/",
                    "/manhua-list-st2/",
                    "/manhua-list-st1/",
                ],
            },
            {
                name: "排行榜",
                type: "fixed",
                itemType: "category",
                categories: ["人气榜", "新番榜", "收藏榜", "吐槽榜"],
                // rank1..4 对应 /manhua-rank/ 页内 rankList_1..4
                categoryParams: ["rank1", "rank2", "rank3", "rank4"],
            },
        ],
        enableRankingPage: false,
    }

    categoryComics = {
        load: async (category, param, options, page) => {
            let pageNum = Math.max(1, parseInt(page, 10) || 1)
            let key = String(param === undefined || param === null ? "" : param).trim()
            if (!key) key = "/manhua-list/"

            // 排行榜子榜: 解析 /manhua-rank/ 页面 HTML
            let rankMatch = key.match(/^rank([1-9]\d*)$/)
            if (rankMatch) {
                let index = parseInt(rankMatch[1], 10) - 1
                let url = this.baseUrl + "/manhua-rank/"
                let html = await this._fetch(url, url)
                let doc = new HtmlDocument(html)
                try {
                    let sections = this._parseRankSections(doc)
                    let section = sections[index]
                    if (!section) {
                        throw new Error(`排行榜 ${key} 解析失败(页面内没有对应的 ul.rank-list): ${url}`)
                    }
                    return { comics: section.comics, maxPage: 1 }
                } finally {
                    doc.dispose()
                }
            }

            // 分类列表页: 路径必须来自站点自有链接
            if (!/^\/manhua-list(-s\d+|-st\d+)?\/$/.test(key)) {
                throw new Error(`未知的分类参数: ${key}`)
            }

            // 站点列表页没有 HTML 分页，下一页依赖 dm5.ashx 匿名 POST(返回 0 字节)，故只提供第一页
            if (pageNum > 1) {
                return { comics: [], maxPage: pageNum }
            }

            let url = this.baseUrl + key
            let html = await this._fetch(url, url)
            let doc = new HtmlDocument(html)
            try {
                let comics = this._parseMangaCards(doc)
                if (comics.length === 0) {
                    throw new Error(`分类页没有解析到漫画条目: ${url}`)
                }
                return { comics: comics, maxPage: 1 }
            } finally {
                doc.dispose()
            }
        },
    }

    // ============================== 搜索 ==============================

    search = {
        load: async (keyword, options, page) => {
            let kw = this._clean(keyword)
            let pageNum = Math.max(1, parseInt(page, 10) || 1)
            if (!kw) return { comics: [], maxPage: 1 }

            let url = `${this.baseUrl}/search?title=${encodeURIComponent(kw)}&language=1&page=${pageNum}`
            let html = await this._fetch(url, this.baseUrl + "/")
            let doc = new HtmlDocument(html)
            let comics = []
            try {
                comics = this._parseSearchResults(doc)
            } finally {
                doc.dispose()
            }

            // 搜索结果页没有总数，按"本页有条目则还有下一页"推进
            return { comics: comics, maxPage: comics.length > 0 ? pageNum + 1 : pageNum }
        },

        optionList: [],

        enableTagsSuggestions: false,
    }

    // ============================== 单个漫画 ==============================

    comic = {
        /**
         * 加载漫画详情
         * @param id {string} 绝对 URL 或 /manhua-{slug}/
         * @returns {Promise<ComicDetails>}
         */
        loadInfo: async (id) => {
            let url = this._comicUrl(id)
            let html = await this._fetch(url, this.baseUrl + "/")
            let doc = new HtmlDocument(html)

            let title = ""
            let cover = ""
            let author = ""
            let status = ""
            let updateTime = ""
            let description = ""
            let tags = []
            let stars = null
            let chapters = new Map()
            let recommend = []

            try {
                title = this._text(doc.querySelector(".detail-main-info-title")) ||
                    this._text(doc.querySelector(".normal-top-title"))
                if (!title) {
                    let titleTag = doc.querySelector("title")
                    title = this._text(titleTag).split("_")[0].replace(/漫画$/, "").trim()
                }

                let coverImg = doc.querySelector(".detail-main-cover img") || doc.querySelector(".detail-main-bg")
                cover = this._normImage(this._attr(coverImg, "data-src") || this._attr(coverImg, "src"))

                let authorBox = doc.querySelector(".detail-main-info-author")
                if (authorBox) {
                    let names = []
                    for (let a of authorBox.querySelectorAll("a")) {
                        let n = this._text(a)
                        if (n) names.push(n)
                    }
                    author = names.length > 0
                        ? names.join("，")
                        : this._text(authorBox).replace(/^作者[:：]?/, "").trim()
                }

                for (let a of doc.querySelectorAll(".detail-main-info-class a")) {
                    let t = this._text(a)
                    if (t) tags.push(t)
                }

                let starEl = doc.querySelector(".detail-main-info-star")
                let starMatch = this._attr(starEl, "class").match(/star-(\d+(?:\.\d+)?)/i)
                if (starMatch) {
                    let v = parseFloat(starMatch[1])
                    if (!isNaN(v)) stars = v
                }

                description = this._text(doc.querySelector(".detail-desc"))

                // 连载状态: 移动版详情页写在章节容器标题里，夹具页面已下架章节列表，故用 <title> 兜底
                status = this._text(doc.querySelector(".detail-list-title-1"))
                if (!status) {
                    let titleTag = doc.querySelector("title")
                    let raw = this._text(titleTag)
                    if (raw.indexOf("连载中") >= 0) status = "连载中"
                    else if (raw.indexOf("已完结") >= 0 || raw.indexOf("完结") >= 0) status = "已完结"
                }
                updateTime = this._text(doc.querySelector(".detail-list-title-3"))

                chapters = this._parseChapters(doc)

                let seen = {}
                for (let box of doc.querySelectorAll(".manga-list")) {
                    for (let c of this._parseMangaCards(box)) {
                        if (seen[c.id] || c.id === url) continue
                        seen[c.id] = true
                        recommend.push(c)
                    }
                }
            } finally {
                doc.dispose()
            }

            // 评论接口需要详情页内联变量里的 mid
            let midMatch = html.match(/var\s+DM5_MID\s*=\s*(\d+)/i) || html.match(/var\s+COMIC_MID\s*=\s*(\d+)/i)
            let mid = midMatch ? midMatch[1] : null

            let tagMap = new Map()
            if (author) tagMap.set("作者", [author])
            if (status) tagMap.set("状态", [status])
            if (tags.length > 0) tagMap.set("标签", tags)

            return new ComicDetails({
                title: title,
                cover: cover,
                description: description,
                tags: tagMap,
                chapters: chapters,
                recommend: recommend,
                updateTime: updateTime,
                stars: stars,
                subId: mid,
                url: url,
            })
        },

        /**
         * 加载章节图片
         * @param comicId {string}
         * @param epId {string} /m{cid}/ 或绝对 URL
         * @returns {Promise<{images: string[]}>}
         */
        loadEp: async (comicId, epId) => {
            let target = epId
            // 兜底: 空/历史丢失的章节 id 时, 从详情页取页面顺序第一话
            if (!this._chapterCid(target)) {
                let detailUrl = this._comicUrl(comicId)
                let detailHtml = await this._fetch(detailUrl, this.baseUrl + "/")
                let doc = new HtmlDocument(detailHtml)
                let chapters
                try {
                    chapters = this._parseChapters(doc)
                } finally {
                    doc.dispose()
                }
                if (chapters.size === 0) {
                    throw new Error(`章节 id 无效且详情页未解析到章节: comicId=${comicId} epId=${epId}`)
                }
                target = chapters.keys().next().value
            }
            let url = this._chapterUrl(target)
            if (!url || url === this.baseUrl) {
                throw new Error(`章节 id 无效: ${epId}`)
            }
            let referer = comicId ? this._comicUrl(comicId) : this.baseUrl + "/"
            let html = await this._fetch(url, referer)

            let images = this._parseChapterImages(html)
            if (images.length === 0) {
                throw new Error(`章节图片解析失败(页面无 packer 脚本或为付费/下架章节): ${url}`)
            }
            return { images: images }
        },

        /**
         * 图片请求头: 图床需要 Referer(章节页) 与 UA
         * @param url {string}
         * @param comicId {string}
         * @param epId {string}
         * @returns {ImageLoadingConfig}
         */
        onImageLoad: (url, comicId, epId) => {
            let referer = epId ? this._chapterUrl(epId) : this.baseUrl + "/"
            return { headers: this._imageHeaders(referer) }
        },

        /**
         * 封面缩略图请求头(图床同样校验 Referer)
         * @param url {string}
         * @returns {ImageLoadingConfig}
         */
        onThumbnailLoad: (url) => {
            return { headers: this._imageHeaders(this.baseUrl + "/") }
        },

        /**
         * 加载详情页评论
         * @param comicId {string}
         * @param subId {string?} ComicDetails.subId(详情页 mid)
         * @param page {number}
         * @param replyTo {string?} 形如 "评论id//页码"
         */
        loadComments: async (comicId, subId, page, replyTo) => {
            let mid = String(subId === undefined || subId === null ? "" : subId).trim()
            if (!/^\d+$/.test(mid)) {
                let m = String(comicId || "").match(/manhua-(\d+)\/?$/i) || String(comicId || "").match(/^(\d+)$/)
                mid = m ? m[1] : ""
            }
            if (!mid) {
                throw new Error(`缺少漫画 mid, 无法加载详情评论: comicId=${comicId}`)
            }

            let requestPage = this._commentRequestPage(page, replyTo)
            let pageSize = ManHuaRen.DETAIL_COMMENT_PAGE_SIZE
            let url = `${this.baseUrl}/manhua-${mid}/pagerdata.ashx?d=${Date.now()}` +
                `&pageindex=${requestPage - 1}&pagesize=${pageSize}&mid=${mid}&t=4`

            let body = await this._fetch(url, `${this.baseUrl}/manhua-${mid}/`)
            return this._parseComments(body, requestPage, pageSize, replyTo)
        },

        /**
         * 加载章节评论
         * @param comicId {string}
         * @param epId {string} 形如 /m{cid}/
         * @param page {number}
         * @param replyTo {string?} 形如 "评论id//页码"
         */
        loadChapterComments: async (comicId, epId, page, replyTo) => {
            let cid = this._chapterDigits(epId) || this._chapterDigits(comicId)
            if (!cid) {
                throw new Error(`无法从章节 id 解析 cid, 无法加载章节评论: epId=${epId}`)
            }

            let requestPage = this._commentRequestPage(page, replyTo)
            let pageSize = ManHuaRen.CHAPTER_COMMENT_PAGE_SIZE
            let url = `${this.baseUrl}/showcomment/pagerdata.ashx?d=${Date.now()}` +
                `&pageindex=${requestPage - 1}&pagesize=${pageSize}&cid=${cid}&t=9`

            let body = await this._fetch(url, `${this.baseUrl}/showcomment/?cid=${cid}`)
            return this._parseComments(body, requestPage, pageSize, replyTo)
        },

        // 站内漫画链接识别: /manhua-{slug}/ 或 https://www.manhuaren.com/manhua-{slug}/
        idMatch: "^(?:https?://(?:www\\.)?manhuaren\\.com)?/?(manhua-[A-Za-z0-9\\-_]+)/?$",

        link: {
            domains: [
                "manhuaren.com",
                "www.manhuaren.com",
            ],
            linkToId: (url) => {
                let m = String(url || "").match(/manhua-[A-Za-z0-9\-_]+/i)
                return m ? this.baseUrl + "/" + m[0] + "/" : null
            },
        },
    }
}
