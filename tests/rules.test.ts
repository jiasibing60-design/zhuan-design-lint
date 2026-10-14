import test from 'node:test';
import assert from 'node:assert/strict';
import { lintNode } from '../src/plugin/rules';
import { DEFAULT_SETTINGS, type NodeSnapshot, type PaintSnapshot, type ResolvedBinding } from '../src/shared/types';
import { makeCSV } from '../src/app/report';
const paint = (hex:string,alpha=1,binding?:ResolvedBinding):PaintSnapshot => ({ type:'SOLID',opacity:alpha,color:{ r:parseInt(hex.slice(1,3),16)/255,g:parseInt(hex.slice(3,5),16)/255,b:parseInt(hex.slice(5,7),16)/255 },binding });
const node = (data:Partial<NodeSnapshot>={}):NodeSnapshot => ({ id:'1:2',name:'测试',type:'RECTANGLE',path:'页面 / 测试',...data });
const binding = (name='品牌/主色',collection='ZHUAN / Color'):ResolvedBinding => ({ id:'v1',name,collection,verifiedCollection:true });
test('每层填充独立检查，部分绑定不能掩盖未绑定颜色',()=>{
  const issues=lintNode(node({ fills:[paint('#FF0F27',1,binding()),paint('#111111')] }),DEFAULT_SETTINGS);
  assert.equal(issues.length,1);assert.equal(issues[0].paintIndex,1);assert.equal(issues[0].rule,'missing-color-binding');
});
test('已应用样式或逐层变量的色板值通过',()=>{
  assert.equal(lintNode(node({ fills:[paint('#FFFFFF')],fillStyleId:'S:1' }),DEFAULT_SETTINGS).length,0);
  assert.equal(lintNode(node({ fills:[paint('#FF0F27',1,binding())] }),DEFAULT_SETTINGS).length,0);
});
test('图片、视频、不可见填充、透明填充不报缺颜色样式',()=>{
  assert.equal(lintNode(node({ fills:[{type:'IMAGE'},{type:'VIDEO'},{...paint('#111111'),visible:false},paint('#111111',0)] }),DEFAULT_SETTINGS).length,0);
});
test('未关联的渐变需要颜色样式',()=>{
  assert.equal(lintNode(node({ fills:[{type:'GRADIENT_LINEAR'}] }),DEFAULT_SETTINGS)[0].rule,'missing-color-binding');
});
test('混合文字逐区间检查，已应用样式区间不误报',()=>{
  const issues=lintNode(node({ type:'TEXT',runs:[
    { start:0,end:2,text:'标题',styleId:'S:1',font:{family:'PingFang SC',style:'Medium'},size:32,fills:[paint('#111111')],fillStyleId:'S:color' },
    { start:2,end:4,text:'正文',styleId:'',font:{family:'PingFang SC',style:'Light'},size:24,fills:[paint('#111111')],fillStyleId:'S:color' }
  ] }),DEFAULT_SETTINGS);
  assert.equal(issues.length,1);assert.equal(issues[0].rule,'missing-text-style');assert.equal(issues[0].start,2);
});
test('正文不推断统一 Regular，价格要求 ExtraBold',()=>{
  const issues=lintNode(node({ type:'TEXT',runs:[{start:0,end:3,text:'100',styleId:'S:1',font:{family:'Akrobat',style:'Bold'},size:44,fills:[],fillStyleId:''}] }),DEFAULT_SETTINGS);
  assert.equal(issues.length,1);assert.equal(issues[0].rule,'price-font-style');
});
test('半值标尺仅由用户显式设置决定',()=>{
  const n=node({type:'TEXT',runs:[{start:0,end:2,text:'中文',styleId:'S:1',font:{family:'PingFang SC',style:'Regular'},size:14,fills:[],fillStyleId:''}]});
  assert.equal(lintNode(n,DEFAULT_SETTINGS)[0].rule,'font-size-outside-spec');
  assert.equal(lintNode(n,{...DEFAULT_SETTINGS,scale:0.5}).length,0);
});
test('四个角分别检查，一个角绑定变量不能跳过其他角',()=>{
  const issues=lintNode(node({ corners:[{field:'topLeftRadius',label:'左上圆角',value:8,binding:binding('radius/xs','ZHUAN / Dimension')},{field:'topRightRadius',label:'右上圆角',value:10},{field:'bottomLeftRadius',label:'左下圆角',value:0},{field:'bottomRightRadius',label:'右下圆角',value:999}] }),DEFAULT_SETTINGS);
  assert.equal(issues.length,1);assert.equal(issues[0].field,'topRightRadius');assert.equal(issues[0].actual,'10');
});
test('圆角绑定了已知变量但值与该 Token 不同，仍列为待核对',()=>{
  const issues=lintNode(node({corners:[{field:'topLeftRadius',label:'左上圆角',value:16,binding:binding('radius/xs','ZHUAN / Dimension')}]}),DEFAULT_SETTINGS);
  assert.equal(issues[0].rule,'radius-token-value-mismatch');
});
test('同 HEX 的蒙层必须保留 70% 不透明度',()=>{
  const issues=lintNode(node({fills:[paint('#111111',1,binding('蒙层/遮罩'))]}),DEFAULT_SETTINGS);
  assert.ok(issues.some(i=>i.rule==='token-value-mismatch'));
  assert.equal(lintNode(node({fills:[paint('#111111',0.7,binding('蒙层/遮罩'))]}),DEFAULT_SETTINGS).length,0);
});
test('语义建议需要已知集合证据，不将其他库同名变量当成 ZHUAN',()=>{
  const n=node({type:'TEXT',runs:[{start:0,end:2,text:'文字',styleId:'S:1',font:{family:'PingFang SC',style:'Regular'},size:24,fills:[paint('#FFFFFF',1,binding('背景/白色'))],fillStyleId:''}]});
  assert.equal(lintNode(n,DEFAULT_SETTINGS)[0].rule,'semantic-color-context');
  n.runs![0].fills[0].binding!.verifiedCollection=false;
  assert.equal(lintNode(n,DEFAULT_SETTINGS).length,0);
});
test('忽略指纹包含实际值，修改属性后问题会重新出现',()=>{
  const one=lintNode(node({fills:[paint('#111111')]}),DEFAULT_SETTINGS)[0];
  const two=lintNode(node({fills:[paint('#666666')]}),DEFAULT_SETTINGS)[0];
  assert.equal(one.id,two.id);assert.notEqual(one.fingerprint,two.fingerprint);
});
test('无法读取的绑定是待核对问题',()=>{
  const issues=lintNode(node({fills:[paint('#FF0F27',1,{...binding(),unavailable:true})]}),DEFAULT_SETTINGS);
  assert.equal(issues[0].rule,'unresolved-color-variable');assert.equal(issues[0].severity,'warning');
});
test('CSV 防止图层名触发电子表格公式，保留 BOM 和元数据',()=>{
  const issues=lintNode(node({name:'=HYPERLINK("bad")',fills:[paint('#111111')]}),DEFAULT_SETTINGS);
  const csv=makeCSV({issues,ignored:[],scanned:1,skipped:0,unreadable:0,complete:true,scope:'page',scopeNames:['Page'],pageName:'Page',pageId:'0:1',at:'2026-10-13',duration:100,settings:DEFAULT_SETTINGS,notices:[]});
  assert.ok(csv.startsWith('\ufeff'));assert.ok(csv.includes("'=HYPERLINK"));assert.ok(csv.includes('检查元数据'));
});
