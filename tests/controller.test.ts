import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { DEFAULT_SETTINGS } from '../src/shared/types';
const built = await build({entryPoints:['src/plugin/controller.ts'],bundle:true,write:false,format:'iife',target:'es2020'});
const code=built.outputFiles[0].text;
function harness() {
  const messages:any[]=[];
  const listeners:Record<string,()=>void>={};
  const data:Record<string,string>={};
  const page:any={id:'0:1',name:'交付页面',type:'PAGE',parent:{type:'DOCUMENT'},children:[],selection:[],getPluginData:(k:string)=>data[k]||'',setPluginData:(k:string,v:string)=>{data[k]=v;},on:(name:string,cb:()=>void)=>listeners[name]=cb,off:(name:string)=>delete listeners[name]};
  const black={type:'SOLID',color:{r:17/255,g:17/255,b:17/255},opacity:1};
  const child:any={id:'1:2',name:'未绑定颜色',type:'RECTANGLE',parent:null,visible:true,locked:false,fills:[black],strokes:[],fillStyleId:'',strokeStyleId:'',removed:false};
  const root:any={id:'1:1',name:'交付画板',type:'FRAME',parent:page,visible:true,locked:false,children:[child],fills:[],strokes:[],fillStyleId:'',strokeStyleId:'',removed:false};
  child.parent=root;page.children=[root];page.selection=[root,child];
  const nodes:any={'1:1':root,'1:2':child,'0:1':page};
  const api:any={currentPage:page,ui:{postMessage:(m:any)=>messages.push(m)},showUI:()=>{},on:(name:string,cb:()=>void)=>listeners[name]=cb,variables:{getVariableByIdAsync:async()=>null},clientStorage:{getAsync:async()=>DEFAULT_SETTINGS,setAsync:async()=>{}},getNodeByIdAsync:async(id:string)=>nodes[id]||null,viewport:{scrollAndZoomIntoView:()=>{}},notify:()=>{},commitUndo:()=>{}};
  vm.runInNewContext(code,{figma:api,__html__:'',setTimeout,clearTimeout,console});
  const send=async(m:any)=>{await api.ui.onmessage(m);};
  return {messages,listeners,page,root,child,nodes,send,api,data};
}
test('扫描重叠选择不重复，定位不改变复查范围，忽略可恢复',async()=>{
  const h=harness();await h.send({type:'ready'});await h.send({type:'scan',scope:'selection'});
  let r=h.messages.filter(m=>m.type==='result').slice(-1)[0].result;
  assert.equal(r.scanned,2);assert.equal(r.issues.length,1);
  await h.send({type:'locate',nodeIds:['1:2']});assert.equal(h.page.selection[0],h.child);
  await h.send({type:'ignore',fingerprint:r.issues[0].fingerprint,reason:'活动插画'});
  r=h.messages.filter(m=>m.type==='result').slice(-1)[0].result;assert.equal(r.issues.length,0);assert.equal(r.ignored.length,1);
  await h.send({type:'settings',settings:DEFAULT_SETTINGS});
  r=h.messages.filter(m=>m.type==='result').slice(-1)[0].result;assert.equal(r.scanned,2);assert.equal(r.ignored.length,1);
  await h.send({type:'restore',fingerprint:r.ignored[0].fingerprint});
  r=h.messages.filter(m=>m.type==='result').slice(-1)[0].result;assert.equal(r.issues.length,1);assert.equal(r.ignored.length,0);
});
test('隐藏和锁定祖先按设置跳过',async()=>{
  const h=harness();h.root.locked=true;await h.send({type:'ready'});await h.send({type:'scan',scope:'page'});
  let r=h.messages.filter(m=>m.type==='result').slice(-1)[0].result;assert.equal(r.scanned,0);assert.equal(r.issues.length,0);
  await h.send({type:'settings',settings:{...DEFAULT_SETTINGS,includeLocked:true}});
  r=h.messages.filter(m=>m.type==='result').slice(-1)[0].result;assert.equal(r.scanned,2);assert.equal(r.issues.length,1);
});
test('空页面扫描返回完整空结果；空选择提示选择范围',async()=>{
  const h=harness();h.page.children=[];h.page.selection=[];await h.send({type:'ready'});await h.send({type:'scan',scope:'page'});
  assert.equal(h.messages.filter(m=>m.type==='result').slice(-1)[0].result.scanned,0);
  await h.send({type:'scan',scope:'selection'});assert.ok(h.messages.some(m=>m.type==='error'&&m.message.includes('请先')));
});
test('删除后定位返回错误，读取失败不能呈现为完整通过',async()=>{
  const h=harness();await h.send({type:'ready'});delete h.nodes['1:2'];await h.send({type:'locate',nodeIds:['1:2']});
  assert.ok(h.messages.some(m=>m.type==='error'&&m.message.includes('删除')));
  Object.defineProperty(h.child,'fills',{get:()=>{throw new Error('unreadable');}});
  await h.send({type:'scan',scope:'page'});const r=h.messages.filter(m=>m.type==='result').slice(-1)[0].result;
  assert.equal(r.unreadable,1);assert.equal(r.complete,false);
});
test('页面 nodechange 自动复查，并保持初始范围',async()=>{
  const h=harness();await h.send({type:'ready'});await h.send({type:'scan',scope:'selection'});
  h.page.selection=[h.child];h.child.fillStyleId='S:color';h.listeners.nodechange();
  await new Promise(resolve=>setTimeout(resolve,680));
  const r=h.messages.filter(m=>m.type==='result').slice(-1)[0].result;
  assert.equal(r.scanned,2);assert.equal(r.issues.length,0);
});
test('批量修复预览后修改属性、复查与导出修复记录',async()=>{
  const h=harness();h.child.topLeftRadius=10;h.child.topRightRadius=8;h.child.bottomLeftRadius=0;h.child.bottomRightRadius=16;h.child.setBoundVariable=()=>{};
  await h.send({type:'ready'});await h.send({type:'scan',scope:'page'});
  const r=h.messages.filter(m=>m.type==='result').slice(-1)[0].result;const issue=r.issues.find((i:any)=>i.rule==='radius-outside-spec');
  await h.send({type:'repair-preview',issueIds:[issue.id],requestId:'test'});
  const plan=h.messages.filter(m=>m.type==='repair-plan').slice(-1)[0].plan;assert.equal(h.child.topLeftRadius,10);
  await h.send({type:'repair-apply',planId:plan.id,choices:[{issueId:issue.id,optionId:'radius:12'}]});
  assert.equal(h.child.topLeftRadius,12);assert.equal(h.child.topRightRadius,8);
  const updated=h.messages.filter(m=>m.type==='result').slice(-1)[0].result;
  assert.equal(updated.issues.filter((i:any)=>i.category==='radius').length,0);assert.equal(updated.repairHistory[0].entries[0].status,'applied');
});
test('预览后图层改变则跳过，失败项恢复并记录',async()=>{
  const h=harness();Object.assign(h.child,{topLeftRadius:10,topRightRadius:8,bottomLeftRadius:0,bottomRightRadius:16,setBoundVariable:()=>{}});
  await h.send({type:'ready'});await h.send({type:'scan',scope:'page'});
  let r=h.messages.filter(m=>m.type==='result').slice(-1)[0].result;let issue=r.issues.find((i:any)=>i.rule==='radius-outside-spec');
  await h.send({type:'repair-preview',issueIds:[issue.id],requestId:'test'});let plan=h.messages.filter(m=>m.type==='repair-plan').slice(-1)[0].plan;
  h.child.name='预览后改名';await h.send({type:'repair-apply',planId:plan.id,choices:[{issueId:issue.id,optionId:'radius:12'}]});assert.equal(h.child.topLeftRadius,10);
  let log=h.messages.filter(m=>m.type==='repair-complete').slice(-1)[0].log;assert.equal(log.entries[0].status,'skipped');
  r=h.messages.filter(m=>m.type==='result').slice(-1)[0].result;issue=r.issues.find((i:any)=>i.rule==='radius-outside-spec');
  await h.send({type:'repair-preview',issueIds:[issue.id],requestId:'test2'});plan=h.messages.filter(m=>m.type==='repair-plan').slice(-1)[0].plan;
  let value=10;Object.defineProperty(h.child,'topLeftRadius',{get:()=>value,set:(v:number)=>{value=v;if(v===12)throw new Error('write failed');}});
  await h.send({type:'repair-apply',planId:plan.id,choices:[{issueId:issue.id,optionId:'radius:12'}]});assert.equal(h.child.topLeftRadius,10);
  log=h.messages.filter(m=>m.type==='repair-complete').slice(-1)[0].log;assert.equal(log.entries[0].status,'failed');assert.ok(log.entries[0].message.includes('已恢复'));
});
test('修复同一属性多个目标会被拒绝，关闭规则导致预览失效',async()=>{
  const h=harness();Object.assign(h.child,{topLeftRadius:10,topRightRadius:8,bottomLeftRadius:0,bottomRightRadius:16,setBoundVariable:()=>{}});
  await h.send({type:'ready'});await h.send({type:'scan',scope:'page'});
  const r=h.messages.filter(m=>m.type==='result').slice(-1)[0].result;const issue=r.issues.find((i:any)=>i.rule==='radius-outside-spec');
  await h.send({type:'repair-preview',issueIds:[issue.id],requestId:'test'});const plan=h.messages.filter(m=>m.type==='repair-plan').slice(-1)[0].plan;
  await h.send({type:'repair-apply',planId:plan.id,choices:[{issueId:issue.id,optionId:'radius:12'},{issueId:issue.id,optionId:'radius:8'}]});
  assert.ok(h.messages.some(m=>m.type==='error'&&m.message.includes('多个修复目标')));assert.equal(h.child.topLeftRadius,10);
  await h.send({type:'settings',settings:{...DEFAULT_SETTINGS,radius:false}});
  await h.send({type:'repair-apply',planId:plan.id,choices:[{issueId:issue.id,optionId:'radius:12'}]});
  assert.ok(h.messages.some(m=>m.type==='error'&&m.message.includes('过期')));
});
test('一键修复直接建立唯一同值颜色样式，复查并保留需人工选值的圆角',async()=>{
  const h=harness();const style:any={id:'S:black',name:'黑色',paints:h.child.fills,type:'PAINT'};
  Object.assign(h.api,{getLocalPaintStylesAsync:async()=>[style],getLocalTextStylesAsync:async()=>[],getStyleByIdAsync:async()=>style,teamLibrary:{getAvailableLibraryVariableCollectionsAsync:async()=>[]}});
  h.api.variables.getLocalVariablesAsync=async()=>[];
  h.child.setFillStyleIdAsync=async(id:string)=>{h.child.fillStyleId=id;};
  Object.assign(h.child,{topLeftRadius:10,topRightRadius:8,bottomLeftRadius:0,bottomRightRadius:16,setBoundVariable:()=>{}});
  await h.send({type:'ready'});await h.send({type:'scan',scope:'page'});await h.send({type:'auto-repair'});
  assert.equal(h.child.fillStyleId,'S:black');assert.equal(h.child.topLeftRadius,10);
  const done=h.messages.find(m=>m.type==='repair-complete');assert.equal(done.automatic,true);assert.equal(done.log.entries[0].status,'applied');
  const r=h.messages.filter(m=>m.type==='result').slice(-1)[0].result;assert.equal(r.issues.length,1);assert.equal(r.issues[0].category,'radius');
});
test('清理仅删除勾选项，预览后出现内容的空文字会跳过',async()=>{
  const h=harness();h.api.root={children:[h.page]};h.api.loadAllPagesAsync=async()=>{};h.page.flowStartingPoints=[];
  const add=(id:string):any=>{const n:any={...h.child,id,type:'TEXT',characters:'',fills:[],getStyledTextSegments:()=>[],parent:h.root};n.remove=()=>{n.removed=true;h.root.children=h.root.children.filter((c:any)=>c!==n);};h.nodes[id]=n;h.root.children.push(n);return n;};
  const a=add('empty-a'),b=add('empty-b');await h.send({type:'ready'});
  await h.send({type:'cleanup-preview',scope:'page'});let plan=h.messages.filter(m=>m.type==='cleanup-plan').slice(-1)[0].plan;
  await h.send({type:'cleanup-apply',planId:plan.id,nodeIds:[a.id]});assert.equal(a.removed,true);assert.equal(b.removed,false);
  await h.send({type:'cleanup-preview',scope:'page'});plan=h.messages.filter(m=>m.type==='cleanup-plan').slice(-1)[0].plan;b.characters='刚添加的内容';
  await h.send({type:'cleanup-apply',planId:plan.id,nodeIds:[b.id]});assert.equal(b.removed,false);assert.equal(h.messages.filter(m=>m.type==='cleanup-complete').slice(-1)[0].entries[0].status,'skipped');
});
