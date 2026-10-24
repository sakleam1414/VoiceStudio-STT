// Reproduce the installed BetterDiscord bug: external JS compilation receives a string as options.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
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
    // Exact _compile -> preload compileFunction call, including the invalid third argument.
    const wrapper = vm.compileFunction(fs.readFileSync(name,'utf8'),['require','module','exports','__dirname'],name);
    wrapper(bdRequire,module,module.exports,path.dirname(name));
    return module.exports;
}
assert.equal(bdRequire('./stt_updates'),undefined);
assert.throws(() => bdRequire(path.join(root,'stt_updates.js')), error => error.code === 'ERR_INVALID_ARG_TYPE' && error.message.includes('options'));
for (const filename of ['microphone.plugin.js','subtitles.plugin.js']) {
    // BetterDiscord loads plugins through its plugin manager, independently of external modules.
    const full = path.join(root,filename);
    const module = {exports:{}};
    const compile = vm.compileFunction(fs.readFileSync(full,'utf8'),['require','module','exports','__dirname'],{filename:full,parsingContext:context});
    compile(bdRequire,module,module.exports,root);
    const Plugin = module.exports;
    const plugin = new Plugin();
    plugin.stop = () => {};
    assert.throws(() => plugin.start(), error => error === reachedUI);
    assert.equal(typeof plugin.shared.network,'function');
    assert.equal(typeof plugin.shared.showNetwork,'function');
    assert(Array.isArray(plugin.shared.network(root).saved()));
}
console.log('PASS: exact external compiler error reproduced; both plugins initialize embedded networking without external JS imports or child_process');
