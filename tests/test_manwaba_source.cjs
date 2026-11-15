const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('manwaba.js', 'utf8') + '\nthis.ManWaBa = ManWaBa;';
const context = { ComicSource: class {}, console };
vm.runInNewContext(source, context);

const fixture = fs.readFileSync('tests/fixtures/manwaba_chapter_params.html', 'utf8');
const match = fixture.match(/params\s*=\s*'([^']+)'/);
assert(match, 'fixture must contain chapter params');

const decoded = new context.ManWaBa().decodeJsStringEscapes(match[1]);
assert.strictEqual(decoded, 'YWJj+/8A==');
console.log('manwaba JS escape fixture passed');
