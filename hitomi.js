/** @type {import('./_venera_.js')} */

/**
 * hitomi.la (hitomi.la) —— Venera 漫画源（完全重写版 v2）
 * ============================ 原站分析 ============================
 * 站点程序: 自研 PHP/静态混合站点; 页面模板由 ltn CDN 提供, 列表与搜索全部走
 *           「索引二进制 + galleryblock 片段」而非 HTML 列表页。
 * 主域名:   https://hitomi.la/
 * 内容 CDN: https://ltn.gold-usergeneratedcontent.net/   (索引/片段/gg.js)
 *           https://tn.gold-usergeneratedcontent.net/    (缩略图, 需 Referer)
 *           https://a*.gold-usergeneratedcontent.net/    (整图, 子域由 gg.js 计算)
 * 分析依据: _analysis/fixtures/hitomi/ 下 2026-09-13 抓取的夹具
 *           (capture.json + manifest.jsonl 36 条; btree.json 为真实 B-tree 节点)
 *
 * 1) 首页/列表
 *    - 列表不是 HTML, 而是 nozomi(小端 int32 序列的 gallery id 数组):
 *      · 单标签/默认排序: 无前缀 /<tag>-<lang>.nozomi, 配合 HTTP Range 分页
 *        (每页 25 个 id = 100 字节; 总数由 Content-Range 得出)
 *      · 多标签交集: 前缀 /n/ 取整份 nozomi 后在内存求交/差/并
 *    - 每个 id 再取 https://ltn.gold-usergeneratedcontent.net/galleryblock/<gid>.html
 *      (热链保护: 必须带 Referer: https://hitomi.la/; 夹具 galleryblock_*.html)
 *      选择器: h1.lillie > a[href$="-<gid>.html"]、.artist-list li a、
 *              table.dj-desc tr(Series/Type/Language/Tags)、.relatedtags li a、
 *              p.dj-date.date、img[data-src]
 * 2) 搜索
 *    - 词法: npmspace:tag 形式, 支持 -排除 与 or 分组; 无 namespace 的裸词走
 *      B-tree: galleriesindex/galleries.<version>.index (464B/节点, big-endian),
 *      key = sha256(term)[0:4], 命中后按 .data 的 [offset,length] 取 id 数组。
 *    - <version> 由 galleriesindex/version?_=<ts> 返回 (夹具 index_version.txt)
 * 3) 详情
 *    - https://ltn.gold-usergeneratedcontent.net/galleries/<gid>.js
 *      形如 `var galleryinfo = {...}` (前缀 18 字节后为 JSON)
 *      字段: title/galleryurl/files[{hash,name,hasavif}]/tags[{tag,female,male}]/
 *            artists/parodys/characters/groups/languages/related/blocked/date
 * 4) 章节/阅读
 *    - 一个 gallery = 一个章节, files 即全部图片。
 *    - 整图 URL 由 gg.js (gg.b 目录盐 + gg.s(hash) 分桶 + 子域计算) 推导;
 *      缩略图 https://tn.gold-usergeneratedcontent.net/{avifbigtn|avifsmallbigtn}/
 *      <hash[-1]>/<hash[-3:-1]>/<hash>.avif。
 *    - 未实现: 账号/收藏/评论 (原站相关能力依赖登录, 夹具未覆盖)。
 * ================================================================
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const domain2 = "gold-usergeneratedcontent.net";
const domain = "ltn." + domain2;
const tn_domain = "tn." + domain2;
const refererUrl = "https://hitomi.la/";

const nozomiextension = ".nozomi";
const compressed_nozomi_prefix = "n";
const galleriesdir = "galleries";
const galleryblockdir = "galleryblock";
const galleries_index_dir = "galleriesindex";
const max_node_size = 464;
const B = 16;

const namespaces = [
  "artist",
  "character",
  "female",
  "group",
  "language",
  "male",
  "series",
  "tag",
  "type",
];

// 会话级索引版本
let galleries_index_version = "";
let versionCacheTime = 0;
const VERSION_CACHE_TTL = 5 * 60 * 1000;
let versionPromise = undefined;

// gg.js 解析结果 (整图子域计算所需)
let gg = undefined;

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------
function toISO8601(s) {
  return String(s).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
}

function formatDate(date) {
  if (typeof date === "string") date = new Date(toISO8601(date));
  if (!(date instanceof Date) || isNaN(date.getTime())) return "";
  const pad = (n) => (n < 10 ? "0" + n : String(n));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const hash_term = function (term) {
  return new Uint8Array(Convert.sha256(Convert.encodeUtf8(term))).slice(0, 4);
};

function getUint64(view, byteOffset) {
  const hi = view.getUint32(byteOffset, false);
  const lo = view.getUint32(byteOffset + 4, false);
  return hi * 2 ** 32 + lo;
}

function decodeBigEndianInt32Array(data, byteOffset = 0, count) {
  if (count === undefined) count = (data.byteLength - byteOffset) >> 2;
  const out = new Array(count);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < count; i++) out[i] = view.getInt32(byteOffset + i * 4, false);
  return out;
}

function compareArrayBuffers(dv1, dv2) {
  const top = Math.min(dv1.length, dv2.length);
  for (let i = 0; i < top; i++) {
    if (dv1[i] < dv2[i]) return -1;
    if (dv1[i] > dv2[i]) return 1;
  }
  return 0;
}

function intersectAll(arrays) {
  if (!arrays.length) return [];
  if (arrays.length === 1) return arrays[0];
  const rest = arrays.slice(1).sort((a, b) => a.length - b.length);
  let acc = arrays[0];
  for (const arr of rest) {
    const set = new Set(arr);
    acc = acc.filter((x) => set.has(x));
  }
  return acc;
}

function subtract(arrA, arrB) {
  const setB = new Set(arrB);
  return arrA.filter((x) => !setB.has(x));
}

function unionAll(arrays) {
  const set = new Set();
  for (const arr of arrays) for (const x of arr) set.add(x);
  return Array.from(set);
}

function shuffleArray(arr) {
  const array = arr.slice();
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// ---------------------------------------------------------------------------
// 缓存层 (按索引版本失效)
// ---------------------------------------------------------------------------
const nodeCache = new Map(); // "version:address" -> node
const dataCache = new Map(); // "version:offset:length" -> {galleryids,bytes}
const nozomiCache = new Map(); // url -> {galleryids,bytes,time}
const galleryBlockCache = new Map(); // gid -> block

const inflightNodes = new Map();
const inflightData = new Map();
const inflightNozomi = new Map();
const inflightGalleryBlocks = new Map();

let dataCacheBytes = 0;
let nozomiCacheBytes = 0;
const DATA_CACHE_LIMIT = 16 * 1024 * 1024;
const NOZOMI_CACHE_LIMIT = 16 * 1024 * 1024;
const NOZOMI_CACHE_ENTRY_LIMIT = 8 * 1024 * 1024;
const NOZOMI_CACHE_TTL = 5 * 60 * 1000;
const GALLERY_BLOCK_CACHE_LIMIT = 500;

function clearIndexCaches() {
  nodeCache.clear();
  dataCache.clear();
  dataCacheBytes = 0;
  inflightNodes.clear();
  inflightData.clear();
}

// ---------------------------------------------------------------------------
// B-tree 索引 (galleriesindex/galleries.<version>.index)
// ---------------------------------------------------------------------------
function decodeNode(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;

  const keys = [];
  const number_of_keys = view.getInt32(pos, false);
  pos += 4;
  for (let i = 0; i < number_of_keys; i++) {
    const key_size = view.getInt32(pos, false);
    if (!key_size || key_size > 32) throw new Error("fatal: bad key_size " + key_size);
    pos += 4;
    keys.push(data.slice(pos, pos + key_size));
    pos += key_size;
  }

  const datas = [];
  const number_of_datas = view.getInt32(pos, false);
  pos += 4;
  for (let i = 0; i < number_of_datas; i++) {
    const offset = getUint64(view, pos);
    pos += 8;
    const length = view.getInt32(pos, false);
    pos += 4;
    datas.push([offset, length]);
  }

  const subnode_addresses = [];
  for (let i = 0; i < B + 1; i++) {
    subnode_addresses.push(getUint64(view, pos));
    pos += 8;
  }

  return { keys, datas, subnode_addresses };
}

function locateKeyInNode(key, node) {
  let i;
  for (i = 0; i < node.keys.length; i++) {
    const cmp = compareArrayBuffers(key, node.keys[i]);
    if (cmp <= 0) break;
  }
  const there = i < node.keys.length && compareArrayBuffers(key, node.keys[i]) === 0;
  return [there, i];
}

function isLeafNode(node) {
  return node.subnode_addresses.every((a) => !a);
}

async function getUrlAtRange(url, range) {
  const headers = { referer: refererUrl };
  if (range) headers.range = `bytes=${range[0]}-${range[1]}`;
  const res = await Network.fetchBytes("GET", url, headers);
  if (res.status !== 200 && res.status !== 206) throw new Error("getUrlAtRange " + res.status);
  return new Uint8Array(res.body);
}

async function getNodeAtAddress(address) {
  if (!galleries_index_version) throw new Error("galleries_index_version is not set");
  const cacheKey = galleries_index_version + ":" + address;
  const cached = nodeCache.get(cacheKey);
  if (cached) return cached;
  const inflight = inflightNodes.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const requestVersion = galleries_index_version;
    const url =
      "https://" + domain + "/" + galleries_index_dir + "/galleries." + requestVersion + ".index";
    const data = await getUrlAtRange(url, [address, address + max_node_size - 1]);
    const node = decodeNode(data);
    if (node && galleries_index_version === requestVersion) nodeCache.set(cacheKey, node);
    return node;
  })();

  inflightNodes.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inflightNodes.delete(cacheKey);
  }
}

async function BSearch(key, node) {
  if (!node || !node.keys.length) return undefined;

  const [there, where] = locateKeyInNode(key, node);
  if (there) return node.datas[where];
  if (isLeafNode(node)) return undefined;

  if (node.subnode_addresses[where] == 0) {
    console.error("non-root node address 0");
    return undefined;
  }
  const subnode = await getNodeAtAddress(node.subnode_addresses[where]);
  return await BSearch(key, subnode);
}

async function getGalleryIdsFromData(data) {
  const [offset, length] = data;
  if (length > 100000000 || length <= 0) throw new Error("length " + length + " is too long");
  const cacheKey = galleries_index_version + ":" + offset + ":" + length;
  const cached = dataCache.get(cacheKey);
  if (cached) {
    dataCache.delete(cacheKey);
    dataCache.set(cacheKey, cached);
    return cached.galleryids;
  }
  const inflight = inflightData.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const requestVersion = galleries_index_version;
    const url =
      "https://" + domain + "/" + galleries_index_dir + "/galleries." + requestVersion + ".data";
    const inbuf = await getUrlAtRange(url, [offset, offset + length - 1]);
    const view = new DataView(inbuf.buffer, inbuf.byteOffset, inbuf.byteLength);
    const number_of_galleryids = view.getInt32(0, false);
    const expected_length = number_of_galleryids * 4 + 4;
    if (number_of_galleryids > 10000000 || number_of_galleryids <= 0) {
      throw new Error("bad number_of_galleryids " + number_of_galleryids);
    }
    if (inbuf.byteLength !== expected_length) {
      throw new Error("inbuf.byteLength " + inbuf.byteLength + " !== " + expected_length);
    }
    const galleryids = decodeBigEndianInt32Array(inbuf, 4, number_of_galleryids);
    if (length < 4 * 1024 * 1024 && galleries_index_version === requestVersion) {
      dataCache.set(cacheKey, { galleryids, bytes: length });
      dataCacheBytes += length;
      while (dataCacheBytes > DATA_CACHE_LIMIT && dataCache.size > 1) {
        const oldestKey = dataCache.keys().next().value;
        dataCacheBytes -= dataCache.get(oldestKey).bytes;
        dataCache.delete(oldestKey);
      }
    }
    return galleryids;
  })();

  inflightData.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inflightData.delete(cacheKey);
  }
}

async function getIndexVersion() {
  const url = "https://" + domain + "/" + galleries_index_dir + "/version?_=" + Date.now();
  const resp = await Network.get(url, { referer: refererUrl });
  if (resp.status !== 200) throw new Error("version " + resp.status);
  return String(resp.body).trim();
}

async function updateGalleriesIndexVersion(force = false) {
  const now = Date.now();
  if (!force && versionCacheTime && now - versionCacheTime < VERSION_CACHE_TTL) return;
  if (versionPromise) return versionPromise;

  versionPromise = (async () => {
    const newVersion = await getIndexVersion();
    if (newVersion && newVersion !== galleries_index_version) {
      galleries_index_version = newVersion;
      clearIndexCaches();
    }
    versionCacheTime = Date.now();
  })();

  try {
    return await versionPromise;
  } finally {
    versionPromise = undefined;
  }
}

async function getGalleryIdsForQueryWithoutNamespace(query) {
  await updateGalleriesIndexVersion();
  const normalized = query.replace(/_/g, " ");
  const key = hash_term(normalized);
  const node = await getNodeAtAddress(0);
  const data = await BSearch(key, node);
  if (!data) {
    // 索引更新后版本号缓存可能过期, 强制刷新一次再试
    const oldVersion = galleries_index_version;
    await updateGalleriesIndexVersion(true);
    if (galleries_index_version === oldVersion) return [];
    const node2 = await getNodeAtAddress(0);
    const data2 = await BSearch(key, node2);
    if (!data2) return [];
    return await getGalleryIdsFromData(data2);
  }
  return await getGalleryIdsFromData(data);
}

// ---------------------------------------------------------------------------
// nozomi (gallery id 序列)
// ---------------------------------------------------------------------------
function nozomiAddressFromState(state, with_prefix) {
  const prefix = with_prefix ? compressed_nozomi_prefix + "/" : "";
  const base = "https://" + domain + "/" + prefix;
  const lang = state.language || "all";
  const tag = encodeURI(state.tag || "index");

  if (state.orderby !== "date" || state.orderbykey === "published") {
    if (state.area === "all") {
      return base + [state.orderby, [state.orderbykey, lang].join("-")].join("/") + nozomiextension;
    }
    return (
      base +
      [state.area, state.orderby, state.orderbykey, [tag, lang].join("-")].join("/") +
      nozomiextension
    );
  }

  if (state.area === "all") return base + [tag, lang].join("-") + nozomiextension;
  return base + [state.area, [tag, lang].join("-")].join("/") + nozomiextension;
}

async function getGalleryIdsFromState(state) {
  const url = nozomiAddressFromState(state, true);
  const inflight = inflightNozomi.get(url);
  if (inflight) return inflight;

  const now = Date.now();
  const cached = nozomiCache.get(url);
  if (cached) {
    if (now - cached.time < NOZOMI_CACHE_TTL) {
      nozomiCache.delete(url);
      nozomiCache.set(url, cached);
      return cached.galleryids;
    }
    nozomiCacheBytes -= cached.bytes;
    nozomiCache.delete(url);
  }

  const promise = (async () => {
    const data = await getUrlAtRange(url);
    const galleryids = decodeBigEndianInt32Array(data);
    if (data.byteLength > 0 && data.byteLength <= NOZOMI_CACHE_ENTRY_LIMIT) {
      while (nozomiCacheBytes + data.byteLength > NOZOMI_CACHE_LIMIT && nozomiCache.size > 0) {
        const oldestKey = nozomiCache.keys().next().value;
        nozomiCacheBytes -= nozomiCache.get(oldestKey).bytes;
        nozomiCache.delete(oldestKey);
      }
      if (data.byteLength <= NOZOMI_CACHE_LIMIT) {
        nozomiCache.set(url, { galleryids, bytes: data.byteLength, time: Date.now() });
        nozomiCacheBytes += data.byteLength;
      }
    }
    return galleryids;
  })();

  inflightNozomi.set(url, promise);
  try {
    return await promise;
  } finally {
    inflightNozomi.delete(url);
  }
}

async function getGalleryIdsAndCount({ range, state }) {
  const headers = { referer: refererUrl };
  if (range) headers.range = range;
  const resp = await Network.fetchBytes("GET", nozomiAddressFromState(state, false), headers);
  if (resp.status !== 200 && resp.status !== 206) throw `failed fetch: ${resp.status}`;

  let itemCount = 0;
  const total = parseInt((resp.headers["content-range"] || "").replace(/^[Bb]ytes \d+-\d+\//, ""));
  if (!isNaN(total) && total > 0) itemCount = total / 4;

  const bytes = resp.body ? new Uint8Array(resp.body) : new Uint8Array(0);
  return { galleryids: decodeBigEndianInt32Array(bytes), count: itemCount };
}

async function getSingleTagSearchPage(state, page) {
  return await getGalleryIdsAndCount({
    state,
    range: "bytes=" + `${page * 100}-${(page + 1) * 100 - 1}`,
  });
}

// ---------------------------------------------------------------------------
// 搜索词法
// ---------------------------------------------------------------------------
function parseQuery(query) {
  const positive_terms = [];
  const negative_terms = [];
  let or_terms = [[]];
  const terms = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean);

  terms.forEach((term, i) => {
    if (term === "or") return;

    let namespace = undefined;
    let value = "";
    if (term.split("").filter((n) => n === ":").length > 1) {
      throw new Error("不合法的标签，请使用namespace:tag的格式");
    }
    if (term.includes(":")) {
      const splits = term.split(":");
      const left = splits[0].replace(/^-/, "");
      if (namespaces.includes(left)) namespace = left;
      else throw new Error("不合法的namespace");
      if (!splits[1]) throw new Error("不合法，标签为空");
      value = splits[1].replace(/_/g, " ");
    } else {
      value = term.replace(/_/g, " ");
    }

    const or_previous = i > 0 && terms[i - 1] === "or";
    const or_next = i + 1 < terms.length && terms[i + 1] === "or";
    if (or_previous || or_next) {
      if (term.match(/^-/)) throw new Error("不合法，或搜索中只能使用正向关键词");
      or_terms[or_terms.length - 1].push({ namespace, value });
      if (!or_next) or_terms.push([]);
      return;
    }

    if (term.match(/^-/)) negative_terms.push({ namespace, value });
    else positive_terms.push({ namespace, value });
  });

  or_terms.filter((n) => n.length === 1).forEach((n) => positive_terms.push(n[0]));
  or_terms = or_terms.filter((n) => n.length > 1);
  if ((or_terms.length > 0 || negative_terms.length > 0) && positive_terms.length === 0) {
    positive_terms.push({ value: "" });
  }
  return { positive_terms, negative_terms, or_terms };
}

async function multiTagSearch(options) {
  const stateFor = (n) => {
    if (!n.value) {
      return {
        area: "all",
        tag: "index",
        language: "all",
        orderby: options.orderby,
        orderbykey: options.orderbykey,
        orderbydirection: options.orderbydirection,
      };
    }
    if (!n.namespace) return null;
    if (n.namespace === "language") {
      return {
        area: "all",
        tag: "index",
        language: n.value,
        orderby: options.orderby,
        orderbykey: options.orderbykey,
        orderbydirection: options.orderbydirection,
      };
    }
    return {
      area: n.namespace === "female" || n.namespace === "male" ? "tag" : n.namespace,
      tag:
        n.namespace === "female"
          ? "female:" + n.value
          : n.namespace === "male"
          ? "male:" + n.value
          : n.value,
      language: "all",
      orderby: options.orderby,
      orderbykey: options.orderbykey,
      orderbydirection: options.orderbydirection,
    };
  };

  const getPromise = (n) => {
    if (!n.namespace) {
      if (!n.value) return getGalleryIdsFromState(stateFor(n));
      return getGalleryIdsForQueryWithoutNamespace(n.value);
    }
    return getGalleryIdsFromState(stateFor(n));
  };

  const parsed = parseQuery(options.term);
  const promises = [
    ...parsed.positive_terms.map(getPromise),
    ...parsed.negative_terms.map(getPromise),
    ...parsed.or_terms.flat().map(getPromise),
  ];
  const result = await Promise.all(promises);

  const lp = parsed.positive_terms.length;
  const ln = parsed.negative_terms.length;
  let r = intersectAll(result.slice(0, lp));

  if (ln > 0) r = subtract(r, unionAll(result.slice(lp, lp + ln)));

  let i = lp + ln;
  const orGroups = [];
  for (const or_term of parsed.or_terms) {
    const group = result.slice(i, i + or_term.length);
    let totalLength = 0;
    for (const arr of group) totalLength += arr.length;
    orGroups.push({ group, totalLength });
    i += or_term.length;
  }
  orGroups.sort((a, b) => a.totalLength - b.totalLength);
  for (const { group } of orGroups) r = intersectAll([r, unionAll(group)]);

  return r;
}

async function search(options) {
  const parsed = parseQuery(options.term);
  const state = {
    area: "all",
    tag: "index",
    language: "all",
    orderby: options.orderby,
    orderbykey: options.orderbykey,
    orderbydirection: options.orderbydirection,
  };

  const simpleSingle =
    (parsed.negative_terms.length === 0 &&
      parsed.or_terms.length === 0 &&
      parsed.positive_terms.length === 1) ||
    (parsed.positive_terms.length === 0 &&
      parsed.negative_terms.length === 0 &&
      parsed.or_terms.length === 0);

  const singleNamespace =
    parsed.negative_terms.length === 0 &&
    parsed.or_terms.length === 0 &&
    parsed.positive_terms.length === 1 &&
    parsed.positive_terms[0].namespace &&
    options.orderbydirection === "desc";

  if (singleNamespace) {
    const n = parsed.positive_terms[0];
    if (n.namespace === "language") {
      state.language = n.value;
    } else {
      state.area = n.namespace === "female" || n.namespace === "male" ? "tag" : n.namespace;
      state.tag =
        n.namespace === "female"
          ? "female:" + n.value
          : n.namespace === "male"
          ? "male:" + n.value
          : n.value;
    }
    const { galleryids, count } = await getSingleTagSearchPage(state, 0);
    return { type: "single", gids: galleryids, count, state };
  }

  if (simpleSingle && !options.term.trim() && options.orderbydirection === "desc") {
    const { galleryids, count } = await getSingleTagSearchPage(state, 0);
    return { type: "single", gids: galleryids, count, state };
  }

  const gids = await multiTagSearch(options);
  const rgids =
    options.orderbydirection === "random"
      ? shuffleArray(gids)
      : options.orderbydirection === "asc"
      ? gids.slice().reverse()
      : gids;
  return { type: "all", gids: rgids, count: rgids.length };
}

// ---------------------------------------------------------------------------
// galleryblock 片段
// ---------------------------------------------------------------------------
async function getSingleGalleryBlock(gid) {
  const cacheKey = String(gid);
  const cached = galleryBlockCache.get(cacheKey);
  if (cached) {
    galleryBlockCache.delete(cacheKey);
    galleryBlockCache.set(cacheKey, cached);
    return cached;
  }
  const inflight = inflightGalleryBlocks.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const url = "https://" + domain + "/" + galleryblockdir + "/" + gid + ".html";
    const res = await Network.get(url, { referer: refererUrl });
    if (res.status !== 200) throw new Error("galleryblock " + gid + ": " + res.status);
    const block = parseGalleryBlockInfo(res.body);
    galleryBlockCache.set(cacheKey, block);
    while (galleryBlockCache.size > GALLERY_BLOCK_CACHE_LIMIT) {
      galleryBlockCache.delete(galleryBlockCache.keys().next().value);
    }
    return block;
  })();

  inflightGalleryBlocks.set(cacheKey, promise);
  try {
    return await promise;
  } catch (e) {
    // 单个坏块不拖垮整页 (最多 25 并发), 用占位块保留位置
    return {
      gid: String(gid),
      title: `Gallery ${gid}`,
      type: undefined,
      language: undefined,
      artists: [],
      series: [],
      females: [],
      males: [],
      others: [],
      thumbnail_hashs: [],
      posted_time: new Date(0),
    };
  } finally {
    inflightGalleryBlocks.delete(cacheKey);
  }
}

async function getGalleryBlocks(gids) {
  if (gids.length > 25) throw new Error("Be careful: too many blocks");
  return await Promise.all(gids.map((n) => getSingleGalleryBlock(n)));
}

function parseGalleryBlockInfo(body) {
  const doc = new HtmlDocument(body);
  try {
    const titleLink = doc.querySelector("h1.lillie > a");
    if (!titleLink) throw new Error("galleryblock: missing title");
    const gidMatch = /-(\d+)\.html$/.exec(titleLink.attributes["href"] || "");
    if (!gidMatch) throw new Error("galleryblock: missing gid");
    const gid = gidMatch[1];
    const title = titleLink.text;

    const thumbnail_hashs = [];
    doc.querySelectorAll("img").forEach((img) => {
      const src = (img.attributes["data-src"] || img.attributes["src"] || "").trim();
      const r = /\/(\w{64})\./.exec(src);
      if (r) thumbnail_hashs.push(r[1]);
    });

    const artists = doc.querySelectorAll(".artist-list li a").map((a) => a.text.trim());

    let language = undefined;
    let type = undefined;
    const series = [];
    doc.querySelectorAll(".dj-desc tr").forEach((row) => {
      const key = (row.children[0] ? row.children[0].text : "").trim().toLowerCase();
      const valueCell = row.children[1];
      if (!valueCell) return;
      if (key === "series") {
        const text = valueCell.text.trim();
        if (text !== "N/A") valueCell.querySelectorAll("a").forEach((a) => series.push(a.text.trim()));
      } else if (key === "type") {
        type = valueCell.text.trim();
      } else if (key === "language") {
        const a = valueCell.querySelector("a");
        const r = a ? /\/index-(\w+)\.html/.exec(a.attributes["href"] || "") : null;
        if (r) language = r[1];
      }
    });

    const females = [];
    const males = [];
    const others = [];
    doc.querySelectorAll(".relatedtags li a").forEach((a) => {
      const text = a.text.trim();
      if (text.endsWith(" ♀")) females.push(text.slice(0, -2));
      else if (text.endsWith(" ♂")) males.push(text.slice(0, -2));
      else others.push(text);
    });

    const dateEl = doc.querySelector(".date");
    const posted_time = dateEl ? new Date(toISO8601(dateEl.text.trim())) : new Date(0);

    return { gid, title, type, language, artists, series, females, males, others, thumbnail_hashs, posted_time };
  } finally {
    doc.dispose();
  }
}

// ---------------------------------------------------------------------------
// 详情 (galleries/<gid>.js)
// ---------------------------------------------------------------------------
async function getGalleryDetail(gid) {
  const resp = await Network.get("https://" + domain + "/" + galleriesdir + "/" + gid + ".js", {
    referer: refererUrl,
  });
  if (resp.status !== 200) throw new Error(String(resp.status));
  return parseGalleryDetail(resp.body);
}

function parseGalleryDetail(text) {
  const marker = text.indexOf("=");
  const json = marker >= 0 ? text.slice(marker + 1) : text;
  const data = JSON.parse(json);

  const artists = (data.artists || []).map((n) => n.artist);
  const groups = (data.groups || []).map((n) => n.group);
  const series = (data.parodys || []).map((n) => n.parody);
  const characters = (data.characters || []).map((n) => n.character);
  const females = [];
  const males = [];
  const others = [];
  (data.tags || []).forEach((n) => {
    if (n.female === "1") females.push(n.tag);
    else if (n.male === "1") males.push(n.tag);
    else others.push(n.tag);
  });
  const translations = (data.languages || []).map((n) => ({ gid: n.galleryid, language: n.name }));
  const related_gids = data.related || [];

  const files = data.files || [];
  return {
    gid: parseInt(data.id),
    title: data.title,
    url: "https://hitomi.la" + data.galleryurl,
    type: data.type,
    length: files.length,
    language: data.language || undefined,
    artists,
    groups,
    series,
    characters,
    females,
    males,
    others,
    thumbnail_hash: files.length ? files[0].hash : undefined,
    files,
    posted_time: data.date ? new Date(toISO8601(data.date)) : new Date(0),
    datepublished: data.datepublished || null,
    translations,
    related_gids,
    blocked: data.blocked,
  };
}

// ---------------------------------------------------------------------------
// 图片 URL 推导
// ---------------------------------------------------------------------------
async function ensureGg() {
  if (gg && gg.b) return gg;
  const resp = await Network.get("https://" + domain + "/gg.js", { referer: refererUrl });
  if (resp.status >= 400) throw new Error("gg.js " + resp.status);
  gg = undefined;
  eval(resp.body);
  if (!gg || !gg.b) {
    gg = undefined;
    throw new Error("gg.js parse failed");
  }
  return gg;
}

function getPreferredImageDir(image) {
  return image && image.hasavif === 0 ? "webp" : "avif";
}

async function getImageSrcs(files) {
  await ensureGg();

  const subdomain_from_url = (url, base, dir) => {
    let retval = "";
    if (!base) {
      if (dir === "webp") retval = "w";
      else if (dir === "avif") retval = "a";
    }
    const r = /\/[0-9a-f]{61}([0-9a-f]{2})([0-9a-f])/;
    const m = r.exec(url);
    if (!m) return retval;
    const g = parseInt(m[2] + m[1], 16);
    if (!isNaN(g)) {
      if (base) retval = String.fromCharCode(97 + gg.m(g)) + base;
      else retval = retval + (1 + gg.m(g));
    }
    return retval;
  };

  const url_from_url = (url, base, dir) => {
    return url.replace(
      /\/\/..?\.(?:gold-usergeneratedcontent\.net|hitomi\.la)\//,
      "//" + subdomain_from_url(url, base, dir) + "." + domain2 + "/"
    );
  };

  const full_path_from_hash = (hash) => gg.b + gg.s(hash) + "/" + hash;
  const real_full_path_from_hash = (hash) => hash.replace(/^.*(..)(.)$/, "$2/$1/" + hash);

  const url_from_hash = (image, dir) => {
    const ext = dir || image.name.split(".").pop();
    const sub = dir === "webp" || dir === "avif" ? "" : dir + "/";
    return "https://a." + domain2 + "/" + sub + full_path_from_hash(image.hash) + "." + ext;
  };

  const url_from_url_from_hash = (image, dir, base) => {
    if (base === "tn") {
      return url_from_url(
        "https://a." + domain2 + "/" + dir + "/" + real_full_path_from_hash(image.hash) + "." + "avif",
        base
      );
    }
    return url_from_url(url_from_hash(image, dir), base, dir);
  };

  return files.map((image) => url_from_url_from_hash(image, getPreferredImageDir(image)));
}

function getThumbnailUrl(hash, bigTn) {
  const dir = bigTn ? "avifbigtn" : "avifsmallbigtn";
  return (
    "https://" + tn_domain + "/" + dir + "/" + hash.slice(-1) + "/" + hash.slice(-3, -1) + "/" + hash + ".avif"
  );
}

// ---------------------------------------------------------------------------
// 漫画源
// ---------------------------------------------------------------------------
class Hitomi extends ComicSource {
  name = "hitomi.la";
  key = "hitomi";
  version = "2.0.0";
  minAppVersion = "1.4.6";
  url = "https://cdn.jsdelivr.net/gh/senran-N/venera-configs@main/hitomi.js";

  searchResultCaches = new Map();
  categoryResultCache = undefined;
  galleryCacheById = {};
  searchCacheLimit = 30;

  cacheSearchResult(cacheKey, value) {
    this.searchResultCaches.set(cacheKey, value);
    while (this.searchResultCaches.size > this.searchCacheLimit) {
      this.searchResultCaches.delete(this.searchResultCaches.keys().next().value);
    }
  }

  init() {}

  _mapBlock(n) {
    const thumb = n.thumbnail_hashs && n.thumbnail_hashs[0] ? getThumbnailUrl(n.thumbnail_hashs[0], true) : "";
    return new Comic({
      id: n.gid,
      title: n.title,
      subTitle: n.artists.length ? n.artists.join(" ") : "",
      cover: thumb,
      tags: [
        ...n.series,
        ...n.females.map((m) => "f:" + m),
        ...n.males.map((m) => "m:" + m),
        ...n.others,
      ],
      language: n.language,
      description: n.type ? n.type + "\n" + formatDate(n.posted_time) : formatDate(n.posted_time),
    });
  }

  explore = [
    {
      title: "hitomi.la",
      type: "multiPageComicList",
      load: async (page) => {
        if (!page) page = 1;
        const result = await getSingleTagSearchPage(
          {
            area: "all",
            tag: "index",
            language: "all",
            orderby: "date",
            orderbykey: "added",
            orderbydirection: "desc",
          },
          page - 1
        );
        const comics = (await getGalleryBlocks(result.galleryids)).map((n) => this._mapBlock(n));
        return { comics, maxPage: Math.ceil(result.count / 25) };
      },
      loadNext(next) {},
    },
  ];

  category = {
    title: "hitomi.la",
    parts: [
      {
        name: "语言",
        type: "fixed",
        categories: ["汉语", "英语"],
        itemType: "category",
        categoryParams: ["language:chinese", "language:english"],
      },
      {
        name: "类别",
        type: "fixed",
        categories: ["同人志", "漫画", "画师CG", "游戏CG", "图集", "动画"],
        itemType: "category",
        categoryParams: [
          "type:doujinshi",
          "type:manga",
          "type:artistcg",
          "type:gamecg",
          "type:imageset",
          "type:anime",
        ],
      },
    ],
    enableRankingPage: true,
  };

  categoryComics = {
    load: async (category, param, options, page) => {
      const term = param;
      if (!term.includes(":")) throw new Error("不合法的标签，请使用namespace:tag的格式");
      if (page === 1) {
        const option = parseInt(options[0]);
        const searchOptions = {
          term,
          orderby: "date",
          orderbykey: "added",
          orderbydirection: "desc",
        };
        switch (option) {
          case 1:
            searchOptions.orderbykey = "published";
            break;
          case 2:
            searchOptions.orderby = "popular";
            searchOptions.orderbykey = "today";
            break;
          case 3:
            searchOptions.orderby = "popular";
            searchOptions.orderbykey = "week";
            break;
          case 4:
            searchOptions.orderby = "popular";
            searchOptions.orderbykey = "month";
            break;
          case 5:
            searchOptions.orderby = "popular";
            searchOptions.orderbykey = "year";
            break;
          case 6:
            searchOptions.orderbydirection = "random";
            break;
          default:
            break;
        }
        const result = await search(searchOptions);
        if (result.type === "single") {
          const comics = (await getGalleryBlocks(result.gids)).map((n) => this._mapBlock(n));
          this.categoryResultCache = { type: "single", state: result.state, count: result.count };
          return { comics, maxPage: Math.ceil(result.count / 25) };
        }
        const comics = (await getGalleryBlocks(result.gids.slice(25 * page - 25, 25 * page))).map((n) => this._mapBlock(n));
        this.categoryResultCache = { type: "all", gids: result.gids, count: result.count };
        return { comics, maxPage: Math.ceil(result.count / 25) };
      }

      if (this.categoryResultCache.type === "single") {
        const result = await getSingleTagSearchPage(this.categoryResultCache.state, page - 1);
        const comics = (await getGalleryBlocks(result.galleryids)).map((n) => this._mapBlock(n));
        return { comics, maxPage: Math.ceil(this.categoryResultCache.count / 25) };
      }
      const comics = (
        await getGalleryBlocks(this.categoryResultCache.gids.slice(25 * page - 25, 25 * page))
      ).map((n) => this._mapBlock(n));
      return { comics, maxPage: Math.ceil(this.categoryResultCache.count / 25) };
    },
    optionList: [
      {
        options: [
          "0-Date Added",
          "1-Date Published",
          "2-Popular:Today",
          "3-Popular:Week",
          "4-Popular:Month",
          "5-Popular:Year",
          "6-Random",
        ],
        notShowWhen: null,
        showWhen: null,
      },
    ],
    ranking: {
      options: ["today-Today", "week-Week", "month-Month", "year-Year"],
      load: async (option, page) => {
        if (!page) page = 1;
        const result = await getSingleTagSearchPage(
          {
            area: "all",
            tag: "index",
            language: "all",
            orderby: "popular",
            orderbykey: option,
            orderbydirection: "desc",
          },
          page - 1
        );
        const comics = (await getGalleryBlocks(result.galleryids)).map((n) => this._mapBlock(n));
        return { comics, maxPage: Math.ceil(result.count / 25) };
      },
    },
  };

  search = {
    load: async (keyword, options, page) => {
      const cacheKey = (keyword || "") + "|" + options.join(",");
      if (page === 1) {
        const option = parseInt(options[0]);
        const searchOptions = {
          term: keyword,
          orderby: "date",
          orderbykey: "added",
          orderbydirection: "desc",
        };
        switch (option) {
          case 1:
            searchOptions.orderbykey = "published";
            break;
          case 2:
            searchOptions.orderby = "popular";
            searchOptions.orderbykey = "today";
            break;
          case 3:
            searchOptions.orderby = "popular";
            searchOptions.orderbykey = "week";
            break;
          case 4:
            searchOptions.orderby = "popular";
            searchOptions.orderbykey = "month";
            break;
          case 5:
            searchOptions.orderby = "popular";
            searchOptions.orderbykey = "year";
            break;
          case 6:
            searchOptions.orderbydirection = "random";
            break;
          default:
            break;
        }
        const result = await search(searchOptions);
        if (result.type === "single") {
          const comics = (await getGalleryBlocks(result.gids)).map((n) => this._mapBlock(n));
          this.cacheSearchResult(cacheKey, { type: "single", state: result.state, count: result.count });
          return { comics, maxPage: Math.ceil(result.count / 25) };
        }
        const comics = (await getGalleryBlocks(result.gids.slice(25 * page - 25, 25 * page))).map((n) => this._mapBlock(n));
        this.cacheSearchResult(cacheKey, { type: "all", gids: result.gids, count: result.count });
        return { comics, maxPage: Math.ceil(result.count / 25) };
      }

      const cache = this.searchResultCaches.get(cacheKey);
      if (!cache) throw new Error("搜索会话已失效，请返回第一页");
      if (cache.type === "single") {
        const result = await getSingleTagSearchPage(cache.state, page - 1);
        const comics = (await getGalleryBlocks(result.galleryids)).map((n) => this._mapBlock(n));
        return { comics, maxPage: Math.ceil(cache.count / 25) };
      }
      const comics = (await getGalleryBlocks(cache.gids.slice(25 * page - 25, 25 * page))).map((n) => this._mapBlock(n));
      return { comics, maxPage: Math.ceil(cache.count / 25) };
    },

    loadNext: async (keyword, options, next) => {},

    optionList: [
      {
        type: "select",
        options: [
          "0-Date Added",
          "1-Date Published",
          "2-Popular:Today",
          "3-Popular:Week",
          "4-Popular:Month",
          "5-Popular:Year",
          "6-Random",
        ],
        label: "sort",
        default: null,
      },
    ],

    enableTagsSuggestions: true,
    onTagSuggestionSelected: (namespace, tag) => {
      let fixedNamespace;
      switch (namespace) {
        case "reclass":
          fixedNamespace = "type";
          break;
        case "parody":
          fixedNamespace = "series";
          break;
        case "other":
          fixedNamespace = "tag";
          break;
        case "mixed":
          fixedNamespace = "tag";
          break;
        case "temp":
          fixedNamespace = "tag";
          break;
        case "cosplayer":
          fixedNamespace = "tag";
          break;
        default:
          fixedNamespace = namespace;
          break;
      }
      return `${fixedNamespace}:${tag.replaceAll(" ", "_")}`;
    },
  };

  comic = {
    loadInfo: async (id) => {
      const data = await getGalleryDetail(id);
      if (data.blocked) throw new Error("This gallery has been blocked");
      if (!data.files || data.files.length === 0) throw new Error("No images found");

      const tags = new Map();
      if (data.type) tags.set("type", [data.type]);
      if (data.groups.length) tags.set("groups", data.groups);
      if (data.artists.length) tags.set("artists", data.artists);
      if (data.language) tags.set("language", [data.language]);
      if (data.series.length) tags.set("series", data.series);
      if (data.characters.length) tags.set("characters", data.characters);
      if (data.females.length) tags.set("females", data.females);
      if (data.males.length) tags.set("males", data.males);
      if (data.others.length) tags.set("others", data.others);

      let recommend = undefined;
      if (data.related_gids.length) {
        recommend = (await getGalleryBlocks(data.related_gids.slice(0, 25))).map((n) => this._mapBlock(n));
      }

      this.galleryCacheById[String(data.gid)] = data;

      const chapters = new Map();
      chapters.set("1", data.title || "Gallery");

      const translations = (data.translations || []).filter((t) => String(t.gid) !== String(data.gid));
      const description = translations.length
        ? "Translations: " + translations.map((t) => `${t.language} #${t.gid}`).join(", ")
        : undefined;

      return new ComicDetails({
        title: data.title,
        cover: data.thumbnail_hash ? getThumbnailUrl(data.thumbnail_hash, true) : undefined,
        tags,
        description,
        maxPage: data.files.length,
        chapters,
        thumbnails: data.files.map((n) => getThumbnailUrl(n.hash)),
        uploadTime: formatDate(data.posted_time),
        updateTime: data.datepublished ? formatDate(new Date(data.datepublished + "T00:00:00")) : undefined,
        url: data.url,
        recommend,
      });
    },

    loadEp: async (comicId, epId) => {
      let data = this.galleryCacheById[String(comicId)];
      if (!data || String(data.gid) !== String(comicId)) {
        data = await getGalleryDetail(comicId);
        this.galleryCacheById[String(comicId)] = data;
      }
      if (!data.files || data.files.length === 0) throw new Error("No images found");
      if (data.type === "anime") throw new Error("不支持视频浏览");
      const images = await getImageSrcs(data.files);
      return { images };
    },

    onImageLoad: (url, comicId, epId) => ({ url, headers: { referer: refererUrl } }),
    onThumbnailLoad: (url) => ({ url, headers: { referer: refererUrl } }),

    onClickTag: (namespace, tag) => {
      let fixedNamespace;
      switch (namespace) {
        case "type":
          fixedNamespace = "type";
          break;
        case "groups":
          fixedNamespace = "group";
          break;
        case "artists":
          fixedNamespace = "artist";
          break;
        case "language":
          fixedNamespace = "language";
          break;
        case "series":
          fixedNamespace = "series";
          break;
        case "characters":
          fixedNamespace = "character";
          break;
        case "females":
          fixedNamespace = "female";
          break;
        case "males":
          fixedNamespace = "male";
          break;
        case "others":
          fixedNamespace = "tag";
          break;
        default:
          break;
      }
      if (!fixedNamespace) throw new Error("不支持的标签命名空间: " + namespace);
      return {
        page: "search",
        attributes: { keyword: fixedNamespace + ":" + tag.replaceAll(" ", "_") },
      };
    },

    link: {
      domains: ["hitomi.la"],
      linkToId: (url) => {
        const r = /https:\/\/hitomi\.la\/\w+\/[^\/]+-(\d+)\.html/.exec(url);
        return r ? r[1] : null;
      },
    },

    enableTagsTranslate: true,
  };

  translation = {
    zh_CN: {
      "Date Added": "按添加时间",
      "Date Published": "按发布时间",
      "Popular:Today": "今日热门",
      "Popular:Week": "本周热门",
      "Popular:Month": "本月热门",
      "Popular:Year": "本年热门",
      Random: "随机",
    },
    zh_TW: {
      "Date Added": "按添加時間",
      "Date Published": "按發佈時間",
      "Popular:Today": "今日熱門",
      "Popular:Week": "本週熱門",
      "Popular:Month": "本月熱門",
      "Popular:Year": "本年熱門",
      Random: "隨機",
    },
    en: {},
  };
}
