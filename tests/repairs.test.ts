import test from 'node:test';
import assert from 'node:assert/strict';
import { repairItem, prepareRepair, captureRepairState, repairGuard } from '../src/plugin/repairs';
import { lintNode } from '../src/plugin/rules';
import { DEFAULT_SETTINGS, type RepairOption, type Issue, type NodeSnapshot } from '../src/shared/types';
const black={type:'SOLID',color:{r:17/255,g:17/255,b:17/255},opacity:1} as SolidPaint;
const api=()=>({variables:{getLocalVariablesAsync:async()=>[],getVariableByIdAsync:async()=>null,setBoundVariableForPaint:(p:SolidPaint,_f:string,v:any)=>({...p,boundVariables:v?{color:{type:'VARIABLE_ALIAS',id:v.id}}:{}})},teamLibrary:{getAvailableLibraryVariableCollectionsAsync:async()=>[]},getLocalPaintStylesAsync:async()=>[],loadFontAsync:async()=>{},listAvailableFontsAsync:async()=>[{fontName:{family:'Akrobat',style:'ExtraBold'}},{fontName:{family:'PingFang SC',style:'Regular'}},{fontName:{family:'PingFang SC',style:'Medium'}}]});
const snap=(data:Partial<NodeSnapshot>={}):NodeSnapshot=>({id:'1:1',name:'图层',type:'RECTANGLE',path:'Page / 图层',...data});
function setup() {const mock=api();(globalThis as any).figma=mock;return mock;}
function textNode(size=25,family='PingFang SC',style='Medium') {
  const segment:any={start:0,end:2,characters:'中文',fontName:{family,style},fontSize:size,textStyleId:'S:1',fills:[],fillStyleId:'',lineHeight:{unit:'AUTO'},letterSpacing:{unit:'PIXELS',value:0},boundVariables:{},textCase:'ORIGINAL',textDecoration:'NONE',paragraphIndent:0,paragraphSpacing:0};
  return {id:'1:1',name:'文字',type:'TEXT',parent:{type:'PAGE',name:'Page',parent:null},characters:'中文',strokes:[],strokeStyleId:'',boundVariables:{},getStyledTextSegments:()=>[{...segment}],getRangeFontName:()=>segment.fontName,setRangeFontSize:(s:number,e:number,v:number)=>{assert.equal(s,0);assert.equal(e,2);segment.fontSize=v;},setRangeFontName:(_s:number,_e:number,v:FontName)=>{segment.fontName=v;},setRangeBoundVariable:(_s:number,_e:number,field:string,v:any)=>{segment.boundVariables[field]=v?{id:v.id,type:'VARIABLE_ALIAS'}:undefined;},segment} as any;
}
test('字号修复只给参考值，不自动猜测文字层级，应用后符合规范',async()=>{
  setup();const node=textNode();
  const snapshot=snap({type:'TEXT',runs:[{start:0,end:2,text:'中文',styleId:'S:1',font:{family:'PingFang SC',style:'Medium'},size:25,fills:[],fillStyleId:''}]});
  const issue=lintNode(snapshot,DEFAULT_SETTINGS)[0];
  const item=await repairItem(issue,node,snapshot,DEFAULT_SETTINGS);
  assert.ok(!item.options.some(o=>o.automatic));assert.deepEqual(item.options.filter(o=>o.recommended).map(o=>o.label),['24','26']);
  const execute=await prepareRepair(issue,node,item.options.find(o=>o.id==='size:24')!);await execute();
  assert.equal(node.segment.fontSize,24);assert.equal(node.segment.fontName.style,'Medium');
  snapshot.runs![0].size=24;assert.equal(lintNode(snapshot,DEFAULT_SETTINGS).length,0);
});
test('字体不可用时准备阶段失败，不修改属性',async()=>{
  const mock=setup();mock.loadFontAsync=async()=>{throw new Error('missing font');};
  const node=textNode(24,'Inter');const before=node.segment.fontName;
  const issue={...lintNode(snap({type:'TEXT',runs:[{start:0,end:2,text:'中文',styleId:'S:1',font:{family:'Inter',style:'Regular'},size:24,fills:[],fillStyleId:''}]}),DEFAULT_SETTINGS)[0]};
  const option:RepairOption={id:'font',label:'PingFang SC Regular',detail:'',action:{kind:'font',font:{family:'PingFang SC',style:'Regular'}}};
  await assert.rejects(()=>prepareRepair(issue,node,option),/missing font/);assert.equal(node.segment.fontName,before);
});
test('圆角修复只修改问题角，保留其他角，支持恢复',async()=>{
  setup();const node:any={type:'RECTANGLE',topLeftRadius:10,topRightRadius:8,bottomLeftRadius:0,bottomRightRadius:16,boundVariables:{},setBoundVariable:()=>{}};
  const snapshot=snap({corners:[{field:'topLeftRadius',label:'左上圆角',value:10}]});const issue=lintNode(snapshot,DEFAULT_SETTINGS)[0];
  const item=await repairItem(issue,node,snapshot,DEFAULT_SETTINGS);const option=item.options.find(o=>o.id==='radius:12')!;
  const restore=await captureRepairState(issue,node,option);await (await prepareRepair(issue,node,option))();
  assert.equal(node.topLeftRadius,12);assert.equal(node.topRightRadius,8);assert.equal(node.bottomLeftRadius,0);await restore();assert.equal(node.topLeftRadius,10);
});
test('颜色修复解除当前关联，只替换对应填充并保留图片层、混合模式',async()=>{
  setup();const image={type:'IMAGE',imageHash:'unchanged'};const node:any={type:'RECTANGLE',fills:[{...black,blendMode:'MULTIPLY',boundVariables:{color:{id:'old'}}},image],fillStyleId:'S:old',setFillStyleIdAsync:async(id:string)=>{node.fillStyleId=id;}};
  const snapshot=snap({fills:[{...black,color:{r:0.9,g:0,b:0}}, {type:'IMAGE'}],fillStyleId:'S:old'});const issue=lintNode(snapshot,DEFAULT_SETTINGS)[0];
  const option:RepairOption={id:'red',label:'品牌/主色',detail:'',action:{kind:'color',hex:'#FF0F27',alpha:1,token:'品牌/主色'}};
  const restore=await captureRepairState(issue,node,option);await (await prepareRepair(issue,node,option))();
  assert.equal(node.fills[0].color.r,1);assert.equal(node.fills[0].color.g,15/255);assert.equal(node.fills[0].blendMode,'MULTIPLY');assert.equal(node.fills[1],image);assert.equal(node.fillStyleId,'');
  await restore();assert.equal(node.fillStyleId,'S:old');assert.equal(node.fills[0].boundVariables.color.id,'old');
});
test('颜色变量规范修复可以改色且建立真实关联，模式不一致则不改',async()=>{
  const mock=setup();let value:any={r:1,g:15/255,b:39/255,a:1};const variable:any={id:'v1',name:'品牌/主色',resolvedType:'COLOR',resolveForConsumer:()=>({value})};
  mock.variables.getVariableByIdAsync=async()=>variable;
  const node:any={type:'RECTANGLE',fills:[black],setFillStyleIdAsync:async()=>{}};
  const issue=lintNode(snap({fills:[black]}),DEFAULT_SETTINGS)[0];
  const option:RepairOption={id:'variable:v1',label:'品牌/主色',detail:'',action:{kind:'candidate',candidate:{id:'v1',name:'品牌/主色',kind:'colorVariable'}}};
  await (await prepareRepair(issue,node,option))();assert.equal(node.fills[0].color.r,1);assert.equal(node.fills[0].boundVariables.color.id,'v1');
  const before=node.fills;value={r:0,g:0,b:0,a:1};await assert.rejects(()=>prepareRepair(issue,node,option),/模式值/);assert.equal(node.fills,before);
});
test('规范颜色与同值候选并列；字体字重不被自动选中',async()=>{
  setup();const node:any={type:'TEXT'};const snapshot=snap({type:'TEXT',runs:[{start:0,end:2,text:'中文',styleId:'S:1',font:{family:'Inter',style:'Regular'},size:24,fills:[],fillStyleId:''}]});const issue=lintNode(snapshot,DEFAULT_SETTINGS)[0];
  const item=await repairItem(issue,node,snapshot,DEFAULT_SETTINGS);assert.equal(item.options.length,2);assert.ok(item.options.every(o=>!o.automatic));
});
test('守卫发现区间文本或字体变化，不只比较检查实际值',async()=>{
  setup();const node=textNode();const before=await repairGuard(node);node.characters='变了';assert.notEqual(before,await repairGuard(node));
});
