const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const context = {
  console,
  setTimeout,
  URL,
  ComicSource: class {},
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
  Network: {},
  UI: { showMessage: () => {} },
};

const source = fs.readFileSync('cycomic.js', 'utf8') + '\nthis.Cycomic = Cycomic;';
vm.runInNewContext(source, context);
const Cycomic = context.Cycomic;

// ---- encodeImageUrl: 中文/空格 URL 编码, 已编码 URL 不二次编码 ----
assert.strictEqual(
  Cycomic.encodeImageUrl('https://tuer.justpic01pt.com:666/picbed/CPMH/haizeiwang/0/x.jpg'),
  'https://tuer.justpic01pt.com:666/picbed/CPMH/haizeiwang/0/x.jpg',
  'pure ASCII URL must pass through'
);
assert.strictEqual(
  Cycomic.encodeImageUrl('https://host/picbed/女王/第1话.jpg'),
  'https://host/picbed/%E5%A5%B3%E7%8E%8B/%E7%AC%AC1%E8%AF%9D.jpg',
  'non-ASCII URL must be encodeURI-ed'
);
assert.strictEqual(
  Cycomic.encodeImageUrl('https://host/picbed/%E5%A5%B3%E7%8E%8B/x.jpg'),
  'https://host/picbed/%E5%A5%B3%E7%8E%8B/x.jpg',
  'already-encoded URL must not be double-encoded'
);
assert.strictEqual(
  Cycomic.encodeImageUrl('https://host/a b.jpg'),
  'https://host/a%20b.jpg',
  'spaces must be encoded'
);

// ---- abs: 协议相对与 http→https 归一 ----
assert.strictEqual(Cycomic.abs('//2cycomic.com/picbed/a.jpg'), 'https://2cycomic.com/picbed/a.jpg');
assert.strictEqual(Cycomic.abs('http://2cycomic.com/book/1/'), 'https://2cycomic.com/book/1/');
assert.strictEqual(Cycomic.abs('/book/1/'), 'https://2cycomic.com/book/1/');
assert.strictEqual(Cycomic.abs(''), '');

// ---- 列表解析: 真实 /update 页卡片结构(图卡 + 排名文字卡) ----
const fixture = fs.readFileSync('tests/fixtures/cycomic_update_list.html', 'utf8');
class FakeDoc {
  constructor(html) {
    this.html = html;
    this.anchors = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map((m) => new FakeEl(m[0]));
  }
  querySelectorAll() {
    return this.anchors;
  }
}
class FakeEl {
  constructor(html) {
    this.html = html;
    this.href = (html.match(/href="([^"]+)"/) || [])[1] || '';
    this.text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const attr = (name) => (html.match(new RegExp(name + '="([^"]*)"')) || [])[1] || '';
    this.attributes = { href: this.href, title: attr('title'), src: attr('src'), 'data-src': attr('data-src'), alt: attr('alt'), style: attr('style') };
    const inner = (sel) => {
      if (sel === 'img') {
        const m = html.match(/<img\b[^>]*>/);
        return m ? new FakeEl(m[0]) : null;
      }
      const cls = sel.replace(/^\./, '');
      const m = html.match(new RegExp('<(?:h3|h4|p|div)[^>]*class="[^"]*' + cls + '[^"]*"[^>]*>([\\s\\S]*?)<\\/(?:h3|h4|p|div)>'));
      return m ? new FakeEl(m[0]) : null;
    };
    this.querySelector = inner;
  }
  get text() {
    return this._text || this.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  set text(v) {
    this._text = v;
  }
  querySelectorAll() {
    return [];
  }
}
const doc = new FakeDoc(fixture);
const comics = Cycomic.parseList(doc);
assert(comics.length >= 3, 'fixture must parse several cards, got ' + comics.length);
for (const c of comics) {
  assert(/^\d+$/.test(c.id), 'book id must be numeric: ' + c.id);
  assert(c.title && c.title.length > 0, 'title must be present');
  assert(c.cover.startsWith('https://'), 'cover must be absolute https');
}
// 标题来自 h3.name(图卡)或 p.name(文字卡)
assert(
  comics.some((c) => c.title.includes('只是体检而已')),
  'known title from fixture must appear'
);

console.log('cycomic source fixture passed');
