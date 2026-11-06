window.__ModuleLoader__.load({
  id: 'dsh-equity-diligence',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback } = React

    let pluginCtx = null
    const PANEL_ID = 'equity'

    // ---------------------------------------------------------------------
    // CSS: host theme tokens with an original navy/blue/grey finance palette.
    // ---------------------------------------------------------------------
    const CSS = `
.eq-root{--eq-navy:#1F4E79;--eq-blue:#2F6FA8;--eq-light-blue:#D9E1F2;--eq-pale:#F2F5FA;--eq-accent:#BDD7EE;
  --eq-bg:var(--dsw-alias-bg-base,#f7f9fc);--eq-surface:var(--dsw-alias-bg-layer-1,#ffffff);--eq-surface-2:var(--dsw-alias-bg-layer-2,#f7f9fc);--eq-surface-3:var(--dsw-alias-bg-layer-3,#eef2f8);
  --eq-border:var(--dsw-alias-border-l1,#e2e8f0);--eq-border-strong:var(--dsw-alias-border-l2,#c9d4e3);--eq-text:var(--dsw-alias-label-primary,#172033);--eq-muted:var(--dsw-alias-label-secondary,#5b6778);--eq-faint:var(--dsw-alias-label-tertiary,#8a94a6);
  --eq-green:var(--dsw-alias-state-success-primary,#2e7d32);--eq-green-bg:#e8f5e9;--eq-amber:var(--dsw-alias-state-warn-primary,#a15c00);--eq-amber-bg:#fff4e0;--eq-red:var(--dsw-alias-state-error-primary,#b3261e);--eq-red-bg:#fdecea;--eq-run:var(--dsw-alias-state-business-primary,#1f5f9e);--eq-run-bg:#e7f0fa;
  height:100%;min-height:0;display:flex;flex-direction:column;background:var(--eq-bg);color:var(--eq-text);
  font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif);font-size:13px;line-height:1.5;
}
body[data-ds-dark-theme] .eq-root{--eq-green-bg:rgba(46,125,50,.18);--eq-amber-bg:rgba(161,92,0,.2);--eq-red-bg:rgba(179,38,30,.2);--eq-run-bg:rgba(31,95,158,.22);--eq-pale:rgba(255,255,255,.035);--eq-light-blue:rgba(189,215,238,.16)}
.eq-root *{box-sizing:border-box}
.eq-top{flex:0 0 58px;display:flex;align-items:center;gap:14px;padding:0 20px;border-bottom:1px solid var(--eq-border);background:var(--eq-surface);position:relative;z-index:3}
.eq-brand{display:flex;align-items:center;gap:10px;min-width:220px}
.eq-mark{width:30px;height:30px;border-radius:8px;background:var(--eq-navy);display:grid;place-items:center;color:#fff;font-weight:700;font-size:13px;letter-spacing:.5px}
.eq-brand-title{font-weight:650;font-size:14px;letter-spacing:.2px}
.eq-brand-sub{font-size:11px;color:var(--eq-faint);margin-top:1px}
.eq-top-spacer{flex:1}
.eq-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border:1px solid var(--eq-border);border-radius:6px;background:var(--eq-surface-2);color:var(--eq-muted);font-size:11.5px;white-space:nowrap}
.eq-chip b{color:var(--eq-text);font-weight:600}
.eq-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 11px;border-radius:6px;border:1px solid var(--eq-border-strong);background:var(--eq-surface);color:var(--eq-text);font-size:12px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s}
.eq-btn:hover{background:var(--eq-surface-3);border-color:var(--eq-blue)}
.eq-btn.primary{background:var(--eq-navy);border-color:var(--eq-navy);color:#fff}
.eq-btn.primary:hover{background:#173f63}
.eq-btn.danger{color:var(--eq-red);border-color:var(--eq-red)}
.eq-btn.ghost{border-color:transparent;background:transparent;color:var(--eq-muted)}
.eq-btn.ghost:hover{background:var(--eq-surface-3);color:var(--eq-text)}
.eq-btn:disabled{opacity:.45;cursor:not-allowed}
.eq-btn.sm{height:25px;padding:0 8px;font-size:11.5px}
.eq-body{flex:1;min-height:0;display:flex}
.eq-rail{flex:0 0 238px;border-right:1px solid var(--eq-border);background:var(--eq-surface);display:flex;flex-direction:column;min-height:0}
.eq-rail-head{padding:14px 14px 8px;display:flex;align-items:center;justify-content:space-between;color:var(--eq-faint);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.eq-rail-list{flex:1;overflow:auto;padding:2px 8px 12px}
.eq-project{width:100%;text-align:left;border:1px solid transparent;background:transparent;border-radius:7px;padding:9px 10px;margin:2px 0;cursor:pointer;display:flex;gap:9px;align-items:flex-start;color:var(--eq-text)}
.eq-project:hover{background:var(--eq-surface-3)}
.eq-project.active{background:var(--eq-pale);border-color:var(--eq-light-blue)}
.eq-dot{width:7px;height:7px;border-radius:50%;margin-top:6px;flex:0 0 auto;background:var(--eq-faint)}
.eq-dot.green{background:var(--eq-green)}.eq-dot.amber{background:var(--eq-amber)}.eq-dot.red{background:var(--eq-red)}.eq-dot.blue{background:var(--eq-run)}.eq-dot.grey{background:var(--eq-faint)}
.eq-project-name{font-weight:600;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eq-project-meta{font-size:10.5px;color:var(--eq-faint);margin-top:2px;display:flex;gap:6px;flex-wrap:wrap}
.eq-rail-foot{border-top:1px solid var(--eq-border);padding:10px}
.eq-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.eq-tabs{flex:0 0 42px;display:flex;align-items:flex-end;gap:2px;padding:0 18px;border-bottom:1px solid var(--eq-border);background:var(--eq-surface)}
.eq-tab{height:34px;padding:0 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--eq-muted);font-size:12.5px;cursor:pointer;display:flex;align-items:center;gap:6px}
.eq-tab:hover{color:var(--eq-text)}
.eq-tab.active{color:var(--eq-navy);border-bottom-color:var(--eq-navy);font-weight:600}
.eq-tab .eq-count{font-size:10.5px;color:var(--eq-faint);background:var(--eq-surface-3);border-radius:9px;padding:0 5px;line-height:16px}
.eq-scroll{flex:1;overflow:auto;padding:16px 18px 30px;min-height:0}
.eq-section{background:var(--eq-surface);border:1px solid var(--eq-border);border-radius:8px;margin-bottom:14px;overflow:hidden}
.eq-section-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--eq-border);background:var(--eq-surface)}
.eq-section-title{font-weight:650;font-size:13px;color:var(--eq-text)}
.eq-section-sub{font-size:11px;color:var(--eq-faint);margin-left:2px}
.eq-section-actions{margin-left:auto;display:flex;gap:6px;align-items:center}
.eq-section-body{padding:14px}
.eq-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-bottom:14px}
.eq-kpi{background:var(--eq-surface);border:1px solid var(--eq-border);border-radius:8px;padding:12px 13px;min-height:74px;position:relative;overflow:hidden}
.eq-kpi:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--eq-light-blue)}
.eq-kpi.green:before{background:var(--eq-green)}.eq-kpi.amber:before{background:var(--eq-amber)}.eq-kpi.red:before{background:var(--eq-red)}.eq-kpi.blue:before{background:var(--eq-run)}
.eq-kpi-label{font-size:10.5px;color:var(--eq-faint);letter-spacing:.04em}
.eq-kpi-value{font-size:23px;font-weight:680;margin-top:4px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.eq-kpi-note{font-size:10.5px;color:var(--eq-muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eq-three{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:14px}
.eq-question{border:1px solid var(--eq-border);border-radius:8px;background:var(--eq-surface);padding:13px 14px;min-height:132px;display:flex;flex-direction:column;gap:7px}
.eq-question h4{margin:0;font-size:12px;color:var(--eq-faint);font-weight:600;letter-spacing:.04em}
.eq-question .eq-big{font-size:17px;font-weight:680;font-variant-numeric:tabular-nums}
.eq-question .eq-small{font-size:11.5px;color:var(--eq-muted);line-height:1.55}
.eq-bar{height:6px;background:var(--eq-surface-3);border-radius:4px;overflow:hidden}
.eq-bar i{display:block;height:100%;background:var(--eq-blue);border-radius:4px}
.eq-bar i.green{background:var(--eq-green)}.eq-bar i.amber{background:var(--eq-amber)}.eq-bar i.red{background:var(--eq-red)}
.eq-table-wrap{overflow:auto;border:1px solid var(--eq-border);border-radius:7px}
.eq-table{width:100%;border-collapse:collapse;font-size:12px;min-width:680px}
.eq-table th{background:var(--eq-light-blue);color:var(--eq-navy);font-weight:650;text-align:left;padding:8px 9px;border-bottom:1px solid var(--eq-border);white-space:nowrap;font-size:11px;letter-spacing:.02em}
body[data-ds-dark-theme] .eq-table th{background:rgba(189,215,238,.14);color:#cfe2f5}
.eq-table td{padding:8px 9px;border-bottom:1px solid var(--eq-border);vertical-align:top}
.eq-table tr:last-child td{border-bottom:0}
.eq-table tbody tr:hover{background:var(--eq-surface-2)}
.eq-table .num{text-align:right;font-variant-numeric:tabular-nums}
.eq-table .mono{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:10.5px}
.eq-badge{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:5px;font-size:10.5px;font-weight:600;white-space:nowrap;border:1px solid transparent}
.eq-badge.green{background:var(--eq-green-bg);color:var(--eq-green);border-color:rgba(46,125,50,.25)}
.eq-badge.amber{background:var(--eq-amber-bg);color:var(--eq-amber);border-color:rgba(161,92,0,.25)}
.eq-badge.red{background:var(--eq-red-bg);color:var(--eq-red);border-color:rgba(179,38,30,.25)}
.eq-badge.blue{background:var(--eq-run-bg);color:var(--eq-run);border-color:rgba(31,95,158,.25)}
.eq-badge.grey{background:var(--eq-surface-3);color:var(--eq-muted);border-color:var(--eq-border)}
.eq-badge.navy{background:var(--eq-pale);color:var(--eq-navy);border-color:var(--eq-light-blue)}
.eq-sub{color:var(--eq-muted);font-size:11.5px}
.eq-mono{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace)}
.eq-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eq-list{display:flex;flex-direction:column;gap:7px}
.eq-row{display:flex;align-items:center;gap:9px;padding:8px 9px;border:1px solid var(--eq-border);border-radius:6px;background:var(--eq-surface)}
.eq-row:hover{border-color:var(--eq-border-strong)}
.eq-row-main{flex:1;min-width:0}
.eq-row-title{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eq-row-sub{font-size:10.5px;color:var(--eq-faint);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eq-flag{display:flex;gap:9px;padding:9px 10px;border:1px solid var(--eq-border);border-radius:6px;background:var(--eq-surface);border-left:3px solid var(--eq-amber)}
.eq-flag.material{border-left-color:var(--eq-red)}
.eq-flag-title{font-size:12px;font-weight:600}
.eq-flag-desc{font-size:11.5px;color:var(--eq-muted);margin-top:2px}
.eq-flag-action{font-size:10.5px;color:var(--eq-faint);margin-top:3px}
.eq-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.eq-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.eq-form{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}
.eq-field{display:flex;flex-direction:column;gap:4px}
.eq-field label{font-size:10.5px;color:var(--eq-faint);letter-spacing:.03em}
.eq-input,.eq-select,.eq-textarea{height:30px;border:1px solid var(--eq-border-strong);border-radius:6px;background:var(--eq-surface);color:var(--eq-text);padding:0 9px;font-size:12px;font-family:inherit;outline:none}
.eq-input:focus,.eq-select:focus,.eq-textarea:focus{border-color:var(--eq-blue);box-shadow:0 0 0 2px rgba(47,111,168,.15)}
.eq-textarea{height:auto;min-height:66px;padding:7px 9px;resize:vertical}
.eq-select{appearance:auto}
.eq-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.eq-help{font-size:10.5px;color:var(--eq-faint);line-height:1.45}
.eq-code{background:var(--eq-surface-2);border:1px solid var(--eq-border);border-radius:6px;padding:10px;font-family:var(--dsw-font-family-code,ui-monospace,Consolas,monospace);font-size:11px;line-height:1.55;overflow:auto;max-height:420px;white-space:pre-wrap;word-break:break-word}
.eq-drawer-mask{position:absolute;inset:0;background:rgba(8,18,30,.18);z-index:20}
.eq-drawer{position:absolute;right:0;top:0;bottom:0;width:min(560px,86vw);background:var(--eq-surface);border-left:1px solid var(--eq-border-strong);z-index:21;display:flex;flex-direction:column;box-shadow:-8px 0 28px rgba(15,30,50,.12)}
.eq-drawer-head{flex:0 0 auto;padding:13px 15px;border-bottom:1px solid var(--eq-border);display:flex;align-items:flex-start;gap:10px}
.eq-drawer-title{font-size:13.5px;font-weight:680;word-break:break-word}
.eq-drawer-sub{font-size:10.5px;color:var(--eq-faint);margin-top:3px}
.eq-drawer-body{flex:1;overflow:auto;padding:14px 15px 24px}
.eq-drawer-foot{flex:0 0 auto;border-top:1px solid var(--eq-border);padding:10px 15px;display:flex;gap:8px;justify-content:flex-end;background:var(--eq-surface-2)}
.eq-tabbar{display:flex;gap:2px;border-bottom:1px solid var(--eq-border);margin:0 0 12px}
.eq-tabbar button{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--eq-muted);font-size:11.5px;padding:7px 9px;cursor:pointer}
.eq-tabbar button.active{color:var(--eq-navy);border-bottom-color:var(--eq-navy);font-weight:600}
.eq-evidence{border:1px solid var(--eq-border);border-radius:6px;padding:9px 10px;margin-bottom:8px;background:var(--eq-surface)}
.eq-evidence-head{display:flex;gap:8px;align-items:center;margin-bottom:4px}
.eq-evidence-title{font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.eq-quote{border-left:2px solid var(--eq-accent);padding:4px 0 4px 9px;color:var(--eq-text);font-size:11.5px;margin:6px 0;line-height:1.6}
.eq-empty{padding:34px 18px;text-align:center;color:var(--eq-muted);border:1px dashed var(--eq-border-strong);border-radius:8px;background:var(--eq-surface-2)}
.eq-empty h3{margin:0 0 6px;font-size:14px;color:var(--eq-text)}
.eq-empty p{margin:0 auto 12px;max-width:520px;font-size:11.5px;line-height:1.6}
.eq-toast{position:absolute;right:18px;bottom:18px;z-index:40;background:var(--eq-text);color:var(--eq-surface);padding:9px 13px;border-radius:7px;font-size:12px;max-width:520px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
.eq-toast.error{background:var(--eq-red)}
.eq-banner{display:flex;gap:9px;align-items:flex-start;padding:9px 11px;border-radius:6px;border:1px solid var(--eq-border);background:var(--eq-surface-2);font-size:11.5px;color:var(--eq-muted);margin-bottom:12px}
.eq-banner.warn{background:var(--eq-amber-bg);border-color:rgba(161,92,0,.25);color:var(--eq-amber)}
.eq-banner.error{background:var(--eq-red-bg);border-color:rgba(179,38,30,.25);color:var(--eq-red)}
.eq-banner.info{background:var(--eq-run-bg);border-color:rgba(31,95,158,.22);color:var(--eq-run)}
.eq-module-row{display:grid;grid-template-columns:34px 92px minmax(180px,1.4fr) minmax(200px,1.8fr) 94px 86px;gap:10px;align-items:center;padding:9px 10px;border:1px solid var(--eq-border);border-radius:6px;background:var(--eq-surface);cursor:pointer}
.eq-module-row:hover{border-color:var(--eq-border-strong);background:var(--eq-surface-2)}
.eq-module-row.has-error{border-color:rgba(179,38,30,.45)}
.eq-module-index{font-size:10.5px;color:var(--eq-faint);font-variant-numeric:tabular-nums;text-align:center}
.eq-module-name{font-weight:600;font-size:12px}
.eq-module-id{font-size:10px;color:var(--eq-faint);margin-top:2px;font-family:var(--dsw-font-family-code,ui-monospace,Consolas,monospace)}
.eq-pipe{font-size:10.5px;color:var(--eq-muted);line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eq-pipe .arrow{color:var(--eq-faint);padding:0 3px}
.eq-matrix{border:1px solid var(--eq-border);border-radius:7px;overflow:auto}
.eq-matrix table{border-collapse:collapse;width:100%;min-width:620px;font-size:11px}
.eq-matrix th,.eq-matrix td{border-bottom:1px solid var(--eq-border);border-right:1px solid var(--eq-border);padding:6px 7px;text-align:center;white-space:nowrap}
.eq-matrix th:first-child,.eq-matrix td:first-child{text-align:left;position:sticky;left:0;background:var(--eq-surface);z-index:1;min-width:190px}
.eq-matrix th{background:var(--eq-light-blue);color:var(--eq-navy);font-weight:650}
body[data-ds-dark-theme] .eq-matrix th{background:rgba(189,215,238,.14);color:#cfe2f5}
.eq-cell{display:inline-block;width:18px;height:18px;border-radius:4px;line-height:18px;font-size:10px;font-weight:700}
.eq-cell.accepted{background:var(--eq-green-bg);color:var(--eq-green)}
.eq-cell.running{background:var(--eq-run-bg);color:var(--eq-run)}
.eq-cell.needs_human,.eq-cell.failed,.eq-cell.blocked{background:var(--eq-red-bg);color:var(--eq-red)}
.eq-cell.todo{background:var(--eq-surface-3);color:var(--eq-faint)}
.eq-file{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--eq-border);border-radius:6px;background:var(--eq-surface)}
.eq-file-name{flex:1;min-width:0;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eq-file-meta{font-size:10px;color:var(--eq-faint);white-space:nowrap}
.eq-split{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(300px,.9fr);gap:14px}
.eq-timeline{display:flex;flex-direction:column;gap:7px}
.eq-timeline-item{display:flex;gap:9px;align-items:flex-start;font-size:11.5px}
.eq-timeline-dot{width:8px;height:8px;border-radius:50%;background:var(--eq-light-blue);margin-top:5px;flex:0 0 auto}
.eq-timeline-item.done .eq-timeline-dot{background:var(--eq-green)}
.eq-timeline-item.active .eq-timeline-dot{background:var(--eq-run)}
.eq-timeline-item.error .eq-timeline-dot{background:var(--eq-red)}
.eq-side-note{font-size:10.5px;color:var(--eq-faint);line-height:1.55}
.eq-click{color:var(--eq-blue);cursor:pointer;text-decoration:none}
.eq-click:hover{text-decoration:underline}
.eq-sep{height:1px;background:var(--eq-border);margin:12px 0}
.eq-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.eq-search{height:28px;border:1px solid var(--eq-border-strong);border-radius:6px;background:var(--eq-surface);color:var(--eq-text);padding:0 9px;font-size:11.5px;min-width:200px}
.eq-pill{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:11px;background:var(--eq-surface-2);border:1px solid var(--eq-border);color:var(--eq-muted);font-size:10.5px}
.eq-pre{white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:11.5px;line-height:1.65;margin:0;color:var(--eq-text)}
@media (max-width:1180px){.eq-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}.eq-three{grid-template-columns:1fr}.eq-split{grid-template-columns:1fr}.eq-rail{flex-basis:204px}}
@media (max-width:860px){.eq-rail{display:none}.eq-top{flex-wrap:wrap;height:auto;min-height:58px;padding:8px 12px}.eq-module-row{grid-template-columns:26px 1fr 90px}.eq-module-row .eq-pipe{display:none}.eq-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
`

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------
    const TYPE_LABEL = {
      'company.roster': '目标清单',
      'company.identity': '主体底册',
      'ownership.chain': '股权控制',
      'investment.map': '投资版图',
      'org.people': '关键人',
      'company.history': '公司沿革',
      'financing.history': '融资历史',
      'business.segment': '业务与技术',
      'valuechain.parties': '客户供应商',
      'ip.portfolio': '知识产权',
      'legal.risk': '司法风险',
      'ops.risk': '经营风险',
      'market.landscape': '行业竞争',
      'financials.public': '公开财务',
      'related.parties': '关联方',
      'workforce.profile': '组织人力',
      'supply.capacity': '供应链产能',
      'tech.origin': '技术来源',
      qualifications: '资质准入',
      'debt.guarantee': '债务担保',
      'regulatory.compliance': '行政监管',
      'esg.ehs': 'ESG/EHS',
      'public.sentiment': '舆情',
      'assessment.fit': '合作契合',
      'risk.redflags': '红旗清单',
      'report.deliverable': '交付索引',
      'document.markdown': 'Markdown',
      'structured.findings': '通用发现',
      'search.ledger': '检索记录',
      'source.coverage': '来源覆盖',
      'dd.request_list': '资料请求',
      'policy.exposure': '出口管制',
    }
    const STATUS_LABEL = {
      draft: '草稿', verified: '已验证', stale: 'stale', rejected: '已否决',
      todo: '待办', running: '运行中', review: '审核中', accepted: '已接受', accepted_with_exception: '接受(有残留)',
      needs_human: '待人工', blocked: '阻断', failed: '失败', paused: '已暂停', cancelled: '已取消', completed: '完成', partial: '部分完成',
      open: '待处理', deferred: '延后', dismissed: '已驳回', waived: '已豁免',
      pass: '通过', fail: '未通过', pending: '待判定', insufficient: '证据不足', hit: '命中', miss: '未命中',
      covered: '已覆盖', missing: '缺失', not_applicable: '不适用', queued: '排队中', budget_exhausted: '预算耗尽',
    }
    const KIND_LABEL = { collect: '采集', verify: '核验', synthesize: '综合', assess: '评估', deliver: '交付' }
    function tone(status) {
      if (['verified', 'accepted', 'accepted_with_exception', 'completed', 'pass', 'hit', 'covered'].includes(status)) return 'green'
      if (['stale', 'needs_human', 'review', 'paused', 'partial', 'attention', 'deferred', 'insufficient'].includes(status)) return 'amber'
      if (['failed', 'blocked', 'rejected', 'fail', 'material', 'cancelled'].includes(status)) return 'red'
      if (['running', 'todo', 'queued', 'budget_exhausted'].includes(status)) return 'blue'
      return 'grey'
    }
    function label(status) { return STATUS_LABEL[status] ?? status ?? '—' }
    function fmtNum(value) {
      if (value === null || value === undefined || value === '') return '—'
      if (typeof value === 'number') return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
      return String(value)
    }
    function fmtBytes(bytes) {
      if (!bytes) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }
    function timeShort(value) {
      if (!value) return '—'
      return String(value).replace('T', ' ').slice(0, 16)
    }
    function hashShort(value) {
      return value ? String(value).replace('sha256:', '').slice(0, 10) : '—'
    }
    function typeLabel(type) { return TYPE_LABEL[type] ?? type }
    function subjectShort(id) {
      if (!id) return '—'
      return String(id).replace(/^co_/, '').replaceAll('_', ' ')
    }
    function pct(value) {
      if (value === null || value === undefined || value === '') return '—'
      if (typeof value === 'number') return `${value.toFixed(2)}%`
      return String(value)
    }
    function errorText(error) {
      if (!error) return ''
      return error.details ? `${error.message}（${JSON.stringify(error.details).slice(0, 240)}）` : error.message
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        ...options,
      })
      const text = await response.text()
      let data = {}
      try { data = text ? JSON.parse(text) : {} } catch { data = { ok: false, error: { code: 'bad_response', message: text.slice(0, 400) } } }
      if (!response.ok || data.ok === false) {
        const error = data.error ?? { code: `http_${response.status}`, message: text.slice(0, 400) }
        throw Object.assign(new Error(error.message ?? '请求失败'), { code: error.code, details: error.details })
      }
      return data
    }

    function Icon({ name, size = 14 }) {
      const paths = {
        refresh: 'M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z',
        plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z',
        play: 'M8 5v14l11-7L8 5Z',
        pause: 'M6 5h4v14H6V5Zm8 0h4v14h-4V5Z',
        check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z',
        x: 'M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3 1.4 1.4Z',
        folder: 'M3 5h7l2 2h9v12H3V5Zm2 4v8h14V9H5Z',
        search: 'M10 4a6 6 0 1 0 3.5 10.9l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
        doc: 'M6 2h8l4 4v16H6V2Zm7 2v4h4l-4-4ZM8 11h8v2H8v-2Zm0 4h8v2H8v-2Z',
        external: 'M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14V3ZM5 5h6v2H7v10h10v-4h2v6H5V5Z',
        layers: 'M12 2 2 7l10 5 10-5-10-5Zm0 9L2 16l10 5 10-5-10-5Z',
      }
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        h('path', { d: paths[name] ?? paths.doc }))
    }

    function Badge({ status, text }) {
      return h('span', { className: `eq-badge ${tone(status)}` }, text ?? label(status))
    }

    function Kpi({ label: name, value, note, tone: t = '' }) {
      return h('div', { className: `eq-kpi ${t}` },
        h('div', { className: 'eq-kpi-label' }, name),
        h('div', { className: 'eq-kpi-value' }, value),
        note ? h('div', { className: 'eq-kpi-note', title: note }, note) : null)
    }

    function Section({ title, sub, actions, children, style }) {
      return h('section', { className: 'eq-section', style },
        h('div', { className: 'eq-section-head' },
          h('div', null,
            h('div', { className: 'eq-section-title' }, title),
            sub ? h('div', { className: 'eq-section-sub' }, sub) : null),
          actions ? h('div', { className: 'eq-section-actions' }, actions) : null),
        h('div', { className: 'eq-section-body' }, children))
    }

    function Empty({ title, text, action }) {
      return h('div', { className: 'eq-empty' },
        h('h3', null, title),
        h('p', null, text),
        action ?? null)
    }

    function Drawer({ title, subtitle, onClose, children, footer }) {
      return h(React.Fragment, null,
        h('div', { className: 'eq-drawer-mask', onClick: onClose }),
        h('div', { className: 'eq-drawer', role: 'dialog', 'aria-label': title },
          h('div', { className: 'eq-drawer-head' },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { className: 'eq-drawer-title' }, title),
              subtitle ? h('div', { className: 'eq-drawer-sub' }, subtitle) : null),
            h('button', { className: 'eq-btn ghost sm', onClick: onClose, 'aria-label': '关闭' }, h(Icon, { name: 'x', size: 12 }))),
          h('div', { className: 'eq-drawer-body' }, children),
          footer ? h('div', { className: 'eq-drawer-foot' }, footer) : null))
    }

    function StateBadge({ value }) { return h(Badge, { status: value, text: label(value) }) }

    // ---------------------------------------------------------------------
    // Data hooks
    // ---------------------------------------------------------------------
    function useProjects() {
      const [projects, setProjects] = useState([])
      const [loading, setLoading] = useState(true)
      const refresh = useCallback(async () => {
        try {
          const data = await api('/api/equity/projects')
          setProjects(data.projects ?? [])
        } catch { /* host may not be ready */ }
        finally { setLoading(false) }
      }, [])
      useEffect(() => { refresh() }, [refresh])
      return { projects, loading, refresh, setProjects }
    }

    function useProjectState(projectId) {
      const [state, setState] = useState(null)
      const [loading, setLoading] = useState(false)
      const refresh = useCallback(async () => {
        if (!projectId) { setState(null); return }
        setLoading(true)
        try {
          const data = await api(`/api/equity/state?projectId=${encodeURIComponent(projectId)}`)
          setState(data.state)
        } catch { /* keep last */ }
        finally { setLoading(false) }
      }, [projectId])
      useEffect(() => { refresh() }, [refresh])
      useEffect(() => {
        if (!state || state.latestRun?.status !== 'running') return undefined
        const timer = setInterval(refresh, 3500)
        return () => clearInterval(timer)
      }, [state, refresh])
      return { state, loading, refresh }
    }

    function usePlaybook(projectId) {
      const [data, setData] = useState(null)
      const refresh = useCallback(async () => {
        if (!projectId) { setData(null); return }
        try { setData(await api(`/api/equity/playbook?projectId=${encodeURIComponent(projectId)}`)) } catch { /* keep */ }
      }, [projectId])
      useEffect(() => { refresh() }, [refresh])
      return { data, refresh, setData }
    }

    // ---------------------------------------------------------------------
    // Overview
    // ---------------------------------------------------------------------
    function Overview({ state, onTab, onAction, busy }) {
      if (!state) return h(Empty, { title: '还没有项目', text: '先创建一个调查项目。' })
      const businessArtifacts = (state.artifacts ?? []).filter((artifact) =>
        !['company.roster', 'search.ledger', 'source.coverage'].includes(artifact.type))
      const verified = businessArtifacts.filter((artifact) => artifact.status === 'verified').length
      const draft = businessArtifacts.filter((artifact) => artifact.status === 'draft').length
      const total = businessArtifacts.length
      const accepted = state.latestRun?.counts?.accepted ?? 0
      const units = state.latestRun?.counts?.total ?? 0
      const coverage = total ? Math.round((verified / total) * 100) : 0
      const redflags = state.redflags ?? []
      const material = redflags.filter((flag) => flag.level === 'material')
      const stale = state.stale?.length ?? 0
      const issues = state.issues?.length ?? 0
      const ready = state.readiness?.deliveryReady
      const running = state.latestRun?.status === 'running'
      const kpis = h('div', { className: 'eq-kpis' },
        h(Kpi, { label: '底稿', value: total, note: `已验证 ${verified} · 草稿 ${draft}`, tone: 'blue' }),
        h(Kpi, { label: '证据覆盖', value: `${coverage}%`, note: total ? '按已验证底稿占比' : '尚无底稿', tone: coverage >= 80 ? 'green' : 'amber' }),
        h(Kpi, { label: '运行单元', value: units ? `${accepted}/${units}` : '—', note: running ? '正在运行' : state.latestRun?.status ? label(state.latestRun.status) : '尚未运行', tone: running ? 'blue' : 'green' }),
        h(Kpi, { label: '红旗', value: redflags.length, note: `material ${material.length}`, tone: material.length ? 'red' : redflags.length ? 'amber' : 'green' }),
        h(Kpi, { label: '待核/议题', value: issues, note: `stale ${stale}`, tone: stale ? 'amber' : issues ? 'amber' : 'green' }),
        h(Kpi, { label: '交付', value: ready ? '可交' : state.deliverable ? '待体检' : '未构建', note: state.deliverable ? `QA ${state.deliverable.data?.qa?.passed ? '通过' : '未过'}` : '先运行再交付', tone: ready ? 'green' : state.deliverable ? 'amber' : 'grey' }))

      const three = h('div', { className: 'eq-three' },
        h('div', { className: 'eq-question' },
          h('h4', null, '查了没有'),
          h('div', { className: 'eq-big' }, total ? `${verified}/${total} 底稿已验证` : '尚未开始'),
          h('div', { className: 'eq-bar' }, h('i', { style: { width: `${coverage}%` }, className: coverage >= 80 ? 'green' : 'amber' })),
          h('div', { className: 'eq-small' }, units ? `最近运行 ${accepted}/${units} 单元接受` : '运行方案后，这里显示覆盖与进度。'),
          h('button', { className: 'eq-btn sm', onClick: () => onTab('runs'), disabled: busy }, running ? '查看看板' : '去运行')),
        h('div', { className: 'eq-question' },
          h('h4', null, '查得对不对'),
          h('div', { className: 'eq-big' }, `${redflags.length} 红旗 · ${issues} 议题`),
          h('div', { className: 'eq-small' }, `material ${material.length}；stale ${stale}；每个结论都挂 claimId 与证据。`),
          h('button', { className: 'eq-btn sm', onClick: () => onTab('artifacts'), disabled: busy }, '看底稿与证据')),
        h('div', { className: 'eq-question' },
          h('h4', null, '能不能交'),
          h('div', { className: 'eq-big' }, ready ? '可以交付' : state.deliverable ? '待体检' : '尚未构建'),
          h('div', { className: 'eq-small' }, state.deliverable ? `QA ${state.deliverable.data?.qa?.passed ? '通过' : '未通过'}；文件 ${state.deliverable.data?.files?.length ?? 0} 个。` : '构建后先看体检单，再签发。'),
          h('button', { className: 'eq-btn sm', onClick: () => onTab('deliver'), disabled: busy }, '去交付')))

      const matrixSection = h(Section, {
        title: '覆盖矩阵', sub: '模块 × 目标；颜色只表达状态',
        actions: h('button', { className: 'eq-btn ghost sm', onClick: () => onTab('playbook') }, '看方案'),
      },
        state.plan?.steps?.length
          ? h('div', { className: 'eq-matrix' }, h('table', null,
              h('thead', null, h('tr', null,
                h('th', null, '模块'),
                ...(state.project.targets ?? [{ name: '项目' }]).map((target) => h('th', { key: target.name }, target.name)),
                h('th', null, '接受'))),
              h('tbody', null,
                state.plan.steps.map((step) => h('tr', { key: step.instanceId },
                  h('td', null, h('div', { className: 'eq-row-title' }, step.name), h('div', { className: 'eq-row-sub' }, step.moduleId)),
                  ...(state.project.targets ?? [{ name: '项目' }]).map((target) => {
                    const unit = (state.latestRun?.units ?? []).find((item) => item.instanceId === step.instanceId && (item.subjectName === target.name || item.subjectId === 'project'))
                    return h('td', { key: target.name }, h('span', { className: `eq-cell ${unit?.status ?? 'todo'}`, title: unit?.status ? label(unit.status) : '待运行' }, unit?.status === 'accepted' ? '✓' : unit?.status === 'running' ? '…' : unit?.status === 'failed' ? '!' : '·'))
                  }),
                  h('td', null, `${step.status?.accepted ?? 0}/${step.status?.total ?? 0}`))))))
          : h(Empty, { title: '方案还没有编译', text: '去“方案”页编译，或先创建项目。', action: h('button', { className: 'eq-btn primary sm', onClick: () => onTab('playbook') }, '去方案') }))

      const flagsSection = h(Section, { title: '红旗与下一步', sub: '风险内容不阻断交付；一致性失败才阻断' },
        h('div', { className: 'eq-list' },
          redflags.slice(0, 6).map((flag, index) => h('div', { key: `${flag.rule}-${index}`, className: `eq-flag ${flag.level === 'material' ? 'material' : ''}` },
            h('div', null,
              h('div', { className: 'eq-flag-title' }, `${flag.level === 'material' ? '重大' : '关注'} · ${flag.rule ?? '红旗'}`),
              h('div', { className: 'eq-flag-desc' }, flag.desc),
              flag.action ? h('div', { className: 'eq-flag-action' }, `下一步：${flag.action}`) : null))),
          redflags.length === 0 ? h('div', { className: 'eq-sub' }, '暂无已核实红旗；运行后自动生成。') : null,
          h('div', { className: 'eq-sep' }),
          (state.nextActions ?? []).map((action) => h('button', { key: action.action, className: 'eq-btn sm', style: { justifyContent: 'flex-start' }, onClick: () => onAction?.(action.action), disabled: busy }, action.label))))

      const issuesSection = state.issues?.length
        ? h(Section, { title: '待人工议题', sub: `${state.issues.length} 个 open/deferred`, actions: h('button', { className: 'eq-btn ghost sm', onClick: () => onTab('runs') }, '去处理') },
            h('div', { className: 'eq-list' }, state.issues.slice(0, 8).map((issue) => h('div', { key: issue.issueId, className: 'eq-row' },
              h('span', { className: `eq-dot ${issue.severity === 'high' ? 'red' : 'amber'}` }),
              h('div', { className: 'eq-row-main' },
                h('div', { className: 'eq-row-title' }, issue.title),
                h('div', { className: 'eq-row-sub' }, issue.detail ?? '')),
              h(StateBadge, { value: issue.status })))))
        : null

      return h(React.Fragment, null, kpis, three, h('div', { className: 'eq-split' }, matrixSection, flagsSection), issuesSection)
    }

    // ---------------------------------------------------------------------
    // Playbook editor
    // ---------------------------------------------------------------------
    function ParamControl({ param, value, onChange }) {
      if (param.type === 'boolean') {
        return h('input', { type: 'checkbox', checked: Boolean(value ?? param.default), onChange: (event) => onChange(event.target.checked) })
      }
      if (param.enum) {
        return h('select', {
          className: 'eq-select',
          style: { height: 26 },
          value: value ?? param.default ?? '',
          onChange: (event) => onChange(event.target.value),
        }, param.enum.map((option) => h('option', { key: option, value: option }, option)))
      }
      return h('input', {
        className: 'eq-input',
        style: { height: 26, width: 130 },
        type: param.type === 'integer' ? 'number' : 'text',
        value: value ?? param.default ?? '',
        onChange: (event) => onChange(param.type === 'integer' ? Number(event.target.value) : event.target.value),
      })
    }

    function ModuleDetail({ step, module, instance, onParam, onToggle }) {
      const params = module?.params ?? []
      return h('div', { style: { border: '1px solid var(--eq-border)', borderTop: 0, borderRadius: '0 0 6px 6px', padding: '10px 12px', background: 'var(--eq-surface-2)' } },
        h('div', { className: 'eq-grid2' },
          h('div', null,
            h('div', { className: 'eq-sub', style: { marginBottom: 4 } }, '硬输入'),
            h('div', { className: 'eq-code', style: { maxHeight: 150 } }, JSON.stringify(step.inputs, null, 2)),
            h('div', { className: 'eq-sub', style: { marginTop: 8 } }, '软引用'),
            h('div', { className: 'eq-code', style: { maxHeight: 130 } }, JSON.stringify(step.references, null, 2))),
          h('div', null,
            h('div', { className: 'eq-sub', style: { marginBottom: 4 } }, '参数'),
            params.length
              ? h('div', { className: 'eq-list' }, params.map((param) => h('div', { key: param.key, className: 'eq-inline' },
                  h('span', { style: { minWidth: 120, fontSize: 11.5 } }, param.label ?? param.key),
                  h(ParamControl, {
                    param,
                    value: instance?.params?.[param.key],
                    onChange: (value) => onParam(step.instanceId, param.key, value),
                  }))))
              : h('div', { className: 'eq-sub' }, '无参数'),
            h('div', { className: 'eq-inline', style: { marginTop: 10 } },
              h('label', { className: 'eq-inline', style: { fontSize: 11.5 } },
                h('input', { type: 'checkbox', checked: instance?.enabled !== false, onChange: () => onToggle(step.instanceId) }),
                '启用'),
              h('span', { className: 'eq-pill' }, `门 ${step.gates?.length ?? 0}`),
              h('span', { className: 'eq-pill' }, `review ${step.review?.mode ?? 'none'}`),
              h('span', { className: 'eq-pill' }, `tools ${step.tools?.length ?? 0}`)))))
    }

    function ModuleRow({ step, module, error, expanded, instance, onSelect, onParam, onToggle }) {
      const statusValue = step.status?.accepted === step.status?.total && step.status?.total
        ? 'accepted'
        : step.status?.failed
          ? 'failed'
          : step.status?.total
            ? 'review'
            : 'todo'
      return h('div', null,
        h('div', { className: `eq-module-row ${error ? 'has-error' : ''}`, onClick: onSelect },
          h('div', { className: 'eq-module-index' }, String(step.index + 1).padStart(2, '0')),
          h('div', null,
            h('span', { className: 'eq-badge navy' }, KIND_LABEL[step.kind] ?? step.kind),
            h('div', { className: 'eq-row-sub' }, step.stage ?? '')),
          h('div', null,
            h('div', { className: 'eq-module-name' }, step.name),
            h('div', { className: 'eq-module-id' }, step.moduleId)),
          h('div', { className: 'eq-pipe' },
            (step.inputs ?? []).map((input) => input.type).join(' + ') || '无硬输入',
            h('span', { className: 'arrow' }, '→'),
            (step.outputs ?? []).map((output) => typeLabel(output.type)).join(' / ')),
          h('div', null,
            h(StateBadge, { value: statusValue }),
            h('div', { className: 'eq-row-sub' }, `${step.status?.accepted ?? 0}/${step.status?.total ?? 0} 单元`)),
          h('div', { className: 'eq-row-sub' }, `${module?.version ?? step.moduleVersion} · ${(step.params ? Object.keys(step.params).length : 0)} 参数`)),
        expanded ? h(ModuleDetail, { step, module, instance, onParam, onToggle }) : null)
    }

    function PlaybookView({ state, playbook, onRefresh, onAction, busy, toast }) {
      const [selected, setSelected] = useState(null)
      const [draft, setDraft] = useState(null)
      const [saving, setSaving] = useState(false)
      const compile = playbook?.compile
      const steps = state?.plan?.steps ?? []
      const modules = playbook?.modules ?? []
      const moduleMap = useMemo(() => new Map(modules.map((module) => [module.id, module])), [modules])
      const errors = compile?.errors ?? []
      const warnings = compile?.warnings ?? []
      useEffect(() => { if (playbook?.playbook) setDraft(JSON.parse(JSON.stringify(playbook.playbook))) }, [playbook])

      async function save() {
        if (!draft || !state) return
        setSaving(true)
        try {
          await api('/api/equity/playbook', { method: 'POST', body: JSON.stringify({ projectId: state.project.projectId, action: 'save', playbook: draft }) })
          await onRefresh()
        } catch (error) { toast(errorText(error), true) }
        finally { setSaving(false) }
      }

      async function applyPreset(name) {
        setSaving(true)
        try {
          await api('/api/equity/playbook', { method: 'POST', body: JSON.stringify({ projectId: state.project.projectId, action: 'apply', preset: name }) })
          await onRefresh()
        } catch (error) { toast(errorText(error), true) }
        finally { setSaving(false) }
      }

      function updateParam(instanceId, key, value) {
        setDraft((current) => {
          if (!current) return current
          const next = JSON.parse(JSON.stringify(current))
          const instance = next.modules.find((item) => item.id === instanceId)
          if (instance) {
            instance.params = instance.params ?? {}
            instance.params[key] = value
          }
          return next
        })
      }

      function toggle(instanceId) {
        setDraft((current) => {
          if (!current) return current
          const next = JSON.parse(JSON.stringify(current))
          const instance = next.modules.find((item) => item.id === instanceId)
          if (instance) instance.enabled = instance.enabled === false
          return next
        })
      }

      const toolbar = h('div', { className: 'eq-toolbar' },
        h('span', { className: 'eq-sub' }, `方案：${playbook?.playbook?.name ?? '—'} v${playbook?.playbook?.version ?? '—'} · ${steps.length} 个模块`),
        h('span', { style: { flex: 1 } }),
        h('select', {
          className: 'eq-select',
          defaultValue: playbook?.playbook?.preset ?? '',
          onChange: (event) => { if (event.target.value) applyPreset(event.target.value) },
          disabled: saving || busy,
        },
          h('option', { value: '' }, '切换预设…'),
          ...(playbook?.presets ?? []).map((preset) => h('option', { key: preset.name, value: preset.name }, `${preset.title}（${preset.moduleCount}）`))),
        h('button', { className: 'eq-btn sm', onClick: save, disabled: saving || busy || !draft }, saving ? '保存中…' : '保存方案'),
        h('button', { className: 'eq-btn sm primary', onClick: () => onAction('compile'), disabled: busy }, '编译'))

      const errorBanner = errors.length
        ? h('div', { className: 'eq-banner error' },
            h(Icon, { name: 'x', size: 14 }),
            h('div', null,
              h('b', null, `编译失败 ${errors.length} 项`),
              h('ul', { style: { margin: '4px 0 0', paddingLeft: 18 } }, errors.slice(0, 8).map((error, index) => h('li', { key: index }, `[${error.code}] ${error.message}`)))))
        : null

      const warningBanner = warnings.length
        ? h('div', { className: 'eq-banner warn' },
            h(Icon, { name: 'layers', size: 14 }),
            h('div', null, `编译警告 ${warnings.length} 项：${warnings.slice(0, 4).map((warning) => warning.message).join('；')}`))
        : null

      const rows = steps.map((step) => {
        const module = moduleMap.get(step.moduleId)
        const error = errors.find((item) => item.instanceId === step.instanceId)
        const instance = draft?.modules?.find((item) => item.id === step.instanceId)
        return h(ModuleRow, {
          key: step.instanceId,
          step,
          module,
          error,
          expanded: selected === step.instanceId,
          instance,
          onSelect: () => setSelected(selected === step.instanceId ? null : step.instanceId),
          onParam: updateParam,
          onToggle: toggle,
        })
      })

      const humanCount = modules.filter((module) => module.provenance?.origin === 'human').length
      const library = h(Section, { title: '模块库', sub: `${modules.length} 个内置/本地模块；未 stable 的为 draft，其中 ${humanCount} 个为人工实现` },
        h('div', { className: 'eq-list' },
          modules.map((module) => h('div', { key: module.id, className: 'eq-row' },
            h('span', { className: `eq-dot ${module.status === 'stable' ? 'green' : 'amber'}` }),
            h('div', { className: 'eq-row-main' },
              h('div', { className: 'eq-row-title' }, module.name, ' ',
                module.provenance?.origin === 'human'
                  ? h('span', {
                    className: 'eq-badge navy',
                    title: `人工实现 · 作者 ${module.provenance.author}${module.provenance.derivedFrom ? ` · 来源 ${module.provenance.derivedFrom}` : ''}`,
                  }, '人工实现')
                  : null,
                h('span', { className: 'eq-badge grey' }, module.status ?? 'draft')),
              h('div', { className: 'eq-row-sub' }, `${module.id} · ${KIND_LABEL[module.kind] ?? module.kind} · ${module.scope} · ${module.outputs?.map((output) => typeLabel(output.type)).join(' / ')}`)),
            h('span', { className: 'eq-pill' }, module.source ?? 'builtin')))))

      return h(React.Fragment, null,
        toolbar,
        errorBanner,
        warningBanner,
        h(Section, { title: '模块顺序与依赖', sub: '列表顺序只影响展示；计算顺序由硬输入推导' },
          h('div', { className: 'eq-list' }, rows.length ? rows : h('div', { className: 'eq-sub' }, '方案还没有模块。'))),
        library)
    }
    // ---------------------------------------------------------------------
    // Artifacts
    // ---------------------------------------------------------------------
    function ArtifactTable({ state, onOpen }) {
      const [type, setType] = useState('')
      const [status, setStatus] = useState('')
      const [search, setSearch] = useState('')
      const artifacts = state?.artifacts ?? []
      const types = useMemo(() => [...new Set(artifacts.map((artifact) => artifact.type))].sort(), [artifacts])
      const filtered = artifacts.filter((artifact) =>
        (!type || artifact.type === type) &&
        (!status || artifact.status === status) &&
        (!search || `${artifact.type} ${artifact.subjectId} ${artifact.partitionKey}`.toLowerCase().includes(search.toLowerCase())))
      return h(React.Fragment, null,
        h('div', { className: 'eq-toolbar' },
          h('input', { className: 'eq-search', placeholder: '搜索类型/主体/分区', value: search, onChange: (event) => setSearch(event.target.value) }),
          h('select', { className: 'eq-select', value: type, onChange: (event) => setType(event.target.value) },
            h('option', { value: '' }, '全部类型'), types.map((item) => h('option', { key: item, value: item }, typeLabel(item)))),
          h('select', { className: 'eq-select', value: status, onChange: (event) => setStatus(event.target.value) },
            h('option', { value: '' }, '全部状态'), ['draft', 'verified', 'stale', 'rejected'].map((item) => h('option', { key: item, value: item }, label(item)))),
          h('span', { className: 'eq-pill' }, `${filtered.length}/${artifacts.length}`)),
        h('div', { className: 'eq-table-wrap' },
          h('table', { className: 'eq-table' },
            h('thead', null, h('tr', null,
              ['类型', '主体', '分区', '状态', 'rev', 'asOf', '证据', '红旗', '更新'].map((header) => h('th', { key: header }, header)))),
            h('tbody', null,
              filtered.map((artifact) => h('tr', { key: artifact.id, style: { cursor: 'pointer' }, onClick: () => onOpen(artifact.id) },
                h('td', null, h('div', { className: 'eq-row-title' }, typeLabel(artifact.type)), h('div', { className: 'eq-row-sub mono' }, artifact.type)),
                h('td', null, subjectShort(artifact.subjectId)),
                h('td', { className: 'mono' }, artifact.partitionKey),
                h('td', null, h(StateBadge, { value: artifact.status })),
                h('td', { className: 'num' }, artifact.revision),
                h('td', { className: 'mono' }, artifact.asOf),
                h('td', { className: 'num' }, artifact.evidenceIds?.length ?? 0),
                h('td', { className: 'num' }, artifact.flags?.length ?? 0),
                h('td', { className: 'mono' }, timeShort(artifact.updatedAt)))))
            )))
    }

    function ArtifactDrawer({ projectId, artifactId, onClose, toast }) {
      const [data, setData] = useState(null)
      const [tab, setTab] = useState('data')
      const [evidenceId, setEvidenceId] = useState(null)
      const [loading, setLoading] = useState(true)
      useEffect(() => {
        let cancelled = false
        setLoading(true)
        api(`/api/equity/artifact?projectId=${encodeURIComponent(projectId)}&artifactId=${encodeURIComponent(artifactId)}`)
          .then((result) => { if (!cancelled) setData(result) })
          .catch((error) => toast(errorText(error), true))
          .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
      }, [projectId, artifactId, toast])
      if (!data) return h(Drawer, { title: '底稿', onClose }, h('div', { className: 'eq-sub' }, loading ? '加载中…' : '无法加载'))
      const artifact = data.artifact
      const claims = data.claims ?? []
      const evidence = data.evidence ?? []
      const claimRows = claims.map((claim) => h('tr', { key: claim.claimId },
        h('td', { className: 'mono' }, claim.claimId),
        h('td', null, claim.predicate),
        h('td', null, typeof claim.value === 'object' ? JSON.stringify(claim.value) : String(claim.value ?? '—')),
        h('td', null, h(StateBadge, { value: claim.status })),
        h('td', null, claim.materiality ?? 'context'),
        h('td', { className: 'mono' }, (claim.evidenceLinks ?? []).map((link) => link.evidenceId).join(', ') || '—')))
      const dataPanel = h('div', null,
        h('div', { className: 'eq-code' }, JSON.stringify(artifact.data, null, 2)),
        h('div', { className: 'eq-sep' }),
        h('div', { className: 'eq-grid2' },
          h('div', null, h('div', { className: 'eq-sub' }, 'contentHash'), h('div', { className: 'eq-mono', style: { fontSize: 10.5 } }, artifact.contentHash ?? '—')),
          h('div', null, h('div', { className: 'eq-sub' }, 'codeVersion'), h('div', { className: 'eq-mono', style: { fontSize: 10.5 } }, artifact.codeVersion ?? '—'))),
        h('div', { className: 'eq-sep' }),
        h('div', { className: 'eq-sub' }, '开放问题'),
        h('div', { className: 'eq-code' }, JSON.stringify(artifact.openQuestions ?? [], null, 2)))
      const claimsPanel = h('div', null,
        h('div', { className: 'eq-table-wrap' }, h('table', { className: 'eq-table' },
          h('thead', null, h('tr', null, ['claimId', 'predicate', 'value', 'status', 'materiality', '证据'].map((header) => h('th', { key: header }, header)))),
          h('tbody', null, claimRows))))
      const evidencePanel = h('div', null,
        evidence.length
          ? evidence.map((item) => h('div', { key: item.evidenceId, className: 'eq-evidence' },
              h('div', { className: 'eq-evidence-head' },
                h('span', { className: 'eq-evidence-title' }, item.title || item.url || item.evidenceId),
                h(StateBadge, { value: item.verificationStatus ?? 'unverified' })),
              h('div', { className: 'eq-sub eq-truncate' }, item.url ?? ''),
              item.quote ? h('div', { className: 'eq-quote' }, item.quote) : null,
              h('div', { className: 'eq-inline', style: { marginTop: 4 } },
                h('span', { className: 'eq-pill' }, item.sourceTier ?? 'media'),
                h('span', { className: 'eq-pill' }, `权威 ${item.sourceAuthority ?? '—'}`),
                h('span', { className: 'eq-pill' }, item.locator ?? '无定位'),
                h('button', { className: 'eq-btn ghost sm', onClick: () => setEvidenceId(item.evidenceId) }, '看原文'))))
          : h('div', { className: 'eq-sub' }, '该底稿没有证据记录。'))
      const lineagePanel = h('div', null,
        h('div', { className: 'eq-sub' }, '上游'),
        h('div', { className: 'eq-code' }, JSON.stringify(data.lineage?.upstream ?? [], null, 2)),
        h('div', { className: 'eq-sub', style: { marginTop: 8 } }, '下游'),
        h('div', { className: 'eq-code' }, JSON.stringify(data.lineage?.downstream ?? [], null, 2)))
      const checksPanel = h('div', null,
        h('div', { className: 'eq-sub' }, '门与检查'),
        h('div', { className: 'eq-code' }, JSON.stringify(artifact.checks ?? [], null, 2)),
        h('div', { className: 'eq-sub', style: { marginTop: 8 } }, '红旗'),
        h('div', { className: 'eq-list' }, (artifact.flags ?? []).map((flag, index) => h('div', { key: index, className: `eq-flag ${flag.level === 'material' ? 'material' : ''}` },
          h('div', null,
            h('div', { className: 'eq-flag-title' }, flag.rule ?? flag.triggerId ?? '红旗'),
            h('div', { className: 'eq-flag-desc' }, flag.desc),
            flag.action ? h('div', { className: 'eq-flag-action' }, flag.action) : null)))))
      const tabbar = h('div', { className: 'eq-tabbar' },
        [['data', '数据'], ['claims', `Claim ${claims.length}`], ['evidence', `证据 ${evidence.length}`], ['lineage', '血缘'], ['checks', '检查']].map(([key, text]) =>
          h('button', { key, className: tab === key ? 'active' : '', onClick: () => setTab(key) }, text)))
      const active = tab === 'claims' ? claimsPanel : tab === 'evidence' ? evidencePanel : tab === 'lineage' ? lineagePanel : tab === 'checks' ? checksPanel : dataPanel
      return h(Drawer, {
        title: `${typeLabel(artifact.type)} · ${subjectShort(artifact.subjectId)}`,
        subtitle: `${artifact.partitionKey} ｜ rev ${artifact.revision} ｜ ${label(artifact.status)} ｜ ${artifact.asOf}`,
        onClose,
        footer: h(React.Fragment, null,
          h('button', { className: 'eq-btn sm', onClick: () => navigator.clipboard?.writeText(artifact.id) }, '复制 id'),
          h('button', { className: 'eq-btn sm', onClick: onClose }, '关闭')),
      },
        tabbar,
        active,
        evidenceId ? h(EvidenceDrawer, { projectId, evidenceId, onClose: () => setEvidenceId(null), toast }) : null)
    }

    function EvidenceDrawer({ projectId, evidenceId, onClose, toast }) {
      const [data, setData] = useState(null)
      useEffect(() => {
        let cancelled = false
        api(`/api/equity/evidence?projectId=${encodeURIComponent(projectId)}&evidenceId=${encodeURIComponent(evidenceId)}`)
          .then((result) => { if (!cancelled) setData(result) })
          .catch((error) => toast(errorText(error), true))
        return () => { cancelled = true }
      }, [projectId, evidenceId, toast])
      if (!data) return h(Drawer, { title: '证据', onClose }, h('div', { className: 'eq-sub' }, '加载中…'))
      const evidence = data.evidence
      const body = h('div', { className: 'eq-list' },
        h('div', { className: 'eq-inline' },
          h('span', { className: 'eq-pill' }, evidence.evidenceId),
          h('span', { className: 'eq-pill' }, `权威 ${evidence.sourceAuthority ?? '—'}`),
          h('span', { className: 'eq-pill' }, evidence.locator ?? '无定位')),
        evidence.quote ? h('div', { className: 'eq-quote' }, evidence.quote) : null,
        h('div', { className: 'eq-sub' }, 'URL'),
        h('div', { className: 'eq-mono', style: { fontSize: 10.5, wordBreak: 'break-all' } }, evidence.url ?? '—'),
        h('div', { className: 'eq-sub' }, 'rawHash'),
        h('div', { className: 'eq-mono', style: { fontSize: 10.5 } }, evidence.rawHash ?? '—'),
        h('div', { className: 'eq-sub' }, '抓取时间'),
        h('div', { className: 'eq-mono', style: { fontSize: 10.5 } }, evidence.retrievedAt ?? '—'),
        h('div', { className: 'eq-sep' }),
        h('div', { className: 'eq-sub' }, '不可变原文快照'),
        h('div', { className: 'eq-code', style: { maxHeight: 380 } }, data.raw || '（无原文快照）'))
      return h(Drawer, {
        title: evidence.title || evidence.evidenceId,
        subtitle: `${evidence.sourceTier} ｜ ${evidence.verificationStatus} ｜ ${evidence.asOf ?? ''}`,
        onClose,
        footer: evidence.url ? h('a', { className: 'eq-btn sm', href: evidence.url, target: '_blank', rel: 'noreferrer' }, '打开来源') : null,
      }, body)
    }
    // ---------------------------------------------------------------------
    // Runs
    // ---------------------------------------------------------------------
    function RunsView({ state, onAction, busy, toast }) {
      const run = state?.latestRun
      const units = run?.units ?? []
      const steps = state?.plan?.steps ?? []
      const targets = state?.project?.targets ?? [{ name: '项目' }]
      async function action(name) {
        try { await onAction(name) } catch (error) { toast(errorText(error), true) }
      }

      const toolbar = h('div', { className: 'eq-toolbar' },
        h('span', { className: 'eq-sub' }, run ? `最近运行 ${run.runId} · ${label(run.status)} · ${timeShort(run.startedAt)}` : '还没有运行记录'),
        h('span', { style: { flex: 1 } }),
        h('button', { className: 'eq-btn sm primary', onClick: () => action('run'), disabled: busy || run?.status === 'running' }, run?.status === 'running' ? '运行中…' : '开始运行'),
        h('button', { className: 'eq-btn sm', onClick: () => action('pause'), disabled: busy || run?.status !== 'running' }, '暂停'),
        h('button', { className: 'eq-btn sm', onClick: () => action('resume'), disabled: busy || !run || run.status === 'running' }, '恢复/重试'),
        h('button', { className: 'eq-btn sm danger', onClick: () => action('cancel'), disabled: busy || run?.status !== 'running' }, '取消'))

      const summary = run
        ? h(Section, { title: '运行摘要', sub: `${run.executor} · 预算 ${fmtNum(run.budget?.usedTokens)} / ${fmtNum(run.budget?.maxTokens)} tokens` },
            h('div', { className: 'eq-kpis', style: { gridTemplateColumns: 'repeat(5,minmax(0,1fr))', marginBottom: 0 } },
              h(Kpi, { label: '状态', value: label(run.status), tone: tone(run.status) }),
              h(Kpi, { label: '单元', value: `${run.counts?.accepted ?? 0}/${run.counts?.total ?? 0}`, note: `失败 ${run.counts?.failed ?? 0} · 待人工 ${run.counts?.needsHuman ?? 0}`, tone: 'blue' }),
              h(Kpi, { label: 'tokens', value: fmtNum(run.budget?.usedTokens), note: run.budget?.maxTokens ? `上限 ${fmtNum(run.budget.maxTokens)}` : '无上限', tone: 'grey' }),
              h(Kpi, { label: '工具调用', value: fmtNum(run.budget?.usedToolCalls), note: '', tone: 'grey' }),
              h(Kpi, { label: '开始', value: timeShort(run.startedAt).slice(5), note: timeShort(run.finishedAt), tone: 'grey' })))
        : h(Empty, { title: '尚未运行', text: '先编译方案，再开始运行。private-agent 优先，不可用时自动回退 native-loop。', action: h('button', { className: 'eq-btn primary sm', onClick: () => action('run'), disabled: busy }, '开始运行') })

      const matrixRows = steps.map((step) => {
        const cells = targets.map((target) => {
          const unit = units.find((item) => item.instanceId === step.instanceId && (item.subjectName === target.name || item.subjectId === 'project'))
          const mark = unit?.status === 'accepted' ? '✓' : unit?.status === 'running' ? '…' : unit?.status === 'failed' || unit?.status === 'blocked' ? '!' : unit?.status === 'needs_human' ? '?' : '·'
          return h('td', { key: target.name, title: unit?.error ?? (unit ? label(unit.status) : '未运行') },
            h('span', { className: `eq-cell ${unit?.status ?? 'todo'}` }, mark))
        })
        return h('tr', { key: step.instanceId },
          h('td', null, h('div', { className: 'eq-row-title' }, step.name), h('div', { className: 'eq-row-sub' }, step.moduleId)),
          ...cells)
      })

      const matrix = run
        ? h(Section, { title: '单元矩阵', sub: '模块 × 目标；点单元格查看错误' },
            h('div', { className: 'eq-matrix' }, h('table', null,
              h('thead', null, h('tr', null,
                h('th', null, '模块'),
                ...targets.map((target) => h('th', { key: target.name }, target.name)))),
              h('tbody', null, matrixRows))))
        : null

      const problems = units.filter((unit) => ['failed', 'blocked', 'needs_human', 'cancelled'].includes(unit.status))
      const problemsSection = run
        ? h(Section, { title: '失败与待人工', sub: '按单元列出错误和下一步' },
            problems.length
              ? h('div', { className: 'eq-list' }, problems.map((unit) => h('div', { key: unit.unitId, className: 'eq-row' },
                  h('span', { className: `eq-dot ${unit.status === 'needs_human' ? 'amber' : 'red'}` }),
                  h('div', { className: 'eq-row-main' },
                    h('div', { className: 'eq-row-title' }, `${unit.moduleId} · ${unit.subjectName ?? unit.subjectId}`),
                    h('div', { className: 'eq-row-sub' }, unit.error ?? '')),
                  h(StateBadge, { value: unit.status }))))
              : h('div', { className: 'eq-sub' }, '没有失败/待人工单元。'))
        : null

      const history = (state?.runs ?? []).length > 1
        ? h(Section, { title: '运行历史', sub: '最近 20 次' },
            h('div', { className: 'eq-table-wrap' }, h('table', { className: 'eq-table' },
              h('thead', null, h('tr', null, ['runId', '状态', '执行器', '单元', '开始', '结束'].map((header) => h('th', { key: header }, header)))),
              h('tbody', null, state.runs.map((item) => h('tr', { key: item.runId },
                h('td', { className: 'mono' }, item.runId),
                h('td', null, h(StateBadge, { value: item.status })),
                h('td', null, item.executor),
                h('td', { className: 'num' }, `${item.counts?.accepted ?? 0}/${item.counts?.total ?? 0}`),
                h('td', { className: 'mono' }, timeShort(item.startedAt)),
                h('td', { className: 'mono' }, timeShort(item.finishedAt))))))))
        : null

      return h(React.Fragment, null, toolbar, summary, matrix, problemsSection, history)
    }
    // ---------------------------------------------------------------------
    // Delivery
    // ---------------------------------------------------------------------
    function DeliveryView({ state, onAction, busy, toast }) {
      const deliverable = state?.deliverable
      const data = deliverable?.data
      const files = data?.files ?? []
      const qa = data?.qa ?? null
      const [summary, setSummary] = useState(null)
      const [signoff, setSignoff] = useState({ preparedBy: 'equity-diligence', reviewedBy: '', approvedBy: '', note: '' })
      useEffect(() => {
        if (!state?.project?.projectId) return
        fetch(`/api/equity/file?projectId=${encodeURIComponent(state.project.projectId)}&path=${encodeURIComponent('01_管理层摘要.md')}`, { credentials: 'same-origin' })
          .then((response) => response.ok ? response.text() : '')
          .then((text) => setSummary(text || null))
          .catch(() => setSummary(null))
      }, [state?.project?.projectId, data?.generatedAt])
      async function build() {
        try { await onAction('build') } catch (error) { toast(errorText(error), true) }
      }
      async function verify() {
        try { await onAction('verify') } catch (error) { toast(errorText(error), true) }
      }
      async function present() {
        try { await onAction('present') } catch (error) { toast(errorText(error), true) }
      }
      async function sign() {
        try {
          await api('/api/equity/review', { method: 'POST', body: JSON.stringify({ projectId: state.project.projectId, action: 'signoff', ...signoff }) })
          toast('签发记录已保存')
          await onAction('refresh')
        } catch (error) { toast(errorText(error), true) }
      }
      function download(path) {
        window.open(`/api/equity/file?projectId=${encodeURIComponent(state.project.projectId)}&path=${encodeURIComponent(path)}`, '_blank')
      }
      return h(React.Fragment, null,
        h('div', { className: 'eq-toolbar' },
          h('span', { className: 'eq-sub' }, data ? `生成于 ${timeShort(data.generatedAt)} · ${files.length} 个文件` : '尚未构建交付包'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'eq-btn sm primary', onClick: build, disabled: busy }, '构建交付包'),
          h('button', { className: 'eq-btn sm', onClick: verify, disabled: busy || !deliverable }, '重新体检'),
          h('button', { className: 'eq-btn sm', onClick: present, disabled: busy || !deliverable }, '交付')),
        !deliverable ? h(Empty, { title: '还没有交付包', text: '运行完成后构建：管理层摘要 + 综合工作簿 + 7+N 专项 + 底稿 + 证据快照 + QA。', action: h('button', { className: 'eq-btn primary sm', onClick: build, disabled: busy }, '构建交付包') }) : null,
        deliverable ? h('div', { className: 'eq-grid2' },
          h(Section, { title: '体检单', sub: qa?.passed ? '通过：可进入签发' : '存在阻断项' },
            qa ? h('div', null,
              h('div', { className: `eq-banner ${qa.passed ? 'info' : 'error'}` }, h(Icon, { name: qa.passed ? 'check' : 'x', size: 14 }), h('div', null, qa.passed ? 'QA 通过' : `QA 阻断 ${qa.blocking?.length ?? 0} 项`, h('div', { className: 'eq-sub' }, `警告 ${qa.warnings?.length ?? 0} 项`))),
              h('div', { className: 'eq-list' },
                (qa.blocking ?? []).map((item, index) => h('div', { key: `b${index}`, className: 'eq-flag material' }, h('div', null, h('div', { className: 'eq-flag-title' }, item.id), h('div', { className: 'eq-flag-desc' }, item.message)))),
                (qa.warnings ?? []).slice(0, 8).map((item, index) => h('div', { key: `w${index}`, className: 'eq-flag' }, h('div', null, h('div', { className: 'eq-flag-title' }, item.id), h('div', { className: 'eq-flag-desc' }, item.message))))) ) : h('div', { className: 'eq-sub' }, '尚无体检结果'),
            h('div', { className: 'eq-sep' }),
            h('div', { className: 'eq-sub' }, '签发'),
            h('div', { className: 'eq-form' },
              h('div', { className: 'eq-field' }, h('label', null, 'preparedBy'), h('input', { className: 'eq-input', value: signoff.preparedBy, onChange: (event) => setSignoff({ ...signoff, preparedBy: event.target.value }) })),
              h('div', { className: 'eq-field' }, h('label', null, 'reviewedBy'), h('input', { className: 'eq-input', value: signoff.reviewedBy, onChange: (event) => setSignoff({ ...signoff, reviewedBy: event.target.value }) })),
              h('div', { className: 'eq-field' }, h('label', null, 'approvedBy'), h('input', { className: 'eq-input', value: signoff.approvedBy, onChange: (event) => setSignoff({ ...signoff, approvedBy: event.target.value }) })),
              h('div', { className: 'eq-field' }, h('label', null, 'note'), h('input', { className: 'eq-input', value: signoff.note, onChange: (event) => setSignoff({ ...signoff, note: event.target.value }) }))),
            h('div', { className: 'eq-inline', style: { marginTop: 8 } }, h('button', { className: 'eq-btn sm primary', onClick: sign, disabled: !qa?.passed }, '保存签发记录'), h('span', { className: 'eq-side-note' }, '签发是用户专属动作；Agent 只能提议。'))),
          h(Section, { title: '交付文件', sub: '点击下载/预览' },
            h('div', { className: 'eq-list' }, files.map((file) => h('div', { key: file.path, className: 'eq-file' },
              h(Icon, { name: 'doc', size: 15 }),
              h('div', { className: 'eq-file-name', title: file.path }, file.path),
              h('span', { className: 'eq-file-meta' }, `${file.kind} · ${fmtBytes(file.size)}`),
              h('span', { className: 'eq-file-meta mono' }, hashShort(file.sha256)),
              h('button', { className: 'eq-btn ghost sm', onClick: () => download(file.path) }, '下载'))))) ) : null,
        deliverable ? h(Section, { title: '管理层摘要预览', sub: '01_管理层摘要.md' },
          summary ? h('pre', { className: 'eq-pre', style: { maxHeight: 520, overflow: 'auto' } }, summary) : h('div', { className: 'eq-sub' }, '摘要尚未生成或不可读。')) : null
      )
    }

    // ---------------------------------------------------------------------
    // Create project
    // ---------------------------------------------------------------------
    function CreateProject({ onCreated, busy, toast }) {
      const [form, setForm] = useState({ target: '', code: '', clientName: '', preset: 'standard', asOf: new Date().toISOString().slice(0, 10), root: '' })
      const [saving, setSaving] = useState(false)
      async function submit(event) {
        event.preventDefault()
        if (!form.target.trim()) return
        setSaving(true)
        try {
          const payload = { action: 'create', ...form }
          if (!String(payload.root ?? '').trim()) delete payload.root
          const result = await api('/api/equity/project', { method: 'POST', body: JSON.stringify(payload) })
          onCreated(result.project)
        } catch (error) { toast(errorText(error), true) }
        finally { setSaving(false) }
      }
      return h('section', { className: 'eq-section', style: { maxWidth: 760 } },
        h('div', { className: 'eq-section-head' }, h('div', { className: 'eq-section-title' }, '新建调查项目'), h('div', { className: 'eq-section-sub' }, '填公司名即可开始；其余用默认值')),
        h('div', { className: 'eq-section-body' },
          h('form', { onSubmit: submit },
            h('div', { className: 'eq-form' },
              h('div', { className: 'eq-field' }, h('label', null, '目标公司 *'), h('input', { className: 'eq-input', value: form.target, onChange: (event) => setForm({ ...form, target: event.target.value }), placeholder: '例如：中际旭创' })),
              h('div', { className: 'eq-field' }, h('label', null, '证券代码/信用代码'), h('input', { className: 'eq-input', value: form.code, onChange: (event) => setForm({ ...form, code: event.target.value }), placeholder: '300308' })),
              h('div', { className: 'eq-field' }, h('label', null, '委托方'), h('input', { className: 'eq-input', value: form.clientName, onChange: (event) => setForm({ ...form, clientName: event.target.value }) })),
              h('div', { className: 'eq-field' }, h('label', null, '截止日'), h('input', { className: 'eq-input', type: 'date', value: form.asOf, onChange: (event) => setForm({ ...form, asOf: event.target.value }) })),
              h('div', { className: 'eq-field' }, h('label', null, '预设'), h('select', { className: 'eq-select', value: form.preset, onChange: (event) => setForm({ ...form, preset: event.target.value }) },
                h('option', { value: 'skill-only' }, 'skill-only · 旧资产闭环（4）'),
                h('option', { value: 'quick' }, 'quick · 48 小时初筛（10）'),
                h('option', { value: 'standard' }, 'standard · 标准尽调（18）'),
                h('option', { value: 'deep' }, 'deep · 深度（24）'),
                h('option', { value: 'generic' }, 'generic · 通用兜底（3）'))),
              h('div', { className: 'eq-field' }, h('label', null, '项目目录（可选）'), h('input', { className: 'eq-input', value: form.root, onChange: (event) => setForm({ ...form, root: event.target.value }), placeholder: '默认 workspace/equity-projects/<slug>' }))),
            h('div', { className: 'eq-inline', style: { marginTop: 14 } },
              h('button', { className: 'eq-btn primary', type: 'submit', disabled: saving || busy }, saving ? '创建中…' : '创建并编译'),
              h('span', { className: 'eq-side-note' }, '创建后会在项目目录写 project.json、playbook.yaml、.equity/ 底稿仓库。')))
        ))
    }

    // ---------------------------------------------------------------------
    // Main workbench
    // ---------------------------------------------------------------------
    function EquityWorkbench() {
      const { projects, refresh: refreshProjects } = useProjects()
      const [projectId, setProjectId] = useState(null)
      const [tab, setTab] = useState('overview')
      const [toastState, setToast] = useState(null)
      const [busy, setBusy] = useState(false)
      const [artifact, setArtifact] = useState(null)
      const { state, refresh: refreshState } = useProjectState(projectId)
      const { data: playbook, refresh: refreshPlaybook } = usePlaybook(projectId)
      const toast = useCallback((text, isError = false) => {
        setToast({ text, isError })
        setTimeout(() => setToast(null), 4200)
      }, [])
      useEffect(() => {
        if (!projectId && projects.length > 0) setProjectId(projects[0].projectId)
      }, [projects, projectId])

      const refreshAll = useCallback(async () => {
        await refreshState()
        await refreshPlaybook()
        await refreshProjects()
      }, [refreshState, refreshPlaybook, refreshProjects])

      async function createProject(result) {
        await refreshProjects()
        if (result?.projectId) setProjectId(result.projectId)
        setTab('overview')
      }

      async function runAction(name) {
        if (!state) return
        setBusy(true)
        try {
          if (name === 'compile') {
            const result = await api('/api/equity/playbook', { method: 'POST', body: JSON.stringify({ projectId: state.project.projectId, action: 'compile' }) })
            if (!result.compile?.ok) toast(`编译失败：${result.compile?.errors?.[0]?.message ?? ''}`, true)
            else toast('编译通过')
            await refreshAll()
          } else if (name === 'run') {
            const result = await api('/api/equity/run', { method: 'POST', body: JSON.stringify({ projectId: state.project.projectId, action: 'start', mode: 'playbook' }) })
            toast(`已启动 ${result.run?.runId ?? '运行'}`)
            setTab('runs')
            await refreshAll()
          } else if (name === 'pause') {
            await api('/api/equity/run', { method: 'POST', body: JSON.stringify({ projectId: state.project.projectId, action: 'pause', runId: state.latestRun?.runId }) })
            toast('已请求暂停')
            await refreshAll()
          } else if (name === 'cancel') {
            await api('/api/equity/run', { method: 'POST', body: JSON.stringify({ projectId: state.project.projectId, action: 'cancel', runId: state.latestRun?.runId }) })
            toast('已请求取消')
            await refreshAll()
          } else if (name === 'resume') {
            const result = await api('/api/equity/run', { method: 'POST', body: JSON.stringify({ projectId: state.project.projectId, action: 'resume', runId: state.latestRun?.runId }) })
            toast(`已恢复 ${result.run?.runId ?? ''}`)
            setTab('runs')
            await refreshAll()
          } else if (name === 'build' || name === 'verify') {
            const result = await api('/api/equity/deliver', { method: 'POST', body: JSON.stringify({ projectId: state.project.projectId, action: 'build' }) })
            toast(result.result?.qa?.passed ? '交付体检通过' : `交付体检未通过：${result.result?.qa?.blocking?.[0]?.message ?? ''}`, !result.result?.qa?.passed)
            setTab('deliver')
            await refreshAll()
          } else if (name === 'present') {
            toast('文件已生成；请用会话中的 present 工具或“下载”按钮交付。')
          } else if (name === 'refresh') {
            await refreshAll()
          } else if (name === 'issues' || name === 'rerun_stale') {
            setTab('runs')
          }
        } catch (error) {
          toast(errorText(error), true)
        } finally {
          setBusy(false)
        }
      }

      const projectOptions = projects.map((project) => h('option', { key: project.projectId, value: project.projectId }, `${project.name}（${project.preset}）`))
      const projectButtons = projects.map((project) => h('button', {
        key: project.projectId,
        className: `eq-project ${project.projectId === projectId ? 'active' : ''}`,
        onClick: () => setProjectId(project.projectId),
      },
        h('span', { className: `eq-dot ${project.status === 'archived' ? 'grey' : 'green'}` }),
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'eq-project-name' }, project.name),
          h('div', { className: 'eq-project-meta' },
            h('span', null, project.preset ?? '—'),
            h('span', null, timeShort(project.updatedAt).slice(5))))))

      const topbar = h('div', { className: 'eq-top' },
        h('div', { className: 'eq-brand' },
          h('div', { className: 'eq-mark' }, 'EQ'),
          h('div', null,
            h('div', { className: 'eq-brand-title' }, '一级市场调查工作台'),
            h('div', { className: 'eq-brand-sub' }, 'Public-market pre-DD workbench'))),
        state
          ? h('select', { className: 'eq-select', style: { maxWidth: 230 }, value: projectId ?? '', onChange: (event) => setProjectId(event.target.value) }, projectOptions)
          : null,
        state ? h('span', { className: 'eq-chip' }, '截至 ', h('b', null, state.project.engagement?.asOf ?? '—')) : null,
        state ? h('span', { className: 'eq-chip' }, '委托方 ', h('b', null, state.project.engagement?.clientName ?? '—')) : null,
        state ? h('span', { className: 'eq-chip' }, '币种 ', h('b', null, state.project.engagement?.currency ?? 'CNY')) : null,
        state ? h('span', { className: `eq-badge ${tone(state.latestRun?.status ?? 'draft')}` }, state.latestRun ? label(state.latestRun.status) : '未运行') : null,
        h('div', { className: 'eq-top-spacer' }),
        h('button', { className: 'eq-btn ghost sm', onClick: () => runAction('refresh'), disabled: busy }, h(Icon, { name: 'refresh', size: 13 }), '刷新'),
        h('button', { className: 'eq-btn sm', onClick: () => setTab('playbook'), disabled: !state }, '方案'),
        h('button', { className: 'eq-btn primary sm', onClick: () => { setProjectId(null); setTab('new') } }, h(Icon, { name: 'plus', size: 13 }), '新建调查'))

      const rail = h('aside', { className: 'eq-rail' },
        h('div', { className: 'eq-rail-head' }, h('span', null, '项目'), h('span', null, `${projects.length}`)),
        h('div', { className: 'eq-rail-list' },
          projectButtons,
          projects.length === 0 ? h('div', { className: 'eq-side-note', style: { padding: '12px 8px' } }, '还没有项目。点“新建调查”。') : null),
        h('div', { className: 'eq-rail-foot' },
          h('button', { className: 'eq-btn primary', style: { width: '100%' }, onClick: () => { setProjectId(null); setTab('new') } }, h(Icon, { name: 'plus', size: 13 }), '新建调查'),
          h('div', { className: 'eq-side-note', style: { marginTop: 8 } }, '证据优先 · 底稿可追溯 · 交付可体检')))

      const tabs = [
        ['overview', '总览', null],
        ['playbook', '方案', state?.plan?.steps?.length ?? 0],
        ['artifacts', '底稿', state?.counts?.total ?? 0],
        ['runs', '运行', state?.latestRun?.counts?.total ?? 0],
        ['deliver', '交付', state?.deliverable ? 1 : 0],
      ]
      const tabbar = state
        ? h('nav', { className: 'eq-tabs' }, tabs.map(([key, text, count]) => h('button', {
            key,
            className: `eq-tab ${tab === key ? 'active' : ''}`,
            onClick: () => setTab(key),
          }, text, count ? h('span', { className: 'eq-count' }, count) : null)))
        : null
      const content = []
      if (tab === 'new') content.push(h(CreateProject, { key: 'new', onCreated: createProject, busy, toast }))
      if (!state && tab !== 'new') content.push(h(Empty, { key: 'empty', title: '选择一个项目', text: '左侧选择已有项目，或新建调查。', action: h('button', { className: 'eq-btn primary sm', onClick: () => setTab('new') }, '新建调查') }))
      if (state && tab === 'overview') content.push(h(Overview, { key: 'overview', state, onTab: setTab, onAction: runAction, busy }))
      if (state && tab === 'playbook') content.push(h(PlaybookView, { key: 'playbook', state, playbook, onRefresh: refreshAll, onAction: runAction, busy, toast }))
      if (state && tab === 'artifacts') content.push(h(ArtifactTable, { key: 'artifacts', state, onOpen: setArtifact }))
      if (state && tab === 'runs') content.push(h(RunsView, { key: 'runs', state, onAction: runAction, busy, toast }))
      if (state && tab === 'deliver') content.push(h(DeliveryView, { key: 'deliver', state, onAction: runAction, busy, toast }))
      const main = h('main', { className: 'eq-main' }, tabbar, h('div', { className: 'eq-scroll' }, content))

      return h('div', { className: 'eq-root' },
        h('style', null, CSS),
        topbar,
        h('div', { className: 'eq-body' }, rail, main),
        artifact ? h(ArtifactDrawer, { projectId, artifactId: artifact, onClose: () => setArtifact(null), toast }) : null,
        toastState ? h('div', { className: `eq-toast ${toastState.isError ? 'error' : ''}`, role: 'status' }, toastState.text) : null)
    }
    // ---------------------------------------------------------------------
    // Sidebar icon + conversation card
    // ---------------------------------------------------------------------
    function EquityPanelIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 64 64', 'aria-hidden': true },
        h('rect', { width: 64, height: 64, rx: 14, fill: '#1F4E79' }),
        h('path', { d: 'M16 44V22h9.5c7 0 11.5 4.2 11.5 11s-4.5 11-11.5 11H16Zm6-5h3.2c3.6 0 5.8-2.2 5.8-6s-2.2-6-5.8-6H22v12Z', fill: '#fff' }),
        h('path', { d: 'M42 22h7l-8 11 8 11h-7l-5-7-2 3v4h-5V22h5v9l7-9Z', fill: '#BDD7EE' }))
    }

    function EquityTurnTail() {
      const [data, setData] = useState(null)
      useEffect(() => {
        let cancelled = false
        api('/api/equity/projects')
          .then(async (projects) => {
            const first = projects.projects?.[0]
            if (!first) return
            const state = await api(`/api/equity/state?projectId=${encodeURIComponent(first.projectId)}`)
            if (!cancelled) setData(state.state)
          })
          .catch(() => {})
        return () => { cancelled = true }
      }, [])
      if (!data) return null
      const counts = data.counts ?? {}
      const status = data.latestRun?.status ?? 'draft'
      return h('div', {
        style: {
          margin: '8px 0', border: '1px solid var(--dsw-alias-border-l1, #e2e8f0)', borderRadius: 8,
          background: 'var(--dsw-alias-bg-layer-1, #fff)', padding: '8px 10px', display: 'flex',
          alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--dsw-alias-label-primary, #172033)',
        },
      },
        h('span', { style: { width: 24, height: 24, borderRadius: 6, background: '#1F4E79', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 700 } }, 'EQ'),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `一级市场调查 · ${data.project.name}`),
          h('div', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary, #8a94a6)' } }, `底稿 ${counts.total ?? 0} ｜ 运行 ${label(status)} ｜ 红旗 ${data.redflags?.length ?? 0}`)),
        h('button', {
          onClick: () => { try { pluginCtx?.layout?.selectPanel(PANEL_ID) } catch { /* ignore */ } },
          style: { height: 26, padding: '0 9px', borderRadius: 6, border: '1px solid #1F4E79', background: '#1F4E79', color: '#fff', fontSize: 11.5, cursor: 'pointer' },
        }, '打开工作台'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, EquityWorkbench))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => '一级市场调查',
        }, EquityPanelIcon))
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'equity-status',
          order: 30,
        }, EquityTurnTail))
      },
    }
  },
})
