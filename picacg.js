class Picacg extends ComicSource {
    name = "Picacg"

    key = "picacg"

    version = "1.0.8"

    minAppVersion = "1.0.0"

    url = "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/picacg.js"

    static defaultApiUrl = "https://picaapi.picacomic.com"

    apiKey = "C69BAF41DA5ABD1FFEDC6D2FEA56B";

    createSignature(path, nonce, time, method) {
        let data = path + time + nonce + method + this.apiKey
        let key = '~d}$Q7$eIni=V)9\\RK/P.RM4;9[7|@/CA}b~OW!3?EV`:<>M7pddUBL5n|0/*Cn'
        let s = Convert.encodeUtf8(key)
        let h = Convert.encodeUtf8(data.toLowerCase())
        return Convert.hmacString(s, h, 'sha256')
    }

    buildHeaders(method, path, token) {
        let uuid = createUuid()
        let nonce = uuid.replace(/-/g, '')
        let time = (new Date().getTime() / 1000).toFixed(0)
        let signature = this.createSignature(path, nonce, time, method.toUpperCase())
        return {
            "api-key": "C69BAF41DA5ABD1FFEDC6D2FEA56B",
            "accept": "application/vnd.picacomic.com.v1+json",
            "app-channel": this.loadSetting('appChannel') || "3",
            "authorization": token ?? "",
            "time": time,
            "nonce": nonce,
            "app-version": "2.2.1.3.3.4",
            "app-uuid": "defaultUuid",
            "image-quality": this.loadSetting('imageQuality') || "original",
            "app-platform": "android",
            "app-build-version": "45",
            "Content-Type": "application/json; charset=UTF-8",
            "user-agent": "okhttp/3.8.1",
            "version": "v1.5.4",
            "signature": signature,
            "http_client": "dart:io",
        }
    }

    account = {
        reLogin: async () => {
            if(!this.isLogged) {
                throw new Error('Not logged in');
            }
            let account = this.loadData('account')
            if(!Array.isArray(account)) {
                throw new Error('Failed to reLogin: Invalid account data');
            }
            let username = account[0]
            let password = account[1]
            return await this.account.login(username, password)
        },
        login: async (account, pwd) => {
            let body = JSON.stringify({
                email: account,
                password: pwd
            })
            let res = await Network.post(
                `${this.loadSetting('base_url')}/auth/sign-in`,
                this.buildHeaders('POST', 'auth/sign-in'),
                body)

            if (res.status === 200) {
                let json = JSON.parse(res.body)
                if (!json.data?.token) {
                    throw 'Failed to get token\nResponse: ' + res.body
                }
                this.saveData('token', json.data.token)
                return 'ok'
            }

            // 透出服务端错误信息 (如账号密码错误、需要验证)
            try {
                let json = JSON.parse(res.body)
                if (json.message) {
                    throw `Login failed (${res.status}): ${json.message}`
                }
            } catch (e) {
                if (typeof e === 'string' && e.startsWith('Login failed')) throw e
            }
            throw `Login failed (${res.status})`
        },

        logout: () => {
            this.deleteData('token')
        },

        registerWebsite: "https://manhuabika.com/pregister/?"
    }

    parseComic(comic) {
        comic = comic ?? {}
        let tags = []
        tags.push(...(comic.tags ?? []))
        tags.push(...(comic.categories ?? []))
        let thumb = comic.thumb ?? {}
        let cover = thumb.fileServer && thumb.path ? thumb.fileServer + '/static/' + thumb.path : ""
        return new Comic({
            id: comic._id,
            title: comic.title ?? "Unknown",
            subTitle: comic.author ?? "",
            cover: cover,
            tags: tags,
            description: `${comic.totalLikes ?? comic.likesCount ?? 0} likes`,
            maxPage: comic.pagesCount,
        })
    }

    parseComicList(docs) {
        let comics = []
        for (let c of (docs ?? [])) {
            try {
                comics.push(this.parseComic(c))
            } catch (e) {
                // 跳过损坏条目, 避免整页崩溃
            }
        }
        return comics
    }

    // 哔咔首页四个专题(大家都在看/大濕推薦/那年今天/官方都在看)是 collections, 不是 categories,
    // 只能走 GET collections 按 title 匹配, 内嵌 comics 数组 (无分页)
    static collectionTitles = ["大家都在看", "大濕推薦", "那年今天", "官方都在看"]

    async loadCollection(title) {
        let base = this.loadSetting('base_url')
        let path = 'collections'
        let res = await Network.get(
            `${base}/${path}`,
            this.buildHeaders('GET', path, this.loadData('token'))
        )
        if (res.status === 401) {
            await this.account.reLogin()
            res = await Network.get(
                `${base}/${path}`,
                this.buildHeaders('GET', path, this.loadData('token'))
            )
        }
        if (res.status !== 200) {
            throw 'Invalid status code: ' + res.status
        }
        let data = JSON.parse(res.body)
        let collections = data.data?.collections ?? []
        let hit = collections.find(c => c.title === title)
        if (!hit) {
            throw `Collection not found: ${title}`
        }
        return {
            comics: this.parseComicList(hit.comics),
            maxPage: 1
        }
    }

    explore = [
        {
            title: "Picacg Random",
            type: "multiPageComicList",
            load: async (page) => {
                if (!this.isLogged) {
                    throw 'Not logged in'
                }
                let res = await Network.get(
                    `${this.loadSetting('base_url')}/comics/random`,
                    this.buildHeaders('GET', 'comics/random', this.loadData('token'))
                )
                if(res.status === 401) {
                    await this.account.reLogin()
                    res = await Network.get(
                        `${this.loadSetting('base_url')}/comics/random`,
                        this.buildHeaders('GET', 'comics/random', this.loadData('token'))
                    )
                }
                if (res.status !== 200) {
                    throw 'Invalid status code: ' + res.status
                }
                let data = JSON.parse(res.body)
                return {
                    comics: this.parseComicList(data.data?.comics),
                    maxPage: 1
                }
            }
        },
        {
            title: "Picacg Latest",
            type: "multiPageComicList",
            load: async (page) => {
                if (!this.isLogged) {
                    throw 'Not logged in'
                }
                let res = await Network.get(
                    `${this.loadSetting('base_url')}/comics?page=${page}&s=dd`,
                    this.buildHeaders('GET', `comics?page=${page}&s=dd`, this.loadData('token'))
                )
                if(res.status === 401) {
                    await this.account.reLogin()
                    res = await Network.get(
                        `${this.loadSetting('base_url')}/comics?page=${page}&s=dd`,
                        this.buildHeaders('GET', `comics?page=${page}&s=dd`, this.loadData('token'))
                    )
                }
                if (res.status !== 200) {
                    throw 'Invalid status code: ' + res.status
                }
                let data = JSON.parse(res.body)
                return {
                    comics: this.parseComicList(data.data?.comics?.docs),
                    maxPage: data.data?.comics?.pages ?? page
                }
            }
        },
        {
            title: "Picacg H24",
            type: "multiPageComicList",
            load: async (page) => {
                if (!this.isLogged) {
                    throw 'Not logged in'
                }
                let res = await Network.get(
                    `${this.loadSetting('base_url')}/comics/leaderboard?tt=H24&ct=VC`,
                    this.buildHeaders('GET', 'comics/leaderboard?tt=H24&ct=VC', this.loadData('token'))
                )
                if (res.status === 401) {
                    await this.account.reLogin()
                    res = await Network.get(
                        `${this.loadSetting('base_url')}/comics/leaderboard?tt=H24&ct=VC`,
                        this.buildHeaders('GET', 'comics/leaderboard?tt=H24&ct=VC', this.loadData('token'))
                    )
                }
                if (res.status !== 200) {
                    throw 'Invalid status code: ' + res.status
                }
                let data = JSON.parse(res.body)
                return {
                    comics: this.parseComicList(data.data?.comics),
                    maxPage: 1
                }
            }
        },
        {
            title: "Picacg D7",
            type: "multiPageComicList",
            load: async (page) => {
                if (!this.isLogged) {
                    throw 'Not logged in'
                }
                let res = await Network.get(
                    `${this.loadSetting('base_url')}/comics/leaderboard?tt=D7&ct=VC`,
                    this.buildHeaders('GET', 'comics/leaderboard?tt=D7&ct=VC', this.loadData('token'))
                )
                if (res.status === 401) {
                    await this.account.reLogin()
                    res = await Network.get(
                        `${this.loadSetting('base_url')}/comics/leaderboard?tt=D7&ct=VC`,
                        this.buildHeaders('GET', 'comics/leaderboard?tt=D7&ct=VC', this.loadData('token'))
                    )
                }
                if (res.status !== 200) {
                    throw 'Invalid status code: ' + res.status
                }
                let data = JSON.parse(res.body)
                return {
                    comics: this.parseComicList(data.data?.comics),
                    maxPage: 1
                }
            }
        },
        {
            title: "Picacg D30",
            type: "multiPageComicList",
            load: async (page) => {
                if (!this.isLogged) {
                    throw 'Not logged in'
                }
                let res = await Network.get(
                    `${this.loadSetting('base_url')}/comics/leaderboard?tt=D30&ct=VC`,
                    this.buildHeaders('GET', 'comics/leaderboard?tt=D30&ct=VC', this.loadData('token'))
                )
                if (res.status === 401) {
                    await this.account.reLogin()
                    res = await Network.get(
                        `${this.loadSetting('base_url')}/comics/leaderboard?tt=D30&ct=VC`,
                        this.buildHeaders('GET', 'comics/leaderboard?tt=D30&ct=VC', this.loadData('token'))
                    )
                }
                if (res.status !== 200) {
                    throw 'Invalid status code: ' + res.status
                }
                let data = JSON.parse(res.body)
                return {
                    comics: this.parseComicList(data.data?.comics),
                    maxPage: 1
                }
            }
        }
    ]

    /// 分类页面
    /// 一个漫画源只能有一个分类页面, 也可以没有, 设置为null禁用分类页面
    category = {
        /// 标题, 同时为标识符, 不能与其他漫画源的分类页面重复
        title: "Picacg",
        parts: [
            {
                name: "主题",
                type: "fixed",
                categories: [
                    "大家都在看",
                    "大濕推薦",
                    "那年今天",
                    "官方都在看",
                    "嗶咔漢化",
                    "全彩",
                    "長篇",
                    "同人",
                    "短篇",
                    "圓神領域",
                    "碧藍幻想",
                    "CG雜圖",
                    "英語 ENG",
                    "生肉",
                    "純愛",
                    "百合花園",
                    "耽美花園",
                    "偽娘哲學",
                    "後宮閃光",
                    "扶他樂園",
                    "單行本",
                    "姐姐系",
                    "妹妹系",
                    "SM",
                    "性轉換",
                    "足の恋",
                    "人妻",
                    "NTR",
                    "強暴",
                    "非人類",
                    "艦隊收藏",
                    "Love Live",
                    "SAO 刀劍神域",
                    "Fate",
                    "東方",
                    "WEBTOON",
                    "禁書目錄",
                    "歐美",
                    "Cosplay",
                    "重口地帶"
                ],
                itemType: "category",
            }
        ],
        enableRankingPage: true,
    }

    /// 分类漫画页面, 即点击分类标签后进入的页面
    categoryComics = {
        load: async (category, param, options, page) => {
            // 四个专题走 collections (内嵌数组, 无视排序)
            if (Picacg.collectionTitles.includes(category)) {
                if (page > 1) {
                    return { comics: [], maxPage: 1 }
                }
                return await this.loadCollection(category)
            }
            let type = param ?? 'c'
            let sort = (options && options[0]) ? String(options[0]).split("-")[0] : "dd"
            let base = this.loadSetting('base_url')
            let path = `comics?page=${page}&${type}=${encodeURIComponent(category)}&s=${sort}`
            let res = await Network.get(
                `${base}/${path}`,
                this.buildHeaders('GET', path, this.loadData('token'))
            )
            if(res.status === 401) {
                await this.account.reLogin()
                res = await Network.get(
                    `${base}/${path}`,
                    this.buildHeaders('GET', path, this.loadData('token'))
                )
            }
            if (res.status !== 200) {
                throw 'Invalid status code: ' + res.status
            }
            let data = JSON.parse(res.body)
            return {
                comics: this.parseComicList(data.data?.comics?.docs),
                maxPage: data.data?.comics?.pages ?? page
            }
        },
        // 提供选项
        optionList: [
            {
                options: [
                    "dd-New to old",
                    "da-Old to new",
                    "ld-Most likes",
                    "vd-Most nominated",
                ],
            }
        ],
        ranking: {
            options: [
                "H24-Day",
                "D7-Week",
                "D30-Month",
            ],
            load: async (option, page) => {
                let res = await Network.get(
                    `${this.loadSetting('base_url')}/comics/leaderboard?tt=${option}&ct=VC`,
                    this.buildHeaders('GET', `comics/leaderboard?tt=${option}&ct=VC`, this.loadData('token'))
                )
                if(res.status === 401) {
                    await this.account.reLogin()
                    res = await Network.get(
                        `${this.loadSetting('base_url')}/comics/leaderboard?tt=${option}&ct=VC`,
                        this.buildHeaders('GET', `comics/leaderboard?tt=${option}&ct=VC`, this.loadData('token'))
                    )
                }
                if (res.status !== 200) {
                    throw 'Invalid status code: ' + res.status
                }
                let data = JSON.parse(res.body)
                return {
                    comics: this.parseComicList(data.data?.comics),
                    maxPage: 1
                }
            }
        }
    }

    /// 搜索
    search = {
        load: async (keyword, options, page) => {
            let sort = (options && options[0]) ? String(options[0]).split("-")[0] : "dd"
            // 多选值在不同 App 版本可能是 JSON 字符串或原生数组, 两种都兼容
            let rawCats = options ? options[1] : null
            let cats = []
            if (Array.isArray(rawCats)) {
                cats = rawCats
            } else if (typeof rawCats === "string" && rawCats) {
                try {
                    let parsed = JSON.parse(rawCats)
                    cats = Array.isArray(parsed) ? parsed : [parsed]
                } catch (e) {
                    cats = []
                }
            }
            let body = {
                keyword: keyword,
                sort: sort,
            }
            if (cats.length > 0) {
                body.categories = cats
            }
            let res = await Network.post(
                `${this.loadSetting('base_url')}/comics/advanced-search?page=${page}`,
                this.buildHeaders('POST', `comics/advanced-search?page=${page}`, this.loadData('token')),
                JSON.stringify(body)
            )
            if(res.status === 401) {
                await this.account.reLogin()
                res = await Network.post(
                    `${this.loadSetting('base_url')}/comics/advanced-search?page=${page}`,
                    this.buildHeaders('POST', `comics/advanced-search?page=${page}`, this.loadData('token')),
                    JSON.stringify(body)
                )
            }
            if (res.status !== 200) {
                throw 'Invalid status code: ' + res.status
            }
            let data = JSON.parse(res.body)
            return {
                comics: this.parseComicList(data.data?.comics?.docs),
                maxPage: data.data?.comics?.pages ?? page
            }
        },
        optionList: [
            {
                options: [
                    "dd-New to old",
                    "da-Old to new",
                    "ld-Most likes",
                    "vd-Most nominated",
                ],
                label: "Sort"
            },
            {
                type: "multi-select",
                options: [
                    "嗶咔漢化-Chinese",
                    "全彩-Full Color",
                    "長篇-Long",
                    "同人-Doujinshi",
                    "短篇-Short",
                    "圓神領域-Yuan Shen",
                    "碧藍幻想-Granblue",
                    "CG雜圖-CG",
                    "英語 ENG-English",
                    "生肉-Raw",
                    "純愛-Pure Love",
                    "百合花園-Yuri",
                    "耽美花園-Yaoi",
                    "偽娘哲學-Trap",
                    "後宮閃光-Harem",
                    "扶他樂園-Futanari",
                    "單行本-Tankoubon",
                    "姐姐系-Sister",
                    "妹妹系-Sister2",
                    "SM-SM",
                    "性轉換-Gender Bender",
                    "足の恋-Feet",
                    "人妻-Wife",
                    "NTR-NTR",
                    "強暴-Rape",
                    "非人類-Non-human",
                    "艦隊收藏-Kancolle",
                    "Love Live-Love Live",
                    "SAO 刀劍神域-SAO",
                    "Fate-Fate",
                    "東方-Touhou",
                    "WEBTOON-WEBTOON",
                    "禁書目錄-Index",
                    "歐美-Western",
                    "Cosplay-Cosplay",
                    "重口地帶-Heavy",
                ],
                label: "Categories",
                default: [],
            }
        ]
    }

    /// 收藏
    favorites = {
        multiFolder: false,
        /// 添加或者删除收藏
        addOrDelFavorite: async (comicId, folderId, isAdding) => {
            let res = await Network.post(
                `${this.loadSetting('base_url')}/comics/${comicId}/favourite`,
                this.buildHeaders('POST', `comics/${comicId}/favourite`, this.loadData('token')),
                '{}'
            )
            if(res.status === 401) {
                throw `Login expired`
            }
            if(res.status !== 200) {
                throw 'Invalid status code: ' + res.status
            }
            return 'ok'
        },
        /// 加载漫画
        loadComics: async (page, folder) => {
            let sort = this.loadSetting('favoriteSort')
            let res = await Network.get(
                `${this.loadSetting('base_url')}/users/favourite?page=${page}&s=${sort}`,
                this.buildHeaders('GET', `users/favourite?page=${page}&s=${sort}`, this.loadData('token'))
            )
            if(res.status === 401) {
                throw `Login expired`
            }
            if (res.status !== 200) {
                throw 'Invalid status code: ' + res.status
            }
            let data = JSON.parse(res.body)
            return {
                comics: this.parseComicList(data.data?.comics?.docs),
                maxPage: data.data?.comics?.pages ?? page
            }
        }
    }

    /// 单个漫画相关
    comic = {
        // 加载漫画信息
        loadInfo: async (id) => {
            let infoLoader = async () => {
                let res = await Network.get(
                    `${this.loadSetting('base_url')}/comics/${id}`,
                    this.buildHeaders('GET', `comics/${id}`, this.loadData('token'))
                )
                if (res.status !== 200) {
                    throw 'Invalid status code: ' + res.status
                }
                let data = JSON.parse(res.body)
                return data.data.comic
            }
            let epsLoader = async () => {
                let eps = new Map();
                let i = 1;
                let j = 1;
                let allEps = [];
                while (true) {
                    let res = await Network.get(
                        `${this.loadSetting('base_url')}/comics/${id}/eps?page=${i}`,
                        this.buildHeaders('GET', `comics/${id}/eps?page=${i}`, this.loadData('token'))
                    );
                    if (res.status !== 200) {
                        throw 'Invalid status code: ' + res.status;
                    }
                    let data = JSON.parse(res.body);
                    allEps.push(...(data.data?.eps?.docs ?? []));
                    let pages = data.data?.eps?.pages ?? 0
                    if (pages <= i) {
                        break;
                    }
                    i++;
                }
                allEps.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                allEps.forEach(e => {
                    eps.set(j.toString(), e.title ?? `Chapter ${j}`);
                    j++;
                });
                return eps;
            }
            let relatedLoader = async () => {
                let res = await Network.get(
                    `${this.loadSetting('base_url')}/comics/${id}/recommendation`,
                    this.buildHeaders('GET', `comics/${id}/recommendation`, this.loadData('token'))
                )
                if (res.status !== 200) {
                    throw 'Invalid status code: ' + res.status
                }
                let data = JSON.parse(res.body)
                return this.parseComicList(data.data?.comics)
            }
            let info, eps, related
            try {
                [info, eps, related] = await Promise.all([infoLoader(), epsLoader(), relatedLoader()])
            }
            catch (e) {
                if (e === 'Invalid status code: 401') {
                    await this.account.reLogin();
                    [info, eps, related] = await Promise.all([infoLoader(), epsLoader(), relatedLoader()]);
                } else {
                    throw e
                }
            }
            let tags = {}
            if(info.author) {
                tags['Author'] = [info.author];
            }
            if(info.chineseTeam) {
                tags['Chinese Team'] = [info.chineseTeam];
            }
            let updateTime = new Date(info.updated_at)
            let formattedDate = updateTime.getFullYear() + '-' + (updateTime.getMonth() + 1) + '-' + updateTime.getDate()
            let creator = info._creator ?? {}
            let thumb = info.thumb ?? {}
            return new ComicDetails({
                title: info.title ?? "Unknown",
                cover: thumb.fileServer && thumb.path ? thumb.fileServer + '/static/' + thumb.path : "",
                description: info.description ?? "",
                tags: {
                    ...tags,
                    'Categories': info.categories ?? [],
                    'Tags': info.tags ?? [],
                },
                chapters: eps,
                isFavorite: info.isFavourite ?? false,
                isLiked: info.isLiked ?? false,
                recommend: related,
                commentCount: info.commentsCount ?? 0,
                likesCount: info.likesCount ?? 0,
                uploader: creator.name ?? "",
                updateTime: formattedDate,
                maxPage: info.pagesCount,
            })
        },
        // 获取章节图片
        loadEp: async (comicId, epId) => {
            let images = []
            let i = 1
            while(true) {
                let res = await Network.get(
                    `${this.loadSetting('base_url')}/comics/${comicId}/order/${epId}/pages?page=${i}`,
                    this.buildHeaders('GET', `comics/${comicId}/order/${epId}/pages?page=${i}`, this.loadData('token'))
                )
                if (res.status === 401) {
                    await this.account.reLogin()
                    res = await Network.get(
                        `${this.loadSetting('base_url')}/comics/${comicId}/order/${epId}/pages?page=${i}`,
                        this.buildHeaders('GET', `comics/${comicId}/order/${epId}/pages?page=${i}`, this.loadData('token'))
                    )
                }
                if (res.status !== 200) {
                    throw 'Invalid status code: ' + res.status
                }
                let data = JSON.parse(res.body)
                for (let p of (data.data?.pages?.docs ?? [])) {
                    let media = p.media ?? {}
                    if (media.fileServer && media.path) {
                        images.push(media.fileServer + '/static/' + media.path)
                    }
                }
                let pages = data.data?.pages?.pages ?? 0
                if(pages <= i) {
                    break
                }
                i++
            }
            return {
                images: images
            }
        },
        likeComic: async (id, isLike) =>  {
            var res = await Network.post(
                `${this.loadSetting('base_url')}/comics/${id}/like`,
                this.buildHeaders('POST', `comics/${id}/like`, this.loadData('token')),
                {}
            );
            if (res.status !== 200) {
                throw 'Invalid status code: ' + res.status
            }
            return 'ok'
        },
        onImageLoad: async (url, comicId, epId) => {
            return {
                url: url,
                headers: {
                    "user-agent": "okhttp/3.8.1",
                }
            }
        },
        onThumbnailLoad: (url) => {
            return {
                url: url,
                headers: {
                    "user-agent": "okhttp/3.8.1",
                }
            }
        },
        // 加载评论
        loadComments: async (comicId, subId, page, replyTo) => {
            // _user 可能为 null (用户已注销, 官方客户端同样判空), 单条坏评论不能拖垮整页
            function parseComment(c) {
                let user = c._user ?? {}
                let avatar = user.avatar
                return new Comment({
                    userName: user.name ?? "Unknown",
                    avatar: avatar && avatar.fileServer && avatar.path ? avatar.fileServer + '/static/' + avatar.path : undefined,
                    id: c._id,
                    content: c.content ?? "",
                    isLiked: c.isLiked,
                    score: c.likesCount ?? 0,
                    replyCount: c.commentsCount,
                    time: c.created_at,
                })
            }
            function parseCommentList(docs) {
                let out = []
                for (let c of (docs ?? [])) {
                    try {
                        out.push(parseComment(c))
                    } catch (e) {
                        // 跳过坏评论
                    }
                }
                return out
            }
            let comments = []

            let maxPage = 1

            if(replyTo) {
                let res = await Network.get(
                    `${this.loadSetting('base_url')}/comments/${replyTo}/childrens?page=${page}`,
                    this.buildHeaders('GET', `comments/${replyTo}/childrens?page=${page}`, this.loadData('token'))
                )
                if (res.status !== 200) {
                    throw 'Invalid status code: ' + res.status
                }
                let data = JSON.parse(res.body)
                comments = parseCommentList(data.data?.comments?.docs)
                maxPage = data.data?.comments?.pages ?? 1
            } else {
                let res = await Network.get(
                    `${this.loadSetting('base_url')}/comics/${comicId}/comments?page=${page}`,
                    this.buildHeaders('GET', `comics/${comicId}/comments?page=${page}`, this.loadData('token'))
                )
                if (res.status !== 200) {
                    throw 'Invalid status code: ' + res.status
                }
                let data = JSON.parse(res.body)
                comments = parseCommentList(data.data?.comments?.docs)
                maxPage = data.data?.comments?.pages ?? 1
            }
            return {
                comments: comments,
                maxPage: maxPage
            }
        },
        // 发送评论, 返回任意值表示成功
        // 注意签名 path 不能带前导 `/` (与官方客户端一致: `comments/xxx`), 否则签名错误
        sendComment: async (comicId, subId, content, replyTo) => {
            if(replyTo) {
                let res = await Network.post(
                    `${this.loadSetting('base_url')}/comments/${replyTo}`,
                    this.buildHeaders('POST', `comments/${replyTo}`, this.loadData('token')),
                    JSON.stringify({
                        content: content
                    })
                )
                if (res.status !== 200) {
                    throw 'Invalid status code: ' + res.status
                }
            } else {
                let res = await Network.post(
                    `${this.loadSetting('base_url')}/comics/${comicId}/comments`,
                    this.buildHeaders('POST', `comics/${comicId}/comments`, this.loadData('token')),
                    JSON.stringify({
                        content: content
                    })
                )
                if (res.status !== 200) {
                    throw 'Invalid status code: ' + res.status
                }
            }
            return 'ok'
        },
        likeComment: async (comicId, subId, commentId, isLike) => {
            let res = await Network.post(
                `${this.loadSetting('base_url')}/comments/${commentId}/like`,
                this.buildHeaders('POST', `comments/${commentId}/like`, this.loadData('token')),
                '{}'
            )
            if (res.status !== 200) {
                throw 'Invalid status code: ' + res.status
            }
            return 'ok'
        },
        onClickTag: (namespace, tag) => {
            if(namespace === 'Author') {
                return {
                    action: 'category',
                    keyword: tag,
                    param: 'a',
                }
            } else if (namespace === 'Categories') {
                return {
                    action: 'category',
                    keyword: tag,
                    param: 'c',
                }
            } else {
                return {
                    action: 'search',
                    keyword: tag,
                }
            }
        }
    }

    settings = {
        base_url: {
            title: "API地址(地址末尾不要添加斜杠)",
            type: "input",
            validator: null,
            default: Picacg.defaultApiUrl,
        },
        'imageQuality': {
            type: 'select',
            title: 'Image quality',
            options: [
                {
                    value: 'original',
                },
                {
                    value: 'medium'
                },
                {
                    value: 'low'
                }
            ],
            default: 'original',
        },
        'appChannel': {
            type: 'select',
            title: 'App channel',
            options: [
                {
                    value: '1',
                },
                {
                    value: '2'
                },
                {
                    value: '3'
                }
            ],
            default: '3',
        },
        'favoriteSort': {
            type: 'select',
            title: 'Favorite sort',
            options: [
                {
                    value: 'dd',
                    text: 'New to old'
                },
                {
                    value: 'da',
                    text: 'Old to new'
                },
            ],
            default: 'dd',
        },
        'punchIn': {
            title: 'Punch in',
            type: 'callback',
            buttonText: 'Punch',
            // 哔咔每日打卡 POST users/punch-in
            callback: async () => {
                if (!this.isLogged) {
                    throw 'Not logged in'
                }
                let base = this.loadSetting('base_url')
                let res = await Network.post(
                    `${base}/users/punch-in`,
                    this.buildHeaders('POST', 'users/punch-in', this.loadData('token')),
                    '{}'
                )
                if (res.status !== 200) {
                    throw 'Invalid status code: ' + res.status
                }
                let message = ""
                try {
                    let json = JSON.parse(res.body)
                    message = json.message ?? ""
                    let status = json.data?.res?.status ?? json.data?.res ?? ""
                    if (status) message += ` (${status})`
                } catch (e) {
                    message = res.body
                }
                UI.showMessage(message || 'ok')
            }
        }
    }

    translation = {
        'zh_CN': {
            'Picacg Random': "哔咔随机",
            'Picacg Latest': "哔咔最新",
            'Picacg H24': "哔咔日榜",
            'Picacg D7': "哔咔周榜",
            'Picacg D30': "哔咔月榜",
            'New to old': "新到旧",
            'Old to new': "旧到新",
            'Most likes': "最多喜欢",
            'Most nominated': "最多指名",
            'Day': "日",
            'Week': "周",
            'Month': "月",
            'Author': "作者",
            'Chinese Team': "汉化组",
            'Categories': "分类",
            'Tags': "标签",
            'Image quality': "图片质量",
            'App channel': "分流",
            'Favorite sort': "收藏排序",
            'Sort': "排序",
            'Categories': "分类",
            'Punch in': "每日打卡",
            'Punch': "打卡",
        },
        'zh_TW': {
            'Picacg Random': "哔咔隨機",
            'Picacg Latest': "哔咔最新",
            'Picacg H24': "哔咔日榜",
            'Picacg D7': "哔咔周榜",
            'Picacg D30': "哔咔月榜",
            'New to old': "新到舊",
            'Old to new': "舊到新",
            'Most likes': "最多喜歡",
            'Most nominated': "最多指名",
            'Day': "日",
            'Week': "周",
            'Month': "月",
            'Author': "作者",
            'Chinese Team': "漢化組",
            'Categories': "分類",
            'Tags': "標籤",
            'Image quality': "圖片質量",
            'App channel': "分流",
            'Favorite sort': "收藏排序",
            'Sort': "排序",
            'Categories': "分類",
            'Punch in': "每日打卡",
            'Punch': "打卡",
        },
    }
}
