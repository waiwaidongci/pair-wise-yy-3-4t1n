import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "core-slices.json");
const port = Number(process.env.PORT || 3025);
const statuses = ["待切割", "制片中", "待观察", "已交付"];
const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];
const DAY = 24 * 60 * 60 * 1000;
const REVIEW_WINDOW_DAYS = 30;

const seed = {
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      custodian: "赵岩",
      retentionUntil: "2026-10-20",
      status: "制片中",
      delivery: "未交付",
      loan: null,
      rechecks: [
        { id: "RC-1", by: "东岭矿业质检所", note: "铜品位复测", status: "进行中", startedAt: "2026-09-20T09:00:00.000Z", endedAt: null }
      ],
      history: [
        { at: "2026-06-12T10:00:00.000Z", text: "建档入库，保存截止 2026-10-20" },
        { at: "2026-09-20T09:00:00.000Z", text: "东岭矿业质检所 发起复检：铜品位复测" }
      ],
      slices: [
        { id: "SL-001-A", method: "茜素红染色", observation: "", status: "研磨", logs: [{ at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" }, { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }] }
      ]
    }
  ],
  destroyed: []
};

function normalize(db) {
  db.samples = (db.samples || []).map(sample => ({ custodian: "", retentionUntil: "", loan: null, rechecks: [], history: [], ...sample }));
  db.destroyed = db.destroyed || [];
  return db;
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return normalize(JSON.parse(await readFile(dbPath, "utf8")));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function updateSampleStatus(sample) {
  const sliceStatuses = sample.slices.map(slice => slice.status);
  if (sliceStatuses.length && sliceStatuses.every(step => step === "观察")) sample.status = "待观察";
  if (sample.delivery === "已交付") sample.status = "已交付";
  else if (sliceStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) sample.status = "制片中";
  else sample.status = "待切割";
}

function daysLeft(sample, now = new Date()) {
  if (!sample.retentionUntil) return null;
  const end = new Date(sample.retentionUntil + "T00:00:00");
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((end - today) / DAY);
}
function reviewState(sample) {
  const left = daysLeft(sample);
  if (left === null) return "未设期限";
  if (left <= 0) return "已到期";
  if (left <= REVIEW_WINDOW_DAYS) return "待复核";
  return "在库";
}
function blockers(sample) {
  const list = [];
  if (sample.loan && sample.loan.active) list.push(`借阅中（${sample.loan.borrower}）`);
  const unfinished = sample.slices.filter(slice => slice.status !== "观察");
  if (unfinished.length) list.push(`切片未完成（${unfinished.map(slice => slice.id).join("、")}）`);
  const openRechecks = sample.rechecks.filter(recheck => recheck.status === "进行中");
  if (openRechecks.length) list.push(`复检未结束（${openRechecks.map(recheck => recheck.by).join("、")}）`);
  return list;
}
function lastActivity(sample) {
  const events = sample.history.map(item => ({ at: item.at, text: item.text }));
  for (const slice of sample.slices) {
    for (const log of slice.logs) events.push({ at: log.at, text: `${slice.id} ${log.step}：${log.note || "完成"}` });
  }
  events.sort((a, b) => (a.at < b.at ? 1 : -1));
  return events[0] || null;
}
function present(sample) {
  const left = daysLeft(sample);
  const blocks = blockers(sample);
  return {
    ...sample,
    daysLeft: left,
    reviewState: reviewState(sample),
    blockers: blocks,
    canDestroy: left !== null && left <= REVIEW_WINDOW_DAYS && blocks.length === 0,
    lastActivity: lastActivity(sample)
  };
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --stone:#73706a; --warn:#8a6d1f; --warn-bg:#fdf3e3; --warn-line:#e4c98f; --due:#8f2f2f; --due-bg:#fbe4e4; --due-line:#e0a3a3; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.warn { background:var(--warn-bg); border-color:var(--warn-line); color:var(--warn); }
    .pill.due { background:var(--due-bg); border-color:var(--due-line); color:var(--due); }
    .blockers { color:var(--due); font-size:13px; } .ok { color:var(--accent); font-size:13px; font-weight:700; }
    .slice { border-top:1px solid var(--line); padding-top:10px; } .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
    .row { display:flex; gap:8px; } .row input { flex:1; }
    .destroy { border-top:1px dashed var(--due-line); padding-top:10px; display:grid; gap:8px; }
    .destroy button { background:var(--due); }
    .section-title { margin:20px 0 12px; }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header><div><h1>岩芯样本切片实验室</h1><div class="meta">样本、切片任务、保存期复核与离库销毁见证</div></div><button id="reload">刷新</button></header>
  <main>
    <form id="form">
      <h2>创建岩芯样本</h2>
      <label>项目</label><input name="project" required>
      <label>钻孔编号</label><input name="borehole" required>
      <label>岩芯箱号</label><input name="coreBox" required>
      <label>取样深度</label><input name="depth" required>
      <label>负责人</label><input name="owner" required>
      <label>保管人</label><input name="custodian" required>
      <label>保存截止日</label><input name="retentionUntil" type="date" required>
      <label>初始切片编号</label><input name="sliceId" required>
      <label>染色方法</label><input name="method" required>
      <button>保存样本</button>
    </form>
    <section>
      <div class="stats" id="stats"></div>
      <div class="grid" id="samples"></div>
      <h2 class="section-title">销毁凭证与存档</h2>
      <div class="grid" id="archived"></div>
    </section>
  </main>
  <script>
    const statuses = ${JSON.stringify(statuses)};
    const steps = ${JSON.stringify(taskSteps)};
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    const archivedEl = document.querySelector("#archived");
    let samples = [];
    let destroyed = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function fmt(at) { return at ? new Date(at).toLocaleString("zh-CN", { hour12:false }) : ""; }
    function leftText(sample) {
      if (sample.daysLeft === null) return "未设保存期限";
      if (sample.daysLeft <= 0) return "已到期 " + Math.abs(sample.daysLeft) + " 天";
      return "剩余 " + sample.daysLeft + " 天";
    }
    function reviewClass(sample) {
      if (sample.reviewState === "已到期") return "due";
      if (sample.reviewState === "待复核") return "warn";
      return "";
    }
    function render() {
      const reviewCount = samples.filter(item => item.reviewState === "待复核" || item.reviewState === "已到期").length;
      stats.innerHTML = statuses.map(s => '<div class="stat"><span>'+s+'</span><strong>'+samples.filter(item => item.status === s).length+'</strong></div>').join("")
        + '<div class="stat"><span>待复核/到期</span><strong>'+reviewCount+'</strong></div>'
        + '<div class="stat"><span>已销毁</span><strong>'+destroyed.length+'</strong></div>';
      samplesEl.innerHTML = samples.map(sample => {
        const blockHtml = sample.blockers.length
          ? '<div class="blockers">阻断原因：' + sample.blockers.join("；") + '</div>'
          : '<div class="ok">无阻断，可排入销毁</div>';
        const last = sample.lastActivity ? '<div class="meta">最近处理：' + sample.lastActivity.text + '（' + fmt(sample.lastActivity.at) + '）</div>' : "";
        const loan = sample.loan && sample.loan.active
          ? '<div class="meta">借阅中：' + sample.loan.borrower + '（' + fmt(sample.loan.since) + ' 起）</div><button data-return="' + sample.id + '">登记归还</button>'
          : '<div class="row"><input data-borrower="' + sample.id + '" placeholder="借阅人"><button data-loan="' + sample.id + '">登记借阅</button></div>';
        const rechecks = sample.rechecks.map(r =>
          '<div class="meta">复检 ' + r.by + ' · ' + r.status + (r.note ? ' · ' + r.note : '') + (r.status === "进行中" ? ' <button data-close-recheck="' + sample.id + '|' + r.id + '">结束复检</button>' : '') + '</div>'
        ).join("") + '<div class="row"><input data-recheck-by="' + sample.id + '" placeholder="复检方/合作方"><input data-recheck-note="' + sample.id + '" placeholder="复检事项"><button data-recheck="' + sample.id + '">开始复检</button></div>';
        const slices = sample.slices.map(slice => '<div class="slice"><b>'+slice.id+'</b><div class="meta">'+slice.method+' · 当前步骤 '+slice.status+'</div><select data-step="'+sample.id+'|'+slice.id+'">'+steps.map(step => '<option>'+step+'</option>').join("")+'</select><textarea data-note="'+sample.id+'|'+slice.id+'" placeholder="步骤备注或观察结果"></textarea><button data-log="'+sample.id+'|'+slice.id+'">记录步骤</button><div class="meta">'+slice.logs.map(log => log.step+"："+log.note).join(" / ")+'</div></div>').join("");
        const destroy = '<div class="destroy"><label>销毁见证（两人现场核对编号与方式，销毁后移出可用样本）</label>'
          + '<div class="row"><input data-w1="' + sample.id + '" placeholder="见证人甲"><input data-w2="' + sample.id + '" placeholder="见证人乙"></div>'
          + '<div class="row"><input data-dmethod="' + sample.id + '" placeholder="销毁方式（如 破碎深埋）"><button data-destroy="' + sample.id + '"' + (sample.canDestroy ? "" : " disabled") + '>确认销毁出库</button></div></div>';
        return '<article class="card"><h3>'+sample.project+'</h3><div><span class="pill">'+sample.status+'</span> <span class="pill '+reviewClass(sample)+'">'+sample.reviewState+'</span></div>'
          + '<div class="meta">'+sample.borehole+' · '+sample.coreBox+' · '+sample.depth+' · 负责人 '+sample.owner+'</div>'
          + '<div class="meta">保管人 '+(sample.custodian || "未登记")+' · 保存截止 '+(sample.retentionUntil || "未设定")+' · '+leftText(sample)+'</div>'
          + blockHtml + last
          + '<label>新增切片</label><input data-new-slice="'+sample.id+'" placeholder="切片编号"><input data-method="'+sample.id+'" placeholder="染色方法"><button data-add="'+sample.id+'">添加切片</button>'
          + slices
          + '<label>借阅与复检</label>' + loan + rechecks
          + '<button data-deliver="'+sample.id+'">标记交付</button>'
          + destroy
          + '</article>';
      }).join("");
      archivedEl.innerHTML = destroyed.length ? destroyed.map(item =>
        '<article class="card"><h3>'+item.project+'（'+item.id+'）</h3><span class="pill due">已销毁</span>'
        + '<div class="meta">凭证 '+item.destruction.certId+' · '+fmt(item.destruction.at)+'</div>'
        + '<div class="meta">方式 '+item.destruction.method+' · 见证 '+item.destruction.witnesses.join("、")+' · 保管人 '+(item.custodian || "未登记")+'</div>'
        + item.slices.map(slice => '<div class="slice"><b>'+slice.id+'</b><div class="meta">'+slice.method+' · 止步于 '+slice.status+'</div><div class="meta">'+slice.logs.map(log => log.step+"："+log.note).join(" / ")+'</div></div>').join("")
        + '</article>'
      ).join("") : '<div class="meta">暂无销毁记录</div>';
      document.querySelectorAll("[data-step]").forEach(sel => {
        const [sampleId, sliceId] = sel.dataset.step.split("|");
        const slice = samples.find(s => s.id === sampleId).slices.find(s => s.id === sliceId);
        sel.value = slice.status;
      });
      document.querySelectorAll("[data-add]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.add;
        await api('/api/samples/'+id+'/slices', { method:'POST', body: JSON.stringify({ id: document.querySelector('[data-new-slice="'+id+'"]').value, method: document.querySelector('[data-method="'+id+'"]').value || "未指定" }) });
        await load();
      });
      document.querySelectorAll("[data-log]").forEach(btn => btn.onclick = async () => {
        const [sampleId, sliceId] = btn.dataset.log.split("|");
        await api('/api/samples/'+sampleId+'/slices/'+sliceId+'/logs', { method:'POST', body: JSON.stringify({ step: document.querySelector('[data-step="'+sampleId+'|'+sliceId+'"]').value, note: document.querySelector('[data-note="'+sampleId+'|'+sliceId+'"]').value || "步骤完成" }) });
        await load();
      });
      document.querySelectorAll("[data-deliver]").forEach(btn => btn.onclick = async () => { await api('/api/samples/'+btn.dataset.deliver+'/deliver', { method:'POST', body: JSON.stringify({}) }); await load(); });
      document.querySelectorAll("[data-loan]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.loan;
        try {
          await api('/api/samples/'+id+'/loan', { method:'POST', body: JSON.stringify({ borrower: document.querySelector('[data-borrower="'+id+'"]').value.trim() }) });
          await load();
        } catch (error) { alert(error.message); }
      });
      document.querySelectorAll("[data-return]").forEach(btn => btn.onclick = async () => { await api('/api/samples/'+btn.dataset.return+'/return', { method:'POST', body: JSON.stringify({}) }); await load(); });
      document.querySelectorAll("[data-recheck]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.recheck;
        try {
          await api('/api/samples/'+id+'/rechecks', { method:'POST', body: JSON.stringify({ by: document.querySelector('[data-recheck-by="'+id+'"]').value.trim(), note: document.querySelector('[data-recheck-note="'+id+'"]').value.trim() }) });
          await load();
        } catch (error) { alert(error.message); }
      });
      document.querySelectorAll("[data-close-recheck]").forEach(btn => btn.onclick = async () => {
        const [sampleId, recheckId] = btn.dataset.closeRecheck.split("|");
        await api('/api/samples/'+sampleId+'/rechecks/'+recheckId+'/close', { method:'POST', body: JSON.stringify({}) });
        await load();
      });
      document.querySelectorAll("[data-destroy]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.destroy;
        const witnesses = [document.querySelector('[data-w1="'+id+'"]').value.trim(), document.querySelector('[data-w2="'+id+'"]').value.trim()];
        const method = document.querySelector('[data-dmethod="'+id+'"]').value.trim();
        if (!confirm("确认由 " + witnesses.join("、") + " 现场见证，按「" + method + "」销毁 " + id + "？")) return;
        try {
          await api('/api/samples/'+id+'/destroy', { method:'POST', body: JSON.stringify({ method, witnesses }) });
          await load();
        } catch (error) { alert(error.message); }
      });
    }
    async function load(){
      [samples, destroyed] = await Promise.all([api("/api/samples"), api("/api/destroyed")]);
      render();
    }
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/samples", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load();
    };
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/samples") return sendJson(res, 200, db.samples.map(present));
    if (req.method === "GET" && url.pathname === "/api/destroyed") return sendJson(res, 200, db.destroyed);
    if (req.method === "POST" && url.pathname === "/api/samples") {
      const input = await body(req);
      const now = new Date().toISOString();
      const sample = {
        id: `CORE-${Date.now()}`,
        project: input.project,
        borehole: input.borehole,
        coreBox: input.coreBox,
        depth: input.depth,
        owner: input.owner,
        custodian: input.custodian || "",
        retentionUntil: input.retentionUntil || "",
        status: "待切割",
        delivery: "未交付",
        loan: null,
        rechecks: [],
        history: [{ at: now, text: `建档入库，保管人 ${input.custodian || "未登记"}，保存截止 ${input.retentionUntil || "未设定"}` }],
        slices: [{ id: input.sliceId, method: input.method, observation: "", status: "取样", logs: [{ at: now, step: "取样", note: "创建初始切片任务" }] }]
      };
      updateSampleStatus(sample);
      db.samples.unshift(sample);
      await saveDb(db);
      return sendJson(res, 201, present(sample));
    }
    const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      const sample = db.samples.find(item => item.id === addSlice[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      sample.slices.push({ id: input.id, method: input.method || "未指定", observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "新增切片任务" }] });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 201, present(sample));
    }
    const logMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === logMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === logMatch[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      const input = await body(req);
      slice.status = input.step;
      if (input.step === "观察") slice.observation = input.note || slice.observation;
      slice.logs.push({ at: new Date().toISOString(), step: input.step, note: input.note || "" });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, present(sample));
    }
    const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === deliverMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      sample.delivery = "已交付";
      sample.history.push({ at: new Date().toISOString(), text: "标记交付" });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, present(sample));
    }
    const loanMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/loan$/);
    if (loanMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === loanMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      if (!input.borrower || !String(input.borrower).trim()) return sendJson(res, 400, { error: "缺少借阅人" });
      if (sample.loan && sample.loan.active) return sendJson(res, 409, { error: "样本已在借阅中" });
      const now = new Date().toISOString();
      sample.loan = { active: true, borrower: String(input.borrower).trim(), since: now };
      sample.history.push({ at: now, text: `借阅给 ${sample.loan.borrower}` });
      await saveDb(db);
      return sendJson(res, 200, present(sample));
    }
    const returnMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/return$/);
    if (returnMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === returnMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      if (!sample.loan || !sample.loan.active) return sendJson(res, 409, { error: "样本不在借阅中" });
      const now = new Date().toISOString();
      sample.history.push({ at: now, text: `借阅归还（${sample.loan.borrower}）` });
      sample.loan = { ...sample.loan, active: false, returnedAt: now };
      await saveDb(db);
      return sendJson(res, 200, present(sample));
    }
    const recheckMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/rechecks$/);
    if (recheckMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === recheckMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      if (!input.by || !String(input.by).trim()) return sendJson(res, 400, { error: "缺少复检方" });
      const now = new Date().toISOString();
      const recheck = { id: `RC-${Date.now()}`, by: String(input.by).trim(), note: String(input.note || "").trim(), status: "进行中", startedAt: now, endedAt: null };
      sample.rechecks.push(recheck);
      sample.history.push({ at: now, text: `${recheck.by} 发起复检${recheck.note ? "：" + recheck.note : ""}` });
      await saveDb(db);
      return sendJson(res, 201, present(sample));
    }
    const closeRecheckMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/rechecks\/([^/]+)\/close$/);
    if (closeRecheckMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === closeRecheckMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const recheck = sample.rechecks.find(item => item.id === closeRecheckMatch[2]);
      if (!recheck) return sendJson(res, 404, { error: "recheck_not_found" });
      if (recheck.status !== "进行中") return sendJson(res, 409, { error: "复检已结束" });
      const now = new Date().toISOString();
      recheck.status = "已结束";
      recheck.endedAt = now;
      sample.history.push({ at: now, text: `${recheck.by} 复检结束` });
      await saveDb(db);
      return sendJson(res, 200, present(sample));
    }
    const destroyMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/destroy$/);
    if (destroyMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === destroyMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      const witnesses = Array.isArray(input.witnesses) ? input.witnesses.map(name => String(name).trim()).filter(Boolean) : [];
      if (new Set(witnesses).size < 2) return sendJson(res, 400, { error: "需要两名不同的见证人现场核对编号与方式" });
      const method = String(input.method || "").trim();
      if (!method) return sendJson(res, 400, { error: "缺少销毁方式" });
      const left = daysLeft(sample);
      if (left === null || left > REVIEW_WINDOW_DAYS) return sendJson(res, 409, { error: `样本未进入待复核期（保存截止前 ${REVIEW_WINDOW_DAYS} 天），不能排入销毁` });
      const blocks = blockers(sample);
      if (blocks.length) return sendJson(res, 409, { error: `存在阻断原因：${blocks.join("；")}`, blockers: blocks });
      const now = new Date().toISOString();
      sample.history.push({ at: now, text: `销毁出库，方式 ${method}，见证 ${witnesses.join("、")}` });
      sample.destruction = { certId: `DEST-${Date.now()}`, at: now, method, witnesses, custodian: sample.custodian || "" };
      db.samples = db.samples.filter(item => item.id !== sample.id);
      db.destroyed.unshift(sample);
      await saveDb(db);
      return sendJson(res, 200, sample);
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
