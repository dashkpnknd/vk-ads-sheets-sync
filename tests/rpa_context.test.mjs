import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../bin/rpa_sync_projects.mjs', import.meta.url), 'utf8');
function load(name, next, deps) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\n${next}`, start);
  return vm.runInNewContext(`(${source.slice(start, end)})`, deps);
}
const normalizeConfigValue = value => String(value ?? '').trim().toLowerCase();

test('explicit source recognizes I-Hub and does not rename unrelated cabinets', () => {
  const canonicalize = load('canonicalizeCabinetProject', 'function canonicalizeProjectRecord', {
    parseCabinetName: () => null,
  });
  const sources = {'ihub|ноябрьск': [{accountLabel:'new',cabinetId:'agency:working'}]};
  const current = canonicalize({accountLabel:'new',cabinetId:'agency:working',cabinetName:'I-Hub Ноябрьск (Церебро)'}, new Map(), sources);
  assert.equal(current.parsed.projectKey, 'ihub|ноябрьск');
  assert.equal(canonicalize({accountLabel:'old',cabinetId:'agency:working'}, new Map(), sources).parsed, null);
});

const active = {userId:'working-user',accountId:'account',sudo:'working@agency_client',cabinetName:'I-Hub Ноябрьск (Церебро)'};
const cabinet = {cabinetId:'agency:working@agency_client',agencySudo:active.sudo,cabinetName:active.cabinetName};
function statsReader(state, payload) {
  const navigations = [];
  const read = load('getStatsForCabinet', 'async function resetVkPage', {
    URL, URLSearchParams,
    selectCabinet: async () => active,
    vkDate: () => '01.10.2026',
    sleep: async () => {}, normalizeConfigValue,
    buildAdPlansUrl: () => 'https://ads.vk.ru/plans',
    buildDashboardStatsUrl: () => 'https://ads.vk.ru/stats',
    normalizeDashboardStats: x => x.total.base,
    normalizeDashboardStatsItems: () => [],
    VK_API_TIMEOUT_MS: 15000,
  });
  let fetches = 0;
  const client = {send:async (method, params) => {
    if(method === 'Page.navigate') navigations.push(params.url);
    if(method !== 'Runtime.evaluate') return {};
    if(!params.awaitPromise) return {result:{value:state}};
    const data = fetches++ === 0 ? {items:[{id:1,name:'campaign'}]} : payload;
    return {result:{value:{status:200,data}}};
  }};
  return {read:()=>read(client,cabinet,'2026-10-01'),navigations};
}
test('statistics navigation preserves sudo and accepts verified cabinet data', async () => {
  const run = statsReader(active,{items:[{id:1,user_id:active.userId}],total:{base:{leads:3,spend:100}}});
  const result = await run.read();
  assert.equal(new URL(run.navigations[0]).searchParams.get('sudo'),active.sudo);
  assert.equal(result.stats.leads,3);
});
test('switching back to personal account fails instead of returning zero', async () => {
  const run = statsReader({...active,userId:'personal',cabinetName:'Personal'},{});
  await assert.rejects(run.read(),/Cabinet context changed/);
});
test('statistics for another user are rejected', async () => {
  const run = statsReader(active,{items:[{id:1,user_id:'wrong-user'}],total:{base:{}}});
  await assert.rejects(run.read(),/Stats belong to another cabinet/);
});
