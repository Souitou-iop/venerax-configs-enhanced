/**
 * 漫画柜 (manhuagui.com) —— Venera 漫画源（完全重写版 v2）
 *
 * ============================ 原站分析 ============================
 * 站点程序: ASP.NET（.aspx/.ashx 接口），静态资源在 cf.mhgui.com，正文图片在 hamreus.com CDN
 * 主域名:   https://www.manhuagui.com
 *
 * 1) 首页 /                板块结构:
 *                          - 热门更新: div.update-cont > div#updateWrap > ul（5 行 × 6）> li
 *                            条目: a.bcover[href=/comic/ID/] > img（懒加载时只有 data-src）
 *                                  + span.tt（最新话）+ span.te（更新时间）；li > p.ell > a（标题）
 *                          - 排行榜:  p#rankTab > a（日/周/月/总）+ div#rankCont > ul × 4（每榜 40 条）
 *                            条目: li.numN > em（名次）+ h6 > a（标题）+ span > a（最新章节）
 *                                  + small（评分）
 *                          - 板块 tab: ul#cmt-tab > li（热门连载/经典完结/最新上架/2020新番）+
 *                            div#cmt-cont > ul.cover-list × 4（每块 12 条，条目结构同热门更新）
 *                          - 题材专区: div.idx-sc-cont × 4；h4 > a（题材名，"/" 分隔）、
 *                            div.idx-sc-bar > li（热门连载/经典完结）、div.idx-sc-list > ul × 2
 *                            （每块 15 条，条目结构同排行榜）
 * 2) 每日更新 /update/     div.latest-cont >（h5 > strong 日期）+ div.latest-list > ul > li
 *                          条目: a.cover > img（可 data-src）+ span.tt；li > p.ell > a；
 *                                li > span.dt > em（更新日期）
 * 3) 排行榜 /rank/         div.w860 > div.bar-tab.top-tab（日/周/月/总）+ div.top-cont
 *                          > table.rank-detail > tr（th 表头行 + .rank-split-first 分隔行 + 数据行）
 *                          数据行: td.rank-no / td.rank-title > h5 > a[href=/comic/ID/] /
 *                                  td.rank-author / td.rank-update / td.rank-time / td.rank-score
 *                          榜单页无封面 <img>，封面按站点 ID 规则拼接 cf.mhgui.com/cpic/m/ID.jpg
 * 4) 分类 /list/...        URL 规则（由夹具 list_japan.html 的筛选链接实测）:
 *                          /list/                    无筛选
 *                          单条件: /list/{token}/     地区 japan/hongkong/other/europe/china/korea
 *                                                     题材 rexue/maoxian/...（共 38 个）
 *                                                     受众 shaonv/shaonian/qingnian/ertong/tongyong
 *                                                     年份 2026/.../200x/199x/198x/197x
 *                                                     字母 a-z/0-9、进度 lianzai/wanjie
 *                          多条件用 "_" 连接（顺序 地区_题材_受众_进度）: /list/japan_rexue/
 *                          排序后缀: {sort}.html（update 最新更新 / view 人气最旺 / rate 评分最高）,
 *                                   默认排序 index 的第 1 页即目录本身
 *                          翻页后缀: {sort}_p{n}.html（如 /list/japan/index_p2.html）
 *                          列表: div.result-count（第 X / Y 页，共有 N 部漫画）+
 *                                ul#contList > li（a.bcover > img + span.tt + span.sl/span.fd；
 *                                p.ell > a；span.updateon（更新于：日期 + em 评分））
 * 5) 搜索 /s/{kw}.html     排序: /s/{kw}_o1.html（最近最热）_o2（最新上架）_o3（评分最高），
 *                          默认 /s/{kw}.html = 最新更新；翻页 /s/{kw}_p{n}.html；
 *                          组合 /s/{kw}_o{type}_p{page}.html
 *                          结果: div.book-result > ul > li.cf
 *                                div.book-cover a.bcover > img（封面）
 *                                div.book-detail dl > dt > a（标题）+ small > a（别名）
 *                                dd.tags.status（状态 + 最近更新时间 + 最新章节）
 *                                dd.tags（年份/地区/类型/作者/别名）、dd.intro（简介）
 *                                div.book-score p.score-avg > strong（评分）
 * 6) 详情 /comic/{id}/      div.book-cont > div.book-cover p.hcover > img（封面）
 *                          div.book-title > h1（标题）/ h2（原名）、div#intro-all > p（简介）
 *                          ul.detail-list > li > span > strong（标签名）+ a（标签值）:
 *                          出品年代 / 漫画地区 / 字母索引 / 漫画剧情 / 漫画作者 / 漫画别名 /
 *                          漫画状态（li.status > span > span.red: [状态, 最近更新日期]）
 *                          章节: div.chapter > h4 > span（分组名）+ div.chapter-list（tab 切换时
 *                                含多个 ul，需全部收集）/ div.chapter-page（"单话" 分页按钮，
 *                                href=javascript:;，不是章节）
 *                                li > a[href=/comic/{id}/{ep}.html][title] > span（章节名 + i 页数）
 *                          相关漫画: ul.similar-list > li
 * 7) 阅读 /comic/{id}/{ep}.html
 *                          正文数据在 packer 混淆脚本中（window["\x65\x76\x61\x6c"](...)）:
 *                          }('13.10({...}).f();',62,66,'BASE64'['\x73\x70\x6c\x69\x63']('\x7c'),0,{}))
 *                          1. k = LZString.decompressFromBase64(BASE64).split('|')
 *                          2. 按 Dean Edwards packer 规则做 base62 词元还原（a/c 动态）
 *                          3. 取第一个平衡花括号 JSON:
 *                             SMH.imgData({bid,bname,bpic,cid,cname,files[],finished,len,path,
 *                                          status,block_cc,nextId,prevId,sl:{e,m}})
 *                          4. 图片 URL = https://us.hamreus.com + path + file + ?e={sl.e}&m={sl.m}
 *                             （匿名实测 200 image/webp；备域名 i.hamreus.com）
 * 8) 评论 tools/submit_ajax.ashx?action=comment_list&book_id={id}&page_index={n}
 *                          JSON: {commentIds:[...], comments:{id:{...}}, total:N}
 *                          commentIds 每项是一条评论链 ["叶子",...,"根"]（根在最后，单项即根），
 *                          站点每页 10 条；发评论 action=comment_add
 * 9) 登录 POST /tools/submit_ajax.ashx?action=user_login
 *                          表单字段 txtUserName / txtPassword（见 /user/login 的 #loginform），
 *                          成功后 Set-Cookie 的 my=... 即登录凭证，后续请求带上即可
 *
 * 本版要点:
 * - 章节图片完全自解析: 源文件内置标准 lz-string + packer 反混淆，不依赖任何外部全局
 * - 全部入口使用稳定 DOM 选择器 / 站点 JSON 接口，失败时抛出含 URL 与状态码的错误
 * - 分类 URL 规则按页面实测重建（地区_题材_受众_进度 + 排序/翻页后缀）
 * - 评论接口按站点 JSON 还原评论链（主评论 + 直接回复）
 * - 图片与缩略图请求统一带 Referer https://www.manhuagui.com/
 *
 * 夹具: _analysis/fixtures/manhuagui（home/update/rank/list_japan/search_ship/detail_32602/
 *       chapter_32602_810441/comments_32602.json/login.html，manifest.jsonl 记录来源与抓取时间）
 * 离线回归: _analysis/test/harness_manhuagui.js
 * ==================================================================
 */
class ManHuaGui extends ComicSource {
    name = "漫画柜"

    key = "ManHuaGui"

    version = "2.0.0"

    minAppVersion = "1.6.0"

    url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/manhuagui.js"

    baseUrl = "https://www.manhuagui.com"

    static UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

    // 章节图片 CDN（主域名匿名可访问，备域名用于个别线路失效时手动切换）
    static IMAGE_HOSTS = [
        "https://us.hamreus.com",
        "https://i.hamreus.com",
    ]

    // 封面兜底规则: 站点封面 CDN 按漫画 ID 拼接（榜单页本身不含封面 <img>）
    static COVER_URL = "https://cf.mhgui.com/cpic/m/"

    // 题材（值 -> 中文名）: 与 /list/ 页面「按剧情」筛选链接一致（夹具 list_japan.html 实测）
    static GENRES = [
        ["rexue", "热血"], ["maoxian", "冒险"], ["mohuan", "魔幻"], ["shengui", "神鬼"],
        ["gaoxiao", "搞笑"], ["mengxi", "萌系"], ["aiqing", "爱情"], ["kehuan", "科幻"],
        ["mofa", "魔法"], ["gedou", "格斗"], ["wuxia", "武侠"], ["jizhan", "机战"],
        ["zhanzheng", "战争"], ["jingji", "竞技"], ["tiyu", "体育"], ["xiaoyuan", "校园"],
        ["shenghuo", "生活"], ["lizhi", "励志"], ["lishi", "历史"], ["weiniang", "伪娘"],
        ["zhainan", "宅男"], ["funv", "腐女"], ["danmei", "耽美"], ["baihe", "百合"],
        ["hougong", "后宫"], ["zhiyu", "治愈"], ["meishi", "美食"], ["tuili", "推理"],
        ["xuanyi", "悬疑"], ["kongbu", "恐怖"], ["sige", "四格"], ["zhichang", "职场"],
        ["zhentan", "侦探"], ["shehui", "社会"], ["yinyue", "音乐"], ["wudao", "舞蹈"],
        ["zazhi", "杂志"], ["heidao", "黑道"],
    ]

    // 地区 / 受众 / 进度 / 排序（值 -> 中文名），与站点筛选链接一致
    static AREAS = [
        ["japan", "日本"], ["hongkong", "港台"], ["other", "其它"],
        ["europe", "欧美"], ["china", "内地"], ["korea", "韩国"],
    ]

    static AGES = [
        ["shaonv", "少女"], ["shaonian", "少年"], ["qingnian", "青年"],
        ["ertong", "儿童"], ["tongyong", "通用"],
    ]

    static PROGRESS = [
        ["lianzai", "连载"], ["wanjie", "完结"],
    ]

    static SORTS = [
        ["index", "最新发布"], ["update", "最新更新"],
        ["view", "人气最旺"], ["rate", "评分最高"],
    ]

    // 详情页标签名 -> 展示用标签分组名
    static TAG_KEYS = {
        "出品年代": "年代",
        "漫画地区": "地区",
        "漫画剧情": "类型",
        "漫画作者": "作者",
        "漫画别名": "别名",
    }

    // ============================== 内置 lz-string ==============================
    // 章节数据经 lz-string 压缩后再做 packer 混淆，这里内置标准 lz-string 解压实现
    // （decompressFromBase64 = _decompress(len, 32, ...)），不依赖运行环境是否提供全局 LZString。
    LZString = (function () {
        var baseReverseDic = {}
        var base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="

        function getBaseValue(alphabet, character) {
            if (!baseReverseDic[alphabet]) {
                baseReverseDic[alphabet] = {}
                for (var i = 0; i < alphabet.length; i++) {
                    baseReverseDic[alphabet][alphabet.charAt(i)] = i
                }
            }
            return baseReverseDic[alphabet][character]
        }

        function decompress(length, resetValue, getNextValue) {
            var dictionary = []
            var next
            var enlargeIn = 4
            var dictSize = 4
            var numBits = 3
            var entry = ""
            var result = []
            var i
            var w
            var bits
            var resb
            var maxpower
            var power
            var c
            var data = {
                val: getNextValue(0),
                position: resetValue,
                index: 1,
            }

            for (i = 0; i < 3; i += 1) {
                dictionary[i] = i
            }

            bits = 0
            maxpower = Math.pow(2, 2)
            power = 1
            while (power != maxpower) {
                resb = data.val & data.position
                data.position >>= 1
                if (data.position == 0) {
                    data.position = resetValue
                    data.val = getNextValue(data.index++)
                }
                bits |= (resb > 0 ? 1 : 0) * power
                power <<= 1
            }

            switch (next = bits) {
                case 0:
                    bits = 0
                    maxpower = Math.pow(2, 8)
                    power = 1
                    while (power != maxpower) {
                        resb = data.val & data.position
                        data.position >>= 1
                        if (data.position == 0) {
                            data.position = resetValue
                            data.val = getNextValue(data.index++)
                        }
                        bits |= (resb > 0 ? 1 : 0) * power
                        power <<= 1
                    }
                    c = String.fromCharCode(bits)
                    break
                case 1:
                    bits = 0
                    maxpower = Math.pow(2, 16)
                    power = 1
                    while (power != maxpower) {
                        resb = data.val & data.position
                        data.position >>= 1
                        if (data.position == 0) {
                            data.position = resetValue
                            data.val = getNextValue(data.index++)
                        }
                        bits |= (resb > 0 ? 1 : 0) * power
                        power <<= 1
                    }
                    c = String.fromCharCode(bits)
                    break
                case 2:
                    return ""
            }

            dictionary[3] = c
            w = c
            result.push(c)

            while (true) {
                if (data.index > length) {
                    return ""
                }

                bits = 0
                maxpower = Math.pow(2, numBits)
                power = 1
                while (power != maxpower) {
                    resb = data.val & data.position
                    data.position >>= 1
                    if (data.position == 0) {
                        data.position = resetValue
                        data.val = getNextValue(data.index++)
                    }
                    bits |= (resb > 0 ? 1 : 0) * power
                    power <<= 1
                }

                switch (c = bits) {
                    case 0:
                        bits = 0
                        maxpower = Math.pow(2, 8)
                        power = 1
                        while (power != maxpower) {
                            resb = data.val & data.position
                            data.position >>= 1
                            if (data.position == 0) {
                                data.position = resetValue
                                data.val = getNextValue(data.index++)
                            }
                            bits |= (resb > 0 ? 1 : 0) * power
                            power <<= 1
                        }
                        dictionary[dictSize++] = String.fromCharCode(bits)
                        c = dictSize - 1
                        enlargeIn--
                        break
                    case 1:
                        bits = 0
                        maxpower = Math.pow(2, 16)
                        power = 1
                        while (power != maxpower) {
                            resb = data.val & data.position
                            data.position >>= 1
                            if (data.position == 0) {
                                data.position = resetValue
                                data.val = getNextValue(data.index++)
                            }
                            bits |= (resb > 0 ? 1 : 0) * power
                            power <<= 1
                        }
                        dictionary[dictSize++] = String.fromCharCode(bits)
                        c = dictSize - 1
                        enlargeIn--
                        break
                    case 2:
                        return result.join("")
                }

                if (enlargeIn == 0) {
                    enlargeIn = Math.pow(2, numBits)
                    numBits++
                }

                if (dictionary[c]) {
                    entry = dictionary[c]
                } else {
                    if (c === dictSize) {
                        entry = w + w.charAt(0)
                    } else {
                        return null
                    }
                }
                result.push(entry)

                dictionary[dictSize++] = w + entry.charAt(0)
                enlargeIn--
                w = entry

                if (enlargeIn == 0) {
                    enlargeIn = Math.pow(2, numBits)
                    numBits++
                }
            }
        }

        return {
            /**
             * 解压 lz-string 的 compressToBase64 输出
             * @param input {string}
             * @returns {string|null}
             */
            decompressFromBase64: function (input) {
                if (input == null) return ""
                if (input == "") return null
                return decompress(input.length, 32, function (index) {
                    return getBaseValue(base64Alphabet, input.charAt(index))
                })
            },
        }
    })()

    // ============================== 基础工具 ==============================

    /**
     * 站点在加载源时会调用 init。
     * 这里做一次自检: 章节图片解码依赖内置 lz-string，缺失时给出明确告警（不阻断源加载）。
     */
    init() {
        if (!this.LZString || typeof this.LZString.decompressFromBase64 !== "function") {
            console.error("漫画柜: 内置 lz-string 解码器不可用, 章节图片将无法解析")
        }
        if (!this.baseUrl) {
            console.error("漫画柜: baseUrl 未配置")
        }
    }

    // 折叠空白
    _clean(text) {
        return String(text == null ? "" : text).replace(/[\s\u3000]+/g, " ").trim()
    }

    // 协议相对（//cf.mhgui.com/...）与站内相对路径（/comic/1/）统一转绝对 URL
    _abs(url) {
        let u = this._clean(url)
        if (!u) return ""
        if (u.indexOf("//") === 0) return "https:" + u
        if (u.indexOf("/") === 0) return this.baseUrl + u
        return u
    }

    // 从 /comic/123/ 之类的链接取漫画 ID
    _comicId(href) {
        let m = /\/comic\/(\d+)/.exec(String(href == null ? "" : href))
        return m ? m[1] : null
    }

    // 从 /comic/123/456.html 取章节 ID
    _epId(href) {
        let m = /\/comic\/\d+\/(\d+)\.html/.exec(String(href == null ? "" : href))
        return m ? m[1] : null
    }

    // 用户可能直接输入数字 ID 或粘贴详情页链接
    _toComicId(id) {
        let m = /\d{1,10}/.exec(String(id == null ? "" : id))
        if (!m) {
            throw `无法识别的漫画 ID: ${id}`
        }
        return m[0]
    }

    // 封面兜底（榜单/题材榜页面没有封面图）
    coverUrl(id) {
        return ManHuaGui.COVER_URL + this._toComicId(id) + ".jpg"
    }

    // 登录凭证（my=<token>），未登录返回 null
    _cookie() {
        let cookie = null
        try {
            cookie = this.loadData("mhg_cookie")
        } catch (e) {
            cookie = null
        }
        if (!cookie) return null
        let value = String(cookie).trim()
        return value ? value : null
    }

    /**
     * 统一请求头
     * @param options {{referer?: string, accept?: string, xhr?: boolean}}
     */
    _headers(options) {
        options = options || {}
        let headers = {
            "User-Agent": ManHuaGui.UA,
            "Accept": options.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7",
        }
        if (options.referer) headers["Referer"] = options.referer
        if (options.xhr) headers["X-Requested-With"] = "XMLHttpRequest"
        let cookie = this._cookie()
        if (cookie) headers["Cookie"] = cookie
        return headers
    }

    // 统一 GET: 非 200 直接抛出含 URL 与状态码的错误（便于定位站点改版/风控）
    async _get(url, options) {
        let res = await Network.get(url, this._headers(options))
        if (!res || res.status !== 200) {
            throw `请求失败: HTTP ${res && res.status != null ? res.status : "无响应"} (${url})`
        }
        return res
    }

    async _fetchDoc(url, options) {
        let res = await this._get(url, options)
        return new HtmlDocument(res.body)
    }

    // 解析 JSON, 失败返回 null（由调用方给出可诊断错误）
    _tryJson(text) {
        try {
            return JSON.parse(text)
        } catch (e) {
            return null
        }
    }

    async _fetchJson(url, options) {
        let res = await this._get(url, options)
        let data = this._tryJson(res.body)
        if (data === null) {
            let head = String(res.body == null ? "" : res.body).slice(0, 120)
            throw `响应不是合法 JSON (${url}), 开头: ${head}`
        }
        return data
    }

    // 从 Set-Cookie 头里取 my 凭证
    _myCookieFrom(headers) {
        if (!headers) return null
        let raw = headers["set-cookie"] || headers["Set-Cookie"]
        if (!raw) return null
        let items = Array.isArray(raw) ? raw : [String(raw)]
        for (let item of items) {
            let m = /(?:^|[;,\s])my=([^;,\s]+)/.exec(String(item))
            if (m) return m[1]
        }
        return null
    }

    // ============================== 列表解析 ==============================

    /**
     * 通用封面卡片: 首页热门更新 / cmt 板块 / 每日更新 / 分类列表
     * <a class="bcover|cover|scover" href="/comic/ID/"><img src|data-src><span class="tt">最新话</span>
     *   [<span class="sl">连载</span>|<span class="fd">完结</span>]</a>
     * <p class="ell"><a href="/comic/ID/">标题</a></p>
     * [<span class="updateon">更新于：日期<em>评分</em></span>|<span class="dt"><em>日期</em></span>]
     */
    _parseCard(li) {
        let link = li.querySelector("a.bcover") || li.querySelector("a.cover") || li.querySelector("a.scover")
        let titleLink = li.querySelector("p.ell > a")
        let href = (link && link.attributes["href"]) || (titleLink && titleLink.attributes["href"]) || ""
        let id = this._comicId(href)
        if (!id) return null

        let title = this._clean(titleLink ? titleLink.text : "")
        if (!title && link) title = this._clean(link.attributes["title"] || link.text)
        if (!title) title = id

        let img = li.querySelector("img")
        let cover = img ? this._abs(img.attributes["src"] || img.attributes["data-src"]) : ""
        if (!cover) cover = this.coverUrl(id)

        let latestEl = link ? link.querySelector("span.tt") : null
        let latest = this._clean(latestEl ? latestEl.text : "")

        let tags = []
        if (link) {
            if (link.querySelector("span.sl")) tags.push("连载")
            else if (link.querySelector("span.fd")) tags.push("完结")
        }
        let score = ""
        let updateEl = li.querySelector("span.updateon")
        if (updateEl) {
            let em = updateEl.querySelector("em")
            score = this._clean(em ? em.text : "")
            let date = this._clean(updateEl.text).replace(/更新于[:：]?/, "")
            if (score) date = this._clean(date.replace(score, ""))
            if (date) tags.push(date)
        }
        let dateEl = li.querySelector("span.dt")
        if (dateEl) {
            let date = this._clean(dateEl.text)
            if (date) tags.push(date)
        }
        if (score) tags.push(`评分 ${score}`)

        let description = []
        if (latest) description.push(`更新至 ${latest}`)
        if (score) description.push(`评分 ${score}`)

        return new Comic({
            id: id,
            title: title,
            subtitle: latest,
            cover: cover,
            tags: tags,
            description: description.join(" · "),
        })
    }

    /**
     * 纯文字排行条目: 首页 #rankCont 与题材专区 .idx-sc-list
     * <li class="numN"><em>名次</em><h6><a href="/comic/ID/">标题</a>
     *   <span> [<a href="/comic/ID/EP.html">最新章节</a>][<i>完</i>]</span></h6><small>评分</small></li>
     */
    _parseRankItem(li) {
        let a = li.querySelector("h6 a")
        if (!a) return null
        let id = this._comicId(a.attributes["href"])
        if (!id) return null

        let rankEl = li.querySelector("em")
        let rank = this._clean(rankEl ? rankEl.text : "")
        let scoreEl = li.querySelector("small")
        let score = this._clean(scoreEl ? scoreEl.text : "")
        let latestEl = li.querySelector("h6 span a")
        let latest = this._clean(latestEl ? latestEl.text : "")
        let finished = !!li.querySelector("h6 span i")

        let tags = []
        if (rank) tags.push(`第${rank}名`)
        if (score) tags.push(`评分 ${score}`)
        if (finished) tags.push("完结")

        return new Comic({
            id: id,
            title: this._clean(a.text) || id,
            subtitle: latest,
            cover: this.coverUrl(id),
            tags: tags,
            description: tags.join(" · "),
        })
    }

    /**
     * 排行榜表格行: table.rank-detail > tr
     * td.rank-no / td.rank-title > h5 > a / td.rank-author / td.rank-update / td.rank-time / td.rank-score
     * 表头行与 .rank-split-first 分隔行没有 td.rank-title，返回 null 被跳过
     */
    _parseRankRow(tr) {
        let titleCell = tr.querySelector("td.rank-title")
        if (!titleCell) return null
        let a = titleCell.querySelector("h5 a") || titleCell.querySelector("a")
        if (!a) return null
        let id = this._comicId(a.attributes["href"])
        if (!id) return null

        let rankEl = tr.querySelector("td.rank-no span")
        let rank = this._clean(rankEl ? rankEl.text : "")
        let authorEl = tr.querySelector("div.rank-author")
        let author = this._clean(authorEl ? authorEl.text : "").replace(/[,\s]+$/, "")
        let updateEl = tr.querySelector("div.rank-update a")
        let latest = this._clean(updateEl ? (updateEl.attributes["title"] || updateEl.text) : "")
        let timeEl = tr.querySelector("td.rank-time")
        let time = this._clean(timeEl ? timeEl.text : "")
        let scoreEl = tr.querySelector("td.rank-score")
        let score = this._clean(scoreEl ? scoreEl.text : "")

        let tags = []
        if (rank) tags.push(`第${rank}名`)
        if (time) tags.push(time)
        if (score) tags.push(`评分 ${score}`)

        let description = []
        if (latest) description.push(`更新至 ${latest}`)
        if (time) description.push(`更新于 ${time}`)
        if (score) description.push(`评分 ${score}`)

        return new Comic({
            id: id,
            title: this._clean(a.text) || id,
            subtitle: author || latest,
            cover: this.coverUrl(id),
            tags: tags,
            description: description.join(" · "),
        })
    }

    // 排行榜页面全部榜单行
    _parseRankTable(doc) {
        let comics = []
        for (let tr of doc.querySelectorAll("table.rank-detail tr")) {
            let comic = this._parseRankRow(tr)
            if (comic) comics.push(comic)
        }
        return comics
    }

    /**
     * 搜索结果条目: div.book-result > ul > li.cf
     * 分类字段通过 dd 内的 strong 标签名匹配（年份/地区/类型/作者/别名/状态/简介），
     * 不依赖 dd 顺序，避免站点调整字段顺序时解析错位
     */
    _parseSearchItem(li) {
        let titleLink = li.querySelector("div.book-detail dt a") || li.querySelector("dt a")
        if (!titleLink) return null
        let id = this._comicId(titleLink.attributes["href"])
        if (!id) return null

        let title = this._clean(titleLink.text) || this._clean(titleLink.attributes["title"] || "") || id
        let img = li.querySelector("div.book-cover img") || li.querySelector("img")
        let cover = img ? this._abs(img.attributes["src"] || img.attributes["data-src"]) : ""
        if (!cover) cover = this.coverUrl(id)

        let year = ""
        let area = ""
        let types = []
        let author = ""
        let alias = []
        let intro = ""
        let status = ""
        let updated = ""

        // 同一个 dd 内可能并排多个 "标签：值" span（年份/地区/类型同处 dd.tags），
        // 因此按 span 而不是按 dd 取字段，避免把多个字段的值合并进同一个标签
        for (let dd of li.querySelectorAll("div.book-detail dd")) {
            let scopes = []
            for (let span of dd.querySelectorAll("span")) {
                if (span.querySelector("strong")) scopes.push(span)
            }
            if (scopes.length === 0 && dd.querySelector("strong")) scopes = [dd]
            for (let scope of scopes) {
                let strong = scope.querySelector("strong")
                let label = this._clean(strong ? strong.text : "").replace(/[:：]\s*$/, "")
                if (!label) continue
                let values = []
                for (let a of scope.querySelectorAll("a")) {
                    let v = this._clean(a.text)
                    if (v) values.push(v)
                }
                if (label === "状态") {
                    let reds = scope.querySelectorAll("span.red")
                    if (reds.length > 0) status = this._clean(reds[0].text)
                    if (reds.length > 1) updated = this._clean(reds[1].text)
                    if (!updated) {
                        let m = /\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?/.exec(this._clean(scope.text))
                        if (m) updated = m[0]
                    }
                } else if (label === "年份") {
                    year = values.join("/")
                } else if (label === "地区") {
                    area = values.join("/")
                } else if (label === "类型") {
                    types = values
                } else if (label === "作者") {
                    author = values.join(", ")
                } else if (label === "别名") {
                    alias = values
                } else if (label === "简介") {
                    intro = this._clean(scope.text).replace(/^简介[:：]?\s*/, "").replace(/\[\s*详情\s*\]\s*$/, "")
                }
            }
        }

        let tags = []
        if (status) tags.push(status)
        tags = tags.concat(types)
        if (year) tags.push(year)
        if (area) tags.push(area)

        let description = intro
        if (!description) {
            let parts = []
            if (status) parts.push(`状态: ${status}`)
            if (updated) parts.push(`更新: ${updated}`)
            description = parts.join(", ")
        }

        return new Comic({
            id: id,
            title: title,
            subtitle: author || updated,
            cover: cover,
            tags: tags,
            description: description,
        })
    }

    /**
     * 解析 ".result-count"（分类页：第 X / Y 页，共有 N 部漫画；搜索页：共查找到 N 部漫画）
     * @param doc {HtmlDocument}
     * @param perPage {number} - 每页条数，用于由总数推算页数（搜索页无页数）
     * @returns {{page: number|null, maxPage: number, total: number|null}}
     */
    _parseResultCount(doc, perPage) {
        let result = { page: null, maxPage: null, total: null }
        let el = doc.querySelector("div.result-count")
        if (!el) return result

        let strongs = []
        for (let s of el.querySelectorAll("strong")) {
            let v = this._clean(s.text)
            if (v) strongs.push(v)
        }
        if (strongs.length >= 3) {
            result.page = parseInt(strongs[0], 10) || null
            result.maxPage = parseInt(strongs[1], 10) || null
            result.total = parseInt(strongs[2], 10) || null
        } else if (strongs.length > 0) {
            result.total = parseInt(strongs[strongs.length - 1], 10) || null
        }

        let text = this._clean(el.text)
        if (!result.maxPage || result.maxPage < 1) {
            let m = /\/\s*(\d+)\s*页/.exec(text)
            if (m) result.maxPage = parseInt(m[1], 10) || 1
        }
        if (result.total == null) {
            let m = /共(?:有|查找到)?\s*(\d+)\s*部/.exec(text)
            if (m) result.total = parseInt(m[1], 10)
        }
        // 兜底一：从分页器链接/页码文本里取最大页码（AspNetPager 等）
        if (result.maxPage == null) {
            let pages = []
            for (let pageEl of doc.querySelectorAll(".pager a, .pager span")) {
                let n = parseInt(this._clean(pageEl.text), 10)
                if (n > 0) pages.push(n)
            }
            if (pages.length > 0) result.maxPage = Math.max.apply(null, pages)
        }
        // 兜底二：搜索页只有 "共查找到 N 部" 时，用每页条数推算页数
        if (result.maxPage == null && result.total != null && perPage > 0) {
            result.maxPage = Math.max(1, Math.ceil(result.total / perPage))
        }
        if (!result.maxPage || result.maxPage < 1) result.maxPage = 1
        return result
    }

    // 分类列表页 ul#contList > li（每页 42 条，页面自带总页数）
    _parseListPage(doc, url) {
        let comics = []
        for (let li of doc.querySelectorAll("#contList > li")) {
            let comic = this._parseCard(li)
            if (comic) comics.push(comic)
        }
        let info = this._parseResultCount(doc, 42)
        if (comics.length === 0 && info.maxPage > 1) {
            throw `分类页解析失败: 未解析到任何漫画，但页面声明共 ${info.maxPage} 页 (${url})`
        }
        return { comics: comics, maxPage: info.maxPage }
    }

    /**
     * 分类页 URL 规则（夹具 list_japan.html 的筛选链接实测）
     * 条件顺序: 地区_题材_受众_进度；排序后缀 {sort}.html；翻页 {sort}_p{n}.html；
     * 默认排序 index 的第 1 页即目录本身（/list/japan/）
     * @param genre {string} 题材值（可空）
     * @param filters {{area?: string, age?: string, status?: string}}
     * @param sort {string} index/update/view/rate
     * @param page {number}
     */
    _listUrl(genre, filters, sort, page) {
        filters = filters || {}
        let tokens = [filters.area, genre, filters.age, filters.status]
        let parts = []
        for (let token of tokens) {
            let value = this._clean(token)
            if (value) parts.push(value)
        }
        let dir = parts.length > 0 ? `/list/${parts.join("_")}/` : "/list/"
        let sortKey = this._clean(sort) || "index"
        let pageNum = Number(page) || 1
        if (pageNum > 1) return `${this.baseUrl}${dir}${sortKey}_p${pageNum}.html`
        if (sortKey === "index") return `${this.baseUrl}${dir}`
        return `${this.baseUrl}${dir}${sortKey}.html`
    }

    /**
     * 搜索 URL 规则（夹具 search_ship.html 实测）
     * 排序: 默认 = 最新更新 / _o1 最近最热 / _o2 最新上架 / _o3 评分最高
     * 翻页: _p{n}（第 1 页不带后缀）
     * @param keyword {string}
     * @param type {string}
     * @param page {number}
     */
    _searchUrl(keyword, type, page) {
        let suffix = ""
        let sortKey = this._clean(type)
        if (sortKey && sortKey !== "0") suffix += `_o${sortKey}`
        let pageNum = Number(page) || 1
        if (pageNum > 1) suffix += `_p${pageNum}`
        return `${this.baseUrl}/s/${encodeURIComponent(this._clean(keyword))}${suffix}.html`
    }

    // ============================== 账号 ==============================

    account = {
        /**
         * 账号密码登录: 提交 /tools/submit_ajax.ashx?action=user_login
         * 成功响应里的 Set-Cookie my=... 即站点登录凭证，保存后由 _headers 统一携带
         */
        login: async (username, password) => {
            let url = `${this.baseUrl}/tools/submit_ajax.ashx?action=user_login`
            let headers = this._headers({
                referer: `${this.baseUrl}/user/login`,
                accept: "application/json, text/javascript, */*; q=0.01",
                xhr: true,
            })
            headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
            let body = `txtUserName=${encodeURIComponent(username)}&txtPassword=${encodeURIComponent(password)}`
            let res = await Network.post(url, headers, body)
            if (!res || res.status !== 200) {
                throw `登录失败: HTTP ${res && res.status != null ? res.status : "无响应"} (${url})`
            }
            let data = this._tryJson(res.body)
            if (data && data.status != null && String(data.status) !== "1") {
                throw `登录失败: ${this._clean(data.msg || data.message || res.body)} (${url})`
            }
            let my = this._myCookieFrom(res.headers)
            if (!my) {
                throw `登录失败: 响应未返回 my 凭证, 请检查账号密码 (${url})`
            }
            this.saveData("mhg_cookie", `my=${my}`)
            return "ok"
        },

        logout: () => {
            this.deleteData("mhg_cookie")
            Network.deleteCookies(this.baseUrl)
        },

        registerWebsite: "https://www.manhuagui.com/user/register",
    }

    // ============================== 探索 ==============================

    explore = [
        {
            title: "漫画柜",
            type: "multiPartPage",
            /**
             * 首页聚合: 热门更新 / 日周月总排行榜 / tab 板块 / 题材专区
             * @param page {number|null}
             */
            load: async (page) => {
                let url = this.baseUrl + "/"
                let doc = await this._fetchDoc(url)
                try {
                    let parts = []

                    // 1. 热门更新
                    let updateCont = doc.querySelector("div.update-cont")
                    if (updateCont) {
                        let comics = []
                        for (let li of updateCont.querySelectorAll("li")) {
                            let comic = this._parseCard(li)
                            if (comic) comics.push(comic)
                        }
                        if (comics.length > 0) parts.push({ title: "热门更新", comics: comics })
                    }

                    // 2. 排行榜（tab 与榜单容器按顺序配对）
                    let rankTabs = doc.querySelectorAll("#rankTab a")
                    let rankLists = doc.querySelectorAll("#rankCont > ul")
                    let rankCount = Math.min(rankTabs.length, rankLists.length)
                    for (let i = 0; i < rankCount; i++) {
                        let name = this._clean(rankTabs[i].text)
                        let comics = []
                        for (let li of rankLists[i].querySelectorAll("li")) {
                            let comic = this._parseRankItem(li)
                            if (comic) comics.push(comic)
                        }
                        if (comics.length > 0) parts.push({ title: `${name}排行榜`, comics: comics })
                    }

                    // 3. tab 板块（热门连载 / 经典完结 / 最新上架 / 2020新番）
                    let tabNames = doc.querySelectorAll("#cmt-tab li")
                    let tabLists = doc.querySelectorAll("#cmt-cont > ul")
                    let tabCount = Math.min(tabNames.length, tabLists.length)
                    for (let i = 0; i < tabCount; i++) {
                        let name = this._clean(tabNames[i].text)
                        let comics = []
                        for (let li of tabLists[i].querySelectorAll("li")) {
                            let comic = this._parseCard(li)
                            if (comic) comics.push(comic)
                        }
                        if (comics.length > 0) parts.push({ title: name, comics: comics })
                    }

                    // 4. 题材专区（每块含 热门连载 / 经典完结 两张榜）
                    for (let block of doc.querySelectorAll("div.idx-sc-cont")) {
                        let h4 = block.querySelector("h4")
                        let genreName = this._clean(h4 ? h4.text : "") || "题材"
                        let barNames = block.querySelectorAll("div.idx-sc-bar > ul > li")
                        let barLists = block.querySelectorAll("div.idx-sc-list > ul")
                        let barCount = Math.min(barNames.length, barLists.length)
                        for (let i = 0; i < barCount; i++) {
                            let label = this._clean(barNames[i].text)
                            let comics = []
                            for (let li of barLists[i].querySelectorAll("li")) {
                                let comic = this._parseRankItem(li)
                                if (comic) comics.push(comic)
                            }
                            if (comics.length === 0) continue
                            parts.push({
                                title: label ? `${genreName} · ${label}` : genreName,
                                comics: comics,
                            })
                        }
                    }

                    if (parts.length === 0) {
                        throw `首页解析失败: 未解析到任何板块 (${url})`
                    }
                    return parts
                } finally {
                    doc.dispose()
                }
            },
            loadNext(next) { },
        },
        {
            title: "每日更新",
            type: "multiPartPage",
            /**
             * /update/ 最近 7 天更新，按日期分组。
             * 单日可达 150+ 部，页面只做预览（每组取前 60 部），完整列表走分类页
             */
            load: async (page) => {
                let url = `${this.baseUrl}/update/`
                let doc = await this._fetchDoc(url)
                try {
                    let parts = []
                    for (let list of doc.querySelectorAll("div.latest-list")) {
                        let header = list.previousElementSibling
                        let strong = header ? header.querySelector("strong") : null
                        let dateText = this._clean(strong ? strong.text : "")
                        let m = /(\d{4}-\d{2}-\d{2})/.exec(dateText)
                        let title = m ? m[1] : (dateText || "最近更新")
                        let comics = []
                        for (let li of list.querySelectorAll("li")) {
                            if (comics.length >= 60) break
                            let comic = this._parseCard(li)
                            if (comic) comics.push(comic)
                        }
                        if (comics.length > 0) parts.push({ title: title, comics: comics })
                    }
                    if (parts.length === 0) {
                        throw `每日更新解析失败: 未找到 div.latest-list (${url})`
                    }
                    return parts
                } finally {
                    doc.dispose()
                }
            },
        },
        {
            title: "排行榜",
            type: "multiPartPage",
            // /rank/ 日/周/月/总 四张榜单（每张 50 名，无翻页）
            load: async (page) => {
                let sections = [
                    ["日排行", "/rank/"],
                    ["周排行", "/rank/week.html"],
                    ["月排行", "/rank/month.html"],
                    ["总排行", "/rank/total.html"],
                ]
                let parts = []
                for (let section of sections) {
                    let url = this.baseUrl + section[1]
                    let doc = await this._fetchDoc(url)
                    try {
                        let comics = this._parseRankTable(doc)
                        if (comics.length > 0) parts.push({ title: section[0], comics: comics })
                    } finally {
                        doc.dispose()
                    }
                }
                if (parts.length === 0) {
                    throw `排行榜解析失败: 未解析到任何排名 (${this.baseUrl}/rank/)`
                }
                return parts
            },
        },
        {
            title: "分类",
            type: "multiPartPage",
            // /list/ 分类页：地区 / 题材 / 进度 各取一页（每页 42 条，只展示前 30 条）
            load: async (page) => {
                let sections = [
                    ["日本漫画", "/list/japan/"],
                    ["热血", "/list/rexue/"],
                    ["连载中", "/list/lianzai/"],
                ]
                let parts = []
                for (let section of sections) {
                    let url = this.baseUrl + section[1]
                    let doc = await this._fetchDoc(url)
                    try {
                        let comics = []
                        for (let li of doc.querySelectorAll("#contList > li")) {
                            if (comics.length >= 30) break
                            let comic = this._parseCard(li)
                            if (comic) comics.push(comic)
                        }
                        if (comics.length > 0) parts.push({ title: section[0], comics: comics })
                    } finally {
                        doc.dispose()
                    }
                }
                if (parts.length === 0) {
                    throw `分类页解析失败: 未解析到任何漫画 (${this.baseUrl}/list/)`
                }
                return parts
            },
        },
    ]

    // ============================== 分类 ==============================

    category = {
        title: "漫画柜",
        parts: [
            {
                name: "题材",
                type: "fixed",
                itemType: "category",
                categories: ["全部"].concat(ManHuaGui.GENRES.map((g) => g[1])),
                categoryParams: [""].concat(ManHuaGui.GENRES.map((g) => g[0])),
            },
        ],
        // 榜单页 /rank/（日/周/月/总）
        enableRankingPage: true,
    }

    categoryComics = {
        /**
         * 分类列表 + 筛选 + 分页
         * @param category {string} 题材中文名（来自 category.parts[0].categories）
         * @param param {string?} 题材值（rexue/...，来自 categoryParams）
         * @param options {string[]} [地区, 受众, 进度, 排序]
         * @param page {number}
         * @returns {Promise<{comics: Comic[], maxPage: number}>}
         */
        load: async (category, param, options, page) => {
            options = options || []
            let url = this._listUrl(param, {
                area: options[0] || "",
                age: options[1] || "",
                status: options[2] || "",
            }, options[3] || "index", page)

            let doc = await this._fetchDoc(url)
            try {
                return this._parseListPage(doc, url)
            } finally {
                doc.dispose()
            }
        },

        optionList: [
            {
                label: "地区",
                options: ["-全部"].concat(ManHuaGui.AREAS.map((a) => `${a[0]}-${a[1]}`)),
            },
            {
                label: "受众",
                options: ["-全部"].concat(ManHuaGui.AGES.map((a) => `${a[0]}-${a[1]}`)),
            },
            {
                label: "进度",
                options: ["-全部"].concat(ManHuaGui.PROGRESS.map((a) => `${a[0]}-${a[1]}`)),
            },
            {
                label: "排序",
                options: ManHuaGui.SORTS.map((a) => `${a[0]}-${a[1]}`),
            },
        ],

        ranking: {
            // 站点榜单: /rank/、/rank/week.html、/rank/month.html、/rank/total.html（均无翻页）
            options: [
                "-日排行",
                "week-周排行",
                "month-月排行",
                "total-总排行",
            ],
            /**
             * @param option {string} 榜单值（空或 day = 日排行）
             * @param page {number}
             * @returns {Promise<{comics: Comic[], maxPage: number}>}
             */
            load: async (option, page) => {
                let key = this._clean(option)
                let path = (!key || key === "day") ? "/rank/" : `/rank/${key}.html`
                let url = this.baseUrl + path
                let doc = await this._fetchDoc(url)
                try {
                    let comics = this._parseRankTable(doc)
                    if (comics.length === 0) {
                        throw `排行榜解析失败: 未解析到排名行 (${url})`
                    }
                    return { comics: comics, maxPage: 1 }
                } finally {
                    doc.dispose()
                }
            },
        },
    }

    // ============================== 搜索 ==============================

    search = {
        /**
         * @param keyword {string}
         * @param options {string[]} [排序值]
         * @param page {number}
         * @returns {Promise<{comics: Comic[], maxPage: number}>}
         */
        load: async (keyword, options, page) => {
            let kw = this._clean(keyword)
            if (!kw) throw "搜索关键词为空"

            options = options || []
            let type = options[0] ? String(options[0]).split("-")[0] : "0"
            let url = this._searchUrl(kw, type, page)
            let doc = await this._fetchDoc(url, { referer: `${this.baseUrl}/` })
            try {
                let comics = []
                for (let li of doc.querySelectorAll("div.book-result li")) {
                    let comic = this._parseSearchItem(li)
                    if (comic) comics.push(comic)
                }
                let info = this._parseResultCount(doc, 10)
                if (comics.length === 0) {
                    if (doc.querySelector("div.result-count")) {
                        throw `搜索页解析失败: 声明有结果但未解析到任何漫画 (${url})`
                    }
                    // 页面没有结果统计 = 无结果
                    return { comics: [], maxPage: 1 }
                }
                return { comics: comics, maxPage: info.maxPage }
            } finally {
                doc.dispose()
            }
        },

        optionList: [
            {
                type: "select",
                label: "排序",
                options: [
                    "0-最新更新",
                    "1-最近最热",
                    "2-最新上架",
                    "3-评分最高",
                ],
            },
        ],

        enableTagsSuggestions: false,
    }

    // ============================== 详情 / 阅读 ==============================

    comic = {
        /**
         * 详情页 /comic/{id}/
         * @param id {string}
         * @returns {Promise<ComicDetails>}
         */
        loadInfo: async (id) => {
            let comicId = this._toComicId(id)
            let url = `${this.baseUrl}/comic/${comicId}/`
            let doc = await this._fetchDoc(url)
            try {
                let book = doc.querySelector("div.book-cont")
                if (!book) {
                    throw `详情页解析失败: 未找到 div.book-cont (${url})`
                }

                let titleEl = book.querySelector("div.book-title h1")
                let title = this._clean(titleEl ? titleEl.text : "")
                if (!title) {
                    throw `详情页解析失败: 标题为空 (${url})`
                }
                let subEl = book.querySelector("div.book-title h2")
                let subtitle = this._clean(subEl ? subEl.text : "")

                let imgEl = book.querySelector("p.hcover img") || book.querySelector("div.book-cover img")
                let cover = imgEl ? this._abs(imgEl.attributes["src"] || imgEl.attributes["data-src"]) : ""
                if (!cover) cover = this.coverUrl(comicId)

                // 简介
                let introParts = []
                for (let p of doc.querySelectorAll("#intro-all p")) {
                    let text = this._clean(p.text)
                    if (text) introParts.push(text)
                }
                let description = introParts.join("\n")

                // 标签: ul.detail-list > li > span > strong（标签名）+ a（标签值）
                let tags = new Map()
                for (let span of doc.querySelectorAll("ul.detail-list > li > span")) {
                    let strong = span.querySelector("strong")
                    let label = this._clean(strong ? strong.text : "").replace(/[:：]\s*$/, "")
                    if (!label) continue
                    let tagKey = ManHuaGui.TAG_KEYS[label]
                    if (!tagKey) continue
                    let values = []
                    for (let a of span.querySelectorAll("a")) {
                        let value = this._clean(a.text)
                        if (value) values.push(value)
                    }
                    if (values.length === 0) {
                        let raw = this._clean(span.text).replace(label, "").replace(/^[:：]\s*/, "")
                        if (raw && raw !== "暂无") values.push(raw)
                    }
                    if (values.length > 0) tags.set(tagKey, values)
                }

                // 状态 + 最近更新时间（li.status > span > span.red[0]=状态, span.red[1]=日期）
                let updateTime = ""
                let statusCell = doc.querySelector("ul.detail-list li.status > span")
                if (statusCell) {
                    let reds = statusCell.querySelectorAll("span.red")
                    let statusText = reds.length > 0 ? this._clean(reds[0].text) : ""
                    if (reds.length > 1) updateTime = this._clean(reds[1].text)
                    if (!updateTime) {
                        let m = /(\d{4}-\d{2}-\d{2})/.exec(this._clean(statusCell.text))
                        if (m) updateTime = m[1]
                    }
                    if (statusText) tags.set("状态", [statusText])
                }

                // 章节
                let chapters = this._parseChapters(doc)
                if (chapters.size === 0) {
                    throw `详情页解析失败: 章节列表为空 (${url})`
                }

                // 相关漫画
                let recommend = []
                for (let li of doc.querySelectorAll("ul.similar-list li")) {
                    let comic = this._parseCard(li)
                    if (comic) recommend.push(comic)
                }

                return new ComicDetails({
                    title: title,
                    subtitle: subtitle,
                    cover: cover,
                    description: description,
                    tags: tags,
                    chapters: chapters,
                    updateTime: updateTime,
                    recommend: recommend,
                    url: url,
                })
            } finally {
                doc.dispose()
            }
        },

        /**
         * 章节图片
         * @param comicId {string}
         * @param epId {string?} 章节 ID（可传 /comic/id/ep.html 链接）；为空时取详情页第一章
         * @returns {Promise<{images: string[]}>}
         */
        loadEp: async (comicId, epId) => {
            let comic = this._toComicId(comicId)
            let ep = this._clean(epId || "")
            if (!ep) {
                // 未指定章节: 用详情页中章节号最小的一话兜底
                let info = await this.comic.loadInfo(comic)
                let first = null
                for (let item of info.chapters) {
                    for (let entry of item[1]) {
                        if (first === null || Number(entry[0]) < Number(first)) first = entry[0]
                    }
                }
                if (!first) {
                    throw `未指定章节且详情页没有章节 (comic ${comic})`
                }
                ep = first
            }
            let epNum = this._epId(ep) || this._clean(ep)
            if (!/^\d+$/.test(epNum)) {
                throw `无法识别的章节 ID: ${epId}`
            }

            let url = `${this.baseUrl}/comic/${comic}/${epNum}.html`
            let res = await this._get(url, { referer: `${this.baseUrl}/comic/${comic}/` })
            let images = this._chapterImages(res.body, url)
            if (images.length === 0) {
                throw `章节图片解析失败: 未取得任何图片 (${url})`
            }
            return { images: images }
        },

        /**
         * 图片请求头: 站点图床要求带 Referer（匿名可访问）
         */
        onImageLoad: (url, comicId, epId) => {
            let headers = {
                "Referer": this.baseUrl + "/",
                "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7",
                "User-Agent": ManHuaGui.UA,
            }
            let cookie = this._cookie()
            if (cookie) headers["Cookie"] = cookie
            return { headers: headers }
        },

        onThumbnailLoad: (url) => {
            let headers = {
                "Referer": this.baseUrl + "/",
                "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7",
                "User-Agent": ManHuaGui.UA,
            }
            let cookie = this._cookie()
            if (cookie) headers["Cookie"] = cookie
            return { headers: headers }
        },

        /**
         * 评论列表（站点 JSON 接口, 每页 10 条）
         * @param comicId {string}
         * @param subId {string?} 站点只提供书籍级评论，忽略
         * @param page {number}
         * @param replyTo {string?} 回复目标（本站生成的 "{commentId}//{page}"）
         * @returns {Promise<{comments: Comment[], maxPage: number}>}
         */
        loadComments: async (comicId, subId, page, replyTo) => {
            let id = this._toComicId(comicId)
            let target = replyTo ? this._parseCommentTarget(replyTo) : null
            let pageNum = Number(target ? target.page : page) || 1

            let url = `${this.baseUrl}/tools/submit_ajax.ashx?action=comment_list` +
                `&book_id=${id}&page_index=${pageNum}`
            let data = await this._fetchJson(url, {
                referer: `${this.baseUrl}/comic/${id}/`,
                accept: "application/json, text/javascript, */*; q=0.01",
                xhr: true,
            })
            let threads = this._parseCommentData(data)

            if (target) {
                let list = threads.children.get(target.id) || []
                let replies = []
                for (let childId of list) {
                    let entry = threads.comments[childId]
                    if (!entry) continue
                    let parentId = threads.parent.get(childId)
                    let parentEntry = parentId ? threads.comments[parentId] : null
                    replies.push(this._buildComment(entry, pageNum, {
                        replyToName: parentEntry ? (this._clean(parentEntry.user_name) || "匿名用户") : "",
                    }))
                }
                return { comments: replies, maxPage: 1 }
            }

            let comments = []
            for (let rootId of threads.roots) {
                let entry = threads.comments[rootId]
                if (!entry) continue
                let replyCount = entry.reply_count != null
                    ? Number(entry.reply_count) || 0
                    : (threads.children.get(rootId) || []).length
                comments.push(this._buildComment(entry, pageNum, { replyCount: replyCount }))
            }
            let total = Number(data && data.total) || 0
            let maxPage = total > 0 ? Math.max(1, Math.ceil(total / 10)) : 1
            return { comments: comments, maxPage: maxPage }
        },

        /**
         * 发表评论（站点对内容做了两次 URL 编码，保持一致）
         * @param comicId {string}
         * @param subId {string?}
         * @param content {string}
         * @param replyTo {string?}
         */
        sendComment: async (comicId, subId, content, replyTo) => {
            let id = this._toComicId(comicId)
            let cookie = this._cookie()
            if (!cookie) throw "请先登录漫画柜账号"

            let url = `${this.baseUrl}/tools/submit_ajax.ashx?action=comment_add`
            let headers = this._headers({
                referer: `${this.baseUrl}/comic/${id}/`,
                accept: "application/json, text/javascript, */*; q=0.01",
                xhr: true,
            })
            headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
            headers["Origin"] = this.baseUrl

            let toCommentId = "0"
            if (replyTo) {
                toCommentId = this._parseCommentTarget(replyTo).id
            }
            let body = `book_id=${encodeURIComponent(id)}` +
                `&txtContent=${encodeURIComponent(encodeURIComponent(content))}` +
                `&to_comment_id=${encodeURIComponent(toCommentId)}`

            let res = await Network.post(url, headers, body)
            if (!res || res.status === 401) throw "Login expired"
            if (res.status !== 200) {
                throw `发送评论失败: HTTP ${res.status} (${url})`
            }
            let data = this._tryJson(res.body)
            if (data && data.status != null && String(data.status) !== "1") {
                throw `发送评论失败: ${this._clean(data.msg || res.body)}`
            }
            return "ok"
        },

        // 标签点击: 作者走搜索，题材走分类页
        onClickTag: (namespace, tag) => {
            let value = this._clean(tag)
            if (!value) return null
            if (namespace === "作者") {
                return { page: "search", keyword: value }
            }
            if (namespace === "类型") {
                let slug = null
                for (let genre of ManHuaGui.GENRES) {
                    if (genre[1] === value) slug = genre[0]
                }
                if (slug) {
                    return {
                        page: "category",
                        attributes: { category: value, param: slug },
                    }
                }
            }
            return { page: "search", keyword: value }
        },

        idMatch: "^\\d{1,10}$",

        link: {
            domains: [
                "manhuagui.com", "www.manhuagui.com", "m.manhuagui.com",
                "mhgui.com", "cf.mhgui.com",
            ],
            linkToId: (url) => {
                let text = String(url == null ? "" : url)
                let m = /\/comic\/(\d+)/.exec(text)
                if (m) return m[1]
                let m2 = /^\s*(\d{1,10})\s*$/.exec(text)
                return m2 ? m2[1] : null
            },
        },

        enableTagsTranslate: false,
    }

    // ============================== 章节 / 评论解析工具 ==============================
    // 说明: comic 对象里的函数都是箭头函数（this 指向源实例），因此这些工具必须挂在原型上，
    // 才能被 comic 内部的 this._<方法>(...) 正常调用。

    /**
     * 章节列表: div.chapter 下的 h4（分组名）与其后的 div.chapter-list
     * - 一个 chapter-list 可能含多个 ul（"卷/话" tab 切换），需全部收集
     * - div.chapter-page 是 "单话" 分组的分页按钮（href=javascript:;），解析时自动跳过
     * @param doc {HtmlDocument}
     * @returns {Map<string, Map<string, string>>} 分组名 -> (章节 ID -> 章节标题)
     */
    _parseChapters(doc) {
        let result = new Map()
        let chapter = doc.querySelector("div.chapter")
        if (!chapter) return result

        let entries = []
        let groupName = ""
        for (let child of chapter.children) {
            let classes = child.classNames || []
            if (child.localName === "h4") {
                groupName = this._clean(child.text)
                continue
            }
            let isList = classes.indexOf("chapter-list") >= 0
            let isPaged = classes.indexOf("chapter-page") >= 0
            if (!isList && !isPaged) continue
            for (let a of child.querySelectorAll("li a")) {
                let epId = this._epId(a.attributes["href"] || "")
                if (!epId) continue
                let title = this._clean(a.attributes["title"] || "")
                if (!title) {
                    let span = a.querySelector("span")
                    title = this._clean(span ? span.text : a.text)
                }
                entries.push({
                    group: groupName || (isPaged ? "单话" : "章节"),
                    id: epId,
                    title: title || epId,
                })
            }
        }

        // 兜底: 页面结构变化时直接扫描章节链接（javascript:; 的分页按钮不会命中 _epId）
        if (entries.length === 0) {
            for (let a of chapter.querySelectorAll("a")) {
                let epId = this._epId(a.attributes["href"] || "")
                if (!epId) continue
                entries.push({
                    group: "章节",
                    id: epId,
                    title: this._clean(a.attributes["title"] || "") || epId,
                })
            }
        }

        // 同一章节可能出现在多个 tab 列表里，用 Map 去重
        let grouped = new Map()
        for (let entry of entries) {
            if (!grouped.has(entry.group)) grouped.set(entry.group, new Map())
            grouped.get(entry.group).set(entry.id, entry.title)
        }
        for (let item of grouped) {
            let sorted = Array.from(item[1].entries()).sort((a, b) => Number(a[0]) - Number(b[0]))
            result.set(item[0], new Map(sorted))
        }
        return result
    }

    /**
     * 章节页图片数据解析（packer 混淆脚本）
     * 1. 正则取出 }('PACKED', a, c, 'BASE64'['\x73\x70\x6c\x69\x63']('\x7c'),0,{}))
     * 2. k = LZString.decompressFromBase64(BASE64).split('|')
     * 3. Dean Edwards packer 反混淆（base62 词元替换，a/c 由脚本给出）
     * 4. 取第一个平衡花括号 JSON（SMH.imgData({...})）
     * 5. 图片 URL = 图片域名 + path + file + ?e={sl.e}&m={sl.m}
     * @param html {string} 章节页 HTML
     * @param url {string} 章节页 URL（用于错误信息）
     * @returns {string[]}
     */
    _chapterImages(html, url) {
        let pattern = /\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\[\s*'\\x73\\x70\\x6c\\x69\\x63'\]\('\\x7c'\),0,\{\}\)/
        let m = pattern.exec(String(html == null ? "" : html))
        if (!m) {
            throw `章节脚本未找到 (packer 正则未匹配, 可能站点已改版) (${url})`
        }

        let decoded = this.LZString.decompressFromBase64(m[4])
        if (!decoded) {
            throw `章节脚本字典解压失败 (lz-string) (${url})`
        }
        let unpacked = this._unpackPacker(m[1], parseInt(m[2], 10), parseInt(m[3], 10), decoded.split("|"))
        let jsonText = this._firstBalancedJson(unpacked)
        if (!jsonText) {
            throw `章节脚本未包含图片数据对象 (${url})`
        }
        let data = this._tryJson(jsonText)
        if (!data) {
            throw `章节图片数据不是合法 JSON (${url})`
        }

        let files = data.files || []
        let path = data.path || ""
        let sl = data.sl || {}
        let query = ""
        if (sl.e != null && sl.m != null) {
            query = `?e=${sl.e}&m=${sl.m}`
        }
        let images = []
        for (let file of files) {
            if (!file) continue
            images.push(ManHuaGui.IMAGE_HOSTS[0] + path + file + query)
        }
        return images
    }

    /**
     * Dean Edwards packer 反混淆: 把 base62 词元替换回字典词
     * （与站点脚本内置的 e(c) 生成规则一致，词元随 a 变化）
     * @param packed {string}
     * @param a {number}
     * @param c {number}
     * @param dict {string[]}
     * @returns {string}
     */
    _unpackPacker(packed, a, c, dict) {
        let e = (n) => (n < a ? "" : e(parseInt(n / a))) +
            ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36))
        let out = packed
        while (c--) {
            if (dict[c]) {
                out = out.replace(new RegExp("\\b" + e(c) + "\\b", "g"), dict[c])
            }
        }
        return out
    }

    // 取文本中第一个平衡花括号对象（字符串内的花括号不计入）
    _firstBalancedJson(text) {
        let start = String(text == null ? "" : text).indexOf("{")
        if (start < 0) return null
        let depth = 0
        let inString = false
        let escaped = false
        for (let i = start; i < text.length; i++) {
            let ch = text[i]
            if (inString) {
                if (escaped) escaped = false
                else if (ch === "\\") escaped = true
                else if (ch === '"') inString = false
                continue
            }
            if (ch === '"') {
                inString = true
            } else if (ch === "{") {
                depth++
            } else if (ch === "}") {
                depth--
                if (depth === 0) return text.slice(start, i + 1)
            }
        }
        return null
    }

    /**
     * 还原评论链
     * commentIds 每项形如 "叶子,...,根"（根评论在最后；单项即根评论），
     * 因此 children[根] = 直接回复，parent[回复] = 上一层评论
     * @param data {any} 接口返回的 JSON
     * @returns {{comments: {}, parent: Map<string,string>, children: Map<string,string[]>, roots: string[]}}
     */
    _parseCommentData(data) {
        let comments = (data && data.comments) ? data.comments : {}
        let raw = (data && data.commentIds) ? data.commentIds : []

        let parent = new Map()
        let children = new Map()
        let isReply = new Set()
        let roots = []
        let seenRoot = new Set()

        for (let item of raw) {
            let parts = String(item == null ? "" : item).split(",")
            let chain = []
            for (let part of parts) {
                let value = this._clean(part)
                if (value) chain.push(value)
            }
            if (chain.length === 0) continue

            let root = chain[chain.length - 1]
            if (!seenRoot.has(root)) {
                seenRoot.add(root)
                roots.push(root)
            }
            for (let i = 0; i < chain.length - 1; i++) {
                let childId = chain[i]
                let parentId = chain[i + 1]
                isReply.add(childId)
                if (!parent.has(childId)) parent.set(childId, parentId)
                let list = children.get(parentId)
                if (!list) {
                    list = []
                    children.set(parentId, list)
                }
                if (list.indexOf(childId) < 0) list.push(childId)
            }
        }

        // 兜底: commentIds 未列出的评论（既不是根也不是回复）按主评论处理
        for (let key of Object.keys(comments)) {
            if (!seenRoot.has(key) && !isReply.has(key)) {
                seenRoot.add(key)
                roots.push(key)
            }
        }

        // 直接回复按时间升序，与站点展示一致
        for (let item of children) {
            item[1].sort((a, b) => {
                let ta = this._clean(comments[a] ? comments[a].add_time : "")
                let tb = this._clean(comments[b] ? comments[b].add_time : "")
                if (ta === tb) return 0
                return ta < tb ? -1 : 1
            })
        }
        return { comments: comments, parent: parent, children: children, roots: roots }
    }

    // 组装 Comment 对象；id 带分页信息，便于加载该主评论的回复
    _buildComment(entry, page, options) {
        options = options || {}
        let id = this._clean(entry.id != null ? entry.id : "")
        let userName = this._clean(entry.user_name) || "匿名用户"
        if (options.replyToName) {
            userName = `${userName} ☞ ${options.replyToName}`
        }
        let avatar = this._clean(entry.avatar)
        return new Comment({
            id: id ? `${id}//${page}` : null,
            userName: userName,
            avatar: avatar ? this._abs(avatar) : null,
            content: entry.content ? String(entry.content) : "（评论内容为空）",
            time: this._clean(entry.add_time),
            replyCount: options.replyCount || 0,
        })
    }

    // "{commentId}//{page}" → {id, page}
    _parseCommentTarget(replyTo) {
        let raw = String(replyTo == null ? "" : replyTo)
        let index = raw.indexOf("//")
        if (index < 0) return { id: raw, page: 1 }
        return {
            id: raw.slice(0, index),
            page: Number(raw.slice(index + 2)) || 1,
        }
    }

    // ============================== 收藏（书架） ==============================
    // 站点书架 /user/book/shelf/{page} 需要登录 Cookie，匿名抓取只能拿到登录页，
    // 因此这部分没有纳入 _analysis/test/harness_manhuagui.js 的离线回归（选择器沿用站点书架结构）。
    favorites = {
        multiFolder: false,

        /**
         * 书架列表
         * @param page {number}
         * @param folder {string?} 站点只有单个书架，忽略
         * @returns {Promise<{comics: Comic[], maxPage: number}>}
         */
        loadComics: async (page, folder) => {
            let cookie = this._cookie()
            if (!cookie) throw "请先登录漫画柜账号"

            let url = `${this.baseUrl}/user/book/shelf/${Number(page) || 1}`
            let doc = await this._fetchDoc(url, { referer: `${this.baseUrl}/` })
            try {
                let comics = []
                for (let item of doc.querySelectorAll("div.dy_content_li")) {
                    let link = item.querySelector("div.dy_img > a") || item.querySelector("a")
                    if (!link) continue
                    let id = this._comicId(link.attributes["href"])
                    if (!id) continue

                    let img = link.querySelector("img") || item.querySelector("img")
                    let cover = img ? this._abs(img.attributes["src"] || img.attributes["data-src"]) : ""
                    if (!cover) cover = this.coverUrl(id)

                    let title = ""
                    let latest = ""
                    let updateDate = ""
                    let lastRead = ""
                    let lastReadDate = ""

                    let info = item.querySelector("div.dy_r")
                    if (info) {
                        let h3 = info.querySelector("h3 a")
                        title = this._clean(h3 ? h3.text : "")
                        let paragraphs = info.querySelectorAll("p")
                        if (paragraphs.length > 0) {
                            let ems = paragraphs[0].querySelectorAll("em")
                            if (ems.length > 0) {
                                let chapterLink = ems[0].querySelector("a")
                                latest = this._clean(chapterLink ? chapterLink.text : "")
                                updateDate = ems.length > 1 ? this._clean(ems[1].text) : ""
                            }
                        }
                        if (paragraphs.length > 1) {
                            let ems = paragraphs[1].querySelectorAll("em")
                            if (ems.length > 0) {
                                let chapterLink = ems[0].querySelector("a")
                                lastRead = this._clean(chapterLink ? chapterLink.text : "")
                                lastReadDate = ems.length > 1 ? this._clean(ems[1].text) : ""
                            }
                        }
                    }
                    if (!title) title = this._clean(link.attributes["title"] || link.text) || id

                    let tags = []
                    if (latest) tags.push(`更新：${latest}`)
                    if (updateDate) tags.push(`更新日期：${updateDate}`)
                    if (lastRead) tags.push(`最近阅读：${lastRead}`)
                    if (lastReadDate) tags.push(`最近阅读时间：${lastReadDate}`)

                    comics.push(new Comic({
                        id: id,
                        title: title,
                        subtitle: latest,
                        cover: cover,
                        tags: tags,
                        description: lastRead ? `最近阅读至 ${lastRead}` : "",
                    }))
                }

                // 页码: 优先 "共 N 记录"，否则取分页按钮最大页码
                let maxPage = 1
                let recordInfo = doc.querySelector("div.flickr.right span")
                let totalText = recordInfo ? this._clean(recordInfo.text) : ""
                let m = /共\s*(\d+)\s*记录/.exec(totalText)
                if (m) {
                    maxPage = Math.max(1, Math.ceil(parseInt(m[1], 10) / 20))
                } else {
                    for (let a of doc.querySelectorAll("div.page-btns a")) {
                        let num = parseInt(this._clean(a.text), 10)
                        if (!isNaN(num) && num > maxPage) maxPage = num
                    }
                }
                return { comics: comics, maxPage: maxPage }
            } finally {
                doc.dispose()
            }
        },

        /**
         * 加入书架（站点没有单独的"取消收藏"接口，取消请在书架页面操作）
         * @param comicId {string}
         * @param folderId {string?}
         * @param isAdding {boolean}
         * @param favoriteId {string?}
         */
        addOrDelFavorite: async (comicId, folderId, isAdding, favoriteId) => {
            if (!isAdding) throw "漫画柜不支持在源内取消收藏，请到书架页面操作"
            let id = this._toComicId(comicId)
            let cookie = this._cookie()
            if (!cookie) throw "请先登录漫画柜账号"

            let url = `${this.baseUrl}/tools/submit_ajax.ashx?action=user_book_shelf_add`
            let headers = this._headers({
                referer: `${this.baseUrl}/comic/${id}/`,
                accept: "application/json, text/javascript, */*; q=0.01",
                xhr: true,
            })
            headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"

            let res = await Network.post(url, headers, `book_id=${encodeURIComponent(id)}`)
            if (!res || res.status === 401) throw "Login expired"
            if (res.status !== 200) {
                throw `添加收藏失败: HTTP ${res.status} (${url})`
            }
            let data = this._tryJson(res.body)
            if (data && data.state !== true && String(data.state) !== "1") {
                throw `添加收藏失败: ${this._clean(data.msg || res.body)}`
            }
            return "ok"
        },
    }
}
