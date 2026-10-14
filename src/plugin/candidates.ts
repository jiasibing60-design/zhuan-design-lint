import type { FixCandidate, Issue } from '../shared/types';
import { createSnapshotReader } from './snapshot';
import { SEMANTICS, tokenName } from '../shared/spec';

const round = (v: number) => Math.round(v*10000)/10000;
const comparablePaints = (items: readonly Paint[]) => items.map(p => p.type === 'SOLID' ? { type:p.type,color:{ r:round(p.color.r),g:round(p.color.g),b:round(p.color.b) },opacity:round(p.opacity ?? 1),visible:p.visible !== false,blendMode:p.blendMode ?? 'NORMAL' } : p);
export async function findCandidates(issue: Issue, node: SceneNode): Promise<FixCandidate[]> {
  if (issue.rule === 'missing-text-style' && node.type === 'TEXT') {
    const start = issue.start!, end = issue.end!;
    const matches = (await figma.getLocalTextStylesAsync()).filter(s => {
      const font = node.getRangeFontName(start,end);
      return typeof font !== 'symbol' && font.family === s.fontName.family && font.style === s.fontName.style &&
        node.getRangeFontSize(start,end) === s.fontSize &&
        JSON.stringify(node.getRangeLineHeight(start,end)) === JSON.stringify(s.lineHeight) &&
        JSON.stringify(node.getRangeLetterSpacing(start,end)) === JSON.stringify(s.letterSpacing) &&
        node.getRangeTextCase(start,end) === s.textCase && node.getRangeTextDecoration(start,end) === s.textDecoration &&
        node.paragraphIndent === s.paragraphIndent && node.paragraphSpacing === s.paragraphSpacing;
    });
    return matches.map(s => ({ id:s.id,name:s.name,kind:'textStyle' }));
  }
  if (issue.rule !== 'missing-color-binding') return [];
  const p = issue.start !== undefined && node.type === 'TEXT' ? node.getRangeFills(issue.start,issue.end!) : issue.field === 'strokes' && 'strokes' in node ? node.strokes : 'fills' in node ? node.fills : [];
  if (typeof p === 'symbol') return [];
  const result: FixCandidate[] = [];
  const styles = await figma.getLocalPaintStylesAsync();
  const same = JSON.stringify(comparablePaints(p));
  for (const style of styles) if (JSON.stringify(comparablePaints(style.paints)) === same) result.push({ id:style.id,name:style.name,kind:'paintStyle' });
  const paint = p[issue.paintIndex!];
  if (paint?.type !== 'SOLID') return result;
  const matchesVariable = (value: VariableValue) => typeof value === 'object' && 'r' in value && Math.abs(value.r-paint.color.r)<0.0001 && Math.abs(value.g-paint.color.g)<0.0001 && Math.abs(value.b-paint.color.b)<0.0001 && Math.abs(('a' in value ? value.a : 1)-(paint.opacity ?? 1))<0.0001;
  const vars = await figma.variables.getLocalVariablesAsync('COLOR');
  for (const v of vars) try { if (matchesVariable(v.resolveForConsumer(node).value)) result.push({ id:v.id,name:v.name,kind:'colorVariable' }); } catch { /* Unresolvable variable isn't a repair candidate. */ }
  try {
    const libraries = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    for (const collection of libraries.filter(c => /^ZHUAN\s*\/\s*Color$/i.test(c.name.trim()))) {
      const descriptors = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(collection.key);
      for (const v of descriptors) {
        const token = SEMANTICS.find(t => t.name === tokenName(v.name));
        if (v.resolvedType !== 'COLOR' || !token || vars.some(local => local.key === v.key)) continue;
        const rgb = { r:parseInt(token.hex.slice(1,3),16)/255,g:parseInt(token.hex.slice(3,5),16)/255,b:parseInt(token.hex.slice(5,7),16)/255,a:token.alpha };
        if (matchesVariable(rgb)) result.push({ id:'library:'+v.key,name:`${v.name} · ZHUAN 团队库`,kind:'colorVariable',key:v.key,remote:true });
      }
    }
  } catch { /* Library permissions shouldn't prevent matching local candidates. */ }
  return result;
}

export async function applyCandidate(issue: Issue, node: SceneNode, candidate: FixCandidate) {
  if (candidate.kind === 'textStyle' && node.type === 'TEXT') {
    const font = node.getRangeFontName(issue.start!,issue.end!);
    if (typeof font === 'symbol') throw new Error('文字区间已变化，请重新检查');
    await figma.loadFontAsync(font);
    await node.setRangeTextStyleIdAsync(issue.start!,issue.end!,candidate.id);
  } else if (candidate.kind === 'paintStyle') {
    if (issue.start !== undefined && node.type === 'TEXT') await node.setRangeFillStyleIdAsync(issue.start,issue.end!,candidate.id);
    else if (issue.field === 'strokes' && 'setStrokeStyleIdAsync' in node) await node.setStrokeStyleIdAsync(candidate.id);
    else if ('setFillStyleIdAsync' in node) await node.setFillStyleIdAsync(candidate.id);
    else throw new Error('该图层不支持应用颜色样式');
  } else if (candidate.kind === 'colorVariable') {
    const v = candidate.remote && candidate.key ? await figma.variables.importVariableByKeyAsync(candidate.key) : await figma.variables.getVariableByIdAsync(candidate.id);
    if (!v) throw new Error('变量已不存在');
    const current = issue.start !== undefined && node.type === 'TEXT' ? node.getRangeFills(issue.start,issue.end!) : issue.field === 'strokes' && 'strokes' in node ? node.strokes : 'fills' in node ? node.fills : [];
    if (typeof current === 'symbol') throw new Error('填充已变化，请重新检查');
    const paints = [...current];
    const p = paints[issue.paintIndex!];
    if (!p || p.type !== 'SOLID') throw new Error('颜色已变化，请重新检查');
    const value = v.resolveForConsumer(node).value;
    if (typeof value !== 'object' || !('r' in value) || Math.abs(value.r-p.color.r)>0.0001 || Math.abs(value.g-p.color.g)>0.0001 || Math.abs(value.b-p.color.b)>0.0001 || Math.abs(('a' in value ? value.a : 1)-(p.opacity ?? 1))>0.0001) throw new Error('团队变量当前模式值与规范快照不同，未修改图层。请在 Figma 面板核对后应用');
    paints[issue.paintIndex!] = figma.variables.setBoundVariableForPaint(p,'color',v);
    if (issue.start !== undefined && node.type === 'TEXT') node.setRangeFills(issue.start,issue.end!,paints);
    else if (issue.field === 'strokes' && 'strokes' in node) node.strokes = paints;
    else if ('fills' in node) node.fills = paints;
  }
}
export { createSnapshotReader };
