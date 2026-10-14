import { BASE_SIZES, BODY_SIZES, PRICE_SIZES, RADII, SEMANTICS, tokenName } from '../shared/spec';
import type { Issue, NodeSnapshot, RepairItem, RepairOption, Settings } from '../shared/types';
import { findCandidates, applyCandidate } from './candidates';
import { hex } from './rules';

export function repairTarget(issue:Issue) {
  const property=issue.category==='text' ? issue.rule==='missing-text-style'?'textStyle':issue.rule==='font-size-outside-spec'?'fontSize':'font' : issue.category==='radius'?issue.field:issue.field;
  return [issue.nodeId,property,issue.start??'',issue.end??'',issue.paintIndex??''].join(':');
}
export async function repairItem(issue:Issue, node:SceneNode, snapshot:NodeSnapshot, settings:Settings):Promise<RepairItem> {
  let options:RepairOption[]=[];
  let note='';
  const run=snapshot.runs?.find(r=>r.start<=issue.start!&&r.end>=issue.end!);
  const nearest=(values:number[],current:number) => Math.min(...values.map(v=>Math.abs(v-current)));
  if (issue.rule==='missing-text-style' || issue.rule==='missing-color-binding') {
    const candidates=await findCandidates(issue,node);
    options=candidates.map(c=>({ id:'candidate:'+c.id,label:c.name,detail:c.remote?'绑定已启用团队变量；应用时校验真实值':c.kind==='textStyle'?'应用同值文字样式':'建立同值颜色关联',action:{kind:'candidate',candidate:c},automatic:candidates.length===1 }));
    if (!options.length) note=issue.category==='text'?'本文件没有同值文字样式，请先添加或应用团队文字样式。':'未找到同值关联，可以选择规范颜色值；应用颜色值后仍需关联样式或变量。';
  }
  if (issue.category==='text'&&run) {
    if (issue.rule==='font-size-outside-spec') {
      const values=(/[\u3400-\u9fff]/.test(run.text)?BODY_SIZES:run.font.family==='Akrobat'?PRICE_SIZES:BASE_SIZES).map(v=>v*settings.scale);
      const distance=nearest(values,run.size);
      options=values.map(value=>({id:'size:'+value,label:String(value),detail:`规范字号 · 标尺 × ${settings.scale}`,action:{kind:'fontSize',value},recommended:Math.abs(value-run.size)===distance}));
      note='最接近字号仅供参考，请按文字层级选择。修改可能改变换行与布局；会解除该区间的字号变量关联。';
    } else if (issue.rule==='font-family-outside-spec'||issue.rule==='price-font-style') {
      const fonts=await figma.listAvailableFontsAsync();
      const targets=fonts.map(f=>f.fontName).filter(f=> issue.rule==='price-font-style' ? f.family==='Akrobat'&&/^extra\s*bold$/i.test(f.style) : /[\u3400-\u9fff]/.test(run.text) ? f.family==='PingFang SC' : f.family==='PingFang SC'||(f.family==='Akrobat'&&/^extra\s*bold$/i.test(f.style)));
      const unique=targets.filter((f,i)=>targets.findIndex(j=>j.family===f.family&&j.style===f.style)===i);
      options=unique.map(font=>({id:'font:'+font.family+':'+font.style,label:font.family+' '+font.style,detail:'仅修改当前文字区间的字体与字形',action:{kind:'font',font},recommended:font.style===run.font.style,automatic:issue.rule==='price-font-style'&&unique.length===1}));
      note=options.length?'会解除该区间的字体 / 字形变量关联。正文统一字重未定义，请自行选定。':'目标字体在当前环境不可用，请先安装字体再试。';
    }
  } else if (issue.category==='radius'&&['radius-outside-spec','radius-token-value-mismatch'].includes(issue.rule)) {
    const corner=snapshot.corners?.find(c=>c.field===issue.field);
    if (corner) {
      const values=[0,...RADII.map(v=>v*settings.scale)];
      const distance=nearest(values,corner.value);
      options=values.filter(v=>v!==corner.value).map(value=>({id:'radius:'+value,label:String(value),detail:'仅修改'+corner.label,action:{kind:'radius',value},recommended:Math.abs(value-corner.value)===distance}));
      note='选择符合组件用途的圆角；只修改对应角，会解除该角的变量关联。';
    }
  } else if (['fill','stroke'].includes(issue.category)) {
    const paint=(issue.start!==undefined?run?.fills:issue.field==='strokes'?snapshot.strokes:snapshot.fills)?.[issue.paintIndex!];
    const supported=['missing-color-binding','color-outside-spec','token-value-mismatch','prefer-semantic-color','semantic-color-context','unknown-color-token','unresolved-color-variable'];
    if (paint?.type==='SOLID' && supported.includes(issue.rule)) {
      const tokens=SEMANTICS.filter(t=>issue.start!==undefined?!/^(背景|边框|蒙层)\//.test(t.name):issue.category==='stroke'?!/^(文字|背景|蒙层)\//.test(t.name):true);
      const vars=await figma.variables.getLocalVariablesAsync('COLOR');
      const libraries=await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync().catch(()=>[]);
      const descriptors=(await Promise.all(libraries.filter(c=>/^ZHUAN\s*\/\s*Color$/i.test(c.name.trim())).map(c=>figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key).catch(()=>[])))).flat();
      for (const token of tokens) {
        const local:Variable[]=[];
        for(const v of vars.filter(v=>tokenName(v.name)===token.name)) {
          try {
            const collection=await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
            const value=v.resolveForConsumer(node).value;
            if(collection&&/^ZHUAN\s*\/\s*Color$/i.test(collection.name)&&typeof value==='object'&&'r' in value&&hex(value)===token.hex&&Math.abs(('a'in value?value.a:1)-token.alpha)<0.0001) local.push(v);
          }catch{ /* Inaccessible variables cannot be repair options. */ }
        }
        for(const v of local) options.push({id:'variable:'+v.id,label:`${token.name} · ${token.hex} / ${token.alpha*100}%`,detail:'绑定真实 ZHUAN 颜色变量',action:{kind:'candidate',candidate:{id:v.id,name:token.name,kind:'colorVariable'}},recommended:!!paint.color&&hex(paint.color)===token.hex});
        for(const v of descriptors.filter(v=>v.resolvedType==='COLOR'&&tokenName(v.name)===token.name&&!local.some(l=>l.key===v.key))) options.push({id:'variable:library:'+v.key,label:`${token.name} · ${token.hex} / ${token.alpha*100}%`,detail:'导入并绑定团队变量，应用前校验当前模式值',action:{kind:'candidate',candidate:{id:'library:'+v.key,name:token.name,kind:'colorVariable',key:v.key,remote:true}},recommended:!!paint.color&&hex(paint.color)===token.hex});
        if(!local.length&&!descriptors.some(v=>tokenName(v.name)===token.name&&v.resolvedType==='COLOR')) options.push({id:'color:'+token.name,label:`${token.name} · ${token.hex} / ${token.alpha*100}%`,detail:'应用规范数值；解除当前颜色样式 / 变量关联',action:{kind:'color',hex:token.hex,alpha:token.alpha,token:token.name},recommended:!!paint.color&&hex(paint.color)===token.hex});
      }
      note='请选择颜色用途。变量候选会建立真实关联；数值候选会解除当前关联。多层填充只替换对应颜色，保留其他层。';
    }
  }
  return {issue,options:options.filter((o,i)=>options.findIndex(v=>v.id===o.id)===i),note:note||'选择修复目标后预览并应用，可通过 Figma 撤销恢复。',target:repairTarget(issue)};
}

function currentPaints(issue:Issue,node:SceneNode):readonly Paint[] {
  const paints=issue.start!==undefined&&node.type==='TEXT'?node.getRangeFills(issue.start,issue.end!):issue.field==='strokes'&&'strokes'in node?node.strokes:'fills'in node?node.fills:[];
  if(typeof paints==='symbol')throw new Error('填充区间已变化，请重新预览');
  return paints;
}
function assignPaints(issue:Issue,node:SceneNode,paints:Paint[]) {
  if(issue.start!==undefined&&node.type==='TEXT')node.setRangeFills(issue.start,issue.end!,paints);
  else if(issue.field==='strokes'&&'strokes'in node)node.strokes=paints;
  else if('fills'in node)node.fills=paints;
  else throw new Error('图层不支持颜色修改');
}
/** Resolve/import/load everything before touching layer attributes. */
export async function prepareRepair(issue:Issue,node:SceneNode,option:RepairOption):Promise<()=>Promise<void>> {
  const action=option.action;
  if(action.kind==='candidate') {
    const c=action.candidate;
    if(c.kind!=='colorVariable') {
      const fresh=await findCandidates(issue,node);
      if(!fresh.some(v=>v.id===c.id))throw new Error('同值样式已变化，请重新预览');
      if(c.kind==='textStyle'&&node.type==='TEXT') {
        const font=node.getRangeFontName(issue.start!,issue.end!);
        if(typeof font==='symbol')throw new Error('字体区间已变化');
        await figma.loadFontAsync(font);
        const style=await figma.getStyleByIdAsync(c.id);
        if(!style||style.type!=='TEXT')throw new Error('文字样式已不存在');
        await figma.loadFontAsync(style.fontName);
      }
      return ()=>applyCandidate(issue,node,c);
    }
    const variable=c.remote&&c.key?await figma.variables.importVariableByKeyAsync(c.key):await figma.variables.getVariableByIdAsync(c.id);
    if(!variable)throw new Error('变量已不存在');
    const value=variable.resolveForConsumer(node).value;
    const token=SEMANTICS.find(t=>t.name===tokenName(variable.name));
    if(variable.resolvedType!=='COLOR'||typeof value!=='object'||!('r'in value))throw new Error('无法读取颜色变量');
    // Missing-binding same-value candidates may belong to another enabled library.
    const paint=currentPaints(issue,node)[issue.paintIndex!];
    if(!paint||paint.type!=='SOLID')throw new Error('目标颜色不再存在');
    if(option.id.startsWith('candidate:')) {
      if(hex(value)!==hex(paint.color)||Math.abs(('a'in value?value.a:1)-(paint.opacity??1))>0.0001)throw new Error('同值候选当前值已变化，请重新预览');
    } else if(!token||hex(value)!==token.hex||Math.abs(('a'in value?value.a:1)-token.alpha)>0.0001)throw new Error('团队变量当前模式值与规范快照不同，已跳过修改');
    return async()=>{
      const paints=[...currentPaints(issue,node)];
      const p=paints[issue.paintIndex!];
      if(p.type!=='SOLID')throw new Error('颜色已变化');
      const updated=figma.variables.setBoundVariableForPaint(p,'color',variable);
      paints[issue.paintIndex!]={...updated,color:{r:value.r,g:value.g,b:value.b},opacity:'a'in value?value.a:1};
      await clearPaintStyle(issue,node);
      assignPaints(issue,node,paints);
    };
  }
  if(action.kind==='color') {
    const token=SEMANTICS.find(t=>t.name===action.token&&t.hex===action.hex&&t.alpha===action.alpha);
    if(!token)throw new Error('不支持的规范颜色');
    return async()=>{
      const paints=[...currentPaints(issue,node)];const p=paints[issue.paintIndex!];if(p.type!=='SOLID')throw new Error('目标填充不是纯色');
      const unbound=figma.variables.setBoundVariableForPaint(p,'color',null);
      paints[issue.paintIndex!]={...unbound,color:{r:parseInt(action.hex.slice(1,3),16)/255,g:parseInt(action.hex.slice(3,5),16)/255,b:parseInt(action.hex.slice(5,7),16)/255},opacity:action.alpha};
      await clearPaintStyle(issue,node);assignPaints(issue,node,paints);
    };
  }
  if(action.kind==='radius') {
    if(!['topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius'].includes(issue.field)||!('topLeftRadius'in node))throw new Error('图层不支持独立圆角');
    return async()=>{node.setBoundVariable(issue.field as VariableBindableNodeField,null);node[issue.field as 'topLeftRadius']=action.value;};
  }
  if(node.type!=='TEXT')throw new Error('目标图层不是文字');
  const start=issue.start!,end=issue.end!;
  const fonts=node.getStyledTextSegments(['fontName'],start,end).map(r=>r.fontName);
  await Promise.all(fonts.map(font=>figma.loadFontAsync(font)));
  if(action.kind==='font') {
    await figma.loadFontAsync(action.font);
    return async()=>{node.setRangeBoundVariable(start,end,'fontFamily',null);node.setRangeBoundVariable(start,end,'fontStyle',null);node.setRangeFontName(start,end,action.font);};
  }
  return async()=>{node.setRangeBoundVariable(start,end,'fontSize',null);node.setRangeFontSize(start,end,action.value);};
}
async function clearPaintStyle(issue:Issue,node:SceneNode) {
  if(issue.start!==undefined&&node.type==='TEXT')await node.setRangeFillStyleIdAsync(issue.start,issue.end!,'');
  else if(issue.field==='strokes'&&'setStrokeStyleIdAsync'in node)await node.setStrokeStyleIdAsync('');
  else if('setFillStyleIdAsync'in node)await node.setFillStyleIdAsync('');
}
export async function repairGuard(node:SceneNode) {
  const snapshot=await (await import('./snapshot')).createSnapshotReader()(node);
  const ancestors=[];
  for(let p:BaseNode|null=node;p&&p.type!=='DOCUMENT';p=p.parent)ancestors.push([p.id,'visible'in p?p.visible:undefined,'locked'in p?p.locked:undefined]);
  return JSON.stringify({snapshot,ancestors,x:node.x,y:node.y,width:node.width,height:node.height,
    layout:'layoutMode'in node?[node.layoutMode,node.itemSpacing,node.paddingTop,node.paddingRight,node.paddingBottom,node.paddingLeft]:undefined,boundVariables:node.boundVariables,
    fills:'fills'in node?node.fills:undefined,strokes:'strokes'in node?node.strokes:undefined,
    text:node.type==='TEXT'?node.characters:undefined,
    textAttributes:node.type==='TEXT'?node.getStyledTextSegments(['fontName','fontSize','textStyleId','fills','fillStyleId','lineHeight','letterSpacing','boundVariables']):undefined});
}
export async function captureRepairState(issue:Issue,node:SceneNode,option:RepairOption):Promise<()=>Promise<void>> {
  const action=option.action;
  if(issue.category==='fill'||issue.category==='stroke') {
    const original=JSON.parse(JSON.stringify(currentPaints(issue,node))) as Paint[];
    const style=issue.start!==undefined&&node.type==='TEXT'?node.getRangeFillStyleId(issue.start,issue.end!):issue.field==='strokes'&&'strokeStyleId'in node?node.strokeStyleId:'fillStyleId'in node?node.fillStyleId:'';
    return async()=>{
      assignPaints(issue,node,original);
      if(typeof style==='string'&&style) {
        if(issue.start!==undefined&&node.type==='TEXT')await node.setRangeFillStyleIdAsync(issue.start,issue.end!,style);
        else if(issue.field==='strokes'&&'setStrokeStyleIdAsync'in node)await node.setStrokeStyleIdAsync(style);
        else if('setFillStyleIdAsync'in node)await node.setFillStyleIdAsync(style);
      }
    };
  }
  if(action.kind==='radius'&&'topLeftRadius'in node) {
    const value=node[issue.field as 'topLeftRadius'];
    const alias=node.boundVariables?.[issue.field as 'topLeftRadius'];
    const variable=alias?await figma.variables.getVariableByIdAsync(alias.id):null;
    if(alias&&!variable)throw new Error('原圆角变量无法读取，跳过修复');
    return async()=>{node.setBoundVariable(issue.field as VariableBindableNodeField,null);node[issue.field as 'topLeftRadius']=value;if(variable)node.setBoundVariable(issue.field as VariableBindableNodeField,variable);};
  }
  if(node.type!=='TEXT')return async()=>{};
  const segments=node.getStyledTextSegments(['fontName','fontSize','textStyleId','boundVariables','lineHeight','letterSpacing','textCase','textDecoration','paragraphIndent','paragraphSpacing'],issue.start!,issue.end!);
  const aliases=new Map<string,Variable>();
  for(const segment of segments)for(const alias of Object.values(segment.boundVariables??{}))if(alias){const variable=await figma.variables.getVariableByIdAsync(alias.id);if(!variable)throw new Error('原文字变量无法读取，跳过修复');aliases.set(alias.id,variable);}
  return async()=>{
    for(const s of segments) {
      await figma.loadFontAsync(s.fontName);
      if(action.kind==='candidate')await node.setRangeTextStyleIdAsync(s.start,s.end,s.textStyleId);
      node.setRangeFontName(s.start,s.end,s.fontName);node.setRangeFontSize(s.start,s.end,s.fontSize);
      if(action.kind==='candidate') {
        node.setRangeLineHeight(s.start,s.end,s.lineHeight);node.setRangeLetterSpacing(s.start,s.end,s.letterSpacing);
        node.setRangeTextCase(s.start,s.end,s.textCase);node.setRangeTextDecoration(s.start,s.end,s.textDecoration);
      }
      for(const field of ['fontFamily','fontStyle','fontSize'] as const)node.setRangeBoundVariable(s.start,s.end,field,s.boundVariables?.[field]?aliases.get(s.boundVariables[field]!.id)!:null);
    }
  };
}
