const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const baselinePath = path.join(projectRoot, 'docs', 'reconstruction-baseline', 'multisource-baseline.json');
const referenceRoot = process.env.ZHSH_REFERENCE_ROOT ?? path.resolve(projectRoot, '..', 'zhsh-references', 'zhsh');
const configRoot = path.join(referenceRoot, 'config');
const sourceCommit = 'b841e0e7f6dfcc5ef5dccd22c42989b12847816e';
const revisionBaseCommit = '73fa853a4b836b78de7de640726f026c9f35ac2a';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function pointerPart(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function source(relativePath, locator) {
  return {
    repository: 'zhsh',
    relative_path: relativePath.replace(/\\/g, '/'),
    locator,
    commit: sourceCommit,
  };
}

function stableId(category, logicalKey) {
  const digest = crypto.createHash('sha256').update(`${category}\0${logicalKey}`, 'utf8').digest('hex').slice(0, 16);
  return `entity.${category}.${digest}`;
}

function normalizeScalars(value) {
  if (Array.isArray(value)) return value.map(normalizeScalars);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeScalars(child)]));
  }
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  return value;
}

function entity(category, logicalKey, originalDisplayName, normalizedData, rawData, relativePath, locator, supportingSources = []) {
  return {
    canonical_id: stableId(category, logicalKey),
    entity_type: category,
    original_display_name: originalDisplayName,
    normalized_data: normalizedData,
    raw_data: rawData,
    evidence_classification: 'SINGLE_SOURCE',
    originality_status: 'UNVERIFIED_AS_ORIGINAL',
    sources: [source(relativePath, locator), ...supportingSources],
  };
}

function splitRawList(value) {
  if (typeof value !== 'string' || value === '') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseQuantityList(value) {
  return splitRawList(value).map((item) => (/^-?\d+$/.test(item) ? Number(item) : null));
}

function normalizedTaskFields(raw) {
  const targets = splitRawList(raw.targetName);
  const parsedQuantities = parseQuantityList(raw.quantity);
  const requiredQuantities = targets.map((_, index) => parsedQuantities[index] ?? null);
  const targetPairs = targets.map((name, index) => ({ name, quantity: requiredQuantities[index] }));
  const itemTaskTypes = new Set(['收集', '送物品', '运货']);

  return {
    raw_task_type: Object.hasOwn(raw, 'taskType') ? raw.taskType : null,
    raw_target_name: Object.hasOwn(raw, 'targetName') ? raw.targetName : null,
    raw_quantity: Object.hasOwn(raw, 'quantity') ? raw.quantity : null,
    raw_target_address: Object.hasOwn(raw, 'targetAddress') ? raw.targetAddress : null,
    raw_level: Object.hasOwn(raw, 'level') ? raw.level : null,
    targets,
    required_quantities: requiredQuantities,
    required_items: itemTaskTypes.has(raw.taskType) ? targetPairs : [],
    kill_targets: raw.taskType === '打怪' ? targetPairs : [],
  };
}

function buildEntities() {
  const worldMap = readJson(path.join(configRoot, 'worldMap.json'));
  const cityMap = readJson(path.join(configRoot, 'cityMap.json'));
  const insideMapFlat = readJson(path.join(configRoot, 'insideMapFlat.json'));
  const insideMap = readJson(path.join(configRoot, 'insideMap.json'));
  const npcs = readJson(path.join(configRoot, 'npcs.json'));
  const allItems = readJson(path.join(configRoot, 'allItems.json'));
  const shopItems = readJson(path.join(configRoot, 'shopItems.json'));
  const taskItems = readJson(path.join(configRoot, 'taskItems.json'));
  const equipment = readJson(path.join(configRoot, 'equipment.json'));
  const monsters = readJson(path.join(configRoot, 'monsters.json'));
  const monsterDrops = readJson(path.join(configRoot, 'monsterDrops.json'));
  const monsterItems = readJson(path.join(configRoot, 'monsterItems.json'));
  const cityShop = readJson(path.join(configRoot, 'cityShop.json'));
  const marketItems = readJson(path.join(configRoot, 'marketItems.json'));
  const ships = readJson(path.join(configRoot, 'ship.json'));
  const fish = readJson(path.join(configRoot, 'fish.json'));
  const pets = readJson(path.join(configRoot, 'pet.json'));
  const trials = readJson(path.join(configRoot, 'trial.json'));

  const cityRegions = new Map();
  for (const [region, cities] of Object.entries(worldMap)) {
    for (const city of cities) {
      if (!cityRegions.has(city)) cityRegions.set(city, []);
      cityRegions.get(city).push(region);
    }
  }

  const entities = {
    world_regions: Object.entries(worldMap).map(([region, cities]) => entity(
      'world_region', region, region,
      { name: region, cities: [...cities] },
      cities,
      'config/worldMap.json',
      `JSON Pointer /${pointerPart(region)}`,
    )),
    cities: Object.entries(cityMap).map(([city, grid]) => entity(
      'city', city, city,
      {
        name: city,
        regions: cityRegions.get(city) || [],
        grid: normalizeScalars(grid),
        grid_rows: grid.length,
        grid_columns_max: Math.max(0, ...grid.map((row) => row.length)),
      },
      grid,
      'config/cityMap.json',
      `JSON Pointer /${pointerPart(city)}`,
      (cityRegions.get(city) || []).map((region) => source('config/worldMap.json', `JSON Pointer /${pointerPart(region)}; contains city ${city}`)),
    )),
    locations: Object.entries(insideMapFlat).map(([compoundName, description]) => {
      const city = Object.keys(cityMap).find((candidate) => compoundName.startsWith(`${candidate}-`)) || null;
      const name = city ? compoundName.slice(city.length + 1) : compoundName;
      return entity(
        'location', compoundName, compoundName,
        { city, name, description },
        description,
        'config/insideMapFlat.json',
        `JSON Pointer /${pointerPart(compoundName)}`,
      );
    }),
    location_connections: [],
    npc_placements: [],
    items: [],
    equipment: Object.entries(equipment).map(([name, raw]) => entity(
      'equipment', name, name,
      { catalog_key: name, ...normalizeScalars(raw) },
      raw,
      'config/equipment.json',
      `JSON Pointer /${pointerPart(name)}`,
    )),
    monsters: [],
    drops: [],
    shops: [],
    city_price_ranges: [],
    ships: [],
    fish: fish.map((raw, index) => entity(
      'fish', raw.name, raw.name,
      normalizeScalars(raw),
      raw,
      'config/fish.json',
      `JSON Pointer /${index}`,
    )),
    pets: Object.entries(pets).map(([section, raw]) => entity(
      'pet', section, section,
      { section, value: normalizeScalars(raw) },
      raw,
      'config/pet.json',
      `JSON Pointer /${pointerPart(section)}`,
    )),
    trials: [],
  };

  for (const [city, relations] of Object.entries(insideMap)) {
    (relations.n || []).forEach((location, index) => {
      entities.location_connections.push(entity(
        'location_connection', `${city}|interior|${location}`, `${city}-${location}`,
        { city, relation_type: 'interior_location', location, entrance: null },
        location,
        'config/insideMap.json',
        `JSON Pointer /${pointerPart(city)}/n/${index}`,
      ));
    });
    for (const [location, entrance] of Object.entries(relations.w || {})) {
      entities.location_connections.push(entity(
        'location_connection', `${city}|wild_to_entrance|${location}|${entrance}`, `${city}-${location} → ${entrance}`,
        { city, relation_type: 'wild_to_entrance', location, entrance },
        entrance,
        'config/insideMap.json',
        `JSON Pointer /${pointerPart(city)}/w/${pointerPart(location)}`,
      ));
    }
  }

  for (const [city, byLocation] of Object.entries(npcs)) {
    for (const [location, records] of Object.entries(byLocation)) {
      records.forEach((raw, index) => entities.npc_placements.push(entity(
        'npc_placement', `${city}|${location}|${raw.name}|${index}`, raw.name,
        { city, location, ...normalizeScalars(raw) },
        raw,
        'config/npcs.json',
        `JSON Pointer /${pointerPart(city)}/${pointerPart(location)}/${index}`,
      )));
    }
  }

  for (const [name, raw] of Object.entries(allItems)) {
    entities.items.push(entity(
      'item', `allItems|${name}`, name,
      { catalog: 'allItems', name, price: normalizeScalars(raw) },
      raw,
      'config/allItems.json',
      `JSON Pointer /${pointerPart(name)}`,
    ));
  }
  shopItems.forEach((raw, index) => entities.items.push(entity(
    'item', `shopItems|${raw.name}`, raw.name,
    { catalog: 'shopItems', ...normalizeScalars(raw) },
    raw,
    'config/shopItems.json',
    `JSON Pointer /${index}`,
  )));
  for (const [name, raw] of Object.entries(taskItems)) {
    entities.items.push(entity(
      'item', `taskItems|${name}`, name,
      { catalog: 'taskItems', name, value: normalizeScalars(raw) },
      raw,
      'config/taskItems.json',
      `JSON Pointer /${pointerPart(name)}`,
    ));
  }
  fish.forEach((raw, index) => entities.items.push(entity(
    'item', `fish|${raw.name}`, raw.name,
    { catalog: 'fish', ...normalizeScalars(raw) },
    raw,
    'config/fish.json',
    `JSON Pointer /${index}`,
  )));

  for (const [city, byLocation] of Object.entries(monsters)) {
    for (const [location, records] of Object.entries(byLocation)) {
      records.forEach((raw, index) => entities.monsters.push(entity(
        'monster', `${city}|${location}|${raw.name}|${index}`, raw.name,
        { city, location, ...normalizeScalars(raw) },
        raw,
        'config/monsters.json',
        `JSON Pointer /${pointerPart(city)}/${pointerPart(location)}/${index}`,
      )));
    }
  }

  for (const [file, relationType, catalog] of [
    ['monsterDrops.json', 'equipment', monsterDrops],
    ['monsterItems.json', 'item', monsterItems],
  ]) {
    for (const [monster, droppedNames] of Object.entries(catalog)) {
      droppedNames.forEach((droppedName, index) => entities.drops.push(entity(
        'drop', `${file}|${monster}|${droppedName}|${index}`, `${monster} → ${droppedName}`,
        { monster, dropped_entity_type: relationType, dropped_name: droppedName, probability: null, quantity: null },
        droppedName,
        `config/${file}`,
        `JSON Pointer /${pointerPart(monster)}/${index}`,
      )));
    }
  }

  for (const [region, offers] of Object.entries(cityShop)) {
    offers.forEach((raw, index) => {
      const itemDetails = shopItems.find((item) => item.name === raw.name) || null;
      entities.shops.push(entity(
        'shop', `${region}|${raw.name}|${index}`, `${region}-${raw.name}`,
        { region, item_name: raw.name, price: normalizeScalars(raw.value), item_details: itemDetails ? normalizeScalars(itemDetails) : null },
        raw,
        'config/cityShop.json',
        `JSON Pointer /${pointerPart(region)}/${index}`,
        itemDetails ? [source('config/shopItems.json', `array item name=${raw.name}`)] : [],
      ));
    });
  }

  for (const [city, goods] of Object.entries(marketItems)) {
    for (const [name, rawRange] of Object.entries(goods)) {
      entities.city_price_ranges.push(entity(
        'city_price_range', `${city}|${name}`, `${city}-${name}`,
        { city, item_name: name, minimum_price: Number(rawRange[0]), maximum_price: Number(rawRange[1]), currency: '铜贝' },
        rawRange,
        'config/marketItems.json',
        `JSON Pointer /${pointerPart(city)}/${pointerPart(name)}`,
      ));
    }
  }

  for (const [port, records] of Object.entries(ships)) {
    records.forEach((raw, index) => entities.ships.push(entity(
      'ship', `${port}|${raw.name}`, raw.name,
      { port, ...normalizeScalars(raw) },
      raw,
      'config/ship.json',
      `JSON Pointer /${pointerPart(port)}/${index}`,
    )));
  }

  trials.forEach((raw, index) => {
    const common = normalizedTaskFields(raw);
    const sourceMonsters = Array.isArray(raw.target?.monsters) ? raw.target.monsters : [];
    const sourceItems = Array.isArray(raw.target?.items) ? raw.target.items : [];
    const boss = raw.boss && typeof raw.boss.name === 'string' ? [raw.boss] : [];
    entities.trials.push(entity(
      'trial', `runtime:${2000 + index}|source:${raw.index}|${raw.name}`, raw.name,
      {
        source_index: raw.index,
        runtime_index: 2000 + index,
        name: raw.name,
        task_type: raw.taskType,
        receive_npc: raw.receiveNpc,
        submit_npc: raw.submitNpc,
        receive_location: raw.receiveLocation,
        submit_location: raw.submitLocation,
        target_location: raw.targetAddress,
        description: raw.description,
        content: raw.content,
        level_requirement: raw.levelRequirement ?? null,
        player_requirement: raw.playerRequirement ?? null,
        time_limit: raw.timeLimit ?? null,
        dialogue: { receive: raw.receiveDialog || [], submit: raw.submitDialog || [] },
        rewards: normalizeScalars(raw.prize || {}),
        predecessor_task: null,
        successor_task: null,
        ...common,
        required_items: sourceItems.map((item) => ({ name: item.name, quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : null })),
        kill_targets: [...sourceMonsters, ...boss].map((item) => ({ name: item.name, quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : null })),
        raw_source_record: raw,
      },
      raw,
      'config/trial.json',
      `JSON Pointer /${index}; source index=${raw.index}`,
      [source('src/task.js', `lines 4-8; runtime index=${2000 + index}`)],
    ));
  });

  return entities;
}

function updateTasks(baseline) {
  const rawBySource = new Map();
  for (let series = 1; series <= 15; series += 1) {
    const filename = `task${series}.json`;
    const records = readJson(path.join(configRoot, 'task', filename));
    records.forEach((raw, position) => rawBySource.set(`${filename}|${position}`, raw));
  }

  for (const task of baseline.tasks) {
    const value = task.canonical_value;
    const filename = `task${value.source_series}.json`;
    const raw = rawBySource.get(`${filename}|${value.source_array_position}`);
    if (!raw) throw new Error(`Missing source task for ${task.canonical_id}`);
    const fields = normalizedTaskFields(raw);
    task.original_display_name = raw.name;
    Object.assign(value, fields, {
      target_objects: fields.targets,
      required_quantities_raw: fields.raw_quantity,
      raw_source_record: raw,
      originality_status: 'UNVERIFIED_AS_ORIGINAL',
    });
    if (value.source_series === 15 && raw.index === 274) {
      value.conflict_refs = ['conflict.system.task.progress'];
      value.issue_refs = ['backlog.task.quantity-274'];
      value.quantity_normalization_note = '仅第一目标有原始数量 5；其余两个目标数量缺失，保持 null，禁止猜测。';
    } else {
      value.conflict_refs = [];
      value.issue_refs = [];
    }
  }
}

function updateTask274Conflict(baseline) {
  const conflict = baseline.conflicts.find((record) => record.canonical_id === 'conflict.system.task.progress');
  if (!conflict) throw new Error('Missing conflict.system.task.progress');
  const variant = 'task15/index=274 三个击杀目标仅有一个数量；后两个数量未知';
  if (!conflict.canonical_value.variants.includes(variant)) conflict.canonical_value.variants.push(variant);
  if (!conflict.conflicts.includes(variant)) conflict.conflicts.push(variant);
  if (!conflict.sources.some((item) => item.relative_path === 'config/task/task15.json' && item.locator.includes('index=274'))) {
    conflict.sources.push({
      ...source('config/task/task15.json', 'array_position=94; index=274'),
      original_value_summary: 'targetName 有 3 项，quantity 原始值仅为 "5"',
    });
  }
  conflict.canonical_value.tentative_decision = '保留主要源实际行为；task15/index=274 仅确认第一目标数量为 5，后两项规范化为 null，等待外部证据。';
}

function main() {
  const baseline = readJson(baselinePath);
  updateTasks(baseline);
  updateTask274Conflict(baseline);
  const entities = buildEntities();

  const connectionsSummary = baseline.configs.records.find((record) => record.canonical_id === 'config.connections');
  connectionsSummary.canonical_value.primary_entity_count = entities.location_connections.length;
  connectionsSummary.canonical_value.interior_location_entries = 445;
  connectionsSummary.canonical_value.wild_to_entrance_entries = 182;
  connectionsSummary.canonical_value.previous_incorrect_count = 475;
  connectionsSummary.sources[0].locator = '40 city objects; n[445] + w entries[182] = 627 relations';
  connectionsSummary.sources[0].original_value_summary = '445 条城内地点成员关系与 182 条野外地点入口映射';

  const pricesSummary = baseline.configs.records.find((record) => record.canonical_id === 'config.prices');
  pricesSummary.canonical_value.primary_entity_count = entities.city_price_ranges.length;
  pricesSummary.canonical_value.market_city_goods_ranges = entities.city_price_ranges.length;
  pricesSummary.canonical_value.price_boundary_values = 106;
  pricesSummary.canonical_value.previous_incorrect_count = 106;
  pricesSummary.sources[0].locator = '32 cities; 54 city-goods ranges; 106 boundary values';
  pricesSummary.sources[0].original_value_summary = '54 条城市商品价格区间（共 106 个已填上下界值）';

  const summaryMapping = {
    world_regions: 'config.world-regions',
    cities: 'config.cities',
    locations: 'config.locations',
    location_connections: 'config.connections',
    npc_placements: 'config.npcs',
    items: 'config.items',
    equipment: 'config.equipment',
    monsters: 'config.enemies',
    drops: 'config.drops',
    shops: 'config.shops',
    city_price_ranges: 'config.prices',
    ships: 'config.ships',
    fish: 'config.fishing',
    pets: 'config.pets',
    trials: 'config.trials',
  };
  const entityStatistics = Object.fromEntries(Object.entries(entities).map(([key, records]) => [key, records.length]));

  for (const [collection, summaryId] of Object.entries(summaryMapping)) {
    const summary = baseline.configs.records.find((record) => record.canonical_id === summaryId);
    if (!summary) throw new Error(`Missing config summary ${summaryId}`);
    summary.canonical_value.entity_collection = collection;
  }

  baseline.meta.schema_version = '2.0.0';
  baseline.meta.revision_base_commit = revisionBaseCommit;
  baseline.meta.scope = '多源复原证据摘要、651 条常规任务与 15 类可直接导入的完整配置实体；单源内容不冒充官方原作。';
  baseline.meta.statistics.config_entities = Object.values(entityStatistics).reduce((sum, count) => sum + count, 0);
  baseline.meta.statistics.config_entity_counts = entityStatistics;
  baseline.meta.normalization = {
    task_array_fields: ['targets', 'required_quantities', 'required_items', 'kill_targets'],
    unknown_quantity_representation: null,
    raw_value_policy: '原始任务记录保存在 raw_source_record，拆分前字段另存 raw_*；配置实体原值保存在 raw_data。',
    originality_policy: 'SINGLE_SOURCE/UNVERIFIED_AS_ORIGINAL 内容仅作为复原基线，不声明为官方原作。',
  };
  baseline.configs.entity_counting_rule = 'configs.entities 各数组一项即一条可导入实体；条数必须与对应 configs.records[].canonical_value.primary_entity_count 一致。';
  baseline.configs.entity_summary_mapping = summaryMapping;
  baseline.configs.entity_statistics = entityStatistics;
  baseline.configs.entities = entities;

  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { encoding: 'utf8' });
  process.stdout.write(`${JSON.stringify({ baseline: baselinePath, entity_statistics: entityStatistics }, null, 2)}\n`);
}

main();
