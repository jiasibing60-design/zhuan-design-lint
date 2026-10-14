import { DEFAULT_SETTINGS } from '../shared/types';
import type { Settings, ScanResult, Issue, FixCandidate, UIMessage, RepairPlan, RepairLog, CleanupPlan } from '../shared/types';
import { SPEC_URL, SPEC_VERSION, SEMANTICS, BODY_SIZES, PRICE_SIZES, RADII, RADIUS_NAMES } from '../shared/spec';
import { makeCSV, makeReport } from './report';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (message: UIMessage) => parent.postMessage({ pluginMessage:message },'*');
const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
let settings: Settings = { ...DEFAULT_SETTINGS };
let result: ScanResult | undefined;
let filter = 'all', severity = 'all', query = '', showingIgnored = false;
let visible: Issue[] = [];
let busy = false;
let dialogIssue: Issue | undefined;
let dialogMode: 'ignore' | 'apply' = 'ignore';
let toastTimer: ReturnType<typeof setTimeout>;
let candidates: FixCandidate[] = [];
const selectedRepairs=new Set<string>();
let repairPlan:RepairPlan|undefined;
let previewRequest=0;
let activeRequest='';
let repairRunning=false;
let cleanupPlan:CleanupPlan|undefined;
const cleanupDialog=$<HTMLDialogElement>('cleanup-dialog');
const repairDialog=$<HTMLDialogElement>('repair-dialog');
const dialog = $<HTMLDialogElement>('issue-dialog');
function toast(message: string) { $('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').hidden=true;},5000); }
function setBusy(value: boolean) {
  busy=value;$('scan-progress').hidden=!value;$<HTMLButtonElement>('scan').disabled=value;$('cancel').hidden=!value||repairRunning;
  $<HTMLButtonElement>('cleanup').disabled=value;
  $<HTMLButtonElement>('auto-repair').disabled=value||!result?.issues.length;
  for (const id of ['export-json','export-csv','repair-selected','select-visible']) $<HTMLButtonElement>(id).disabled=value;
}
function syncForm() {
  for (const [key,value] of Object.entries(settings)) {
    const el = document.querySelector<HTMLInputElement|HTMLSelectElement>(`[name="${key}"]`);
    if (!el) continue;
    if (el instanceof HTMLInputElement) el.checked=Boolean(value); else el.value=String(value);
  }
}
function renderSpec() {
  $('spec-view').innerHTML=`<div class="section-title"><h2>团队规范</h2><button data-tab="check">返回检查</button></div><p class="hint">已发布变量快照 · ${SPEC_VERSION}</p><div class="note">来自内部规范的已核实变量汇总，共 73 个变量。当前快照包含颜色、字体字号与圆角；组件库审计仍需人工完成。</div><div class="spec-heading"><h3>语义颜色</h3><span>19 个 · Light</span></div><div class="token-grid">${SEMANTICS.map(t=>`<div class="token-item"><span class="token-swatch" style="background:${t.hex};opacity:${t.alpha}"></span><div><strong>${escape(t.name)}</strong><small>${t.hex}${t.alpha<1?` · ${t.alpha*100}%`:''}</small></div></div>`).join('')}</div><div class="spec-heading"><h3>字体与字号</h3><span>Figma 原始数值</span></div><div class="spec-values"><b>正文</b> PingFang SC<br><b>中文字号</b> ${BODY_SIZES.join(' / ')}<br><b>价格</b> Akrobat ExtraBold<br><b>价格字号</b> ${PRICE_SIZES.join(' / ')}<br><br>正文统一字重、行高、字距和段落间距尚未定义。插件不推断标题与正文层级。</div><div class="spec-heading"><h3>圆角</h3><span>7 个变量</span></div><div>${RADII.map((v,i)=>`<span class="spec-pill">${RADIUS_NAMES[i]} · ${v}</span>`).join('')}</div><div class="note">规范未确认设计稿采用 1× 还是 2×。默认按原始数值检查，需换算时请在设置中选择 × 0.5。组件用途、间距、描边宽度、状态、暗色模式与图标规则均未在快照中定义。</div><a class="spec-source" href="${SPEC_URL}" target="_blank" rel="noopener noreferrer">打开内部设计规范 ↗</a>`;
  $<HTMLAnchorElement>('spec-link').href=SPEC_URL;
}
function render() {
  if (!result) return;
  $('welcome').hidden=true;$('results').hidden=false;
  const errors=result.issues.filter(i=>i.severity==='error').length;
  const warnings=result.issues.length-errors;
  const allRules=result.settings.text&&result.settings.fill&&result.settings.stroke&&result.settings.radius&&result.settings.checkSpec;
  const pass=!errors&&!warnings&&result.complete&&allRules;
  $('summary').className='summary'+(pass?' good':!errors?' neutral':'');
  $('summary').innerHTML=`<strong>${!result.complete?'检查未完整完成':errors?`${errors} 项待修复，交付前请处理`:warnings?`${warnings} 项待核对，请确认用途`:!allRules?'已启用规则未发现问题':'当前检查范围未发现问题'}</strong><p>${errors||warnings?`待修复 ${errors} · 待核对 ${warnings} · 已忽略 ${result.ignored.length}`:result.ignored.length?`存在 ${result.ignored.length} 项已忽略问题，请在交付时说明原因`:'请结合检查覆盖范围与人工验收完成交付'}</p>`;
  const counts = { all:result.issues.length,text:result.issues.filter(i=>i.category==='text').length,color:result.issues.filter(i=>i.category==='fill'||i.category==='stroke').length,radius:result.issues.filter(i=>i.category==='radius').length };
  for (const [key,value] of Object.entries(counts)) $('count-'+key).textContent=String(value);
  $('open-count').textContent=String(result.issues.length);$('ignored-count').textContent=String(result.ignored.length);
  $('show-open').classList.toggle('active',!showingIgnored);$('show-ignored').classList.toggle('active',showingIgnored);
  const source=showingIgnored?result.ignored:result.issues;
  visible=source.filter(i=>(filter==='all'||i.category===filter||(filter==='color'&&(i.category==='fill'||i.category==='stroke')))&&(severity==='all'||i.severity===severity)&&(!query||[i.nodeName,i.path,i.title,i.actual,i.expected].join(' ').toLowerCase().includes(query)));
  for(const id of selectedRepairs)if(!result.issues.some(i=>i.id===id))selectedRepairs.delete(id);
  $('issue-list').innerHTML=visible.length?visible.slice(0,200).map(card).join(''):`<div class="empty-list">${showingIgnored?'没有符合筛选的已忽略问题':result.issues.length?'没有符合筛选的问题':'✓ 当前规则未发现问题'}<br>可调整筛选条件或检查设置</div>`;
  if (visible.length>200) $('issue-list').insertAdjacentHTML('beforeend','<div class="empty-list">当前显示前 200 项，请搜索或筛选缩小范围。<br>导出报告包含全部结果。</div>');
  $('scan-meta').textContent=`${result.scanned} 个图层 · ${(result.duration/1000).toFixed(1)} 秒`;
  const rules=[result.settings.text?'文字样式':'',result.settings.fill?'填充':'',result.settings.stroke?'描边':'',result.settings.radius&&result.settings.checkSpec?'圆角':''].filter(Boolean).join(' / ')||'无';
  $('coverage').textContent=`检查范围：${result.scope==='page'?'当前页面':'选中图层'} · ${result.scopeNames.join('、')}。已启用：${rules}；${result.settings.checkSpec?'规范核对开启':'规范核对关闭'}；字号与圆角 × ${result.settings.scale}。${result.notices.join('；')}。未覆盖规范尚未定义的组件、间距、行高等规则。`;
  $('footer-status').textContent=`${new Date(result.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})} 已检查${result.settings.live?' · 自动复查已开启':''}`;
  updateRepairSelection();
}
function card(i: Issue) {
  const ignore=result?.ignored.find(j=>j.id===i.id)?.ignore;
  return `<article class="issue-card" data-id="${escape(i.id)}"><div class="issue-header">${!ignore?`<input type="checkbox" data-repair-check="${escape(i.id)}" aria-label="选择修复 ${escape(i.nodeName)} ${escape(i.title)}" ${selectedRepairs.has(i.id)?'checked':''}>`:''}<h3>${escape(i.title)}</h3><span class="severity-tag ${i.severity}">${i.severity==='error'?'修复':'核对'}</span></div><button class="layer-button" data-action="locate" title="${escape(i.path)}">${escape(i.nodeName)} ↗</button><div class="issue-value">${i.swatch?`<i class="swatch" style="background:${/^#[\da-f]{6}$/i.test(i.swatch)?i.swatch:'#fff'}"></i>`:''}${escape(i.actual)}</div><div class="issue-actions">${!ignore?'<button data-action="repair" class="repair-link">修复</button>':''}<button data-action="${ignore?'restore':'ignore'}">${ignore?'恢复':'忽略'}</button><details><summary>详情</summary><div class="issue-detail">${escape(i.path)}${i.start!==undefined?`<br>文字区间：第 ${i.start+1}–${i.end} 位`:''}<br>建议：${escape(i.expected)}${i.suggestions.length?`<br>可参考：${escape(i.suggestions.join('；'))}`:''}${ignore?`<br>忽略原因：${escape(ignore.reason)}`:''}</div></details></div></article>`;
}
document.addEventListener('click',event=>{
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]');if(!button)return;
  const target=button.classList.contains('active')?'check':button.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(el=>el.classList.toggle('active',(el as HTMLElement).dataset.tab===target));
  for(const tab of ['check','spec','settings'])$(tab+'-view').hidden=tab!==target;
});
document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(button=>button.onclick=()=>{filter=button.dataset.filter!;document.querySelectorAll('[data-filter]').forEach(el=>el.classList.toggle('active',el===button));render();});
$('scan').onclick=()=>{if(!Object.entries(settings).some(([key,v])=>['text','fill','stroke'].includes(key)&&v)&&!(settings.radius&&settings.checkSpec)){toast('请在检查设置中至少启用一项规则');return;}send({ type:'scan',scope:$<HTMLSelectElement>('scope').value as 'page'|'selection' });};
$('cancel').onclick=()=>send({ type:'cancel' });
$('show-open').onclick=()=>{showingIgnored=false;render();};$('show-ignored').onclick=()=>{showingIgnored=true;render();};
$<HTMLInputElement>('search').oninput=e=>{query=(e.target as HTMLInputElement).value.trim().toLowerCase();render();};
$<HTMLSelectElement>('severity').onchange=e=>{severity=(e.target as HTMLSelectElement).value;render();};
$('select-visible').onclick=()=>{if(visible.length)send({ type:'locate',nodeIds:visible.map(i=>i.nodeId) });else toast('当前筛选没有问题图层');};
$('issue-list').onclick=e=>{
  const button=(e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  const id=button?.closest<HTMLElement>('[data-id]')?.dataset.id;
  const issue=visible.find(i=>i.id===id);if(!button||!issue)return;
  if(button.dataset.action==='locate')send({ type:'locate',nodeIds:[issue.nodeId] });
  else if(button.dataset.action==='repair')openRepair([issue.id]);
  else if(button.dataset.action==='restore')send({ type:'restore',fingerprint:issue.fingerprint });
  else if(button.dataset.action==='ignore'){
    dialogIssue=issue;dialogMode='ignore';$('dialog-content').innerHTML=`<h3>忽略此问题</h3><p>${escape(issue.nodeName)} · ${escape(issue.title)}<br>填写原因，便于在交付报告中说明。</p><textarea id="ignore-reason" placeholder="例如：活动插画专用颜色，已与研发确认" maxlength="240" required></textarea>`;$('dialog-submit').textContent='确认忽略';$<HTMLButtonElement>('dialog-submit').disabled=false;dialog.showModal();
  } else if(button.dataset.action==='match'){
    dialogIssue=issue;dialogMode='apply';$('dialog-content').innerHTML='<h3>匹配可用样式</h3><p>正在匹配本文件样式、变量与已启用的 ZHUAN 团队颜色库…</p>';$<HTMLButtonElement>('dialog-submit').disabled=true;$('dialog-submit').textContent='应用关联';dialog.showModal();send({ type:'candidates',issueId:issue.id });
  }
};
$('dialog-close').onclick=()=>dialog.close();
$<HTMLFormElement>('dialog-form').onsubmit=e=>{
  e.preventDefault();if(!dialogIssue)return;
  if(dialogMode==='ignore'){const reason=$<HTMLTextAreaElement>('ignore-reason').value.trim();if(!reason){toast('请填写忽略原因');return;}send({ type:'ignore',fingerprint:dialogIssue.fingerprint,reason });}
  else{const selected=document.querySelector<HTMLInputElement>('input[name="candidate"]:checked');if(!selected)return;send({ type:'apply',issueId:dialogIssue.id,candidateId:selected.value });}
  dialog.close();
};
$<HTMLFormElement>('settings-form').onsubmit=e=>{e.preventDefault();const data=new FormData(e.target as HTMLFormElement);const next={ ...settings };for(const key of Object.keys(next) as (keyof Settings)[]){if(key==='scale')next.scale=data.get(key)==='0.5'?0.5:1;else (next[key] as boolean)=data.has(key);}send({ type:'settings',settings:next });};
$('clear-ignored').onclick=()=>send({ type:'clear-ignored' });
function download(content: string,type: string,extension: string) {
  const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`转转设计检查-${new Date().toISOString().slice(0,10)}.${extension}`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('export-json').onclick=()=>{if(result&&!busy)download(JSON.stringify(makeReport(result),null,2),'application/json;charset=utf-8','json');};
$('export-csv').onclick=()=>{if(result&&!busy)download(makeCSV(result),'text/csv;charset=utf-8','csv');};
window.addEventListener('message',event=>{
  if(event.source!==parent)return;const m=event.data.pluginMessage;if(!m)return;
  if(m.type==='init'){settings=m.settings;syncForm();$('page-name').textContent=m.pageName;$('selection-hint').textContent=m.count?`已选中 ${m.count} 个图层 · 会检查全部子图层`:'在 Figma 中选择要交付的设计稿';}
  else if(m.type==='selection')$('selection-hint').textContent=m.count?`当前选中 ${m.count} 个图层 · 点击开始检查可更新范围`:'在 Figma 中选择要交付的设计稿';
  else if(m.type==='scanning'){setBusy(true);$('progress-text').textContent=`正在检查 · 已读取 ${m.scanned} 个图层`;$('footer-status').textContent='检查中…';}
  else if(m.type==='result'){result=m.result;setBusy(false);render();}
  else if(m.type==='repair-plan'&&m.requestId===activeRequest&&repairDialog.open){repairPlan=m.plan;renderRepairPlan();}
  else if(m.type==='repairing'){repairRunning=true;setBusy(true);$('progress-text').textContent=`正在修复 ${m.done} / ${m.total} 项`;$('repair-apply').textContent=`正在修复 ${m.done} / ${m.total}`;$<HTMLButtonElement>('repair-close').disabled=true;}
  else if(m.type==='planning'){setBusy(true);$('cancel').hidden=true;$('progress-text').textContent='正在匹配可直接修复的项目…';}
  else if(m.type==='auto-empty'){setBusy(false);toast(m.message);}
  else if(m.type==='cleanup-plan'){setBusy(false);if(cleanupDialog.open){cleanupPlan=m.plan;renderCleanup();}}
  else if(m.type==='cleaning'){repairRunning=true;setBusy(true);$('progress-text').textContent=`正在清理 ${m.done} / ${m.total} 个图层`;$<HTMLButtonElement>('cleanup-close').disabled=true;}
  else if(m.type==='cleanup-complete'){repairRunning=false;$<HTMLButtonElement>('cleanup-close').disabled=false;cleanupDialog.close();setBusy(false);const deleted=m.entries.filter((e:{status:string})=>e.status==='deleted');const skipped=m.entries.length-deleted.length;feedback(`已删除 ${deleted.length} 个图层${skipped?`，${skipped} 个因变化跳过`:''}。可使用 Figma 撤销恢复。`);}
  else if(m.type==='repair-complete'){repairRunning=false;$<HTMLButtonElement>('repair-close').disabled=false;repairDialog.close();showRepairLog(m.log,m.automatic);selectedRepairs.clear();}
  else if(m.type==='settings-saved'){settings=m.settings;syncForm();toast('设置已保存');}
  else if(m.type==='reset'){cleanupPlan=undefined;cleanupDialog.close();result=undefined;selectedRepairs.clear();repairPlan=undefined;repairDialog.close();$('repair-feedback').hidden=true;setBusy(false);$('results').hidden=true;$('welcome').hidden=false;$('page-name').textContent=m.pageName;toast('已切换页面，请重新选择检查范围');}
  else if(m.type==='cancelled'){setBusy(false);if(result)render();toast('已取消，本次未完成的结果没有替换上一份报告');}
  else if(m.type==='error'){repairRunning=false;$<HTMLButtonElement>('cleanup-close').disabled=false;$<HTMLButtonElement>('repair-close').disabled=false;syncRepairApply();syncCleanup();setBusy(false);if(result)render();
    if(cleanupDialog.open||repairDialog.open){const host=$(cleanupDialog.open?'cleanup-items':'repair-items');host.querySelector('.operation-error')?.remove();host.insertAdjacentHTML('afterbegin',`<div class="note operation-error" role="alert">${escape(m.message)}</div>`);}
    else toast(m.message);}
  else if(m.type==='candidates'&&dialogIssue?.id===m.issueId){
    candidates=m.candidates;$('dialog-content').innerHTML=`<h3>匹配可用样式</h3><p>本文件候选按实际值匹配；团队颜色变量按规范快照列出，应用前再次核对当前模式值。请选择符合用途的候选，应用后可用 Figma 撤销恢复。</p>${candidates.length?candidates.map((c,index)=>`<label class="candidate-label"><input type="radio" name="candidate" value="${escape(c.id)}" ${index===0?'checked':''}><span>${escape(c.name)}<br><small>${c.remote?'已启用团队库 · 应用时导入':c.kind==='textStyle'?'文字样式':c.kind==='paintStyle'?'颜色样式':'颜色变量'}</small></span></label>`).join(''):'<div class="note">没有找到同值候选。请确认已启用 ZHUAN 团队库，或在 Figma 右侧面板选择适用样式。</div>'}`;$<HTMLButtonElement>('dialog-submit').disabled=!candidates.length;
  }
});
function updateRepairSelection() {
  $('repair-count').textContent=String(selectedRepairs.size);
  $('repair-selected').hidden=!selectedRepairs.size;
  $<HTMLButtonElement>('repair-selected').disabled=busy||showingIgnored||!selectedRepairs.size;
  const check=$<HTMLInputElement>('select-repairs');
  check.disabled=busy||showingIgnored||!visible.length;
  check.checked=!!visible.length&&visible.every(i=>selectedRepairs.has(i.id));
  check.indeterminate=!check.checked&&visible.some(i=>selectedRepairs.has(i.id));
}
$('issue-list').addEventListener('change',event=>{const input=event.target as HTMLInputElement;const id=input.dataset.repairCheck;if(!id)return;if(input.checked)selectedRepairs.add(id);else selectedRepairs.delete(id);updateRepairSelection();});
$<HTMLInputElement>('select-repairs').onchange=event=>{const checked=(event.target as HTMLInputElement).checked;visible.forEach(i=>checked?selectedRepairs.add(i.id):selectedRepairs.delete(i.id));render();};
$('repair-selected').onclick=()=>openRepair([...selectedRepairs]);
function openRepair(ids:string[]) {
  if(busy||repairRunning)return;
  if(ids.length>100){toast('一次最多修复 100 项，请先筛选或减少勾选');return;}
  repairPlan=undefined;activeRequest=String(++previewRequest);
  $('repair-items').innerHTML='<div class="note">正在读取图层并生成修复选项…</div>';
  $<HTMLInputElement>('auto-repairs').checked=false;
  $<HTMLButtonElement>('repair-apply').disabled=true;
  if(!repairDialog.open)repairDialog.showModal();
  send({type:'repair-preview',issueIds:ids,requestId:activeRequest});
}
function renderRepairPlan() {
  if(!repairPlan)return;
  $('repair-items').innerHTML=repairPlan.items.map((item,index)=>`<article class="repair-item" data-repair-id="${escape(item.issue.id)}"><label class="repair-item-title"><input class="repair-enabled" type="checkbox" ${item.options.length?'':'disabled'}><strong>${escape(item.issue.nodeName)}</strong></label><p class="repair-problem">${escape(item.issue.title)}</p><div class="repair-before">当前：${escape(item.issue.actual)}</div><details class="repair-options"><summary>选择修改目标</summary><div class="repair-option-list">${item.options.map(option=>`<label class="repair-radio"><input type="radio" class="repair-option" name="repair-${index}" value="${escape(option.id)}"><span>${escape(option.label)}${option.recommended?' · 参考值':''}</span></label>`).join('')||'<span>没有可用修复目标</span>'}</div></details><div class="repair-detail"></div><div class="repair-note">${escape(item.note)}</div></article>`).join('')||'<div class="note">所选问题已变化，请重新检查。</div>';
  syncRepairApply();
}
function repairChoices() {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-repair-id]')).flatMap(row=>{
    const enabled=row.querySelector<HTMLInputElement>('.repair-enabled')!.checked;
    const optionId=row.querySelector<HTMLInputElement>('.repair-option:checked')?.value;
    return enabled&&optionId?[{issueId:row.dataset.repairId!,optionId}]:[];
  });
}
function syncRepairApply() {
  const choices=repairChoices();let conflict=false;
  const targets=new Set<string>();
  for(const choice of choices){const item=repairPlan?.items.find(i=>i.issue.id===choice.issueId);if(item){if(targets.has(item.target))conflict=true;targets.add(item.target);}}
  $<HTMLButtonElement>('repair-apply').disabled=repairRunning||!choices.length||conflict;
  $('repair-apply').textContent=conflict?'同一属性请只选一个目标':`应用 ${choices.length} 项修复`;
}
$('repair-items').addEventListener('change',event=>{
  const target=event.target as HTMLInputElement|HTMLSelectElement;
  const row=target.closest<HTMLElement>('[data-repair-id]');if(!row)return;
  const item=repairPlan?.items.find(i=>i.issue.id===row.dataset.repairId);
  const select=row.querySelector<HTMLInputElement>('.repair-option:checked');
  if(target.classList.contains('repair-option'))row.querySelector<HTMLInputElement>('.repair-enabled')!.checked=!!select;
  const option=item?.options.find(o=>o.id===select?.value);
  row.querySelector('.repair-detail')!.textContent=option?.detail??'';
  if(option){row.querySelector('summary')!.textContent='修改为：'+option.label;row.querySelector<HTMLDetailsElement>('details')!.open=false;}
  syncRepairApply();
});
$<HTMLInputElement>('auto-repairs').onchange=event=>{
  const checked=(event.target as HTMLInputElement).checked;
  const occupied=new Set<string>();
  document.querySelectorAll<HTMLElement>('[data-repair-id]').forEach(row=>{
    const item=repairPlan?.items.find(i=>i.issue.id===row.dataset.repairId);
    const automatic=item?.options.find(o=>o.automatic);
    if(!item||!automatic||occupied.has(item.target))return;
    occupied.add(item.target);
    row.querySelectorAll<HTMLInputElement>('.repair-option').forEach(input=>input.checked=checked&&input.value===automatic.id);
    row.querySelector<HTMLInputElement>('.repair-enabled')!.checked=checked;
    row.querySelector('.repair-detail')!.textContent=checked?automatic.detail:'';
    row.querySelector('summary')!.textContent=checked?'修改为：'+automatic.label:'选择修改目标';
  });syncRepairApply();
};
$('repair-close').onclick=()=>{if(!repairRunning){activeRequest='';repairDialog.close();}};
repairDialog.addEventListener('cancel',event=>{if(repairRunning)event.preventDefault();else activeRequest='';});
$('repair-apply').onclick=()=>{if(!repairPlan||repairRunning)return;const choices=repairChoices();if(!choices.length)return;repairRunning=true;syncRepairApply();$<HTMLButtonElement>('repair-close').disabled=true;send({type:'repair-apply',planId:repairPlan.id,choices});};
function showRepairLog(log:RepairLog,automatic=false) {
  const applied=log.entries.filter(e=>e.status==='applied').length;
  const rejected=log.entries.filter(e=>e.status!=='applied');
  $('repair-feedback').hidden=false;
  $('repair-feedback').innerHTML=`<strong>已修改 ${applied} 项${rejected.length?`，${rejected.length} 项未完成`:''}</strong><br>${automatic?'其余问题请逐项选择修复目标。 ':''}已自动复查，可在 Figma 撤销本批修改。${rejected.length?`<details><summary>查看未完成原因</summary>${rejected.map(e=>`<div>${escape(e.nodeName)}：${escape(e.message)}</div>`).join('')}</details>`:''}`;
}
function feedback(message:string) {$('repair-feedback').hidden=false;$('repair-feedback').textContent=message;}
$('auto-repair').onclick=()=>{if(!busy&&result){setBusy(true);$('cancel').hidden=true;send({type:'auto-repair'});}};
$('cleanup').onclick=()=>{
  if(busy)return;cleanupPlan=undefined;$('cleanup-items').innerHTML='<div class="note">正在查找可清理图层…</div>';
  $('cleanup-meta').textContent='';$<HTMLButtonElement>('cleanup-apply').disabled=true;$<HTMLInputElement>('cleanup-all').checked=true;
  cleanupDialog.showModal();setBusy(true);$('cancel').hidden=true;$('progress-text').textContent='正在查找可清理图层…';send({type:'cleanup-preview',scope:$<HTMLSelectElement>('scope').value as 'page'|'selection'});
};
function renderCleanup() {
  if(!cleanupPlan)return;
  $('cleanup-meta').textContent=`找到 ${cleanupPlan.items.length} 个可清理图层，保留 ${cleanupPlan.protected} 个受保护候选。组件、锁定内容和原型引用均保留。`;
  $('cleanup-items').innerHTML=cleanupPlan.items.map(item=>`<label class="cleanup-item"><input type="checkbox" data-cleanup-id="${escape(item.id)}" checked><span><strong>${escape(item.name)}</strong><small>${escape(item.reason)}${item.descendants?` · 含 ${item.descendants} 个子图层`:''}</small><small class="cleanup-path" title="${escape(item.path)}">${escape(item.path)}</small></span><button type="button" data-cleanup-locate="${escape(item.id)}">定位</button></label>`).join('')||'<div class="empty-list">没有可清理的图层</div>';
  syncCleanup();
}
function cleanupIds() {return Array.from(document.querySelectorAll<HTMLInputElement>('[data-cleanup-id]:checked')).map(i=>i.dataset.cleanupId!);}
function syncCleanup() {
  const count=cleanupIds().length;$('cleanup-apply').textContent=`删除 ${count} 个图层`;$<HTMLButtonElement>('cleanup-apply').disabled=repairRunning||!count;
  const all=$<HTMLInputElement>('cleanup-all');all.disabled=!cleanupPlan?.items.length;all.checked=!!count&&count===cleanupPlan?.items.length;all.indeterminate=!!count&&!all.checked;
}
$('cleanup-items').addEventListener('change',syncCleanup);
$('cleanup-items').onclick=event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-cleanup-locate]');if(button){event.preventDefault();send({type:'locate',nodeIds:[button.dataset.cleanupLocate!]});}};
$<HTMLInputElement>('cleanup-all').onchange=event=>{const checked=(event.target as HTMLInputElement).checked;document.querySelectorAll<HTMLInputElement>('[data-cleanup-id]').forEach(i=>i.checked=checked);syncCleanup();};
$('cleanup-close').onclick=()=>{if(!repairRunning)cleanupDialog.close();};
cleanupDialog.addEventListener('cancel',event=>{if(repairRunning)event.preventDefault();});
$('cleanup-apply').onclick=()=>{if(!cleanupPlan||repairRunning)return;const ids=cleanupIds();if(!ids.length)return;repairRunning=true;syncCleanup();$<HTMLButtonElement>('cleanup-close').disabled=true;send({type:'cleanup-apply',planId:cleanupPlan.id,nodeIds:ids});};
renderSpec();syncForm();send({ type:'ready' });
