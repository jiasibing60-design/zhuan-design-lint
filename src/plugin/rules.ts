import { BODY_SIZES, PRICE_SIZES, BASE_SIZES, RADII, RADIUS_NAMES, PRIMITIVES, SEMANTICS, tokenName } from '../shared/spec';
import type { Issue, NodeSnapshot, PaintSnapshot, Settings, ColorToken } from '../shared/types';

export function hex(color: { r: number; g: number; b: number }) {
  return '#' + [color.r,color.g,color.b].map(c => Math.round(c*255).toString(16).padStart(2,'0')).join('').toUpperCase();
}
export function matchesColor(paint: PaintSnapshot, token: ColorToken) {
  return !!paint.color && hex(paint.color) === token.hex && Math.abs((paint.opacity ?? 1) - token.alpha) < 0.005;
}
export function lintNode(node: NodeSnapshot, settings: Settings): Issue[] {
  const issues: Issue[] = [];
  const add = (data: Omit<Issue,'id'|'fingerprint'|'nodeId'|'nodeName'|'nodeType'|'path'>) => {
    const id = [node.id,data.rule,data.field,data.start ?? '',data.end ?? '',data.paintIndex ?? ''].join(':');
    const fingerprint = JSON.stringify([id,data.actual,data.expected]);
    issues.push({ ...data,id,fingerprint,nodeId:node.id,nodeName:node.name,nodeType:node.type,path:node.path });
  };
  const paints = (items: PaintSnapshot[] | undefined, styleId: string | undefined, field: string, start?: number, end?: number) => {
    const category = field === 'strokes' ? 'stroke' : 'fill';
    if (!settings[category]) return;
    (items ?? []).forEach((p,index) => {
      if (p.visible === false || p.opacity === 0 || p.type === 'IMAGE' || p.type === 'VIDEO') return;
      const actual = p.type === 'SOLID' && p.color ? `${hex(p.color)} · ${Math.round((p.opacity ?? 1)*100)}%` : '渐变填充';
      const common = { category,field,paintIndex:index,start,end,actual,swatch:p.color ? hex(p.color) : undefined } as const;
      let suggestions = SEMANTICS.filter(t => matchesColor(p,t));
      if (start !== undefined) suggestions = suggestions.filter(t => !/^(背景|边框|蒙层)\//.test(t.name));
      else if (category === 'stroke') suggestions = suggestions.filter(t => !/^(文字|背景|蒙层)\//.test(t.name));
      const tips = suggestions.map(t => `${t.name} · ${t.hex}${t.alpha < 1 ? ` / ${t.alpha*100}%` : ''}`);
      if (!styleId && !p.binding) add({ ...common,rule:'missing-color-binding',severity:'error',title:category === 'fill' ? '填充未关联颜色样式或变量' : '描边未关联颜色样式或变量',expected:'关联颜色样式，或为每个颜色绑定变量',suggestions:tips });
      if (p.binding?.unavailable) add({ ...common,rule:'unresolved-color-variable',severity:'warning',title:'颜色变量无法读取',expected:'检查变量是否存在，以及团队库权限',suggestions:[] });
      if (!settings.checkSpec || p.type !== 'SOLID') return;
      if (!PRIMITIVES.some(t => matchesColor(p,t))) add({ ...common,rule:'color-outside-spec',severity:'warning',title:'颜色或不透明度不在规范色板中',expected:'核对 ZHUAN Color 色板；特殊业务色可注明原因',suggestions:tips });
      const b = p.binding;
      if (!b || b.unavailable) return;
      const name = tokenName(b.name);
      const known = /Color Primitives$/i.test(b.collection) ? PRIMITIVES.find(t => t.name === name) : SEMANTICS.find(t => t.name === name);
      if (b.verifiedCollection && /Color(?: Primitives)?$/i.test(b.collection) && !known) add({ ...common,rule:'unknown-color-token',severity:'warning',title:'变量不在当前规范快照中',actual:`${b.collection} / ${b.name}`,expected:'核对规范是否更新，或是否引用了其他业务变量',suggestions:[] });
      if (known && b.verifiedCollection && !matchesColor(p,known)) add({ ...common,rule:'token-value-mismatch',severity:'warning',title:'变量颜色与规范快照不一致',expected:`${known.name} · ${known.hex} / ${known.alpha*100}%`,suggestions:[] });
      if (!settings.semanticHints || !b.verifiedCollection) return;
      if (/Color Primitives$/i.test(b.collection)) add({ ...common,rule:'prefer-semantic-color',severity:'warning',title:'建议使用按用途命名的语义颜色',actual:`${b.collection} / ${b.name}`,expected:'优先绑定 ZHUAN / Color 语义变量',suggestions:tips });
      else if (/Color$/i.test(b.collection) && ((start !== undefined && /^(背景|边框|蒙层)\//.test(name)) || (category === 'stroke' && /^(文字|背景|蒙层)\//.test(name)))) add({ ...common,rule:'semantic-color-context',severity:'warning',title:'颜色语义用途需要核对',actual:`${b.name} · ${actual}`,expected:start !== undefined ? '文字通常使用文字、品牌、反馈或链接语义色' : '描边通常使用边框语义色',suggestions:tips });
    });
  };
  if (node.runs) {
    for (const run of node.runs) {
      if (settings.text) {
        const common = { category:'text',field:'text',start:run.start,end:run.end } as const;
        const actual = `${run.font.family} ${run.font.style} · ${run.size}`;
        if (!run.styleId) add({ ...common,actual,rule:'missing-text-style',severity:'error',title:'文字未套用文字样式',expected:'为该文字区间应用文字样式',suggestions:[] });
        if (settings.checkSpec) {
          const chinese = /[\u3400-\u9fff]/.test(run.text);
          const price = run.font.family === 'Akrobat';
          const sizes = (chinese ? BODY_SIZES : price ? PRICE_SIZES : BASE_SIZES).map(n => n*settings.scale);
          if (!sizes.includes(run.size)) add({ ...common,actual:String(run.size),rule:'font-size-outside-spec',severity:'warning',title:'字号不在规范范围中',expected:`${chinese ? '中文' : price ? '价格' : '基础'}字号：${sizes.join('、')}`,suggestions:[] });
          if ((chinese && run.font.family !== 'PingFang SC') || (!chinese && !['PingFang SC','Akrobat'].includes(run.font.family))) add({ ...common,actual:run.font.family,rule:'font-family-outside-spec',severity:'warning',title:'字体家族需要核对',expected:chinese ? '中文正文：PingFang SC；特殊字体请注明用途' : '正文 PingFang SC；价格 Akrobat',suggestions:[] });
          if (price && !/^extra\s*bold$/i.test(run.font.style)) add({ ...common,actual:run.font.style,rule:'price-font-style',severity:'warning',title:'价格字形与规范不同',expected:'Akrobat ExtraBold',suggestions:[] });
        }
      }
      paints(run.fills,run.fillStyleId,'fills',run.start,run.end);
    }
  } else paints(node.fills,node.fillStyleId,'fills');
  paints(node.strokes,node.strokeStyleId,'strokes');
  if (settings.radius && settings.checkSpec) {
    for (const corner of node.corners ?? []) {
      const allowed = RADII.map(v => v*settings.scale);
      if (corner.value === 0) continue;
      if (!allowed.includes(corner.value)) add({ category:'radius',field:corner.field,rule:'radius-outside-spec',severity:'warning',title:`${corner.label}不在圆角规范中`,actual:String(corner.value),expected:`直角 0 或 ${allowed.join('、')}`,suggestions:allowed.map((v,i) => `${RADIUS_NAMES[i]} · ${v}`) });
      if (corner.binding?.verifiedCollection && /Dimension$/i.test(corner.binding.collection)) {
        const index=RADIUS_NAMES.indexOf(tokenName(corner.binding.name));
        if (index>=0 && Math.abs(corner.value-allowed[index])>0.001) add({ category:'radius',field:corner.field,rule:'radius-token-value-mismatch',severity:'warning',title:`${corner.label}变量与规范快照不同`,actual:`${corner.binding.name} · ${corner.value}`,expected:`${RADIUS_NAMES[index]} · ${allowed[index]}`,suggestions:[] });
      }
      if (corner.binding?.unavailable) add({ category:'radius',field:corner.field,rule:'unresolved-radius-variable',severity:'warning',title:`${corner.label}变量无法读取`,actual:corner.binding.name,expected:'检查变量及团队库权限',suggestions:[] });
    }
  }
  return issues;
}
