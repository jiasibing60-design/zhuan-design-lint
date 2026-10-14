import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCleanupPlan, prototypeReferences, validateCleanup, cleanupStillEligible } from '../src/plugin/cleanup';
import { automaticChoices } from '../src/plugin/automatic';
import type { RepairItem, RepairOption } from '../src/shared/types';
function tree() {
  (globalThis as any).figma={variables:{getVariableByIdAsync:async()=>null}};
  let sequence=0;
  const page:any={id:'page',name:'Page',type:'PAGE',parent:{type:'DOCUMENT'},children:[],flowStartingPoints:[]};
  const make=(type:string,props:any={},parent=page):any=>{
    const n:any={id:'n'+(++sequence),type,name:type,parent,visible:true,locked:false,removed:false,boundVariables:{},fills:[],strokes:[],reactions:[],effects:[],...props};
    if(['FRAME','GROUP','COMPONENT','COMPONENT_SET','INSTANCE'].includes(type))n.children=[];
    if(type==='TEXT'){n.characters=props.characters??'';n.getStyledTextSegments=()=>[];}
    parent.children.push(n);return n;
  };
  return {page,make};
}
test('清理空文字、空分组、隐藏子树；保留空画板和空格文字，重叠选择不重复',async()=>{
  const {page,make}=tree();const empty=make('TEXT'),group=make('GROUP');make('TEXT',{characters:' '});make('FRAME');
  const hidden=make('FRAME',{visible:false});const child=make('TEXT',{characters:'隐藏文字'},hidden);
  const {plan}=await buildCleanupPlan(page,[child,hidden,empty,group],new Set(),'p');
  assert.equal(plan.items.length,3);assert.deepEqual(plan.items.map(i=>i.reason).sort(),['空分组','空文字','隐藏图层']);assert.equal(plan.items.find(i=>i.id===hidden.id)!.descendants,1);
});
test('锁定祖先、组件内部、隐藏父层含组件或锁定后代均保留',async()=>{
  const {page,make}=tree();const locked=make('FRAME',{locked:true});make('TEXT',{},locked);
  const comp=make('COMPONENT',{visible:false});make('TEXT',{},comp);
  const hidden=make('GROUP',{visible:false});make('INSTANCE',{},hidden);
  const hidden2=make('FRAME',{visible:false});make('RECTANGLE',{locked:true},hidden2);
  const {plan}=await buildCleanupPlan(page,page.children,new Set(),'p');assert.equal(plan.items.length,0);assert.ok(plan.protected>=4);
});
test('保留可见性变量、原型动作、原型目标、带效果空分组',async()=>{
  const {page,make}=tree();const target=make('FRAME',{visible:false});page.flowStartingPoints=[{nodeId:target.id,name:'flow'}];
  const target2=make('FRAME',{visible:false});make('RECTANGLE',{reactions:[{actions:[{type:'CONDITIONAL',conditionalBlocks:[{actions:[{type:'NODE',destinationId:target2.id}]}]}]}]});
  make('RECTANGLE',{visible:false,boundVariables:{visible:{id:'v'}}});make('GROUP',{effects:[{type:'DROP_SHADOW'}]});
  const refs=prototypeReferences([page]);assert.ok(refs.has(target.id));assert.ok(refs.has(target2.id));
  const {plan}=await buildCleanupPlan(page,page.children,refs,'p');assert.equal(plan.items.length,0);
});
test('跨页原型引用也阻止清理',async()=>{
  const {page,make}=tree();const node=make('FRAME',{visible:false});const other:any={...page,id:'other',children:[{...node,id:'source',visible:true,reactions:[{action:{type:'NODE',destinationId:node.id}}]}]};
  const {plan}=await buildCleanupPlan(page,page.children,prototypeReferences([page,other]),'p');assert.equal(plan.items.length,0);
});
test('预览后文本、隐藏状态、锁定后代或引用改变不能删除',async()=>{
  const {page,make}=tree();const node=make('FRAME',{visible:false}),text=make('TEXT',{},node);
  const stored=await buildCleanupPlan(page,page.children,new Set(),'p');const item=stored.plan.items[0],guard=stored.guards.get(node.id)!;
  assert.equal(await validateCleanup(item,node,page.id,new Set(),guard),true);
  text.characters='新增内容';assert.equal(await validateCleanup(item,node,page.id,new Set(),guard),false);text.characters='';
  node.visible=true;assert.equal(await validateCleanup(item,node,page.id,new Set(),guard),false);node.visible=false;
  text.locked=true;assert.equal(await validateCleanup(item,node,page.id,new Set(),guard),false);text.locked=false;
  assert.equal(cleanupStillEligible(item,node,page.id,new Set([text.id])),false);
});
function item(id:string,target:string,options:RepairOption[],overrides:any={}):RepairItem {
  return {issue:{id,nodeId:'node',category:'text',start:0,end:3,...overrides} as any,target,options,note:''};
}
const font:RepairOption={id:'font',label:'font',detail:'',automatic:true,action:{kind:'font',font:{family:'Akrobat',style:'ExtraBold'}}};
test('一键修复仅选择唯一自动目标，避开重复属性与文字样式覆盖冲突',()=>{
  const style:RepairOption={...font,id:'style',action:{kind:'candidate',candidate:{id:'s',name:'style',kind:'textStyle'}}};
  const items=[item('a','style',[style]),item('b','font',[font]),item('c','ambiguous',[font,{...font,id:'other'}]),item('d','size',[{...font,automatic:false}]),item('e','later',[font],{start:4,end:6}),item('f','later',[font],{start:4,end:6})];
  assert.deepEqual(automaticChoices(items),[{issueId:'a',optionId:'style'},{issueId:'e',optionId:'font'}]);
});
