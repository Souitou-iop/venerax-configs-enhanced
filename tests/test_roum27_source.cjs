const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

// 模拟 venera 运行时桥: Convert.decodeBase64(str)→bytes, decodeUtf8(bytes)→str
const context = {
  console,
  setTimeout,
  URL,
  ComicSource: class {
    loadSetting() {
      return '';
    }
  },
  Comic: class {
    constructor(d) {
      Object.assign(this, d);
    }
  },
  ComicDetails: class {
    constructor(d) {
      Object.assign(this, d);
    }
  },
  HtmlDocument: class {},
  Network: {
    get: async () => {
      throw new Error('network stub not set');
    },
  },
  UI: { showMessage: () => {} },
  Convert: {
    decodeBase64: (s) => new Uint8Array(Buffer.from(s, 'base64')),
    decodeUtf8: (bytes) => Buffer.from(bytes).toString('utf-8'),
  },
};

const source = fs.readFileSync('roum27.js', 'utf8') + '\nthis.Roum27 = Roum27;';
vm.runInNewContext(source, context);
const Roum27 = context.Roum27;

// ---- decodePayload: 站点剥离 base64 padding 的修复 ----
// 真实样本: 内容图载荷 len%4==2(90B), 广告载荷 len%4==0(180B)
const contentPayload = 'czM6Ly9yb3VtYW4vaW1hZ2VzL2Ntd3A2ZTA4cDAwMGFzNjhkY240YnZoODgvY292ZXIuanBn';
const decodedContent = Roum27.decodePayload(contentPayload);
assert(
  decodedContent.startsWith('s3://rouman/images/'),
  'padded decode must recover s3 payload: ' + decodedContent
);

// len%4==2 的真实内容图载荷(截取自章节页, 站点已剥 "=")
const unaligned = 'czM6Ly9yb3VtYW4vaW1hZ2VzL2Ntd3A2ZTA4cDAwMGFzNjhkY240YnZoODgvMThjLzE0OTE3NjcvMDAwMDEud2VicA';
assert.strictEqual(unaligned.length % 4, 2, 'sample payload must be unaligned (mod 2)');
const decoded = Roum27.decodePayload(unaligned);
assert(decoded.startsWith('s3://rouman/images/cmwp6e08p000as68dcn4bvh88/18c/'), 'unaligned payload must decode after padding: ' + decoded);

// len%4==1 → 非法, 返回空串(不抛异常)
assert.strictEqual(Roum27.decodePayload('czM6Ly9yb3VtYW4vaW1hZ2VzL'), '');
// 空输入
assert.strictEqual(Roum27.decodePayload(''), '');

// ---- parseCardsFromHtml: SSR 卡片提取(真实页结构 a.site-comic > img + h3) ----
const cardHtml = `<div class="site-comic-grid"><a class="site-comic" href="/books/cmwp6e08p000as68dcn4bvh88"><div class="site-comic-cover"><img src="https://towm85.xyz/m/tok/wm:0/sr:0/czM6Ly9yb3VtYW4.jpg" width="300" height="450" alt="飞机杯女神连缐中(机翻版)" loading="lazy"/></div><span class="site-comic-status">人氣 01</span><h3 title="飞机杯女神连缐中(机翻版)">飞机杯女神连缐中(机翻版)</h3></a></div>`;
const cards = Roum27.parseCardsFromHtml(cardHtml);
assert.strictEqual(cards.length, 1, 'must parse one card');
assert.strictEqual(cards[0].id, 'cmwp6e08p000as68dcn4bvh88');
assert.strictEqual(cards[0].title, '飞机杯女神连缐中(机翻版)');
assert(cards[0].cover.startsWith('https://towm85.xyz/m/'), 'cover must be kept');
// href 在 class 之前的形态也要能解析
const cardHtml2 = `<a href="/books/63b65185-f798-4c8f-a0b0-8811615908fd" class="site-comic"><img src="https://x/y.jpg" alt="别名书"/><h3>别名书</h3></a>`;
const cards2 = Roum27.parseCardsFromHtml(cardHtml2);
assert.strictEqual(cards2.length, 1);
assert.strictEqual(cards2[0].id, '63b65185-f798-4c8f-a0b0-8811615908fd');

// ---- loadEp: 真实章节页 fixture 的载荷提取与广告过滤 ----
(async () => {
const fixture = fs.readFileSync('tests/fixtures/roum27_chapter_page.html', 'utf8');
context.Network.get = async () => ({ status: 200, body: fixture });
const src = new context.Roum27();
const ep = await src.comic.loadEp('cmwp6e08p000as68dcn4bvh88', '0');
assert(Array.isArray(ep.images), 'loadEp must return images array');
assert(ep.images.length >= 60, 'fixture chapter must yield many content images, got ' + ep.images.length);
// 全部为正文图载荷: 无广告(advertiser/adcs)与封面
for (const u of ep.images) {
  const m = u.match(/czM6Ly9[A-Za-z0-9+/=]+/);
  assert(m, 'image url must embed base64 payload');
  const payload = Roum27.decodePayload(m[0]);
  assert(payload.startsWith('s3://rouman/images/'), 'only rouman/images payloads allowed, got ' + payload.slice(0, 40));
  assert(!/\/cover\.(jpg|jpeg|png|webp)$/i.test(payload), 'covers must be excluded');
}
// 去重
assert.strictEqual(new Set(ep.images).size, ep.images.length, 'images must be deduped');

// ---- 降级页识别: 页面含广告载荷但无正文图 → SITE_DEGRADED ----
const degradedHtml = '<html><head><link rel="preload" as="image" href="https://v.rn252.xyz/m/tok/wm:0/sr:0/czM6Ly9yb3VwdWIvYWR2ZXJ0aXNlci1hc3NldHMvYWR2LmdpZg=="/></head><body></body></html>';
context.Network.get = async () => ({ status: 200, body: degradedHtml });
await assert.rejects(
  () => src.comic.loadEp('cmwp6e08p000as68dcn4bvh88', '0'),
  /SITE_DEGRADED/,
  'degraded page (ads only, no content) must raise SITE_DEGRADED'
);

// ---- 结构变化识别: 页面无任何载荷 → 普通错误(FAIL 语义, 非 BLOCKED) ----
context.Network.get = async () => ({ status: 200, body: '<html><body>redesign</body></html>' });
await assert.rejects(
  () => src.comic.loadEp('cmwp6e08p000as68dcn4bvh88', '0'),
  /页面无图片载荷/,
  'page without payloads must raise structural error'
);

console.log('roum27 source fixture passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
