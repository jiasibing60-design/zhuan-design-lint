import { DEFAULT_SETTINGS } from '../shared/types';
import type { UIMessage, Settings, ScanResult, Scope, Issue, IgnoreEntry, RepairPlan, RepairLog, CleanupPlan } from '../shared/types';
import { lintNode } from './rules';
import { createSnapshotReader } from './snapshot';
import { findCandidates, applyCandidate } from './candidates';
import { repairItem, prepareRepair, repairGuard, captureRepairState } from './repairs';
import { automaticChoices, repairConflict } from './automatic';
import { buildCleanupPlan, prototypeReferences, validateCleanup, cleanupStillEligible } from './cleanup';

figma.showUI(__html__, { width:400,height:680,themeColors:true });
figma.skipInvisibleInstanceChildren = false;
let settings: Settings = { ...DEFAULT_SETTINGS };
let ignored: IgnoreEntry[] = [];
let result: ScanResult | undefined;
let roots: string[] = [];
let scope: Scope = 'selection';
let pageId = figma.currentPage.id;
let generation = 0, scanning = false, pending = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let repairing=false, planning=false;
let cleanupSequence=0;
let cleanupPlan:{plan:CleanupPlan;guards:Map<string,string>}|undefined;
let repairSequence=0;
let currentPlan:{ plan:RepairPlan; guards:Map<string,string>; settings:string }|undefined;
const repairHistory:RepairLog[]=[];
const post = (message: object) => figma.ui.postMessage(message);
const fail = (e: unknown) => post({ type:'error',message:e instanceof Error ? e.message : String(e) });
const storeKey = 'zhuan-design-lint-settings-v2';
const ignoreKey = 'zhuan-design-lint-ignored-v2';
const saveIgnored = () => figma.currentPage.setPluginData(ignoreKey,JSON.stringify(ignored));
function loadIgnored() {
  try { ignored = JSON.parse(figma.currentPage.getPluginData(ignoreKey) || '[]'); } catch { ignored = []; }
}
function sendResult() {
  if (!result) return;
  const all = [...result.issues,...result.ignored];
  result.issues = all.filter(issue => !ignored.some(i => i.fingerprint === issue.fingerprint));
  result.ignored = all.flatMap(issue => { const entry = ignored.find(i => i.fingerprint === issue.fingerprint); return entry ? [{ ...issue,ignore:entry }] : []; });
  post({ type:'result',result });
}
const vectors = new Set(['VECTOR','BOOLEAN_OPERATION','STAR','POLYGON','ELLIPSE']);
function excluded(node: SceneNode, rules: Settings) {
  if (node.type === 'SLICE') return true;
  for (let p: BaseNode | null = node; p && p.type !== 'PAGE'; p = p.parent) {
    if ('visible' in p && !rules.includeHidden && !p.visible) return true;
    if ('locked' in p && !rules.includeLocked && p.locked) return true;
  }
  return false;
}
async function scan(useCurrentSelection = false) {
  if(repairing||planning) { pending=true; return; }
  if (scanning) { pending = true; return; }
  const run = ++generation;
  scanning = true;
  const started = Date.now();
  const scanSettings = { ...settings };
  currentPlan=undefined;
  post({ type:'scanning',scanned:0 });
  try {
    if (figma.currentPage.id !== pageId) { pageId = figma.currentPage.id; roots = []; result = undefined; loadIgnored(); }
    if (useCurrentSelection && scope === 'selection') roots = figma.currentPage.selection.map(n => n.id);
    if (scope === 'selection' && roots.length === 0) throw new Error('请先在 Figma 中选中要交付的画板或图层');
    const selected = scope === 'page' ? [...figma.currentPage.children] : (await Promise.all(roots.map(id => figma.getNodeByIdAsync(id)))).filter((n): n is SceneNode => !!n && n.type !== 'PAGE' && n.type !== 'DOCUMENT' && !n.removed);
    if (!selected.length && scope === 'selection') throw new Error('检查范围已被删除，请重新选择图层');
    const reader = createSnapshotReader();
    const visited = new Set<string>();
    const issues: Issue[] = [];
    let scanned = 0, skipped = 0, unreadable = 0;
    const stack = [...selected].reverse();
    while (stack.length) {
      if (run !== generation || figma.currentPage.id !== pageId) { post({ type:'cancelled' }); return; }
      const node = stack.pop()!;
      if (visited.has(node.id) || node.removed) continue;
      visited.add(node.id);
      if (excluded(node,scanSettings)) { skipped++; continue; }
      if (vectors.has(node.type) && !scanSettings.includeVectors) skipped++;
      else {
        try { issues.push(...lintNode(await reader(node),scanSettings)); scanned++; }
        catch { unreadable++; }
      }
      if ('children' in node) stack.push(...[...node.children].reverse());
      if (visited.size % 80 === 0) { post({ type:'scanning',scanned }); await new Promise(resolve => setTimeout(resolve,0)); }
    }
    if (run !== generation || figma.currentPage.id !== pageId) { post({ type:'cancelled' }); return; }
    const notices: string[] = [];
    if (!scanSettings.includeHidden) notices.push('已跳过隐藏图层及其子树');
    if (!scanSettings.includeLocked) notices.push('已跳过锁定图层及其子树');
    if (!scanSettings.includeVectors) notices.push('未检查矢量图层');
    if (unreadable) notices.push(`${unreadable} 个图层读取失败，请重新检查`);
    result = { issues,ignored:[],scanned,skipped,unreadable,complete:unreadable === 0,scope,scopeNames:scope === 'page' ? [figma.currentPage.name] : selected.map(n => n.name),pageId,pageName:figma.currentPage.name,at:new Date().toISOString(),duration:Date.now()-started,settings:scanSettings,notices,repairHistory:[...repairHistory] };
    sendResult();
  } catch(e) { fail(e); }
  finally { scanning = false; if (pending) { pending = false; timer=setTimeout(()=>{void scan();},600); } }
}
function schedule() {
  if(repairing||planning) { pending=true; return; }
  if (!settings.live) return;
  if (scanning) { pending = true; return; }
  if (!result || !settings.live) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void scan(); },600);
}
async function locate(ids: string[]) {
  const found = await Promise.all([...new Set(ids)].slice(0,500).map(id => figma.getNodeByIdAsync(id)));
  const nodes = found.filter((n): n is SceneNode => !!n && n.type !== 'DOCUMENT' && n.type !== 'PAGE' && !n.removed);
  if (!nodes.length) throw new Error('图层已被删除，请重新检查');
  let page: BaseNode | null = nodes[0];
  while (page && page.type !== 'PAGE') page = page.parent;
  if (page?.type === 'PAGE' && page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page);
  const onPage = nodes.filter(node => { let p: BaseNode | null = node; while(p && p.type !== 'PAGE') p = p.parent; return p?.id === figma.currentPage.id; });
  figma.currentPage.selection = onPage;
  figma.viewport.scrollAndZoomIntoView(onPage);
  if (ids.length > 500) figma.notify('一次最多定位 500 个图层，其余问题请筛选后定位');
}

async function makeRepairPlan(issueIds:string[],limit=100):Promise<RepairPlan> {
  planning=true;
  try {
      if(scanning)throw new Error('请等待检查完成，再预览修复');
      if(!result)throw new Error('请先检查设计稿');
      const ids=[...new Set(issueIds)];
      if(ids.length>limit)throw new Error(`一次最多预览 ${limit} 项，请筛选后分批处理`);
      if(timer)clearTimeout(timer);
      const sequence=++repairSequence;
      const previewPage=figma.currentPage.id;
      const previewSettings=JSON.stringify(settings);
      const guards=new Map<string,string>();
      const plan:RepairPlan={id:'repair-'+sequence,pageId:previewPage,items:[],at:new Date().toISOString()};
      const reader=createSnapshotReader();
      for(const id of ids) {
        const issue=result.issues.find(i=>i.id===id);
        if(!issue)continue;
        const node=await figma.getNodeByIdAsync(issue.nodeId);
        if(!node||node.type==='PAGE'||node.type==='DOCUMENT'||node.removed)continue;
        const before=await repairGuard(node);
        const snapshot=await reader(node);
        if(!lintNode(snapshot,settings).some(i=>i.fingerprint===issue.fingerprint))throw new Error('设计稿已变化，请重新检查后预览');
        const item=await repairItem(issue,node,snapshot,settings);
        if(before!==await repairGuard(node))throw new Error('生成预览期间图层已变化，请重新预览');
        guards.set(node.id,before);plan.items.push(item);
      }
      if(sequence!==repairSequence||figma.currentPage.id!==previewPage||previewSettings!==JSON.stringify(settings)||scanning)throw new Error('检查范围或设置已变化，请重新预览');
      currentPlan={plan,guards,settings:previewSettings};
      return plan;

  } finally {planning=false;}
}
async function applyRepairPlan(planId:string,choices:{issueId:string;optionId:string}[],automatic=false) {
      const stored=currentPlan;
      if(!stored||stored.plan.id!==planId||stored.plan.pageId!==figma.currentPage.id||stored.settings!==JSON.stringify(settings)||scanning)throw new Error('修复预览已过期，请重新预览');

      if(!choices.length||choices.length>100)throw new Error('请选择 1–100 项修复');
      const targets=new Set<string>();
      const selected=choices.map(choice=>{
        const item=stored.plan.items.find(i=>i.issue.id===choice.issueId);
        const option=item?.options.find(o=>o.id===choice.optionId);
        if(!item||!option)throw new Error('修复选项已变化');
        if(targets.has(item.target))throw new Error('同一个属性存在多个修复目标，请只保留一个');
        targets.add(item.target);return {item,option};
      });
      for(let i=0;i<selected.length;i++) if(selected.slice(0,i).some(other=>repairConflict(other,selected[i])))throw new Error('样式和属性修复存在冲突，请分批处理');
      repairing=true;currentPlan=undefined;if(timer)clearTimeout(timer);pending=false;
      const log:RepairLog={at:new Date().toISOString(),entries:[]};
      post({type:'repairing',done:0,total:selected.length});
      figma.commitUndo();
      try {
        for(const {item,option} of selected) {
          const entry:RepairLog['entries'][number]={nodeId:item.issue.nodeId,nodeName:item.issue.nodeName,issueId:item.issue.id,before:item.issue.actual,after:option.label,status:'skipped'};
          let rollback:(()=>Promise<void>)|undefined;
          let wrote=false;
          try {
            if(figma.currentPage.id!==stored.plan.pageId)throw new Error('已切换页面，跳过剩余修改');
            const node=await figma.getNodeByIdAsync(item.issue.nodeId);
            if(!node||node.type==='PAGE'||node.type==='DOCUMENT'||node.removed)throw new Error('图层已删除');
            const guard=await repairGuard(node);
            if(guard!==stored.guards.get(node.id))throw new Error('图层已在预览后发生变化，请重新预览');
            const execute=await prepareRepair(item.issue,node,option);
            if(await repairGuard(node)!==guard||figma.currentPage.id!==stored.plan.pageId)throw new Error('加载字体或变量时图层已变化，请重新预览');
            rollback=await captureRepairState(item.issue,node,option);
            if(await repairGuard(node)!==guard||figma.currentPage.id!==stored.plan.pageId)throw new Error('准备恢复记录时图层已变化，请重新预览');
            wrote=true;await execute();
            stored.guards.set(node.id,await repairGuard(node));
            entry.status='applied';
          }catch(e){
            entry.message=e instanceof Error?e.message:String(e);
            if(wrote&&rollback) {
              entry.status='failed';
              try{await rollback();entry.message+='；已恢复该项修改前的属性';}catch{entry.message+='；恢复失败，请使用 Figma 撤销';}
            }
          }
          log.entries.push(entry);post({type:'repairing',done:log.entries.length,total:selected.length});
        }
      }finally{
        figma.commitUndo();repairing=false;pending=false;
        if(figma.currentPage.id===stored.plan.pageId)repairHistory.push(log);
        post({type:'repair-complete',log,automatic});
        await scan();
      }

}
async function cleanupReferences() {
  await figma.loadAllPagesAsync();
  return prototypeReferences(figma.root.children);
}
async function previewCleanup(cleanupScope:Scope) {
  if(scanning)throw new Error('请等待检查完成');
  planning=true;
  if(timer)clearTimeout(timer);
  try {
    const page=figma.currentPage;
    const selected=cleanupScope==='page'?[...page.children]:[...page.selection];
    if(cleanupScope==='selection'&&!selected.length)throw new Error('请先选择要清理的画板或图层');
    const refs=await cleanupReferences();
    const stored=await buildCleanupPlan(page,selected,refs,'cleanup-'+(++cleanupSequence));
    if(figma.currentPage.id!==page.id)throw new Error('已切换页面，请重新预览');
    cleanupPlan=stored;post({type:'cleanup-plan',plan:stored.plan});
  }finally {planning=false;}
}
async function applyCleanup(planId:string,nodeIds:string[]) {
  const stored=cleanupPlan;
  if(!stored||stored.plan.id!==planId||stored.plan.pageId!==figma.currentPage.id||scanning)throw new Error('清理预览已过期，请重新预览');
  const ids=[...new Set(nodeIds)];
  if(!ids.length||ids.length>500)throw new Error('请选择 1–500 个图层');
  if(ids.some(id=>!stored.plan.items.some(item=>item.id===id)))throw new Error('清理选项已变化');
  repairing=true;cleanupPlan=undefined;currentPlan=undefined;if(timer)clearTimeout(timer);pending=false;
  const entries:{name:string;status:'deleted'|'skipped';message?:string;descendants:number}[]=[];
  post({type:'cleaning',done:0,total:ids.length});
  figma.commitUndo();
  try {
    const refs=await cleanupReferences();
    for(const id of ids) {
      const item=stored.plan.items.find(i=>i.id===id)!;
      try {
        const node=await figma.getNodeByIdAsync(id);
        if(!node||node.type==='PAGE'||node.type==='DOCUMENT'||figma.currentPage.id!==stored.plan.pageId
          ||!await validateCleanup(item,node,stored.plan.pageId,refs,stored.guards.get(id)!))throw new Error('图层内容、锁定状态或引用已变化，请重新预览');
        if(figma.currentPage.id!==stored.plan.pageId||!cleanupStillEligible(item,node,stored.plan.pageId,prototypeReferences(figma.root.children)))throw new Error('页面或图层引用已变化，请重新预览');
        node.remove();entries.push({name:item.name,status:'deleted',descendants:item.descendants});
      }catch(e){entries.push({name:item.name,status:'skipped',descendants:0,message:e instanceof Error?e.message:String(e)});}
      post({type:'cleaning',done:entries.length,total:ids.length});
    }
  }finally {
    figma.commitUndo();repairing=false;pending=false;
    post({type:'cleanup-complete',entries});
    if(result&&figma.currentPage.id===stored.plan.pageId) {
      roots=roots.filter(id=>!entries.some((entry,i)=>entry.status==='deleted'&&ids[i]===id));
      if(scope==='selection'&&!roots.length){result=undefined;post({type:'reset',pageName:figma.currentPage.name});}
      else await scan();
    }
  }
}

let observedPage = figma.currentPage;
observedPage.on('nodechange',schedule);
figma.on('selectionchange',() => post({ type:'selection',count:figma.currentPage.selection.length }));
figma.on('currentpagechange',() => { generation++; currentPlan=undefined;cleanupPlan=undefined;repairHistory.length=0;observedPage.off('nodechange',schedule); observedPage=figma.currentPage; observedPage.on('nodechange',schedule); if(timer)clearTimeout(timer);pending=false;roots=[];result=undefined;pageId=figma.currentPage.id;loadIgnored();post({ type:'reset',pageName:figma.currentPage.name }); });
figma.ui.onmessage = async (msg: UIMessage) => {
  try {
    if((repairing||planning)&&msg.type!=='close')throw new Error('正在修复，请等待修改完成');
    if (msg.type === 'ready') {
      const stored = await figma.clientStorage.getAsync(storeKey);
      settings = normalizeSettings(stored ?? DEFAULT_SETTINGS);
      loadIgnored();
      post({ type:'init',settings,pageName:figma.currentPage.name,count:figma.currentPage.selection.length });
    } else if(msg.type==='repair-preview') {
      const plan=await makeRepairPlan(msg.issueIds);
      post({type:'repair-plan',plan,requestId:msg.requestId});
    } else if(msg.type==='repair-apply') {
      await applyRepairPlan(msg.planId,msg.choices);
    } else if(msg.type==='auto-repair') {
      if(scanning)throw new Error('请等待检查完成');
      if(!result)throw new Error('请先检查设计稿');
      await scan();
      const candidates=result.issues.filter(i=>['missing-text-style','missing-color-binding','price-font-style'].includes(i.rule)).slice(0,500);
      if(!candidates.length){post({type:'auto-empty',message:'没有可直接修复的项目。字号、圆角与颜色用途请点击问题右侧的修复选择目标。'});return;}
      post({type:'planning'});
      const plan=await makeRepairPlan(candidates.map(i=>i.id),500);
      const choices=automaticChoices(plan.items);
      if(!choices.length){post({type:'auto-empty',message:'没有唯一匹配的修复目标，请逐项选择适用样式或规范值。'});return;}
      await applyRepairPlan(plan.id,choices,true);
    } else if(msg.type==='cleanup-preview') {
      await previewCleanup(msg.scope);
    } else if(msg.type==='cleanup-apply') {
      await applyCleanup(msg.planId,msg.nodeIds);
    } else if (msg.type === 'scan') { scope=msg.scope; await scan(true); }
    else if (msg.type === 'cancel') { generation++; pending=false; }
    else if (msg.type === 'settings') {
      currentPlan=undefined;
      if (scanning) { generation++; pending=true; }
      settings=normalizeSettings(msg.settings); await figma.clientStorage.setAsync(storeKey,settings);
      post({ type:'settings-saved',settings });
      if (result) await scan();
    } else if (msg.type === 'locate') await locate(msg.nodeIds);
    else if (msg.type === 'ignore') {
      const issue = result?.issues.find(i => i.fingerprint === msg.fingerprint);
      if (issue && msg.reason.trim()) { ignored=ignored.filter(i=>i.fingerprint!==msg.fingerprint);ignored.push({ fingerprint:msg.fingerprint,reason:msg.reason.trim().slice(0,240),at:new Date().toISOString() });saveIgnored();sendResult(); }
    } else if (msg.type === 'restore') { ignored=ignored.filter(i=>i.fingerprint!==msg.fingerprint);saveIgnored();sendResult(); }
    else if (msg.type === 'clear-ignored') { ignored=[];saveIgnored();sendResult(); }
    else if (msg.type === 'candidates' || msg.type === 'apply') {
      const issue = result?.issues.find(i=>i.id===msg.issueId);
      if (!issue) throw new Error('问题已变化，请重新检查');
      const node = await figma.getNodeByIdAsync(issue.nodeId);
      if (!node || node.type === 'PAGE' || node.type === 'DOCUMENT' || node.removed) throw new Error('图层已被删除');
      const fresh = lintNode(await createSnapshotReader()(node),settings).find(i=>i.fingerprint===issue.fingerprint);
      if (!fresh) throw new Error('图层属性已变化，请重新检查');
      const candidates = await findCandidates(fresh,node);
      if (msg.type === 'candidates') post({ type:'candidates',issueId:issue.id,candidates });
      else {
        const candidate=candidates.find(c=>c.id===msg.candidateId);
        if (!candidate) throw new Error('候选样式已变化，请重新匹配');
        await applyCandidate(fresh,node,candidate);figma.commitUndo();figma.notify('已应用，可用 Figma 撤销恢复');await scan();
      }
    } else if (msg.type === 'close') figma.closePlugin();
  } catch(e) { fail(e); }
};
export function normalizeSettings(input: Partial<Settings>): Settings {
  const output = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(output) as (keyof Settings)[]) {
    if (key === 'scale') output.scale = input.scale === 0.5 ? 0.5 : 1;
    else if (typeof input[key] === 'boolean') (output[key] as boolean) = input[key] as boolean;
  }
  return output;
}
