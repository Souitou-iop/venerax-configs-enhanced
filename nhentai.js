/** @type {import('./_venera_.js')} */

/**
 * nhentai (nhentai.net) —— Venera 漫画源（完全重写版 v2）
 * ============================ 原站分析 ============================
 * 站点程序 / 主域名: nhentai.net（SvelteKit 前端 + 公开 JSON API）
 * API:              https://nhentai.net/api/v2
 * 图片 CDN:         https://i.nhentai.net（原图） / https://t.nhentai.net（缩略图、封面、头像）
 * 分析依据:         _analysis/fixtures/nhentai/ 下 2026-09-13 抓取的真实夹具
 *                   （manifest.jsonl 共 22 条；latest_1.json / search_yuri.json /
 *                    search_yuri_popular.json / search_tag_lang.json / detail_1.json /
 *                    detail_1_include.json / detail_680786.json / related_1.json /
 *                    comments_1.json / rank_popular.json / tags_*.json / favorites_unauth.json）
 *
 * 反爬证据（BLOCKED 部分）:
 *   GET https://nhentai.net/            -> 403 text/html（Cloudflare 拦截匿名 HTML）
 *   GET https://nhentai.net/api/gallery/1-> 403 text/plain
 *   但站点自用的 GET https://nhentai.net/api/v2/* 可匿名访问（200 application/json）。
 *   => 本重写完全基于 /api/v2 JSON API，不做 HTML 解析，故 HTML 403 不影响功能。
 *
 * 1) 首页最新 GET /api/v2/galleries?page=N   （夹具 latest_1.json/latest_2.json）
 *      返回 {result:[{id,media_id,english_title,japanese_title,thumbnail,
 *            thumbnail_width,thumbnail_height,num_pages,num_favorites,tag_ids}],
 *            num_pages,per_page,total}；首页同时用热门：
 *      GET /api/v2/galleries/popular?page=N 直接返回数组（每页 5 条，夹具 popular_1.json）。
 * 2) 搜索     GET /api/v2/search?query=<kw>&sort=<sort>&page=N   （夹具 search_yuri*.json）
 *      查询语法与原站一致：tag:yuri / language:chinese / artist:x / parody:x /
 *      character:x / group:x / category:x（夹具 search_tag_lang.json 为 tag:yuri language:chinese）。
 *      sort 取值 date / popular 已被夹具验证；popular-today|week|month 为同参数窗口值。
 * 3) 分类目录 GET /api/v2/tags/<type>?page=N，type ∈ category/language/tag/parody/
 *      character/artist/group（夹具 tags_category.json 等）。
 * 4) 详情     GET /api/v2/galleries/<id>?include=related,favorite（夹具 detail_1_include.json）
 *      返回 title{pretty,english,japanese} / cover.path / thumbnail.path /
 *      tags[{id,type,name,slug}] / num_pages / upload_date(unix 秒) /
 *      pages[{number,path,thumbnail}] / related[]。
 * 5) 阅读     GET /api/v2/galleries/<id> 取 pages[].path，拼 https://i.nhentai.net/<path>
 *      （夹具 detail_1.json：pages[0].path = galleries/9/1.jpg；图片实测 200 image/jpeg）。
 * 6) 评论     GET /api/v2/galleries/<id>/comments?page=N 公开可读（夹具 comments_1.json，
 *      poster.username / poster.avatar_url / body / post_date）。
 * 7) 收藏     GET /api/v2/favorites?page=N 匿名返回 401 {"error":"Authentication required"}
 *      （夹具 favorites_unauth.json）—=> 收藏/发表评论受限于登录，本版未实现，避免编造。
 * ================================================================
 */

class Nhentai extends ComicSource {
    name = "nhentai"

    key = "nhentai"

    version = "2.0.0"

    minAppVersion = "1.0.0"

    url = "https://cdn.jsdelivr.net/gh/senran-N/venera-configs@main/nhentai.js"

    baseUrl = "https://nhentai.net"
    apiBaseUrl = "https://nhentai.net/api/v2"
    imageServer = "https://i.nhentai.net"
    thumbServer = "https://t.nhentai.net"

    settings = {
        apiKey: {
            title: "API Key (可选, 用于登录相关请求)",
            type: "input",
            default: "",
        },
    }

    get headers() {
        const h = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Referer": this.baseUrl + "/",
            "Accept": "application/json",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        };
        const key = (this.loadSetting("apiKey") || "").trim();
        if (key) h["Authorization"] = "Key " + key;
        return h;
    }

    async _get(url) {
        const res = await Network.get(url, this.headers);
        if (res.status !== 200) throw `Invalid status code: ${res.status}`;
        return JSON.parse(res.body);
    }

    /** 相对媒体路径 -> 绝对地址；封面/缩略图/头像走 t.nhentai.net，正文图片走 i.nhentai.net */
    _mediaUrl(path, isThumb = false) {
        if (!path) return "";
        let p = String(path).replace(/(\.(jpg|jpeg|png|webp|gif))+$/i,
            (m) => m.match(/\.(jpg|jpeg|png|webp|gif)/i)[0]);
        if (/^https?:\/\//i.test(p)) return p;
        if (p.startsWith("//")) return "https:" + p;
        p = p.replace(/^\/+/, "");
        if (/cover|thumb|avatar/i.test(p)) isThumb = true;
        return `${isThumb ? this.thumbServer : this.imageServer}/${p}`;
    }

    normalizeComicId(id) {
        id = String(id || "");
        if (id.startsWith("nhentai")) return id.replace("nhentai", "");
        if (id.startsWith("nh")) return id.replace("nh", "");
        return id;
    }

    languageOf(tagIds) {
        if (tagIds.includes(12227)) return "English";
        if (tagIds.includes(6346)) return "日本語";
        if (tagIds.includes(29963)) return "中文";
        return "Unknown";
    }

    parseComicFromApi(item) {
        const tagIds = Array.isArray(item.tag_ids) ? item.tag_ids : [];
        const title =
            item.english_title ||
            item.japanese_title ||
            item.title?.pretty ||
            item.title?.english ||
            item.title?.japanese ||
            String(item.id);
        const thumb =
            typeof item.thumbnail === "string" ? item.thumbnail :
            (item.thumbnail?.path || item.cover?.path || "");
        return new Comic({
            id: String(item.id),
            title: title,
            subtitle: "",
            cover: this._mediaUrl(thumb, true),
            tags: [],
            description: String(item.id),
            language: this.languageOf(tagIds),
            maxPage: item.num_pages || 0,
        });
    }

    parseList(data) {
        const arr = Array.isArray(data) ? data : (data.result || []);
        return {
            comics: arr.map((e) => this.parseComicFromApi(e)),
            maxPage: data.num_pages || 1,
        };
    }

    normalizeSort(raw) {
        const s = String(raw == null ? "" : raw).toLowerCase();
        if (s.includes("today")) return "popular-today";
        if (s.includes("week")) return "popular-week";
        if (s.includes("month")) return "popular-month";
        if (s.includes("popular") || s.includes("all")) return "popular";
        return "date";
    }

    normalizeTagType(param) {
        switch (String(param || "").toLowerCase()) {
            case "tags": case "tag": return "tag";
            case "languages": case "language": return "language";
            case "artists": case "artist": return "artist";
            case "characters": case "character": return "character";
            case "parodies": case "parody": return "parody";
            case "groups": case "group": return "group";
            case "categories": case "category": return "category";
            default: return "tag";
        }
    }

    tagNamespace(type) {
        switch (String(type || "").toLowerCase()) {
            case "language": return "Languages";
            case "artist": return "Artists";
            case "character": return "Characters";
            case "parody": return "Parodies";
            case "group": return "Groups";
            case "category": return "Categories";
            default: return "Tags";
        }
    }

    slugifyTag(name) {
        return String(name || "")
            .toLowerCase()
            .trim()
            .replaceAll(".", "-")
            .replaceAll("_", "-")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-");
    }

    /** 统一走 /api/v2/search（首页用 galleries / galleries/popular） */
    async _search(query, sort, page) {
        const q = query === "*" ? "*" : encodeURIComponent(query);
        const data = await this._get(
            `${this.apiBaseUrl}/search?query=${q}&sort=${encodeURIComponent(sort)}&page=${page}`
        );
        return this.parseList(data);
    }

    formatTimestamp(sec) {
        const t = Number(sec);
        if (!t) return "";
        const d = new Date(t * 1000);
        const p = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    explore = [
        {
            title: "nhentai",
            type: "mixed",
            load: async (page) => {
                const currentPage = page || 1;
                const data = [];

                if (currentPage === 1) {
                    const popular = await this._get(`${this.apiBaseUrl}/galleries/popular?page=1`);
                    data.push({
                        title: "Popular Now",
                        comics: (Array.isArray(popular) ? popular : []).map((e) => this.parseComicFromApi(e)),
                    });
                }

                const latest = this.parseList(
                    await this._get(`${this.apiBaseUrl}/galleries?page=${currentPage}`)
                );
                if (currentPage === 1) {
                    data.push({ title: "New Uploads", comics: latest.comics });
                } else {
                    data.push(latest.comics);
                }

                return { data, maxPage: latest.maxPage };
            },
        },
    ]

    category = {
        title: "nhentai",
        parts: [
            {
                name: "Languages",
                type: "fixed",
                categories: ["japanese", "translated", "chinese", "english", "ukrainian", "textless", "hebrew", "arabic", "textless narrative", "khmer", "romanian", "greek", "turkish", "czech"],
                itemType: "category",
                categoryParams: ["language:japanese", "language:translated", "language:chinese", "language:english", "language:ukrainian", "language:textless", "language:hebrew", "language:arabic", "language:textless-narrative", "language:khmer", "language:romanian", "language:greek", "language:turkish", "language:czech"],
            },
            {
                name: "Categories",
                type: "fixed",
                categories: ["doujinshi", "manga", "misc"],
                itemType: "category",
                categoryParams: ["category:doujinshi", "category:manga", "category:misc"],
            },
            {
                name: "Tags",
                type: "fixed",
                categories: ["big breasts", "sole female", "sole male", "group", "anal", "nakadashi", "lolicon", "stockings", "blowjob", "schoolgirl uniform", "full color", "glasses", "shotacon", "mosaic censorship", "rape", "yaoi", "ahegao", "bondage", "multi-work series", "males only", "x-ray", "incest", "milf", "dark skin", "paizuri", "sex toys", "netorare", "futanari", "double penetration", "tankoubon"],
                itemType: "category",
                categoryParams: ["tag:big-breasts", "tag:sole-female", "tag:sole-male", "tag:group", "tag:anal", "tag:nakadashi", "tag:lolicon", "tag:stockings", "tag:blowjob", "tag:schoolgirl-uniform", "tag:full-color", "tag:glasses", "tag:shotacon", "tag:mosaic-censorship", "tag:rape", "tag:yaoi", "tag:ahegao", "tag:bondage", "tag:multi-work-series", "tag:males-only", "tag:x-ray", "tag:incest", "tag:milf", "tag:dark-skin", "tag:paizuri", "tag:sex-toys", "tag:netorare", "tag:futanari", "tag:double-penetration", "tag:tankoubon"],
            },
            {
                name: "Parodies",
                type: "fixed",
                categories: ["original", "touhou project", "kantai collection", "fate grand order", "the idolmaster", "blue archive", "granblue fantasy", "genshin impact", "pokemon", "azur lane", "hololive", "neon genesis evangelion", "love live", "girls und panzer", "sailor moon", "mahou shoujo lyrical nanoha", "one piece", "fate stay night", "naruto", "sword art online"],
                itemType: "category",
                categoryParams: ["parody:original", "parody:touhou-project", "parody:kantai-collection", "parody:fate-grand-order", "parody:the-idolmaster", "parody:blue-archive", "parody:granblue-fantasy", "parody:genshin-impact", "parody:pokemon", "parody:azur-lane", "parody:hololive", "parody:neon-genesis-evangelion", "parody:love-live", "parody:girls-und-panzer", "parody:sailor-moon", "parody:mahou-shoujo-lyrical-nanoha", "parody:one-piece", "parody:fate-stay-night", "parody:naruto", "parody:sword-art-online"],
            },
            {
                name: "Characters",
                type: "fixed",
                categories: ["teitoku", "sensei", "gudao", "producer", "reimu hakurei", "shielder", "asuka langley soryu", "sakuya izayoi", "gran", "patchouli knowledge", "shinji ikari", "sanae kochiya", "flandre scarlet", "rei ayanami", "fate testarossa", "marisa kirisame", "remilia scarlet", "shikikan", "nami", "atago"],
                itemType: "category",
                categoryParams: ["character:teitoku", "character:sensei", "character:gudao", "character:producer", "character:reimu-hakurei", "character:shielder", "character:asuka-langley-soryu", "character:sakuya-izayoi", "character:gran", "character:patchouli-knowledge", "character:shinji-ikari", "character:sanae-kochiya", "character:flandre-scarlet", "character:rei-ayanami", "character:fate-testarossa", "character:marisa-kirisame", "character:remilia-scarlet", "character:shikikan", "character:nami", "character:atago"],
            },
            {
                name: "Artists",
                type: "fixed",
                categories: ["ankoman", "crimson", "saigado", "inochi wazuka", "itaba hiroshi", "takasugi kou", "osuwaani", "sanbun kyoden", "bai asuka", "nakajima yuka", "shiwasu no okina", "yukino minato", "mimonel", "nekogen", "kuroinu juu", "fan no hitori", "cuvie", "ryo", "cle masahiro", "ahemaru"],
                itemType: "category",
                categoryParams: ["artist:ankoman", "artist:crimson", "artist:saigado", "artist:inochi-wazuka", "artist:itaba-hiroshi", "artist:takasugi-kou", "artist:osuwaani", "artist:sanbun-kyoden", "artist:bai-asuka", "artist:nakajima-yuka", "artist:shiwasu-no-okina", "artist:yukino-minato", "artist:mimonel", "artist:nekogen", "artist:kuroinu-juu", "artist:fan-no-hitori", "artist:cuvie", "artist:ryo", "artist:cle-masahiro", "artist:ahemaru"],
            },
            {
                name: "Groups",
                type: "fixed",
                categories: ["digital lover", "crimson comics", "noraneko-no-tama", "black dog", "studio wallaby", "amuai okashi seisakusho", "nagiyamasugi", "kinokonomi", "valssu", "clesta", "axz", "warabimochi", "u.r.c", "tsurikichi doumei", "ncp", "nyuu koubou", "gambler club", "rpg company 2", "orangemaru", "cyclone"],
                itemType: "category",
                categoryParams: ["group:digital-lover", "group:crimson-comics", "group:noraneko-no-tama", "group:black-dog", "group:studio-wallaby", "group:amuai-okashi-seisakusho", "group:nagiyamasugi", "group:kinokonomi", "group:valssu", "group:clesta", "group:axz", "group:warabimochi", "group:u-r-c", "group:tsurikichi-doumei", "group:ncp", "group:nyuu-koubou", "group:gambler-club", "group:rpg-company-2", "group:orangemaru", "group:cyclone"],
            },
        ],
        enableRankingPage: true,
    }

    categoryComics = {
        load: async (category, param, options, page) => {
            const sort = this.normalizeSort(options && options[0]);
            const query = (param && String(param).includes(":"))
                ? param
                : `${this.normalizeTagType(param)}:${this.slugifyTag(category)}`;
            return await this._search(query, sort, page || 1);
        },
        optionList: [
            {
                label: "sort",
                options: [
                    "date-Recent",
                    "popular-Popular All",
                    "popular-today-Popular Today",
                    "popular-week-Popular Week",
                    "popular-month-Popular Month",
                ],
            },
        ],
        ranking: {
            options: [
                "popular-Popular All",
                "popular-today-Popular Today",
                "popular-week-Popular Week",
                "popular-month-Popular Month",
                "date-Recent",
            ],
            load: async (option, page) => {
                return await this._search("*", this.normalizeSort(option), page || 1);
            },
        },
    }

    search = {
        load: async (keyword, options, page) => {
            const sort = this.normalizeSort(options && options[0]);
            return await this._search(keyword, sort, page || 1);
        },
        optionList: [
            {
                label: "sort",
                options: [
                    "date-Recent",
                    "popular-Popular All",
                    "popular-today-Popular Today",
                    "popular-week-Popular Week",
                    "popular-month-Popular Month",
                ],
            },
        ],
        enableTagsSuggestions: false,
    }

    comic = {
        onThumbnailLoad: (url) => ({ url: url, headers: this.headers }),

        onImageLoad: (url) => ({ url: url, headers: this.headers }),

        loadInfo: async (id) => {
            id = this.normalizeComicId(id);
            const data = await this._get(`${this.apiBaseUrl}/galleries/${id}?include=related,favorite`);

            const title = data?.title?.pretty || data?.title?.english || String(id);
            const englishTitle = data?.title?.english || "";
            const subtitle = englishTitle && englishTitle !== title ? englishTitle : "";
            const cover = this._mediaUrl(data?.cover?.path || data?.thumbnail?.path || "", true);

            const tags = new Map();
            for (const tag of (data.tags || [])) {
                const ns = this.tagNamespace(tag.type);
                if (!tags.has(ns)) tags.set(ns, []);
                tags.get(ns).push(tag.name);
            }

            const thumbnails = (data.pages || [])
                .map((p) => this._mediaUrl(p.thumbnail, true))
                .filter(Boolean);

            const recommend = (data.related || []).map((e) => this.parseComicFromApi(e));

            // 单个 gallery 即一个章节
            const chapters = new Map();
            chapters.set("1", title || String(id));

            return new ComicDetails({
                title: title || String(id),
                subtitle: subtitle,
                cover: cover,
                tags: tags,
                chapters: chapters,
                maxPage: data?.num_pages || 0,
                uploadTime: this.formatTimestamp(data?.upload_date),
                isFavorite: !!data?.is_favorited,
                thumbnails: thumbnails,
                recommend: recommend,
                url: `${this.baseUrl}/g/${id}/`,
            });
        },

        loadEp: async (comicId, epId) => {
            comicId = this.normalizeComicId(comicId);
            const data = await this._get(`${this.apiBaseUrl}/galleries/${comicId}`);
            const images = (data.pages || [])
                .filter((p) => p && p.path)
                .map((p) => this._mediaUrl(p.path, false));
            if (!images.length) throw "No images found";
            return { images: images };
        },

        loadComments: async (comicId, subId, page) => {
            comicId = this.normalizeComicId(comicId);
            const data = await this._get(
                `${this.apiBaseUrl}/galleries/${comicId}/comments?page=${page || 1}`
            );
            const comments = (data.result || []).map((c) => new Comment({
                userName: c?.poster?.username || "",
                avatar: this._mediaUrl(c?.poster?.avatar_url || "", false),
                content: c?.body || "",
                time: this.formatTimestamp(c?.post_date),
            }));
            return { comments: comments, maxPage: data.num_pages || 1 };
        },

        idMatch: "^(\\d+|nh\\d+|nhentai\\d+)$",

        onClickTag: (namespace, tag) => {
            return {
                action: "category",
                keyword: tag,
                param: namespace,
            };
        },

        link: {
            domains: ["nhentai.net"],
            linkToId: (url) => {
                const match = /\/g\/(\d+)\/?/.exec(url);
                return match ? match[1] : null;
            },
        },

        enableTagsTranslate: true,
    }

    translation = {
        "zh_CN": {
            "Tags": "标签",
            "Categories": "分类",
            "Languages": "语言",
            "Artists": "画师",
            "Characters": "角色",
            "Groups": "团队",
            "Parodies": "原作",
            "Recent": "最近",
            "Popular All": "热门",
            "Popular Today": "今日热门",
            "Popular Week": "本周热门",
            "Popular Month": "本月热门",
            "sort": "排序",
        },
        "zh_TW": {
            "Tags": "標籤",
            "Categories": "分類",
            "Languages": "語言",
            "Artists": "畫師",
            "Characters": "角色",
            "Groups": "團隊",
            "Parodies": "原作",
            "Recent": "最近",
            "Popular All": "熱門",
            "Popular Today": "今日熱門",
            "Popular Week": "本週熱門",
            "Popular Month": "本月熱門",
            "sort": "排序",
        },
        "en": {},
    }
}
