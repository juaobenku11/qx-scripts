/*
* 全美节点 AI 批量筛选（Quantumult X · event-interaction 脚本）
* 版本：v1.0（2026-11-14）
*
* 一键把订阅里的全部美国节点逐个测一遍，出排行榜：
* - 第一轮：逐个测出口 IP + 延迟（5 个一批并行）
* - 第二轮：只对活着的节点测 Claude API + ChatGPT API 是否通
* - 排序：Claude 通 > ChatGPT 通 > 延迟低；同出口的节点会标注
* 结果以弹窗（htmlMessage）+ 通知双通道给出。
*
* 用法：在「工具 → HTTP 请求」里运行本任务即可（不需要长按，
* 脚本会自己挨个点名每个美国节点）。换机场/加新订阅后，
* 节点名单变化时告诉 Muse 更新本脚本顶部的名单即可。
*/

var NODES = ["[美国]", "[美国] 移动", "[美国]₁原生", "[美国]₂原生", "[美国] 原生₄", "[美国原生]", "[美国] 原生₅", "[美国] 原生₆", "🇺🇸 美国 01", "🇺🇸 美国 02", "🇺🇸 美国 03", "🇺🇸 美国 04", "🇺🇸 美国 05", "备用美国1"];
var TIMEOUT = 9000;
var BATCH = 5;
var DEADLINE = Date.now() + 80000;
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function get(url, policy) {
return Promise.race([
$task.fetch({ url: url, method: "GET", headers: { "User-Agent": UA}, opts: { policy: policy}}),
new Promise(function (_, rej) { setTimeout(function () { rej(new Error("timeout"));}, TIMEOUT);})
]).then(function (resp) {
return { ok: true, status: resp.statusCode, body: resp.body || ""};
}).catch(function (e) {
return { ok: false, status: 0, body: ""};
});
}

function chunks(arr, size) {
var out = [];
for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
return out;
}

function esc(s) {
return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function traceNode(name) {
var t0 = Date.now();
return get("https://chatgpt.com/cdn-cgi/trace", name).then(function (r) {
var ip = "", loc = "";
if (r.ok && r.body) {
var mIP = r.body.match(/ip=([^\n]+)/);
var mLoc = r.body.match(/loc=([^\n]+)/);
if (mIP) ip = mIP[1].trim();
if (mLoc) loc = mLoc[1].trim();
}
return { name: name, alive: !!ip, ip: ip, loc: loc, ms: Date.now() - t0, claude: null, gpt: null, tested: false, skipped: false};
});
}

function probeAI(rec) {
return Promise.all([
get("https://api.anthropic.com/v1/models", rec.name),
get("https://api.openai.com/v1/models", rec.name)
]).then(function (res) {
rec.claude = res[0].ok? res[0].status: 0;
rec.gpt = res[1].ok? res[1].status: 0;
rec.tested = true;
return rec;
});
}

var records = [];
var phase1 = Promise.resolve();
chunks(NODES, BATCH).forEach(function (group) {
phase1 = phase1.then(function () {
if (Date.now() > DEADLINE) {
group.forEach(function (n) { records.push({ name: n, alive: false, ip: "", loc: "", ms: 0, claude: null, gpt: null, tested: false, skipped: true});});
return null;
}
return Promise.all(group.map(traceNode)).then(function (rs) {
rs.forEach(function (r) { records.push(r);});
});
});
});

phase1.then(function () {
var alive = records.filter(function (r) { return r.alive;});
var phase2 = Promise.resolve();
chunks(alive, BATCH).forEach(function (group) {
phase2 = phase2.then(function () {
if (Date.now() > DEADLINE) return null;
return Promise.all(group.map(probeAI));
});
});
return phase2;
}).then(function () {
function score(r) {
var s = 0;
if (r.claude === 401) s += 2;
if (r.gpt === 401) s += 1;
return s;
}
var alive = records.filter(function (r) { return r.alive;});
var dead = records.filter(function (r) { return !r.alive;});
alive.sort(function (a, b) {
var d = score(b) - score(a);
if (d !== 0) return d;
return a.ms - b.ms;
});
var ordered = alive.concat(dead);

var ipOwner = {};
ordered.forEach(function (r) {
if (r.ip && !ipOwner[r.ip]) ipOwner[r.ip] = r.name;
});

var medals = ["🥇", "🥈", "🥉"];
var lines = [];
var claudePass = 0;
ordered.forEach(function (r, idx) {
if (!r.alive) {
lines.push("❌ " + r.name + (r.skipped? " · 未测完（超时上限）": " · 连不上"));
return;
}
if (r.claude === 401) claudePass++;
var c = r.claude === 401? "✅Claude": (r.claude === 403? "🚫Claude": "❔Claude");
var g = r.gpt === 401? "✅GPT": (r.gpt === 403? "🚫GPT": "❔GPT");
var head = (idx < 3 && score(r) >= 2? medals[idx] + " ": (score(r) >= 2? "✅ ": "⚠️ "));
var line = head + r.name + "：" + c + " " + g + " · " + r.ms + "ms\n    出口 " + r.ip + (r.loc? "（" + r.loc + "）": "");
if (ipOwner[r.ip] && ipOwner[r.ip] !== r.name) line += " · 同「" + ipOwner[r.ip] + "」出口";
lines.push(line);
});

var testedAlive = alive.filter(function (r) { return r.tested;}).length;
var summary = "可用 " + alive.length + "/" + NODES.length + " · Claude可通 " + claudePass + " 个" + (testedAlive < alive.length? " · 部分未测完": "");
var body = lines.join("\n") + "\n———\n" + summary;
console.log(body);
$notify("全美节点AI筛选", summary, body);
var html = "<p style=\"text-align: left; font-family: -apple-system; font-size: medium\">" +
body.split("\n").map(esc).join("</br>") + "</p>";
$done({ title: "全美节点AI筛选", htmlMessage: html});
}).catch(function (e) {
$notify("全美节点AI筛选", "脚本出错", String(e));
$done({ title: "全美节点AI筛选", htmlMessage: "<p>脚本出错：" + esc(String(e)) + "</p>"});
});
