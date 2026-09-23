/**
 * 紳士漫畫 (wnacg) —— Venera 漫畫源（完全重寫版 v2）
 *
 * ============================ 原站分析 ============================
 * 站點程序: MeiuPic 2.2.0, 主題 weitu
 * 主域名:   www.wnacg.com / www.wnacg.ru / www.wn10.cfd / www.wn10.shop
 * 地址發布頁: https://wnacg01.link/ (wn01.link 301 到這裡)
 *
 * 1) 首頁 /            6 個板塊（最新更新/同人誌CG畫集/單行漫畫/雜誌短篇/韓國漫畫/Cosplay寫真）
 *                      板塊頭: div.title_sort > div.title_h2 + div.r>a（原站有重複 class 屬性的
 *                      HTML bug: <div class="title_sort" class="cc">，故不依賴單一選擇器配對）
 *                      列表:   div.gallary_wrap > ul.cc > li.li.gallary_item
 * 2) 列表項            div.pic_box > a[href=/photos-index-aid-N.html] > img
 *                      div.info > div.title > a（標題）、div.info_col（日期, N張圖片）
 * 3) 分頁              div.f_left.paginator（span.thispage / a / span.next）
 *                      更新 /albums-index-page-N.html
 *                      分類 /albums-index-page-N-cate-C.html
 *                      標籤 /albums-index-page-N-tag-<urlencoded>.html
 *                      排行 /albums-favorite_ranking-page-N-type-T[-cate-C].html
 *                      搜索 /search/?q=&f=&s=&syn=yes&p=N（24 條/頁，頁面含精確總數）
 * 4) 排行              /albums-favorite_ranking-type-{day|week|month|year}[-cate-C].html
 * 5) 詳情              /photos-index-aid-N.html
 *                      div.userwrap > h2 標題；div.asTBcell.uwthumb img 封面
 *                      div.asTBcell.uwconn label: 分類/頁數/編號；a.tagshow 標籤
 *                      div.asTBcell.uwuinfo > a > p 上傳者
 *                      縮略圖 div.pic_box.tb，120 條內分頁 /photos-index-page-N-aid-N.html
 * 6) 閱讀              /photos-item-aid-N.html 內 mReader.initData({...}) 的 page_url 數組
 *                      降級 /photos-gallery-aid-N.html 的 imglist
 * 7) 評論              AJAX 片段 /?ctl=comment&act=frag&aid=N&sort=hot|new&page=P
 *                      （靜態評論頁只是殼，內容由 JS 拉取，10 條/頁）
 *                      結構: div.plItem[data-id] > img.plAv + .plBody
 *                            > .plHead > span.plName + span.plTime
 *                            > div.plText；.plMeta > a.plUp/a.plDown > i（票數）
 *                      發送 /?ctl=comment&act=post (aid,pid,content)
 *                      點踩 /?ctl=comment&act=vote (plid,v=1/-1)
 * 8) 登錄              POST /users-check_login.html
 *                      (normal=1, login_name, login_pass, remember_pass=1)
 *                      返回 JSON {ret:true/false, html}
 * 9) 收藏              /users-addfav-id-N.html 彈窗取文件夾；POST /users-save_fav-id-N.html(favc_id)
 *                      刪除 /users-fav_del-id-FID.html?ajax=true；列表 /users-users_fav-page-P-c-FID.html
 *                      文件夾 /users-favc_save-id.html(favc_name) 與 /users-favclass_del-id-FID.html
 * 10) 圖片             //t4.qy0.ru（縮略圖）、img5.qy0.ru 等（正文），http/協議相對均升級為 https
 *
 * 本版要點:
 * - 真實的評論接口（舊版抓靜態頁面，永遠解析不到評論）
 * - 全域域名故障轉移（當前域名 4xx/5xx/超時自動切換鏡像並記憶）
 * - 發布頁刷新 + 可用性驗證後才落盤，避免把發布頁本身當鏡像
 * - 首頁板塊彈性配對，兼容原站重複 class 屬性的畸形 HTML
 * - 搜索排序/範圍選項、排行週期+分類、標籤跳轉、封面/正文/https 歸一化
 * ==================================================================
 */

class Wnacg extends ComicSource {
    name = "紳士漫畫"
    key = "wnacg"
    version = "2.0.0"
    minAppVersion = "1.6.0"
    url = "https://cdn.jsdelivr.net/gh/senran-N/venera-configs@main/wnacg.js"

    static UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

    // 內置鏡像（發布頁失效時的最後防線）
    static DEFAULT_DOMAINS = [
        "www.wnacg.com",
        "www.wnacg.ru",
        "www.wn10.cfd",
        "www.wn10.shop",
    ]

    // 官方地址發布頁（按順序嘗試）
    static ANNOUNCE_URLS = [
        "https://wnacg01.link/",
        "https://wnacg02.link/",
        "https://wn01.link/",
    ]

    static _domainCache = null
    static _runtime = null

    // 首頁板塊 -> 分類 path 的兜底映射（標題按去空白處理）
    static SECTION_PARAMS = {
        "最新更新": "/albums.html",
        "同人誌CG畫集": "/albums-index-cate-5.html",
        "單行漫畫": "/albums-index-cate-6.html",
        "雜誌短篇": "/albums-index-cate-7.html",
        "韓國漫畫": "/albums-index-cate-19.html",
        "Cosplay寫真": "/albums-index-cate-3.html",
    }

    // 詳情頁「分類」主分類 -> cate id
    static CATE_IDS = {
        "同人誌": 5,
        "單行本": 6,
        "雜誌&短篇": 7,
        "韓漫": 19,
        "寫真&Cosplay": 3,
        "3D&漫畫": 22,
        "3D漫畫": 22,
        "AI圖集": 37,
        "CG畫集": 2,
        "Cosplay": 3,
    }

    // ============================== 域名管理 ==============================

    domainList() {
        if (Wnacg._domainCache) return Wnacg._domainCache
        let saved = null
        try { saved = this.loadData("domains") } catch (e) { /* ignore */ }
        let list = (Array.isArray(saved) && saved.length > 0)
            ? saved.filter((d) => typeof d === "string" && d.length > 0)
            : Wnacg.DEFAULT_DOMAINS.slice()
        if (list.length === 0) list = Wnacg.DEFAULT_DOMAINS.slice()
        Wnacg._domainCache = list
        return list
    }

    _saveDomainList(list) {
        Wnacg._domainCache = list
        try { this.saveData("domains", list) } catch (e) { /* ignore */ }
    }

    // 當前生效域名（帶運行時故障轉移記憶）
    get baseUrl() {
        let list = this.domainList()
        let selection = parseInt(this.loadSetting("domainSelection"))
        if (isNaN(selection)) selection = 1

        if (selection === 0) {
            let custom = String(this.loadSetting("domain0") || "").trim()
            custom = custom.replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
            if (!custom) custom = list[0] || Wnacg.DEFAULT_DOMAINS[0]
            return "https://" + custom
        }

        let preferred = list[selection - 1] || list[0] || Wnacg.DEFAULT_DOMAINS[0]
        let rt = Wnacg._runtime
        if (rt && rt.selection === selection && list.indexOf(rt.domain) >= 0) {
            preferred = rt.domain
        }
        return "https://" + preferred
    }

    _rememberWorkingDomain(domain) {
        let selection = parseInt(this.loadSetting("domainSelection"))
        if (isNaN(selection) || selection === 0) return
        if (Wnacg._runtime && Wnacg._runtime.selection === selection && Wnacg._runtime.domain === domain) {
            return
        }
        Wnacg._runtime = { selection: selection, domain: domain }
        try { this.saveData("runtimeDomain", Wnacg._runtime) } catch (e) { /* ignore */ }
    }

    _baseHeaders(referer) {
        let headers = {
            "User-Agent": Wnacg.UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7",
        }
        if (referer) headers["Referer"] = referer
        return headers
    }

    _isBadResponse(res) {
        if (!res) return true
        if (res.status === 0) return true
        if (res.status === 403 || res.status === 429) return true
        if (res.status >= 500) return true
        return false
    }

    /**
     * 統一請求入口。
     * - path 以 "/" 開頭時：在當前域名失敗（網絡異常/403/429/5xx）後自動嘗試其他鏡像
     * - absolute: true 時 path 為完整 URL（發布頁、域名驗證）
     * - noFailover: 寫操作默認不跨域重試，避免重複副作用
     * @returns {Promise<{status:number, headers:any, body:string}>}
     */
    async _request(method, path, options) {
        options = options || {}
        let headers = Object.assign(
            this._baseHeaders(options.referer || ""),
            options.headers || {}
        )
        let data = options.data

        if (options.absolute || /^https?:\/\//i.test(path)) {
            return await Network[method](path, headers, data)
        }

        let list = this.domainList()
        let current = this.baseUrl.replace(/^https?:\/\//i, "")
        let candidates = [current]
        if (!options.noFailover) {
            for (let d of list) {
                if (candidates.indexOf(d) < 0) candidates.push(d)
            }
        }

        let lastError = null
        for (let d of candidates) {
            let url = "https://" + d + path
            headers["Referer"] = options.referer || ("https://" + d + "/")
            try {
                let res = await Network[method](url, headers, data)
                if (this._isBadResponse(res)) {
                    lastError = `HTTP ${res.status} @ ${d}`
                    continue
                }
                this._rememberWorkingDomain(d)
                return res
            } catch (e) {
                lastError = e
            }
        }
        throw lastError || "Request failed"
    }

    async _fetchHtml(path, options) {
        let res = await this._request("get", path, options)
        if (res.status !== 200) throw `Invalid status code: ${res.status}`
        return res.body
    }

    async _fetchDoc(path, options) {
        return new HtmlDocument(await this._fetchHtml(path, options))
    }

    // ============================== 通用解析 ==============================

    // 從任意串中還原漫畫 aid
    _aid(input) {
        if (!input) return null
        let s = String(input)
        let m = /-aid-(\d+)/.exec(s)
        if (m) return m[1]
        m = /^\s*(?:wnacg-?)?(?:aid-?)?(\d{1,8})\s*$/i.exec(s)
        if (m) return m[1]
        return null
    }

    // 圖片 URL 歸一化：協議相對 //、原站 ////、http、相對路徑 -> https 絕對路徑
    _normImg(src) {
        if (!src) return ""
        let s = String(src).trim()
        if (!s) return ""
        if (/^https?:\/\//i.test(s)) return s.replace(/^http:\/\//i, "https://")
        if (/^\/{2,}/.test(s)) return "https://" + s.replace(/^\/+/, "")
        return this.baseUrl + (s.startsWith("/") ? s : "/" + s)
    }

    _stripTags(s) {
        if (!s) return ""
        return String(s).replace(/<[^>]*>/g, "").trim()
    }

    _clean(s) {
        if (s === null || s === undefined) return ""
        return String(s).replace(/\s+/g, " ").trim()
    }

    _tryJson(s) {
        if (!s) return null
        try { return JSON.parse(s) } catch (e) { return null }
    }

    _throwIfLoginPage(body) {
        if (!body) return
        if (body.indexOf("用戶登錄") >= 0 || body.indexOf("用户登录") >= 0 ||
            body.indexOf("login_form") >= 0) {
            throw "Login expired"
        }
    }

    // 列表項解析：兼容 li.gallary_item 與裸 div.pic_box
    _parseComic(el) {
        let box = null
        if (el.localName === "div" && (el.classNames || []).indexOf("pic_box") >= 0) {
            box = el
        } else {
            box = el.querySelector("div.pic_box") || el
        }

        let link = (box.localName === "a") ? box : box.querySelector("a")
        if (!link && el !== box) link = el.querySelector("a")
        let href = link ? link.attributes["href"] : null
        let id = this._aid(href)
        if (!id) throw "Invalid comic id"

        let img = box.querySelector("img") || (link ? link.querySelector("img") : null)
        let cover = ""
        if (img) {
            cover = img.attributes["src"] || img.attributes["data-src"] ||
                img.attributes["data-original"] || ""
        }

        let titleEl = el.querySelector("div.info div.title a") || el.querySelector("div.title a")
        let title = titleEl ? titleEl.text : ""
        if (!title && link) title = link.attributes["title"] || ""
        if (!title && img) title = img.attributes["alt"] || ""
        title = this._stripTags(title)

        let infoEl = el.querySelector("div.info div.info_col") || el.querySelector("div.info_col")
        let info = infoEl ? this._clean(infoEl.text) : ""

        return new Comic({
            id: id,
            title: title,
            subtitle: info,
            cover: this._normImg(cover),
            description: "",
        })
    }

    // 通用列表頁解析
    _parseList(doc) {
        let items = doc.querySelectorAll("div.gallary_wrap ul.cc > li.gallary_item")
        if (items.length === 0) items = doc.querySelectorAll("li.gallary_item")

        let comics = []
        for (let item of items) {
            try {
                let c = this._parseComic(item)
                if (c) comics.push(c)
            } catch (e) { /* 跳過損壞條目 */ }
        }

        // 兜底：解析器丟棄列表容器時，直接抓取葉子 pic_box（排除詳情頁縮略圖 tb）
        if (comics.length === 0) {
            for (let box of doc.querySelectorAll("div.pic_box")) {
                if ((box.classNames || []).indexOf("tb") >= 0) continue
                try {
                    let c = this._parseComic(box)
                    if (c) comics.push(c)
                } catch (e) { /* skip */ }
            }
        }

        return { comics: comics, maxPage: this._parseMaxPage(doc) }
    }

    // 分頁器解析：文本數字 + href 的 -page-N / p=N
    _parseMaxPage(doc) {
        let max = 1
        let paginators = doc.querySelectorAll("div.f_left.paginator")
        if (paginators.length === 0) paginators = doc.querySelectorAll("div.paginator")

        for (let p of paginators) {
            let nums = []
            for (let a of p.querySelectorAll("a")) {
                let text = (a.text || "").trim()
                if (/^\d+$/.test(text)) nums.push(parseInt(text))
                let href = a.attributes["href"] || ""
                let m = /[?&]p=(\d+)/.exec(href) || /-page-(\d+)(?:-|\.)/.exec(href)
                if (m) nums.push(parseInt(m[1]))
            }
            let cur = p.querySelector("span.thispage")
            if (cur) {
                let t = parseInt((cur.text || "").trim())
                if (!isNaN(t)) nums.push(t)
            }
            for (let n of nums) {
                if (!isNaN(n) && n > max) max = n
            }
        }
        return max
    }

    // 分類/標籤/更新列表 path -> 指定頁 URL
    _listUrl(param, page) {
        param = (param || "/albums.html").trim()
        if (!param.startsWith("/")) param = "/" + param
        if (!page || page <= 1) return this.baseUrl + param

        let mCate = /^\/albums-index-cate-(\d+)\.html$/.exec(param)
        if (mCate) return `${this.baseUrl}/albums-index-page-${page}-cate-${mCate[1]}.html`

        let mTag = /^\/albums-index-tag-(.+)\.html$/.exec(param)
        if (mTag) {
            let tag = mTag[1]
            try { tag = decodeURIComponent(tag) } catch (e) { /* 已是原文 */ }
            return `${this.baseUrl}/albums-index-page-${page}-tag-${encodeURIComponent(tag)}.html`
        }

        if (param === "/albums.html" || param === "/albums-index.html") {
            return `${this.baseUrl}/albums-index-page-${page}.html`
        }

        if (/-page-\d+/.test(param)) {
            return this.baseUrl + param.replace(/-page-\d+/, `-page-${page}`)
        }

        let mGeneric = /^\/albums-index-(.+)\.html$/.exec(param)
        if (mGeneric && !mGeneric[1].startsWith("page-")) {
            return `${this.baseUrl}/albums-index-page-${page}-${mGeneric[1]}.html`
        }
        return this.baseUrl + param
    }

    // 排行 URL：option = "week" 或 "week:5"（週期:分類 id）
    _rankingUrl(option, page) {
        let parts = String(option || "week").split(":")
        let type = (parts[0] || "week").trim()
        if (["day", "week", "month", "year"].indexOf(type) < 0) type = "week"
        let cate = parts[1] ? parseInt(parts[1]) : 0
        let suffix = (cate && !isNaN(cate)) ? `-cate-${cate}` : ""
        if (!page || page <= 1) {
            return `${this.baseUrl}/albums-favorite_ranking-type-${type}${suffix}.html`
        }
        return `${this.baseUrl}/albums-favorite_ranking-page-${page}-type-${type}${suffix}.html`
    }

    // ============================== 初始化 / 域名刷新 ==============================

    async init() {
        // 還原運行時域名的選擇（僅當選擇項未變化時生效）
        try {
            let rt = this.loadData("runtimeDomain")
            if (rt && typeof rt === "object" && rt.domain) Wnacg._runtime = rt
        } catch (e) { /* ignore */ }

        if (this.loadSetting("refreshDomainsOnStart")) {
            try { await this.refreshDomains(false) } catch (e) { /* 啟動刷新失敗不阻塞 */ }
        }
    }

    /**
     * 從發布頁抓取鏡像並逐一驗證，只保留真正能打開站點首頁的域名。
     * @param showDialog {boolean}
     */
    async refreshDomains(showDialog) {
        let discovered = []
        for (let url of Wnacg.ANNOUNCE_URLS) {
            try {
                let res = await this._request("get", url, { absolute: true, referer: "" })
                if (res.status !== 200) continue
                let doc = new HtmlDocument(res.body)
                for (let a of doc.querySelectorAll("a[href]")) {
                    let href = a.attributes["href"] || ""
                    let m = /^https?:\/\/([^\/]+)/i.exec(href)
                    if (!m) continue
                    let host = m[1].toLowerCase()
                    if (/google|cdn-cgi|email-protection|w3\.org|juicyads|yandex/.test(host)) continue
                    if (discovered.indexOf(host) < 0) discovered.push(host)
                }
                doc.dispose()
                if (discovered.length > 0) break
            } catch (e) { /* 換下一個發布頁 */ }
        }

        // 候選 = 內置 + 發布頁發現；驗證首頁特徵後才保留
        let candidates = Wnacg.DEFAULT_DOMAINS.slice()
        for (let d of discovered) {
            if (candidates.indexOf(d) < 0) candidates.push(d)
        }

        let verified = []
        for (let d of candidates) {
            try {
                let res = await this._request("get", "https://" + d + "/", {
                    absolute: true,
                    referer: "https://" + d + "/",
                })
                if (res.status === 200 &&
                    (res.body.indexOf("gallary_item") >= 0 || res.body.indexOf("photos-index-aid-") >= 0)) {
                    verified.push(d)
                }
            } catch (e) { /* 不可用鏡像 */ }
        }

        let ok = verified.length > 0
        let list = ok ? verified : this.domainList()
        let title = ok ? this.translate("Update Success") : this.translate("Update Failed")
        let message = (ok ? this.translate("Available mirrors") : this.translate("Keep current mirrors")) + ":\n\n"
        for (let i = 0; i < list.length; i++) message += `  ${i + 1}. ${list[i]}\n`
        message += "\n" + this.translate("Re-enter page to refresh")

        if (showDialog) {
            UI.showDialog(title, message, [
                { text: this.translate("Cancel"), callback: () => { } },
                { text: this.translate("Apply"), callback: () => { if (ok) this._saveDomainList(verified) } },
            ])
        } else if (ok) {
            this._saveDomainList(verified)
        }
    }

    // ============================== 賬號 ==============================

    account = {
        login: async (account, pwd) => {
            let res = await this._request("post", "/users-check_login.html", {
                headers: { "content-type": "application/x-www-form-urlencoded" },
                data: `normal=1&login_name=${encodeURIComponent(account)}&login_pass=${encodeURIComponent(pwd)}&remember_pass=1`,
            })
            if (res.status !== 200) throw `Login failed (HTTP ${res.status})`
            let json = this._tryJson(res.body)
            if (json) {
                if (json.ret === true) return "ok"
                let msg = this._stripTags(String(json.html || json.msg || ""))
                throw msg || "Login failed"
            }
            if (res.body.indexOf("登錄成功") >= 0 || res.body.indexOf("登录成功") >= 0) return "ok"
            throw "Login failed"
        },

        logout: () => {
            try { Network.deleteCookies(this.baseUrl) } catch (e) { /* ignore */ }
        },

        registerWebsite: "https://www.wnacg.com/users-reg.html",
    }

    // ============================== 探索頁 ==============================

    explore = [
        {
            title: "紳士漫畫",
            type: "multiPartPage",
            load: async () => {
                let doc = await this._fetchDoc("/")
                try {
                    let titles = doc.querySelectorAll("div.title_h2")
                    let wraps = doc.querySelectorAll("div.gallary_wrap")
                    let result = []

                    if (titles.length > 0 && wraps.length === titles.length) {
                        for (let i = 0; i < titles.length; i++) {
                            // 原站標題內嵌 <em>，文本會帶換行/縮進（如「最新\n更新」），需去掉全部空白
                            let title = (titles[i].text || "").replace(/\s+/g, "").trim()
                            if (!title) continue

                            let comics = []
                            for (let item of wraps[i].querySelectorAll("li.gallary_item")) {
                                try {
                                    let c = this._parseComic(item)
                                    if (c) comics.push(c)
                                } catch (e) { /* skip */ }
                            }
                            if (comics.length === 0) continue

                            // 優先讀板塊自帶的「更多>>」連結，其次用標題映射兜底
                            let param = null
                            try {
                                let parent = titles[i].parent
                                if (parent) {
                                    let moreA = parent.querySelector("div.r a")
                                    if (moreA) param = moreA.attributes["href"] || null
                                }
                            } catch (e) { /* ignore */ }
                            if (!param) param = Wnacg.SECTION_PARAMS[title] || null

                            let part = { title: title, comics: comics }
                            if (param) {
                                part.viewMore = {
                                    page: "category",
                                    attributes: { category: title, param: param },
                                }
                            }
                            result.push(part)
                        }
                    }

                    // 兜底：板塊容器被解析器丟棄時，把所有條目歸入「最新更新」
                    if (result.length === 0) {
                        let comics = []
                        for (let item of doc.querySelectorAll("li.gallary_item")) {
                            try {
                                let c = this._parseComic(item)
                                if (c) comics.push(c)
                            } catch (e) { /* skip */ }
                        }
                        if (comics.length > 0) {
                            result.push({
                                title: "最新更新",
                                comics: comics,
                                viewMore: {
                                    page: "category",
                                    attributes: { category: "最新更新", param: "/albums.html" },
                                },
                            })
                        }
                    }
                    return result
                } finally {
                    doc.dispose()
                }
            },
            loadNext(next) { },
        },
    ]

    // ============================== 分類 ==============================

    category = {
        title: "紳士漫畫",
        parts: [
            {
                name: "更新",
                type: "fixed",
                categories: ["最新更新"],
                itemType: "category",
                categoryParams: ["/albums.html"],
            },
            {
                name: "同人誌",
                type: "fixed",
                categories: ["同人誌", "同人誌CG畫集", "CG畫集", "AI圖集", "3D&漫畫", "3D漫畫", "Cosplay", "漢化", "日語", "English"],
                itemType: "category",
                categoryParams: [
                    "/albums-index-cate-5.html",
                    "/albums-index-cate-5.html",
                    "/albums-index-cate-2.html",
                    "/albums-index-cate-37.html",
                    "/albums-index-cate-22.html",
                    "/albums-index-cate-22.html",
                    "/albums-index-cate-3.html",
                    "/albums-index-cate-1.html",
                    "/albums-index-cate-12.html",
                    "/albums-index-cate-16.html",
                ],
            },
            {
                name: "單行本",
                type: "fixed",
                categories: ["單行本", "單行漫畫", "漢化", "日語", "English"],
                itemType: "category",
                categoryParams: [
                    "/albums-index-cate-6.html",
                    "/albums-index-cate-6.html",
                    "/albums-index-cate-9.html",
                    "/albums-index-cate-13.html",
                    "/albums-index-cate-17.html",
                ],
            },
            {
                name: "雜誌&短篇",
                type: "fixed",
                categories: ["雜誌&短篇", "雜誌短篇", "漢化", "日語", "English"],
                itemType: "category",
                categoryParams: [
                    "/albums-index-cate-7.html",
                    "/albums-index-cate-7.html",
                    "/albums-index-cate-10.html",
                    "/albums-index-cate-14.html",
                    "/albums-index-cate-18.html",
                ],
            },
            {
                name: "韓漫",
                type: "fixed",
                categories: ["韓漫", "韓國漫畫", "漢化", "其他"],
                itemType: "category",
                categoryParams: [
                    "/albums-index-cate-19.html",
                    "/albums-index-cate-19.html",
                    "/albums-index-cate-20.html",
                    "/albums-index-cate-21.html",
                ],
            },
            {
                name: "寫真&Cosplay",
                type: "fixed",
                categories: ["寫真&Cosplay", "Cosplay寫真"],
                itemType: "category",
                categoryParams: [
                    "/albums-index-cate-3.html",
                    "/albums-index-cate-3.html",
                ],
            },
        ],
        enableRankingPage: true,
    }

    categoryComics = {
        load: async (category, param, options, page) => {
            // viewMore 帶來的 param 優先；缺失時按分類名兜底
            let path = param || Wnacg.SECTION_PARAMS[category] || null
            if (!path) {
                let cid = Wnacg.CATE_IDS[category]
                path = cid ? `/albums-index-cate-${cid}.html` : "/albums.html"
            }
            let doc = await this._fetchDoc(this._listUrl(path, page).replace(this.baseUrl, ""))
            try {
                return this._parseList(doc)
            } finally {
                doc.dispose()
            }
        },

        ranking: {
            options: [
                "day-今日",
                "week-本週",
                "month-本月",
                "year-今年",
                "week:5-本週·同人誌",
                "week:6-本週·單行本",
                "week:7-本週·雜誌&短篇",
                "week:19-本週·韓漫",
                "week:3-本週·寫真&Cosplay",
                "week:22-本週·3D&漫畫",
            ],
            load: async (option, page) => {
                let url = this._rankingUrl(option, page)
                let doc = await this._fetchDoc(url.replace(this.baseUrl, ""))
                try {
                    return this._parseList(doc)
                } finally {
                    doc.dispose()
                }
            },
        },
    }

    // ============================== 搜索 ==============================

    search = {
        load: async (keyword, options, page) => {
            options = options || []
            let sort = options[0] || "create_time_DESC"
            if (["create_time_DESC", "create_time_ASC", "comment", "favorite"].indexOf(sort) < 0) {
                sort = "create_time_DESC"
            }
            let field = options[1] || "_all"
            if (["_all", "tag"].indexOf(field) < 0) field = "_all"

            let path = `/search/?q=${encodeURIComponent(keyword)}&f=${field}&s=${sort}&syn=yes`
            if (page && page > 1) path += `&p=${page}`

            let body = await this._fetchHtml(path)
            let doc = new HtmlDocument(body)
            let parsed
            try {
                parsed = this._parseList(doc)
            } finally {
                doc.dispose()
            }

            // 搜索結果頁有精確總數，用它換算總頁數（24 條/頁）
            let m = /大約有\s*<b>\s*([\d,]+)\s*<\/b>\s*項符合/.exec(body)
            if (m) {
                let total = parseInt(m[1].replace(/,/g, ""))
                if (!isNaN(total) && total > 0) parsed.maxPage = Math.ceil(total / 24)
            }
            return parsed
        },

        optionList: [
            {
                type: "select",
                label: "排序",
                options: [
                    "create_time_DESC-最新",
                    "create_time_ASC-最早",
                    "comment-最多評論",
                    "favorite-最多收藏",
                ],
            },
            {
                type: "select",
                label: "範圍",
                options: [
                    "_all-全部",
                    "tag-標籤",
                ],
            },
        ],
    }

    // ============================== 收藏 ==============================

    favorites = {
        multiFolder: true,
        isOldToNewSort: true,

        addOrDelFavorite: async (comicId, folderId, isAdding, favoriteId) => {
            let id = this._aid(comicId) || comicId
            if (isAdding) {
                let res = await this._request("post", `/users-save_fav-id-${id}.html`, {
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                    data: `favc_id=${encodeURIComponent(folderId || 0)}`,
                    noFailover: true,
                })
                this._throwIfLoginPage(res.body)
                let json = this._tryJson(res.body)
                if (json && json.ret === false) {
                    throw this._clean(this._stripTags(json.html || json.msg || "Add failed"))
                }
                if (res.status !== 200) throw `Add failed (HTTP ${res.status})`
                return "ok"
            }

            if (!favoriteId) throw "Missing favorite id"
            let res = await this._request("get",
                `/users-fav_del-id-${favoriteId}.html?ajax=true&_t=${randomDouble(0, 1)}`,
                { noFailover: true })
            this._throwIfLoginPage(res.body)
            if (res.status !== 200) throw `Delete failed (HTTP ${res.status})`
            return "ok"
        },

        loadFolders: async (comicId) => {
            // 未登錄時該彈窗會返回登錄框，據此觸發 App 重新登錄
            let aid = this._aid(comicId) || comicId || "210814"
            let res = await this._request("get", `/users-addfav-id-${aid}.html`)
            this._throwIfLoginPage(res.body)

            let doc = new HtmlDocument(res.body)
            let folders = {}
            let favorited = []
            try {
                for (let opt of doc.querySelectorAll("option")) {
                    let value = opt.attributes["value"]
                    let name = this._clean(opt.text)
                    if (value === undefined || value === null || value === "" || !name) continue
                    folders[String(value)] = name
                    if (opt.attributes["selected"] !== undefined ||
                        (opt.classNames || []).indexOf("selected") >= 0) {
                        favorited.push(String(value))
                    }
                }
            } finally {
                doc.dispose()
            }
            return { folders: folders, favorited: favorited }
        },

        addFolder: async (name) => {
            let res = await this._request("post", "/users-favc_save-id.html", {
                headers: { "content-type": "application/x-www-form-urlencoded" },
                data: `favc_name=${encodeURIComponent(name)}`,
                noFailover: true,
            })
            this._throwIfLoginPage(res.body)
            if (res.status !== 200) throw `Add failed (HTTP ${res.status})`
            return "ok"
        },

        deleteFolder: async (folderId) => {
            let res = await this._request("get",
                `/users-favclass_del-id-${folderId}.html?ajax=true&_t=${randomDouble(0, 1)}`,
                { noFailover: true })
            this._throwIfLoginPage(res.body)
            if (res.status !== 200) throw `Delete failed (HTTP ${res.status})`
            return "ok"
        },

        loadComics: async (page, folder) => {
            page = Number(page) || 1
            let f = (folder === null || folder === undefined || folder === "") ? "0" : folder
            let res = await this._request("get", `/users-users_fav-page-${page}-c-${f}.html`)
            this._throwIfLoginPage(res.body)

            let doc = new HtmlDocument(res.body)
            let comics = []
            try {
                for (let block of doc.querySelectorAll("div.asTB")) {
                    try {
                        let linkEl = block.querySelector("div.box_cel.u_listcon p.l_title a")
                            || block.querySelector("p.l_title a")
                        if (!linkEl) continue
                        let id = this._aid(linkEl.attributes["href"])
                        if (!id) continue

                        let img = block.querySelector("div.asTBcell.thumb img") || block.querySelector("img")
                        let title = this._clean(linkEl.text) ||
                            this._stripTags(linkEl.attributes["title"] || "")

                        let timeEl = block.querySelector("div.box_cel.u_listcon p.l_catg span")
                            || block.querySelector("p.l_catg span")
                        let time = timeEl ? this._clean(timeEl.text).replace(/^創建時間：?/, "") : ""

                        let infoEl = block.querySelector("p.l_detla")
                        let info = infoEl ? this._clean(infoEl.text) : ""
                        let pages = 0
                        let pm = /頁數：\s*(\d+)/.exec(info)
                        if (pm) pages = parseInt(pm[1])

                        let favoriteId = ""
                        let delEl = block.querySelector("p.alopt a")
                        if (delEl) {
                            let dm = /del-id-(\d+)/.exec(delEl.attributes["onclick"] || "")
                            if (dm) favoriteId = dm[1]
                        }

                        comics.push(new Comic({
                            id: id,
                            title: title,
                            cover: this._normImg(img ? img.attributes["src"] : ""),
                            subtitle: time,
                            description: info,
                            maxPage: pages || undefined,
                            favoriteId: favoriteId || undefined,
                        }))
                    } catch (e) { /* skip */ }
                }
                return { comics: comics, maxPage: this._parseMaxPage(doc) }
            } finally {
                doc.dispose()
            }
        },
    }

    // ============================== 詳情 / 閱讀 ==============================

    comic = {
        loadInfo: async (id) => {
            id = this._aid(id) || id
            let doc = await this._fetchDoc(`/photos-index-aid-${id}.html`)
            try {
                let titleEl = doc.querySelector("div.userwrap h2") ||
                    doc.querySelector("#bodywrap h2") || doc.querySelector("h2")
                let title = this._clean(titleEl ? titleEl.text : "")
                if (!title) throw "Failed to load comic info"

                let coverEl = doc.querySelector("div.asTBcell.uwthumb img") ||
                    doc.querySelector("div.uwthumb img")
                let cover = this._normImg(coverEl ? coverEl.attributes["src"] : "")

                // 分類 / 頁數 / 編號
                let category = "", pagesRaw = "", code = ""
                for (let label of doc.querySelectorAll("div.asTBcell.uwconn label")) {
                    let t = this._clean(label.text)
                    if (t.indexOf("分類") === 0) category = (t.split("：")[1] || "").trim()
                    else if (t.indexOf("頁數") === 0) pagesRaw = (t.split("：")[1] || "").trim()
                    else if (t.indexOf("編號") === 0) code = (t.split("：")[1] || "").trim()
                }
                if (!pagesRaw) {
                    for (let label of doc.querySelectorAll("div.uwconn label")) {
                        let t = this._clean(label.text)
                        if (t.indexOf("分類") === 0 && !category) category = (t.split("：")[1] || "").trim()
                        else if (t.indexOf("頁數") === 0 && !pagesRaw) pagesRaw = (t.split("：")[1] || "").trim()
                        else if (t.indexOf("編號") === 0 && !code) code = (t.split("：")[1] || "").trim()
                    }
                }
                let pagesNum = 0
                let pm = /(\d+)/.exec(pagesRaw)
                if (pm) pagesNum = parseInt(pm[1])

                // 標籤
                let tags = new Map()
                if (category) tags.set("分類", [category])
                if (pagesRaw) tags.set("頁數", [pagesRaw])
                if (code) tags.set("編號", [code])
                let tagList = []
                for (let a of doc.querySelectorAll("a.tagshow")) {
                    let t = this._clean(a.text)
                    if (t) tagList.push(t)
                }
                if (tagList.length > 0) tags.set("標籤", tagList)

                // 原站無獨立作者字段，取標題首個 [xxx] 作為作者
                let author = ""
                let am = /\[([^\[\]]+)\]/.exec(title)
                if (am) author = am[1].trim()
                if (author) tags.set("作者", [author])

                // 簡介
                let descEl = doc.querySelector("div.asTBcell.uwconn > p") ||
                    doc.querySelector("div.uwconn p")
                let description = descEl
                    ? this._clean(descEl.text).replace(/^簡介：?\s*/, "")
                    : ""

                // 上傳者
                let upEl = doc.querySelector("div.asTBcell.uwuinfo > a > p") ||
                    doc.querySelector("div.uwuinfo a p")
                let uploader = upEl ? this._clean(upEl.text) : ""

                // 章節：原站多為單畫廊；若頁面出現其他 aid 連結則視為章節列表
                let chapters = new Map()
                for (let a of doc.querySelectorAll("div.userwrap a[href*='-aid-']")) {
                    let cid = this._aid(a.attributes["href"])
                    if (!cid || cid === String(id)) continue
                    let t = this._clean(a.text)
                    if (!t) continue
                    chapters.set(cid, t)
                }
                if (chapters.size === 0) chapters.set(String(id), title)

                return new ComicDetails({
                    id: String(id),
                    title: title,
                    subtitle: author || undefined,
                    cover: cover,
                    tags: tags,
                    description: description,
                    uploader: uploader || undefined,
                    maxPage: pagesNum || undefined,
                    thumbnails: null,
                    url: `${this.baseUrl}/photos-index-aid-${id}.html`,
                    chapters: chapters,
                })
            } finally {
                doc.dispose()
            }
        },

        loadThumbnails: async (id, next) => {
            id = this._aid(id) || id
            let page = Number(next) || 1
            let doc = await this._fetchDoc(`/photos-index-page-${page}-aid-${id}.html`)
            try {
                let imgs = doc.querySelectorAll("div.pic_box.tb img")
                if (imgs.length === 0) imgs = doc.querySelectorAll("div.gallary_wrap.tb ul.cc img")
                let thumbnails = []
                for (let img of imgs) {
                    let src = img.attributes["src"] || img.attributes["data-src"] || ""
                    if (src) thumbnails.push(this._normImg(src))
                }
                let hasNext = false
                let paginator = doc.querySelector("div.f_left.paginator")
                if (paginator && paginator.querySelector("span.next")) hasNext = true
                return {
                    thumbnails: thumbnails,
                    next: hasNext ? String(page + 1) : null,
                }
            } finally {
                doc.dispose()
            }
        },

        loadEp: async (comicId, epId) => {
            let id = this._aid(epId) || this._aid(comicId) || comicId
            let images = await this._imagesFromItem(id)
            if (images.length === 0) images = await this._imagesFromGallery(id)
            if (images.length === 0) images = await this._imagesFromThumbs(id)
            if (images.length === 0) throw "No images found"
            return { images: images }
        },

        onImageLoad: (url, comicId, epId) => {
            let referer = ""
            try { referer = this.baseUrl + "/" } catch (e) { /* ignore */ }
            return { headers: this._baseHeaders(referer) }
        },

        onThumbnailLoad: (url) => {
            let referer = ""
            try { referer = this.baseUrl + "/" } catch (e) { /* ignore */ }
            return { headers: this._baseHeaders(referer) }
        },

        onClickTag: (namespace, tag) => {
            namespace = namespace || ""
            tag = (tag || "").trim()
            if (namespace === "分類") {
                let main = tag.split(/[／/]/)[0].trim()
                let cid = Wnacg.CATE_IDS[main]
                if (cid) {
                    return {
                        page: "category",
                        attributes: { category: main, param: `/albums-index-cate-${cid}.html` },
                    }
                }
            }
            // 標籤/作者/編號：走站內搜索（原站標籤頁由 category 入口承載，搜索更通用）
            return { page: "search", keyword: tag }
        },

        idMatch: "^(?:wnacg-?)?(?:aid-?)?(\\d{1,8})$",

        link: {
            domains: [
                "wnacg.com", "www.wnacg.com",
                "wnacg.ru", "www.wnacg.ru",
                "wn10.cfd", "www.wn10.cfd",
                "wn10.shop", "www.wn10.shop",
                "wnacg01.link", "wnacg02.link",
            ],
            linkToId: (url) => {
                let m = /-aid-(\d+)/.exec(url || "")
                if (m) return m[1]
                let m2 = /^\s*(?:wnacg-?)?(?:aid-?)?(\d{1,8})\s*$/i.exec(url || "")
                return m2 ? m2[1] : null
            },
        },

        // 真實評論接口：AJAX 片段，10 條/頁
        loadComments: async (comicId, subId, page, replyTo) => {
            let id = this._aid(comicId) || comicId
            // 原站没有按父评论分页的接口，回复列表返回空
            if (replyTo) return { comments: [], maxPage: 1 }

            page = Number(page) || 1
            let body = await this._fetchHtml(`/?ctl=comment&act=frag&aid=${id}&sort=hot&page=${page}`)
            let doc = new HtmlDocument(body)
            try {
                let items = doc.querySelectorAll("div.plItem")
                let comments = []
                for (let it of items) {
                    try {
                        let userName = it.querySelector("span.plName")
                        let time = it.querySelector("span.plTime")
                        let text = it.querySelector("div.plText")
                        let avatar = it.querySelector("img.plAv")
                        let up = it.querySelector("a.plUp")
                        let down = it.querySelector("a.plDown")

                        let likes = 0, dislikes = 0
                        if (up) {
                            let i = up.querySelector("i")
                            likes = parseInt(i ? i.text : "0") || 0
                        }
                        if (down) {
                            let i = down.querySelector("i")
                            dislikes = parseInt(i ? i.text : "0") || 0
                        }
                        let voteStatus = 0
                        if (up && (up.classNames || []).indexOf("on") >= 0) voteStatus = 1
                        else if (down && (down.classNames || []).indexOf("on") >= 0) voteStatus = -1

                        let content = ""
                        if (text) {
                            content = text.innerHTML || this._clean(text.text)
                        }
                        if (!this._clean(this._stripTags(content))) continue

                        comments.push(new Comment({
                            id: it.attributes["data-id"] || undefined,
                            userName: this._clean(userName ? userName.text : ""),
                            avatar: this._normImg(avatar ? avatar.attributes["src"] : ""),
                            content: content,
                            time: this._clean(time ? time.text : ""),
                            score: likes - dislikes,
                            voteStatus: voteStatus,
                            isLiked: voteStatus === 1,
                        }))
                    } catch (e) { /* skip */ }
                }
                return {
                    comments: comments,
                    maxPage: items.length >= 10 ? page + 1 : page,
                }
            } finally {
                doc.dispose()
            }
        },

        sendComment: async (comicId, subId, content, replyTo) => {
            let id = this._aid(comicId) || comicId
            let res = await this._request("post", `/?ctl=comment&act=post&aid=${id}`, {
                headers: { "content-type": "application/x-www-form-urlencoded" },
                data: `aid=${encodeURIComponent(id)}&pid=${encodeURIComponent(replyTo || 0)}&content=${encodeURIComponent(content)}`,
                noFailover: true,
            })
            let json = this._tryJson(res.body)
            if (json && json.ok) return "ok"
            let msg = json ? this._clean(json.msg || json.html || "") : this._clean(this._stripTags(res.body))
            if (/登[入錄]|Login expired/i.test(msg)) throw "Login expired"
            throw msg || "Send failed"
        },

        likeComment: async (comicId, subId, commentId, isLike) => {
            let id = this._aid(comicId) || comicId
            let res = await this._request("post", `/?ctl=comment&act=vote&aid=${id}`, {
                headers: { "content-type": "application/x-www-form-urlencoded" },
                data: `plid=${encodeURIComponent(commentId)}&v=${isLike ? 1 : -1}`,
                noFailover: true,
            })
            let json = this._tryJson(res.body)
            if (json && json.ok) return
            let msg = json ? this._clean(json.msg || "") : ""
            if (/登[入錄]|Login expired/i.test(msg)) throw "Login expired"
            throw msg || "Vote failed"
        },

        enableTagsTranslate: false,
    }

    // ============================== 閱讀器數據源 ==============================

    _extractBalancedJson(text, marker) {
        let i = text.indexOf(marker)
        if (i < 0) return null
        let start = text.indexOf("{", i)
        if (start < 0) return null
        let depth = 0, inStr = false, esc = false
        for (let j = start; j < text.length; j++) {
            let ch = text[j]
            if (inStr) {
                if (esc) esc = false
                else if (ch === "\\") esc = true
                else if (ch === '"') inStr = false
            } else if (ch === '"') {
                inStr = true
            } else if (ch === "{") {
                depth++
            } else if (ch === "}") {
                depth--
                if (depth === 0) return text.slice(start, j + 1)
            }
        }
        return null
    }

    _dedupeImages(list) {
        let seen = new Set()
        let out = []
        for (let u of list) {
            if (!u) continue
            if (seen.has(u)) continue
            seen.add(u)
            out.push(u)
        }
        return out
    }

    // 主數據源: /photos-item-aid-N.html 的 mReader.initData JSON
    async _imagesFromItem(id) {
        try {
            let body = await this._fetchHtml(`/photos-item-aid-${id}.html`)
            let jsonStr = this._extractBalancedJson(body, "mReader.initData(")
            if (jsonStr) {
                let json = this._tryJson(jsonStr)
                if (json && Array.isArray(json.page_url)) {
                    return this._dedupeImages(json.page_url.map((u) => this._normImg(String(u))))
                }
            }
            // 正則兜底
            let m = /"page_url"\s*:\s*\[([\s\S]*?)\]/.exec(body)
            if (m) {
                let urls = []
                let re = /"((?:[^"\\]|\\.)*)"/g
                let mm
                while ((mm = re.exec(m[1])) !== null) {
                    let u = mm[1].replace(/\\\//g, "/").replace(/\\"/g, '"')
                    if (/\.(jpg|jpeg|png|webp|gif|jpe|bmp|avif)(\?|$)/i.test(u) || u.indexOf("/data/") >= 0) {
                        urls.push(u)
                    }
                }
                return this._dedupeImages(urls.map((u) => this._normImg(u)))
            }
        } catch (e) { /* 降級 */ }
        return []
    }

    // 降級: /photos-gallery-aid-N.html 的 imglist
    async _imagesFromGallery(id) {
        try {
            let body = await this._fetchHtml(`/photos-gallery-aid-${id}.html`)
            let urls = []
            // 原站 imglist 位於 document.writeln("...") 內，引號被轉義為 \"，需容忍反斜線
            let re = /url\s*:\s*(?:[A-Za-z_$][\w$]*\s*\+\s*)?\\?"((?:[^"\\]|\\.)*?)\\?"/g
            let m
            while ((m = re.exec(body)) !== null) {
                let u = m[1].replace(/\\\//g, "/").replace(/\\"/g, '"')
                // 只保留 CDN 絕對地址（正文圖片均為 //host/... 或 http(s)://host/...），
                // 排除站內相對資源（如 /themes/.../shoucang.jpg）
                if (!/^\/{2,}/.test(u) && !/^https?:\/\//i.test(u)) continue
                urls.push(u)
            }
            if (urls.length === 0) {
                let re2 = /(?:https?:)?\/{2,}[^"'\s]+\/(?:data|photos)\/[^"'\s]+?\.(?:jpg|jpeg|png|webp|gif)/gi
                while ((m = re2.exec(body)) !== null) urls.push(m[0])
            }
            return this._dedupeImages(urls.map((u) => this._normImg(u)))
        } catch (e) { /* 降級 */ }
        return []
    }

    // 最後降級: 詳情頁縮略圖逐頁抓取
    async _imagesFromThumbs(id) {
        let urls = []
        try {
            let doc = await this._fetchDoc(`/photos-index-aid-${id}.html`)
            let maxPage = 1
            try {
                maxPage = this._parseMaxPage(doc)
                for (let img of doc.querySelectorAll("div.pic_box.tb img")) {
                    let src = img.attributes["src"] || ""
                    if (src) urls.push(this._normImg(src))
                }
            } finally {
                doc.dispose()
            }
            for (let p = 2; p <= maxPage && p <= 500; p++) {
                let d = await this._fetchDoc(`/photos-index-page-${p}-aid-${id}.html`)
                try {
                    for (let img of d.querySelectorAll("div.pic_box.tb img")) {
                        let src = img.attributes["src"] || ""
                        if (src) urls.push(this._normImg(src))
                    }
                } finally {
                    d.dispose()
                }
            }
        } catch (e) { /* 放棄 */ }
        return this._dedupeImages(urls)
    }

    // ============================== 設置 ==============================

    get settings() {
        let domains = this.domainList()
        let options = [{ value: "0", text: this.translate("Custom Domain") }]
        for (let i = 0; i < domains.length; i++) {
            options.push({ value: String(i + 1), text: domains[i] })
        }

        return {
            refreshDomains: {
                title: this.translate("Refresh Domain List"),
                type: "callback",
                buttonText: this.translate("Refresh"),
                callback: () => this.refreshDomains(true),
            },
            refreshDomainsOnStart: {
                title: this.translate("Refresh Domain List on Startup"),
                type: "switch",
                default: true,
            },
            domainSelection: {
                title: this.translate("Domain Selection"),
                type: "select",
                options: options,
                default: "1",
            },
            domain0: {
                title: this.translate("Custom Domain"),
                type: "input",
                validator: String.raw`^(?!:\/\/)(?=.{1,253})([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$`,
                default: "www.wnacg.com",
            },
        }
    }

    translation = {
        "zh_CN": {
            "Refresh Domain List": "刷新域名列表",
            "Refresh": "刷新",
            "Refresh Domain List on Startup": "启动时刷新域名列表",
            "Domain Selection": "域名选择",
            "Custom Domain": "自定义域名",
            "Update Success": "更新成功",
            "Update Failed": "更新失败",
            "Available mirrors": "可用镜像",
            "Keep current mirrors": "保持当前镜像",
            "Re-enter page to refresh": "重新进入页面后生效",
            "Cancel": "取消",
            "Apply": "应用",
            "排序": "排序",
            "範圍": "范围",
            "最新": "最新",
            "最早": "最早",
            "最多評論": "最多评论",
            "最多收藏": "最多收藏",
            "全部": "全部",
            "標籤": "标签",
        },
        "zh_TW": {
            "Refresh Domain List": "重新整理網域清單",
            "Refresh": "重新整理",
            "Refresh Domain List on Startup": "啟動時重新整理網域清單",
            "Domain Selection": "網域選擇",
            "Custom Domain": "自訂網域",
            "Update Success": "更新成功",
            "Update Failed": "更新失敗",
            "Available mirrors": "可用鏡像",
            "Keep current mirrors": "保持目前鏡像",
            "Re-enter page to refresh": "重新進入頁面後生效",
            "Cancel": "取消",
            "Apply": "套用",
            "排序": "排序",
            "範圍": "範圍",
            "最新": "最新",
            "最早": "最早",
            "最多評論": "最多評論",
            "最多收藏": "最多收藏",
            "全部": "全部",
            "標籤": "標籤",
        },
        "en": {
            "Refresh Domain List": "Refresh Domain List",
            "Refresh": "Refresh",
            "Refresh Domain List on Startup": "Refresh domains on startup",
            "Domain Selection": "Domain Selection",
            "Custom Domain": "Custom Domain",
            "Update Success": "Update Success",
            "Update Failed": "Update Failed",
            "Available mirrors": "Available mirrors",
            "Keep current mirrors": "Keep current mirrors",
            "Re-enter page to refresh": "Re-enter the page to apply",
            "Cancel": "Cancel",
            "Apply": "Apply",
            "最新": "Newest",
            "最早": "Oldest",
            "最多評論": "Most comments",
            "最多收藏": "Most favorites",
            "全部": "All",
            "標籤": "Tags",
        },
    }
}
