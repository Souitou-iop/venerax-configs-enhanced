/** @type {import('./_venera_.js')} */

// ============================================================
// 嬉皮漫画 (HiPi Manga) - https://m.hipmh.com
//
// 逆向要点:
//   - 站点为 Astro SSR, 数据来自独立 API 主机(无 Cloudflare 挑战):
//       https://hipapi1.s3file.top/v1/... (列表/详情/章节)
//       https://hipapi1.s3file.top/v2/chapter (章节图片, 密文)
//   - 漫画 id: /works/{b64url("m:{id}")}-{slug}-{外部id}
//     如 bToyMzQ3NQ-yi-ren-zhi-xia-tencent-531490-17793
//   - 章节 hid: b64url("m:{mid}-c:{cid}")-b64url("{mid}:{版本}")
//     图片接口需要 b64url("c:{cid}")-... 形式, 需要转换
//   - 图片密文解密: qM9 前缀 + Z7 后缀, 分段重排 -> 字符替换 ->
//     7字符分块隔块反转 -> base64url -> UTF-8 JSON
//   - 解密后含一张"陷阱图", 需按 order_id/sid 计算位置移除
// ============================================================

class HiPiManga extends ComicSource {
    // 名称
    name = "嬉皮漫画"

    // 唯一标识
    key = "hipmh"

    version = "1.0.1"

    minAppVersion = "1.0.0"

    // 更新地址
    url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/hipmh.js"

    // 常量
    static apiBase = "https://hipapi1.s3file.top"
    static coverBase = "https://cover.s3imgs.top"
    static imgBaseTx = "https://hip-tx-1.s3imgs.top"
    static imgBaseCf = "https://hip-cf-1.s3imgs.top"
    static imgBaseTxS = "https://hip-tx-s1.s3imgs.top"
    static Mobile_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
    static webHeaders = {
        "User-Agent": HiPiManga.Mobile_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    static jsonHeaders = {
        "User-Agent": HiPiManga.Mobile_UA,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/json",
    }

    // ---------- 工具函数 ----------

    // base64url 解码为 utf-8 字符串
    static b64urlDecode(str) {
        let s = String(str || "").replace(/-/g, "+").replace(/_/g, "/")
        s += "=".repeat((4 - (s.length % 4)) % 4)
        return Convert.decodeUtf8(Convert.decodeBase64(s))
    }

    // utf-8 字符串编码为 base64url
    static b64urlEncode(str) {
        return Convert.encodeBase64(Convert.encodeUtf8(str))
            .replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
    }

    // 从 b64 mid 解析数字 id: "bToyMzQ3NQ" -> "23475"
    static midToNumeric(b64mid) {
        return HiPiManga.b64urlDecode(b64mid).replace(/^m:/, "")
    }

    // 前端章节 hid -> 图片接口需要的 api hid
    // 前端: b64url("m:{mid}-c:{cid}")-{tail} -> 接口: b64url("c:{cid}")-{tail}
    static toApiHid(hid) {
        const sep = String(hid || "").lastIndexOf("-")
        if (sep <= 0) return hid
        const m = HiPiManga.b64urlDecode(hid.substring(0, sep)).match(/^m:(\d+)-c:(\d+)$/)
        if (!m) return hid
        return HiPiManga.b64urlEncode("c:" + m[2]) + hid.substring(sep)
    }

    // 封面地址补全
    static coverUrl(url) {
        if (!url) return ""
        return url.startsWith("http") ? url : HiPiManga.coverBase + url
    }

    // 带重试的 GET 请求 (网络抖动时自动重试)
    static async getWithRetry(url, headers, retries = 2) {
        let lastError
        for (let i = 0; i <= retries; i++) {
            try {
                const res = await Network.get(url, headers)
                if (res.status === 200) return res
                lastError = `HTTP ${res.status}`
            } catch (e) {
                lastError = e.message || String(e)
            }
            if (i < retries) {
                await new Promise(resolve => setTimeout(resolve, 600 * (i + 1)))
            }
        }
        throw lastError
    }

    // 章节图片密文解密 (与站点 chapter-decoder.js 算法一致)
    static decodeChapterImages(enc) {
        if (typeof enc !== "string" || !enc.startsWith("qM9") || !enc.includes("Z7")) {
            return []
        }
        const mid = enc.slice(3, -2)                       // 去掉 qM9 前缀和 Z7 后缀
        const total = mid.length - 2 - 3                   // 去掉 "Vx" 与 "pL0" 两个标记
        const seg3Len = Math.floor(total / 3)              // 尾段长度
        const seg1Len = Math.floor((total - seg3Len) / 2)  // 头段长度
        const seg2Len = total - seg3Len - seg1Len          // 中段长度
        const seg1 = mid.substring(0, seg1Len)
        const seg2 = mid.substring(seg1Len + 2, seg1Len + 2 + seg2Len)
        const seg3 = mid.substring(seg1Len + 2 + seg2Len + 3)
        const data = seg3 + seg1 + seg2                    // 重排: 尾段 + 头段 + 中段

        // 字符替换: 自定义字母表 -> base64url 字母表
        const custom = "_-9876543210abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        let subbed = ""
        for (let i = 0; i < data.length; i++) {
            subbed += alpha[custom.indexOf(data[i])]
        }
        // 7 字符一块, 奇数块反转
        let chunked = ""
        for (let i = 0, ci = 0; i < subbed.length; i += 7, ci++) {
            const chunk = subbed.slice(i, i + 7)
            chunked += ci % 2 ? chunk.split("").reverse().join("") : chunk
        }
        // base64url -> json
        const padded = chunked.replace(/-/g, "+").replace(/_/g, "/") +
            "=".repeat((4 - (chunked.length % 4)) % 4)
        return JSON.parse(Convert.decodeUtf8(Convert.decodeBase64(padded)))
    }

    // 移除解密结果中的"陷阱图" (与站点 H() 算法一致, 无需 BigInt)
    static removeTrapImage(images, orderId, sid) {
        if (!Array.isArray(images) || images.length <= 0) return images
        const D = (40503 << 16 | 31153) >>> 0
        const R = (34283 << 16 | 51819) >>> 0
        const d = images.length
        const m = Number(orderId)
        const g = Number(sid)
        if (!Number.isFinite(m) || !Number.isFinite(g) || m < 0 || g < 0) return images

        // (a * b) 的 4 个 16 位小端字 (a, b < 2^32, 积 < 2^64, 无需 BigInt)
        const mulWords = (a, b) => {
            const a0 = a & 0xFFFF, a1 = a >>> 16
            const b0 = b & 0xFFFF, b1 = b >>> 16
            const low = a0 * b0
            const mid = a0 * b1 + a1 * b0
            const high = a1 * b1
            const w0 = low & 0xFFFF
            const c1 = Math.floor(low / 65536)
            const w1 = (mid + c1) & 0xFFFF
            const c2 = Math.floor((mid + c1) / 65536)
            const w2 = (high + c2) & 0xFFFF
            const w3 = Math.floor((high + c2) / 65536)
            return [w0, w1, w2, w3]
        }

        // (g*D ^ d*R) % d
        const lw = mulWords(g, D)
        const vw = mulWords(d, R)
        let b = 0
        let pow = 1 % d
        for (let i = 0; i < 4; i++) {
            b = (b + ((lw[i] ^ vw[i]) % d) * pow) % d
            pow = (pow * 65536) % d
        }
        // m ^ b (按 32 位无符号处理)
        const m32 = Math.floor(m) >>> 0
        const b32 = b >>> 0
        const h = ((m32 >>> 16) ^ (b32 >>> 16)) * 65536 + ((m32 & 0xFFFF) ^ (b32 & 0xFFFF))
        if (h < 0 || h >= d) return images
        const c = images.slice()
        c.splice(h, 1)
        return c
    }

    // 解析漫画条目 (兼容 home/search/mangas 三种数据源)
    static parseComic(item) {
        const authors = Array.isArray(item.author_names)
            ? item.author_names
            : Array.isArray(item.authors) ? item.authors.map(a => (typeof a === "string" ? a : a.name)).filter(Boolean) : []
        const genres = Array.isArray(item.genres)
            ? item.genres.map(g => (typeof g === "string" ? g : g.name)).filter(Boolean) : []
        return new Comic({
            id: item.mid || item.link || item.id,
            title: item.title,
            subTitle: authors.join(", ") || item.sub_title || "",
            cover: HiPiManga.coverUrl(item.vertical_image_url || item.cover_image_url || item.image_url),
            tags: genres,
        })
    }

    // ---------- 探索页 ----------
    explore = [
        {
            title: this.name,
            type: "multiPartPage",
            load: async () => {
                const res = await Network.get(`${HiPiManga.apiBase}/v1/home`, HiPiManga.jsonHeaders)
                if (res.status !== 200) throw `加载首页失败: ${res.status}`
                const home = JSON.parse(res.body).data || {}

                const sections = [
                    ["本周热门", home.weekly_hot, null],
                    ["人气排名", home.popularity_ranking, null],
                    ["高分韩漫", home.high_rated_korean, {
                        page: "category",
                        attributes: { category: "标签", param: "tag:69" },
                    }],
                    ["最新上架", home.new_releases, null],
                    ["完结推荐", home.completed_recommendations, null],
                    ["编辑精选", home.featured, null],
                    ["近期更新", home.recent_updates, null],
                ]

                const result = []
                for (const [title, comics, viewMore] of sections) {
                    if (!Array.isArray(comics) || comics.length === 0) continue
                    result.push({
                        title: title,
                        comics: comics.map(HiPiManga.parseComic),
                        viewMore: viewMore,
                    })
                }
                return result
            },
        },
    ]

    // ---------- 分类 ----------
    category = {
        title: this.name,
        parts: [
            {
                name: "分类",
                type: "fixed",
                categories: ["全部", "国漫", "日漫", "韩漫"],
                itemType: "category",
                categoryParams: ["all", "category:2", "category:3", "category:1"],
            },
            {
                name: "题材",
                type: "fixed",
                categories: [
                    "系统", "玄幻", "穿越", "大女主", "逆袭", "武侠", "重生", "动作",
                    "冒险", "复仇", "宫斗", "剧情", "异能", "搞笑", "战斗", "热血",
                ],
                itemType: "category",
                categoryParams: [
                    "genre:67", "genre:27", "genre:20", "genre:30", "genre:32", "genre:39",
                    "genre:46", "genre:40", "genre:38", "genre:31", "genre:44", "genre:3",
                    "genre:51", "genre:4", "genre:63", "genre:33",
                ],
            },
            {
                name: "标签",
                type: "fixed",
                categories: ["高分韩漫", "高分国漫", "人气榜新上榜"],
                itemType: "category",
                categoryParams: ["tag:69", "tag:45", "tag:108"],
            },
            {
                name: "状态",
                type: "fixed",
                categories: ["连载中", "已完结"],
                itemType: "category",
                categoryParams: ["status:ongoing", "status:completed"],
            },
        ],
        enableRankingPage: true,
    }

    // ---------- 分类漫画加载 ----------
    categoryComics = {
        load: async (category, param, options, page) => {
            // param 格式: "all" | "category:{id}" | "genre:{id}" | "tag:{id}" | "status:{value}"
            let filter = ""
            if (param && param !== "all") {
                const idx = param.indexOf(":")
                if (idx > 0) {
                    filter = `${param.substring(0, idx)}=${encodeURIComponent(param.substring(idx + 1))}`
                }
            }
            const sort = options && options[0] ? options[0] : "updated"
            const url = `${HiPiManga.apiBase}/v1/mangas?${filter ? filter + "&" : ""}sort=${sort}&page=${page}&per_page=18`
            const res = await Network.get(url, HiPiManga.jsonHeaders)
            if (res.status !== 200) throw `加载分类失败: ${res.status}`
            const data = JSON.parse(res.body).data || {}
            return {
                comics: (data.items || []).map(HiPiManga.parseComic),
                maxPage: Math.min(data.total_pages || 1, 100),
            }
        },
        optionList: [
            {
                label: "排序",
                options: [
                    "updated-最近更新",
                    "popular-最热门",
                    "latest-最新上架",
                ],
            },
        ],
        ranking: {
            options: [
                "popular-人气榜",
                "latest-最新上架",
                "updated-最近更新",
            ],
            load: async (option, page) => {
                const res = await Network.get(
                    `${HiPiManga.apiBase}/v1/mangas?sort=${option}&page=${page}&per_page=18`,
                    HiPiManga.jsonHeaders
                )
                if (res.status !== 200) throw `加载排行榜失败: ${res.status}`
                const data = JSON.parse(res.body).data || {}
                return {
                    comics: (data.items || []).map(HiPiManga.parseComic),
                    maxPage: Math.min(data.total_pages || 1, 100),
                }
            },
        },
    }

    // ---------- 搜索 ----------
    search = {
        load: async (keyword, options, page) => {
            const res = await Network.get(
                `${HiPiManga.apiBase}/v1/search?q=${encodeURIComponent(keyword)}&page=${page}&page_size=20`,
                HiPiManga.jsonHeaders
            )
            if (res.status !== 200) throw `搜索失败: ${res.status}`
            const data = JSON.parse(res.body).data || {}
            return {
                comics: (data.data || []).map(HiPiManga.parseComic),
                maxPage: Math.min(data.total_pages || 1, 100),
            }
        },
        optionList: [],
    }

    // ---------- 漫画详情 ----------
    comic = {
        loadInfo: async (id) => {
            // 兼容传入 URL 或纯 id
            const worksId = id.includes("/") ? id.substring(id.lastIndexOf("/") + 1) : id
            const b64mid = worksId.split("-")[0]
            const numericMid = HiPiManga.midToNumeric(b64mid)

            // 详情
            const res = await Network.get(
                `${HiPiManga.apiBase}/v1/manga?mid=${encodeURIComponent(b64mid)}`,
                HiPiManga.jsonHeaders
            )
            if (res.status !== 200) throw `加载漫画详情失败: ${res.status}`
            const data = JSON.parse(res.body).data
            if (!data) throw "漫画不存在"

            // 章节列表 (per_page 上限 50, 分批并发获取)
            // 注意: 必须用 order=asc 正序(第1话在前), 否则"开始阅读"会定位到最新章节
            const chapters = {}
            try {
                const firstRes = await HiPiManga.getWithRetry(
                    `${HiPiManga.apiBase}/v1/manga/chapters?mid=${numericMid}&page=1&per_page=50&order=asc`,
                    HiPiManga.jsonHeaders
                )
                const firstData = JSON.parse(firstRes.body).data || {}
                const totalPages = Math.max(1, Math.ceil((firstData.total || 0) / 50))
                ;(firstData.items || []).forEach(c => { chapters[c.hid] = c.title })
                for (let start = 2; start <= totalPages; start += 5) {
                    const batch = []
                    for (let p = start; p < start + 5 && p <= totalPages; p++) {
                        batch.push(
                            HiPiManga.getWithRetry(
                                `${HiPiManga.apiBase}/v1/manga/chapters?mid=${numericMid}&page=${p}&per_page=50&order=asc`,
                                HiPiManga.jsonHeaders
                            ).then(r => JSON.parse(r.body).data.items || [])
                        )
                    }
                    const results = await Promise.all(batch)
                    results.forEach(items => {
                        items.forEach(c => { chapters[c.hid] = c.title })
                    })
                }
            } catch (e) {
                console.error("章节列表加载失败: " + (e.message || e))
            }

            // 相关作品 (来自 SSR 页面, 失败不影响主流程)
            let recommend = []
            try {
                const worksRes = await Network.get(
                    `https://m.hipmh.com/works/${worksId}`,
                    HiPiManga.webHeaders
                )
                if (worksRes.status === 200) {
                    const doc = new HtmlDocument(worksRes.body)
                    try {
                        const list = doc.querySelector("[data-work-related-list]")
                        if (list) {
                            recommend = list.querySelectorAll("li").map(li => {
                                const a = li.querySelector("a")
                                const href = a ? a.attributes["href"] : ""
                                const linkId = href.includes("/works/") ? href.split("/works/")[1] : href
                                const titleEl = a ? a.querySelector("div.truncate") : null
                                const imgEl = li.querySelector("img")
                                return new Comic({
                                    id: linkId,
                                    title: titleEl ? titleEl.text : "",
                                    cover: imgEl ? imgEl.attributes["src"] : "",
                                })
                            }).filter(c => c.id)
                        }
                    } finally {
                        doc.dispose()
                    }
                }
            } catch (e) {
                recommend = []
            }

            const statusMap = { ongoing: "连载中", completed: "已完结" }
            const authorNames = (data.authors || []).map(a => a.name).filter(Boolean)
            const genreNames = (data.genres || []).map(g => g.name).filter(Boolean)
            const tags = {}
            if (authorNames.length > 0) tags["作者"] = authorNames
            if (genreNames.length > 0) tags["标签"] = genreNames
            const statusText = statusMap[data.status] || data.status || ""
            if (statusText) tags["状态"] = [statusText]

            return {
                title: data.title,
                cover: HiPiManga.coverUrl(data.vertical_image_url || data.cover_image_url),
                description: data.description || "",
                tags: tags,
                chapters: chapters,
                recommend: recommend,
                updateTime: data.updated_at || "",
            }
        },

        loadEp: async (comicId, epId) => {
            // 章节 id 为空时直接报错, 避免发出 hid=null 的无效请求
            if (!epId || typeof epId !== "string") {
                throw "无效的章节 ID"
            }
            const apiHid = HiPiManga.toApiHid(epId)
            if (!apiHid) throw "无效的章节 ID"
            const res = await HiPiManga.getWithRetry(
                `${HiPiManga.apiBase}/v2/chapter?hid=${encodeURIComponent(apiHid)}`,
                HiPiManga.jsonHeaders
            )
            const data = JSON.parse(res.body).data
            if (!data) throw "章节不存在"

            let images = typeof data.images === "string"
                ? HiPiManga.decodeChapterImages(data.images)
                : (data.images || [])
            images = HiPiManga.removeTrapImage(images, data.order_id, data.sid)

            // line: 1 -> tx 线路, 2 -> cf 线路, 9 -> s 加密线路
            const imgBase = data.line === 2 ? HiPiManga.imgBaseCf
                : (data.line === 9 ? HiPiManga.imgBaseTxS : HiPiManga.imgBaseTx)
            return {
                images: images.map(p => p.startsWith("http") ? p : imgBase + p),
            }
        },

        onImageLoad: (url, comicId, epId) => {
            return {
                url: url,
                headers: {
                    "User-Agent": HiPiManga.Mobile_UA,
                    "referer": "https://reader.hipmh.top/",
                },
            }
        },

        // 标签点击 -> 搜索
        onClickTag: (namespace, tag) => {
            return {
                page: "search",
                attributes: {
                    keyword: tag,
                },
            }
        },

        // 识别粘贴的漫画 id
        idMatch: "^[A-Za-z0-9_-]{4,}-[a-z0-9-]+-\\d+$",

        link: {
            domains: [
                "m.hipmh.com",
                "hipmh.com",
            ],
            linkToId: (url) => {
                const m = String(url).match(/\/works\/([A-Za-z0-9_-]+)/)
                return m ? m[1] : null
            },
        },
    }
}
