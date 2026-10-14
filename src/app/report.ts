import type { ScanResult } from '../shared/types';
import { SPEC_URL, SPEC_VERSION } from '../shared/spec';
export function makeReport(result: ScanResult) {
  return { plugin:'转转 Design Lint',version:'2.2.0',spec:{ url:SPEC_URL,version:SPEC_VERSION,source:'内部规范的已发布变量快照；非完整组件库审计' },...result,counts:{ errors:result.issues.filter(i=>i.severity==='error').length,warnings:result.issues.filter(i=>i.severity==='warning').length,ignored:result.ignored.length },manualReview:['组件用途与状态','行高、字距、段落间距','间距与尺寸','图标规范','暗色模式','其他业务规范'] };
}
function cell(value: unknown) {
  let text=String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)||/^[\t\r\n]/.test(text)) text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
export function makeCSV(result: ScanResult) {
  const rows: unknown[][]=[['记录类型','状态','级别','图层','路径','问题','实际值','建议','规则','图层ID','文字起点','文字终点','忽略原因']];
  rows.push(['检查元数据',result.complete?'读取完整':'读取不完整','',result.pageName,result.scopeNames.join(' / '),'检查时间',result.at,`规范 ${SPEC_VERSION}；数值标尺 × ${result.settings.scale}`]);
  rows.push(['覆盖范围','','','','','检查设置',JSON.stringify(result.settings),result.notices.join('；')]);
  for (const issue of [...result.issues,...result.ignored]) {
    const ignored=result.ignored.find(i=>i.id===issue.id);
    rows.push(['问题',ignored?'已忽略':'待处理',issue.severity==='error'?'待修复':'待核对',issue.nodeName,issue.path,issue.title,issue.actual,issue.expected,issue.rule,issue.nodeId,issue.start!==undefined?issue.start+1:'',issue.end,ignored?.ignore.reason]);
  }
  for(const log of result.repairHistory??[])for(const entry of log.entries)rows.push(['修复记录',entry.status==='applied'?'已修改':entry.status==='skipped'?'已跳过':'失败','',entry.nodeName,'',entry.message??'',entry.before,entry.after,entry.issueId,entry.nodeId,'','',log.at]);
  return '\ufeff'+rows.map(row=>row.map(cell).join(',')).join('\r\n');
}
