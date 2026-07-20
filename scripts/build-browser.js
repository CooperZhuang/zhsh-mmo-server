'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { exportTask1Content } = require('./export-task1-content');

const root = path.resolve(__dirname,'..');
const webRoot = path.join(root,'web');
const distRoot = path.join(root,'dist');

function buildBrowser() {
  exportTask1Content();
  const bundle = bundleCommonJs(path.join(root,'src','task-runtime','browser-entry.js'));
  const formalNames = ['CombatRuntime','NpcDuelRuntime','DivingRuntime','DropRuntime','DungeonRuntime','EconomyRuntime','EquipmentRuntime','FishingRuntime','FormalGameplayCatalog','ItemRuntime','MaritimeRuntime','RecoveryRuntime','ShipRuntime','VoyageRuntime','effectiveStats'];
  const browserBundle = `${bundle}\n${formalNames.map((name) => `export const ${name}=__entry.${name};`).join('\n')}\n`;
  const generated = path.join(webRoot,'generated','task-runtime-browser.js');
  fs.mkdirSync(path.dirname(generated),{ recursive:true });
  fs.writeFileSync(generated,browserBundle,'utf8');
  fs.mkdirSync(distRoot,{ recursive:true });
  fs.cpSync(webRoot,distRoot,{ recursive:true,force:true });
  return { generated,distRoot };
}

function bundleCommonJs(entryPath) {
  const modules = new Map();
  function add(filePath) {
    const id = path.relative(root,filePath).replaceAll('\\','/');
    if (modules.has(id)) return id;
    let source = fs.readFileSync(filePath,'utf8');
    modules.set(id,'');
    if(path.extname(filePath)==='.json') {
      modules.set(id,`module.exports=${source.trim()};`);
      return id;
    }
    source = source.replace(/require\(['"](\.\.?\/[^'"]+)['"]\)/g,(_match,request) => {
      const resolved = path.resolve(path.dirname(filePath),request.endsWith('.js')||request.endsWith('.json') ? request : `${request}.js`);
      return `require(${JSON.stringify(add(resolved))})`;
    });
    modules.set(id,source);
    return id;
  }
  const entryId = add(entryPath);
  const table = [...modules.entries()].map(([id,source]) => `${JSON.stringify(id)}: function(module,exports,require){\n${source}\n}`).join(',\n');
  return `// Generated from the shared CommonJS task runtime. Do not edit by hand.\nconst __modules={\n${table}\n};\nconst __cache={};\nfunction __require(id){if(__cache[id])return __cache[id].exports;const module={exports:{}};__cache[id]=module;__modules[id](module,module.exports,__require);return module.exports;}\nconst __entry=__require(${JSON.stringify(entryId)});\n${['BrowserRuntimeStorage','BrowserTaskCatalog','IndexedDbDurableStore','TaskRuntimeEngine','UiFeedback','buildCityMapEntries'].map((name) => `export const ${name}=__entry.${name};`).join('\n')}\n`;
}

if (require.main === module) {
  const result = buildBrowser();
  console.log(`Built browser playable slice at ${path.relative(root,result.distRoot)}`);
}

module.exports = { buildBrowser,bundleCommonJs };
