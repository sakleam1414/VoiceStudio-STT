// Reproduce BetterDiscord's loader: ./ imports return undefined; child_process is unavailable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const cache = {};
const context = vm.createContext({console, setTimeout, clearTimeout, AbortController});
context.window = {require: {cache}};
context.BdApi = {Data: {load: () => null}};
const reachedUI = new Error('Reached UI');
context.document = {createElement: () => {throw reachedUI;}};
function bdRequire(name) {
    if (name.startsWith('./')) return undefined;
    if (name === 'fs') return fs;
    if (name === 'path') return path;
    if (!path.isAbsolute(name)) throw new Error('Unsupported BetterDiscord module: '+name);
    if (cache[name]) return cache[name].exports;
    const module = {exports: {}};
    cache[name] = module;
    const wrapper = vm.runInContext('(function(require,module,exports,__dirname){\n'+fs.readFileSync(name,'utf8')+'\n})',context,{filename:name});
    wrapper(bdRequire,module,module.exports,path.dirname(name));
    return module.exports;
}
assert.equal(bdRequire('./stt_updates'),undefined);
for (const filename of ['microphone.plugin.js','subtitles.plugin.js']) {
    const Plugin = bdRequire(path.join(root,filename));
    const plugin = new Plugin();
    plugin.stop = () => {};
    assert.throws(() => plugin.start(), error => error === reachedUI);
    assert.equal(typeof plugin.shared.network,'function');
    assert.equal(typeof plugin.shared.showNetwork,'function');
    assert.equal(plugin.shared.network(root).saved().length,0);
}
console.log('PASS: both plugins load shared networking with the BetterDiscord loader and without child_process');
