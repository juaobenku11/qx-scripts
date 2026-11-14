/*
* AI 节点质量检测（Quantumult X · event-interaction 脚本）
* 版本：v2.3（2026-11-14，总截止保底版）
*
* v2.3 修复（长按又报「无有效内容」）：
* v2.2 本身没坏（19:31 真机验证过），但它的最坏耗时太长：单请求超时
* 15 秒、延迟采样又是 3 次串行——被测出口一慢，整轮检测可能拖过圈X
* 给长按脚本的执行时限，脚本被杀在交报告之前，于是弹「无有效内容」。
* 本版两处保底：
* 1) 总截止 25 秒：到点无论探针跑没跑完，都先把已完成的部分组成报告
*    用 $done 交回，绝不空手；慢/死的出口会直接在报告里现形。
* 2) 提速：单请求超时降到 9 秒；出口信息、九条 AI 探针、三次延迟采样
*    改为全并行，健康出口整轮约 3-6 秒完成。
*
* （v2.2 的长按契约不变：探针带 opts.policy=$environment.params，
*  结束用 $done({title, htmlMessage}) 交报告。）
*
* 用法：
* - 测单个节点/地区：开着圈X，在节点列表里长按某个节点或策略组
*   （如「美国节点」「日本节点」「狮城节点」组）→ 选「AI节点质量检测」，
*   报告测的就是那个出口，并直接弹出。
* - 在任务列表右滑运行 = 测当前「AI服务」选中的出口。
*
* 检测内容：
* - 出口 IP、城市、运营商、AS，以及 ip-api 的 proxy / hosting 标记
* - 延迟：3 次并行采样，给出 平均 / 最小 / 最大
* - 七家 AI 可达性 + 每家状态码：ChatGPT / Claude / Gemini / Copilot /
*   Perplexity / Grok / Muse（ChatGPT、Claude 同时测 API 和网页）
*
* 判定逻辑（未登录探针，看返回码）：
* - 官方 API 未带密钥访问返回 401 = 通且没被地区封；403 = 被封/地区限制
* - 网页端返回 200 / 3xx = 可用；403 = 被风控拦截（结合 API 结果区分）
*/

var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
var TIMEOUT = 9000;
var DEADLINE = 25000;

// 长按入口传入的目标（节点名或策略组名）；任务列表直接运行则为空
var PARAMS = "";
try {
var _p = $environment && $environment.params;
if (typeof _p === "string") PARAMS = _p;
else if (_p) PARAMS = _p.tag || _p.name || _p.server || "";
} catch (e) {}

var state = { label: "", exitIP: "", exitLoc: "", ipInfo: null, probes: null, lat: [] };
var finished = false;

function fetchWithTimeout(opts, t) {
return Promise.race([
$task.fetch(opts),
new Promise(function (_, reject) {
setTimeout(function () { reject(new Error("timeout")); }, t || TIMEOUT);
})
]);
}

function get(url, t) {
var req = {
url: url,
method: "GET",
headers: { "User-Agent": UA }
};
// 长按指定了目标时，强制每条请求走那个出口（与流媒体解锁查询同做法）
if (PARAMS) req.opts = { policy: PARAMS };
return fetchWithTimeout(req, t).then(function (resp) {
return { ok: true, status: resp.statusCode, body: resp.body || "" };
}).catch(function (e) {
return { ok: false, status: 0, body: "", error: String(e && e.error ? e.error : e) };
});
}

function timedGet(url, t) {
var t0 = Date.now();
return get(url, t).then(function (r) {
r.ms = Date.now() - t0;
return r;
});
}

// 长按的是策略组时，把组解析成实际命中的节点链，仅用于报告标题（失败就用原名）
function resolveLabel() {
if (!PARAMS) return Promise.resolve("");
try {
if (typeof $configuration === "undefined" || !$configuration || !$configuration.sendMessage) {
return Promise.resolve(PARAMS);
}
var ipc = $configuration.sendMessage({ action: "get_policy_state", content: PARAMS });
var guard = new Promise(function (res) { setTimeout(function () { res(null); }, 3000); });
return Promise.race([ipc, guard]).then(function (r) {
try {
if (r && r.ret && r.ret[PARAMS]) {
var arr = r.ret[PARAMS];
if (Array.isArray(arr) && arr.length) return PARAMS + " ➟ " + arr.join(" ➟ ");
}
} catch (e) {}
return PARAMS;
}).catch(function () { return PARAMS; });
} catch (e) {
return Promise.resolve(PARAMS);
}
}

function esc(s) {
return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function judgeApi(r) {
if (!r) return { icon: "⚠️", text: "未完成" };
if (!r.ok) return { icon: "❌", text: "不可达/超时" };
if (r.status === 401) return { icon: "✅", text: "可用" };
if (r.status === 403) return { icon: "❌", text: "被封/地区限制" };
return { icon: "⚠️", text: "异常(" + r.status + ")" };
}

function judgeWeb(r) {
if (!r) return { icon: "⚠️", text: "未完成" };
if (!r.ok) return { icon: "❌", text: "不可达/超时" };
if (r.status >= 200 && r.status < 400) return { icon: "✅", text: "可用" };
if (r.status === 403) return { icon: "⚠️", text: "网页被风控(403)" };
return { icon: "⚠️", text: "异常(" + r.status + ")" };
}

function buildReport(timedOut) {
var p = state.probes;
var rows, pass = 0;
if (p) {
var gptApi = judgeApi(p[0]);
var claudeApi = judgeApi(p[2]);
var claudeWeb = judgeWeb(p[3]);
var claude;
if (claudeApi.icon === "✅" && claudeWeb.icon === "✅") {
claude = { icon: "✅", text: "可用（网页+API）" };
} else if (claudeApi.icon === "✅") {
claude = { icon: "⚠️", text: "API通、网页被拦" };
} else {
claude = claudeApi;
}
rows = [
{ name: "ChatGPT", j: gptApi, ms: p[0].ms, detail: "API " + (p[0].status || "无响应") + " · 网页 " + (p[1].status || "无响应") },
{ name: "Claude", j: claude, ms: p[2].ms, detail: "API " + (p[2].status || "无响应") + " · 网页 " + (p[3].status || "无响应") },
{ name: "Gemini", j: judgeWeb(p[4]), ms: p[4].ms, detail: "状态码 " + (p[4].status || "无响应") },
{ name: "Copilot", j: judgeWeb(p[5]), ms: p[5].ms, detail: "状态码 " + (p[5].status || "无响应") },
{ name: "Perplexity", j: judgeWeb(p[6]), ms: p[6].ms, detail: "状态码 " + (p[6].status || "无响应") },
{ name: "Grok", j: judgeWeb(p[7]), ms: p[7].ms, detail: "状态码 " + (p[7].status || "无响应") },
{ name: "Muse", j: judgeWeb(p[8]), ms: p[8].ms, detail: "状态码 " + (p[8].status || "无响应") }
];
} else {
rows = ["ChatGPT", "Claude", "Gemini", "Copilot", "Perplexity", "Grok", "Muse"].map(function (n) {
return { name: n, j: { icon: "⚠️", text: "未完成" }, ms: 0, detail: "检测超时前未返回" };
});
}
var lines = [];
rows.forEach(function (row) {
if (row.j.icon === "✅") pass++;
lines.push(row.j.icon + " " + row.name + "：" + row.j.text + (row.ms ? " · " + row.ms + "ms" : "") + "（" + row.detail + "）");
});

// 出口信息
var ipLine = "出口：" + (state.exitIP || "未知");
var clean = false;
var ipInfo = state.ipInfo;
if (ipInfo && ipInfo.status === "success") {
ipLine += "（" + (ipInfo.city || "") + ", " + (ipInfo.country || state.exitLoc) + "）";
ipLine += "\n运营商：" + (ipInfo.isp || ipInfo.org || "未知");
if (ipInfo.as) ipLine += "\nAS：" + ipInfo.as;
var flags = [];
if (ipInfo.hosting) flags.push("机房IP");
if (ipInfo.proxy) flags.push("被标记代理");
if (ipInfo.mobile) flags.push("移动网络");
clean = !ipInfo.proxy && !ipInfo.hosting;
ipLine += "\nIP标记：" + (flags.length ? flags.join("、") : "干净（无机房/代理标记）");
} else if (state.exitLoc) {
ipLine += "（地区 " + state.exitLoc + "，IP详情查询失败）";
}

// 延迟统计
var latLine = "";
if (state.lat.length) {
var sum = 0, min = state.lat[0], max = state.lat[0];
state.lat.forEach(function (v) { sum += v; if (v < min) min = v; if (v > max) max = v; });
latLine = "\n延迟采样：平均 " + Math.round(sum / state.lat.length) + "ms（最小 " + min + " / 最大 " + max + "，抖动 " + (max - min) + "ms）";
}

var grade;
if (!p) grade = "未完成 · 出口太慢或无响应，探针没跑完";
else if (pass >= 7 && clean) grade = "优 · 全通且IP干净";
else if (pass >= 6) grade = "良 · 基本可用";
else if (pass >= 4) grade = "中 · 部分AI不可用";
else grade = "差 · 多数AI不可用，不建议当AI出口";

var body = ipLine + latLine + "\n———\n" + lines.join("\n") + "\n———\n综合：" + grade + "（" + pass + "/7 可用）";
if (timedOut) body = "⚠️ 本次检测超时未跑完，以下是已完成的部分：\n" + body;
return body;
}

function finishOnce(timedOut) {
if (finished) return;
finished = true;
try { clearTimeout(deadlineTimer); } catch (e) {}
var title = "AI节点质量检测" + (state.label ? " · " + state.label : "");
var body = buildReport(timedOut);
console.log(title + "\n" + body);
$notify(title, "", body);
var html = "<p style=\"text-align: left; font-family: -apple-system; font-size: medium\">" +
body.split("\n").map(esc).join("</br>") + "</p>";
$done({ title: title, htmlMessage: html });
}

// 总截止：到点必交报告，绝不让圈X 弹「无有效内容」
var deadlineTimer = setTimeout(function () { finishOnce(true); }, DEADLINE);

function main() {
resolveLabel().then(function (resolved) {
if (resolved) state.label = resolved;
}).then(function () {
// 1) 出口 IP：chatgpt.com 的 trace（长按时经 opts.policy 走被测出口）
return timedGet("https://chatgpt.com/cdn-cgi/trace");
}).then(function (tr) {
if (tr.ok && tr.body) {
var mIP = tr.body.match(/ip=([^\n]+)/);
var mLoc = tr.body.match(/loc=([^\n]+)/);
if (mIP) state.exitIP = mIP[1].trim();
if (mLoc) state.exitLoc = mLoc[1].trim();
}
// 2) 出口信息 + 九条探针 + 延迟采样，全并行
var ipInfoP;
if (state.exitIP) {
ipInfoP = get("http://ip-api.com/json/" + state.exitIP + "?lang=zh-CN&fields=status,query,country,regionName,city,isp,org,as,proxy,hosting,mobile").then(function (r) {
if (r.ok) { try { state.ipInfo = JSON.parse(r.body); } catch (e) {} }
});
} else {
ipInfoP = get("http://ip-api.com/json/?lang=zh-CN&fields=status,query,country,regionName,city,isp,org,as,proxy,hosting,mobile").then(function (r) {
if (r.ok) {
try {
state.ipInfo = JSON.parse(r.body);
if (!state.exitIP) state.exitIP = state.ipInfo.query || "";
} catch (e) {}
}
});
}
var probesP = Promise.all([
timedGet("https://api.openai.com/v1/models"),
timedGet("https://chatgpt.com/"),
timedGet("https://api.anthropic.com/v1/models"),
timedGet("https://claude.ai/"),
timedGet("https://gemini.google.com/"),
timedGet("https://copilot.microsoft.com/"),
timedGet("https://www.perplexity.ai/"),
timedGet("https://grok.com/"),
timedGet("https://muse.ai/")
]).then(function (res) { state.probes = res; });
var latP = Promise.all([1, 2, 3].map(function () {
return timedGet("http://cp.cloudflare.com/generate_204", 6000).then(function (r) {
if (r.ok) state.lat.push(r.ms);
});
}));
return Promise.all([ipInfoP, probesP, latP]);
}).then(function () {
finishOnce(false);
}).catch(function (e) {
if (!state.label) state.label = PARAMS;
finishOnce(false);
});
}

main();
