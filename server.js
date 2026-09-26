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
const reviewStatuses = ["无复检", "复检中", "复检完成"];
const destroyMethods = ["破碎回填", "深埋处置", "高温焚烧", "化学中和", "其他"];
const reviewWindowDays = 30;

const seed = {
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      custodian: "陆川",
      retentionUntil: "2026-10-20",
      reviewStatus: "无复检",
      loans: [],
      status: "制片中",
      delivery: "未交付",
      slices: [
        { id: "SL-001-A", method: "茜素红染色", observation: "", status: "研磨", logs: [{ at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" }, { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }] }
      ]
    }
  ],
  archive: []
};

function normalizeSample(sample) {
  sample.custodian = sample.custodian || sample.owner || "未指定";
  sample.retentionUntil = sample.retentionUntil || "";
  sample.reviewStatus = reviewStatuses.includes(sample.reviewStatus) ? sample.reviewStatus : "无复检";
  sample.loans = Array.isArray(sample.loans) ? sample.loans : [];
  sample.slices = Array.isArray(sample.slices) ? sample.slices : [];
  return sample;
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.samples = Array.isArray(db.samples) ? db.samples : [];
  db.archive = Array.isArray(db.archive) ? db.archive : [];
  db.samples.forEach(normalizeSample);
  db.archive.forEach(normalizeSample);
  return db;
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
function daysLeftOf(sample) {
  if (!sample.retentionUntil) return null;
  const due = new Date(`${sample.retentionUntil}T00:00:00`);
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}
function stageOf(daysLeft) {
  if (daysLeft === null) return "未设期限";
  if (daysLeft < 0) return "已逾期";
  if (daysLeft <= reviewWindowDays) return "待复核";
  return "在库";
}
function blockersOf(sample) {
  const blockers = [];
  const activeLoans = sample.loans.filter(loan => !loan.returnedAt);
  if (activeLoans.length) blockers.push(`借阅未归还（${activeLoans.map(loan => loan.borrower).join("、")}）`);
  const unfinished = sample.slices.filter(slice => slice.status !== "观察");
  if (unfinished.length) blockers.push(`切片未完成（${unfinished.map(slice => `${slice.id}·${slice.status}`).join("、")}）`);
  if (sample.reviewStatus === "复检中") blockers.push("复检未结束");
  return blockers;
}
function lastActivityOf(sample) {
  let latest = null;
  for (const slice of sample.slices) {
    for (const log of slice.logs || []) {
      if (!latest || new Date(log.at) > new Date(latest.at)) latest = { ...log, slice: slice.id };
    }
  }
  return latest;
}
function enrich(sample) {
  const daysLeft = daysLeftOf(sample);
  return { ...sample, daysLeft, stage: stageOf(daysLeft), blockers: blockersOf(sample), lastActivity: lastActivityOf(sample) };
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --warn:#8a6d1a; --warn-bg:#fbf3df; --danger:#a13c2f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; align-items:start; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; margin-top:8px; }
    button.ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); }
    button.danger { background:var(--danger); }
    .side { display:grid; gap:22px; align-content:start; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.warn { background:var(--warn-bg); border-color:#e2c98c; color:var(--warn); }
    .pill.out { background:#fbe9e6; border-color:#e0a89f; color:var(--danger); }
    .slice { border-top:1px solid var(--line); padding-top:10px; }
    .blockers { color:var(--danger); font-size:13px; } .ok { color:var(--accent); font-size:13px; }
    .cert { border:1px dashed var(--accent); border-radius:6px; padding:10px; font-size:13px; background:#f6faf2; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .archive-card { border-top:1px solid var(--line); padding:10px 0; }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>岩芯样本切片实验室</h1><div class="meta">样本、切片、保存期复核与离库销毁见证</div></div><button id="reload">刷新</button></header>
  <main>
    <div class="side">
      <form id="form">
        <h2>创建岩芯样本（建档）</h2>
        <label>项目</label><input name="project" required>
        <label>钻孔编号</label><input name="borehole" required>
        <label>岩芯箱号</label><input name="coreBox" required>
        <label>取样深度</label><input name="depth" required>
        <label>负责人</label><input name="owner" required>
        <label>保管人</label><input name="custodian" required>
        <label>保存截止日</label><input name="retentionUntil" type="date" required>
        <label>复检状态</label><select name="reviewStatus">${reviewStatuses.map(s => `<option>${s}</option>`).join("")}</select>
        <label>初始切片编号</label><input name="sliceId" required>
        <label>染色方法</label><input name="method" required>
        <button>保存样本</button>
      </form>
      <section class="panel">
        <h2>离库见证台</h2>
        <div class="meta">仅无阻断的样本可销毁；需两人现场核对编号与方式，系统留下时间并出具凭证。</div>
        <label>选择样本</label><select id="deskSample"></select>
        <div id="deskInfo"></div>
        <div id="deskForm" hidden>
          <label>销毁方式</label><select id="deskMethod">${destroyMethods.map(m => `<option>${m}</option>`).join("")}</select>
          <label>见证人甲</label><input id="witnessA" placeholder="现场核对人一">
          <label>见证人乙</label><input id="witnessB" placeholder="现场核对人二（不能与甲相同）">
          <label>核对编号确认</label><input id="confirmId" placeholder="输入样本编号以确认">
          <button class="danger" id="destroyBtn">确认销毁并出具凭证</button>
        </div>
        <div id="deskCert" style="margin-top:10px"></div>
      </section>
    </div>
    <section>
      <div class="stats" id="stats"></div>
      <div class="grid" id="samples"></div>
      <section class="panel" style="margin-top:14px">
        <h2>销毁档案</h2>
        <div class="meta">已销毁样本从可用样本与统计中移出；原切片步骤与销毁凭证在此保留可查。</div>
        <div id="archive"></div>
      </section>
    </section>
  </main>
  <script>
    const statuses = ${JSON.stringify(statuses)};
    const steps = ${JSON.stringify(taskSteps)};
    const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
    const fmtDay = iso => iso ? String(iso).slice(0, 10) : "";
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    const archiveEl = document.querySelector("#archive");
    let samples = [];
    let archive = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function daysText(s) {
      if (s.daysLeft === null) return "未设保存期限";
      if (s.daysLeft < 0) return "已逾期 " + (-s.daysLeft) + " 天";
      return "剩余 " + s.daysLeft + " 天";
    }
    function stagePill(s) {
      if (s.stage === "待复核") return '<span class="pill warn">待复核</span>';
      if (s.stage === "已逾期") return '<span class="pill out">已逾期</span>';
      return '<span class="pill">' + esc(s.stage) + '</span>';
    }
    function render() {
      const reviewCount = samples.filter(s => s.stage === "待复核" || s.stage === "已逾期").length;
      stats.innerHTML = statuses.map(s => '<div class="stat"><span>'+s+'</span><strong>'+samples.filter(item => item.status === s).length+'</strong></div>').join("")
        + '<div class="stat"><span>待复核/逾期</span><strong>'+reviewCount+'</strong></div>';
      samplesEl.innerHTML = samples.map(sample => {
        const activeLoan = sample.loans.find(loan => !loan.returnedAt);
        const last = sample.lastActivity;
        return '<article class="card"><h3>'+esc(sample.project)+'</h3>'
          + '<div class="row"><span class="pill">'+esc(sample.status)+'</span>'+stagePill(sample)+'<span class="pill">复检：'+esc(sample.reviewStatus)+'</span></div>'
          + '<div class="meta">'+esc(sample.id)+' · '+esc(sample.borehole)+' · '+esc(sample.coreBox)+' · '+esc(sample.depth)+'</div>'
          + '<div class="meta">负责人 '+esc(sample.owner)+' · 保管人 '+esc(sample.custodian)+' · 保存截止 '+esc(sample.retentionUntil || "未设置")+'</div>'
          + '<div><b>'+daysText(sample)+'</b></div>'
          + (sample.blockers.length ? '<div class="blockers">阻断销毁：'+sample.blockers.map(esc).join("；")+'</div>' : '<div class="ok">无阻断，可安排离库销毁</div>')
          + '<div class="meta">最近处理：'+(last ? esc(last.step+"："+last.note)+' · '+fmtDay(last.at) : "暂无")+'</div>'
          + (activeLoan
              ? '<div class="meta">借阅中：'+esc(activeLoan.borrower)+' · 自 '+fmtDay(activeLoan.at)+'</div><button class="ghost" data-return="'+esc(sample.id)+'|'+esc(activeLoan.id)+'">登记归还</button>'
              : '<div class="row"><input data-borrower="'+esc(sample.id)+'" placeholder="借阅人"><button class="ghost" data-loan="'+esc(sample.id)+'">借阅登记</button></div>')
          + (sample.reviewStatus === "复检中"
              ? '<button class="ghost" data-review="'+esc(sample.id)+'|finish">结束复检</button>'
              : '<button class="ghost" data-review="'+esc(sample.id)+'|start">开始复检</button>')
          + '<label>新增切片</label><input data-new-slice="'+esc(sample.id)+'" placeholder="切片编号"><input data-method="'+esc(sample.id)+'" placeholder="染色方法"><button data-add="'+esc(sample.id)+'">添加切片</button>'
          + sample.slices.map(slice => '<div class="slice"><b>'+esc(slice.id)+'</b><div class="meta">'+esc(slice.method)+' · 当前步骤 '+esc(slice.status)+'</div><select data-step="'+esc(sample.id)+'|'+esc(slice.id)+'">'+steps.map(step => '<option>'+step+'</option>').join("")+'</select><textarea data-note="'+esc(sample.id)+'|'+esc(slice.id)+'" placeholder="步骤备注或观察结果"></textarea><button data-log="'+esc(sample.id)+'|'+esc(slice.id)+'">记录步骤</button><div class="meta">'+slice.logs.map(log => esc(log.step+"："+log.note)).join(" / ")+'</div></div>').join("")
          + '<button data-deliver="'+esc(sample.id)+'">标记交付</button></article>';
      }).join("");
      document.querySelectorAll("[data-step]").forEach(sel => {
        const [sampleId, sliceId] = sel.dataset.step.split("|");
        const sample = samples.find(s => s.id === sampleId);
        const slice = sample && sample.slices.find(s => s.id === sliceId);
        if (slice) sel.value = slice.status;
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
        const borrower = document.querySelector('[data-borrower="'+id+'"]').value.trim();
        if (!borrower) return alert("请填写借阅人");
        await api('/api/samples/'+id+'/loans', { method:'POST', body: JSON.stringify({ borrower }) });
        await load();
      });
      document.querySelectorAll("[data-return]").forEach(btn => btn.onclick = async () => {
        const [sampleId, loanId] = btn.dataset.return.split("|");
        await api('/api/samples/'+sampleId+'/loans/'+loanId+'/return', { method:'POST', body: JSON.stringify({}) });
        await load();
      });
      document.querySelectorAll("[data-review]").forEach(btn => btn.onclick = async () => {
        const [id, action] = btn.dataset.review.split("|");
        await api('/api/samples/'+id+'/review', { method:'POST', body: JSON.stringify({ action }) });
        await load();
      });
    }
    function renderDesk() {
      const sel = document.querySelector("#deskSample");
      const keep = sel.value;
      sel.innerHTML = '<option value="">请选择样本</option>' + samples.map(s => '<option value="'+esc(s.id)+'">'+esc(s.id+' · '+s.project)+'</option>').join("");
      if (keep && samples.some(s => s.id === keep)) sel.value = keep;
      updateDesk();
    }
    function updateDesk() {
      const id = document.querySelector("#deskSample").value;
      const info = document.querySelector("#deskInfo");
      const deskForm = document.querySelector("#deskForm");
      const sample = samples.find(s => s.id === id);
      if (!sample) { info.innerHTML = ""; deskForm.hidden = true; return; }
      info.innerHTML = '<div class="meta" style="margin:8px 0">'+esc(sample.id)+' · '+esc(sample.project)+' · 保管人 '+esc(sample.custodian)+'<br>'+daysText(sample)+'（保存截止 '+esc(sample.retentionUntil || "未设置")+'）</div>'
        + (sample.blockers.length
          ? '<div class="blockers">暂不能销毁：'+sample.blockers.map(esc).join("；")+'</div>'
          : '<div class="ok">核对通过，可执行销毁</div>');
      deskForm.hidden = sample.blockers.length > 0;
      document.querySelector("#confirmId").placeholder = '输入 '+sample.id+' 以确认';
    }
    function renderArchive() {
      archiveEl.innerHTML = archive.length ? archive.map(sample => {
        const d = sample.destruction || {};
        return '<div class="archive-card"><b>'+esc(sample.id)+' · '+esc(sample.project)+'</b>'
          + '<div class="meta">凭证 '+esc(d.certificateId || "-")+' · 销毁时间 '+esc(d.destroyedAt || "-")+' · 方式 '+esc(d.method || "-")+' · 见证人 '+esc((d.witnesses || []).join("、"))+'</div>'
          + sample.slices.map(slice => '<div class="meta">切片 '+esc(slice.id)+'（'+esc(slice.method)+'）：'+slice.logs.map(log => esc(log.step+"："+log.note)+' '+fmtDay(log.at)).join(" / ")+'</div>').join("")
          + '</div>';
      }).join("") : '<div class="meta" style="margin-top:8px">暂无销毁记录</div>';
    }
    async function load(){
      samples = await api("/api/samples");
      archive = await api("/api/archive");
      render(); renderDesk(); renderArchive();
    }
    document.querySelector("#reload").onclick = load;
    document.querySelector("#deskSample").onchange = () => { document.querySelector("#deskCert").innerHTML = ""; updateDesk(); };
    document.querySelector("#destroyBtn").onclick = async () => {
      const id = document.querySelector("#deskSample").value;
      if (!id) return;
      try {
        const result = await api('/api/samples/'+id+'/destroy', { method:'POST', body: JSON.stringify({
          method: document.querySelector("#deskMethod").value,
          witnessA: document.querySelector("#witnessA").value,
          witnessB: document.querySelector("#witnessB").value,
          confirmId: document.querySelector("#confirmId").value
        }) });
        const c = result.certificate;
        document.querySelector("#deskCert").innerHTML = '<div class="cert">销毁凭证 <b>'+esc(c.certificateId)+'</b><br>时间 '+esc(c.destroyedAt)+'<br>方式 '+esc(c.method)+' · 见证人 '+esc(c.witnesses.join("、"))+'</div>';
        await load();
      } catch (error) { alert(error.message); }
    };
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
    if (req.method === "GET" && url.pathname === "/api/samples") return sendJson(res, 200, db.samples.map(enrich));
    if (req.method === "GET" && url.pathname === "/api/archive") return sendJson(res, 200, db.archive);
    if (req.method === "POST" && url.pathname === "/api/samples") {
      const input = await body(req);
      const sample = {
        id: `CORE-${Date.now()}`,
        project: input.project,
        borehole: input.borehole,
        coreBox: input.coreBox,
        depth: input.depth,
        owner: input.owner,
        custodian: (input.custodian || "").trim() || input.owner,
        retentionUntil: input.retentionUntil || "",
        reviewStatus: reviewStatuses.includes(input.reviewStatus) ? input.reviewStatus : "无复检",
        loans: [],
        status: "待切割",
        delivery: "未交付",
        slices: [{ id: input.sliceId, method: input.method, observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "创建初始切片任务" }] }]
      };
      updateSampleStatus(sample);
      db.samples.unshift(sample);
      await saveDb(db);
      return sendJson(res, 201, enrich(sample));
    }
    const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      const sample = db.samples.find(item => item.id === addSlice[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      sample.slices.push({ id: input.id, method: input.method || "未指定", observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "新增切片任务" }] });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 201, enrich(sample));
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
      return sendJson(res, 200, enrich(sample));
    }
    const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === deliverMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      sample.delivery = "已交付";
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, enrich(sample));
    }
    const loanMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/loans$/);
    if (loanMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === loanMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      const borrower = (input.borrower || "").trim();
      if (!borrower) return sendJson(res, 400, { error: "请填写借阅人" });
      sample.loans.push({ id: `LOAN-${Date.now()}`, borrower, at: new Date().toISOString(), returnedAt: null });
      await saveDb(db);
      return sendJson(res, 201, enrich(sample));
    }
    const returnMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/loans\/([^/]+)\/return$/);
    if (returnMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === returnMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const loan = sample.loans.find(item => item.id === returnMatch[2]);
      if (!loan) return sendJson(res, 404, { error: "loan_not_found" });
      loan.returnedAt = new Date().toISOString();
      await saveDb(db);
      return sendJson(res, 200, enrich(sample));
    }
    const reviewMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/review$/);
    if (reviewMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === reviewMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      if (input.action === "start") sample.reviewStatus = "复检中";
      else if (input.action === "finish") sample.reviewStatus = "复检完成";
      else return sendJson(res, 400, { error: "invalid_action" });
      await saveDb(db);
      return sendJson(res, 200, enrich(sample));
    }
    const destroyMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/destroy$/);
    if (destroyMatch && req.method === "POST") {
      const index = db.samples.findIndex(item => item.id === destroyMatch[1]);
      if (index === -1) return sendJson(res, 404, { error: "sample_not_found" });
      const sample = db.samples[index];
      const input = await body(req);
      const blockers = blockersOf(sample);
      if (blockers.length) return sendJson(res, 409, { error: "存在阻断原因，不能销毁", blockers });
      const method = (input.method || "").trim();
      const witnessA = (input.witnessA || "").trim();
      const witnessB = (input.witnessB || "").trim();
      if (!method) return sendJson(res, 400, { error: "请填写销毁方式" });
      if (!witnessA || !witnessB || witnessA === witnessB) return sendJson(res, 400, { error: "需两名不同的见证人现场核对" });
      if ((input.confirmId || "").trim() !== sample.id) return sendJson(res, 400, { error: "核对编号与所选样本不一致" });
      const destroyedAt = new Date().toISOString();
      const certificateId = `DEST-${destroyedAt.slice(0, 10).replaceAll("-", "")}-${String(db.archive.length + 1).padStart(3, "0")}`;
      sample.destruction = { certificateId, method, witnesses: [witnessA, witnessB], destroyedAt };
      db.archive.unshift(sample);
      db.samples.splice(index, 1);
      await saveDb(db);
      return sendJson(res, 200, { certificate: sample.destruction, sample: enrich(sample) });
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
