class ShonenJumpPlus extends ComicSource {
  name = "少年ジャンプ＋";
  key = "shonen_jump_plus";
  version = "1.1.4";
  minAppVersion = "1.2.1";
  url =
    "https://cdn.jsdelivr.net/gh/Souitou-iop/venerax-configs-enhanced@main/shonen_jump_plus.js";

  deviceId = this.generateDeviceId();
  bearerToken = null;
  userAccountId = null;
  tokenExpiry = 0;
  latestVersion = "4.0.40";

  get headers() {
    return {
      "Origin": "https://shonenjumpplus.com",
      "Referer": "https://shonenjumpplus.com/",
      "X-Giga-Device-Id": this.deviceId,
      "User-Agent": `ShonenJumpPlus-Android/${this.latestVersion}`,
    };
  }

  apiBase = `https://shonenjumpplus.com/api/v1`;
  generateDeviceId() {
    let result = "";
    const chars = "0123456789abcdef";
    for (let i = 0; i < 16; i++) {
      result += chars[randomInt(0, chars.length - 1)];
    }
    return result;
  }

  async init() {
    // 通过 iTunes lookup 获取当前 App 版本 (比 HTML 抓取更稳定)。
    // 服务器会校验客户端版本号, 过旧会返回 410 UPDATE_REQUIRED。
    try {
      const url = "https://itunes.apple.com/lookup?id=875750302&country=jp";
      const resp = await Network.get(url);
      if (resp.status === 200) {
        const json = JSON.parse(resp.body);
        const ver = json?.results?.[0]?.version;
        if (ver && /^\d+\.\d+\.\d+$/.test(ver)) {
          this.latestVersion = ver;
        }
      }
    } catch (e) {
      // 保持默认 latestVersion, 版本仅需 >= 最低要求即可访问
    }
  }

  explore = [
    {
      title: "少年ジャンプ＋",
      type: "singlePageWithMultiPart",
      load: async () => {
        await this.ensureAuth();

        const response = await this.graphqlRequest("HomeCacheable", {});

        if (!response || !response.data || !response.data.homeSections) {
          throw "Cannot fetch home sections";
        }

        // 排行板块标题本地化 (サーバー返回日文标题)
        const rankTitles = {
          "総合": "综合排行",
          "注目": "注目排行",
          "読切": "短篇排行",
          "完結": "完结排行",
          "シェア": "分享排行",
        };

        const sections = response.data.homeSections;
        const result = {};
        const addPart = (title, comics) => {
          if (title && comics && comics.length > 0) result[title] = comics;
        };
        const parseSeries = (series) => {
          if (!series || !series.databaseId) return null;
          const cover = series.squareThumbnailUriTemplate ||
            series.horizontalThumbnailUriTemplate;
          return {
            id: series.databaseId,
            title: series.title || "",
            subTitle: series.author?.name || "",
            cover: this.replaceCoverUrl(cover),
            tags: [],
            description: series.author?.name || "",
          };
        };

        // 1. 每日排行: dailyRankings 含最近7天, 取日期最新的一天
        //    (原实现取 find() 第一个, 实际是一周前的旧榜)
        const dailySection = sections.find((section) =>
          section.__typename === "DailyRankingSection"
        );
        const dayRankings = (dailySection?.dailyRankings || [])
          .map((entry) => entry?.ranking)
          .filter((ranking) =>
            ranking && ranking.__typename === "DailyRanking" &&
            ranking.items?.edges?.length > 0
          );
        if (dayRankings.length > 0) {
          dayRankings.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
          const latest = dayRankings[dayRankings.length - 1];
          // date 为 UTC ISO, +9h 转 JST 取 月/日
          const jst = new Date(new Date(latest.date).getTime() + 9 * 3600000);
          const dateLabel = `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}`;
          const comics = latest.items.edges
            .map((edge) => edge.node)
            .filter((node) =>
              node.__typename === "DailyRankingValidItem" && node.product?.series
            )
            .map((node) => {
              const comic = parseSeries(node.product.series);
              if (comic) {
                const views = node.viewCount != null
                  ? ` · ${node.viewCount} views`
                  : "";
                comic.description = `#${node.rank}${views}`;
              }
              return comic;
            })
            .filter((comic) => comic !== null);
          addPart(`每日排行(${dateLabel})`, comics);
        }

        // 2. 系列排行: 総合/注目/読切/完結/シェア (各30件)
        //    ルーキー(RookieSeriesRanking) 指向外部 rookie.shonenjump.com, 无法在本源内打开, 跳过
        const rankingSection = sections.find((section) =>
          section.__typename === "RankingSection"
        );
        for (const entry of rankingSection?.rankings || []) {
          if (entry.ranking?.__typename !== "SeriesRanking") continue;
          const comics = (entry.ranking.series?.edges || [])
            .map((edge) => parseSeries(edge.node))
            .filter((comic) => comic !== null);
          addPart(
            rankTitles[entry.title] || entry.title,
            comics,
          );
        }

        // 3. 动态作品板块 (新連載はこちら / 最新の読切はこちら / アニメ化作品！等)
        for (const section of sections) {
          if (section.__typename !== "WorksSection") continue;
          const comics = (section.seriesList || [])
            .map((node) => parseSeries(node))
            .filter((comic) => comic !== null);
          addPart(section.title, comics);
        }

        // 4. 限时免费作品
        const freeSection = sections.find((section) =>
          section.__typename === "FreeOnlyNowSection"
        );
        if (freeSection) {
          const comics = (freeSection.seriesList || [])
            .map((node) => parseSeries(node?.series))
            .filter((comic) => comic !== null);
          addPart(freeSection.title || "限时免费", comics);
        }

        return result;
      },
    },
  ];

  search = {
    load: async (keyword, _, page) => {
      await this.ensureAuth();

      // 接口为游标分页(after), app 侧为页码分页; 缓存每个关键词的游标供下一页使用
      if (!page || page <= 1) page = 1;
      this._searchCursors = this._searchCursors || {};
      if (page === 1) delete this._searchCursors[keyword];
      const after = this._searchCursors[keyword] || null;

      const response = await this.graphqlRequest("SearchResult", {
        keyword,
        after,
      });
      const edges = response?.data?.search?.edges || [];
      const pageInfo = response?.data?.search?.pageInfo || {};

      // 查询限定 types: [SERIES] (MagazineLabel 杂志条目无法在本源打开)
      const comics = edges.map(({ node }) => {
        if (node.__typename !== "Series") return null;
        const authors = (node.author?.name || "").split(/\s*\/\s*/).filter(
          Boolean,
        );
        return new Comic({
          id: node.databaseId,
          title: node.title || "",
          cover: this.replaceCoverUrl(node.thumbnailUriTemplate),
          description: node.description || "",
          tags: authors,
        });
      }).filter(Boolean);

      if (pageInfo.hasNextPage && pageInfo.endCursor) {
        this._searchCursors[keyword] = pageInfo.endCursor;
      }

      return {
        comics,
        maxPage: pageInfo.hasNextPage ? page + 1 : page,
      };
    },
  };

  comic = {
    loadInfo: async (id) => {
      await this.ensureAuth();
      // 并发: 系列详情 + 章节列表 (两个 GraphQL 查询互不依赖, 原串行浪费一个 RTT)
      const [seriesData, episodes] = await Promise.all([
        this.fetchSeriesDetail(id),
        this.fetchEpisodes(id),
      ]);

      const { chapters, latestPublishAt } = episodes.reduce(
        (acc, ep) => ({
          chapters: {
            ...acc.chapters,
            [ep.databaseId]: ep.title || "",
          },
          latestPublishAt:
            ep.publishedAt && ep.publishedAt > acc.latestPublishAt
              ? ep.publishedAt
              : acc.latestPublishAt,
        }),
        { chapters: {}, latestPublishAt: "" },
      );

      const maxDate = latestPublishAt > seriesData.openAt
        ? latestPublishAt
        : seriesData.openAt;
      const updateDate = new Date(new Date(maxDate) - 60 * 60 * 1000);
      const authors = (seriesData.author?.name || "").split(/\s*\/\s*/).filter(
        Boolean,
      );

      const statusMap = {
        "ONGOING": "连载中",
        "FINISHED": "已完结",
        "HIATUS": "休载中",
        "SUSPENDED": "休载中",
      };
      const tags = {
        "Author": authors,
        "Update": [updateDate.toISOString().slice(0, 10)],
      };
      const status = seriesData.serialInfo?.status;
      if (status) tags["Status"] = [statusMap[status] || status];
      if (seriesData.serialUpdateScheduleLabel) {
        tags["Schedule"] = [seriesData.serialUpdateScheduleLabel];
      }

      return new ComicDetails({
        title: seriesData.title || "",
        subtitle: authors.join(" / "),
        cover: this.replaceCoverUrl(seriesData.thumbnailUriTemplate),
        description: seriesData.description || "",
        tags,
        url: `https://shonenjumpplus.com/app/episode/${seriesData.publisherId}`,
        chapters,
      });
    },

    loadEp: async (comicId, epId) => {
      await this.ensureAuth();
      const episodeId = this.normalizeEpisodeId(epId);
      const episodeData = await this.fetchEpisodePages(episodeId);

      if (!this.isEpisodeAccessible(episodeData)) {
        await this.handleEpisodePurchase(episodeData);
        return this.comic.loadEp(comicId, epId);
      }

      return this.buildImageUrls(episodeData);
    },

    onImageLoad: (url) => {
      const [cleanUrl, token] = url.split("?token=");
      return {
        url: cleanUrl,
        headers: { "X-Giga-Page-Image-Auth": token },
      };
    },

    onClickTag: (namespace, tag) => {
      if (namespace === "Author") {
        return {
          action: "search",
          keyword: `${tag}`,
          param: null,
        };
      }
      throw "Unsupported tag namespace: " + namespace;
    },
  };

  async ensureAuth() {
    if (!this.bearerToken || Date.now() > this.tokenExpiry) {
      await this.fetchBearerToken();
    }
  }

  async graphqlRequest(operationName, variables) {
    const payload = {
      operationName,
      variables,
      query: GraphQLQueries[operationName],
    };
    const response = await Network.post(
      `${this.apiBase}/graphql`,
      {
        ...this.headers,
        "Authorization": `Bearer ${this.bearerToken}`,
        "Accept": "application/json",
        "X-APOLLO-OPERATION-NAME": operationName,
        "Content-Type": "application/json",
      },
      JSON.stringify(payload),
    );

    if (response.status !== 200) throw `Invalid status: ${response.status}`;
    return JSON.parse(response.body);
  }

  normalizeEpisodeId(epId) {
    if (typeof epId === "object") return epId.id;
    if (typeof epId === "string" && epId.includes("/")) {
      return epId.split("/").pop();
    }
    return epId;
  }

  replaceCoverUrl(url) {
    return (url || "").replace("{height}", "1500").replace(
      "{width}",
      "1500",
    ) || "";
  }

  async fetchBearerToken() {
    const response = await Network.post(
      `${this.apiBase}/user_account/access_token`,
      this.headers,
      "",
    );
    const { access_token, user_account_id } = JSON.parse(
      response.body,
    );
    this.bearerToken = access_token;
    this.userAccountId = user_account_id;
    this.tokenExpiry = Date.now() + 3600000;
  }

  async fetchSeriesDetail(id) {
    const response = await this.graphqlRequest("SeriesDetail", { id });
    return response?.data?.series || {};
  }

  async fetchEpisodes(id) {
    const response = await this.graphqlRequest(
      "SeriesDetailEpisodeList",
      { id, episodeOffset: 0, episodeFirst: 1500, episodeSort: "NUMBER_ASC" },
    );
    const episodes = (response?.data?.series?.episodes?.edges || []).map(
      (edge) => edge.node
    );
    return episodes;
  }

  async fetchEpisodePages(episodeId) {
    const response = await this.graphqlRequest(
      "EpisodeViewerConditionallyCacheable",
      { episodeID: episodeId },
    );
    return response?.data?.episode || {};
  }

  isEpisodeAccessible({ purchaseInfo }) {
    return purchaseInfo?.isFree || purchaseInfo?.hasPurchased ||
      purchaseInfo?.hasRented;
  }

  async handleEpisodePurchase(episodeData) {
    const { id, purchaseInfo } = episodeData;
    const { purchasableViaOnetimeFree, rentable, unitPrice } = purchaseInfo ||
      {};

    if (purchasableViaOnetimeFree) await this.consumeOnetimeFree(id);
    if (rentable) await this.rentChapter(id, unitPrice);
  }

  buildImageUrls({ pageImages, pageImageToken }) {
    const validImages = pageImages.edges.flatMap((edge) => edge.node?.src)
      .filter(Boolean);
    return {
      images: validImages.map((url) => `${url}?token=${pageImageToken}`),
    };
  }

  async consumeOnetimeFree(episodeId) {
    const response = await this.graphqlRequest("ConsumeOnetimeFree", {
      input: { id: episodeId },
    });
    return response?.data?.consumeOnetimeFree?.isSuccess;
  }

  async rentChapter(episodeId, unitPrice, retryCount = 0) {
    if (retryCount > 3) {
      throw "Failed to rent chapter after multiple attempts.";
    }
    const response = await this.graphqlRequest("Rent", {
      input: { id: episodeId, unitPrice },
    });

    if (response.errors?.[0]?.extensions?.code === "FAILED_TO_USE_POINT") {
      await this.refreshAccount();
      return this.rentChapter(episodeId, unitPrice, retryCount + 1);
    }

    this.userAccountId = response?.data?.rent?.userAccount?.databaseId;
    return true;
  }

  async refreshAccount() {
    this.deviceId = this.generateDeviceId();
    this.bearerToken = this.userAccountId = null;
    this.tokenExpiry = 0;
    await this.fetchBearerToken();
    await this.addUserDevice();
  }

  async addUserDevice() {
    await this.graphqlRequest("AddUserDevice", {
      input: {
        deviceName: `Android ${21 + Math.floor(Math.random() * 14)}`,
        modelName: `Device-${Math.random().toString(36).slice(2, 10)}`,
        osName: `Android ${9 + Math.floor(Math.random() * 6)}`,
      },
    });
    this.addUserDeviceCalled = true;
  }
}

const GraphQLQueries = {
  "SearchResult": `query SearchResult($after: String, $keyword: String!) {
        search(after: $after, first: 50, keyword: $keyword, types: [SERIES]) {
            pageInfo { hasNextPage endCursor }
            edges {
                node {
                    __typename
                    ... on Series { id databaseId title thumbnailUriTemplate author { name } description }
                }
            }
        }
    }`,
  "SeriesDetail": `query SeriesDetail($id: String!) {
        series(databaseId: $id) {
            id databaseId title thumbnailUriTemplate
            author { name }
            description
            hashtags serialUpdateScheduleLabel
            serialInfo { status isTrial }
            openAt
            publisherId
        }
    }`,
  "SeriesDetailEpisodeList":
    `query SeriesDetailEpisodeList($id: String!, $episodeOffset: Int, $episodeFirst: Int, $episodeSort: ReadableProductSorting) {
        series(databaseId: $id) {
            episodes: readableProducts(types: [EPISODE], first: $episodeFirst, offset: $episodeOffset, sort: $episodeSort) {
                edges { node { databaseId title publishedAt } }
            }
        }
    }`,
  "EpisodeViewerConditionallyCacheable":
    `query EpisodeViewerConditionallyCacheable($episodeID: String!) {
        episode(databaseId: $episodeID) {
            id pageImages { edges { node { src } } } pageImageToken
            purchaseInfo {
                isFree hasPurchased hasRented
                purchasableViaOnetimeFree rentable unitPrice
            }
        }
    }`,
  "ConsumeOnetimeFree":
    `mutation ConsumeOnetimeFree($input: ConsumeOnetimeFreeInput!) {
        consumeOnetimeFree(input: $input) { isSuccess }
    }`,
  "Rent": `mutation Rent($input: RentInput!) {
        rent(input: $input) {
            userAccount { databaseId }
        }
    }`,
  "AddUserDevice": `mutation AddUserDevice($input: AddUserDeviceInput!) {
        addUserDevice(input: $input) { isSuccess }
    }`,
  "HomeCacheable": `query HomeCacheable {
    homeSections {
      __typename
      ...DailyRankingSection
      ... on RankingSection {
        title
        rankings {
          title
          ranking {
            __typename
            ... on SeriesRanking {
              series(first: 30) {
                edges { node { __typename ...ExploreSeries } }
              }
            }
          }
        }
      }
      ... on WorksSection {
        title
        seriesList { __typename ...ExploreSeries }
      }
      ... on FreeOnlyNowSection {
        title
        seriesList { __typename series { __typename ...ExploreSeries } }
      }
    }
  }
  fragment ExploreSeries on Series {
    id databaseId title
    author { name }
    horizontalThumbnailUriTemplate: subThumbnailUri(type: HORIZONTAL_WITH_LOGO)
    squareThumbnailUriTemplate: subThumbnailUri(type: SQUARE_WITHOUT_LOGO)
  }
  fragment SerialInfoIcon on SerialInfo {
    isOriginal isIndies
  }
  fragment DailyRankingSeries on Series {
    id databaseId publisherId title
    horizontalThumbnailUriTemplate: subThumbnailUri(type: HORIZONTAL_WITH_LOGO)
    squareThumbnailUriTemplate: subThumbnailUri(type: SQUARE_WITHOUT_LOGO)
    isNewOngoing supportsOnetimeFree
    serialInfo {
      __typename ...SerialInfoIcon
      status isTrial
    }
    jamEpisodeWorkType
  }
  fragment DailyRankingItem on DailyRankingItem {
    __typename
    ... on DailyRankingValidItem {
      product {
        __typename
        ... on Episode {
          id databaseId publisherId commentCount
          series {
            __typename ...DailyRankingSeries
          }
        }
        ... on SpecialContent {
          publisherId linkUrl
          series {
            __typename ...DailyRankingSeries
          }
        }
      }
      badge { name label }
      label rank viewCount
    }
    ... on DailyRankingInvalidItem {
      publisherWorkId
    }
  }
  fragment DailyRanking on DailyRanking {
    date firstPositionSeriesId
    items {
      edges {
        node {
          __typename ...DailyRankingItem
        }
      }
    }
  }
  fragment DailyRankingSection on DailyRankingSection {
    title
    dailyRankings {
      ranking {
        __typename ...DailyRanking
      }
    }
  }`,
};
